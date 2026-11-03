import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineBridge } from "../../src/desktop/EngineBridge.js";
import { DesktopGateway } from "../../src/desktop/gateway.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { DesktopEvent } from "../../src/desktop/protocol.js";

const fixture = resolve("test/support/fakeEngine.mjs");
const CLI = resolve("dist/cli.js");
const REA_ENTRY = resolve("node_modules/rea-agents/scripts/rea.mjs");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function start(): Promise<{ gateway: DesktopGateway; bridge: EngineBridge; token: string }> {
  const directory = await mkdtemp(join(tmpdir(), "rea-gateway-e2e-"));
  const staticDir = join(directory, "dist-desktop");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>REA</title>");
  const bridge = new EngineBridge({ cliPath: fixture, requestTimeoutMs: 15_000 });
  const gateway = new DesktopGateway({
    bridge,
    config: { ...DEFAULT_CONFIG, workspaceDir: join(directory, "workspace") },
    configPath: join(directory, "config.json"),
    staticDir,
    port: 0,
    mode: "browser",
  });
  await gateway.listen();
  cleanups.push(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = (await (await fetch(`${gateway.origin}/api/session`)).json()) as { token: string };
  return { gateway, bridge, token: session.token };
}

describe("gateway over the real bridge process", () => {
  it("serves the UI, proxies RPC to the child, and replays its notifications over SSE", async () => {
    const { gateway, bridge, token } = await start();
    const call = async (method: string): Promise<Response> =>
      await fetch(`${gateway.origin}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-REA-Token": token },
        body: JSON.stringify({ method, params: {} }),
      });

    const page = await fetch(`${gateway.origin}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("REA");

    const pingBody = (await (await call("engine.ping")).json()) as { result: { ok: boolean; pid: number } };
    expect(pingBody.result.ok).toBe(true);
    expect(pingBody.result.pid).toBeGreaterThan(0);

    // Notifications are replayed from the bridge's history when a subscriber
    // connects with Last-Event-ID, so the engine's startup banner is already
    // waiting by the time this stream opens.

    const controller = new AbortController();
    const events = await fetch(`${gateway.origin}/api/events`, {
      headers: { "X-REA-Token": token, "Last-Event-ID": "0" },
      signal: controller.signal,
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");

    const received: DesktopEvent[] = [];
    const reader = events.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (label: string, predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}; saw ${received.map((event) => event.method).join(", ")}`);
        const chunk = await reader?.read();
        if (!chunk || chunk.done) throw new Error("Event stream closed early");
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data !== undefined) received.push(JSON.parse(data.slice(6)) as DesktopEvent);
          boundary = buffer.indexOf("\n\n");
        }
      }
    };

    await readUntil("the replayed startup notification", () => received.some((event) => event.method === "engine.ready"));

    // Live fan-out: the bridge is the only producer of events, so emit one the
    // way `publish` does and confirm it reaches the subscribed client.
    const live: DesktopEvent = {
      id: (received.at(-1)?.id ?? 0) + 1000,
      method: "agent.event",
      params: { type: "assistant_delta", data: { text: "streamed" } },
      time: new Date().toISOString(),
    };
    bridge.emit("event", live);
    await readUntil("a live notification", () => received.some((event) => event.id === live.id));
    controller.abort();
    await reader?.cancel().catch(() => undefined);

    expect(received.find((event) => event.id === live.id)?.params).toMatchObject({ type: "assistant_delta" });
    const replayed = received.filter((event) => event.id < live.id).map((event) => event.id);
    expect(replayed).toEqual([...replayed].sort((a, b) => a - b));
  }, 30_000);

  it("saves a case folder through the gateway and lists it back", async () => {
    // This one needs the *real* engine process: `case.save` is implemented in
    // `dist/cli.js serve`, not in the fixture, and asserting against a fake
    // would only test the fake.
    if (!existsSync(CLI)) return;
    const directory = await mkdtemp(join(tmpdir(), "rea-gateway-case-"));
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ rea: { command: process.execPath, args: [REA_ENTRY, "mcp"] }, workspaceDir: join(directory, "workspace") }), "utf8");
    const bridge = new EngineBridge({ cliPath: CLI, configPath, requestTimeoutMs: 120_000 });
    const gateway = new DesktopGateway({
      bridge,
      config: { ...DEFAULT_CONFIG, workspaceDir: join(directory, "workspace") },
      configPath,
      staticDir: join(directory, "static"),
      port: 0,
      mode: "browser",
    });
    await mkdir(join(directory, "static"), { recursive: true });
    await gateway.listen();
    cleanups.push(async () => {
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
    });
    const { token } = (await (await fetch(`${gateway.origin}/api/session`)).json()) as { token: string };
    const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      const response = await fetch(`${gateway.origin}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-REA-Token": token },
        body: JSON.stringify({ method, params }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { result: unknown }).result;
    };

    const saved = (await call("case.save", {
      name: "integration-case",
      report: "# REA analysis report\n\nintegration",
      reportJson: '{"schemaVersion":1}',
      // The fixture engine has no REA tools, so the bundle step must degrade.
      includeEvidence: true,
    })) as { ok: boolean; directory: string; files: Array<{ name: string }>; evidence?: { ok: boolean } };
    expect(saved.ok).toBe(true);
    expect(saved.files.map((file) => file.name)).toEqual([
      "analysis.md",
      "analysis.json",
      "evidence-bundle.json",
    ]);
    // REA wrote the package itself: the file is the canonical byte-stable bundle.
    expect(saved.evidence).toMatchObject({ ok: true, unknowns: 0 });
    const bundle = await readFile(join(saved.directory, "evidence-bundle.json"), "utf8");
    expect(bundle.startsWith('{"artifacts"')).toBe(true);
    expect(await readFile(join(saved.directory, "analysis.md"), "utf8")).toBe("# REA analysis report\n\nintegration");

    const listed = (await call("case.list")) as { cases: Array<{ name: string; files: Array<{ name: string }> }>; total: number };
    expect(listed.total).toBe(1);
    expect(listed.cases[0]?.name).toBe("integration-case");
  }, 40_000);

  it("closes the engine child process with the gateway", async () => {
    const { gateway, bridge } = await start();
    await fetch(`${gateway.origin}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-REA-Token": (await (await fetch(`${gateway.origin}/api/session`)).json() as { token: string }).token },
      body: JSON.stringify({ method: "engine.ping" }),
    });
    expect(bridge.running).toBe(true);
    await gateway.close();
    expect(bridge.running).toBe(false);
  }, 30_000);
});
