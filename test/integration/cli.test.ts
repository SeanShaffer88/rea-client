/**
 * CLI tests, run as a real subprocess.
 *
 * The CLI is the only executable surface of the engine, so its exit codes and
 * stream separation are a contract (CI scripts and the desktop shell's process
 * supervisor both depend on them). Testing the exported functions would not
 * cover argument parsing, exit codes, or stdout/stderr routing.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli.js");
const REA_ENTRY = resolve("node_modules/rea-agents/scripts/rea.mjs");
const hasBuild = existsSync(CLI);
const hasRea = existsSync(REA_ENTRY);

// Without dist/ every CLI test skips, which in CI would silently drop the only
// coverage of argument parsing, exit codes, and stream separation.
if (!hasBuild && process.env["CI"] === "true") {
  throw new Error(
    `${CLI} does not exist, so CLI coverage would silently disappear. Build before ` +
      `testing in CI (npm run build then npm run test:all).`,
  );
}

let configDir = "";
let configPath = "";

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: readonly string[]): Promise<Run> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : 1;
        resolveRun({ code, stdout, stderr });
      },
    );
  });
}

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "rea-cli-"));
  configPath = join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      rea: { command: process.execPath, args: [REA_ENTRY, "mcp"] },
      workspaceDir: join(configDir, "workspace"),
    }),
    "utf8",
  );
});

afterAll(() => {
  if (configDir !== "") rmSync(configDir, { recursive: true, force: true });
});

describe.skipIf(!hasBuild)("rea-client CLI", () => {
  it("prints usage and exits 0 for --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("rea-client");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("probe");
  });

  it("prints usage and exits 2 when no command is given", async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Usage:");
  });

  it("exits 2 on an unknown command", async () => {
    const result = await run(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown command");
  });

  it("rejects relative target paths in probe, before contacting the server", async () => {
    const result = await run(["probe", "samples/app.exe", "--config", configPath]);
    // Exit 2 is the "bad input" contract, distinct from a failed analysis.
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/absolute/i);
  });

  it("requires a question for ask", async () => {
    const result = await run(["ask", "--config", configPath]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("requires a question");
  });

  describe.skipIf(!hasRea)("with a live REA server", () => {
    it("doctor --json emits a machine-readable report", async () => {
      const result = await run(["doctor", "--json", "--no-llm", "--config", configPath]);
      expect(result.code).toBe(0);

      const report = JSON.parse(result.stdout) as {
        healthy: boolean;
        checks: Array<{ id: string; status: string }>;
        catalogSize?: number;
      };
      expect(report.healthy).toBe(true);
      expect(report.checks.map((check) => check.id)).toEqual(
        expect.arrayContaining(["node-version", "network-policy", "workspace", "rea-mcp", "providers"]),
      );
      expect(report.catalogSize).toBeGreaterThan(100);
    });

    it("doctor --json --no-llm does not touch the model endpoint", async () => {
      const result = await run(["doctor", "--json", "--no-llm", "--config", configPath]);
      const report = JSON.parse(result.stdout) as { checks: Array<{ id: string; status: string }> };
      const llm = report.checks.find((check) => check.id === "llm");
      expect(llm?.status).toBe("skipped");
    });

    it("doctor reports the model endpoint as failed without failing the process", async () => {
      const result = await run(["doctor", "--json", "--config", configPath]);
      const report = JSON.parse(result.stdout) as {
        healthy: boolean;
        checks: Array<{ id: string; status: string; remediation?: string }>;
      };
      const llm = report.checks.find((check) => check.id === "llm");
      expect(llm?.status).toBe("fail");
      expect(llm?.remediation).toContain("llama-server");
      // A missing inference server is a real failure, so the exit code is 1.
      expect(report.healthy).toBe(false);
      expect(result.code).toBe(1);
    });

    it("tools --json reports families and the resolved scope", async () => {
      const result = await run(["tools", "--json", "--config", configPath]);
      expect(result.code).toBe(0);

      const parsed = JSON.parse(result.stdout) as {
        total: number;
        families: Array<{ id: string; count: number }>;
        scope: { name: string; count: number; missing: string[] };
      };
      expect(parsed.total).toBeGreaterThan(100);
      expect(parsed.families.length).toBeGreaterThan(5);
      expect(parsed.scope.name).toBe("binary-core");
      expect(parsed.scope.count).toBeGreaterThan(15);
      expect(parsed.scope.missing).toEqual([]);
    });

    it("tools --family filters to one family", async () => {
      const result = await run(["tools", "--json", "--family", "pe", "--config", configPath]);
      const parsed = JSON.parse(result.stdout) as {
        families: Array<{ id: string; tools?: string[] }>;
      };
      const pe = parsed.families.find((family) => family.id === "pe");
      expect(pe?.tools).toBeDefined();
      expect(pe?.tools).toContain("inspect_pe_imports");
    });

    it("probe opens a real binary and reports identity", async () => {
      const result = await run(["probe", "/usr/bin/ls", "--config", configPath]);
      expect(result.stdout).toContain("Format: elf");
      expect(result.stdout).toContain("Arch: x86_64");
      // The engine marks target-derived content as untrusted.
      expect(result.stdout).toContain("UNTRUSTED DATA");
    }, 120_000);
  });
});
