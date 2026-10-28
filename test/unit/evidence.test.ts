import { describe, expect, it } from "vitest";
import {
  ToolObservation,
  UNTRUSTED_PREFIX,
  clampWithMarker,
  projectEvidence,
  projectToolResult,
  readEvidence,
  stringifyBounded,
} from "../../src/mcp/evidence.js";
import { parseReaError } from "../../src/mcp/errors.js";
import type { McpCallToolResult } from "../../src/mcp/types.js";

const budget = { maxChars: 4_000 };

/** Verbatim error shape captured from rea-agents 6.8.0 for a relative path. */
const REAL_ERROR_TEXT = JSON.stringify({
  error: {
    code: "invalid_request",
    category: "invalid_input",
    message: "The arguments for MCP tool open_binary do not match its advertised input schema.",
    retryable: false,
    remediation: {
      action:
        "Read the declared input schema or CLI usage for open_binary; if using MCP and the catalog may be stale, call tools/list. Correct the listed fields, then retry. Do not repeat the unchanged call.",
    },
    recovery: { kind: "inspect_input_contract", operation: "open_binary" },
    details: {
      operation: "open_binary",
      issues: [{ path: [], reason: "invalid_value", message: "path: must be an absolute local filesystem path" }],
    },
  },
});

const REAL_EVIDENCE = {
  evidence_id: "ev_0123456789abcdef",
  predicate_type: "native.function.dossier",
  operation: "analyze_function",
  confidence: "high",
  normalized_result: {
    procedure: { name: "sub_1400010a0", address: "0x1400010a0" },
    pseudocode: "void sub_1400010a0(void) {\n  xor eax, eax;\n}",
  },
  raw_result: { huge: "x".repeat(50_000) },
  limitations: ["Indirect calls were not resolved."],
  relationship_coverage: { callees: "complete" },
};

describe("readEvidence", () => {
  it("reads a top-level Evidence envelope", () => {
    const result: McpCallToolResult = { structuredContent: REAL_EVIDENCE };
    expect(readEvidence(result)?.evidence_id).toBe("ev_0123456789abcdef");
  });

  it("unwraps the nested result shape used by discovery tools", () => {
    const result: McpCallToolResult = {
      structuredContent: { result: { open: false, path: "/bin/ls" } },
    };
    // `binary_session` is not Evidence, so nothing should be claimed as such.
    expect(readEvidence(result)).toBeUndefined();
  });

  it("returns undefined without structured content", () => {
    expect(readEvidence({ content: [{ type: "text", text: "hi" }] })).toBeUndefined();
  });
});

describe("projectEvidence", () => {
  it("pins the id and limitations, and drops the duplicated raw payload", () => {
    const projected = projectEvidence(REAL_EVIDENCE, budget);
    expect(projected.text).toContain("evidence_id=ev_0123456789abcdef");
    expect(projected.text).toContain("operation=analyze_function");
    expect(projected.text).toContain("[limitations]");
    expect(projected.text).toContain("Indirect calls were not resolved.");
    expect(projected.text).toContain("sub_1400010a0");
    // raw_result duplicates normalized_result and is not rendered.
    expect(projected.text).not.toContain("xxxxx");
  });

  it("preserves fields it does not recognise", () => {
    const projected = projectEvidence(
      { ...REAL_EVIDENCE, future_field: { a: 1 } },
      budget,
    );
    expect(projected.text).toContain("[additional]");
    expect(projected.text).toContain("future_field");
  });

  it("falls back to raw_result when nothing was normalized", () => {
    const projected = projectEvidence(
      { evidence_id: "e1", operation: "op", raw_result: { provider: "ghidra" } },
      budget,
    );
    expect(projected.text).toContain("[result:raw]");
    expect(projected.text).toContain("ghidra");
  });

  it("respects the character budget", () => {
    const projected = projectEvidence(REAL_EVIDENCE, { maxChars: 400 });
    expect(projected.text.length).toBeLessThanOrEqual(400);
    expect(projected.truncated).toBe(true);
  });
});

describe("projectToolResult", () => {
  it("marks REA validation failures with actionable guidance", () => {
    const observation = projectToolResult(
      { isError: true, content: [{ type: "text", text: REAL_ERROR_TEXT }] },
      budget,
    );
    expect(observation.text.startsWith(ToolObservation.errorPrefix)).toBe(true);
    expect(observation.text).toContain("invalid_request");
    expect(observation.text).toContain("must be an absolute local filesystem path");
    expect(observation.text).toContain("Retrying the same arguments will fail");
  });

  it("keeps the evidence id from a successful call", () => {
    const observation = projectToolResult({ structuredContent: REAL_EVIDENCE }, budget);
    expect(observation.evidenceId).toBe("ev_0123456789abcdef");
  });

  it("flags untrusted target-derived content", () => {
    const observation = projectToolResult(
      {
        structuredContent: REAL_EVIDENCE,
        _meta: { provenance: { untrusted_content: true, source: "analysis_target" } },
      },
      budget,
    );
    expect(observation.text.startsWith(UNTRUSTED_PREFIX)).toBe(true);
  });

  it("does not add the untrusted marker to trusted output", () => {
    const observation = projectToolResult({ structuredContent: REAL_EVIDENCE }, budget);
    expect(observation.text.startsWith(UNTRUSTED_PREFIX)).toBe(false);
  });

  it("truncates oversized plain text but keeps the tail", () => {
    const head = "H".repeat(5_000);
    const tail = "IMPORTANT-TRAILING-LIMITATION";
    const observation = projectToolResult(
      { content: [{ type: "text", text: `${head}${tail}` }] },
      { maxChars: 500 },
    );
    expect(observation.text.length).toBeLessThanOrEqual(500);
    expect(observation.text).toContain(tail);
    expect(observation.text).toContain("truncated");
    expect(observation.truncated).toBe(true);
  });

  it("handles an empty result", () => {
    expect(projectToolResult({}, budget).text).toBe("(tool returned no content)");
  });
});

describe("parseReaError", () => {
  it("extracts the error contract", () => {
    const parsed = parseReaError({ isError: true, content: [{ type: "text", text: REAL_ERROR_TEXT }] });
    expect(parsed?.code).toBe("invalid_request");
    expect(parsed?.retryable).toBe(false);
    expect(parsed?.remediationAction).toContain("Do not repeat the unchanged call");
  });

  it("returns undefined for non-JSON error text", () => {
    expect(
      parseReaError({ isError: true, content: [{ type: "text", text: "boom" }] }),
    ).toBeUndefined();
  });
});

describe("stringifyBounded", () => {
  it("elides long strings with a count", () => {
    const out = stringifyBounded({ s: "y".repeat(2_000) }, { maxChars: 4_000, maxStringLength: 10 });
    expect(out).toContain("(+1990 chars)");
  });

  it("elides long arrays and marks the remainder", () => {
    const out = stringifyBounded([1, 2, 3, 4, 5], { maxChars: 4_000, maxArrayItems: 2 });
    expect(out).toContain("(+3 items)");
  });

  it("stops descending at the depth limit", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i += 1) nested = { next: nested };
    expect(stringifyBounded(nested, { maxChars: 4_000, maxDepth: 3 })).toContain("depth limit");
  });

  it("survives circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => stringifyBounded(circular, { maxChars: 1_000 })).not.toThrow();
  });
});

describe("clampWithMarker", () => {
  it("returns short text untouched", () => {
    expect(clampWithMarker("short", 100, "x")).toEqual({ text: "short", truncated: false });
  });

  it("never exceeds the limit", () => {
    const { text, truncated } = clampWithMarker("a".repeat(1_000), 100, "payload");
    expect(text.length).toBeLessThanOrEqual(100);
    expect(truncated).toBe(true);
  });
});
