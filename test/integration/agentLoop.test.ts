/**
 * End-to-end agent loop.
 *
 * Wires the real pieces together: `AgentSession` -> real `LlamaServerClient`
 * over a real HTTP socket -> scripted MCP connection. Nothing at the transport
 * layer is mocked, so this covers the contract between the SSE parser, the turn
 * assembler, the tool dispatcher, and the evidence projection in one pass.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/agent/AgentSession.js";
import type { AgentEvents } from "../../src/agent/events.js";
import { ToolCatalog } from "../../src/mcp/catalog.js";
import { LlamaServerClient } from "../../src/llm/LlamaServerClient.js";
import type { McpCallToolResult } from "../../src/mcp/types.js";
import { FakeConnection, tool } from "../support/fakes.js";
import {
  FakeModelServer,
  SSE_DONE,
  sseFrame,
  textChunk,
  toolChunk,
  type FakeResponse,
} from "../support/fakeModelServer.js";

const TOOLS = ["open_binary", "analyze_function", "procedure_pseudo_code", "xrefs"].map((name) =>
  tool(name),
);

const servers: FakeModelServer[] = [];

async function serve(responder: () => FakeResponse): Promise<FakeModelServer> {
  const server = new FakeModelServer(responder);
  await server.start();
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop()));
});

function build(modelServer: FakeModelServer, responder?: () => McpCallToolResult) {
  const catalog = ToolCatalog.from(TOOLS);
  const scope = catalog.resolveScope("custom", TOOLS.map((t) => t.name));
  const connection = new FakeConnection(TOOLS, responder);
  const agent = new AgentSession({
    connection,
    chat: new LlamaServerClient({ baseUrl: modelServer.url }),
    catalog,
    scope,
    model: "test-model",
    maxIterations: 4,
    maxToolResultChars: 4_000,
    temperature: 0.1,
    maxTokens: 256,
    contextWindow: 16_384,
    systemPrompt: "system",
  });
  return { agent, connection, catalog };
}

/**
 * A responder that plays the model: first call returns a tool call, second
 * returns prose. Stateful because `AgentSession` issues multiple HTTP requests.
 */
function scriptedModel(turns: readonly Record<string, unknown>[][]): () => FakeResponse {
  let index = 0;
  return () => {
    const turn = turns[index] ?? turns[turns.length - 1] ?? [];
    index += 1;
    return { chunks: [...turn.map((chunk) => sseFrame(chunk)), SSE_DONE] };
  };
}

describe("agent loop over a real HTTP model connection", () => {
  it("streams text for a turn that needs no tools", async () => {
    const modelServer = await serve(scriptedModel([[textChunk("Nothing to analyse.")]]));
    const { agent, connection } = build(modelServer);

    const deltas: string[] = [];
    agent.on("assistant_delta", ({ text }) => deltas.push(text));

    const result = await agent.ask("hello");

    expect(result.reason).toBe("final_answer");
    expect(deltas.join("")).toBe("Nothing to analyse.");
    expect(connection.calls).toHaveLength(0);
  });

  it("executes a tool call and returns a synthesised answer", async () => {
    const modelServer = await serve(
      scriptedModel([
        [toolChunk(0, { id: "c1", name: "procedure_pseudo_code", arguments: '{"procedure":"0x401000"}' })],
        [textChunk("It XORs with a rolling key.")],
      ]),
    );

    const { agent, connection } = build(modelServer, () => ({
      structuredContent: {
        evidence_id: "ev_e2e",
        operation: "procedure_pseudo_code",
        normalized_result: { pseudocode: "for(;;) buf[i] ^= key++;" },
        limitations: ["Loop bound inferred statically."],
      },
    }));

    const started: AgentEvents["tool_call_started"][] = [];
    const finished: AgentEvents["tool_call_finished"][] = [];
    agent.on("tool_call_started", (event) => started.push(event));
    agent.on("tool_call_finished", (event) => finished.push(event));

    const result = await agent.ask("Explain sub_401000");

    expect(result.reason).toBe("final_answer");
    expect(result.content).toBe("It XORs with a rolling key.");
    expect(result.iterations).toBe(2);
    expect(result.toolCallsExecuted).toBe(1);

    expect(started[0]).toMatchObject({
      name: "procedure_pseudo_code",
      mcpName: "procedure_pseudo_code",
      arguments: { procedure: "0x401000" },
    });
    expect(finished[0]).toMatchObject({ ok: true, evidenceId: "ev_e2e" });

    expect(connection.calls).toEqual([
      { name: "procedure_pseudo_code", args: { procedure: "0x401000" } },
    ]);

    // The observation must carry the evidence id and the limitation.
    const toolMessage = agent.transcript().find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("evidence_id=ev_e2e");
    expect(toolMessage?.content).toContain("Loop bound inferred statically.");
    expect(toolMessage?.tool_call_id).toBe("c1");
  });

  it("feeds a typed REA error back so the model can correct itself", async () => {
    const modelServer = await serve(
      scriptedModel([
        [toolChunk(0, { id: "c1", name: "analyze_function", arguments: '{"procedure":"0xdead"}' })],
        [textChunk("That address is not present in this binary.")],
      ]),
    );

    const { agent } = build(modelServer, () => ({
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
    }));

    const result = await agent.ask("explain 0xdead");

    expect(result.reason).toBe("final_answer");
    const toolMessage = agent.transcript().find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("TOOL_ERROR");
    expect(toolMessage?.content).toContain("Check the address against list_procedures.");
  });

  it("declares tools to the model on every request", async () => {
    const modelServer = await serve(scriptedModel([[textChunk("ok")]]));
    const { agent } = build(modelServer);

    await agent.ask("hi");

    const body = modelServer.recorded[0]?.body as {
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: string;
    };
    expect(body.tool_choice).toBe("auto");
    expect(body.tools?.map((entry) => entry.function.name)).toEqual(
      expect.arrayContaining(["open_binary", "analyze_function"]),
    );
  });

  it("includes prior observations in the follow-up request", async () => {
    const modelServer = await serve(
      scriptedModel([
        [toolChunk(0, { id: "c1", name: "xrefs", arguments: '{"address":"0x5000"}' })],
        [textChunk("Two callers.")],
      ]),
    );
    const { agent } = build(modelServer, () => ({
      structuredContent: { evidence_id: "ev_x", operation: "xrefs", normalized_result: { count: 2 } },
    }));

    await agent.ask("who references 0x5000");

    const second = modelServer.recorded[1]?.body as {
      messages?: Array<{ role: string; content: string | null; tool_calls?: unknown[] }>;
    };
    const roles = second.messages?.map((message) => message.role) ?? [];

    // At the moment of the follow-up request the transcript is
    // system, user, assistant(tool_calls), tool -- the final answer has not
    // been produced yet.
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);

    // The protocol requires the tool result to follow its calling assistant
    // message, so the two can never be separated by transcript pruning.
    const assistantIndex = roles.lastIndexOf("assistant");
    expect(second.messages?.[assistantIndex]?.tool_calls).toHaveLength(1);
    expect(roles[assistantIndex + 1]).toBe("tool");
  });
});
