/**
 * One implementation of the case folder on disk.
 *
 * The desktop bridge and the headless CLI both expose "saved cases", and a case
 * written by one must be readable by the other. Rather than keep two copies of
 * the name rules, the permission bits, the conflict behaviour, and the
 * containment checks, both call this module. Anything that differs between the
 * two front ends (how the report text is produced, whether REA is connected to
 * write the bundle) stays with the caller.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { readBundleCounts, readCaseSummary, type CaseSummary } from "./report.js";

/** Per-document ceiling for a case file. */
export const CASE_DOCUMENT_MAX_CHARS = 2_000_000;
/** Newest cases offered to a caller; the folder itself may hold more. */
export const CASE_LIST_LIMIT = 25;
/** A report larger than this is not parsed for a one-line summary. */
export const CASE_SUMMARY_MAX_BYTES = 1_048_576;
/** A report larger than this is not returned in full. */
export const CASE_REPORT_MAX_CHARS = 4_000_000;

export const CASE_NAME_RULE = "1-80 characters of letters, digits, dot, dash, or underscore";
const CASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** Invalid input: the equivalent of JSON-RPC `-32602` and CLI exit code 2. */
export class CaseStoreError extends Error {
  public override readonly name = "CaseStoreError";
}

export interface CaseFile {
  readonly name: string;
  readonly bytes: number;
}

export interface CaseSaveResult {
  readonly ok: boolean;
  readonly name: string;
  readonly directory: string;
  readonly files: CaseFile[];
  /** Set when the save was refused, for example because the folder exists. */
  readonly error?: string;
}

export interface CaseListEntry {
  readonly name: string;
  readonly directory: string;
  readonly savedAt: string;
  readonly files: CaseFile[];
  readonly summary?: CaseSummary;
}

export interface CaseListResult {
  readonly casesRoot: string;
  readonly cases: CaseListEntry[];
  /** Number of cases on disk, which may exceed the returned entries. */
  readonly total: number;
}

export interface CaseOpenResult {
  readonly ok: boolean;
  readonly name: string;
  readonly directory?: string;
  readonly savedAt?: string;
  readonly files: CaseFile[];
  readonly summary?: CaseSummary;
  readonly report?: string;
  readonly reportTruncated?: boolean;
  readonly reportJson?: string;
  readonly jsonTruncated?: boolean;
  readonly bundle?: { path: string; bytes: number; records?: number; unknowns?: number };
  readonly error?: string;
}

export interface CaseDeleteResult {
  readonly ok: boolean;
  readonly name: string;
  readonly directory?: string;
  readonly error?: string;
}

export function casesRoot(workspaceDir: string): string {
  return resolve(workspaceDir, "cases");
}

/**
 * A case name is a directory name: bounded, no separators, no traversal. The
 * same rule applies to evidence export names, so both features reason about the
 * workspace identically.
 */
export function normalizeCaseName(raw: unknown, fallback: string): string {
  if (raw !== undefined && typeof raw !== "string") {
    throw new CaseStoreError('"name" must be a string when provided.');
  }
  const stem = (raw ?? fallback).trim().replace(/\.(json|md)$/i, "");
  if (!CASE_NAME_PATTERN.test(stem) || stem.includes("..")) {
    throw new CaseStoreError(`"name" must be ${CASE_NAME_RULE}.`);
  }
  return stem;
}

/** True when a name would be accepted, for callers that report rather than throw. */
export function isValidCaseName(name: string): boolean {
  return CASE_NAME_PATTERN.test(name) && !name.includes("..");
}

export function normalizeCaseDocument(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new CaseStoreError(`"${label}" must be a non-empty string.`);
  }
  if (raw.length > CASE_DOCUMENT_MAX_CHARS) {
    throw new CaseStoreError(`"${label}" exceeds the ${CASE_DOCUMENT_MAX_CHARS}-character limit.`);
  }
  return raw;
}

/** Default folder name when a caller does not supply one. */
export function defaultCaseName(now: Date = new Date()): string {
  return `case-${now.toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Writes `cases/<name>/analysis.md` and `analysis.json`.
 *
 * Returns `{ ok: false }` — rather than throwing — when the folder already
 * exists and `overwrite` is not set, because "someone already saved this" is an
 * answer a caller can act on, not a mistake in the call.
 */
export async function saveCase(options: {
  readonly workspaceDir: string;
  readonly name: unknown;
  readonly markdown: unknown;
  readonly json: unknown;
  readonly overwrite?: boolean;
}): Promise<CaseSaveResult> {
  const markdown = normalizeCaseDocument(options.markdown, "report");
  const json = normalizeCaseDocument(options.json, "reportJson");
  const stem = normalizeCaseName(options.name, defaultCaseName());

  const root = casesRoot(options.workspaceDir);
  const directory = resolve(root, stem);
  // The name rule already forbids separators; the resolved path is the property
  // that actually matters, so it is asserted too.
  if (directory !== join(root, stem) || !directory.startsWith(`${root}${sep}`)) {
    throw new CaseStoreError('"name" must not address a nested directory.');
  }

  const exists = await stat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (exists && options.overwrite !== true) {
    return {
      ok: false,
      name: stem,
      directory,
      files: [],
      error: `A case named "${stem}" already exists. Choose another name or allow overwrite.`,
    };
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const files: CaseFile[] = [];
  for (const [name, content] of [
    ["analysis.md", markdown],
    ["analysis.json", json],
  ] as const) {
    await writeFile(join(directory, name), content, { mode: 0o600 });
    files.push({ name, bytes: Buffer.byteLength(content) });
  }

  return { ok: true, name: stem, directory, files };
}

/** Records a file written by someone else (the engine's evidence bundle). */
export function withFile(files: readonly CaseFile[], name: string, bytes: number): CaseFile[] {
  return [...files.filter((file) => file.name !== name), { name, bytes }];
}

export async function caseFiles(directory: string): Promise<CaseFile[]> {
  const names = await readdir(directory).catch((): string[] => []);
  const files: CaseFile[] = [];
  for (const name of names.sort()) {
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    files.push({ name, bytes: info.size });
  }
  return files;
}

/** Resolves an existing case folder, refusing anything outside the cases root. */
export async function resolveCaseDirectory(workspaceDir: string, name: string): Promise<string | undefined> {
  if (!isValidCaseName(name)) return undefined;
  const root = casesRoot(workspaceDir);
  const directory = resolve(root, name);
  if (directory === root || !directory.startsWith(`${root}${sep}`)) return undefined;
  const info = await stat(directory).catch(() => undefined);
  return info?.isDirectory() === true ? directory : undefined;
}

/**
 * Lists saved cases newest first. Only directories with both report files are
 * described as cases, so a stray folder cannot look like one. Where the report
 * is small enough to read, its summary is included so the list says what the
 * case is about instead of only its name.
 */
export async function listCases(
  workspaceDir: string,
  limit = CASE_LIST_LIMIT,
): Promise<CaseListResult> {
  const root = casesRoot(workspaceDir);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const cases: CaseListEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const files = await caseFiles(directory);
    const reportFile = files.find((file) => file.name === "analysis.json");
    if (reportFile === undefined) continue;
    if (!files.some((file) => file.name === "analysis.md")) continue;

    const report =
      reportFile.bytes <= CASE_SUMMARY_MAX_BYTES
        ? readCaseSummary(await readFile(join(directory, "analysis.json"), "utf8").catch(() => ""))
        : undefined;
    const savedAt = new Date((await stat(directory).catch(() => undefined))?.mtimeMs ?? Date.now()).toISOString();

    cases.push({
      name: entry.name,
      directory,
      savedAt,
      files,
      ...(report === undefined ? {} : { summary: report }),
    });
  }

  cases.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  return { casesRoot: root, cases: cases.slice(0, Math.max(0, limit)), total: cases.length };
}

/**
 * Reads a saved case back: the Markdown report, the JSON companion, and the
 * counts from REA's bundle if one was written. Nothing is re-derived; the file
 * either parses or the result says why it does not.
 */
export async function openCase(workspaceDir: string, name: string): Promise<CaseOpenResult> {
  const directory = await resolveCaseDirectory(workspaceDir, name);
  if (directory === undefined) {
    return { ok: false, name, files: [], error: `No saved case named "${name}" in this workspace.` };
  }

  const files = await caseFiles(directory);
  if (!files.some((file) => file.name === "analysis.json")) {
    return { ok: false, name, directory, files, error: "This folder has no analysis.json, so it is not a readable case." };
  }

  const readText = async (file: string): Promise<string | undefined> =>
    await readFile(join(directory, file), "utf8").catch(() => undefined);
  const reportJson = await readText("analysis.json");
  if (reportJson === undefined) {
    return { ok: false, name, directory, files, error: "analysis.json could not be read." };
  }
  const summary = readCaseSummary(reportJson);
  if (summary === undefined) {
    return { ok: false, name, directory, files, error: "analysis.json is not valid JSON, so this case cannot be read." };
  }

  const report = await readText("analysis.md");
  const truncated = report !== undefined && report.length > CASE_REPORT_MAX_CHARS;
  const bundleFile = files.find((file) => file.name === "evidence-bundle.json");
  const bundle =
    bundleFile === undefined
      ? undefined
      : {
        path: join(directory, "evidence-bundle.json"),
        bytes: bundleFile.bytes,
        ...(readBundleCounts((await readText("evidence-bundle.json")) ?? "") ?? {}),
      };

  return {
    ok: true,
    name,
    directory,
    savedAt: new Date((await stat(directory).catch(() => undefined))?.mtimeMs ?? Date.now()).toISOString(),
    files,
    summary,
    ...(report === undefined ? {} : { report: truncated ? report.slice(0, CASE_REPORT_MAX_CHARS) : report }),
    reportTruncated: truncated,
    reportJson: reportJson.length > CASE_REPORT_MAX_CHARS ? reportJson.slice(0, CASE_REPORT_MAX_CHARS) : reportJson,
    jsonTruncated: reportJson.length > CASE_REPORT_MAX_CHARS,
    ...(bundle === undefined ? {} : { bundle }),
  };
}

/** Removes one case folder. Never the cases root, never a plain file. */
export async function deleteCase(workspaceDir: string, name: string): Promise<CaseDeleteResult> {
  const directory = await resolveCaseDirectory(workspaceDir, name);
  if (directory === undefined) {
    return { ok: false, name, error: `No saved case named "${name}" in this workspace.` };
  }
  try {
    await rm(directory, { recursive: true, force: false, maxRetries: 2 });
  } catch (error) {
    return { ok: false, name, directory, error: `The case folder could not be removed: ${(error as Error).message}` };
  }
  return { ok: true, name, directory };
}
