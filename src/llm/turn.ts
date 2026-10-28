/**
 * Assembles a streamed reply into an `AssistantTurn`.
 *
 * Tool calls arrive as fragments rather than whole objects: the name and id
 * usually appear once, and `arguments` is delivered as a sequence of string
 * chunks that must be concatenated by index before parsing. Getting this wrong
 * is the most common cause of "the model called a tool but the client sent
 * empty arguments", so it is implemented once, here, and unit-tested.
 */

import type { AssistantToolCall, AssistantTurn, StreamEvent, TokenUsage } from "./types.js";

export interface CollectOptions {
  /** Called for every text delta, so the UI can stream before the turn ends. */
  readonly onTextDelta?: (text: string) => void;
  /** Called for every tool-call fragment, for progress display. */
  readonly onToolCallDelta?: (index: number, name?: string) => void;
}

interface PartialToolCall {
  id: string;
  name: string;
  argumentChunks: string[];
}

export async function collectTurn(
  events: AsyncGenerator<StreamEvent, void, undefined>,
  options: CollectOptions = {},
): Promise<AssistantTurn> {
  const partials = new Map<number, PartialToolCall>();
  const text: string[] = [];
  let finishReason: string | null = null;
  let usage: TokenUsage | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "text_delta": {
        text.push(event.text);
        options.onTextDelta?.(event.text);
        break;
      }
      case "tool_call_delta": {
        let partial = partials.get(event.index);
        if (partial === undefined) {
          partial = { id: "", name: "", argumentChunks: [] };
          partials.set(event.index, partial);
        }
        if (event.id !== undefined && event.id !== "") partial.id = event.id;
        if (event.name !== undefined && event.name !== "") partial.name = event.name;
        if (event.argumentsDelta !== undefined) {
          partial.argumentChunks.push(event.argumentsDelta);
        }
        options.onToolCallDelta?.(event.index, event.name);
        break;
      }
      case "usage": {
        usage = event.usage;
        break;
      }
      case "finish": {
        finishReason = event.reason;
        break;
      }
    }
  }

  const toolCalls: AssistantToolCall[] = [];
  for (const [index, partial] of [...partials.entries()].sort((a, b) => a[0] - b[0])) {
    if (partial.name === "") continue;
    toolCalls.push({
      id: partial.id === "" ? `call_${index}` : partial.id,
      type: "function",
      function: {
        name: partial.name,
        arguments: partial.argumentChunks.join(""),
      },
    });
  }

  const content = text.join("");
  return {
    content,
    toolCalls,
    finishReason,
    usage,
    producedAnything: content.trim() !== "" || toolCalls.length > 0,
  };
}
