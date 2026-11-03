import { describe, expect, it } from "vitest";
import {
  caseLocation,
  caseNameConflict,
  caseNameProblem,
  defaultCaseName,
  caseTotalBytes,
  describeCaseFiles,
  describeCaseSave,
  describeSavedCase,
} from "../../desktop/ui/cases.js";
import type { CaseSnapshot, SavedCase } from "../../src/desktop/protocol.js";

const SAVED: SavedCase = {
  name: "ls-triage",
  directory: "/home/analyst/work/cases/ls-triage",
  savedAt: "2026-11-02T12:00:00.000Z",
  files: [
    { name: "analysis.json", bytes: 1200 },
    { name: "analysis.md", bytes: 900 },
    { name: "evidence-bundle.json", bytes: 8117 },
  ],
};

describe("case folder helpers", () => {
  it("sums the bytes the bridge reported", () => {
    expect(caseTotalBytes(SAVED)).toBe(10_217);
    expect(caseTotalBytes({ files: [] })).toBe(0);
    expect(caseTotalBytes({ files: [{ name: "a", bytes: Number.NaN }] })).toBe(0);
  });

  it("names the files that exist rather than assuming a fixed set", () => {
    expect(describeCaseFiles(SAVED)).toBe("analysis.json · analysis.md · evidence-bundle.json");
    // A case saved while the engine was offline has no bundle.
    expect(describeCaseFiles({ files: [{ name: "analysis.md", bytes: 1 }] })).toBe("analysis.md");
    expect(describeCaseFiles({ files: [] })).toBe("No files");
  });

  it("describes a saved case with its time and contents", () => {
    const described = describeSavedCase(SAVED, "/home/analyst/work");
    expect(described).toContain("evidence-bundle.json");
    expect(described).toContain(new Date(SAVED.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
    expect(describeSavedCase({ ...SAVED, savedAt: "" }, "/home/analyst/work")).toContain("Unknown time");
  });

  it("shows where a case lives relative to the workspace", () => {
    expect(caseLocation(SAVED, "/home/analyst/work")).toBe("work/cases/ls-triage");
    expect(caseLocation({ directory: "/elsewhere/case" }, "/home/analyst/work")).toBe("/elsewhere/case");
    expect(caseLocation({}, "/home/analyst/work")).toBe("");
  });

  it("summarises a save, including whether the bundle came with it", () => {
    const withBundle: CaseSnapshot = {
      ok: true,
      name: "ls-triage",
      directory: "/home/analyst/work/cases/ls-triage",
      files: SAVED.files,
      evidence: { ok: true, bytes: 8117, records: 2, unknowns: 0 },
    };
    expect(describeCaseSave(withBundle, "/home/analyst/work")).toBe(
      "Case saved · 3 files · canonical bundle included → work/cases/ls-triage",
    );
    expect(
      describeCaseSave({ ...withBundle, files: [{ name: "analysis.md", bytes: 1 }], evidence: { ok: false, error: "offline" } }, "/home/analyst/work"),
    ).toBe("Case saved · 1 file → work/cases/ls-triage");
  });

  it("recognises a name conflict but not other failures", () => {
    expect(caseNameConflict('A case named "ls-triage" already exists. Choose another name or allow overwrite.')).toBe(true);
    expect(caseNameConflict("The engine is not connected.")).toBe(false);
    expect(caseNameConflict(undefined)).toBe(false);
  });
});

describe("case naming", () => {
  it("suggests a recognisable name from the target and the date", () => {
    const now = new Date("2026-11-02T12:00:00.000Z");
    expect(defaultCaseName("/usr/bin/ls", now)).toBe("ls-2026-11-02");
    expect(defaultCaseName("C:\\Samples\\My App!.exe", now)).toBe("my-app-2026-11-02");
    expect(defaultCaseName(undefined, now)).toBe("case-2026-11-02");
    // Long paths are trimmed, never left with a trailing separator-like dash.
    const long = defaultCaseName(`/tmp/${"a".repeat(80)}.bin`, now);
    expect(long).toBe(`${"a".repeat(48)}-2026-11-02`);
    // The result still satisfies the bridge's rule, whatever the path length.
    expect(caseNameProblem(long)).toBeNull();
  });

  it("explains a name the bridge would reject, before it is sent", () => {
    expect(caseNameProblem("ls-triage")).toBeNull();
    expect(caseNameProblem(" Case_1.v2 ")).toBeNull();
    expect(caseNameProblem("")).toBe("Give the case a name.");
    expect(caseNameProblem("   ")).toBe("Give the case a name.");
    expect(caseNameProblem("-leading")).toBe("Start with a letter or digit.");
    expect(caseNameProblem("../escape")).toBe("Start with a letter or digit.");
    expect(caseNameProblem("has space")).toBe("Use only letters, digits, dots, dashes, or underscores.");
    expect(caseNameProblem("a..b")).toBe("A name cannot contain ..");
    expect(caseNameProblem("x".repeat(81))).toBe("Keep the name to 80 characters or fewer.");
  });
});
