import { describe, expect, it } from "vitest";
import {
  describeEvidenceExport,
  describeRetainedCounts,
  evidenceExportConflict,
  filterRetainedRecords,
  relativeToWorkspace,
  shortEvidenceId,
} from "../../desktop/ui/evidence.js";
import type { EvidenceInventorySnapshot, RetainedEvidenceSummary } from "../../src/desktop/protocol.js";

const RECORDS: RetainedEvidenceSummary[] = [
  {
    evidenceId: `ev_${"4e8c8fb7".repeat(8)}`,
    operation: "inspect_artifact",
    subjectName: "/usr/bin/ls",
    providerId: "rea-binary",
    confidence: "high",
    authority: "observed",
  },
  { evidenceId: `ev_${"1f".repeat(32)}`, operation: "xrefs", subjectName: "ntdll.dll" },
];

const INVENTORY: EvidenceInventorySnapshot = {
  ok: true,
  totalRetained: 2,
  matching: 2,
  unknownRevisions: 0,
  records: RECORDS,
};

describe("retained evidence display helpers", () => {
  it("shortens ids without hiding which record they are", () => {
    expect(shortEvidenceId(RECORDS[0]!.evidenceId)).toBe("ev_4e8c8fb7…");
    expect(shortEvidenceId("ev_abc")).toBe("ev_abc");
    expect(shortEvidenceId("opaque-id-value")).toBe("opaque-id-va…");
  });

  it("filters by id, operation, subject, provider, or confidence", () => {
    expect(filterRetainedRecords(RECORDS, "").length).toBe(2);
    expect(filterRetainedRecords(RECORDS, "  ").length).toBe(2);
    expect(filterRetainedRecords(RECORDS, "xrefs").map((record) => record.operation)).toEqual(["xrefs"]);
    expect(filterRetainedRecords(RECORDS, "REA-BINARY").length).toBe(1);
    expect(filterRetainedRecords(RECORDS, "4e8c").length).toBe(1);
    expect(filterRetainedRecords(RECORDS, "nothing here")).toEqual([]);
  });

  it("reports the bundle's own counts, including unknown revisions", () => {
    expect(describeRetainedCounts(INVENTORY)).toBe("2 retained records · 0 unknown revisions");
    expect(describeRetainedCounts({ ...INVENTORY, totalRetained: 5, matching: 2 })).toBe(
      "2 of 5 retained records · 0 unknown revisions",
    );
    expect(describeRetainedCounts({ ...INVENTORY, totalRetained: 1, matching: 1, records: [RECORDS[0]!], unknownRevisions: 1 })).toBe(
      "1 retained record · 1 unknown revision",
    );
  });

  it("describes an export with its size, counts, and workspace-relative path", () => {
    const message = describeEvidenceExport(
      { ok: true, path: "/home/analyst/work/evidence/bundle.json", bytes: 8117, records: 2, unknowns: 0 },
      "/home/analyst/work",
    );
    expect(message).toBe("Evidence bundle exported · 8117 bytes · 2 records · 0 unknowns → work/evidence/bundle.json");
    expect(
      describeEvidenceExport({ ok: true, path: "C:\\work\\evidence\\b.json", bytes: 12, records: 1, unknowns: 0 }, "C:\\work"),
    ).toContain("→ work/evidence/b.json");
    expect(describeEvidenceExport({ ok: true, path: "/elsewhere/b.json" }, "/home/analyst/work")).toContain(
      "→ /elsewhere/b.json",
    );
    expect(relativeToWorkspace("/home/analyst/work", "/home/analyst/work")).toBe(".");
    expect(relativeToWorkspace("", "/home/analyst/work")).toBe("");
  });

  it("recognises an export that stopped because the file already exists", () => {
    expect(evidenceExportConflict("EEXIST: file already exists, open '/w/evidence/b.json'")).toBe(true);
    expect(evidenceExportConflict("refusing to overwrite an existing bundle")).toBe(true);
    expect(evidenceExportConflict("the engine is not connected")).toBe(false);
  });
});
