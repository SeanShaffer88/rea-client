/**
 * REA's error contract.
 *
 * Verified against rea-agents 6.8.0: a failing tool call returns
 * `{ isError: true }` with **no** `structuredContent`, and puts a JSON document
 * in the text block:
 *
 *   { "error": { "code", "category", "message", "retryable",
 *                "remediation": { "action" }, "recovery": { ... },
 *                "details": { ... } } }
 *
 * Rendering that JSON verbatim into the transcript wastes context and buries the
 * one sentence the model needs. This module extracts the actionable parts and
 * keeps REA's own guidance ("Do not repeat the unchanged call") in front of the
 * model.
 */

import type { McpCallToolResult } from "./types.js";
import { textContent } from "./types.js";

export interface ReaErrorEnvelope {
  readonly code: string;
  readonly category?: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly remediationAction?: string;
  readonly details?: unknown;
}

/** Parses the REA error contract out of a failed tool result. */
export function parseReaError(result: McpCallToolResult): ReaErrorEnvelope | undefined {
  const text = textContent(result);
  if (text === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const error = (parsed as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return undefined;

  const record = error as Record<string, unknown>;
  const code = typeof record["code"] === "string" ? record["code"] : "unknown_error";
  const message = typeof record["message"] === "string" ? record["message"] : text.slice(0, 500);

  const remediation = record["remediation"];
  const remediationAction =
    typeof remediation === "object" && remediation !== null &&
    typeof (remediation as Record<string, unknown>)["action"] === "string"
      ? ((remediation as Record<string, unknown>)["action"] as string)
      : undefined;

  return {
    code,
    ...(typeof record["category"] === "string" ? { category: record["category"] } : {}),
    message,
    ...(typeof record["retryable"] === "boolean" ? { retryable: record["retryable"] } : {}),
    ...(remediationAction === undefined ? {} : { remediationAction }),
    ...(record["details"] === undefined ? {} : { details: record["details"] }),
  };
}

/**
 * Renders a failed call as concise, directive text for the model.
 *
 * The wording deliberately mirrors REA's own remediation style: state what
 * failed, whether retrying unchanged can help, and what to do instead.
 */
export function renderReaError(envelope: ReaErrorEnvelope): string {
  const header = envelope.category === undefined
    ? `REA rejected the call: ${envelope.code}`
    : `REA rejected the call: ${envelope.code} (${envelope.category})`;

  const lines: string[] = [header, envelope.message];

  if (envelope.retryable === false) {
    lines.push("Retrying the same arguments will fail the same way.");
  } else if (envelope.retryable === true) {
    lines.push("REA marked this failure retryable.");
  }

  // The specific field-level reason lives in `details.issues[].message`
  // ("path: must be an absolute local filesystem path"); the top-level message
  // is only the generic schema-mismatch sentence.
  for (const issue of collectIssueMessages(envelope.details)) {
    lines.push(`Detail: ${issue}`);
  }

  if (envelope.remediationAction !== undefined && envelope.remediationAction !== envelope.message) {
    lines.push(`Next step: ${envelope.remediationAction}`);
  }

  return lines.join("\n");
}

/** Extracts human-readable reasons from `details.issues[]`, when present. */
function collectIssueMessages(details: unknown): string[] {
  if (typeof details !== "object" || details === null) return [];
  const issues = (details as Record<string, unknown>)["issues"];
  if (!Array.isArray(issues)) return [];

  const messages: string[] = [];
  for (const issue of issues.slice(0, 6)) {
    if (typeof issue !== "object" || issue === null) continue;
    const message = (issue as Record<string, unknown>)["message"];
    if (typeof message === "string" && message !== "") messages.push(message);
  }
  return messages;
}

/**
 * True when the result is flagged as untrusted target-derived content.
 *
 * REA sets `_meta.provenance.untrusted_content` on results whose text came from
 * the analyzed binary — strings, comments, symbol names, decompiled source. A
 * malicious target can therefore embed instruction-like text. The agent loop
 * marks these observations so the model treats them as data.
 */
export function isUntrustedContent(result: McpCallToolResult): boolean {
  const provenance = result._meta?.["provenance"];
  if (typeof provenance !== "object" || provenance === null) return false;
  return (provenance as Record<string, unknown>)["untrusted_content"] === true;
}
