import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, realpath, unlink } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { ReaClientConfig } from "../config.js";
import type { EngineBridge } from "./EngineBridge.js";
import type { Bootstrap, DesktopEvent } from "./protocol.js";

const RPC_METHODS = new Set(["engine.ping", "engine.doctor", "tools.list", "tools.describe", "target.session", "target.open", "target.close", "target.probe", "evidence.list", "evidence.get", "evidence.export", "case.save", "case.list", "case.open", "agent.ask", "agent.cancel", "agent.reset", "agent.transcript"]);
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };
const MAX_BODY = 1024 * 1024;
/** RPC bodies carry an analysis report, which is far larger than a control call. */
const MAX_RPC_BODY = 4 * 1024 * 1024;
/** The two report documents a case may carry, in characters. */
const MAX_CASE_DOCUMENT = 2_000_000;
const MAX_CASE_TOTAL = 3_000_000;
/** Mirrors the bridge's case-name rule so a bad name fails at the edge. */
const SAFE_CASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface GatewayOptions {
  bridge: EngineBridge;
  config: ReaClientConfig;
  configPath: string;
  staticDir: string;
  host?: string;
  port?: number;
  mode?: "desktop" | "browser";
  previewHost?: string;
  /** Required in addition to the host check when the preview is shared. */
  previewAccessToken?: string;
  allowedOrigins?: string[];
}

/** Same-origin HTTP adapter for the browser preview. Electron uses it on loopback only. */
export class DesktopGateway {
  private readonly server: Server;
  private readonly token = randomBytes(32).toString("hex");
  private readonly clients = new Set<ServerResponse>();
  private readonly onEvent = (event: DesktopEvent): void => {
    for (const client of this.clients) client.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private port = 0;

  public constructor(private readonly options: GatewayOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) this.json(response, 500, { error: error instanceof Error ? error.message : String(error) });
        else response.end();
      });
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 15_000;
  }

  public get origin(): string { return `http://${this.options.host === "0.0.0.0" ? "127.0.0.1" : this.options.host ?? "127.0.0.1"}:${this.port}`; }
  public get address(): { host: string; port: number } { return { host: this.options.host ?? "127.0.0.1", port: this.port }; }

  public async listen(): Promise<this> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1", () => {
        this.server.off("error", reject);
        this.port = (this.server.address() as AddressInfo).port;
        resolvePromise();
      });
    });
    this.options.bridge.on("event", this.onEvent);
    this.heartbeat = setInterval(() => { for (const client of this.clients) client.write(": heartbeat\n\n"); }, 15_000);
    this.heartbeat.unref();
    return this;
  }

  private hostAllowed(request: IncomingMessage): boolean {
    const host = request.headers.host;
    const local = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]);
    return host !== undefined && (local.has(host) || host === this.options.previewHost);
  }

  private originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (request.headers["sec-fetch-site"] === "cross-site") return false;
    if (origin === undefined) return true;
    if (origin === this.origin || this.options.allowedOrigins?.includes(origin)) return true;
    if (this.options.previewHost && request.headers.host === this.options.previewHost) {
      return origin === `https://${this.options.previewHost}` || origin === `http://${this.options.previewHost}`;
    }
    return false;
  }

  private authorized(request: IncomingMessage): boolean {
    const supplied = Buffer.from(request.headers["x-rea-token"]?.toString() ?? "");
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  }

  private async body(request: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
    if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected application/json.");
    // A declared length over the limit is answered before the body is read, so
    // the client sees a status instead of a connection reset mid-upload.
    if (Number(request.headers["content-length"] ?? 0) > limit) {
      request.resume();
      throw new Error(`Request exceeds the ${Math.round(limit / 1024)} KiB limit.`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) throw new Error(`Request exceeds the ${Math.round(limit / 1024)} KiB limit.`);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    if (!this.hostAllowed(request)) { this.json(response, 403, { error: "Unrecognized desktop host." }); return; }
    if (!this.originAllowed(request)) { this.json(response, 403, { error: "Cross-origin desktop requests are not allowed." }); return; }
    const url = new URL(request.url ?? "/", "http://rea.local");
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session" && request.method === "GET") {
        if (this.options.previewAccessToken !== undefined) {
          const supplied = Buffer.from(url.searchParams.get("access_token") ?? "");
          const expected = Buffer.from(this.options.previewAccessToken);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            this.json(response, 401, { error: "This preview requires an access token." });
            return;
          }
        }
        const config = this.options.config;
        const bootstrap: Bootstrap = {
          token: this.token, mode: this.options.mode ?? "desktop", version: "0.1.0", platform: process.platform,
          config: { model: config.llm.model, baseUrl: config.llm.baseUrl, contextWindow: config.llm.contextWindow, maxIterations: config.agent.maxIterations, toolScope: config.agent.toolScope, customTools: [...config.agent.customTools], allowNonLoopback: config.policy.allowNonLoopback, workspaceDir: resolve(config.workspaceDir), configPath: resolve(this.options.configPath), transport: config.rea.transport },
        };
        this.json(response, 200, bootstrap); return;
      }
      if (!this.authorized(request)) { this.json(response, 401, { error: "Missing or invalid workspace session token." }); return; }
      if (url.pathname === "/api/events" && request.method === "GET") { this.events(request, response); return; }
      if (url.pathname === "/api/rpc" && request.method === "POST") {
        let value: { method?: unknown; params?: unknown };
        try { value = JSON.parse((await this.body(request, MAX_RPC_BODY)).toString("utf8")); }
        catch (error) { this.json(response, 400, { error: (error as Error).message }); return; }
        if (!value || typeof value.method !== "string" || !RPC_METHODS.has(value.method)) { this.json(response, 403, { error: "This engine method is not available to the desktop." }); return; }
        if (value.params !== undefined && (typeof value.params !== "object" || value.params === null || Array.isArray(value.params))) { this.json(response, 400, { error: "RPC params must be an object." }); return; }
        const params = (value.params ?? {}) as Record<string, unknown>;
        if (value.method === "agent.ask" && (typeof params.question !== "string" || params.question.length > 32_000 || (params.extraInstructions !== undefined && (typeof params.extraInstructions !== "string" || params.extraInstructions.length > 8000)) || (params.clientRequestId !== undefined && (typeof params.clientRequestId !== "string" || params.clientRequestId.length === 0 || params.clientRequestId.length > 128)))) {
          this.json(response, 400, { error: "Question, request id, or instructions exceed the desktop input limit." }); return;
        }
        // Oversized or malformed evidence exports would only be rejected by the
        // engine after a round trip; refuse them at the edge instead.
        if (value.method === "evidence.export" && params.name !== undefined && (typeof params.name !== "string" || params.name.length > 96)) {
          this.json(response, 400, { error: "The export name must be a short string." }); return;
        }
        if (value.method === "evidence.get" && (typeof params.evidenceId !== "string" || params.evidenceId.length > 128)) {
          this.json(response, 400, { error: "An evidence id is required." }); return;
        }
        // Case reports are the largest payload the page can send; bound them here
        // so an oversized body never reaches the engine's JSON-RPC framing.
        if (value.method === "case.open" && (typeof params.name !== "string" || !SAFE_CASE_NAME.test(params.name))) {
          this.json(response, 400, { error: "A saved case name is required." }); return;
        }
        if (value.method === "case.save") {
          const report = params.report;
          const reportJson = params.reportJson;
          const tooLarge =
            typeof report === "string" && typeof reportJson === "string"
              ? report.length > MAX_CASE_DOCUMENT ||
                reportJson.length > MAX_CASE_DOCUMENT ||
                report.length + reportJson.length > MAX_CASE_TOTAL
              : false;
          if (
            (report !== undefined && typeof report !== "string") ||
            (reportJson !== undefined && typeof reportJson !== "string") ||
            tooLarge ||
            (params.name !== undefined && (typeof params.name !== "string" || !SAFE_CASE_NAME.test(params.name)))
          ) {
            this.json(response, 400, { error: "A case needs a bounded name and report text." }); return;
          }
        }
        try {
          const result = await this.options.bridge.request(value.method, params, value.method === "agent.ask" ? 0 : 600_000);
          this.json(response, 200, { result });
        } catch (error) { this.json(response, 502, { error: (error as Error).message }); }
        return;
      }
      if (url.pathname === "/api/upload" && request.method === "POST" && this.options.mode === "browser") {
        await this.upload(request, response, url.searchParams.get("name") ?? "binary"); return;
      }
      this.json(response, 404, { error: "Unknown desktop endpoint." }); return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") { this.json(response, 405, { error: "Method not allowed." }); return; }
    await this.static(url.pathname, response, request.method === "HEAD");
  }

  private events(request: IncomingMessage, response: ServerResponse): void {
    if (this.clients.size >= 8) { this.json(response, 429, { error: "Too many workspace event listeners." }); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    const after = Number(request.headers["last-event-id"] ?? 0);
    for (const event of this.options.bridge.eventsAfter(Number.isSafeInteger(after) ? after : 0)) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    this.clients.add(response);
    request.on("close", () => this.clients.delete(response));
  }

  private async upload(request: IncomingMessage, response: ServerResponse, rawName: string): Promise<void> {
    if (!request.headers["content-type"]?.startsWith("application/octet-stream")) { this.json(response, 415, { error: "Upload a binary as application/octet-stream." }); return; }
    const declared = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) { this.json(response, 413, { error: "Binary exceeds the 100 MiB upload limit." }); return; }
    const directory = resolve(this.options.config.workspaceDir, "uploads");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const cleanName = basename(rawName.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 140) || "binary";
    const safeName = `${randomUUID()}${extname(cleanName).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 12)}`;
    const path = join(directory, safeName);
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    const finished = new Promise<void>((resolveFinished) => { output.once("close", () => resolveFinished()); });
    let writeError: Error | undefined;
    output.on("error", (error) => { writeError ??= error; });
    let size = 0;
    let tooLarge = false;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_UPLOAD_BYTES) { tooLarge = true; break; }
        if (writeError) break;
        if (!output.write(buffer)) {
          await new Promise<void>((resolveDrain, rejectDrain) => {
            const cleanup = (): void => { output.off("drain", onDrain); output.off("error", onError); };
            const onDrain = (): void => { cleanup(); resolveDrain(); };
            const onError = (error: Error): void => { cleanup(); rejectDrain(error); };
            output.once("drain", onDrain);
            output.once("error", onError);
          });
        }
      }
    } catch (error) { writeError ??= error as Error; }
    output.end();
    await finished;
    if (tooLarge || writeError || !request.complete) {
      await unlink(path).catch(() => undefined);
      if (tooLarge) {
        request.resume();
        this.json(response, 413, { error: "Binary exceeds the 100 MiB upload limit." });
        return;
      }
      this.json(response, 400, { error: writeError?.message ?? "Upload interrupted." });
      return;
    }
    if (size === 0) { await unlink(path).catch(() => undefined); this.json(response, 400, { error: "The selected file is empty." }); return; }
    this.json(response, 200, { path, name: cleanName, size });
  }

  private async static(pathname: string, response: ServerResponse, head: boolean): Promise<void> {
    const root = resolve(this.options.staticDir);
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); }
    catch { this.json(response, 400, { error: "Invalid asset path." }); return; }
    let path = resolve(root, `.${decoded}`);
    if (path !== root && !path.startsWith(`${root}${sep}`)) { this.json(response, 403, { error: "Invalid asset path." }); return; }
    // `resolve` collapses `..`, but a symlink inside the build output could still
    // point outside it. Compare real paths so the containment claim holds.
    const realRoot = await realpath(root).catch(() => root);
    const realPath = await realpath(path).catch(() => path);
    if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) { this.json(response, 403, { error: "Invalid asset path." }); return; }
    try {
      if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    } catch {
      if (!extname(pathname)) path = join(root, "index.html");
    }
    try {
      const content = await readFile(path);
      response.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream", "Cache-Control": path.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache" });
      response.end(head ? undefined : content);
    } catch { this.json(response, 404, { error: "Desktop assets not found. Run npm run build:desktop." }); }
  }

  public async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.options.bridge.off("event", this.onEvent);
    for (const client of this.clients) client.end();
    this.clients.clear();
    const closed = new Promise<void>((r) => this.server.close(() => r()));
    // Idle keep-alive sockets would otherwise hold `close` open indefinitely.
    this.server.closeAllConnections();
    await closed;
    await this.options.bridge.close();
  }
}
