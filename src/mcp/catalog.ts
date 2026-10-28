/**
 * Dynamic tool discovery.
 *
 * REA 6.8.0 advertises 229 tools. Nothing here is hardcoded to that number or
 * to that version: the catalog is whatever `tools/list` returned at runtime,
 * and every operation degrades gracefully when a name is absent.
 *
 * Advertise-vs-call is an important distinction. REA's inventory is much larger
 * than a chat turn can afford to describe — sending all 229 JSON Schemas to a
 * local 14B model consumes most of a 16k context before the user's question is
 * even asked. So the catalog supports *scopes*: a working set is advertised to
 * the model, while calls are still validated against the complete inventory.
 */

import type { McpToolDefinition } from "./types.js";
import type { ToolScopeName } from "../config.js";

export interface ToolFamily {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

interface FamilyRule {
  readonly family: string;
  readonly test: RegExp;
}

/**
 * Ordered classification rules; first match wins.
 *
 * Rules are keyed on REA's naming conventions (`inspect_*`, `list_*`,
 * `analyze_*`) plus provider-specific nouns. They are intentionally broad: a
 * tool this client has never seen still lands in a sensible group for the
 * navigation tree instead of falling into "other".
 */
const FAMILY_RULES: readonly FamilyRule[] = [
  { family: "session", test: /^(open_binary|close_binary|binary_session|open_bundle_resources|current_document|list_documents)$/ },
  { family: "navigation", test: /^(goto_address|next_address|prev_address|current_address|current_procedure|address_name|procedure_address|resolve_containing_procedure|get_navigation_context|address_to_file_offset)$/ },
  { family: "native-analysis", test: /^(analyze_function|list_procedures|procedure_(pseudo_code|assembly|info|callers|callees|references)|decompile_all|batch_decompile|read_function_instructions|read_bytes|search_procedures|search_bytes|list_names|list_unknowns|record_unknown|update_unknown|verify_unknown_resolution|resolve_native_call_targets|inspect_native_instruction|inspect_address_context|binary_overview|inspect_analysis_view)$/ },
  { family: "xrefs", test: /^(xrefs|find_xrefs_to_name|get_call_graph|trace_call_path|build_call_path)$/ },
  { family: "annotate", test: /^(set_address_name|set_addresses_names|comment|set_comment|inline_comment|set_inline_comment|annotate_native_function|set_bookmark|unset_bookmark|list_bookmarks)$/ },
  { family: "pe", test: /^inspect_pe_/ },
  { family: "binary-layout", test: /^(inspect_binary_layout|list_segments|inspect_byte_entropy|list_strings|search_strings|inspect_native_exports|inspect_native_load_image|inspect_elf_notes|inspect_go_binary|inspect_rust_binary|inspect_native_api|inspect_native_data_type|inspect_native_dispatch_metadata|inspect_gpu_code_objects|inspect_kernel_module|inspect_artifact|extract_artifact|inspect_signature|inspect_sqlite_database|inspect_keyed_archive|inspect_wasm_artifact|inspect_model_artifact|list_architectures|inspect_analysis_settings|update_analysis_settings|inspect_python_pyc|inspect_with_objdump)$/ },
  { family: "javascript", test: /(javascript|electron|web_bundle|web_page|web_script|web_capture|web_screenshot|web_network|web_event|webmcp|source_map|browser_targets|bundle_resources|module_imports|source_location|export_shapes|observe_web_execution|observe_web_session|capture_browser_scenario)/ },
  { family: "android", test: /(android|apk|adb_|jadx|jeb|apktool|devicetree|_dart_aot|flutter)/ },
  { family: "apple", test: /(objc|swift|macho|plist|apple|interface_builder|asset_catalog|dylib)/ },
  { family: "managed", test: /(managed|il2cpp|dotnet|nativeaot)/ },
  { family: "embedded", test: /(firmware|kernel_module|erlang_beam|gpu_code|signal_recording|signal_decoders|packet_capture|packet_fields|pcap|evm_interface|byte_entropy)/ },
  { family: "runtime-debug", test: /(frida|_gdb_|gdb_|rizin|cutter|recorded_crash|observe_native|trace_native|process_capture|native_ui|capture_process_scenario)/ },
  { family: "workflow", test: /^(trace_feature|trace_application_feature|find_changed_behavior|correlate_static_and_runtime|match_native_functions|project_harmony_application_graph|inspect_desktop_application)$/ },
  { family: "evidence", test: /(evidence|compare_|reconstruction|export_environment|import_environment|verify_)/ },
];

export const TOOL_FAMILIES: readonly ToolFamily[] = [
  { id: "session", label: "Session", description: "Open, close, and describe the active analysis target." },
  { id: "navigation", label: "Navigation", description: "Move the cursor and resolve addresses to procedures." },
  { id: "native-analysis", label: "Native analysis", description: "Function dossiers, pseudocode, assembly, inventory." },
  { id: "xrefs", label: "Cross-references", description: "References, call graphs, and call paths." },
  { id: "annotate", label: "Annotations", description: "Names, comments, bookmarks written back to the provider." },
  { id: "pe", label: "PE structures", description: "PE headers, imports, exports, resources, certificates." },
  { id: "binary-layout", label: "Binary layout", description: "Segments, strings, entropy, format-specific metadata." },
  { id: "javascript", label: "JavaScript / web", description: "Web bundle, Electron, and browser surface analysis." },
  { id: "android", label: "Android", description: "APK, ADB device, and JADX-backed analysis." },
  { id: "apple", label: "Apple", description: "Mach-O, Objective-C, Swift, and bundle resources." },
  { id: "managed", label: "Managed", description: ".NET, IL2CPP, and NativeAOT assemblies." },
  { id: "embedded", label: "Embedded / capture", description: "Firmware, kernel modules, packet and signal captures." },
  { id: "runtime-debug", label: "Runtime / debug", description: "Frida, GDB, Rizin, Cutter, and recorded crashes." },
  { id: "workflow", label: "Workflow", description: "Cross-cutting feature tracing and version comparison." },
  { id: "evidence", label: "Evidence", description: "Comparison, export, and verification workflows." },
  { id: "other", label: "Other", description: "Tools this client does not classify yet." },
];

/**
 * Curated working set for a native-binary conversation.
 *
 * Every name is verified against the live inventory at runtime; a name that the
 * connected server does not expose is reported as missing rather than assumed
 * to exist.
 */
const BINARY_CORE_TOOLS: readonly string[] = [
  "binary_session",
  "open_binary",
  "close_binary",
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
];

const BINARY_EXTENDED_EXTRA: readonly string[] = [
  "decompile_all",
  "batch_decompile",
  "read_function_instructions",
  "search_bytes",
  "list_names",
  "get_evidence_bundle",
  "export_evidence_bundle",
  "export_environment_bundle",
  "import_evidence_bundle",
  "set_address_name",
  "set_comment",
  "comment",
  "set_bookmark",
  "list_bookmarks",
  "inspect_address_context",
  "inspect_native_instruction",
  "resolve_containing_procedure",
  "find_xrefs_to_name",
  "trace_call_path",
  "build_call_path",
  "inspect_pe_load_config",
  "inspect_pe_resources",
  "inspect_pe_certificates",
  "inspect_byte_entropy",
  "address_to_file_offset",
  "list_unknowns",
  "record_unknown",
  "inspect_analysis_settings",
  "update_analysis_settings",
  "compare_functions",
  "compare_artifacts",
];

const EXTENDED_SCOPE_TOOLS: readonly string[] = [...BINARY_CORE_TOOLS, ...BINARY_EXTENDED_EXTRA];

export interface ScopeResolution {
  readonly scope: ToolScopeName;
  /** Tools actually present in the live inventory, in advertised order. */
  readonly tools: readonly McpToolDefinition[];
  /** Requested names the connected server does not expose. */
  readonly missing: readonly string[];
}

export class ToolCatalog {
  private readonly byName: Map<string, McpToolDefinition>;
  private readonly familyIndex: Map<string, McpToolDefinition[]>;

  private constructor(tools: readonly McpToolDefinition[]) {
    this.byName = new Map();
    for (const tool of tools) {
      // First definition wins; duplicates are reported by `duplicateNames()`.
      if (!this.byName.has(tool.name)) this.byName.set(tool.name, tool);
    }

    this.familyIndex = new Map();
    for (const family of TOOL_FAMILIES) this.familyIndex.set(family.id, []);
    for (const tool of this.byName.values()) {
      const family = classifyTool(tool.name);
      this.familyIndex.get(family)?.push(tool);
    }
  }

  public static from(tools: readonly McpToolDefinition[]): ToolCatalog {
    return new ToolCatalog(tools);
  }

  public get size(): number {
    return this.byName.size;
  }

  public names(): string[] {
    return [...this.byName.keys()];
  }

  public get(name: string): McpToolDefinition | undefined {
    return this.byName.get(name);
  }

  public has(name: string): boolean {
    return this.byName.has(name);
  }

  public all(): readonly McpToolDefinition[] {
    return [...this.byName.values()];
  }

  /** Names whose definition appeared more than once in the raw listing. */
  public duplicateNames(raw: readonly McpToolDefinition[]): string[] {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const tool of raw) {
      if (seen.has(tool.name)) dupes.add(tool.name);
      seen.add(tool.name);
    }
    return [...dupes];
  }

  public byFamily(familyId: string): readonly McpToolDefinition[] {
    return this.familyIndex.get(familyId) ?? [];
  }

  /** Families in declaration order, omitting empty groups. */
  public populatedFamilies(): Array<ToolFamily & { readonly tools: readonly McpToolDefinition[] }> {
    return TOOL_FAMILIES.flatMap((family) => {
      const tools = this.byFamily(family.id);
      return tools.length === 0 ? [] : [{ ...family, tools }];
    });
  }

  public familyOf(name: string): string {
    return classifyTool(name);
  }

  /**
   * Resolves a configured scope to concrete tool definitions.
   *
   * `full` always resolves to the complete inventory. Named scopes report any
   * requested tool the server does not expose, so version drift shows up as a
   * diagnostic instead of a silently thinner toolset.
   */
  public resolveScope(scope: ToolScopeName, custom: readonly string[] = []): ScopeResolution {
    if (scope === "full") {
      return { scope, tools: this.all(), missing: [] };
    }

    const requested =
      scope === "binary-core"
        ? BINARY_CORE_TOOLS
        : scope === "binary-extended"
          ? EXTENDED_SCOPE_TOOLS
          : custom;

    const tools: McpToolDefinition[] = [];
    const missing: string[] = [];
    for (const name of requested) {
      const tool = this.byName.get(name);
      if (tool === undefined) missing.push(name);
      else tools.push(tool);
    }
    return { scope, tools, missing };
  }
}

/** Classifies a tool name into a family id. Unknown names yield "other". */
export function classifyTool(name: string): string {
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(name)) return rule.family;
  }
  return "other";
}

/** Builds the deterministic inventory fingerprint used by diagnostics. */
export function inventoryFingerprint(tools: readonly McpToolDefinition[]): string {
  return [...tools.map((tool) => tool.name)].sort().join("\n");
}
