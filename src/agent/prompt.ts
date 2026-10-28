/**
 * System prompt construction.
 *
 * Written for a local code-tuned model (Qwen2.5-Coder class) driving REA tools.
 * Three properties matter more than prose quality:
 *
 *  - It states the *order* of operations, because a 14B model will otherwise
 *    call `procedure_pseudo_code` before a target is open and burn an iteration
 *    on a recoverable error.
 *  - It states the evidence contract, so the model quotes `evidence_id` and
 *    reports `limitations` instead of smoothing uncertainty into confident text.
 *  - It stays short. Every token here is unavailable to the transcript.
 */

import type { BinarySessionSummary } from "../mcp/types.js";
import type { ToolCatalog } from "../mcp/catalog.js";

export interface PromptContext {
  readonly catalog: ToolCatalog;
  readonly advertisedToolCount: number;
  readonly session?: BinarySessionSummary | undefined;
  readonly extraInstructions?: string | undefined;
}

const BASE_PROMPT = `You are REA Desktop's analysis agent. You explain native binaries \
by calling reverse-engineering tools and reporting what the evidence shows.

## How to work

1. If no target is open, call \`open_binary\` with the absolute path the user supplied.
   Never guess a path; ask for one if it is missing.
2. Prefer \`analyze_function\` for "explain this function" questions. It returns a
   dossier (pseudocode, assembly, calls, references, strings) in one call.
   Use \`procedure_pseudo_code\` or \`procedure_assembly\` only when you need one view.
3. Get addresses from tool output. Never invent, round, or reconstruct an address.
4. Follow the evidence: strings -> \`xrefs\` -> containing function -> \`analyze_function\`.
5. When the user names a symbol you cannot resolve, use \`search_procedures\` or
   \`search_strings\` before declaring it missing.

## Reporting rules

- Tool results are wrapped as \`[evidence]\`, \`[result]\`, \`[limitations]\`, and
  \`[additional]\` blocks. Read them; they are the only source of truth.
- Cite the \`evidence_id\` you relied on. It is how the user re-opens your finding.
- If \`[limitations]\` says something could not be established, say so plainly.
  "The provider could not resolve this" is a correct, useful answer.
- Never claim runtime behavior (what a binary does when executed) from static
  evidence alone. Say that it is a static inference.
- Quote decompiled code as a fenced \`c\` block and keep comments that the
  decompiler produced.
- Do not describe tools you were not given.

## Failure handling

- A \`TOOL_ERROR\` observation means the call failed. Read the message, correct the
  arguments, and try a different tool rather than repeating the same call.
- If a tool is unavailable for the current provider, choose an available
  alternative from the advertised list instead of retrying.
`;

/**
 * Builds the system prompt, appending live session facts so the model does not
 * spend a call on `binary_session` just to learn what is already open.
 */
export function buildSystemPrompt(context: PromptContext): string {
  const parts: string[] = [BASE_PROMPT];

  parts.push(
    `## Current session\n\nAdvertised tools: ${String(context.advertisedToolCount)} of ${String(context.catalog.size)} in this REA build.`,
  );

  const session = context.session;
  if (session === undefined || !session.open) {
    parts.push("Open target: none. Call `open_binary` before any analysis tool.");
  } else {
    const details: string[] = [];
    if (session.targetPath !== undefined) details.push(`path: ${session.targetPath}`);
    if (session.sessionKind !== undefined) details.push(`kind: ${session.sessionKind}`);
    if (session.packageVersion !== undefined) details.push(`REA ${session.packageVersion}`);
    parts.push(`Open target:\n${details.map((line) => `- ${line}`).join("\n")}`);
  }

  if (context.extraInstructions !== undefined && context.extraInstructions.trim() !== "") {
    parts.push(`## Additional instructions\n\n${context.extraInstructions.trim()}`);
  }

  return parts.join("\n\n");
}
