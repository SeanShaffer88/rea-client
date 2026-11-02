/**
 * Readers for REA's retained Evidence bundle.
 *
 * The agent loop only ever needs a bounded projection of an observation, but a
 * human analyst does not: the workspace lets someone open the *retained* record
 * behind an evidence id, and export the whole canonical bundle. Both are
 * ordinary REA tools (`get_evidence_bundle`, `export_evidence_bundle`) rather
 * than new capabilities, and both are wrapped here so the bridge never has to
 * trust the payload's shape.
 *
 * Shapes verified against rea-agents 6.8.0 — see `docs/rea-integration-notes.md`.
 */

import type { McpCallToolResult } from "./types.js";
import { textContent } from "./types.js";

export interface RetainedEvidenceRecord {
  readonly evidenceId: string;
  readonly operation?: string;
  readonly subjectName?: string;
  readonly subjectSha256?: string;
  readonly subjectFormat?: string;
  readonly providerId?: string;
  readonly confidence?: string;
  readonly authority?: string;
  readonly retention?: string;
  readonly limitationCount?: number;
}

export interface EvidenceInventory {
  readonly totalRetained: number;
  readonly matching: number;
  readonly unknownRevisions: number;
  readonly records: RetainedEvidenceRecord[];
}

export interface ExportedEvidenceBundle {
  readonly path: string;
  readonly bytes: number;
  readonly records: number;
  readonly unknowns: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

function num(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fill<K extends string, V>(key: K, value: V | undefined): {} | Record<K, V> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * REA returns structured content for these tools, but a server build that only
 * emits text would otherwise look like "no evidence". Read the JSON text body
 * as a fallback and treat unparseable output as absent rather than empty.
 */
function payload(result: McpCallToolResult): Record<string, unknown> | undefined {
  const structured = asRecord(result.structuredContent);
  if (structured !== undefined) return asRecord(structured["result"]) ?? structured;
  const text = textContent(result).trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed = asRecord(JSON.parse(text));
    return asRecord(parsed?.["result"]) ?? parsed;
  } catch {
    return undefined;
  }
}

/** REA mints `ev_` + sha256-shaped ids; anything else cannot be re-read later. */
const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/;

function readRecord(entry: Record<string, unknown>): RetainedEvidenceRecord | undefined {
  const evidenceId = str(entry, "evidence_id");
  if (evidenceId === undefined || !EVIDENCE_ID.test(evidenceId)) return undefined;
  const subject = asRecord(entry["subject"]);
  const digest = asRecord(subject?.["digest"]);
  const provider = asRecord(entry["provider"]);
  return {
    evidenceId,
    ...fill("operation", str(entry, "operation")),
    ...fill("subjectName", str(subject, "name")),
    ...fill("subjectSha256", str(digest, "sha256")),
    ...fill("subjectFormat", str(subject, "format")),
    ...fill("providerId", str(provider, "id")),
    ...fill("confidence", str(entry, "confidence")),
    ...fill("authority", str(entry, "authority")),
    ...fill("retention", str(entry, "retention")),
    ...fill("limitationCount", num(entry, "limitation_count")),
  };
}

/** Reads a `get_evidence_bundle { detail: "summary" }` result. */
export function readEvidenceSummary(result: McpCallToolResult): EvidenceInventory | undefined {
  const body = payload(result);
  if (body === undefined) return undefined;
  const records = body["records"];
  if (!Array.isArray(records)) return undefined;

  const parsed: RetainedEvidenceRecord[] = [];
  for (const entry of records) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const read = readRecord(record);
    if (read !== undefined) parsed.push(read);
  }

  return {
    totalRetained: num(body, "total_retained_records") ?? parsed.length,
    matching: num(body, "matching_records") ?? parsed.length,
    unknownRevisions: num(body, "unknown_revisions") ?? 0,
    records: parsed,
  };
}

/** Reads an `export_evidence_bundle` result. */
export function readExportedBundle(result: McpCallToolResult): ExportedEvidenceBundle | undefined {
  const body = payload(result);
  if (body === undefined) return undefined;
  const path = str(body, "path");
  if (path === undefined) return undefined;
  return {
    path,
    bytes: num(body, "bytes") ?? 0,
    records: num(body, "records") ?? 0,
    unknowns: num(body, "unknowns") ?? 0,
  };
}

/**
 * Selects one record from a `detail: "complete"` bundle.
 *
 * The filter is applied server-side, but a mistaken or evolving server that
 * returns every record must not leak a different observation into a panel the
 * analyst believes is one specific evidence id, so the match is re-checked here.
 */
export function selectEvidenceRecord(
  result: McpCallToolResult,
  evidenceId: string,
): Record<string, unknown> | undefined {
  const body = payload(result);
  const records = body?.["records"];
  if (!Array.isArray(records)) return undefined;
  for (const entry of records) {
    const record = asRecord(entry);
    if (record !== undefined && record["evidence_id"] === evidenceId) return record;
  }
  return undefined;
}
