import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/agent/prompt.js";
import { ToolCatalog } from "../../src/mcp/catalog.js";
import type { BinarySessionSummary } from "../../src/mcp/types.js";
import { tool } from "../support/fakes.js";

const catalog = ToolCatalog.from([tool("open_binary"), tool("analyze_function"), tool("xrefs")]);

function session(overrides: Partial<BinarySessionSummary> = {}): BinarySessionSummary {
  return {
    open: true,
    cleanupPending: false,
    providers: [],
    raw: {},
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("states that no target is open when the session is closed", () => {
    const prompt = buildSystemPrompt({ catalog, advertisedToolCount: 3, session: session({ open: false }) });
    expect(prompt).toContain("Open target: none");
    expect(prompt).toContain("open_binary");
  });

  it("states that no target is open when the session is unknown", () => {
    const prompt = buildSystemPrompt({ catalog, advertisedToolCount: 3 });
    expect(prompt).toContain("Open target: none");
  });

  it("reports the live target path and provider facts", () => {
    const prompt = buildSystemPrompt({
      catalog,
      advertisedToolCount: 3,
      session: session({
        targetPath: "C:\\targets\\app.exe",
        format: "pe",
        packageVersion: "6.8.0",
        providerId: "ghidra",
      }),
    });
    expect(prompt).toContain("C:\\targets\\app.exe");
    expect(prompt).toContain("REA 6.8.0");
  });

  it("reports advertised vs total tool counts so the model knows the catalogue is scoped", () => {
    const prompt = buildSystemPrompt({ catalog, advertisedToolCount: 3 });
    expect(prompt).toContain("3 of 3");
  });

  it("surfaces a scoped catalogue honestly", () => {
    const bigger = ToolCatalog.from(Array.from({ length: 40 }, (_, i) => tool(`t_${i}`)));
    const prompt = buildSystemPrompt({ catalog: bigger, advertisedToolCount: 5 });
    expect(prompt).toContain("5 of 40");
  });

  it("keeps the reporting rules that prevent overclaiming", () => {
    const prompt = buildSystemPrompt({ catalog, advertisedToolCount: 3 });
    // These instructions are load-bearing: without them a small model smooths
    // "provider could not resolve this" into a confident answer.
    expect(prompt).toContain("limitations");
    expect(prompt).toContain("static inference");
    expect(prompt).toContain("Never invent");
  });

  it("tells the model how to read REA's section-labelled observations", () => {
    const prompt = buildSystemPrompt({ catalog, advertisedToolCount: 3 });
    expect(prompt).toContain("[evidence]");
    expect(prompt).toContain("[limitations]");
    expect(prompt).toContain("TOOL_ERROR");
  });

  it("appends extra instructions when supplied", () => {
    const prompt = buildSystemPrompt({
      catalog,
      advertisedToolCount: 3,
      extraInstructions: "Always answer in French.",
    });
    expect(prompt).toContain("## Additional instructions");
    expect(prompt).toContain("Always answer in French.");
  });

  it("ignores blank extra instructions", () => {
    const prompt = buildSystemPrompt({ catalog, advertisedToolCount: 3, extraInstructions: "   " });
    expect(prompt).not.toContain("## Additional instructions");
  });
});
