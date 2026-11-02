import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type ReaClientConfig } from "../../src/config.js";
import { checkNodeVersion, runDoctor } from "../../src/doctor.js";
import { ReaClient } from "../../src/mcp/ReaClient.js";
import { NetworkPolicyError } from "../../src/platform/net.js";

describe("checkNodeVersion", () => {
  it("fails below Node 22", () => {
    expect(checkNodeVersion("20.11.0").status).toBe("fail");
  });

  it("warns on Node 22 below REA's declared 22.23.4 floor", () => {
    const result = checkNodeVersion("22.22.3");
    expect(result.status).toBe("warn");
    expect(result.remediation).toBeDefined();
  });

  it.each(["22.23.4", "22.24.0", "24.22.1", "24.25.0", "26.12.1", "27.0.0"])(
    "passes %s inside REA's declared engine range",
    (version) => {
      const result = checkNodeVersion(version);
      expect(result.status).toBe("ok");
      expect(result.remediation).toBeUndefined();
    },
  );

  it.each(["23.5.0", "24.22.0", "25.1.0", "26.12.0"])(
    "warns on %s outside REA's declared engine range",
    (version) => {
      expect(checkNodeVersion(version).status).toBe("warn");
    },
  );
});

describe("runDoctor — LLM auth and air-gap policy", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "rea-doctor-unit-"));
  });

  afterEach(async () => {
    if (workspaceDir !== "") await rm(workspaceDir, { recursive: true, force: true });
  });

  function fastFailReaConfig(overrides: Partial<ReaClientConfig> = {}): ReaClientConfig {
    return {
      ...DEFAULT_CONFIG,
      ...overrides,
      workspaceDir,
      rea: {
        ...DEFAULT_CONFIG.rea,
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
        startupTimeoutSec: 5,
        ...overrides.rea,
      },
    };
  }

  it("sends Authorization: Bearer <apiKey> when probing /models", async () => {
    let seenAuth: string | undefined;
    const fakeFetch: typeof fetch = vi.fn(async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth = headers["authorization"];
      return new Response(JSON.stringify({ data: [{ id: "qwen2.5-coder" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const report = await runDoctor(
      fastFailReaConfig({
        llm: { ...DEFAULT_CONFIG.llm, apiKey: "secret-local-token" },
      }),
      { fetchImpl: fakeFetch, nodeVersion: "24.22.1" },
    );

    expect(seenAuth).toBe("Bearer secret-local-token");
    expect(report.checks.find((c) => c.id === "llm")?.status).toBe("ok");
  });

  it("refuses to probe a non-loopback llm.baseUrl when allowNonLoopback is false", async () => {
    const fakeFetch: typeof fetch = vi.fn(async () => {
      throw new Error("fetch must not be called for blocked off-box URLs");
    });

    const report = await runDoctor(
      fastFailReaConfig({
        llm: { ...DEFAULT_CONFIG.llm, baseUrl: "http://10.0.0.8:8080/v1" },
        policy: { allowNonLoopback: false },
      }),
      { fetchImpl: fakeFetch, nodeVersion: "24.22.1" },
    );

    expect(fakeFetch).not.toHaveBeenCalled();
    expect(report.checks.find((c) => c.id === "network-policy")?.status).toBe("fail");
    expect(report.checks.find((c) => c.id === "llm")?.status).toBe("fail");
  });
});

describe("ReaClient — HTTP transport loopback enforcement", () => {
  it("refuses to connect to a non-loopback httpUrl when allowNonLoopback is false", async () => {
    const client = new ReaClient(
      {
        ...DEFAULT_CONFIG.rea,
        transport: "http",
        httpUrl: "http://10.0.0.8:8721/mcp",
      },
      { allowNonLoopback: false },
    );

    await expect(client.connect()).rejects.toThrow(NetworkPolicyError);
  });
});
