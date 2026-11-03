/**
 * Persistent newline-delimited JSON-RPC 2.0 bridge for native desktop shells.
 *
 * A native Windows shell (Rust/egui, Slint, Tauri, WinUI) supervised by a Job
 * Object spawns `rea-client serve` once and drives the engine over stdin/stdout:
 *
 *   - Every frame on `output` is a single-line JSON-RPC 2.0 response or
 *     notification (`\n`-delimited; `\r\n` accepted on `input`).
 *   - Incoming lines are dispatched concurrently so `agent.cancel`,
 *     `engine.ping`, or `engine.shutdown` executes immediately even while an
 *     `agent.ask` turn is streaming tokens or waiting on Ghidra.
 *   - Oversized frames fail closed (`-32700`) before unbounded buffering.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ReaClientConfig, ToolScopeName } from "../config.js";
import { runDoctor, type DoctorOptions, type DoctorReport } from "../doctor.js";
import { AgentSession, createAgentSession } from "../agent/AgentSession.js";
import type { AgentEvents } from "../agent/events.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { LlamaServerClient } from "../llm/LlamaServerClient.js";
import type { ChatMessage, ChatTransport } from "../llm/types.js";
import { ToolCatalog, type ScopeResolution } from "../mcp/catalog.js";
import { ToolObservation, projectToolResult } from "../mcp/evidence.js";
import {
  readEvidenceSummary,
  readExportedBundle,
  selectEvidenceRecord,
} from "../mcp/evidenceBundle.js";
import { ReaClient, type McpConnection } from "../mcp/ReaClient.js";
import { readBinarySession } from "../mcp/session.js";
import { readBundleCounts, readCaseSummary } from "../desktop/cases.js";
import type { BinarySessionSummary } from "../mcp/types.js";
import { canonicalizeTargetPath, TargetPathError, type PathPlatform } from "../platform/paths.js";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export type JsonRpcOutboundMessage =
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification;

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  SERVER_ERROR: -32000,
} as const;

export class JsonRpcException extends Error {
  public override readonly name = "JsonRpcException";
  public readonly code: number;
  public readonly data?: unknown;

  public constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

export interface ManagedMcpConnection extends McpConnection {
  connect?: () => Promise<void>;
}

export interface EngineRpcServerOptions {
  readonly config: ReaClientConfig;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  /** Maximum UTF-8 bytes accepted for a single JSON-RPC line (default 1 MiB). */
  readonly maxLineBytes?: number;
  readonly version?: string;
  readonly platform?: PathPlatform;
  /** Optional dependency hooks for unit testing. */
  readonly createConnection?: (config: ReaClientConfig) => ManagedMcpConnection;
  readonly createChat?: (config: ReaClientConfig) => ChatTransport;
  readonly runDoctorImpl?: (
    config: ReaClientConfig,
    options?: DoctorOptions,
  ) => Promise<DoctorReport>;
}

interface ConnectedState {
  readonly connection: ManagedMcpConnection;
  readonly catalog: ToolCatalog;
}

const DEFAULT_MAX_LINE_BYTES = 1_048_576;
/** Display ceiling for one retained evidence record in the desktop UI. */
const EVIDENCE_RECORD_MAX_CHARS = 200_000;
/** Per-document ceiling for a case file the workspace persists. */
const CASE_DOCUMENT_MAX_CHARS = 2_000_000;
/** Newest cases offered to the UI; the folder itself may hold more. */
const CASE_LIST_LIMIT = 25;
/** A saved report larger than this is not parsed for a one-line summary. */
const CASE_SUMMARY_MAX_BYTES = 1_048_576;
/** A saved report larger than this is not returned to the page in full. */
const CASE_REPORT_MAX_CHARS = 4_000_000;
const VALID_SCOPES: readonly ToolScopeName[] = [
  "binary-core",
  "binary-extended",
  "full",
  "custom",
];

function serializeSession(
  session: BinarySessionSummary | undefined,
): Omit<BinarySessionSummary, "raw"> | null {
  if (session === undefined) return null;
  const { raw: _raw, ...rest } = session;
  return rest;
}

function defaultPlatform(): PathPlatform {
  return process.platform === "win32" ? "windows" : "posix";
}

export class EngineRpcServer {
  private readonly config: ReaClientConfig;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly maxLineBytes: number;
  private readonly version: string;
  private readonly platform: PathPlatform;
  private readonly createConnection: (config: ReaClientConfig) => ManagedMcpConnection;
  private readonly createChat: (config: ReaClientConfig) => ChatTransport;
  private readonly runDoctorImpl: (
    config: ReaClientConfig,
    options?: DoctorOptions,
  ) => Promise<DoctorReport>;

  private connectedState: ConnectedState | undefined;
  private connectPromise: Promise<ConnectedState> | undefined;
  private chat: ChatTransport | undefined;
  private agent: AgentSession | undefined;
  private activeScopeName: ToolScopeName;
  private activeExtraInstructions: string | undefined;
  private latestSession: BinarySessionSummary | undefined;
  private activeTurnAbort: AbortController | undefined;
  private shuttingDown = false;
  private closed = false;
  private resolveRun: (() => void) | undefined;
  private cleanupInputListeners: (() => void) | undefined;
  private readonly inFlight = new Set<Promise<void>>();

  public constructor(options: EngineRpcServerOptions) {
    this.config = options.config;
    this.input = options.input;
    this.output = options.output;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.version = options.version ?? "0.1.0";
    this.platform = options.platform ?? defaultPlatform();
    this.activeScopeName = options.config.agent.toolScope;
    this.createConnection =
      options.createConnection ??
      ((cfg) => {
        const client = new ReaClient(cfg.rea, {
          allowNonLoopback: cfg.policy.allowNonLoopback,
        });
        client.on("stderr", ({ line }) => {
          this.notify("rea.stderr", { line });
        });
        return client;
      });
    this.createChat =
      options.createChat ??
      ((cfg) =>
        new LlamaServerClient({
          baseUrl: cfg.llm.baseUrl,
          ...(cfg.llm.apiKey === undefined ? {} : { apiKey: cfg.llm.apiKey }),
          requestTimeoutMs: cfg.llm.requestTimeoutMs,
          allowNonLoopback: cfg.policy.allowNonLoopback,
        }));
    this.runDoctorImpl = options.runDoctorImpl ?? runDoctor;
  }

  /**
   * Starts reading newline-delimited JSON-RPC frames from `input` and resolves
   * once `engine.shutdown` completes or `input` reaches EOF and all in-flight
   * calls have settled.
   */
  public async run(): Promise<void> {
    if (this.closed) return;

    await new Promise<void>((resolve) => {
      this.resolveRun = resolve;
      let pending = Buffer.alloc(0);
      let discardingOversized = false;

      const onData = (chunk: Buffer | string): void => {
        if (this.shuttingDown) return;
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        let offset = 0;

        while (offset < buf.length) {
          const newlineIndex = buf.indexOf(0x0a, offset); // '\n'

          if (discardingOversized) {
            if (newlineIndex === -1) {
              return;
            }
            discardingOversized = false;
            pending = Buffer.alloc(0);
            offset = newlineIndex + 1;
            continue;
          }

          if (newlineIndex === -1) {
            const remainder = buf.subarray(offset);
            if (pending.length + remainder.length > this.maxLineBytes) {
              pending = Buffer.alloc(0);
              discardingOversized = true;
              this.sendError(
                null,
                JSON_RPC_ERRORS.PARSE_ERROR,
                `JSON-RPC frame exceeds maxLineBytes (${String(this.maxLineBytes)} bytes).`,
              );
              return;
            }
            pending = pending.length === 0 ? Buffer.from(remainder) : Buffer.concat([pending, remainder]);
            return;
          }

          const slice = buf.subarray(offset, newlineIndex);
          offset = newlineIndex + 1;

          const totalLength = pending.length + slice.length;
          if (totalLength > this.maxLineBytes) {
            pending = Buffer.alloc(0);
            this.sendError(
              null,
              JSON_RPC_ERRORS.PARSE_ERROR,
              `JSON-RPC frame exceeds maxLineBytes (${String(this.maxLineBytes)} bytes).`,
            );
            continue;
          }

          const fullLine =
            pending.length === 0 ? slice.toString("utf8") : Buffer.concat([pending, slice]).toString("utf8");
          pending = Buffer.alloc(0);
          this.dispatchLine(fullLine);
        }
      };

      const finishStream = (): void => {
        cleanupListeners();
        if (!discardingOversized && pending.length > 0 && !this.shuttingDown) {
          const trailing = pending.toString("utf8");
          pending = Buffer.alloc(0);
          this.dispatchLine(trailing);
        }
        void Promise.allSettled([...this.inFlight]).then(async () => {
          await this.close();
          resolve();
        });
      };

      const cleanupListeners = (): void => {
        this.cleanupInputListeners = undefined;
        this.input.off("data", onData);
        this.input.off("end", finishStream);
        this.input.off("close", finishStream);
        this.input.off("error", finishStream);
      };

      this.cleanupInputListeners = cleanupListeners;
      this.input.on("data", onData);
      this.input.once("end", finishStream);
      this.input.once("close", finishStream);
      this.input.once("error", finishStream);
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shuttingDown = true;
    this.cleanupInputListeners?.();
    this.activeTurnAbort?.abort();
    const state = this.connectedState;
    this.connectedState = undefined;
    this.connectPromise = undefined;
    if (state !== undefined) {
      await state.connection.close().catch(() => undefined);
    }
    this.resolveRun?.();
  }

  private dispatchLine(rawLine: string): void {
    const trimmed = rawLine.endsWith("\r") ? rawLine.slice(0, -1).trim() : rawLine.trim();
    if (trimmed === "") return;

    const task = this.handleRawFrame(trimmed).finally(() => {
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
  }

  private async handleRawFrame(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.sendError(
        null,
        JSON_RPC_ERRORS.PARSE_ERROR,
        `Invalid JSON: ${(error as Error).message}`,
      );
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.sendError(
        null,
        JSON_RPC_ERRORS.INVALID_REQUEST,
        "JSON-RPC request must be a JSON object.",
      );
      return;
    }

    const record = parsed as Record<string, unknown>;
    const hasId = Object.prototype.hasOwnProperty.call(record, "id");
    const rawId = record["id"];
    if (hasId && !this.isValidId(rawId)) {
      this.sendError(
        null,
        JSON_RPC_ERRORS.INVALID_REQUEST,
        'JSON-RPC "id" must be a string, finite number, or null.',
      );
      return;
    }
    const id: JsonRpcId = hasId ? (rawId as JsonRpcId) : null;

    if (record["jsonrpc"] !== "2.0") {
      this.sendError(
        id,
        JSON_RPC_ERRORS.INVALID_REQUEST,
        'JSON-RPC "jsonrpc" field must be "2.0".',
      );
      return;
    }

    const method = record["method"];
    if (typeof method !== "string" || method.trim() === "") {
      this.sendError(
        id,
        JSON_RPC_ERRORS.INVALID_REQUEST,
        'JSON-RPC "method" must be a non-empty string.',
      );
      return;
    }

    const rawParams = record["params"];
    let params: Record<string, unknown> = {};
    if (rawParams !== undefined) {
      if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
        this.sendError(
          id,
          JSON_RPC_ERRORS.INVALID_REQUEST,
          'JSON-RPC "params" must be an object when provided.',
        );
        return;
      }
      params = rawParams as Record<string, unknown>;
    }

    try {
      const result = await this.dispatchMethod(method, params, hasId ? id : undefined);
      if (hasId) {
        this.sendResult(id, result);
      }
      if (method === "engine.shutdown") {
        await this.close();
      }
    } catch (error) {
      if (!hasId) return;
      if (error instanceof JsonRpcException) {
        this.sendError(id, error.code, error.message, error.data);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.sendError(id, JSON_RPC_ERRORS.SERVER_ERROR, message);
      }
    }
  }

  private isValidId(value: unknown): value is JsonRpcId {
    return (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    );
  }

  private async dispatchMethod(
    method: string,
    params: Record<string, unknown>,
    requestId: JsonRpcId | undefined,
  ): Promise<unknown> {
    switch (method) {
      case "engine.ping":
        return {
          ok: true,
          version: this.version,
          pid: process.pid,
          connected: this.connectedState !== undefined,
          running: this.agent?.isRunning === true,
        };

      case "engine.doctor": {
        const skipLlm = params["skipLlm"];
        if (skipLlm !== undefined && typeof skipLlm !== "boolean") {
          throw new JsonRpcException(
            JSON_RPC_ERRORS.INVALID_PARAMS,
            '"skipLlm" must be a boolean when provided.',
          );
        }
        return this.runDoctorImpl(this.config, { skipLlm: skipLlm === true });
      }

      case "engine.shutdown":
        this.shuttingDown = true;
        this.activeTurnAbort?.abort();
        return { ok: true };

      case "tools.list":
        return this.handleToolsList(params);

      case "tools.describe":
        return this.handleToolsDescribe(params);

      case "evidence.list":
        return this.handleEvidenceList();

      case "evidence.get":
        return this.handleEvidenceGet(params);

      case "evidence.export":
        return this.handleEvidenceExport(params);

      case "case.save":
        return this.handleCaseSave(params);

      case "case.list":
        return this.handleCaseList();

      case "case.open":
        return this.handleCaseOpen(params);

      case "case.delete":
        return this.handleCaseDelete(params);

      case "target.session":
        return this.handleTargetSession();

      case "target.open":
        return this.handleTargetOpen(params);

      case "target.close":
        return this.handleTargetClose();

      case "target.probe":
        return this.handleTargetProbe(params);

      case "agent.ask":
        return this.handleAgentAsk(params, requestId ?? null);

      case "agent.cancel": {
        if (this.activeTurnAbort === undefined) {
          return { cancelled: false };
        }
        this.activeTurnAbort.abort();
        return { cancelled: true };
      }

      case "agent.reset":
        return this.handleAgentReset(params);

      case "agent.transcript": {
        const agent = await this.ensureAgent();
        return {
          messages: agent.transcript(),
          estimatedTokens: agent.estimatedTranscriptTokens(),
        };
      }

      default:
        throw new JsonRpcException(
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Unknown JSON-RPC method: ${method}`,
        );
    }
  }

  private validateScopeName(raw: unknown): ToolScopeName {
    if (typeof raw !== "string") {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        `"scope" must be one of: ${VALID_SCOPES.join(", ")}`,
      );
    }
    const match = VALID_SCOPES.find((candidate) => candidate === raw);
    if (match === undefined) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        `"scope" must be one of: ${VALID_SCOPES.join(", ")} (received ${JSON.stringify(raw)})`,
      );
    }
    if (match === "custom" && this.config.agent.customTools.length === 0) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"scope" custom requires at least one tool in config "agent.customTools".',
      );
    }
    return match;
  }

  private canonicalizePathParam(rawPath: unknown): string {
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"path" is required and must be a non-empty string.',
      );
    }
    try {
      return canonicalizeTargetPath(rawPath, {
        platform: this.platform,
        allowNonLoopback: this.config.policy.allowNonLoopback,
      });
    } catch (error) {
      if (error instanceof TargetPathError) {
        throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, error.message, {
          code: error.code,
        });
      }
      throw error;
    }
  }

  private async ensureConnected(): Promise<ConnectedState> {
    if (this.connectedState !== undefined) return this.connectedState;
    if (this.connectPromise !== undefined) return this.connectPromise;

    this.connectPromise = (async () => {
      const connection = this.createConnection(this.config);
      try {
        if (connection.connect !== undefined) {
          await connection.connect();
        }
        const tools = await connection.listTools();
        const catalog = ToolCatalog.from(tools);
        if (catalog.has("binary_session")) {
          const sessionResult = await connection.callTool("binary_session", {});
          this.latestSession = readBinarySession(sessionResult);
        }
        const state: ConnectedState = { connection, catalog };
        this.connectedState = state;
        return state;
      } catch (error) {
        this.connectPromise = undefined;
        if (connection.close !== undefined) {
          await connection.close().catch(() => undefined);
        }
        throw error;
      }
    })();

    return this.connectPromise;
  }

  private async refreshSessionState(): Promise<BinarySessionSummary | undefined> {
    const { connection, catalog } = await this.ensureConnected();
    if (catalog.has("binary_session")) {
      const sessionResult = await connection.callTool("binary_session", {});
      this.latestSession = readBinarySession(sessionResult);
    }
    if (this.agent !== undefined) {
      const scope = catalog.resolveScope(this.activeScopeName, this.config.agent.customTools);
      this.agent.setSystemPrompt(
        this.composeSystemPrompt(catalog, scope, this.latestSession, this.activeExtraInstructions),
      );
    }
    return this.latestSession;
  }

  private composeSystemPrompt(
    catalog: ToolCatalog,
    scope: ScopeResolution,
    session: BinarySessionSummary | undefined,
    extraInstructions: string | undefined,
  ): string {
    return buildSystemPrompt({
      catalog,
      advertisedToolCount: scope.tools.length,
      session,
      extraInstructions,
    });
  }

  private async ensureAgent(
    requestedScope?: ToolScopeName,
    extraInstructions?: string,
  ): Promise<AgentSession> {
    const { connection, catalog } = await this.ensureConnected();
    const nextScopeName = requestedScope ?? this.activeScopeName;
    const nextInstructions =
      extraInstructions !== undefined ? extraInstructions : this.activeExtraInstructions;

    if (
      this.agent !== undefined &&
      nextScopeName === this.activeScopeName &&
      nextInstructions === this.activeExtraInstructions
    ) {
      return this.agent;
    }

    const previousHistory: readonly ChatMessage[] =
      this.agent === undefined ? [] : this.agent.transcript().filter((m) => m.role !== "system");

    if (this.chat === undefined) {
      this.chat = this.createChat(this.config);
    }

    this.activeScopeName = nextScopeName;
    this.activeExtraInstructions = nextInstructions;
    const scope = catalog.resolveScope(nextScopeName, this.config.agent.customTools);

    const nextAgent = createAgentSession(this.config, {
      connection,
      chat: this.chat,
      catalog,
      scope,
      extraInstructions: nextInstructions,
      systemPrompt: this.composeSystemPrompt(
        catalog,
        scope,
        this.latestSession,
        nextInstructions,
      ),
      buildPromptForSession: (session) => {
        this.latestSession = session;
        return this.composeSystemPrompt(catalog, scope, session, this.activeExtraInstructions);
      },
    });

    if (previousHistory.length > 0) {
      nextAgent.replaceHistory(previousHistory);
    }
    this.agent = nextAgent;
    return nextAgent;
  }

  private async handleToolsList(params: Record<string, unknown>): Promise<unknown> {
    const family = params["family"];
    if (family !== undefined && typeof family !== "string") {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"family" must be a string when provided.',
      );
    }
    const scopeName =
      params["scope"] === undefined
        ? this.activeScopeName
        : this.validateScopeName(params["scope"]);

    const includeDetails = params["includeDetails"];
    if (includeDetails !== undefined && typeof includeDetails !== "boolean") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"includeDetails" must be a boolean when provided.');
    }
    const { catalog } = await this.ensureConnected();
    const resolved = catalog.resolveScope(scopeName, this.config.agent.customTools);

    return {
      total: catalog.size,
      // Full schemas are fetched one at a time by tools.describe. The complete
      // REA inventory is several MiB, too large for the default stdio frame.
      ...(includeDetails === true ? { entries: catalog.all().map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description ?? "",
        family: catalog.familyOf(tool.name),
        readOnly: tool.annotations?.["readOnlyHint"] === true,
        destructive: tool.annotations?.["destructiveHint"] === true,
      })) } : {}),
      families: catalog.populatedFamilies().map((group) => ({
        id: group.id,
        label: group.label,
        count: group.tools.length,
        ...(family === undefined || family === group.id
          ? { tools: group.tools.map((tool) => tool.name) }
          : {}),
      })),
      scope: {
        name: resolved.scope,
        count: resolved.tools.length,
        missing: resolved.missing,
        ...(includeDetails === true ? { names: resolved.tools.map((tool) => tool.name) } : {}),
      },
    };
  }

  private async handleToolsDescribe(params: Record<string, unknown>): Promise<unknown> {
    const name = params["name"];
    if (typeof name !== "string" || name.trim() === "") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"name" is required and must be a non-empty string.');
    }
    const { catalog } = await this.ensureConnected();
    const tool = catalog.get(name);
    if (tool === undefined) {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, `Tool is not in the live catalog: ${name}`);
    }
    const scope = catalog.resolveScope(this.activeScopeName, this.config.agent.customTools);
    return { tool, family: catalog.familyOf(name), inScope: scope.tools.some((entry) => entry.name === name) };
  }

  private requireEvidenceTool(catalog: ToolCatalog, name: string): void {
    if (catalog.has(name)) return;
    throw new JsonRpcException(
      JSON_RPC_ERRORS.SERVER_ERROR,
      `Connected REA server does not advertise "${name}".`,
    );
  }

  private validateEvidenceId(raw: unknown): string {
    if (typeof raw !== "string" || !/^ev_[a-f0-9]{64}$/.test(raw)) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"evidenceId" must be a retained REA evidence id: "ev_" followed by 64 lowercase hex characters.',
      );
    }
    return raw;
  }

  private async handleEvidenceList(): Promise<unknown> {
    const { connection, catalog } = await this.ensureConnected();
    this.requireEvidenceTool(catalog, "get_evidence_bundle");
    const raw = await connection.callTool("get_evidence_bundle", { detail: "summary" });
    const inventory = readEvidenceSummary(raw);
    const projected = projectToolResult(raw, { maxChars: 2_000 });
    const failed =
      raw.isError === true || projected.text.startsWith(ToolObservation.errorPrefix);
    if (failed || inventory === undefined) {
      return {
        ok: false,
        error: projected.text,
        totalRetained: 0,
        matching: 0,
        unknownRevisions: 0,
        records: [],
      };
    }
    return { ok: true, ...inventory };
  }

  private async handleEvidenceGet(params: Record<string, unknown>): Promise<unknown> {
    const evidenceId = this.validateEvidenceId(params["evidenceId"]);
    const { connection, catalog } = await this.ensureConnected();
    this.requireEvidenceTool(catalog, "get_evidence_bundle");

    // Confirm the id is retained before pulling a payload, so "not found" is a
    // clear answer rather than a large ambiguous bundle.
    const summaryRaw = await connection.callTool("get_evidence_bundle", {
      detail: "summary",
      filters: { evidence_id: evidenceId },
    });
    const inventory = readEvidenceSummary(summaryRaw);
    if (summaryRaw.isError !== true && inventory !== undefined && inventory.matching === 0) {
      return {
        ok: false,
        evidenceId,
        text: "",
        truncated: false,
        untrusted: true,
        error: "REA has no retained evidence with that id in this session.",
      };
    }

    const raw = await connection.callTool("get_evidence_bundle", {
      detail: "complete",
      filters: { evidence_id: evidenceId },
    });
    const projected = projectToolResult(raw, { maxChars: 2_000 });
    const failed = raw.isError === true || projected.text.startsWith(ToolObservation.errorPrefix);
    if (failed) {
      return { ok: false, evidenceId, text: projected.text, truncated: false, untrusted: true, error: projected.text };
    }

    const record = selectEvidenceRecord(raw, evidenceId);
    if (record === undefined) {
      return {
        ok: false,
        evidenceId,
        text: projected.text,
        truncated: false,
        untrusted: true,
        error: "The bundle did not contain the requested evidence record.",
      };
    }

    const serialized = JSON.stringify(record, null, 2);
    const truncated = serialized.length > EVIDENCE_RECORD_MAX_CHARS;
    return {
      ok: true,
      evidenceId,
      text: truncated
        ? `${serialized.slice(0, EVIDENCE_RECORD_MAX_CHARS)}\n… [display truncated: ${EVIDENCE_RECORD_MAX_CHARS} of ${serialized.length} characters]`
        : serialized,
      truncated,
      // The record embeds provider output derived from the target itself.
      untrusted: true,
    };
  }

  private async handleEvidenceExport(params: Record<string, unknown>): Promise<unknown> {
    const overwrite = params["overwrite"];
    if (overwrite !== undefined && typeof overwrite !== "boolean") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"overwrite" must be a boolean when provided.');
    }
    const rawName = params["name"];
    if (rawName !== undefined && typeof rawName !== "string") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"name" must be a string when provided.');
    }
    const stem = (rawName ?? `evidence-bundle-${new Date().toISOString().replace(/[:.]/g, "-")}`)
      .replace(/\.json$/i, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(stem) || stem.includes("..")) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"name" must be 1-80 characters of letters, digits, dot, dash, or underscore.',
      );
    }

    const { connection, catalog } = await this.ensureConnected();
    this.requireEvidenceTool(catalog, "export_evidence_bundle");

    // The renderer never chooses a directory: exports stay inside the workspace
    // so a compromised page cannot write anywhere the user did not expect.
    const directory = resolve(this.config.workspaceDir, "evidence");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${stem}.json`);

    const raw = await connection.callTool("export_evidence_bundle", {
      path,
      ...(overwrite === true ? { overwrite: true } : {}),
    });
    const exported = readExportedBundle(raw);
    const projected = projectToolResult(raw, { maxChars: 2_000 });
    if (raw.isError === true || exported === undefined) {
      return { ok: false, error: projected.text, path };
    }
    return { ok: true, ...exported };
  }

  /**
   * A case name is a directory name: bounded, no separators, no traversal. The
   * same rule is applied to evidence export names so both features reason about
   * the workspace identically.
   */
  private caseName(raw: unknown, fallback: string): string {
    if (raw !== undefined && typeof raw !== "string") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"name" must be a string when provided.');
    }
    const stem = (raw ?? fallback).trim().replace(/\.(json|md)$/i, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(stem) || stem.includes("..")) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"name" must be 1-80 characters of letters, digits, dot, dash, or underscore.',
      );
    }
    return stem;
  }

  private caseDocument(raw: unknown, label: string): string {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, `"${label}" must be a non-empty string.`);
    }
    if (raw.length > CASE_DOCUMENT_MAX_CHARS) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        `"${label}" exceeds the ${CASE_DOCUMENT_MAX_CHARS}-character limit.`,
      );
    }
    return raw;
  }

  /**
   * Persists a finished analysis as a self-contained case folder:
   * `cases/<name>/analysis.md`, `analysis.json`, and — when the caller asks and
   * REA can — `evidence-bundle.json` written by REA itself.
   *
   * The report text comes from the renderer because it carries per-turn target
   * attribution the engine does not keep; the bridge owns the destination and
   * every filename, so a case can never be written outside the workspace.
   */
  private async handleCaseSave(params: Record<string, unknown>): Promise<unknown> {
    const includeEvidence = params["includeEvidence"];
    if (includeEvidence !== undefined && typeof includeEvidence !== "boolean") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"includeEvidence" must be a boolean when provided.');
    }
    const overwrite = params["overwrite"];
    if (overwrite !== undefined && typeof overwrite !== "boolean") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"overwrite" must be a boolean when provided.');
    }
    const markdown = this.caseDocument(params["report"], "report");
    const json = this.caseDocument(params["reportJson"], "reportJson");
    const stem = this.caseName(
      params["name"],
      `case-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );

    const casesRoot = resolve(this.config.workspaceDir, "cases");
    const directory = resolve(casesRoot, stem);
    // Belt and braces: the name rule already forbids separators, but a resolved
    // path is the property that matters, so assert it too.
    if (directory !== join(casesRoot, stem) || !directory.startsWith(`${casesRoot}${sep}`)) {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"name" must not address a nested directory.');
    }

    const exists = await stat(directory).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (exists && overwrite !== true) {
      return {
        ok: false,
        directory,
        error: `A case named "${stem}" already exists. Choose another name or allow overwrite.`,
      };
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const files: Array<{ name: string; bytes: number }> = [];
    const write = async (name: string, content: string): Promise<void> => {
      await writeFile(join(directory, name), content, { mode: 0o600 });
      files.push({ name, bytes: Buffer.byteLength(content) });
    };
    await write("analysis.md", markdown);
    await write("analysis.json", json);

    let evidence: Record<string, unknown> | undefined;
    if (includeEvidence !== false) {
      const bundlePath = join(directory, "evidence-bundle.json");
      try {
        const { connection, catalog } = await this.ensureConnected();
        this.requireEvidenceTool(catalog, "export_evidence_bundle");
        const raw = await connection.callTool("export_evidence_bundle", {
          path: bundlePath,
          overwrite: true,
        });
        const exported = readExportedBundle(raw);
        if (raw.isError === true || exported === undefined) {
          evidence = { ok: false, error: projectToolResult(raw, { maxChars: 2_000 }).text };
        } else {
          evidence = { ok: true, ...exported };
          files.push({ name: "evidence-bundle.json", bytes: exported.bytes });
        }
      } catch (error) {
        // The report is the deliverable; a missing bundle is reported, not fatal.
        evidence = { ok: false, error: (error as Error).message };
      }
    }

    return {
      ok: true,
      name: stem,
      directory,
      files,
      ...(evidence === undefined ? {} : { evidence }),
    };
  }

  /** Resolves an existing case folder, refusing anything outside the cases root. */
  private async resolveCaseDirectory(name: string): Promise<string | undefined> {
    const casesRoot = resolve(this.config.workspaceDir, "cases");
    const directory = resolve(casesRoot, name);
    if (!directory.startsWith(`${casesRoot}${sep}`)) return undefined;
    const info = await stat(directory).catch(() => undefined);
    return info?.isDirectory() === true ? directory : undefined;
  }

  private async caseFiles(directory: string): Promise<Array<{ name: string; bytes: number }>> {
    const names = await readdir(directory).catch((): string[] => []);
    const files: Array<{ name: string; bytes: number }> = [];
    for (const name of names.sort()) {
      const info = await stat(join(directory, name)).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;
      files.push({ name, bytes: info.size });
    }
    return files;
  }

  /**
   * Lists saved case folders newest first. Only directories with the two report
   * files are described as cases, so a stray folder cannot look like one. Where
   * the report is small enough to read, its target and turn counts are included
   * so the list says what each case is about instead of only its name.
   */
  private async handleCaseList(): Promise<unknown> {
    const casesRoot = resolve(this.config.workspaceDir, "cases");
    const entries = await readdir(casesRoot, { withFileTypes: true }).catch(() => []);
    const cases: Array<{
      name: string;
      directory: string;
      savedAt: string;
      files: Array<{ name: string; bytes: number }>;
      summary?: ReturnType<typeof readCaseSummary>;
    }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(casesRoot, entry.name);
      const files = await this.caseFiles(directory);
      if (!files.some((file) => file.name === "analysis.json")) continue;
      if (!files.some((file) => file.name === "analysis.md")) continue;

      const reportFile = files.find((file) => file.name === "analysis.json");
      const report =
        reportFile !== undefined && reportFile.bytes <= CASE_SUMMARY_MAX_BYTES
          ? readCaseSummary(await readFile(join(directory, "analysis.json"), "utf8").catch(() => ""))
          : undefined;

      cases.push({
        name: entry.name,
        directory,
        savedAt: new Date((await stat(directory).catch(() => undefined))?.mtimeMs ?? Date.now()).toISOString(),
        files,
        ...(report === undefined ? {} : { summary: report }),
      });
    }

    cases.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
    return { ok: true, casesRoot, cases: cases.slice(0, CASE_LIST_LIMIT), total: cases.length };
  }

  /**
   * Reads a saved case back: the Markdown report, the JSON companion, and the
   * counts from REA's bundle if one was written. Nothing here re-runs analysis;
   * it shows what the folder actually contains.
   */
  private async handleCaseOpen(params: Record<string, unknown>): Promise<unknown> {
    const name = this.caseName(params["name"], "");
    if (name === "") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"name" is required.');
    }
    const directory = await this.resolveCaseDirectory(name);
    if (directory === undefined) {
      return { ok: false, name, files: [], error: `No saved case named "${name}" in this workspace.` };
    }

    const files = await this.caseFiles(directory);
    if (!files.some((file) => file.name === "analysis.json")) {
      return { ok: false, name, directory, files, error: "This folder has no analysis.json, so it is not a readable case." };
    }

    const readText = async (file: string): Promise<string | undefined> =>
      await readFile(join(directory, file), "utf8").catch(() => undefined);
    const reportJson = await readText("analysis.json");
    if (reportJson === undefined) {
      return { ok: false, name, directory, files, error: "analysis.json could not be read." };
    }
    const summary = readCaseSummary(reportJson);
    if (summary === undefined) {
      return { ok: false, name, directory, files, error: "analysis.json is not valid JSON, so this case cannot be read." };
    }
    const report = await readText("analysis.md");
    const truncated = report !== undefined && report.length > CASE_REPORT_MAX_CHARS;

    const bundleFile = files.find((file) => file.name === "evidence-bundle.json");
    const bundle =
      bundleFile === undefined
        ? undefined
        : {
          path: join(directory, "evidence-bundle.json"),
          bytes: bundleFile.bytes,
          ...(readBundleCounts(await readText("evidence-bundle.json") ?? "") ?? {}),
        };

    const savedAt = new Date((await stat(directory).catch(() => undefined))?.mtimeMs ?? Date.now()).toISOString();
    return {
      ok: true,
      name,
      directory,
      savedAt,
      files,
      summary,
      ...(report === undefined ? {} : { report: truncated ? report.slice(0, CASE_REPORT_MAX_CHARS) : report }),
      reportTruncated: truncated,
      reportJson: reportJson.length > CASE_REPORT_MAX_CHARS ? reportJson.slice(0, CASE_REPORT_MAX_CHARS) : reportJson,
      jsonTruncated: reportJson.length > CASE_REPORT_MAX_CHARS,
      ...(bundle === undefined ? {} : { bundle }),
    };
  }

  /**
   * Removes a saved case folder.
   *
   * Destructive and irreversible, so it only ever touches one directory that is
   * strictly inside `<workspaceDir>/cases`, never the root itself, and never a
   * path that is not a directory. The caller must confirm in the UI; the bridge
   * re-checks the name rather than trusting that.
   */
  private async handleCaseDelete(params: Record<string, unknown>): Promise<unknown> {
    const name = this.caseName(params["name"], "");
    if (name === "") {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"name" is required.');
    }
    const directory = await this.resolveCaseDirectory(name);
    if (directory === undefined) {
      return { ok: false, name, error: `No saved case named "${name}" in this workspace.` };
    }
    // `resolveCaseDirectory` already proves containment and directory-ness; this
    // covers the case where the name is the root itself (e.g. "." would fail the
    // name rule, but the guard is cheap and states the invariant).
    const casesRoot = resolve(this.config.workspaceDir, "cases");
    if (directory === casesRoot || !directory.startsWith(`${casesRoot}${sep}`)) {
      throw new JsonRpcException(JSON_RPC_ERRORS.INVALID_PARAMS, '"name" must address a case folder.');
    }

    try {
      await rm(directory, { recursive: true, force: false, maxRetries: 2 });
    } catch (error) {
      return { ok: false, name, directory, error: `The case folder could not be removed: ${(error as Error).message}` };
    }
    return { ok: true, name, directory };
  }

  private async handleTargetSession(): Promise<unknown> {
    const session = await this.refreshSessionState();
    return { session: serializeSession(session) };
  }

  private async handleTargetOpen(params: Record<string, unknown>): Promise<unknown> {
    const path = this.canonicalizePathParam(params["path"]);
    const format = params["format"];
    if (format !== undefined && typeof format !== "string") {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"format" must be a string when provided.',
      );
    }
    const providerId = params["providerId"];
    if (providerId !== undefined && typeof providerId !== "string") {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"providerId" must be a string when provided.',
      );
    }

    const { connection } = await this.ensureConnected();
    const opened = await connection.callTool("open_binary", {
      path,
      ...(format === undefined ? {} : { format }),
      ...(providerId === undefined ? {} : { provider_id: providerId }),
    });
    const observation = projectToolResult(opened, { maxChars: 4_000 });
    const ok =
      opened.isError !== true && !observation.text.startsWith(ToolObservation.errorPrefix);
    const session = await this.refreshSessionState();

    return {
      ok,
      observation: observation.text,
      session: serializeSession(session),
    };
  }

  private async handleTargetClose(): Promise<unknown> {
    const { connection, catalog } = await this.ensureConnected();
    if (!catalog.has("close_binary")) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.SERVER_ERROR,
        'Connected REA server does not advertise "close_binary".',
      );
    }
    const closed = await connection.callTool("close_binary", {});
    const observation = projectToolResult(closed, { maxChars: 4_000 });
    const ok =
      closed.isError !== true && !observation.text.startsWith(ToolObservation.errorPrefix);
    const session = await this.refreshSessionState();

    return {
      ok,
      observation: observation.text,
      session: serializeSession(session),
    };
  }

  private async handleTargetProbe(params: Record<string, unknown>): Promise<unknown> {
    const path = this.canonicalizePathParam(params["path"]);
    const { connection, catalog } = await this.ensureConnected();

    const opened = await connection.callTool("open_binary", { path });
    const openObservation = projectToolResult(opened, { maxChars: 4_000 });
    const openFailed =
      opened.isError === true || openObservation.text.startsWith(ToolObservation.errorPrefix);
    const session = await this.refreshSessionState();

    if (openFailed) {
      return {
        ok: false,
        open: openObservation.text,
        session: serializeSession(session),
        overview: null,
      };
    }

    let overview: string | null = null;
    let overviewError: string | undefined;
    if (catalog.has("binary_overview")) {
      const rawOverview = await connection.callTool("binary_overview", {});
      const overviewObservation = projectToolResult(rawOverview, { maxChars: 6_000 });
      if (rawOverview.isError === true || overviewObservation.text.startsWith(ToolObservation.errorPrefix)) {
        // A target can open successfully while its inspection provider is
        // unavailable. Report that honestly instead of presenting an error
        // string as if it were an overview.
        overviewError = overviewObservation.text;
      } else {
        overview = overviewObservation.text;
      }
    }

    return {
      ok: true,
      open: openObservation.text,
      session: serializeSession(session),
      overview,
      ...(overviewError === undefined ? {} : { overviewError }),
    };
  }

  private async handleAgentAsk(
    params: Record<string, unknown>,
    requestId: JsonRpcId,
  ): Promise<unknown> {
    const rawQuestion = params["question"];
    if (typeof rawQuestion !== "string" || rawQuestion.trim() === "") {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"question" is required and must be a non-empty string.',
      );
    }

    if (this.agent?.isRunning === true || this.activeTurnAbort !== undefined) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.SERVER_ERROR,
        "An agent turn is already running; await completion or call agent.cancel first.",
      );
    }

    const requestedScope =
      params["scope"] === undefined ? undefined : this.validateScopeName(params["scope"]);
    const extraInstructions = params["extraInstructions"];
    if (extraInstructions !== undefined && typeof extraInstructions !== "string") {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"extraInstructions" must be a string when provided.',
      );
    }

    const clientRequestId = params["clientRequestId"];
    if (
      clientRequestId !== undefined &&
      (typeof clientRequestId !== "string" || clientRequestId.length === 0 || clientRequestId.length > 128)
    ) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"clientRequestId" must be a non-empty string of at most 128 characters when provided.',
      );
    }

    const agent = await this.ensureAgent(requestedScope, extraInstructions);
    // A desktop client can correlate streamed events with its own optimistic
    // message id. Without it, events carry the JSON-RPC request id so existing
    // stdio clients keep their current behaviour.
    const unsubs = this.forwardAgentEvents(agent, clientRequestId ?? requestId);
    const controller = new AbortController();
    this.activeTurnAbort = controller;

    try {
      const result = await agent.ask(rawQuestion.trim(), { signal: controller.signal });
      return {
        content: result.content,
        reason: result.reason,
        ...(result.error === undefined ? {} : { error: result.error }),
        iterations: result.iterations,
        toolCallsExecuted: result.toolCallsExecuted,
        usage: result.usage ?? null,
        transcriptLength: agent.transcript().length,
      };
    } finally {
      this.activeTurnAbort = undefined;
      for (const unsub of unsubs) unsub();
    }
  }

  private forwardAgentEvents(agent: AgentSession, requestId: JsonRpcId): Array<() => void> {
    const emitEvent = <K extends keyof AgentEvents>(type: K, data: AgentEvents[K]): void => {
      this.notify("agent.event", { requestId, type, data });
    };

    return [
      agent.on("assistant_delta", (data) => emitEvent("assistant_delta", data)),
      agent.on("iteration", (data) => emitEvent("iteration", data)),
      agent.on("context_pruned", (data) => emitEvent("context_pruned", data)),
      agent.on("error", (data) => emitEvent("error", data)),
      agent.on("tool_call_started", (data) => emitEvent("tool_call_started", data)),
      agent.on("tool_call_finished", (data) => emitEvent("tool_call_finished", data)),
      agent.on("done", (data) => emitEvent("done", data)),
    ];
  }

  private async handleAgentReset(params: Record<string, unknown>): Promise<unknown> {
    if (this.agent?.isRunning === true || this.activeTurnAbort !== undefined) {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.SERVER_ERROR,
        "Cannot reset while an agent turn is running; call agent.cancel first.",
      );
    }

    const requestedScope =
      params["scope"] === undefined ? undefined : this.validateScopeName(params["scope"]);
    const extraInstructions = params["extraInstructions"];
    if (extraInstructions !== undefined && typeof extraInstructions !== "string") {
      throw new JsonRpcException(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        '"extraInstructions" must be a string when provided.',
      );
    }

    if (requestedScope !== undefined) {
      this.activeScopeName = requestedScope;
    }
    if (extraInstructions !== undefined) {
      this.activeExtraInstructions = extraInstructions;
    }

    if (this.connectedState !== undefined) {
      this.agent = undefined;
      await this.refreshSessionState();
      await this.ensureAgent(this.activeScopeName, this.activeExtraInstructions);
    } else {
      this.agent = undefined;
    }

    return {
      ok: true,
      scope: this.activeScopeName,
    };
  }

  private sendResult(id: JsonRpcId, result: unknown): void {
    this.writeOutbound({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private sendError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.writeOutbound({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.writeOutbound({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private writeOutbound(message: JsonRpcOutboundMessage): void {
    if (this.closed && message.jsonrpc === "2.0" && "method" in message) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
