/**
 * Readers for saved case folders.
 *
 * A case folder is produced by `case.save`: `analysis.md`, `analysis.json`, and
 * optionally `evidence-bundle.json` written by REA. Reading one back means
 * trusting a file that may have been edited, truncated, or replaced by hand, so
 * every field is optional and a file that does not parse is reported as
 * unreadable rather than treated as an empty analysis.
 */

export interface CaseTargetSummary {
  readonly name?: string;
  readonly path?: string;
  readonly format?: string;
  readonly architecture?: string;
  readonly sha256?: string;
}

export interface CaseSummary {
  readonly schemaVersion?: number;
  readonly exportedAt?: string;
  readonly engineVersion?: string;
  readonly scope?: string;
  readonly target: CaseTargetSummary;
  /** Completed turns in the saved report. */
  readonly turns: number;
  /** Tool observations recorded across those turns. */
  readonly observations: number;
  /** Observations that carried an evidence id. */
  readonly evidenceReferences: number;
}

export interface BundleCounts {
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
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fill<K extends string, V>(key: K, value: V | undefined): {} | Record<K, V> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Summarises a saved `analysis.json` without trusting its shape.
 *
 * Returns `undefined` only when the text is not a JSON object at all; a report
 * with missing sections still yields a summary with zeroed counts, because that
 * is what the file honestly contains.
 */
export function readCaseSummary(text: string): CaseSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const report = asRecord(parsed);
  if (report === undefined) return undefined;

  const target = asRecord(report["target"]);
  const turns = Array.isArray(report["turns"]) ? report["turns"] : [];
  let observations = 0;
  let evidenceReferences = 0;
  for (const entry of turns) {
    const turn = asRecord(entry);
    const list = turn?.["observations"];
    if (!Array.isArray(list)) continue;
    observations += list.length;
    for (const observation of list) {
      if (str(asRecord(observation), "evidenceId") !== undefined) evidenceReferences += 1;
    }
  }

  return {
    ...fill("schemaVersion", num(report, "schemaVersion")),
    ...fill("exportedAt", str(report, "exportedAt")),
    ...fill("engineVersion", str(report, "engineVersion")),
    ...fill("scope", str(report, "scope")),
    target: {
      ...fill("name", str(target, "name")),
      ...fill("path", str(target, "path")),
      ...fill("format", str(target, "format")),
      ...fill("architecture", str(target, "architecture")),
      ...fill("sha256", str(target, "sha256")),
    },
    turns: turns.length,
    observations,
    evidenceReferences,
  };
}

/**
 * Counts what REA's exported bundle contains. The bundle is a byte-stable
 * document with array sections, so the counts come from the arrays that are
 * actually present rather than from a remembered total.
 */
export function readBundleCounts(text: string): BundleCounts | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const bundle = asRecord(parsed);
  if (bundle === undefined) return undefined;
  const records = Array.isArray(bundle["records"]) ? bundle["records"].length : 0;
  const unknowns = Array.isArray(bundle["unknowns"]) ? bundle["unknowns"].length : 0;
  return { records, unknowns };
}
