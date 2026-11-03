import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  EngineRpcServer,
  JSON_RPC_ERRORS,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  type JsonRpcOutboundMessage,
  type JsonRpcSuccessResponse,
} from "../../src/bridge/JsonRpcServer.js";
import { DEFAULT_CONFIG, type ReaClientConfig } from "../../src/config.js";
import type { DoctorReport } from "../../src/doctor.js";
import type { ChatTransport, StreamingChatRequest } from "../../src/llm/types.js";
import { FakeConnection, ScriptedChat, textTurn, tool, toolCallTurn } from "../support/fakes.js";

const BRIDGE_TOOLS = [
  "open_binary",
  "close_binary",
  "binary_session",
  "binary_overview",
  "analyze_function",
  "xrefs",
].map((name) => tool(name));

class RpcHarness {
  public readonly input = new PassThrough();
  public readonly output = new PassThrough();
  public readonly server: EngineRpcServer;
  public readonly notifications: JsonRpcNotification[] = [];
  private readonly pending = new Map<
    string | number | null,
    (msg: JsonRpcSuccessResponse | JsonRpcErrorResponse) => void
  >();
  private readonly unmatched: (JsonRpcSuccessResponse | JsonRpcErrorResponse)[] = [];
  private buffer = "";
  private readonly runPromise: Promise<void>;

  public constructor(options: {
    config?: ReaClientConfig;
    maxLineBytes?: number;
    platform?: "windows" | "posix";
    connection?: FakeConnection & { connect?: () => Promise<void>; close?: () => Promise<void> };
    chat?: ChatTransport;
    doctorReport?: DoctorReport;
  } = {}) {
    let isOpen = false;
    let currentPath: string | undefined;

    const defaultConnection = new FakeConnection(BRIDGE_TOOLS, (name, args) => {
      if (name === "open_binary") {
        const p = String(args["path"] ?? "");
        if (p.includes("missing")) {
          return {
            isError: true,
            content: [{ type: "text", text: '{"error":{"code":"not_found","message":"missing"}}' }],
          };
        }
        isOpen = true;
        currentPath = p;
        return { content: [{ type: "text", text: `opened ${p}` }] };
      }
      if (name === "close_binary") {
        isOpen = false;
        currentPath = undefined;
        return { content: [{ type: "text", text: "closed" }] };
      }
      if (name === "binary_session") {
        return {
          structuredContent: {
            result: isOpen
              ? {
                  open: true,
                  path: currentPath,
                  format: "pe",
                  architecture: "x86_64",
                  sha256: "bb".repeat(32),
                  packageVersion: "6.8.0",
                }
              : { open: false, packageVersion: "6.8.0" },
          },
        };
      }
      if (name === "binary_overview") {
        return { content: [{ type: "text", text: "overview summary" }] };
      }
      return { content: [{ type: "text", text: `ok:${name}` }] };
    });

    const conn = options.connection ?? defaultConnection;
    const chat = options.chat ?? new ScriptedChat([textTurn("default answer")]);

    this.server = new EngineRpcServer({
      config: options.config ?? DEFAULT_CONFIG,
      input: this.input,
      output: this.output,
      platform: options.platform ?? "windows",
      ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
      createConnection: () => conn,
      createChat: () => chat,
      runDoctorImpl: async (_cfg, opts) =>
        options.doctorReport ?? {
          healthy: true,
          checks: [
            {
              id: "llm",
              label: "Local model server",
              status: opts?.skipLlm === true ? "skipped" : "ok",
              detail: "ok",
            },
          ],
        },
    });

    this.output.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const nl = this.buffer.indexOf("\n");
        if (nl === -1) break;
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        const parsed = JSON.parse(line) as JsonRpcOutboundMessage;
        if ("method" in parsed) {
          this.notifications.push(parsed);
        } else {
          const waiter = this.pending.get(parsed.id);
          if (waiter !== undefined) {
            this.pending.delete(parsed.id);
            waiter(parsed);
          } else {
            this.unmatched.push(parsed);
          }
        }
      }
    });

    this.runPromise = this.server.run();
  }

  public sendRaw(raw: string): void {
    this.input.write(raw);
  }

  public async nextUnmatched(): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse> {
    if (this.unmatched.length > 0) {
      return this.unmatched.shift()!;
    }
    return new Promise((resolve) => {
      this.pending.set(null, resolve);
    });
  }

  public async call(
    id: string | number,
    method: string,
    params?: Record<string, unknown>,
    lineEnding = "\n",
  ): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse> {
    const responsePromise = new Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse>(
      (resolve) => {
        this.pending.set(id, resolve);
      },
    );
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    this.input.write(`${frame}${lineEnding}`);
    return responsePromise;
  }

  public async close(): Promise<void> {
    this.input.end();
    await this.runPromise;
  }
}

describe("EngineRpcServer — framing and JSON-RPC 2.0 validation", () => {
  it("supports CRLF framing, chunk-split frames, and client notifications", async () => {
    const harness = new RpcHarness();
    try {
      // Notification (no id) must not produce a response frame.
      harness.sendRaw('{"jsonrpc":"2.0","method":"engine.ping"}\r\n');

      // Split a valid request across three chunks with CRLF terminator.
      const splitPromise = new Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse>((resolve) => {
        (harness as unknown as { pending: Map<unknown, unknown> }).pending.set(1, resolve);
      });
      harness.sendRaw('{"jsonrpc":"2.0",');
      harness.sendRaw('"id":1,"method":');
      harness.sendRaw('"engine.ping"}\r\n');

      const res = await splitPromise;
      expect("result" in res && res.result).toMatchObject({ ok: true, version: "0.1.0" });
    } finally {
      await harness.close();
    }
  });

  it("returns standard JSON-RPC error codes for invalid frames, params, and methods", async () => {
    const harness = new RpcHarness({ maxLineBytes: 128 });
    try {
      harness.sendRaw("{not-valid-json}\n");
      const parseErr = await harness.nextUnmatched();
      expect("error" in parseErr && parseErr.error.code).toBe(JSON_RPC_ERRORS.PARSE_ERROR);

      // Oversized frame > 128 bytes fails closed with -32700, then recovers cleanly!
      harness.sendRaw(`{"jsonrpc":"2.0","id":99,"method":"${"x".repeat(300)}"}\n`);
      const oversizedErr = await harness.nextUnmatched();
      expect("error" in oversizedErr && oversizedErr.error.code).toBe(JSON_RPC_ERRORS.PARSE_ERROR);

      harness.sendRaw('{"jsonrpc":"1.0","id":2,"method":"engine.ping"}\n');
      const badVersion = await harness.nextUnmatched();
      expect("error" in badVersion && badVersion.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);

      const unknownMethod = await harness.call(3, "engine.doesNotExist");
      expect("error" in unknownMethod && unknownMethod.error.code).toBe(
        JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      );

      const badParams = await harness.call(4, "target.open", { path: "relative\\sample.exe" });
      expect("error" in badParams && badParams.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);

      const nonLocalUnc = await harness.call(5, "target.open", {
        path: "\\\\10.0.0.9\\share\\sample.exe",
      });
      expect("error" in nonLocalUnc && nonLocalUnc.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
    } finally {
      await harness.close();
    }
  });
});

describe("EngineRpcServer — lifecycle, target management, and stateful agent turns", () => {
  it("drives doctor, tools, target open/probe/close, and synchronizes AgentSession prompt", async () => {
    const chat = new ScriptedChat([
      toolCallTurn("analyze_function", { procedure: "0x140001000" }),
      textTurn("Entry point initializes stack cookie [ev_1]."),
      textTurn("Follow-up after target closed."),
    ]);
    const harness = new RpcHarness({ chat });

    try {
      const doctorRes = (await harness.call(1, "engine.doctor", {
        skipLlm: true,
      })) as JsonRpcSuccessResponse;
      expect(doctorRes.result).toMatchObject({ healthy: true });

      const toolsRes = (await harness.call(2, "tools.list", {
        scope: "binary-core",
      })) as JsonRpcSuccessResponse;
      expect(toolsRes.result).toMatchObject({ total: BRIDGE_TOOLS.length });

      const openRes = (await harness.call(3, "target.open", {
        path: "C:/targets/sample.exe",
      })) as JsonRpcSuccessResponse;
      expect(openRes.result).toMatchObject({
        ok: true,
        session: { open: true, targetPath: "C:\\targets\\sample.exe", format: "pe" },
      });

      const askRes = (await harness.call(4, "agent.ask", {
        question: "Explain 0x140001000",
      })) as JsonRpcSuccessResponse;
      expect(askRes.result).toMatchObject({
        reason: "final_answer",
        toolCallsExecuted: 1,
      });

      // Verify notifications streamed with requestId = 4.
      const eventTypes = harness.notifications
        .filter((n) => n.method === "agent.event" && n.params["requestId"] === 4)
        .map((n) => n.params["type"]);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "tool_call_started",
          "tool_call_finished",
          "assistant_delta",
          "done",
        ]),
      );

      // Verify the LLM received the opened target's path and format in the system prompt!
      expect(chat.requests[0]?.messages[0]?.content).toContain("path: C:\\targets\\sample.exe");
      expect(chat.requests[0]?.messages[0]?.content).toContain("format: pe");

      // Close target and verify the next turn sees "Open target: none" while keeping transcript!
      const closeRes = (await harness.call(5, "target.close")) as JsonRpcSuccessResponse;
      expect(closeRes.result).toMatchObject({ ok: true, session: { open: false } });

      await harness.call(6, "agent.ask", { question: "What now?" });
      expect(chat.requests[2]?.messages[0]?.content).toContain("Open target: none");

      const transcriptRes = (await harness.call(7, "agent.transcript")) as JsonRpcSuccessResponse;
      const transcriptPayload = transcriptRes.result as { messages: unknown[] };
      expect(transcriptPayload.messages.length).toBeGreaterThan(3);

      const resetRes = (await harness.call(8, "agent.reset", {
        scope: "binary-extended",
      })) as JsonRpcSuccessResponse;
      expect(resetRes.result).toEqual({ ok: true, scope: "binary-extended" });

      const probeOk = (await harness.call(9, "target.probe", {
        path: "C:\\targets\\good.exe",
      })) as JsonRpcSuccessResponse;
      expect(probeOk.result).toMatchObject({ ok: true, overview: "overview summary" });

      const sessionRes = (await harness.call(10, "target.session")) as JsonRpcSuccessResponse;
      expect(sessionRes.result).toMatchObject({
        session: { open: true, targetPath: "C:\\targets\\good.exe" },
      });

      const probeFail = (await harness.call(11, "target.probe", {
        path: "C:\\targets\\missing.exe",
      })) as JsonRpcSuccessResponse;
      expect(probeFail.result).toMatchObject({ ok: false, overview: null });
    } finally {
      await harness.close();
    }
  });

  it("carries transcript history across mid-session scope switches and handles trailing EOF frame", async () => {
    const chat = new ScriptedChat([
      textTurn("Turn 1 answer."),
      textTurn("Turn 2 answer in extended scope."),
    ]);
    const harness = new RpcHarness({ chat });

    await harness.call("t1", "agent.ask", {
      question: "First question",
      extraInstructions: "Keep it brief.",
    });
    const second = (await harness.call("t2", "agent.ask", {
      question: "Second question",
      scope: "binary-extended",
    })) as JsonRpcSuccessResponse;

    expect(second.result).toMatchObject({ reason: "final_answer" });
    // Second turn carried the first user/assistant exchange across the scope switch!
    expect(
      chat.requests[1]?.messages.some((m) => m.content?.includes("First question")),
    ).toBe(true);

    // Send a trailing frame without newline right before EOF.
    const eofResponse = new Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse>((resolve) => {
      (harness as unknown as { pending: Map<unknown, unknown> }).pending.set("eof-1", resolve);
    });
    harness.sendRaw('{"jsonrpc":"2.0","id":"eof-1","method":"engine.ping"}');
    await harness.close();
    const finalPing = await eofResponse;
    expect("result" in finalPing && finalPing.result).toMatchObject({ ok: true });
  });

  it("aborts an in-flight agent.ask turn immediately when agent.cancel arrives concurrently", async () => {
    let streamStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });

    const slowChat: ChatTransport = {
      async *streamChat(_req: StreamingChatRequest, options?: { signal?: AbortSignal }) {
        yield { type: "text_delta", text: "partial..." };
        streamStarted();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    };

    const closeSpy = vi.fn(async () => undefined);
    const conn = Object.assign(new FakeConnection(BRIDGE_TOOLS), { close: closeSpy });
    const harness = new RpcHarness({ chat: slowChat, connection: conn });

    const askPromise = harness.call("turn-1", "agent.ask", {
      question: "Decompile everything",
    });

    await startedPromise;
    const cancelRes = (await harness.call("cancel-1", "agent.cancel")) as JsonRpcSuccessResponse;
    expect(cancelRes.result).toEqual({ cancelled: true });

    const askRes = (await askPromise) as JsonRpcSuccessResponse;
    expect(askRes.result).toMatchObject({ reason: "cancelled" });

    const shutdownRes = (await harness.call("bye", "engine.shutdown")) as JsonRpcSuccessResponse;
    expect(shutdownRes.result).toEqual({ ok: true });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("EngineRpcServer — target probe reporting", () => {
  it("keeps a failed overview distinct from a successful target open", async () => {
    const connection = new FakeConnection(BRIDGE_TOOLS, (name) => {
      if (name === "open_binary") {
        return { content: [{ type: "text", text: "opened C:\\targets\\provider.exe" }] };
      }
      if (name === "binary_overview") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: '{"error":{"code":"provider_unavailable","message":"No analysis provider is available."}}',
            },
          ],
        };
      }
      if (name === "binary_session") {
        return {
          structuredContent: {
            result: {
              open: true,
              path: "C:\\targets\\provider.exe",
              format: "pe",
              packageVersion: "6.8.0",
            },
          },
        };
      }
      return { content: [{ type: "text", text: `ok:${name}` }] };
    });
    const harness = new RpcHarness({ connection });

    try {
      const response = (await harness.call("probe", "target.probe", {
        path: "C:\\targets\\provider.exe",
      })) as JsonRpcSuccessResponse;
      const result = response.result as { ok: boolean; overview: string | null; overviewError?: string };
      expect(result.ok).toBe(true);
      expect(result.overview).toBeNull();
      expect(result.overviewError).toContain("provider_unavailable");
    } finally {
      await harness.close();
    }
  });
});

describe("EngineRpcServer — desktop event correlation", () => {
  it("tags streamed agent events with the caller's client request id", async () => {
    const harness = new RpcHarness({ chat: new ScriptedChat([textTurn("Streamed answer.")]) });

    try {
      const response = (await harness.call("ask-1", "agent.ask", {
        question: "What does it do?",
        clientRequestId: "ui-abc",
      })) as JsonRpcSuccessResponse;
      expect(response.result).toMatchObject({ content: "Streamed answer." });
      const tagged = harness.notifications.filter(
        (notification) =>
          notification.method === "agent.event" && notification.params["requestId"] === "ui-abc",
      );
      expect(tagged.length).toBeGreaterThan(0);
      expect(
        harness.notifications.some(
          (notification) =>
            notification.method === "agent.event" && notification.params["requestId"] === "ask-1",
        ),
      ).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("rejects a client request id that is not a bounded non-empty string", async () => {
    const harness = new RpcHarness();

    try {
      for (const clientRequestId of ["", "x".repeat(129), 7]) {
        const response = (await harness.call("ask-2", "agent.ask", {
          question: "Hello",
          clientRequestId,
        })) as JsonRpcErrorResponse;
        expect(response.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
      }
    } finally {
      await harness.close();
    }
  });
});

const EVIDENCE_ID = `ev_${"4e8c8fb7".repeat(8)}`;

function evidenceConnection(): FakeConnection {
  return new FakeConnection(
    ["open_binary", "close_binary", "binary_session", "get_evidence_bundle", "export_evidence_bundle"].map((name) => tool(name)),
    (name, args) => {
      if (name === "binary_session") {
        return { structuredContent: { result: { open: false, packageVersion: "6.8.0" } } };
      }
      if (name === "get_evidence_bundle") {
        const filters = (args["filters"] ?? {}) as { evidence_id?: string };
        const requested = filters.evidence_id;
        if (args["detail"] === "complete") {
          if (requested !== EVIDENCE_ID) {
            return { structuredContent: { result: { kind: "evidence-bundle", records: [] } } };
          }
          return {
            structuredContent: {
              result: {
                kind: "evidence-bundle",
                records: [
                  {
                    evidence_id: EVIDENCE_ID,
                    operation: "inspect_artifact",
                    subject: { name: "/usr/bin/ls", digest: { sha256: "aa".repeat(32) }, format: "elf" },
                    provider: { id: "rea-binary", version: "6.8.0" },
                    confidence: "high",
                    authority: "observed",
                    retention: "session",
                    limitation_count: 1,
                    detail: { imports: ["puts"] },
                  },
                ],
              },
            },
          };
        }
        const matches = requested === undefined || requested === EVIDENCE_ID;
        return {
          structuredContent: {
            result: {
              kind: "evidence-bundle-summary",
              total_retained_records: 2,
              matching_records: requested === undefined ? 2 : matches ? 1 : 0,
              unknown_revisions: 0,
              records: matches
                ? [
                    {
                      evidence_id: EVIDENCE_ID,
                      subject: { name: "/usr/bin/ls", digest: { sha256: "aa".repeat(32) }, format: "elf" },
                      provider: { id: "rea-binary" },
                      operation: "inspect_artifact",
                      confidence: "high",
                      authority: "observed",
                      retention: "session",
                      limitation_count: 1,
                    },
                    ...(requested === undefined
                      ? [
                          {
                            evidence_id: `ev_${"1f".repeat(32)}`,
                            subject: { name: "/usr/bin/ls", format: "elf" },
                            provider: { id: "rea-binary" },
                            operation: "binary_session",
                          },
                        ]
                      : []),
                  ]
                : [],
            },
          },
        };
      }
      if (name === "export_evidence_bundle") {
        const path = String(args["path"] ?? "");
        // Windows absolute paths are `C:\…`, so ask the platform, not for a slash.
        if (!isAbsolute(path)) {
          return { isError: true, content: [{ type: "text", text: "path must be absolute" }] };
        }
        return { structuredContent: { result: { path, bytes: 8117, records: 2, unknowns: 0 } } };
      }
      return { content: [{ type: "text", text: `ok:${name}` }] };
    },
  );
}

describe("EngineRpcServer — retained evidence", () => {
  it("lists retained records from the summary and reads one full record", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rea-evidence-"));
    const harness = new RpcHarness({
      connection: evidenceConnection(),
      config: { ...DEFAULT_CONFIG, workspaceDir },
    });
    try {
      const listed = (await harness.call("list", "evidence.list")) as JsonRpcSuccessResponse;
      expect(listed.result).toMatchObject({
        ok: true,
        totalRetained: 2,
        matching: 2,
        unknownRevisions: 0,
      });
      const records = (listed.result as { records: Array<Record<string, unknown>> }).records;
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        evidenceId: EVIDENCE_ID,
        operation: "inspect_artifact",
        subjectName: "/usr/bin/ls",
        providerId: "rea-binary",
        confidence: "high",
        limitationCount: 1,
      });
      expect(records[1]).toMatchObject({ evidenceId: `ev_${"1f".repeat(32)}`, operation: "binary_session" });
      // The summary projection must not copy the full record payload.
      expect(JSON.stringify(listed.result)).not.toContain("imports");

      const record = (await harness.call("get", "evidence.get", {
        evidenceId: EVIDENCE_ID,
      })) as JsonRpcSuccessResponse;
      expect(record.result).toMatchObject({ ok: true, evidenceId: EVIDENCE_ID, truncated: false, untrusted: true });
      expect((record.result as { text: string }).text).toContain('"imports"');

      const missing = (await harness.call("missing", "evidence.get", {
        evidenceId: `ev_${"0".repeat(64)}`,
      })) as JsonRpcSuccessResponse;
      expect(missing.result).toMatchObject({ ok: false });
      expect(String((missing.result as { error: string }).error)).toContain("no retained evidence");

      for (const evidenceId of ["ev_nothex", "ev_" + "A".repeat(64), 42, undefined]) {
        const bad = (await harness.call(`bad-${String(evidenceId)}`, "evidence.get", {
          evidenceId,
        })) as JsonRpcErrorResponse;
        expect(bad.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
      }
    } finally {
      await harness.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("exports the bundle inside the workspace and refuses names that escape it", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rea-evidence-export-"));
    const connection = evidenceConnection();
    const harness = new RpcHarness({
      connection,
      config: { ...DEFAULT_CONFIG, workspaceDir },
    });
    try {
      const exported = (await harness.call("export", "evidence.export", {
        name: "findings",
      })) as JsonRpcSuccessResponse;
      expect(exported.result).toMatchObject({
        ok: true,
        bytes: 8117,
        records: 2,
        unknowns: 0,
        path: join(workspaceDir, "evidence", "findings.json"),
      });
      // REA writes the file; the bridge must point it at the workspace and nowhere else.
      expect(connection.calls.find((entry) => entry.name === "export_evidence_bundle")?.args["path"]).toBe(
        join(workspaceDir, "evidence", "findings.json"),
      );

      for (const name of ["../escape", "nested/path", "bad name", "x".repeat(120), ""]) {
        const bad = (await harness.call(`name-${name}`, "evidence.export", { name })) as JsonRpcErrorResponse;
        expect(bad.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
      }

      const badOverwrite = (await harness.call("bool", "evidence.export", {
        overwrite: "yes",
      })) as JsonRpcErrorResponse;
      expect(badOverwrite.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
    } finally {
      await harness.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("EngineRpcServer — saved cases", () => {
  it("writes a case folder with the report, the JSON companion, and REA's bundle", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rea-case-"));
    const connection = evidenceConnection();
    const harness = new RpcHarness({
      connection,
      config: { ...DEFAULT_CONFIG, workspaceDir },
    });
    try {
      const saved = (await harness.call("save", "case.save", {
        name: "ls-triage",
        report: "# REA analysis report\n\nbody",
        reportJson: '{"schemaVersion":1}',
      })) as JsonRpcSuccessResponse;
      const result = saved.result as {
        ok: boolean;
        name: string;
        directory: string;
        files: Array<{ name: string; bytes: number }>;
        evidence: { ok: boolean; records: number };
      };
      expect(result.ok).toBe(true);
      expect(result.name).toBe("ls-triage");
      expect(result.directory).toBe(join(workspaceDir, "cases", "ls-triage"));
      expect(result.files.map((file) => file.name)).toEqual([
        "analysis.md",
        "analysis.json",
        "evidence-bundle.json",
      ]);
      expect(result.evidence).toMatchObject({ ok: true, records: 2 });

      // The bridge owns every filename, and the engine was pointed inside the case.
      const bundle = connection.calls.find((entry) => entry.name === "export_evidence_bundle");
      expect(bundle?.args["path"]).toBe(join(workspaceDir, "cases", "ls-triage", "evidence-bundle.json"));
      expect(bundle?.args["overwrite"]).toBe(true);
    } finally {
      await harness.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing case unless asked, and can skip the bundle", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rea-case-again-"));
    const connection = evidenceConnection();
    const harness = new RpcHarness({
      connection,
      config: { ...DEFAULT_CONFIG, workspaceDir },
      // The oversized-report case needs a frame larger than the bridge default.
      maxLineBytes: 5_000_000,
    });
    try {
      const first = (await harness.call("one", "case.save", {
        name: "repeat",
        report: "# one",
        reportJson: "{}",
        includeEvidence: false,
      })) as JsonRpcSuccessResponse;
      expect((first.result as { files: unknown[] }).files).toHaveLength(2);
      expect(connection.calls.some((entry) => entry.name === "export_evidence_bundle")).toBe(false);

      const second = (await harness.call("two", "case.save", {
        name: "repeat",
        report: "# two",
        reportJson: "{}",
        includeEvidence: false,
      })) as JsonRpcSuccessResponse;
      expect(second.result).toMatchObject({ ok: false });
      expect(String((second.result as { error: string }).error)).toContain("already exists");

      const third = (await harness.call("three", "case.save", {
        name: "repeat",
        report: "# three",
        reportJson: "{}",
        includeEvidence: false,
        overwrite: true,
      })) as JsonRpcSuccessResponse;
      expect(third.result).toMatchObject({ ok: true, name: "repeat" });

      // A refused name, empty report, or oversized document is an argument error.
      for (const params of [
        { name: "../escape", report: "x", reportJson: "{}" },
        { name: "nested/path", report: "x", reportJson: "{}" },
        { name: "ok", report: "", reportJson: "{}" },
        { name: "ok", report: "x", reportJson: "" },
        { name: "ok", report: 5, reportJson: "{}" },
        { name: "ok", report: "x".repeat(2_000_001), reportJson: "{}" },
        { name: "ok", report: "x", reportJson: "{}", includeEvidence: "yes" },
      ]) {
        const bad = (await harness.call(`bad-${String(Math.random())}`, "case.save", params)) as JsonRpcErrorResponse;
        expect(bad.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
      }
    } finally {
      await harness.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reads a saved case back, with its summary, report, and bundle counts", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rea-case-open-"));
    const harness = new RpcHarness({ connection: evidenceConnection(), config: { ...DEFAULT_CONFIG, workspaceDir } });
    try {
      const report = {
        schemaVersion: 1,
        exportedAt: "2026-11-02T12:00:00.000Z",
        engineVersion: "6.8.0",
        target: { name: "ls", path: "/usr/bin/ls", format: "elf", architecture: "x86_64", sha256: "ab".repeat(32) },
        scope: "binary-core",
        turns: [
          {
            question: "What is this?",
            answer: "An ELF binary.",
            observations: [{ tool: "binary_overview", ok: true, evidenceId: `ev_${"cd".repeat(32)}` }],
          },
        ],
      };
      await harness.call("save", "case.save", {
        name: "readable",
        report: "# REA analysis report\n\nAn ELF binary.",
        reportJson: JSON.stringify(report),
        includeEvidence: false,
      });

      const opened = (await harness.call("open", "case.open", { name: "readable" })) as JsonRpcSuccessResponse;
      expect(opened.result).toMatchObject({
        ok: true,
        name: "readable",
        directory: join(workspaceDir, "cases", "readable"),
        reportTruncated: false,
        jsonTruncated: false,
        summary: {
          schemaVersion: 1,
          scope: "binary-core",
          turns: 1,
          observations: 1,
          evidenceReferences: 1,
          target: { name: "ls", format: "elf", architecture: "x86_64" },
        },
      });
      const result = opened.result as { report: string; reportJson: string; files: Array<{ name: string }> };
      expect(result.report).toContain("An ELF binary.");
      expect(JSON.parse(result.reportJson)).toMatchObject({ schemaVersion: 1 });
      expect(result.files.map((file) => file.name)).toEqual(["analysis.json", "analysis.md"]);

      // A missing case and a traversal attempt are answered, not thrown into a stack trace.
      const missing = (await harness.call("missing", "case.open", { name: "nope" })) as JsonRpcSuccessResponse;
      expect(missing.result).toMatchObject({ ok: false });
      expect(String((missing.result as { error: string }).error)).toContain("No saved case named");

      for (const name of ["../escape", "nested/path", ""]) {
        const bad = (await harness.call(`bad-${name}`, "case.open", { name })) as JsonRpcErrorResponse;
        expect(bad.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
      }
      const notString = (await harness.call("bad-type", "case.open", { name: 7 })) as JsonRpcErrorResponse;
      expect(notString.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
    } finally {
      await harness.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reports a case whose report is unreadable instead of showing an empty analysis", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rea-case-broken-"));
    const harness = new RpcHarness({ connection: evidenceConnection(), config: { ...DEFAULT_CONFIG, workspaceDir } });
    try {
      const { mkdir: makeDir, writeFile: write } = await import("node:fs/promises");
      const directory = join(workspaceDir, "cases", "broken");
      await makeDir(directory, { recursive: true });
      await write(join(directory, "analysis.md"), "# looks fine");
      await write(join(directory, "analysis.json"), "{ not json");

      const opened = (await harness.call("open", "case.open", { name: "broken" })) as JsonRpcSuccessResponse;
      expect(opened.result).toMatchObject({ ok: false, name: "broken" });
      expect(String((opened.result as { error: string }).error)).toContain("not valid JSON");
      expect((opened.result as { files: Array<{ name: string }> }).files.map((file) => file.name)).toEqual([
        "analysis.json",
        "analysis.md",
      ]);

      // A folder with only a report has no analysis.json at all.
      const half = join(workspaceDir, "cases", "half");
      await makeDir(half, { recursive: true });
      await write(join(half, "analysis.md"), "# only markdown");
      const partial = (await harness.call("half", "case.open", { name: "half" })) as JsonRpcSuccessResponse;
      expect(String((partial.result as { error: string }).error)).toContain("no analysis.json");

      // The list still shows the folder (it has both reports) but no summary,
      // and the markdown-only folder is not a case at all.
      const listed = (await harness.call("list", "case.list")) as JsonRpcSuccessResponse;
      const rows = (listed.result as { total: number; cases: Array<{ name: string; summary?: unknown }> });
      expect(rows.total).toBe(1);
      expect(rows.cases[0]?.name).toBe("broken");
      expect(rows.cases[0]?.summary).toBeUndefined();
    } finally {
      await harness.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("lists saved cases newest first and ignores folders that are not cases", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rea-case-list-"));
    const harness = new RpcHarness({ connection: evidenceConnection(), config: { ...DEFAULT_CONFIG, workspaceDir } });
    try {
      const empty = (await harness.call("empty", "case.list")) as JsonRpcSuccessResponse;
      expect(empty.result).toEqual({ ok: true, casesRoot: join(workspaceDir, "cases"), cases: [], total: 0 });

      for (const name of ["older", "newer"]) {
        await harness.call(name, "case.save", {
          name,
          report: `# ${name}`,
          reportJson: "{}",
          includeEvidence: false,
        });
        // Distinct mtimes keep the ordering assertion meaningful on coarse clocks.
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      const { mkdir: makeDir, writeFile: write } = await import("node:fs/promises");
      await makeDir(join(workspaceDir, "cases", "not-a-case"), { recursive: true });
      await write(join(workspaceDir, "cases", "stray.txt"), "ignored");

      const listed = (await harness.call("list", "case.list")) as JsonRpcSuccessResponse;
      const result = listed.result as { cases: Array<{ name: string; files: Array<{ name: string }>; savedAt: string }>; total: number };
      expect(result.total).toBe(2);
      expect(result.cases.map((entry) => entry.name)).toEqual(["newer", "older"]);
      expect(result.cases[0]?.files.map((file) => file.name)).toEqual(["analysis.json", "analysis.md"]);
      // The list describes what each case is about, read from its report.
      expect((result.cases[0] as unknown as { summary: { turns: number } }).summary.turns).toBe(0);
      expect(Date.parse(result.cases[0]!.savedAt)).toBeGreaterThan(Date.parse(result.cases[1]!.savedAt));
    } finally {
      await harness.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
