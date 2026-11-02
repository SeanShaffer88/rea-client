import { describe, expect, it } from "vitest";
import {
  readEvidenceSummary,
  readExportedBundle,
  selectEvidenceRecord,
} from "../../src/mcp/evidenceBundle.js";

const ID = `ev_${"ab".repeat(32)}`;

describe("retained evidence readers", () => {
  it("reads the summary envelope without copying full records", () => {
    const summary = readEvidenceSummary({
      structuredContent: {
        result: {
          kind: "evidence-bundle-summary",
          total_retained_records: 3,
          matching_records: 2,
          unknown_revisions: 1,
          records: [
            {
              evidence_id: ID,
              subject: { name: "/usr/bin/ls", digest: { sha256: "aa".repeat(32) }, format: "elf" },
              provider: { id: "rea-binary", version: "6.8.0" },
              operation: "inspect_artifact",
              confidence: "high",
              authority: "observed",
              retention: "session",
              limitation_count: 2,
              native_dossier: { available: true },
            },
            { evidence_id: `ev_${"cd".repeat(32)}` },
            { evidence_id: "not-an-id" },
          ],
        },
      },
    });

    expect(summary).toEqual({
      totalRetained: 3,
      matching: 2,
      unknownRevisions: 1,
      records: [
        {
          evidenceId: ID,
          subjectName: "/usr/bin/ls",
          subjectSha256: "aa".repeat(32),
          subjectFormat: "elf",
          providerId: "rea-binary",
          operation: "inspect_artifact",
          confidence: "high",
          authority: "observed",
          retention: "session",
          limitationCount: 2,
        },
        { evidenceId: `ev_${"cd".repeat(32)}` },
      ],
    });
  });

  it("falls back to a JSON text body and rejects payloads it cannot read", () => {
    const fromText = readEvidenceSummary({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            result: {
              total_retained_records: 1,
              matching_records: 1,
              unknown_revisions: 0,
              records: [{ evidence_id: ID, operation: "xrefs" }],
            },
          }),
        },
      ],
    });
    expect(fromText?.records).toEqual([{ evidenceId: ID, operation: "xrefs" }]);

    expect(readEvidenceSummary({ content: [{ type: "text", text: "no evidence" }] })).toBeUndefined();
    expect(readEvidenceSummary({ content: [{ type: "text", text: "{broken" }] })).toBeUndefined();
    expect(readEvidenceSummary({ structuredContent: { result: { kind: "other" } } })).toBeUndefined();
  });

  it("counts what the bundle reported instead of guessing when totals are absent", () => {
    const summary = readEvidenceSummary({
      structuredContent: { records: [{ evidence_id: ID }, { evidence_id: `ev_${"ef".repeat(32)}` }] },
    });
    expect(summary).toMatchObject({ totalRetained: 2, matching: 2, unknownRevisions: 0 });
  });

  it("selects only the requested record from a complete bundle", () => {
    const result = {
      structuredContent: {
        result: {
          records: [
            { evidence_id: `ev_${"11".repeat(32)}`, operation: "other" },
            { evidence_id: ID, operation: "inspect_artifact" },
          ],
        },
      },
    };
    expect(selectEvidenceRecord(result, ID)).toMatchObject({ evidence_id: ID, operation: "inspect_artifact" });
    // A server that ignores the filter must not make us display another record.
    expect(selectEvidenceRecord(result, `ev_${"22".repeat(32)}`)).toBeUndefined();
    expect(selectEvidenceRecord({ content: [{ type: "text", text: "nope" }] }, ID)).toBeUndefined();
  });

  it("reads an export result", () => {
    expect(
      readExportedBundle({
        structuredContent: { result: { path: "/w/evidence/bundle.json", bytes: 8117, records: 2, unknowns: 0 } },
      }),
    ).toEqual({ path: "/w/evidence/bundle.json", bytes: 8117, records: 2, unknowns: 0 });

    expect(readExportedBundle({ structuredContent: { result: { bytes: 1 } } })).toBeUndefined();
    expect(readExportedBundle({ content: [{ type: "text", text: "denied" }] })).toBeUndefined();
  });
});
