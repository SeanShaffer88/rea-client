/**
 * Maps MCP tool definitions onto OpenAI-compatible function definitions.
 *
 * Three constraints drive this module:
 *
 *  1. **Name grammar.** Function names must match `^[A-Za-z0-9_-]{1,64}$`.
 *     REA's names already comply, but the mapper still sanitizes and keeps a
 *     reverse map so a future rename cannot silently break dispatch.
 *  2. **Context budget.** Descriptions are the single largest fixed cost of a
 *     turn. REA writes thorough descriptions; they are trimmed here to a
 *     configurable ceiling because the first ~1 KB is what actually steers
 *     tool selection.
 *  3. **Schema hygiene.** JSON Schema keywords that some local servers reject
 *     (`$schema`, `$id`) are dropped, and the parameters object is forced to
 *     `type: "object"`.
 */

import type { FunctionDefinition } from "./types.js";
import type { McpToolDefinition } from "../mcp/types.js";

const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DESCRIPTION_LIMIT = 700;

export interface SchemaMapperOptions {
  /** Maximum characters of description retained per tool. */
  readonly descriptionLimit?: number;
}

export interface MappedToolSet {
  readonly definitions: readonly FunctionDefinition[];
  /** Maps the advertised (possibly sanitized) function name to the MCP name. */
  readonly mcpNameFor: ReadonlyMap<string, string>;
  /** Names that had to be rewritten to satisfy the function-name grammar. */
  readonly renamed: readonly { readonly mcpName: string; readonly functionName: string }[];
  /** Approximate characters of the serialized definitions. */
  readonly approximateChars: number;
}

/** Coerces an MCP tool name into the function-name grammar. */
export function toFunctionName(name: string): string {
  if (VALID_NAME.test(name)) return name;
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return sanitized === "" ? "tool" : sanitized;
}

function cleanParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (schema === undefined || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  const clone: Record<string, unknown> = { ...schema };
  delete clone["$schema"];
  delete clone["$id"];

  if (clone["type"] === undefined) clone["type"] = "object";
  if (clone["type"] === "object" && clone["properties"] === undefined) {
    clone["properties"] = {};
  }
  if (clone["properties"] !== undefined && typeof clone["properties"] !== "object") {
    clone["properties"] = {};
  }
  return clone;
}

function summarizeDescription(tool: McpToolDefinition, limit: number): string {
  const base = (tool.description ?? "").replace(/\s+/g, " ").trim();
  const text = base === "" ? `REA tool ${tool.name}.` : base;
  if (text.length <= limit) return text;
  // Prefer cutting at a sentence boundary near the limit.
  const window = text.slice(0, limit);
  const lastStop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
  if (lastStop > limit * 0.5) return window.slice(0, lastStop + 1);
  return `${window.trimEnd()}…`;
}

/**
 * Builds the advertised tool set for one turn.
 *
 * Duplicate sanitized names are dropped after the first occurrence so the
 * reverse map stays injective.
 */
export function buildFunctionDefinitions(
  tools: readonly McpToolDefinition[],
  options: SchemaMapperOptions = {},
): MappedToolSet {
  const limit = options.descriptionLimit ?? DESCRIPTION_LIMIT;
  const definitions: FunctionDefinition[] = [];
  const mcpNameFor = new Map<string, string>();
  const renamed: Array<{ mcpName: string; functionName: string }> = [];

  for (const tool of tools) {
    const functionName = toFunctionName(tool.name);
    if (mcpNameFor.has(functionName)) continue;

    mcpNameFor.set(functionName, tool.name);
    if (functionName !== tool.name) {
      renamed.push({ mcpName: tool.name, functionName });
    }

    definitions.push({
      type: "function",
      function: {
        name: functionName,
        description: summarizeDescription(tool, limit),
        parameters: cleanParameters(tool.inputSchema),
      },
    });
  }

  return {
    definitions,
    mcpNameFor,
    renamed,
    approximateChars: definitions.reduce(
      (total, definition) => total + JSON.stringify(definition).length,
      0,
    ),
  };
}

/**
 * Rough token estimate for the advertised tool block.
 *
 * Deliberately pessimistic (~3.2 chars/token) for JSON-heavy text: overestimating
 * the fixed cost keeps headroom for the conversation on a small context.
 */
export function estimateSchemaTokens(mapped: MappedToolSet): number {
  return Math.ceil(mapped.approximateChars / 3.2);
}
