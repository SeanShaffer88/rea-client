/**
 * Test doubles for the two boundaries the agent loop sits between: the MCP
 * connection and the chat transport. Both are scripted, so a test asserts on
 * exact request/response sequences rather than on timing.
 */

import type { McpConnection } from "../../src/mcp/ReaClient.js";
import type { McpCallToolResult, McpServerVersion, McpToolDefinition } from "../../src/mcp/types.js";
import type {
  ChatTransport,
  StreamEvent,
  StreamingChatRequest,
} from "../../src/llm/types.js";

export interface RecordedCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export class FakeConnection implements McpConnection {
  public readonly calls: RecordedCall[] = [];
  public closed = false;
  private readonly tools: readonly McpToolDefinition[];
  private readonly responder: (name: string, args: Record<string, unknown>) => McpCallToolResult;

  public constructor(
    tools: readonly McpToolDefinition[],
    responder: (name: string, args: Record<string, unknown>) => McpCallToolResult = () => ({
      content: [{ type: "text", text: "ok" }],
    }),
  ) {
    this.tools = tools;
    this.responder = responder;
  }

  public async listTools(): Promise<readonly McpToolDefinition[]> {
    return this.tools;
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    this.calls.push({ name, args });
    return this.responder(name, args);
  }

  public serverVersion(): McpServerVersion | undefined {
    return { name: "rea", version: "6.8.0" };
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

/** A chat transport that replays one scripted event list per call. */
export class ScriptedChat implements ChatTransport {
  public readonly requests: StreamingChatRequest[] = [];
  private readonly turns: StreamEvent[][];

  public constructor(turns: readonly (readonly StreamEvent[])[]) {
    this.turns = turns.map((turn) => [...turn]);
  }

  public async *streamChat(
    request: StreamingChatRequest,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    this.requests.push(request);
    const turn = this.turns.shift() ?? [];
    for (const event of turn) yield event;
  }
}

/** Builds a tool definition with a permissive schema. */
export function tool(name: string, description = `${name} tool`): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { procedure: { type: "string" } },
      additionalProperties: false,
    },
  };
}

/** Convenience: a text-only assistant turn. */
export function textTurn(text: string): StreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "finish", reason: "stop" },
  ];
}

/** Convenience: an assistant turn that calls one tool. */
export function toolCallTurn(
  name: string,
  args: Record<string, unknown>,
  id = "call_1",
): StreamEvent[] {
  // Fragmented on purpose: models emit the name once and arguments in pieces.
  const json = JSON.stringify(args);
  const midpoint = Math.floor(json.length / 2);
  return [
    {
      type: "tool_call_delta",
      index: 0,
      id,
      name,
      argumentsDelta: json.slice(0, midpoint),
    },
    {
      type: "tool_call_delta",
      index: 0,
      argumentsDelta: json.slice(midpoint),
    },
    { type: "finish", reason: "tool_calls" },
  ];
}
