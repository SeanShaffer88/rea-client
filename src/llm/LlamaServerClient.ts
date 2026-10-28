/**
 * Streaming client for an OpenAI-compatible `/chat/completions` endpoint.
 *
 * Target deployment is `llama-server.exe` from llama.cpp, but nothing here is
 * llama.cpp-specific: it speaks the same wire format vLLM, Ollama's OpenAI
 * shim, and LM Studio expose, which keeps the desktop build testable against a
 * trivial fake server.
 *
 * Implemented directly on `fetch` + SSE instead of an SDK so the air-gapped
 * bundle ships one dependency and no hidden network defaults.
 */

import { assertLoopbackUrl } from "../platform/net.js";
import type {
  ChatTransport,
  StreamEvent,
  StreamingChatRequest,
  TokenUsage,
} from "./types.js";

export class LlmRequestError extends Error {
  public override readonly name = "LlmRequestError";
  public readonly status: number | undefined;
  public readonly body: string | undefined;

  public constructor(message: string, status?: number, body?: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface LlamaServerOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly requestTimeoutMs?: number;
  readonly allowNonLoopback?: boolean;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface RawStreamChunk {
  choices?: Array<{
    index?: number;
    delta?: { content?: string | null; tool_calls?: RawToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string };
}

export class LlamaServerClient implements ChatTransport {
  private readonly endpoint: string;
  private readonly options: LlamaServerOptions;

  public constructor(options: LlamaServerOptions) {
    this.options = options;
    // Validated on construction so a misconfigured endpoint fails at startup,
    // not on the user's first question.
    const parsed = assertLoopbackUrl(options.baseUrl, {
      ...(options.allowNonLoopback === undefined
        ? {}
        : { allowNonLoopback: options.allowNonLoopback }),
      settingName: "llm.baseUrl",
    });
    const base = parsed.href.replace(/\/+$/, "");
    this.endpoint = `${base}/chat/completions`;
  }

  public get url(): string {
    return this.endpoint;
  }

  public async *streamChat(
    request: StreamingChatRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: true,
    };
    if (request.tools !== undefined && request.tools.length > 0) {
      body["tools"] = request.tools;
      body["tool_choice"] = request.toolChoice ?? "auto";
    }
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;
    if (request.stop !== undefined && request.stop.length > 0) body["stop"] = request.stop;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (this.options.apiKey !== undefined && this.options.apiKey !== "") {
      headers["authorization"] = `Bearer ${this.options.apiKey}`;
    }

    const signals: AbortSignal[] = [];
    if (options.signal !== undefined) signals.push(options.signal);
    const timeoutMs = this.options.requestTimeoutMs;
    if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));

    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
      });
    } catch (error) {
      throw new LlmRequestError(
        `Could not reach the local model server at ${this.endpoint}: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      const text = await safeText(response);
      throw new LlmRequestError(
        `Model server returned HTTP ${response.status} for ${this.endpoint}.`,
        response.status,
        text,
      );
    }

    if (response.body === null) {
      throw new LlmRequestError("Model server returned an empty response body.");
    }

    yield* this.parseEventStream(response.body, response.headers.get("content-type"));
  }

  private async *parseEventStream(
    stream: ReadableStream<Uint8Array>,
    contentType: string | null,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    // Some servers ignore `stream: true` and answer with a single JSON object.
    if (contentType !== null && contentType.includes("application/json")) {
      const text = await new Response(stream).text();
      yield* this.parseWholeJson(text);
      return;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line; "\r\n\r\n" is also valid.
        let boundary = findEventBoundary(buffer);
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          for (const event of this.parseEvent(rawEvent)) yield event;
          boundary = findEventBoundary(buffer);
        }
      }

      const remainder = buffer.trim();
      if (remainder !== "") {
        for (const event of this.parseEvent(remainder)) yield event;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private *parseEvent(rawEvent: string): Generator<StreamEvent, void, undefined> {
    for (const line of rawEvent.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;

      let chunk: RawStreamChunk;
      try {
        chunk = JSON.parse(payload) as RawStreamChunk;
      } catch {
        // A malformed frame should not kill an otherwise good stream.
        continue;
      }

      if (chunk.error !== undefined) {
        throw new LlmRequestError(
          `Model server error: ${chunk.error.message ?? "unknown error"}`,
        );
      }

      const choice = chunk.choices?.[0];
      if (choice !== undefined) {
        const content = choice.delta?.content;
        if (typeof content === "string" && content !== "") {
          yield { type: "text_delta", text: content };
        }

        const toolCalls = choice.delta?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const [position, call] of toolCalls.entries()) {
            yield {
              type: "tool_call_delta",
              index: call.index ?? position,
              ...(call.id === undefined ? {} : { id: call.id }),
              ...(call.function?.name === undefined ? {} : { name: call.function.name }),
              ...(call.function?.arguments === undefined
                ? {}
                : { argumentsDelta: call.function.arguments }),
            };
          }
        }

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          yield { type: "finish", reason: choice.finish_reason };
        }
      }

      if (chunk.usage !== undefined) {
        const usage: TokenUsage = {
          ...(chunk.usage.prompt_tokens === undefined ? {} : { promptTokens: chunk.usage.prompt_tokens }),
          ...(chunk.usage.completion_tokens === undefined
            ? {}
            : { completionTokens: chunk.usage.completion_tokens }),
          ...(chunk.usage.total_tokens === undefined ? {} : { totalTokens: chunk.usage.total_tokens }),
        };
        yield { type: "usage", usage };
      }
    }
  }

  private *parseWholeJson(text: string): Generator<StreamEvent, void, undefined> {
    let parsed: RawStreamChunk;
    try {
      parsed = JSON.parse(text) as RawStreamChunk;
    } catch {
      throw new LlmRequestError("Model server returned unparseable JSON.");
    }
    if (parsed.error !== undefined) {
      throw new LlmRequestError(`Model server error: ${parsed.error.message ?? "unknown error"}`);
    }
    const choice = parsed.choices?.[0];
    const content = choice?.delta?.content ?? undefined;
    if (typeof content === "string" && content !== "") {
      yield { type: "text_delta", text: content };
    }
    for (const [index, call] of (choice?.delta?.tool_calls ?? []).entries()) {
      yield {
        type: "tool_call_delta",
        index: call.index ?? index,
        ...(call.id === undefined ? {} : { id: call.id }),
        ...(call.function?.name === undefined ? {} : { name: call.function.name }),
        ...(call.function?.arguments === undefined ? {} : { argumentsDelta: call.function.arguments }),
      };
    }
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      yield { type: "finish", reason: choice.finish_reason };
    }
    if (parsed.usage !== undefined) {
      yield {
        type: "usage",
        usage: {
          ...(parsed.usage.prompt_tokens === undefined ? {} : { promptTokens: parsed.usage.prompt_tokens }),
          ...(parsed.usage.completion_tokens === undefined
            ? {}
            : { completionTokens: parsed.usage.completion_tokens }),
          ...(parsed.usage.total_tokens === undefined ? {} : { totalTokens: parsed.usage.total_tokens }),
        },
      };
    }
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 2_000);
  } catch {
    return "";
  }
}
