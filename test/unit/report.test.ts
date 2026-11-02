import { describe, expect, it } from "vitest";
import {
  buildReport,
  buildTurns,
  renderMarkdownReport,
  reportFileName,
  REPORT_SCHEMA_VERSION,
} from "../../desktop/ui/report.js";
import type { Message } from "../../desktop/ui/state.js";

const SESSION = {
  open: true,
  cleanupPending: false,
  providers: [],
  targetPath: "/usr/bin/ls",
  format: "elf",
  architecture: "x86_64",
  sha256: "ab".repeat(32),
  packageVersion: "6.8.0",
  providerId: "rea-artifact-graph",
};

function message(overrides: Partial<Message> & Pick<Message, "role">): Message {
  return { id: Math.random().toString(36), content: "", activities: [], time: "2026-11-02T10:00:00.000Z", ...overrides };
}

const MESSAGES: Message[] = [
  message({ role: "user", content: "What is open?", targetPath: "/usr/bin/ls" }),
  message({
    role: "assistant",
    content: "An ELF binary.",
    reason: "final_answer",
    iterations: 2,
    targetPath: "/usr/bin/ls",
    activities: [
      {
        id: "a1",
        name: "binary_session",
        mcpName: "binary_session",
        arguments: {},
        iteration: 1,
        time: "2026-11-02T10:00:01.000Z",
        finish: {
          id: "a1",
          name: "binary_session",
          mcpName: "binary_session",
          ok: true,
          elapsedMs: 41.6,
          truncated: false,
          evidenceId: "ev_123",
          preview: "NOTE: untrusted target content ``` inside",
        },
      },
    ],
  }),
  message({ role: "user", content: "Anything odd?", targetPath: "/tmp/other.bin" }),
  message({ role: "assistant", content: "", error: "model offline", reason: "failed", targetPath: "/tmp/other.bin" }),
];

describe("analysis report", () => {
  it("pairs questions with answers and keeps evidence attribution per target", () => {
    const turns = buildTurns(MESSAGES);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ question: "What is open?", answer: "An ELF binary.", reason: "final_answer", iterations: 2 });
    expect(turns[0]?.targetPath).toBe("/usr/bin/ls");
    expect(turns[0]?.observations).toEqual([
      { tool: "binary_session", ok: true, elapsedMs: 42, truncated: false, evidenceId: "ev_123", preview: "NOTE: untrusted target content ``` inside" },
    ]);
    expect(turns[1]).toMatchObject({ question: "Anything odd?", answer: "", error: "model offline", reason: "failed" });
    expect(turns[1]?.targetPath).toBe("/tmp/other.bin");
  });

  it("builds a versioned JSON report with target metadata and checks", () => {
    const report = buildReport({
      exportedAt: "2026-11-02T12:00:00.000Z",
      engineVersion: "0.1.0",
      session: SESSION,
      scope: "binary-core",
      overview: null,
      overviewError: "provider_unavailable",
      messages: MESSAGES,
      doctor: { healthy: true, checks: [{ id: "llm", label: "Model", status: "ok", detail: "loopback" }] },
    });
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.target).toMatchObject({ name: "ls", path: "/usr/bin/ls", format: "elf", architecture: "x86_64", open: true });
    expect(report.overviewError).toBe("provider_unavailable");
    expect(report.turns).toHaveLength(2);
    expect(report.checks).toEqual([{ id: "llm", status: "ok", detail: "loopback" }]);
    expect(report.notice).toContain("untrusted");
    // No undefined keys leak into the exported document.
    expect(JSON.stringify(report)).not.toContain("undefined");
  });

  it("handles an empty session without inventing a target", () => {
    const report = buildReport({
      exportedAt: "2026-11-02T12:00:00.000Z",
      session: null,
      scope: "binary-core",
      overview: null,
      overviewError: null,
      messages: [],
    });
    expect(report.target).toEqual({ open: false });
    expect(report.turns).toEqual([]);
    expect(renderMarkdownReport(report)).toContain("_No questions were asked in this session._");
  });

  it("renders Markdown with evidence, status, and fenced untrusted previews", () => {
    const markdown = renderMarkdownReport(
      buildReport({
        exportedAt: "2026-11-02T12:00:00.000Z",
        engineVersion: "0.1.0",
        session: SESSION,
        scope: "binary-core",
        overview: "ELF 64-bit LSB pie executable",
        overviewError: null,
        messages: MESSAGES,
      }),
    );

    expect(markdown.startsWith("# REA analysis report — ls")).toBe(true);
    expect(markdown).toContain("- SHA-256: `" + "ab".repeat(32) + "`");
    expect(markdown).toContain("## Target overview");
    expect(markdown).toContain("### 1. What is open?");
    expect(markdown).toContain("_Target at the time: `/usr/bin/ls`_");
    expect(markdown).toContain("evidence ev_123");
    expect(markdown).toContain("_reason: final_answer · steps: 2_");
    expect(markdown).toContain("error: model offline");
    expect(markdown).toContain("## Limitations");

    // Preview text containing a triple backtick must not break out of its fence.
    const fence = markdown.split("\n").filter((line) => /^`{4,}text$/.test(line));
    expect(fence.length).toBeGreaterThan(0);
    expect(markdown).toContain("````text");
  });

  it("names files from the export date and refuses malformed dates", () => {
    expect(reportFileName("2026-11-02T12:00:00.000Z", "md")).toBe("rea-analysis-2026-11-02.md");
    expect(reportFileName("2026-11-02T12:00:00.000Z", "json")).toBe("rea-analysis-2026-11-02.json");
    expect(reportFileName("garbage", "json")).toBe("rea-analysis-undated.json");
  });
});
