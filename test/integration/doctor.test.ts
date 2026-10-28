/**
 * `runDoctor` in-process.
 *
 * The CLI exercises this through a subprocess, which v8 coverage cannot observe,
 * so the checks are asserted directly here. `doctor` is the first thing a user
 * runs when something is wrong, so its individual verdicts matter.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type ReaClientConfig } from "../../src/config.js";
import { runDoctor } from "../../src/doctor.js";
import { ToolCatalog } from "../../src/mcp/catalog.js";
import { ReaClient } from "../../src/mcp/ReaClient.js";

const REA_ENTRY = resolve("node_modules/rea-agents/scripts/rea.mjs");
const hasRea = existsSync(REA_ENTRY);

const liveConfig: ReaClientConfig = {
  ...DEFAULT_CONFIG,
  rea: { ...DEFAULT_CONFIG.rea, command: process.execPath, args: [REA_ENTRY, "mcp"] },
  workspaceDir: "workspace",
};

function find(report: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  return report.checks.find((check) => check.id === id);
}

describe("runDoctor — checks that need no server", () => {
  it("passes the loopback policy for default configuration", async () => {
    const report = await runDoctor(
      { ...liveConfig, rea: { ...liveConfig.rea, args: ["--nope"] } },
      { skipLlm: true },
    );
    // The MCP check will fail, but the policy verdict must still be produced.
    expect(find(report, "network-policy")?.status).toBe("ok");
  });

  it("fails the loopback policy when an endpoint is off-box", async () => {
    const report = await runDoctor(
      {
        ...liveConfig,
        rea: { ...liveConfig.rea, args: ["--nope"] },
        policy: { allowNonLoopback: false },
        llm: { ...liveConfig.llm, baseUrl: "http://192.168.1.50:8080/v1" },
      },
      { skipLlm: true },
    );
    const check = find(report, "network-policy");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("192.168.1.50");
    expect(report.healthy).toBe(false);
  });

  it("warns instead of failing when allowNonLoopback is deliberate", async () => {
    const report = await runDoctor(
      {
        ...liveConfig,
        rea: { ...liveConfig.rea, args: ["--nope"] },
        policy: { allowNonLoopback: true },
      },
      { skipLlm: true },
    );
    expect(find(report, "network-policy")?.status).toBe("warn");
  });

  it("marks the model probe as skipped when requested", async () => {
    const report = await runDoctor(
      { ...liveConfig, rea: { ...liveConfig.rea, args: ["--nope"] } },
      { skipLlm: true },
    );
    expect(find(report, "llm")?.status).toBe("skipped");
  });

  it("reports an unreachable model endpoint with remediation", async () => {
    const report = await runDoctor(
      { ...liveConfig, rea: { ...liveConfig.rea, args: ["--nope"] } },
      {
        fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
      },
    );
    const check = find(report, "llm");
    expect(check?.status).toBe("fail");
    expect(check?.remediation).toContain("llama-server");
  });

  it("reports a failing model endpoint by status code", async () => {
    const report = await runDoctor(
      { ...liveConfig, rea: { ...liveConfig.rea, args: ["--nope"] } },
      {
        fetchImpl: (() =>
          Promise.resolve(new Response("nope", { status: 503 }))) as typeof fetch,
      },
    );
    expect(find(report, "llm")?.detail).toContain("503");
  });

  it("lists model ids when the endpoint answers", async () => {
    const report = await runDoctor(
      { ...liveConfig, rea: { ...liveConfig.rea, args: ["--nope"] } },
      {
        fetchImpl: (() =>
          Promise.resolve(
            new Response(JSON.stringify({ data: [{ id: "qwen2.5-coder-14b" }] }), { status: 200 }),
          )) as typeof fetch,
      },
    );
    const check = find(report, "llm");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("qwen2.5-coder-14b");
  });

  it("reports a broken MCP command without throwing", async () => {
    const report = await runDoctor(
      { ...liveConfig, rea: { ...liveConfig.rea, args: ["definitely-not-a-command"] } },
      { skipLlm: true },
    );
    const check = find(report, "rea-mcp");
    expect(check?.status).toBe("fail");
    expect(check?.remediation).toContain("rea.command");
    // Downstream checks still report rather than vanishing.
    expect(find(report, "providers")?.status).toBe("skipped");
  }, 120_000);
});

describe.skipIf(!hasRea)("runDoctor — against a live REA server", () => {
  it("passes the MCP check and reports catalog identity", async () => {
    const report = await runDoctor(liveConfig, { skipLlm: true });

    const mcp = find(report, "rea-mcp");
    expect(mcp?.status).toBe("ok");
    expect(mcp?.detail).toContain("6.8.0");
    expect(report.catalogSize).toBeGreaterThan(100);
    expect(report.serverVersion).toBeDefined();
  }, 120_000);

  it("reports provider availability from binary_session", async () => {
    const report = await runDoctor(liveConfig, { skipLlm: true });
    expect(report.providers).toBeDefined();
    expect(report.providers?.length).toBeGreaterThan(0);
    expect(find(report, "providers")?.status).toBeTypeOf("string");
  }, 120_000);

  it("agrees with the catalog the client itself discovers", async () => {
    const report = await runDoctor(liveConfig, { skipLlm: true });

    const client = new ReaClient(liveConfig.rea);
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(report.catalogSize).toBe(ToolCatalog.from(tools).size);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("keeps the report healthy when only the model is missing", async () => {
    const report = await runDoctor(liveConfig, {
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
    });
    // The REA half is healthy; the model half is the only failure.
    expect(find(report, "rea-mcp")?.status).toBe("ok");
    expect(find(report, "llm")?.status).toBe("fail");
    expect(report.healthy).toBe(false);
  }, 120_000);
});
