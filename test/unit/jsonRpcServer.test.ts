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
