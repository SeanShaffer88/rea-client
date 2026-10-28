import { describe, expect, it } from "vitest";
import { collectTurn } from "../../src/llm/turn.js";
import {
  buildFunctionDefinitions,
  estimateSchemaTokens,
  toFunctionName,
} from "../../src/llm/toolSchema.js";
import type { StreamEvent } from "../../src/llm/types.js";
import { tool, toolCallTurn } from "../support/fakes.js";

async function* generate(events: readonly StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event;
}

describe("collectTurn", () => {
  it("concatenates fragmented tool-call arguments by index", async () => {
    const turn = await collectTurn(
      generate(toolCallTurn("procedure_pseudo_code", { procedure: "0x1400010a0" }, "call_9")),
    );
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.id).toBe("call_9");
    expect(turn.toolCalls[0]?.function.name).toBe("procedure_pseudo_code");
    expect(JSON.parse(turn.toolCalls[0]?.function.arguments ?? "{}")).toEqual({
      procedure: "0x1400010a0",
    });
  });

  it("keeps parallel tool calls separate", async () => {
    const events: StreamEvent[] = [
      { type: "tool_call_delta", index: 0, id: "a", name: "xrefs", argumentsDelta: '{"address":' },
      { type: "tool_call_delta", index: 1, id: "b", name: "list_strings", argumentsDelta: "{}" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '"0x1000"}' },
      { type: "finish", reason: "tool_calls" },
    ];
    const turn = await collectTurn(generate(events));
    expect(turn.toolCalls.map((c) => c.function.name)).toEqual(["xrefs", "list_strings"]);
    expect(turn.toolCalls[0]?.function.arguments).toBe('{"address":"0x1000"}');
    expect(turn.toolCalls[1]?.function.arguments).toBe("{}");
  });

  it("streams text deltas through the callback", async () => {
    const seen: string[] = [];
    const turn = await collectTurn(
      generate([
        { type: "text_delta", text: "The loop " },
        { type: "text_delta", text: "decrypts." },
        { type: "finish", reason: "stop" },
      ]),
      { onTextDelta: (text) => seen.push(text) },
    );
    expect(seen.join("")).toBe("The loop decrypts.");
    expect(turn.content).toBe("The loop decrypts.");
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.producedAnything).toBe(true);
  });

  it("captures usage and the finish reason", async () => {
    const turn = await collectTurn(
      generate([
        { type: "text_delta", text: "ok" },
        { type: "usage", usage: { promptTokens: 10, completionTokens: 2 } },
        { type: "finish", reason: "length" },
      ]),
    );
    expect(turn.finishReason).toBe("length");
    expect(turn.usage?.completionTokens).toBe(2);
  });

  it("synthesises an id when the server omits one", async () => {
    const turn = await collectTurn(
      generate([{ type: "tool_call_delta", index: 3, name: "xrefs", argumentsDelta: "{}" }]),
    );
    expect(turn.toolCalls[0]?.id).toBe("call_3");
  });

  it("ignores deltas with no function name", async () => {
    const turn = await collectTurn(
      generate([{ type: "tool_call_delta", index: 0, argumentsDelta: "{}" }]),
    );
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.producedAnything).toBe(false);
  });
});

describe("buildFunctionDefinitions", () => {
  it("strips schema keywords local servers reject", () => {
    const mapped = buildFunctionDefinitions([
      {
        name: "open_binary",
        description: "Open a target.",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "x",
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    const parameters = mapped.definitions[0]?.function.parameters;
    expect(parameters?.["$schema"]).toBeUndefined();
    expect(parameters?.["$id"]).toBeUndefined();
    expect(parameters?.["required"]).toEqual(["path"]);
  });

  it("forces an object schema when the server sends none", () => {
    const mapped = buildFunctionDefinitions([
      { name: "x", inputSchema: undefined as never },
    ]);
    expect(mapped.definitions[0]?.function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("trims long descriptions at a sentence boundary", () => {
    const description = `${"Sentence one. ".repeat(100)}Trailing detail.`;
    const mapped = buildFunctionDefinitions([tool("x", description)], { descriptionLimit: 200 });
    const kept = mapped.definitions[0]?.function.description ?? "";
    expect(kept.length).toBeLessThanOrEqual(201);
    expect(kept.endsWith("…") || kept.endsWith(".")).toBe(true);
  });

  it("keeps a reverse map from advertised name to MCP name", () => {
    const mapped = buildFunctionDefinitions([tool("procedure_pseudo_code")]);
    expect(mapped.mcpNameFor.get("procedure_pseudo_code")).toBe("procedure_pseudo_code");
  });

  it("sanitizes names that violate the function-name grammar", () => {
    expect(toFunctionName("inspect.pe/imports")).toBe("inspect_pe_imports");
    expect(toFunctionName("ok_name-1")).toBe("ok_name-1");
    expect(toFunctionName("")).toBe("tool");
  });

  it("records renames so dispatch can map back", () => {
    const mapped = buildFunctionDefinitions([tool("inspect.pe:imports")]);
    expect(mapped.renamed).toEqual([
      { mcpName: "inspect.pe:imports", functionName: "inspect_pe_imports" },
    ]);
    expect(mapped.mcpNameFor.get("inspect_pe_imports")).toBe("inspect.pe:imports");
  });

  it("drops duplicate advertised names", () => {
    const mapped = buildFunctionDefinitions([tool("x"), tool("x")]);
    expect(mapped.definitions).toHaveLength(1);
  });

  it("estimates a pessimistic token cost", () => {
    const mapped = buildFunctionDefinitions(Array.from({ length: 20 }, (_, i) => tool(`tool_${i}`)));
    expect(estimateSchemaTokens(mapped)).toBeGreaterThan(0);
  });
});
