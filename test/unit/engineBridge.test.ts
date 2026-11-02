import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineBridge } from "../../src/desktop/EngineBridge.js";

const fixture = resolve("test/support/fakeEngine.mjs");
const bridges: EngineBridge[] = [];

function createBridge(maxLineBytes = 64 * 1024): EngineBridge {
  const bridge = new EngineBridge({ cliPath: fixture, maxLineBytes, requestTimeoutMs: 5_000 });
  bridges.push(bridge);
  return bridge;
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe("EngineBridge", () => {
  it("spawns the CLI, frames requests, and publishes notifications", async () => {
    const bridge = createBridge();
    const events: string[] = [];
    bridge.on("event", (event: { method: string }) => events.push(event.method));

    const ping = await bridge.request<{ ok: boolean; pid: number }>("engine.ping");
    expect(ping.ok).toBe(true);
    expect(ping.pid).toBeGreaterThan(0);

    const echoed = await bridge.request<{ params: Record<string, unknown> }>("echo", { value: 7 });
    expect(echoed.params).toEqual({ value: 7 });

    await bridge.request("notify");
    expect(events).toContain("engine.ready");
    expect(events).toContain("agent.event");
    expect(bridge.running).toBe(true);
  });

  it("replays only events newer than the requested id", async () => {
    const bridge = createBridge();
    await bridge.request("notify");
    const all = bridge.eventsAfter(0);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const lastId = all.at(-1)?.id ?? 0;
    expect(bridge.eventsAfter(lastId)).toEqual([]);
    expect(bridge.eventsAfter(lastId - 1)).toHaveLength(1);
  });

  it("surfaces engine errors and request timeouts without losing the process", async () => {
    const bridge = createBridge();
    await expect(bridge.request("fail")).rejects.toThrow("fixture failure");
    await expect(bridge.request("slow", {}, 60)).rejects.toThrow(/timed out/);
    // A timed-out request must not poison later calls.
    await expect(bridge.request("engine.ping")).resolves.toMatchObject({ ok: true });
  });

  it("reports an invalid engine frame and forwards stderr as events", async () => {
    const bridge = createBridge();
    const methods: string[] = [];
    bridge.on("event", (event: { method: string }) => methods.push(event.method));

    await bridge.request("badjson");
    await bridge.request("stderr");
    await vi.waitFor(() => {
      expect(methods).toContain("engine.protocol_error");
      expect(methods).toContain("engine.stderr");
    });
  });

  it("fails closed when a frame exceeds the bridge limit", async () => {
    const bridge = createBridge(256);
    await expect(bridge.request("oversized")).rejects.toThrow(/bridge limit/);
    await vi.waitFor(() => expect(bridge.running).toBe(false));
  });

  it("shuts the child process down gracefully and is idempotent", async () => {
    const bridge = createBridge();
    await bridge.request("engine.ping");
    await bridge.close();
    expect(bridge.running).toBe(false);
    await bridge.close();
    await expect(bridge.request("engine.ping")).rejects.toThrow(/closing/);
  });
});

describe("EngineBridge — spawn failure", () => {
  it("clears the failed child so a later request retries instead of hanging", async () => {
    const bridge = new EngineBridge({
      cliPath: fixture,
      nodePath: resolve("test/support/does-not-exist-node"),
      requestTimeoutMs: 2_000,
    });
    bridges.push(bridge);

    await expect(bridge.request("engine.ping")).rejects.toThrow();
    expect(bridge.running).toBe(false);
    await expect(bridge.request("engine.ping")).rejects.toThrow();
  });
});
