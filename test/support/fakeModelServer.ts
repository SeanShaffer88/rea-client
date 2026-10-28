/**
 * A real HTTP server that speaks the OpenAI `/chat/completions` streaming
 * protocol, for testing `LlamaServerClient` over an actual socket.
 *
 * Why a real server instead of a stubbed `fetch`:
 *
 * The interesting failures in SSE parsing are all transport-shaped — a frame
 * split across two TCP segments, `\r\n\r\n` instead of `\n\n`, a chunk landing
 * mid-UTF-8-character, a server that ignores `stream: true`. A `fetch` stub that
 * returns a pre-built `ReadableStream` reproduces none of them, because the test
 * author decides where the boundaries fall rather than the network.
 *
 * Chunks here are written separately with a flush delay, so each one really does
 * arrive as its own segment.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
  readonly rawBody: string;
}

export interface FakeResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /**
   * Written in order; each entry is one TCP write. Buffers are sent verbatim, so
   * a test can split a multi-byte UTF-8 character across two segments.
   */
  readonly chunks: readonly (string | Buffer)[];
  /** Delay between chunk writes, to force separate segments. */
  readonly delayBetweenChunksMs?: number;
  /** Delay before writing anything, for timeout tests. */
  readonly delayBeforeFirstChunkMs?: number;
}

export type FakeResponder = (request: RecordedRequest) => FakeResponse;

export class FakeModelServer {
  private server: Server | undefined;
  private readonly responder: FakeResponder;
  private readonly requests: RecordedRequest[] = [];
  private baseUrl = "";

  public constructor(responder: FakeResponder) {
    this.responder = responder;
  }

  /** Base URL including the `/v1` prefix, matching a real llama-server config. */
  public get url(): string {
    if (this.baseUrl === "") {
      throw new Error("FakeModelServer.start() must be awaited before reading url");
    }
    return this.baseUrl;
  }

  public get recorded(): readonly RecordedRequest[] {
    return [...this.requests];
  }

  public async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");

    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("FakeModelServer failed to bind a TCP port");
    }
    this.baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
  }

  public async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = rawBody === "" ? undefined : JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }

    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      url: req.url ?? "",
      headers: req.headers,
      body: parsedBody,
      rawBody,
    };
    this.requests.push(recorded);

    let response: FakeResponse;
    try {
      response = this.responder(recorded);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
      return;
    }

    if ((response.delayBeforeFirstChunkMs ?? 0) > 0) {
      await delay(response.delayBeforeFirstChunkMs ?? 0);
    }

    res.writeHead(response.status ?? 200, {
      "content-type": response.headers?.["content-type"] ?? "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...response.headers,
    });

    const gap = response.delayBetweenChunksMs ?? 1;
    for (const chunk of response.chunks) {
      if (!res.writableEnded) res.write(chunk);
      if (gap > 0) await delay(gap);
    }
    if (!res.writableEnded) res.end();
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of req) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One SSE frame. `payload` objects are JSON-encoded; strings are sent verbatim. */
export function sseFrame(payload: unknown): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}\n\n`;
}

/** A frame using CRLF line endings, which some servers emit. */
export function sseFrameCrlf(payload: unknown): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}\r\n\r\n`;
}

/** Terminal frame. */
export const SSE_DONE = "data: [DONE]\n\n";

/** A text delta chunk. */
export function textChunk(text: string): Record<string, unknown> {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

/** A tool-call delta chunk. */
export function toolChunk(
  index: number,
  fields: { id?: string; name?: string; arguments?: string },
): Record<string, unknown> {
  const fn: Record<string, string> = {};
  if (fields.name !== undefined) fn["name"] = fields.name;
  if (fields.arguments !== undefined) fn["arguments"] = fields.arguments;

  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(fields.id === undefined ? {} : { id: fields.id }),
              ...(Object.keys(fn).length === 0 ? {} : { function: fn }),
            },
          ],
        },
      },
    ],
  };
}
