/**
 * The case store is the shared implementation behind `case.*` in the desktop
 * bridge and `rea-client case` in the CLI. Its rules are what keep a saved case
 * inside the workspace and readable by whichever front end opens it next, so
 * they are asserted directly rather than only through one of the two callers.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CaseStoreError,
  casesRoot,
  deleteCase,
  isValidCaseName,
  listCases,
  normalizeCaseName,
  openCase,
  saveCase,
} from "../../src/cases/store.js";

const REPORT_JSON = JSON.stringify({
  schemaVersion: 1,
  target: { name: "ls", format: "elf", architecture: "x86_64" },
  turns: [{ observations: [{ evidenceId: "e1" }, {}] }],
});

const roots: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rea-casestore-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("case names", () => {
  it("accepts ordinary stems and strips a report extension", () => {
    expect(normalizeCaseName("ls-triage", "")).toBe("ls-triage");
    expect(normalizeCaseName("ls.json", "")).toBe("ls");
    expect(normalizeCaseName("  spaced_name.1  ", "")).toBe("spaced_name.1");
  });

  it("refuses traversal, separators, and empty names", () => {
    for (const bad of ["../escape", "a/b", "a\\b", "", "..", ".hidden", "-lead", "x".repeat(81)]) {
      expect(() => normalizeCaseName(bad, "")).toThrow(CaseStoreError);
      expect(isValidCaseName(bad)).toBe(false);
    }
  });

  it("refuses a non-string name instead of coercing it", () => {
    expect(() => normalizeCaseName(42, "")).toThrow(/"name" must be a string/);
  });
});

describe("saving and reading cases", () => {
  it("writes both documents and reports their sizes", async () => {
    const root = await workspace();
    const saved = await saveCase({
      workspaceDir: root,
      name: "ls-triage",
      markdown: "# report\n",
      json: REPORT_JSON,
    });

    expect(saved.ok).toBe(true);
    expect(saved.files).toEqual([
      { name: "analysis.md", bytes: 9 },
      { name: "analysis.json", bytes: Buffer.byteLength(REPORT_JSON) },
    ]);
    await expect(readFile(join(saved.directory, "analysis.md"), "utf8")).resolves.toBe("# report\n");
  });

  it("refuses to replace an existing case unless overwrite is set", async () => {
    const root = await workspace();
    await saveCase({ workspaceDir: root, name: "dup", markdown: "one", json: REPORT_JSON });

    const refused = await saveCase({ workspaceDir: root, name: "dup", markdown: "two", json: REPORT_JSON });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("already exists");
    await expect(readFile(join(refused.directory, "analysis.md"), "utf8")).resolves.toBe("one");

    const replaced = await saveCase({
      workspaceDir: root,
      name: "dup",
      markdown: "two",
      json: REPORT_JSON,
      overwrite: true,
    });
    expect(replaced.ok).toBe(true);
    await expect(readFile(join(replaced.directory, "analysis.md"), "utf8")).resolves.toBe("two");
  });

  it("rejects empty documents", async () => {
    const root = await workspace();
    await expect(
      saveCase({ workspaceDir: root, name: "empty", markdown: "  ", json: REPORT_JSON }),
    ).rejects.toThrow(/"report" must be a non-empty string/);
  });

  it("reads a case back with a summary and bundle counts", async () => {
    const root = await workspace();
    const saved = await saveCase({
      workspaceDir: root,
      name: "ls-triage",
      markdown: "# report\n",
      json: REPORT_JSON,
    });
    await writeFile(join(saved.directory, "evidence-bundle.json"), '{"records":[{},{}],"unknowns":[{}]}', "utf8");

    const opened = await openCase(root, "ls-triage");
    expect(opened.ok).toBe(true);
    expect(opened.report).toBe("# report\n");
    expect(opened.summary).toMatchObject({ turns: 1, observations: 2, evidenceReferences: 1 });
    expect(opened.bundle).toMatchObject({ records: 2, unknowns: 1 });
    expect(opened.files.map((file) => file.name)).toContain("evidence-bundle.json");
  });

  it("reports an unparseable companion instead of an empty analysis", async () => {
    const root = await workspace();
    const saved = await saveCase({ workspaceDir: root, name: "broken", markdown: "# x", json: REPORT_JSON });
    await writeFile(join(saved.directory, "analysis.json"), "{not json", "utf8");

    const opened = await openCase(root, "broken");
    expect(opened.ok).toBe(false);
    expect(opened.error).toContain("not valid JSON");
  });

  it("lists newest first and ignores folders that are not cases", async () => {
    const root = await workspace();
    await saveCase({ workspaceDir: root, name: "older", markdown: "# a", json: REPORT_JSON });
    await saveCase({ workspaceDir: root, name: "newer", markdown: "# b", json: REPORT_JSON });
    await mkdir(join(casesRoot(root), "markdown-only"), { recursive: true });
    await writeFile(join(casesRoot(root), "markdown-only", "analysis.md"), "# orphan", "utf8");
    await writeFile(join(casesRoot(root), "loose-file.md"), "# not a folder", "utf8");

    const listed = await listCases(root);
    expect(listed.total).toBe(2);
    expect(listed.cases.map((entry) => entry.name).sort()).toEqual(["newer", "older"]);
    expect(listed.cases[0]?.summary).toMatchObject({ turns: 1, observations: 2 });
  });

  it("caps the returned entries without hiding the total", async () => {
    const root = await workspace();
    for (const name of ["a", "b", "c"]) {
      await saveCase({ workspaceDir: root, name, markdown: "# x", json: REPORT_JSON });
    }
    const listed = await listCases(root, 2);
    expect(listed.cases).toHaveLength(2);
    expect(listed.total).toBe(3);
  });
});

describe("deleting cases", () => {
  it("removes a case folder and nothing else", async () => {
    const root = await workspace();
    const saved = await saveCase({ workspaceDir: root, name: "gone", markdown: "# x", json: REPORT_JSON });

    const removed = await deleteCase(root, "gone");
    expect(removed).toMatchObject({ ok: true, name: "gone", directory: saved.directory });
    expect((await listCases(root)).total).toBe(0);
  });

  it("refuses a name outside the cases root", async () => {
    const root = await workspace();
    await mkdir(join(root, "cases"), { recursive: true });
    const removed = await deleteCase(root, "../cases");
    expect(removed.ok).toBe(false);
    expect(removed.error).toContain("No saved case");
    expect((await listCases(root)).total).toBe(0);
  });

  it("reports a missing case as an answer, not a crash", async () => {
    const root = await workspace();
    const removed = await deleteCase(root, "never-existed");
    expect(removed).toEqual({
      ok: false,
      name: "never-existed",
      error: 'No saved case named "never-existed" in this workspace.',
    });
  });
});
