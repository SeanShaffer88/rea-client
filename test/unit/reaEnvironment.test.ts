import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { ReaClient } from "../../src/mcp/ReaClient.js";

afterEach(() => vi.restoreAllMocks());

describe("REA subprocess environment", () => {
  async function environment(command: string, electron: boolean, env: Record<string, string> = {}) {
    if (electron) Object.defineProperty(process.versions, "electron", { value: "45.2.1", configurable: true });
    let captured: Record<string, string> = {};
    const client = {
      connect: async (transport: { _serverParams: { env: Record<string, string> } }) => { captured = transport._serverParams.env; },
      close: async () => undefined,
    } as unknown as Client;
    const rea = new ReaClient({ ...DEFAULT_CONFIG.rea, command, env }, { clientFactory: () => client });
    try { await rea.connect(); await rea.close(); return captured; }
    finally { if (electron) delete (process.versions as Record<string, string>)["electron"]; }
  }

  it("keeps the packaged executable in Node mode without inheriting secrets", async () => {
    vi.stubEnv("REA_TEST_SECRET", "must-not-leak");
    try {
      const env = await environment(process.execPath, true);
      expect(env["ELECTRON_RUN_AS_NODE"]).toBe("1");
      expect(env["REA_TEST_SECRET"]).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  it("does not inject Electron flags into an external command or plain Node", async () => {
    expect((await environment("custom-rea-command", true))["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
    expect((await environment(process.execPath, false))["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
  });

  it("retains explicit subprocess environment overrides", async () => {
    expect((await environment(process.execPath, true, { ELECTRON_RUN_AS_NODE: "0" }))["ELECTRON_RUN_AS_NODE"]).toBe("0");
  });
});
