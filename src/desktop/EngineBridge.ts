import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { DesktopEvent } from "./protocol.js";

export interface EngineBridgeOptions {
  cliPath: string;
  configPath?: string;
  cwd?: string;
  nodePath?: string;
  maxLineBytes?: number;
  requestTimeoutMs?: number;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Supervises the existing stdio engine; the renderer never receives process access. */
export class EngineBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private closing = false;
  private nextId = 1;
  private nextEventId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly history: DesktopEvent[] = [];
  private readonly maxLineBytes: number;
  private readonly requestTimeoutMs: number;

  public constructor(private readonly options: EngineBridgeOptions) {
    super();
    this.maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
  }

  public get running(): boolean { return this.child !== undefined && this.child.exitCode === null; }
  public eventsAfter(id: number): DesktopEvent[] { return this.history.filter((event) => event.id > id); }

  public async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.requestTimeoutMs): Promise<T> {
    await this.start();
    const child = this.child;
    if (child === undefined || child.exitCode !== null) throw new Error("The REA engine is not running. Reconnect and try again.");
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      const timer = timeoutMs === 0 ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out. Check Diagnostics or cancel the active turn.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolvePromise(value as T), reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) this.failAll(error);
      });
    });
  }

  public async start(): Promise<void> {
    if (this.closing) throw new Error("The REA workspace is closing.");
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolvePromise, reject) => {
      const args = [resolve(this.options.cliPath), "serve"];
      if (this.options.configPath) args.push("--config", resolve(this.options.configPath));
      const child = spawn(this.options.nodePath ?? process.execPath, args, {
        cwd: this.options.cwd ?? process.cwd(),
        env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      let settled = false;
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let oversized = false;
      const stderrDecoder = new StringDecoder("utf8");
      let stderrBuffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (oversized) { oversized = false; continue; }
          if (Buffer.byteLength(raw) > this.maxLineBytes) {
            oversized = true;
            this.failAll(new Error("An engine response exceeded the desktop bridge limit."));
            child.kill("SIGTERM");
            continue;
          }
          const line = raw.trim();
          if (line) this.receive(line);
        }
        if (Buffer.byteLength(buffer) > this.maxLineBytes) {
          buffer = "";
          oversized = true;
          this.failAll(new Error("An engine response exceeded the desktop bridge limit."));
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += stderrDecoder.write(chunk);
        const lines = stderrBuffer.split("\n");
        stderrBuffer = (lines.pop() ?? "").slice(-8192);
        for (const line of lines) if (line.trim()) this.publish("engine.stderr", { line: line.slice(0, 8192) });
      });
      child.stdin.on("error", (error) => this.failAll(error));
      child.once("error", (error) => {
        this.failAll(error);
        if (this.child === child) this.child = undefined;
        if (!settled) { settled = true; reject(error); }
      });
      child.once("exit", (code, signal) => {
        const error = new Error(this.closing ? "The REA engine stopped." : `The REA engine exited unexpectedly (${signal ?? code ?? "unknown"}). Open Diagnostics to reconnect.`);
        this.failAll(error);
        if (!settled) { settled = true; reject(error); }
        if (this.child === child) this.child = undefined;
        if (!this.closing) this.publish("engine.disconnected", { message: error.message });
      });
      child.once("spawn", () => { settled = true; resolvePromise(); });
    });
    try { await this.starting; }
    finally { this.starting = undefined; }
  }

  private receive(line: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(line); }
    catch { this.publish("engine.protocol_error", { message: "The engine emitted an invalid JSON frame." }); return; }
    if (typeof message.method === "string") { this.publish(message.method, message.params ?? {}); return; }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? "The engine returned an unknown error."));
    else pending.resolve(message.result);
  }

  private publish(method: string, params: Record<string, unknown>): void {
    const event: DesktopEvent = { id: this.nextEventId++, method, params, time: new Date().toISOString() };
    this.history.push(event);
    if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
    this.emit("event", event);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  public async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolvePromise) => {
      // MCP's stdio transport allows two seconds after stdin EOF and two
      // more after SIGTERM. Let it reap REA before terminating the engine.
      const kill = setTimeout(() => child.kill("SIGKILL"), 6000);
      child.once("exit", () => { clearTimeout(kill); resolvePromise(); });
      try { child.stdin.write('{"jsonrpc":"2.0","id":0,"method":"engine.shutdown"}\n'); }
      catch { child.kill("SIGTERM"); }
    });
  }
}
