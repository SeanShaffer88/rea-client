import type { CaseSnapshot, CaseSummary, SavedCase } from "../../src/desktop/protocol.js";
import { relativeToWorkspace } from "./evidence.js";

/**
 * Presentation helpers for saved case folders.
 *
 * A case is only worth showing if the report files are actually there, so these
 * helpers read the file list the bridge returned rather than assuming a fixed
 * set — a case saved while REA was disconnected has no evidence bundle.
 */

export function caseTotalBytes(saved: Pick<SavedCase, "files"> | Pick<CaseSnapshot, "files">): number {
  return saved.files.reduce((total, file) => total + (Number.isFinite(file.bytes) ? file.bytes : 0), 0);
}

export function describeCaseFiles(saved: Pick<SavedCase, "files"> | Pick<CaseSnapshot, "files">): string {
  if (saved.files.length === 0) return "No files";
  return saved.files.map((file) => file.name).join(" · ");
}

export function describeSavedCase(saved: SavedCase, workspaceDir: string): string {
  const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Unknown time";
  return `${when} · ${describeCaseFiles(saved)}`;
}

/** Workspace-relative location of a saved case, for a toast or a row title. */
export function caseLocation(saved: Pick<SavedCase, "directory"> | Pick<CaseSnapshot, "directory">, workspaceDir: string): string {
  return relativeToWorkspace(saved.directory ?? "", workspaceDir);
}

export function describeCaseSave(result: CaseSnapshot, workspaceDir: string): string {
  const where = caseLocation(result, workspaceDir);
  const count = `${result.files.length} ${result.files.length === 1 ? "file" : "files"}`;
  const bundle = result.evidence?.ok === true ? " · canonical bundle included" : "";
  return `Case saved · ${count}${bundle}${where ? ` → ${where}` : ""}`;
}

/** True when the save lost a race with an existing folder of the same name. */
export function caseNameConflict(error: string | undefined): boolean {
  if (error === undefined) return false;
  return /\balready exists\b/i.test(error);
}

/**
 * A case name the analyst can keep or edit. The target's file name makes the
 * folder recognisable; the date keeps two runs on the same target apart, which
 * matters because the bridge refuses to overwrite silently.
 */
export function defaultCaseName(targetPath: string | undefined, now: Date = new Date()): string {
  const base = (targetPath ?? "").split(/[\\/]/).pop() ?? "";
  const slug = base
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);
  const date = now.toISOString().slice(0, 10);
  return `${slug === "" ? "case" : slug}-${date}`;
}

/** Mirrors the bridge's rule, so the dialog can explain a bad name before sending it. */
export function caseNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the case a name.";
  if (trimmed.length > 80) return "Keep the name to 80 characters or fewer.";
  if (!/^[A-Za-z0-9]/.test(trimmed)) return "Start with a letter or digit.";
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return "Use only letters, digits, dots, dashes, or underscores.";
  if (trimmed.includes("..")) return "A name cannot contain ..";
  return null;
}

/** "ls · elf · x86_64" — the identity a saved case is about. */
export function describeCaseTarget(summary: CaseSummary | undefined): string {
  if (summary === undefined) return "Target not recorded";
  const parts = [summary.target.name ?? summary.target.path ?? "Unnamed target"];
  if (summary.target.format !== undefined) parts.push(summary.target.format);
  if (summary.target.architecture !== undefined) parts.push(summary.target.architecture);
  return parts.join(" · ");
}

/** Twelve hex characters are enough to tell two builds apart in a row. */
export function shortDigest(sha256: string | undefined): string | undefined {
  if (sha256 === undefined || sha256 === "") return undefined;
  return sha256.length > 12 ? `${sha256.slice(0, 12)}…` : sha256;
}

export function describeCaseStats(summary: CaseSummary | undefined): string {
  if (summary === undefined) return "This folder has no readable report summary.";
  const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const parts = [plural(summary.turns, "turn"), plural(summary.observations, "observation")];
  if (summary.evidenceReferences > 0) parts.push(`${plural(summary.evidenceReferences, "evidence reference")}`);
  return parts.join(" · ");
}

export function caseDownloadName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;
}

/** Case-list search: name, target identity, scope, or digest prefix. */
export function filterSavedCases<T extends { name: string; summary?: CaseSummary }>(
  cases: ReadonlyArray<T>,
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...cases];
  return cases.filter((entry) =>
    [
      entry.name,
      entry.summary?.target.name ?? "",
      entry.summary?.target.path ?? "",
      entry.summary?.target.format ?? "",
      entry.summary?.target.architecture ?? "",
      entry.summary?.target.sha256 ?? "",
      entry.summary?.scope ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/** Says exactly what a delete will remove, so the confirmation is not vague. */
export function describeCaseDeletion(name: string, files: ReadonlyArray<{ name: string }>, workspaceDir: string): string {
  const folder = relativeToWorkspace(`${workspaceDir}/cases/${name}`, workspaceDir);
  const listed = files.length === 0 ? "the folder" : files.map((file) => file.name).join(", ");
  return `${folder} will be deleted, along with ${listed}. This cannot be undone.`;
}
