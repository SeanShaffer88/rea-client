import type {
  EvidenceExportSnapshot,
  EvidenceInventorySnapshot,
  RetainedEvidenceSummary,
} from "../../src/desktop/protocol.js";

/**
 * Display helpers for REA's retained evidence.
 *
 * The bridge reports what the bundle actually contains; these functions only
 * shorten identifiers and describe counts so a panel never implies more
 * coverage than the summary reported.
 */

/** `ev_4e8c8fb7…` — enough to recognise a record without wrapping the row. */
export function shortEvidenceId(id: string): string {
  if (!id.startsWith("ev_")) return id.length > 14 ? `${id.slice(0, 12)}…` : id;
  const body = id.slice(3);
  return body.length > 10 ? `ev_${body.slice(0, 8)}…` : id;
}

export function filterRetainedRecords(
  records: ReadonlyArray<RetainedEvidenceSummary>,
  query: string,
): RetainedEvidenceSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...records];
  return records.filter((record) =>
    [
      record.evidenceId,
      record.operation ?? "",
      record.subjectName ?? "",
      record.providerId ?? "",
      record.confidence ?? "",
      record.authority ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

export function describeRetainedCounts(inventory: EvidenceInventorySnapshot): string {
  const shown = inventory.records.length;
  const retained = plural(inventory.totalRetained, "retained record");
  const matching = inventory.matching === inventory.totalRetained ? retained : `${inventory.matching} of ${retained}`;
  const parts = [matching];
  if (shown !== inventory.matching) parts.push(`${shown} shown`);
  parts.push(plural(inventory.unknownRevisions, "unknown revision"));
  return parts.join(" · ");
}

export function describeEvidenceExport(
  exported: EvidenceExportSnapshot,
  workspaceDir: string,
): string {
  const path = exported.path ?? "";
  const where = relativeToWorkspace(path, workspaceDir);
  const counts = [plural(exported.records ?? 0, "record"), plural(exported.unknowns ?? 0, "unknown")];
  const size = typeof exported.bytes === "number" && exported.bytes > 0 ? `${exported.bytes} bytes · ` : "";
  return `Evidence bundle exported · ${size}${counts.join(" · ")}${where ? ` → ${where}` : ""}`;
}

/** Workspace-relative paths keep the toast readable on every platform. */
export function relativeToWorkspace(path: string, workspaceDir: string): string {
  if (!path) return "";
  if (!workspaceDir) return path;
  const root = workspaceDir.replace(/[\\/]+$/, "");
  const normalized = path.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/");
  if (normalized === normalizedRoot) return ".";
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return `${root.split(/[\\/]/).pop() ?? ""}/${normalized.slice(normalizedRoot.length + 1)}`;
  }
  return normalized;
}

export function evidenceExportConflict(message: string): boolean {
  return /\b(exists?|already|overwrite|refus)/i.test(message);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
