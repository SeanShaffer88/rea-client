/** Chat and tool-call shapes shared by the client and the agent loop. */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface AssistantToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string | null;
  readonly tool_calls?: readonly AssistantToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
}

/** OpenAI-compatible function definition. */
export interface FunctionDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface TokenUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface StreamingChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly FunctionDefinition[];
  readonly toolChoice?: "auto" | "none" | "required";
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
}

export type StreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "finish"; readonly reason: string | null };

export interface ChatTransport {
  streamChat(
    request: StreamingChatRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, undefined>;
}

/** Fully assembled model reply for one turn. */
export interface AssistantTurn {
  readonly content: string;
  readonly toolCalls: readonly AssistantToolCall[];
  readonly finishReason: string | null;
  readonly usage: TokenUsage | undefined;
  /** True when the model emitted text or tool calls. */
  readonly producedAnything: boolean;
}
