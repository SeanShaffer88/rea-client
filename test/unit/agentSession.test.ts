import { describe, expect, it, vi } from "vitest";
import { AgentSession, groupIntoUnits, parseArguments } from "../../src/agent/AgentSession.js";
import type { AgentEvents } from "../../src/agent/events.js";
import { ToolCatalog } from "../../src/mcp/catalog.js";
import type { McpCallToolResult } from "../../src/mcp/types.js";
import type { ChatTransport } from "../../src/llm/types.js";
import { FakeConnection, ScriptedChat, textTurn, tool, toolCallTurn } from "../support/fakes.js";

const TOOLS = [
  "open_binary",
  "binary_session",
  "analyze_function",
  "procedure_pseudo_code",
  "xrefs",
  "list_strings",
].map((name) => tool(name));

function build(options: {
  chat: ChatTransport;
  responder?: (name: string, args: Record<string, unknown>) => McpCallToolResult;
  maxIterations?: number;
  contextWindow?: number;
  maxToolResultChars?: number;
}) {
  const catalog = ToolCatalog.from(TOOLS);
  const scope = catalog.resolveScope("custom", TOOLS.map((t) => t.name));
  const connection = new FakeConnection(TOOLS, options.responder);
  const agent = new AgentSession({
    connection,
    chat: options.chat,
    catalog,
    scope,
    model: "test-model",
    maxIterations: options.maxIterations ?? 4,
    maxToolResultChars: options.maxToolResultChars ?? 4_000,
    temperature: 0.1,
    maxTokens: 256,
    contextWindow: options.contextWindow ?? 16_384,
    systemPrompt: "system",
  });
  return { agent, connection, catalog, scope };
}

describe("AgentSession — final answers", () => {
  it("returns a text-only reply without calling tools", async () => {
    const { agent, connection } = build({ chat: new ScriptedChat([textTurn("Nothing to do.")]) });

    const result = await agent.ask("hello");

    expect(result.reason).toBe("final_answer");
    expect(result.content).toBe("Nothing to do.");
    expect(result.iterations).toBe(1);
    expect(connection.calls).toHaveLength(0);
  });

  it("advertises the scoped tools in the request", async () => {
    const chat = new ScriptedChat([textTurn("ok")]);
    const { agent } = build({ chat });

    await agent.ask("hi");

    const advertised = chat.requests[0]?.tools?.map((t) => t.function.name);
    expect(advertised).toEqual(expect.arrayContaining(["analyze_function", "xrefs"]));
    expect(chat.requests[0]?.toolChoice).toBe("auto");
  });

  it("emits streamed deltas so a UI can render as text arrives", async () => {
    const { agent } = build({
      chat: new ScriptedChat([
        [
          { type: "text_delta", text: "Hello " },
          { type: "text_delta", text: "world" },
          { type: "finish", reason: "stop" },
        ],
      ]),
    });

    const chunks: string[] = [];
    agent.on("assistant_delta", ({ text }) => chunks.push(text));
    await agent.ask("hi");

    expect(chunks).toEqual(["Hello ", "world"]);
  });
});

describe("AgentSession — tool loop", () => {
  it("executes a tool call and feeds the observation back", async () => {
    const chat = new ScriptedChat([
      toolCallTurn("procedure_pseudo_code", { procedure: "0x1400010a0" }, "call_1"),
      textTurn("That loop XORs with a rolling key."),
    ]);

    const { agent, connection } = build({
      chat,
      responder: () => ({
        structuredContent: {
          evidence_id: "ev_abc",
          operation: "procedure_pseudo_code",
          normalized_result: { pseudocode: "void f(void){ xor eax,eax; }" },
          limitations: [],
        },
      }),
    });

    const result = await agent.ask("Explain sub_1400010a0");

    expect(result.reason).toBe("final_answer");
    expect(result.toolCallsExecuted).toBe(1);
    expect(result.iterations).toBe(2);
    expect(connection.calls).toEqual([
      { name: "procedure_pseudo_code", args: { procedure: "0x1400010a0" } },
    ]);

    const transcript = agent.transcript();
    const assistant = transcript.find((m) => m.role === "assistant" && m.tool_calls !== undefined);
    const toolMessage = transcript.find((m) => m.role === "tool");
    expect(assistant?.tool_calls?.[0]?.id).toBe("call_1");
    expect(toolMessage?.tool_call_id).toBe("call_1");
    expect(toolMessage?.content).toContain("evidence_id=ev_abc");
    expect(toolMessage?.content).toContain("xor eax,eax");

    // The second request must include the observation.
    expect(chat.requests[1]?.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("runs multiple tool calls from one assistant turn", async () => {
    const chat = new ScriptedChat([
      [
        { type: "tool_call_delta", index: 0, id: "a", name: "xrefs", argumentsDelta: '{"address":"0x1000"}' },
        { type: "tool_call_delta", index: 1, id: "b", name: "list_strings", argumentsDelta: "{}" },
        { type: "finish", reason: "tool_calls" },
      ],
      textTurn("done"),
    ]);

    const { agent, connection } = build({ chat });
    const result = await agent.ask("look around");

    expect(result.toolCallsExecuted).toBe(2);
    expect(connection.calls.map((c) => c.name)).toEqual(["xrefs", "list_strings"]);
    expect(agent.transcript().filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("reports tool timing and evidence ids to the UI", async () => {
    const chat = new ScriptedChat([
      toolCallTurn("xrefs", { address: "0x1000" }),
      textTurn("done"),
    ]);
    const { agent } = build({
      chat,
      responder: () => ({ structuredContent: { evidence_id: "ev_xyz", operation: "xrefs" } }),
    });

    const finished: AgentEvents["tool_call_finished"][] = [];
    agent.on("tool_call_finished", (event) => finished.push(event));

    await agent.ask("refs?");

    expect(finished).toHaveLength(1);
    expect(finished[0]?.evidenceId).toBe("ev_xyz");
    expect(finished[0]?.ok).toBe(true);
    expect(finished[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("AgentSession — recoverable failures", () => {
  it("returns a failed call to the model instead of aborting the turn", async () => {
    const chat = new ScriptedChat([
      toolCallTurn("analyze_function", { procedure: "0xdeadbeef" }),
      textTurn("That address is not in the binary."),
    ]);

    const { agent } = build({
      chat,
      responder: () => ({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "invalid_request",
                message: "unknown procedure",
                retryable: false,
                remediation: { action: "Check the address against list_procedures." },
              },
            }),
          },
        ],
      }),
    });

    const result = await agent.ask("explain 0xdeadbeef");

    expect(result.reason).toBe("final_answer");
    const toolMessage = agent.transcript().find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("TOOL_ERROR");
    expect(toolMessage?.content).toContain("Check the address against list_procedures.");
  });

  it("rejects unparseable arguments without calling the tool", async () => {
    const chat = new ScriptedChat([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "c1",
          name: "xrefs",
          argumentsDelta: '{"address": 0x1000 trailing prose}',
        },
      ],
      textTurn("retried"),
    ]);

    const { agent, connection } = build({ chat });
    const result = await agent.ask("refs");

    expect(connection.calls).toHaveLength(0);
    expect(result.reason).toBe("final_answer");
    expect(agent.transcript().find((m) => m.role === "tool")?.content).toMatch(/not valid JSON/);
  });

  it("treats an empty argument string as an empty object", async () => {
    const chat = new ScriptedChat([
      [{ type: "tool_call_delta", index: 0, id: "c1", name: "list_strings" }],
      textTurn("done"),
    ]);
    const { agent, connection } = build({ chat });

    await agent.ask("strings?");

    expect(connection.calls[0]).toEqual({ name: "list_strings", args: {} });
  });

  it("explains an unknown tool and suggests alternatives", async () => {
    const chat = new ScriptedChat([
      toolCallTurn("decompile_function", { address: "0x1" }),
      textTurn("using the right tool"),
    ]);

    const { agent, connection } = build({ chat });
    await agent.ask("decompile");

    expect(connection.calls).toHaveLength(0);
    const content = agent.transcript().find((m) => m.role === "tool")?.content ?? "";
    expect(content).toContain("Unknown tool");
    expect(content).toMatch(/analyze_function|procedure_pseudo_code/);
  });

  it("surfaces a throwing transport as an observation", async () => {
    const chat = new ScriptedChat([
      toolCallTurn("xrefs", { address: "0x1" }),
      textTurn("handled"),
    ]);
    const { agent } = build({
      chat,
      responder: () => {
        throw new Error("transport exploded");
      },
    });

    const result = await agent.ask("refs");

    expect(result.reason).toBe("final_answer");
    expect(agent.transcript().find((m) => m.role === "tool")?.content).toContain("transport exploded");
  });
});

describe("AgentSession — limits and cancellation", () => {
  it("stops at maxIterations with an explanatory message", async () => {
    const chat = new ScriptedChat([
      toolCallTurn("xrefs", { address: "0x1" }, "a"),
      toolCallTurn("xrefs", { address: "0x2" }, "b"),
    ]);
    const { agent } = build({ chat, maxIterations: 2 });

    const result = await agent.ask("loop forever");

    expect(result.reason).toBe("max_iterations");
    expect(result.iterations).toBe(2);
    expect(result.content).toContain("step limit");
  });

  it("honours a pre-aborted signal", async () => {
    const { agent } = build({ chat: new ScriptedChat([]) });
    const controller = new AbortController();
    controller.abort();

    const result = await agent.ask("do work", { signal: controller.signal });
    expect(result.reason).toBe("cancelled");
  });

  it("refuses concurrent turns", async () => {
    const { agent } = build({ chat: new ScriptedChat([textTurn("one"), textTurn("two")]) });
    const first = agent.ask("one");
    await expect(agent.ask("two")).rejects.toThrow(/already running/);
    await first;
  });

  it("emits done exactly once per turn", async () => {
    const { agent } = build({ chat: new ScriptedChat([textTurn("ok")]) });
    const done = vi.fn();
    agent.on("done", done);
    await agent.ask("hi");
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0]?.[0]).toMatchObject({ reason: "final_answer" });
  });
});

describe("AgentSession — context management", () => {
  it("prunes the oldest units when the transcript exceeds the budget", async () => {
    const long = "z".repeat(20_000);
    const chat = new ScriptedChat([
      textTurn(long),
      textTurn(long),
      textTurn("final"),
    ]);
    const { agent } = build({ chat, contextWindow: 1_024, maxIterations: 4 });

    const pruned: AgentEvents["context_pruned"][] = [];
    agent.on("context_pruned", (event) => pruned.push(event));

    await agent.ask(`first ${long}`);
    await agent.ask(`second ${long}`);

    expect(pruned.length).toBeGreaterThan(0);
    expect(agent.transcript()[0]?.role).toBe("system");
  });

  it("keeps the system message when pruning", async () => {
    const { agent } = build({ chat: new ScriptedChat([textTurn("ok")]), contextWindow: 1_024 });
    await agent.ask("hello");
    expect(agent.transcript()[0]).toEqual({ role: "system", content: "system" });
  });
});

describe("groupIntoUnits", () => {
  it("keeps an assistant tool-call message with its tool results", () => {
    const units = groupIntoUnits([
      { role: "system", content: "s" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }],
      },
      { role: "tool", content: "r", tool_call_id: "1" },
      { role: "assistant", content: "a" },
    ]);
    // system alone, then one unit holding the whole user turn.
    expect(units).toHaveLength(2);
    expect(units[0]).toHaveLength(1);
    expect(units[1]).toHaveLength(4);
    expect(units[1]?.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});

describe("parseArguments", () => {
  it("accepts an object", () => {
    expect(parseArguments('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("treats empty and null as empty objects", () => {
    expect(parseArguments("")).toEqual({ ok: true, value: {} });
    expect(parseArguments("  ")).toEqual({ ok: true, value: {} });
    expect(parseArguments("null")).toEqual({ ok: true, value: {} });
  });

  it("rejects arrays and scalars", () => {
    expect(parseArguments("[1,2]")).toMatchObject({ ok: false });
    expect(parseArguments("42")).toMatchObject({ ok: false });
  });

  it("returns guidance on malformed JSON", () => {
    const result = parseArguments("{oops}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not valid JSON");
  });
});
