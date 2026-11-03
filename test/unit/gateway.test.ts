import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopGateway } from "../../src/desktop/gateway.js";
import type { EngineBridge } from "../../src/desktop/EngineBridge.js";
import type { DesktopEvent } from "../../src/desktop/protocol.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

class FakeBridge extends EventEmitter {
  public readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  public result: unknown = { ok: true };
  public failure: Error | null = null;
  public history: DesktopEvent[] = [];
  public closed = false;

  public async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.failure) throw this.failure;
    return this.result;
  }

  public eventsAfter(id: number): DesktopEvent[] {
    return this.history.filter((event) => event.id > id);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

interface ResponseSnapshot {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<ResponseSnapshot> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          ...options.headers,
          ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

const open: Array<{ gateway: DesktopGateway; directory: string }> = [];

async function start(options: { previewHost?: string; previewAccessToken?: string; mode?: "browser" | "desktop" } = {}): Promise<{
  gateway: DesktopGateway;
  bridge: FakeBridge;
  directory: string;
  port: number;
  token: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "rea-gateway-"));
  const staticDir = join(directory, "dist-desktop");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>workspace</title>");
  await writeFile(join(staticDir, "assets", "app.js"), "console.log('workspace');");
  await writeFile(join(directory, "secret.txt"), "outside static root");
  const bridge = new FakeBridge();
  const gateway = new DesktopGateway({
    bridge: bridge as unknown as EngineBridge,
    config: { ...DEFAULT_CONFIG, workspaceDir: join(directory, "workspace") },
    configPath: join(directory, "config.json"),
    staticDir,
    port: 0,
    mode: options.mode ?? "browser",
    ...(options.previewHost === undefined ? {} : { previewHost: options.previewHost }),
    ...(options.previewAccessToken === undefined ? {} : { previewAccessToken: options.previewAccessToken }),
  });
  await gateway.listen();
  open.push({ gateway, directory });
  const query = options.previewAccessToken === undefined ? "" : `?access_token=${encodeURIComponent(options.previewAccessToken)}`;
  const token = (JSON.parse((await send(gateway.address.port, `/api/session${query}`)).body) as { token: string }).token;
  return { gateway, bridge, directory, port: gateway.address.port, token };
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.gateway.close();
    await rm(entry.directory, { recursive: true, force: true });
  }
});

describe("DesktopGateway", () => {
  it("serves the built UI with a restrictive policy and returns bootstrap config", async () => {
    const { port } = await start();
    const page = await send(port, "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("workspace");
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");

    const asset = await send(port, "/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");

    const session = JSON.parse((await send(port, "/api/session")).body) as {
      token: string;
      mode: string;
      config: { allowNonLoopback: boolean; configPath: string; workspaceDir: string };
    };
    expect(session.token).toHaveLength(64);
    expect(session.mode).toBe("browser");
    expect(session.config.allowNonLoopback).toBe(false);
    expect(session.config.configPath).toContain("config.json");
  });

  it("rejects unrecognized hosts, cross-origin requests, unknown endpoints, and escaping symlinks", async () => {
    const { port, token, directory } = await start();
    const staticDir = join(directory, "dist-desktop");
    expect((await send(port, "/", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await send(port, "/api/session", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await send(port, "/api/session", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await send(port, "/api/nope", { headers: { "X-REA-Token": token } })).status).toBe(404);
    expect((await send(port, "/", { method: "POST" })).status).toBe(405);
    expect((await send(port, "/..%2fsecret.txt")).status).toBe(403);
    // A symlink inside the build output must not become a read primitive.
    if (process.platform === "win32") {
      // A native junction tests the same canonical-path boundary without elevated privileges.
      const outside = join(directory, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "file.js"), "outside the build output");
      await symlink(outside, join(staticDir, "linked"), "junction");
      expect((await send(port, "/linked/file.js")).status).toBe(403);
    } else {
      const outside = join(directory, "outside.js");
      await writeFile(outside, "outside the build output");
      await symlink(outside, join(staticDir, "linked.js"));
      expect((await send(port, "/linked.js")).status).toBe(403);
    }
  });

  it("requires the workspace token and an explicit RPC allowlist", async () => {
    const { port, token, bridge } = await start();
    expect(
      (
        await send(port, "/api/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "engine.ping" }),
        })
      ).status,
    ).toBe(401);

    const call = async (payload: unknown, headers: Record<string, string> = {}) =>
      send(port, "/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-REA-Token": token, ...headers },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      });

    expect((await call({ method: "engine.shutdown" })).status).toBe(403);
    expect((await call({ method: "eval" })).status).toBe(403);
    expect((await call("{not json")).status).toBe(400);
    expect((await call({ method: "engine.ping", params: [1, 2] })).status).toBe(400);
    expect((await call({ method: "agent.ask", params: { question: "x".repeat(32_001) } })).status).toBe(400);

    const ok = await call({ method: "engine.ping", params: { verbose: true } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ result: { ok: true } });
    expect(bridge.requests.at(-1)).toEqual({ method: "engine.ping", params: { verbose: true } });

    bridge.failure = new Error("engine offline");
    const failed = await call({ method: "engine.ping" });
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.body)).toEqual({ error: "engine offline" });
  });

  it("exposes retained evidence reads but bounds what reaches the engine", async () => {
    const { port, token, bridge } = await start();
    const call = async (payload: Record<string, unknown>) =>
      send(port, "/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-REA-Token": token },
        body: JSON.stringify(payload),
      });

    const evidenceId = `ev_${"ab".repeat(32)}`;
    const listed = await call({ method: "evidence.list" });
    expect(listed.status).toBe(200);
    expect(bridge.requests.at(-1)).toEqual({ method: "evidence.list", params: {} });

    const record = await call({ method: "evidence.get", params: { evidenceId } });
    expect(record.status).toBe(200);
    expect(bridge.requests.at(-1)).toEqual({ method: "evidence.get", params: { evidenceId } });

    const exported = await call({ method: "evidence.export", params: { overwrite: true } });
    expect(exported.status).toBe(200);
    expect(bridge.requests.at(-1)).toEqual({ method: "evidence.export", params: { overwrite: true } });

    // A missing id or an unbounded export name never leaves the gateway.
    expect((await call({ method: "evidence.get", params: {} })).status).toBe(400);
    expect((await call({ method: "evidence.get", params: { evidenceId: 7 } })).status).toBe(400);
    expect((await call({ method: "evidence.get", params: { evidenceId: "e".repeat(129) } })).status).toBe(400);
    expect((await call({ method: "evidence.export", params: { name: "x".repeat(97) } })).status).toBe(400);
    expect((await call({ method: "evidence.export", params: { name: 12 } })).status).toBe(400);
    expect(bridge.requests.at(-1)?.method).toBe("evidence.export");
  });

  it("forwards case saves within bounds and lists saved cases", async () => {
    const { port, token, bridge } = await start();
    const call = async (payload: Record<string, unknown>) =>
      send(port, "/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-REA-Token": token },
        body: JSON.stringify(payload),
      });

    const saved = await call({
      method: "case.save",
      params: { report: "# report", reportJson: "{}", includeEvidence: true },
    });
    expect(saved.status).toBe(200);
    expect(bridge.requests.at(-1)).toEqual({
      method: "case.save",
      params: { report: "# report", reportJson: "{}", includeEvidence: true },
    });

    const listed = await call({ method: "case.list" });
    expect(listed.status).toBe(200);
    expect(bridge.requests.at(-1)).toEqual({ method: "case.list", params: {} });

    const opened = await call({ method: "case.open", params: { name: "ls-triage" } });
    expect(opened.status).toBe(200);
    expect(bridge.requests.at(-1)).toEqual({ method: "case.open", params: { name: "ls-triage" } });

    const removed = await call({ method: "case.delete", params: { name: "ls-triage" } });
    expect(removed.status).toBe(200);
    expect(bridge.requests.at(-1)).toEqual({ method: "case.delete", params: { name: "ls-triage" } });

    // Reports are the biggest body the page can send; they are bounded at the edge.
    const before = bridge.requests.length;
    expect((await call({ method: "case.save", params: { report: 7, reportJson: "{}" } })).status).toBe(400);
    expect((await call({ method: "case.save", params: { report: "x", reportJson: ["{}"] } })).status).toBe(400);
    expect((await call({ method: "case.save", params: { report: "x".repeat(2_000_001), reportJson: "{}" } })).status).toBe(400);
    // Individually acceptable, together too large.
    expect(
      (await call({ method: "case.save", params: { report: "x".repeat(1_800_000), reportJson: "y".repeat(1_800_000) } })).status,
    ).toBe(400);
    expect((await call({ method: "case.save", params: { report: "x", reportJson: "{}", name: "n".repeat(97) } })).status).toBe(400);
    expect((await call({ method: "case.save", params: { report: "x", reportJson: "{}", name: 9 } })).status).toBe(400);
    expect((await call({ method: "case.open", params: {} })).status).toBe(400);
    expect((await call({ method: "case.open", params: { name: "n".repeat(97) } })).status).toBe(400);
    expect((await call({ method: "case.open", params: { name: 3 } })).status).toBe(400);
    expect((await call({ method: "case.open", params: { name: "../escape" } })).status).toBe(400);
    // Deletion is destructive: a bad name never reaches the engine.
    expect((await call({ method: "case.open", params: { name: "../escape" } })).status).toBe(400);
    expect((await call({ method: "case.delete", params: {} })).status).toBe(400);
    expect((await call({ method: "case.delete", params: { name: "../escape" } })).status).toBe(400);
    expect((await call({ method: "case.delete", params: { name: "nested/path" } })).status).toBe(400);
    expect((await call({ method: "case.delete", params: { name: 12 } })).status).toBe(400);
    expect((await call({ method: "case.open", params: { name: "nested/path" } })).status).toBe(400);
    expect((await call({ method: "case.save", params: { report: "x", reportJson: "{}", name: "../escape" } })).status).toBe(400);
    expect(bridge.requests.length).toBe(before);
  });

  it("replays retained events and enforces the listener cap", async () => {
    const { port, token, bridge } = await start();
    bridge.history = [
      { id: 1, method: "engine.ready", params: {}, time: new Date().toISOString() },
      { id: 2, method: "agent.event", params: { type: "assistant_delta" }, time: new Date().toISOString() },
    ];
    const replay = await new Promise<string>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/events",
          headers: { "X-REA-Token": token, "Last-Event-ID": "1" },
        },
        (response) => {
          expect(response.statusCode).toBe(200);
          expect(response.headers["content-type"]).toContain("text/event-stream");
          response.once("data", (chunk: Buffer) => {
            request.destroy();
            resolve(chunk.toString("utf8"));
          });
        },
      );
      request.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      request.end();
    });
    expect(replay).toContain("id: 2");
    expect(replay).not.toContain("id: 1");
  });

  it("accepts streamed browser uploads inside the workspace with sanitized names", async () => {
    const { port, token, directory } = await start();
    const payload = Buffer.from("fake binary payload");
    const response = await send(port, `/api/upload?name=${encodeURIComponent("../My Binary.exe")}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-REA-Token": token },
      body: payload,
    });
    expect(response.status).toBe(200);
    const uploaded = JSON.parse(response.body) as { path: string; name: string; size: number };
    expect(uploaded.name).toBe("My Binary.exe");
    expect(uploaded.size).toBe(payload.length);
    expect(uploaded.path.startsWith(join(directory, "workspace", "uploads"))).toBe(true);
    await expect(readFile(uploaded.path)).resolves.toEqual(payload);

    const wrongType = await send(port, "/api/upload?name=a.bin", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-REA-Token": token },
      body: payload,
    });
    expect(wrongType.status).toBe(415);

    const empty = await send(port, "/api/upload?name=empty.bin", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-REA-Token": token },
    });
    expect(empty.status).toBe(400);

    const tooLarge = await send(port, "/api/upload?name=huge.bin", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-REA-Token": token,
        "Content-Length": String(200 * 1024 * 1024),
      },
    });
    expect(tooLarge.status).toBe(413);
  });

  it("requires the configured preview access token before issuing a session", async () => {
    const previewHost = "5173-preview.e2b.app";
    const { port, token } = await start({ previewHost, previewAccessToken: "correct-horse" });

    expect((await send(port, "/api/session", { headers: { Host: previewHost } })).status).toBe(401);
    expect((await send(port, "/api/session?access_token=wrong", { headers: { Host: previewHost } })).status).toBe(401);
    expect((await send(port, "/api/session?access_token=correct-horse", { headers: { Host: previewHost } })).status).toBe(200);
    const rpc = await send(port, "/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-REA-Token": token },
      body: JSON.stringify({ method: "engine.ping" }),
    });
    expect(rpc.status).toBe(200);
  });

  it("accepts the preview host only when it was configured explicitly", async () => {
    const previewHost = "5173-preview.e2b.app";
    const { port } = await start({ previewHost });
    const page = await send(port, "/", { headers: { Host: previewHost } });
    expect(page.status).toBe(200);
    const crossOrigin = await send(port, "/", {
      headers: { Host: previewHost, Origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
    const previewOrigin = await send(port, "/", {
      headers: { Host: previewHost, Origin: `https://${previewHost}` },
    });
    expect(previewOrigin.status).toBe(200);
  });
});
