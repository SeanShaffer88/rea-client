import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end coverage for `vendor advisories`.
 *
 * The packaged CLI is exercised against a loopback advisory service. The
 * deliberately misleading part of the fixture is that the *hoisted* copy is
 * patched while a nested copy is vulnerable, because reporting only the hoisted
 * version is precisely the mistake this command exists to prevent.
 */

const CLI = resolve(__dirname, "../../dist/cli.js");
const REPO_ROOT = resolve(__dirname, "../..");
const HAS_DIST = await readFile(
  join(REPO_ROOT, "package.json"),
  "utf8",
).then(
  async () => {
    try {
      await readFile(CLI, "utf8");
      return true;
    } catch {
      return false;
    }
  },
  () => false,
);

if (process.env["CI"] === "true" && !HAS_DIST) {
  throw new Error(
    `dist/cli.js is missing at ${CLI}; the CI workflow must build before running integration tests.`,
  );
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, ...env }, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : 1;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

const ADVISORY_PAYLOAD = [
  {
    ghsa_id: "GHSA-mrhx-c7xc-m3w5",
    cve_id: "CVE-2023-54404",
    severity: "high",
    summary: "Zod can exhaust memory while validating oversized constrained collections",
    html_url: "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
    vulnerabilities: [
      {
        package: { name: "zod", ecosystem: "npm" },
        vulnerable_version_range: "< 4.6.6",
        first_patched_version: "4.6.6",
      },
    ],
  },
  {
    ghsa_id: "GHSA-m95q-7qp3-xv42",
    severity: "moderate",
    summary: "Zod denial of service vulnerability",
    vulnerabilities: [
      {
        package: { name: "zod", ecosystem: "npm" },
        vulnerable_version_range: "<= 3.22.2",
        first_patched_version: "3.22.3",
      },
    ],
  },
];

let server: Server;
let advisoryUrl = "";
let projectRoot = "";
let failing = false;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (failing) {
      response.writeHead(503).end("upstream unavailable");
      return;
    }
    if (!request.url?.startsWith("/advisories")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(ADVISORY_PAYLOAD));
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address() as AddressInfo;
  advisoryUrl = `http://127.0.0.1:${String(port)}/advisories`;

  projectRoot = await mkdtemp(join(tmpdir(), "rea-advisories-it-"));
  await writeFile(
    join(projectRoot, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "rea-agents": "6.8.0", zod: "^4.6.7" } },
        "node_modules/rea-agents": {
          version: "6.8.0",
          dependencies: { zod: "4.4.3" },
        },
        "node_modules/rea-agents/node_modules/zod": { version: "4.4.3" },
        "node_modules/zod": { version: "4.6.7" },
      },
    }),
    "utf8",
  );
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (projectRoot !== "") await rm(projectRoot, { recursive: true, force: true });
});

/** A config pointing at a server that is not there, so no tool surface loads. */
async function configWithoutRea(): Promise<string> {
  const path = join(projectRoot, "no-rea.json");
  await writeFile(
    path,
    JSON.stringify({
      rea: { command: process.execPath, args: ["-e", "process.exit(1)"], startupTimeoutMs: 5000 },
    }),
    "utf8",
  );
  return path;
}

async function offlineAdvisoryFile(): Promise<string> {
  const path = join(projectRoot, "zod.ghsa.json");
  await writeFile(path, JSON.stringify(ADVISORY_PAYLOAD), "utf8");
  return path;
}

describe.runIf(HAS_DIST)("vendor advisories", () => {
  it("finds the nested vulnerable copy and the hoisted patched one", async () => {
    const result = await runCli(
      ["vendor", "advisories", "zod", "--advisories", await offlineAdvisoryFile(), "--allow-undetermined"],
      projectRoot,
    );

    expect(result.stdout).toContain("4.4.3  node_modules/rea-agents/node_modules/zod");
    expect(result.stdout).toContain("4.6.7  node_modules/zod");
  });

  it("blocks on an undetermined high-severity finding by default", async () => {
    const result = await runCli(
      [
        "vendor",
        "advisories",
        "zod",
        "--advisories",
        await offlineAdvisoryFile(),
        "--config",
        await configWithoutRea(),
      ],
      projectRoot,
    );

    // Without a reachable tool surface the precondition cannot be checked, and
    // "could not check" must not pass a security gate.
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("UNDETERMINED  GHSA-mrhx-c7xc-m3w5");
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).toContain("note: could not enumerate the REA tool surface");
    expect(result.stdout).toContain("--allow-undetermined");
  });

  it("passes when undetermined findings are explicitly allowed", async () => {
    const result = await runCli(
      [
        "vendor",
        "advisories",
        "zod",
        "--advisories",
        await offlineAdvisoryFile(),
        "--config",
        await configWithoutRea(),
        "--allow-undetermined",
      ],
      projectRoot,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OK  no reachable advisory at or above "high"');
  });

  it("reports the advisory no installed copy is affected by as not-reachable", async () => {
    const result = await runCli(
      ["vendor", "advisories", "zod", "--advisories", await offlineAdvisoryFile(), "--allow-undetermined"],
      projectRoot,
    );

    expect(result.stdout).toContain("NOT-REACHABLE  GHSA-m95q-7qp3-xv42");
    expect(result.stdout).toContain("affected: no installed copy");
  });

  it("queries the advisory service when no offline file is given", async () => {
    const file = join(projectRoot, "service.json");
    await writeFile(
      file,
      JSON.stringify({ rea: { command: process.execPath, args: ["-e", "process.exit(1)"], startupTimeoutMs: 5000 } }),
      "utf8",
    );
    const result = await runCli(
      ["vendor", "advisories", "zod", "--config", file, "--allow-undetermined"],
      projectRoot,
      { REA_ADVISORY_API: advisoryUrl },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("GHSA-mrhx-c7xc-m3w5");
    expect(result.stdout).toContain("UNDETERMINED");
  });

  it("fails closed when the advisory lookup cannot complete", async () => {
    // Port 1 on loopback refuses connections, so this is a real transport
    // failure rather than a stub: no network answer must never read as clean.
    const result = await runCli(
      ["vendor", "advisories", "zod", "--config", await configWithoutRea()],
      projectRoot,
      { REA_ADVISORY_API: "http://127.0.0.1:1/advisories" },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Could not assess advisories");
    expect(result.stderr).toContain("--advisories");
    expect(result.stdout).not.toContain("OK");
  });

  it("fails when the advisory service returns an error status", async () => {
    failing = true;
    try {
      const result = await runCli(
        ["vendor", "advisories", "zod", "--config", await configWithoutRea()],
        projectRoot,
      );
      expect(result.code).toBe(1);
    } finally {
      failing = false;
    }
  });

  it("emits machine-readable JSON with --json", async () => {
    const result = await runCli(
      [
        "vendor",
        "advisories",
        "zod",
        "--advisories",
        await offlineAdvisoryFile(),
        "--config",
        await configWithoutRea(),
        "--json",
        "--allow-undetermined",
      ],
      projectRoot,
    );

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      package: string;
      copies: { path: string; version: string }[];
      reachable: unknown[];
    };
    expect(report.package).toBe("zod");
    expect(report.copies.map((copy) => copy.version)).toEqual(["4.4.3", "4.6.7"]);
    expect(report.reachable).toEqual([]);
  });

  it("exits 2 on an invalid severity", async () => {
    const result = await runCli(["vendor", "advisories", "zod", "--deny", "urgent"], projectRoot);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--deny must be one of");
  });

  it("exits 2 on a malformed accepted-findings file", async () => {
    const path = join(projectRoot, "bad-accept.json");
    await writeFile(path, JSON.stringify([{ id: "X", package: "zod" }]), "utf8");
    const result = await runCli(
      ["vendor", "advisories", "zod", "--advisories", await offlineAdvisoryFile(), "--accept", path],
      projectRoot,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("rationale");
  });

  it("unblocks an accepted finding and prints its mitigation", async () => {
    const path = join(projectRoot, "accept.json");
    await writeFile(
      path,
      JSON.stringify({
        accepted: [
          {
            id: "GHSA-mrhx-c7xc-m3w5",
            package: "zod",
            rationale: "pinned upstream by rea-agents",
            mitigation: "argument guard bounds every outbound array",
            reviewedAt: "2026-10-27",
          },
        ],
      }),
      "utf8",
    );

    const result = await runCli(
      [
        "vendor",
        "advisories",
        "zod",
        "--advisories",
        await offlineAdvisoryFile(),
        "--config",
        await configWithoutRea(),
        "--accept",
        path,
      ],
      projectRoot,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ACCEPTED  GHSA-mrhx-c7xc-m3w5");
    expect(result.stdout).toContain("argument guard bounds every outbound array");
  });

  it("still blocks a reachable finding with no acceptance on record", async () => {
    const path = join(projectRoot, "accept-other.json");
    await writeFile(
      path,
      JSON.stringify({
        accepted: [
          {
            id: "GHSA-other",
            package: "zod",
            rationale: "r",
            mitigation: "m",
            reviewedAt: "2026-10-27",
          },
        ],
      }),
      "utf8",
    );

    const result = await runCli(
      [
        "vendor",
        "advisories",
        "zod",
        "--advisories",
        await offlineAdvisoryFile(),
        "--config",
        await configWithoutRea(),
        "--accept",
        path,
      ],
      projectRoot,
    );

    expect(result.code).toBe(1);
  });
});
