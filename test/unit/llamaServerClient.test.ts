/**
 * Tests for the OpenAI-compatible streaming client, over a real TCP socket.
 *
 * Everything here goes through `LlamaServerClient` -> `fetch` -> Node's HTTP
 * stack -> a real server, so these cover the code that actually talks to
 * `llama-server.exe` rather than a mock standing in for it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { LlamaServerClient, LlmRequestError } from "../../src/llm/LlamaServerClient.js";
import { collectTurn } from "../../src/llm/turn.js";
import { NetworkPolicyError } from "../../src/platform/net.js";
import type { StreamEvent } from "../../src/llm/types.js";
import {
  FakeModelServer,
  SSE_DONE,
  sseFrame,
  sseFrameCrlf,
  textChunk,
  toolChunk,
  type FakeResponse,
} from "../support/fakeModelServer.js";

const servers: FakeModelServer[] = [];

async function serve(responder: (request: unknown) => FakeResponse): Promise<FakeModelServer> {
  const server = new FakeModelServer(responder as never);
  await server.start();
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop()));
});

async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const baseRequest = {
  model: "test-model",
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("LlamaServerClient — request construction", () => {
  it("posts to /v1/chat/completions with stream enabled", async () => {
    const server = await serve(() => ({ chunks: [sseFrame(textChunk("hi")), SSE_DONE] }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    await drain(client.streamChat(baseRequest));

    const recorded = server.recorded[0];
    expect(recorded?.method).toBe("POST");
    expect(recorded?.url).toBe("/v1/chat/completions");
    expect(recorded?.headers["content-type"]).toBe("application/json");
    expect(recorded?.headers["accept"]).toBe("text/event-stream");
    expect(recorded?.body).toMatchObject({ model: "test-model", stream: true });
  });

  it("omits tools and tool_choice when no tools are supplied", async () => {
    const server = await serve(() => ({ chunks: [SSE_DONE] }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    await drain(client.streamChat(baseRequest));

    const body = server.recorded[0]?.body as Record<string, unknown>;
    expect(body["tools"]).toBeUndefined();
    expect(body["tool_choice"]).toBeUndefined();
  });

  it("sends tools with tool_choice auto when supplied", async () => {
    const server = await serve(() => ({ chunks: [SSE_DONE] }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    await drain(
      client.streamChat({
        ...baseRequest,
        tools: [
          {
            type: "function",
            function: { name: "xrefs", description: "refs", parameters: { type: "object" } },
          },
        ],
      }),
    );

    const body = server.recorded[0]?.body as Record<string, unknown>;
    expect(body["tool_choice"]).toBe("auto");
    expect(Array.isArray(body["tools"])).toBe(true);
  });

  it("sends an Authorization header only when an api key is configured", async () => {
    const withKey = await serve(() => ({ chunks: [SSE_DONE] }));
    await drain(new LlamaServerClient({ baseUrl: withKey.url, apiKey: "sk-local" }).streamChat(baseRequest));
    expect(withKey.recorded[0]?.headers["authorization"]).toBe("Bearer sk-local");

    const withoutKey = await serve(() => ({ chunks: [SSE_DONE] }));
    await drain(new LlamaServerClient({ baseUrl: withoutKey.url }).streamChat(baseRequest));
    expect(withoutKey.recorded[0]?.headers["authorization"]).toBeUndefined();
  });

  it("normalizes a trailing slash in baseUrl", async () => {
    const server = await serve(() => ({ chunks: [SSE_DONE] }));
    const client = new LlamaServerClient({ baseUrl: `${server.url}/` });

    await drain(client.streamChat(baseRequest));

    expect(server.recorded[0]?.url).toBe("/v1/chat/completions");
    expect(client.url).not.toContain("//chat");
  });

  it("refuses a non-loopback endpoint at construction time", () => {
    expect(() => new LlamaServerClient({ baseUrl: "http://10.0.0.5:8080/v1" })).toThrow(
      NetworkPolicyError,
    );
  });
});

describe("LlamaServerClient — SSE parsing", () => {
  it("streams text deltas in order", async () => {
    const server = await serve(() => ({
      chunks: [
        sseFrame(textChunk("The loop ")),
        sseFrame(textChunk("XORs ")),
        sseFrame(textChunk("the buffer.")),
        SSE_DONE,
      ],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    const events = await drain(client.streamChat(baseRequest));
    const text = events
      .filter((event): event is Extract<StreamEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.text)
      .join("");

    expect(text).toBe("The loop XORs the buffer.");
  });

  it("parses frames split across TCP segments", async () => {
    // One logical frame delivered as three separate writes.
    const server = await serve(() => ({
      chunks: ['data: {"choices":[{"index":0,', '"delta":{"content":"split"}}]}', "\n\n", SSE_DONE],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    const events = await drain(client.streamChat(baseRequest));
    const text = events
      .filter((event): event is Extract<StreamEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.text)
      .join("");

    expect(text).toBe("split");
  });

  it("accepts CRLF frame separators", async () => {
    const server = await serve(() => ({
      chunks: [sseFrameCrlf(textChunk("crlf")), SSE_DONE],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    const events = await drain(client.streamChat(baseRequest));
    const text = events
      .filter((event): event is Extract<StreamEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.text)
      .join("");

    expect(text).toBe("crlf");
  });

  it("does not corrupt a multi-byte character split across segments", async () => {
    const expected = "→ 暗号化ループ";
    const payload = Buffer.from(sseFrame(textChunk(expected)), "utf8");

    // Cut one byte into the first 3-byte character, so the decoder receives the
    // leading byte in one segment and the continuation bytes in the next.
    const charStart = payload.indexOf(Buffer.from("暗", "utf8"));
    const cut = charStart + 1;
    expect(cut).toBeGreaterThan(charStart);

    const server = await serve(() => ({
      chunks: [payload.subarray(0, cut), payload.subarray(cut), SSE_DONE],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    const text = (await drain(client.streamChat(baseRequest)))
      .filter((event): event is Extract<StreamEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.text)
      .join("");

    // Without TextDecoder({ stream: true }) this arrives as U+FFFD replacement
    // characters instead of the original text.
    expect(text).toBe(expected);
    expect(text).not.toContain("\uFFFD");
  });

  it("ignores [DONE], comments and malformed frames", async () => {
    const server = await serve(() => ({
      chunks: [
        ": keep-alive comment\n\n",
        sseFrame(textChunk("ok")),
        "data: {not json}\n\n",
        SSE_DONE,
      ],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    const events = await drain(client.streamChat(baseRequest));
    const text = events
      .filter((event): event is Extract<StreamEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.text)
      .join("");

    expect(text).toBe("ok");
  });

  it("forwards finish_reason and usage", async () => {
    const server = await serve(() => ({
      chunks: [
        sseFrame({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "length" }] }),
        sseFrame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }),
        SSE_DONE,
      ],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    const events = await drain(client.streamChat(baseRequest));

    expect(events.find((event) => event.type === "finish")).toEqual({
      type: "finish",
      reason: "length",
    });
    expect(events.find((event) => event.type === "usage")).toEqual({
      type: "usage",
      usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
    });
  });

  it("reassembles a fragmented tool call into a complete turn", async () => {
    const server = await serve(() => ({
      chunks: [
        sseFrame(toolChunk(0, { id: "call_a", name: "procedure_pseudo_code" })),
        sseFrame(toolChunk(0, { arguments: '{"procedure"' })),
        sseFrame(toolChunk(0, { arguments: ':"0x1400010a0"}' })),
        sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        SSE_DONE,
      ],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    const turn = await collectTurn(client.streamChat(baseRequest));

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.id).toBe("call_a");
    expect(turn.toolCalls[0]?.function.name).toBe("procedure_pseudo_code");
    expect(JSON.parse(turn.toolCalls[0]?.function.arguments ?? "{}")).toEqual({
      procedure: "0x1400010a0",
    });
    expect(turn.finishReason).toBe("tool_calls");
  });

  it("handles a server that ignores stream:true and returns whole JSON", async () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "non-streamed" },
          delta: { content: "non-streamed" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const server = await serve(() => ({
      headers: { "content-type": "application/json" },
      chunks: [body],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    const turn = await collectTurn(client.streamChat(baseRequest));

    expect(turn.content).toBe("non-streamed");
    expect(turn.finishReason).toBe("stop");
    expect(turn.usage?.promptTokens).toBe(5);
  });
});

describe("LlamaServerClient — failures", () => {
  it("reports the status and body on an HTTP error", async () => {
    const server = await serve(() => ({
      status: 400,
      headers: { "content-type": "application/json" },
      chunks: [JSON.stringify({ error: { message: "context length exceeded" } })],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    await expect(drain(client.streamChat(baseRequest))).rejects.toThrow(LlmRequestError);

    try {
      await drain(client.streamChat(baseRequest));
    } catch (error) {
      const requestError = error as LlmRequestError;
      expect(requestError.status).toBe(400);
      expect(requestError.body).toContain("context length exceeded");
      expect(requestError.message).toContain("HTTP 400");
    }
  });

  it("surfaces an in-band error frame", async () => {
    const server = await serve(() => ({
      chunks: [sseFrame({ error: { message: "model failed to load" } }), SSE_DONE],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });

    await expect(drain(client.streamChat(baseRequest))).rejects.toThrow(/model failed to load/);
  });

  it("raises a clear error when the server is unreachable", async () => {
    const server = await serve(() => ({ chunks: [SSE_DONE] }));
    const deadUrl = server.url;
    await server.stop();

    const client = new LlamaServerClient({ baseUrl: deadUrl });

    await expect(drain(client.streamChat(baseRequest))).rejects.toThrow(/Could not reach/);
  });

  it("applies the request timeout", async () => {
    const server = await serve(() => ({
      delayBeforeFirstChunkMs: 400,
      chunks: [sseFrame(textChunk("late")), SSE_DONE],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url, requestTimeoutMs: 120 });

    await expect(drain(client.streamChat(baseRequest))).rejects.toThrow();
  });

  it("honours an abort signal", async () => {
    const server = await serve(() => ({
      delayBeforeFirstChunkMs: 400,
      chunks: [sseFrame(textChunk("late")), SSE_DONE],
    }));
    const client = new LlamaServerClient({ baseUrl: server.url });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);

    await expect(
      drain(client.streamChat(baseRequest, { signal: controller.signal })),
    ).rejects.toThrow();
  });
});
