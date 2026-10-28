/**
 * Structural views of the MCP payloads this client consumes.
 *
 * These are declared locally instead of imported from the SDK so the
 * orchestration layer can be unit-tested against fixtures, and so an SDK
 * upgrade that reshapes its nominal types does not ripple through the engine.
 * Anything not needed by the orchestration layer is intentionally omitted.
 */

export type JsonSchema = Record<string, unknown>;

/** One entry from `tools/list`. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly title?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: Record<string, unknown>;
}

export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

export type McpContentBlock = McpTextContent | { readonly type: string; readonly [key: string]: unknown };

/** One entry from `tools/call`. */
export interface McpCallToolResult {
  readonly content?: readonly McpContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly _meta?: Record<string, unknown>;
}

export function isTextContent(block: McpContentBlock): block is McpTextContent {
  return block.type === "text" && typeof (block as { text?: unknown }).text === "string";
}

/** Concatenates the textual content blocks of a tool result. */
export function textContent(result: McpCallToolResult): string {
  const blocks = result.content ?? [];
  return blocks
    .filter(isTextContent)
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Server implementation info returned by the handshake. */
export interface McpServerVersion {
  readonly name: string;
  readonly version: string;
}

/**
 * REA's Evidence record, as advertised in `outputSchema`.
 *
 * Every evidence-producing REA tool returns this same envelope, which is why the
 * engine can treat tool output uniformly instead of special-casing per tool.
 */
export interface EvidenceRecord {
  readonly evidence_id?: string;
  readonly subject?: unknown;
  readonly provider?: unknown;
  readonly analysis_profile?: unknown;
  readonly predicate_type?: unknown;
  readonly operation?: unknown;
  readonly parameters?: unknown;
  readonly caller_input_path?: unknown;
  readonly raw_result?: unknown;
  readonly normalized_result?: unknown;
  readonly confidence?: unknown;
  readonly authority?: unknown;
  readonly environment?: unknown;
  readonly limitations?: unknown;
  readonly relationship_coverage?: unknown;
  readonly locations?: unknown;
  readonly evidence_links?: unknown;
  readonly [key: string]: unknown;
}

/**
 * The subset of `binary_session` this client reads.
 *
 * Field names match the verified 6.8.0 payload, where an open target adds
 * `path`, `format`, `kind`, `sha256` and `architecture` at the top level.
 */
export interface BinarySessionSummary {
  readonly open: boolean;
  readonly cleanupPending: boolean;
  readonly sessionKind?: string;
  readonly targetPath?: string;
  readonly format?: string;
  readonly kind?: string;
  readonly sha256?: string;
  readonly architecture?: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly protocolVersion?: string;
  readonly catalogDigest?: string;
  readonly catalogToolCount?: number;
  readonly runId?: string;
  /** Deep-analysis provider selected by `open_binary`, when one was bound. */
  readonly providerId?: string;
  readonly providerVersion?: string;
  /** Providers this host advertises, available or not, with availability. */
  readonly providers: readonly ProviderAvailability[];
  readonly raw: Record<string, unknown>;
}

export interface ProviderAvailability {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly available: boolean;
  readonly reason?: string;
}
