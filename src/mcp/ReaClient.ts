/**
 * Owns the REA MCP server connection.
 *
 * Responsibilities:
 *   - spawn `node <rea>/scripts/rea.mjs mcp` (stdio) or attach to `rea mcp --http`
 *   - complete the MCP handshake within a bounded startup budget
 *   - capture the child's stderr into a ring buffer for the diagnostics panel
 *   - expose `listTools` / `callTool` with per-call timeouts and cancellation
 *
 * It deliberately does not interpret tool results; see `evidence.ts`.
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { ReaServerConfig } from "../config.js";
import { Emitter } from "../util/emitter.js";
import type { McpCallToolResult, McpServerVersion, McpToolDefinition } from "./types.js";

/** Transport-agnostic surface the agent loop depends on. */
export interface McpConnection {
  listTools(): Promise<readonly McpToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<McpCallToolResult>;
  serverVersion(): McpServerVersion | undefined;
  close(): Promise<void>;
}

export type ReaClientState = "idle" | "connecting" | "ready" | "failed" | "closed";

export interface ReaClientEvents {
  stderr: { readonly line: string; readonly stream: "stderr" };
  state: { readonly state: ReaClientState; readonly detail?: string };
}

export class McpCallError extends Error {
  public override readonly name = "McpCallError";
  public constructor(
    public readonly toolName: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

const STDERR_RING_CAPACITY = 500;

export interface ReaClientOptions {
  /** Injected for tests; defaults to the SDK's stdio transport. */
  readonly clientFactory?: () => Client;
}

export class ReaClient extends Emitter<ReaClientEvents> implements McpConnection {
  private readonly config: ReaServerConfig;
  private readonly clientFactory: () => Client;
  private client: Client | undefined;
  private transport: { close(): Promise<void> } | undefined;
  private currentState: ReaClientState = "idle";
  private readonly stderrRing: string[] = [];
  private toolsCache: McpToolDefinition[] | undefined;

  public constructor(config: ReaServerConfig, options: ReaClientOptions = {}) {
    super();
    this.config = config;
    this.clientFactory = options.clientFactory ?? (() => new Client(
      { name: "rea-desktop", version: "0.1.0" },
      { capabilities: {} },
    ));
  }

  public get state(): ReaClientState {
    return this.currentState;
  }

  /** Retained child-process stderr, oldest first. */
  public stderrLines(): readonly string[] {
    return [...this.stderrRing];
  }

  private setState(state: ReaClientState, detail?: string): void {
    this.currentState = state;
    this.emit("state", detail === undefined ? { state } : { state, detail });
  }

  private pushStderr(chunk: string): void {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line === "") continue;
      this.stderrRing.push(line);
      if (this.stderrRing.length > STDERR_RING_CAPACITY) {
        this.stderrRing.shift();
      }
      this.emit("stderr", { line, stream: "stderr" });
    }
  }

  /** Performs the MCP handshake. Idempotent. */
  public async connect(): Promise<void> {
    if (this.currentState === "ready") return;
    if (this.currentState === "connecting") {
      throw new Error("connect() called while already connecting");
    }

    this.setState("connecting");
    const client = this.clientFactory();

    try {
      const transport = this.buildTransport();
      this.transport = transport;
      this.client = client;

      const startupTimeout = this.config.startupTimeoutSec * 1000;
      await client.connect(transport as never, { timeout: startupTimeout });
      this.setState("ready");
    } catch (error) {
      this.setState("failed", describeError(error));
      await this.closeQuietly();
      throw error;
    }
  }

  private buildTransport(): StdioClientTransport | StreamableHTTPClientTransport {
    if (this.config.transport === "http") {
      const url = new URL(this.config.httpUrl);
      return new StreamableHTTPClientTransport(url);
    }

    const transport = new StdioClientTransport({
      command: this.config.command,
      args: [...this.config.args],
      // Inherit only the SDK's safe allowlist, then apply configured overrides.
      // `getDefaultEnvironment` deliberately excludes the full parent env so the
      // child cannot inherit credentials or proxy settings by accident.
      env: { ...getDefaultEnvironment(), ...this.config.env },
      ...(this.config.cwd === undefined ? {} : { cwd: this.config.cwd }),
      stderr: "pipe",
    });

    const stderr = transport.stderr as NodeJS.ReadableStream | null | undefined;
    if (stderr !== null && stderr !== undefined) {
      const decodable = stderr as NodeJS.ReadableStream & {
        setEncoding(encoding: BufferEncoding): unknown;
      };
      decodable.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        this.pushStderr(chunk);
      });
    }

    return transport;
  }

  /** Canonical tool inventory. Cached after the first successful listing. */
  public async listTools(): Promise<readonly McpToolDefinition[]> {
    if (this.toolsCache !== undefined) return this.toolsCache;
    const client = this.requireClient();
    const result = await client.listTools();
    const tools = (result.tools ?? []) as unknown as McpToolDefinition[];
    this.toolsCache = [...tools];
    return this.toolsCache;
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<McpCallToolResult> {
    const client = this.requireClient();

    const requestOptions: Record<string, unknown> = {};
    if (options.timeoutMs !== undefined) requestOptions["timeout"] = options.timeoutMs;
    if (options.signal !== undefined) requestOptions["signal"] = options.signal;

    try {
      const result = await client.callTool(
        { name, arguments: args },
        requestOptions as never,
      );
      return result as unknown as McpCallToolResult;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new McpCallError(name, `Tool call "${name}" was cancelled.`, error);
      }
      throw new McpCallError(name, `Tool call "${name}" failed: ${describeError(error)}`, error);
    }
  }

  public serverVersion(): McpServerVersion | undefined {
    const version = this.client?.getServerVersion();
    if (version === undefined) return undefined;
    return { name: version.name, version: version.version };
  }

  public async close(): Promise<void> {
    await this.closeQuietly();
    this.setState("closed");
  }

  private async closeQuietly(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    const client = this.client;
    this.client = undefined;
    this.toolsCache = undefined;

    try {
      if (client !== undefined) await client.close();
    } catch {
      // Shutdown races are not actionable; the job object reaps the child.
    }
    try {
      if (transport !== undefined) await transport.close();
    } catch {
      // Same.
    }
  }

  private requireClient(): Client {
    if (this.client === undefined || this.currentState !== "ready") {
      throw new Error(
        `REA MCP connection is not ready (state=${this.currentState}). Call connect() first.`,
      );
    }
    return this.client;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
