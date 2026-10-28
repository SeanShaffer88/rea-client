import { describe, expect, it } from "vitest";
import { ToolCatalog, classifyTool, inventoryFingerprint } from "../../src/mcp/catalog.js";
import { tool } from "../support/fakes.js";

/** Names taken from a real rea-agents 6.8.0 `tools/list` response. */
const REAL_NAMES = [
  "open_binary",
  "close_binary",
  "binary_session",
  "binary_overview",
  "list_procedures",
  "analyze_function",
  "procedure_pseudo_code",
  "procedure_assembly",
  "procedure_info",
  "procedure_callers",
  "procedure_callees",
  "xrefs",
  "list_strings",
  "search_strings",
  "search_procedures",
  "list_segments",
  "inspect_binary_layout",
  "inspect_pe_imports",
  "inspect_native_exports",
  "read_bytes",
  "get_call_graph",
  "inspect_analysis_view",
  "decompile_all",
  "batch_decompile",
  "inspect_android_class",
  "trace_javascript_semantics",
  "inspect_macho",
  "start_frida_session",
  "export_evidence_bundle",
];

describe("classifyTool", () => {
  it.each([
    ["open_binary", "session"],
    ["binary_session", "session"],
    ["goto_address", "navigation"],
    ["analyze_function", "native-analysis"],
    ["procedure_pseudo_code", "native-analysis"],
    ["decompile_all", "native-analysis"],
    ["xrefs", "xrefs"],
    ["get_call_graph", "xrefs"],
    ["set_comment", "annotate"],
    ["inspect_pe_imports", "pe"],
    ["inspect_macho", "apple"],
    ["list_strings", "binary-layout"],
    ["inspect_android_class", "android"],
    ["inspect_dotnet_assembly", "managed"],
    ["start_frida_session", "runtime-debug"],
    ["export_evidence_bundle", "evidence"],
  ])("classifies %s as %s", (name, family) => {
    expect(classifyTool(name)).toBe(family);
  });

  it("falls back to other for unknown names", () => {
    expect(classifyTool("totally_new_tool")).toBe("other");
  });
});

describe("ToolCatalog", () => {
  const tools = REAL_NAMES.map((name) => tool(name));
  const catalog = ToolCatalog.from(tools);

  it("indexes the live inventory", () => {
    expect(catalog.size).toBe(REAL_NAMES.length);
    expect(catalog.has("find_xrefs_to_name")).toBe(false);
    expect(catalog.get("xrefs")?.name).toBe("xrefs");
  });

  it("groups tools into populated families", () => {
    const families = catalog.populatedFamilies();
    expect(families.length).toBeGreaterThan(0);
    const total = families.reduce((sum, family) => sum + family.tools.length, 0);
    expect(total).toBe(REAL_NAMES.length);
  });

  it("deduplicates repeated definitions so dispatch stays unambiguous", () => {
    const duplicated = ToolCatalog.from([tool("xrefs", "first"), tool("xrefs", "second")]);
    expect(duplicated.size).toBe(1);
    expect(duplicated.get("xrefs")?.description).toBe("first");
    expect(duplicated.duplicateNames([tool("xrefs"), tool("xrefs")])).toEqual(["xrefs"]);
  });

  it("resolves the binary-core scope to the subset present", () => {
    const resolved = catalog.resolveScope("binary-core");
    expect(resolved.tools.length).toBeGreaterThan(10);
    expect(resolved.missing).toEqual([]);
    expect(resolved.tools.map((t) => t.name)).toContain("analyze_function");
  });

  it("reports scope names the server does not expose instead of dropping them", () => {
    const partial = ToolCatalog.from([tool("open_binary"), tool("analyze_function")]);
    const resolved = partial.resolveScope("binary-core");
    expect(resolved.tools.map((t) => t.name)).toEqual(["open_binary", "analyze_function"]);
    expect(resolved.missing).toContain("procedure_pseudo_code");
  });

  it("resolves full scope to the complete inventory", () => {
    expect(catalog.resolveScope("full").tools.length).toBe(REAL_NAMES.length);
    expect(catalog.resolveScope("full").missing).toEqual([]);
  });

  it("resolves a custom scope verbatim", () => {
    const resolved = catalog.resolveScope("custom", ["xrefs", "list_strings", "nope"]);
    expect(resolved.tools.map((t) => t.name)).toEqual(["xrefs", "list_strings"]);
    expect(resolved.missing).toEqual(["nope"]);
  });

  it("extended scope is a superset of core", () => {
    const core = new Set(catalog.resolveScope("binary-core").tools.map((t) => t.name));
    const extended = new Set(catalog.resolveScope("binary-extended").tools.map((t) => t.name));
    for (const name of core) expect(extended.has(name)).toBe(true);
  });
});

describe("inventoryFingerprint", () => {
  it("is order-independent", () => {
    const a = [tool("b"), tool("a")];
    const b = [tool("a"), tool("b")];
    expect(inventoryFingerprint(a)).toBe(inventoryFingerprint(b));
  });
});
