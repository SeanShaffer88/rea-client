/**
 * Case and evidence commands, run against the real CLI binary.
 *
 * These are the headless half of the desktop case workflow: a case saved by the
 * app must open from the terminal and vice versa. The exit codes matter as much
 * as the output, because `case save` is the kind of command people put in a
 * script after an analysis run.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli.js");
const REA_ENTRY = resolve("node_modules/rea-agents/scripts/rea.mjs");
const hasBuild = existsSync(CLI);
const hasRea = existsSync(REA_ENTRY);

if (!hasBuild && process.env["CI"] === "true") {
  throw new Error(`${CLI} does not exist; build before running the CLI integration tests.`);
}

const REPORT_MD = "# Analysis: /bin/ls\n\nNo packer detected.\n";
const REPORT_JSON = JSON.stringify(
  {
    schemaVersion: 1,
    exportedAt: "2026-11-02T00:00:00.000Z",
    engineVersion: "6.8.0",
    scope: "binary-core",
    target: { name: "ls", path: "/bin/ls", format: "elf", architecture: "x86_64" },
    turns: [{ question: "What is this?", observations: [{ evidenceId: "e1" }] }],
  },
  null,
  2,
);

let root = "";
let workspaceDir = "";
let configPath = "";
let reportPath = "";
let reportJsonPath = "";

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: readonly string[], stdin?: string): Promise<Run> {
  return new Promise((resolveRun) => {
    const child = execFile(
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
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rea-cli-cases-"));
  workspaceDir = join(root, "workspace");
  configPath = join(root, "config.json");
  reportPath = join(root, "report.md");
  reportJsonPath = join(root, "report.json");
  writeFileSync(reportPath, REPORT_MD, "utf8");
  writeFileSync(reportJsonPath, REPORT_JSON, "utf8");
  writeFileSync(
    configPath,
    JSON.stringify({
      rea: { command: process.execPath, args: [REA_ENTRY, "mcp"] },
      workspaceDir,
    }),
    "utf8",
  );
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

/** Every invocation passes the workspace explicitly, so nothing depends on cwd. */
const inWorkspace = (args: readonly string[]): string[] => [
  "--config",
  configPath,
  "--workspace",
  workspaceDir,
  ...args,
];

describe.skipIf(!hasBuild)("rea-client case", () => {
  it("lists an empty workspace without failing", async () => {
    const result = await run(inWorkspace(["case", "list"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(join(workspaceDir, "cases"));
    expect(result.stdout).toContain("No saved cases");
  });

  it("saves a case from files and reports what it wrote", async () => {
    const result = await run(
      inWorkspace([
        "case",
        "save",
        "ls-triage",
        "--report",
        reportPath,
        "--json-report",
        reportJsonPath,
      ]),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Saved case "ls-triage"');
    expect(result.stdout).toContain("analysis.md");
    expect(readFileSync(join(workspaceDir, "cases", "ls-triage", "analysis.md"), "utf8")).toBe(REPORT_MD);
  });

  it("shows the report and the parsed summary", async () => {
    const result = await run(inWorkspace(["case", "show", "ls-triage"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Case: ls-triage");
    expect(result.stdout).toContain("ls (elf, x86_64) — 1 turn(s), 1 observation(s)");
    expect(result.stdout).toContain("No packer detected.");
  });

  it("writes the stored report out with --report", async () => {
    const target = join(root, "shown.md");
    const result = await run(inWorkspace(["case", "show", "ls-triage", "--report", target]));
    expect(result.code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(REPORT_MD);
  });

  it("refuses to overwrite a case unless asked", async () => {
    const refused = await run(
      inWorkspace(["case", "save", "ls-triage", "--report", reportPath, "--json-report", reportJsonPath]),
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("already exists");

    const replaced = await run(
      inWorkspace([
        "case",
        "save",
        "ls-triage",
        "--report",
        reportPath,
        "--json-report",
        reportJsonPath,
        "--overwrite",
      ]),
    );
    expect(replaced.code).toBe(0);
  });

  it("reads the companion from stdin", async () => {
    const result = await run(
      inWorkspace(["case", "save", "from-stdin", "--report", "-", "--json-report", reportJsonPath]),
      REPORT_MD,
    );
    expect(result.code).toBe(0);
    expect(readFileSync(join(workspaceDir, "cases", "from-stdin", "analysis.md"), "utf8")).toBe(REPORT_MD);
  });

  it("refuses a companion that is not JSON, and a traversal name", async () => {
    const notJson = join(root, "bad.json");
    writeFileSync(notJson, "not json", "utf8");
    const bad = await run(
      inWorkspace(["case", "save", "bad-case", "--report", reportPath, "--json-report", notJson]),
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("not valid JSON");

    const traversal = await run(inWorkspace(["case", "show", "../escape"]));
    expect(traversal.code).toBe(2);

    const missing = await run(inWorkspace(["case", "show", "no-such-case"]));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("No saved case");
  });

  it("emits machine-readable listings and deletes a case", async () => {
    const listed = await run(inWorkspace(["case", "list", "--json"]));
    expect(listed.code).toBe(0);
    const parsed = JSON.parse(listed.stdout) as {
      ok: boolean;
      total: number;
      casesRoot: string;
      cases: { name: string; summary?: { turns: number } }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.casesRoot).toBe(join(workspaceDir, "cases"));
    expect(parsed.total).toBe(2);
    expect(parsed.cases.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["ls-triage", "from-stdin"]),
    );

    const removed = await run(inWorkspace(["case", "delete", "from-stdin", "--json"]));
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ ok: true, name: "from-stdin" });

    const again = await run(inWorkspace(["case", "delete", "from-stdin"]));
    expect(again.code).toBe(1);
  });

  it("rejects an unknown subcommand with usage on stderr", async () => {
    const result = await run(inWorkspace(["case", "explode"]));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown case subcommand");
  });
});

describe.skipIf(!hasBuild || !hasRea)("rea-client evidence export", () => {
  it("writes REA's bundle into a saved case", async () => {
    const bundle = join(workspaceDir, "cases", "ls-triage", "evidence-bundle.json");
    const result = await run(inWorkspace(["evidence", "export", "ls-triage"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("evidence record(s)");
    expect(result.stdout).toContain(bundle);

    // The bundle is REA's document, not ours: it must still parse as JSON here.
    const parsed = JSON.parse(readFileSync(bundle, "utf8")) as { records?: unknown[] };
    expect(Array.isArray(parsed.records)).toBe(true);

    // The case now reports the bundle alongside its own files.
    const shown = await run(inWorkspace(["case", "show", "ls-triage", "--json"]));
    expect(shown.code).toBe(0);
    const opened = JSON.parse(shown.stdout) as { files: { name: string }[]; bundle?: { bytes: number } };
    expect(opened.bundle?.bytes).toBeGreaterThan(0);
    expect(opened.files.map((file) => file.name)).toContain("evidence-bundle.json");
  }, 90_000);

  it("refuses a destination outside the workspace", async () => {
    const result = await run(
      inWorkspace(["evidence", "export", "--out", join(root, "escaped.json")]),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("must stay inside the workspace");
    expect(existsSync(join(root, "escaped.json"))).toBe(false);
  });
});
