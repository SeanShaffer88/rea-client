import { describe, expect, it } from "vitest";
import { readBundleCounts, readCaseSummary } from "../../src/desktop/cases.js";

const REPORT = {
  schemaVersion: 1,
  exportedAt: "2026-11-02T12:00:00.000Z",
  engineVersion: "6.8.0",
  target: {
    name: "ls",
    path: "/usr/bin/ls",
    format: "elf",
    architecture: "x86_64",
    sha256: "cb30d69b24245bf2ecdc9e7f53bbad19",
    open: true,
  },
  scope: "binary-core",
  overview: null,
  turns: [
    {
      question: "What is this?",
      answer: "An ELF binary.",
      askedAt: "2026-11-02T12:00:01.000Z",
      observations: [
        { tool: "binary_overview", ok: true, evidenceId: `ev_${"ab".repeat(32)}`, preview: "…" },
        { tool: "xrefs", ok: false, preview: "…" },
      ],
    },
    { question: "Anything else?", answer: "No.", askedAt: "2026-11-02T12:01:00.000Z", observations: [] },
  ],
};

describe("saved case readers", () => {
  it("summarises a report without re-deriving its content", () => {
    const summary = readCaseSummary(JSON.stringify(REPORT));
    expect(summary).toEqual({
      schemaVersion: 1,
      exportedAt: "2026-11-02T12:00:00.000Z",
      engineVersion: "6.8.0",
      scope: "binary-core",
      target: {
        name: "ls",
        path: "/usr/bin/ls",
        format: "elf",
        architecture: "x86_64",
        sha256: "cb30d69b24245bf2ecdc9e7f53bbad19",
      },
      turns: 2,
      observations: 2,
      evidenceReferences: 1,
    });
  });

  it("degrades honestly when a hand-edited report is missing sections", () => {
    expect(readCaseSummary("{}")).toEqual({
      target: {},
      turns: 0,
      observations: 0,
      evidenceReferences: 0,
    });
    // A report with a malformed turn list still reports its target.
    const partial = readCaseSummary(JSON.stringify({ target: { name: "app.exe" }, turns: "nope" }));
    expect(partial).toMatchObject({ target: { name: "app.exe" }, turns: 0, observations: 0 });
  });

  it("refuses text that is not a report at all", () => {
    expect(readCaseSummary("")).toBeUndefined();
    expect(readCaseSummary("{truncated")).toBeUndefined();
    expect(readCaseSummary("[1,2,3]")).toBeUndefined();
    expect(readCaseSummary("null")).toBeUndefined();
  });

  it("counts the sections REA's bundle actually contains", () => {
    expect(
      readBundleCounts(
        JSON.stringify({ artifacts: [1, 2], captures: [], environments: [], providers: [], records: [{}, {}], scenarios: [], unknowns: [{}] }),
      ),
    ).toEqual({ records: 2, unknowns: 1 });
    // A bundle without those arrays reports zero rather than throwing.
    expect(readBundleCounts(JSON.stringify({ artifacts: [] }))).toEqual({ records: 0, unknowns: 0 });
    expect(readBundleCounts("not json")).toBeUndefined();
    expect(readBundleCounts("[]")).toBeUndefined();
  });
});
