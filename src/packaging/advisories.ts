/**
 * Advisory assessment for the shipped dependency tree.
 *
 * `npm audit` reports a vulnerability when a package *version* falls inside an
 * advisory range. For a bundled desktop app that is the wrong question. What
 * matters is whether the vulnerable code is reachable with input an attacker
 * controls — a vulnerable package on a path no attacker can drive is a
 * paperwork problem, and a vulnerable package on the parse path of an untrusted
 * binary is not.
 *
 * This module answers both:
 *
 *   1. Which installed copies of a dependency are affected? (Exact resolution,
 *      not the top-level hoisted version — the vulnerable copy is often nested.)
 *   2. Is the vulnerable code path reachable from untrusted input? (Assessed
 *      against the live tool surface for the specific weakness class.)
 *
 * Verdicts are deliberately three-valued. "Undetermined" is a correct answer
 * when the evidence does not settle it, and is far better than a false all-clear.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpToolDefinition } from "../mcp/types.js";
import { SemverError, satisfiesRange } from "./semver.js";

// ---------------------------------------------------------------------------
// Advisory source
// ---------------------------------------------------------------------------

export interface Advisory {
  readonly id: string;
  readonly severity: "low" | "moderate" | "medium" | "high" | "critical";
  readonly summary: string;
  readonly cveId?: string;
  readonly url?: string;
  /** Version range the advisory marks vulnerable, e.g. "< 4.6.6". */
  readonly vulnerableRange: string;
  readonly patchedVersion?: string;
  readonly description?: string;
}

export class AdvisoryError extends Error {
  public override readonly name = "AdvisoryError";
  public readonly status: number | undefined;

  public constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface AdvisorySourceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Restricts severity at the source, e.g. "high". */
  readonly severity?: string;
}

const DEFAULT_ADVISORY_API = "https://api.github.com/advisories";

interface RawAdvisory {
  ghsa_id?: string;
  cve_id?: string | null;
  severity?: string;
  summary?: string;
  description?: string;
  html_url?: string;
  vulnerabilities?: Array<{
    package?: { name?: string; ecosystem?: string };
    vulnerable_version_range?: string;
    first_patched_version?: string | null;
  }>;
}

/**
 * Looks up npm advisories for one package.
 *
 * Uses the GitHub Advisory Database, which is the API reachable from the build
 * environment. Returns an empty list when the service says "none" — but throws
 * on a transport or status failure, so a network problem can never be mistaken
 * for "no vulnerabilities".
 */
export async function fetchAdvisories(
  packageName: string,
  options: AdvisorySourceOptions = {},
): Promise<Advisory[]> {
  const base = options.baseUrl ?? DEFAULT_ADVISORY_API;
  const url = new URL(base);
  url.searchParams.set("ecosystem", "npm");
  url.searchParams.set("affects", packageName);
  url.searchParams.set("per_page", "100");
  if (options.severity !== undefined) url.searchParams.set("severity", options.severity);

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AdvisoryError(`Could not query advisories for ${packageName}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new AdvisoryError(
      `Advisory service returned HTTP ${String(response.status)} for ${packageName}`,
      response.status,
    );
  }

  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new AdvisoryError(`Advisory service returned an unexpected payload for ${packageName}`);
  }

  // One advisory can cover several packages; the normalizer keeps only the
  // ranges that name the package we asked about.
  return normalizeAdvisoryPayload(body, packageName, "advisory service");
}

function normalizeSeverity(raw: string | undefined): Advisory["severity"] {
  switch ((raw ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "medium";
  }
}

/**
 * Reads advisories from a JSON file.
 *
 * Accepts either the GitHub API payload or a list of already-normalised
 * advisories. An air-gapped deployment has no route to an advisory service, so
 * the reference data has to be shippable — and a recorded file makes a security
 * review reproducible even when the network answer would have changed.
 */
export async function loadAdvisoriesFromFile(
  filePath: string,
  packageName?: string,
): Promise<Advisory[]> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AdvisoryError(`${filePath} is not valid JSON: ${(error as Error).message}`);
  }
  return normalizeAdvisoryPayload(parsed, packageName, filePath);
}

/** Normalizes a GitHub advisory payload or a list of advisories. */
export function normalizeAdvisoryPayload(
  payload: unknown,
  packageName?: string,
  origin = "advisory payload",
): Advisory[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { advisories?: unknown }).advisories)
      ? ((payload as { advisories: unknown[] }).advisories)
      : undefined;

  if (list === undefined) {
    throw new AdvisoryError(
      `${origin} must be an array of advisories, or an object with an "advisories" array`,
    );
  }

  const advisories: Advisory[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as RawAdvisory & Partial<Advisory> & { vulnerable_range?: string };

    // Already-normalised shape.
    const normalizedRange = record.vulnerableRange ?? record.vulnerable_range;
    if (normalizedRange !== undefined) {
      advisories.push({
        id: record.id ?? record.ghsa_id ?? "unknown",
        severity: normalizeSeverity(record.severity),
        summary: record.summary ?? record.id ?? "advisory",
        vulnerableRange: normalizedRange,
        ...(record.cveId === undefined ? {} : { cveId: record.cveId }),
        ...(record.url === undefined ? {} : { url: record.url }),
        ...(record.patchedVersion === undefined ? {} : { patchedVersion: record.patchedVersion }),
        ...(record.description === undefined ? {} : { description: record.description }),
      });
      continue;
    }

    // GitHub API shape.
    for (const vulnerability of record.vulnerabilities ?? []) {
      if (vulnerability.package?.ecosystem !== "npm") continue;
      const name = vulnerability.package.name;
      if (packageName !== undefined && name !== packageName) continue;
      const range = vulnerability.vulnerable_version_range;
      if (range === undefined || range === "") continue;

      advisories.push({
        id: record.ghsa_id ?? "unknown",
        severity: normalizeSeverity(record.severity),
        summary: record.summary ?? record.ghsa_id ?? "advisory",
        vulnerableRange: range,
        ...(record.cve_id === undefined || record.cve_id === null ? {} : { cveId: record.cve_id }),
        ...(record.html_url === undefined ? {} : { url: record.html_url }),
        ...(record.description === undefined ? {} : { description: record.description }),
        ...(vulnerability.first_patched_version === undefined ||
        vulnerability.first_patched_version === null
          ? {}
          : { patchedVersion: vulnerability.first_patched_version }),
      });
    }
  }

  return advisories;
}

export const SEVERITY_ORDER: readonly Advisory["severity"][] = [
  "low",
  "medium",
  "high",
  "critical",
];

export function severityAtLeast(
  severity: Advisory["severity"],
  threshold: Advisory["severity"],
): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);
}

// ---------------------------------------------------------------------------
// Installed copies
// ---------------------------------------------------------------------------

export interface InstalledCopy {
  /** Path relative to the project root, e.g. "node_modules/rea-agents/node_modules/zod". */
  readonly path: string;
  readonly version: string;
  /** Packages that depend on this copy, for attributing why it is present. */
  readonly requiredBy: readonly string[];
}

interface LockfileEntry {
  version?: string;
  resolved?: string;
  dependencies?: Record<string, string>;
}

/**
 * Enumerates every installed copy of a package from `package-lock.json`.
 *
 * Reads the lockfile rather than the tree so *nested* copies are found. That
 * matters here: the vulnerable copy of a dependency is frequently the nested
 * one pinned by a single consumer, while the hoisted copy everyone else shares
 * is already patched. Reporting only the hoisted version would be wrong.
 */
export async function installedCopies(
  packageName: string,
  projectRoot: string,
): Promise<InstalledCopy[]> {
  const raw = await readFile(join(projectRoot, "package-lock.json"), "utf8");
  let parsed: { packages?: Record<string, LockfileEntry> };
  try {
    parsed = JSON.parse(raw) as { packages?: Record<string, LockfileEntry> };
  } catch (error) {
    throw new AdvisoryError(`package-lock.json is not valid JSON: ${(error as Error).message}`);
  }

  const packages = parsed.packages ?? {};
  const copies: InstalledCopy[] = [];

  for (const [path, entry] of Object.entries(packages)) {
    if (path === "") continue;
    // A top-level entry is "node_modules/<name>" with no leading separator, so
    // split on "node_modules/" rather than "/node_modules/" to catch both.
    const segments = path.split("node_modules/");
    const leaf = segments[segments.length - 1];
    if (leaf !== packageName) continue;
    if (entry.version === undefined) continue;

    copies.push({
      path,
      version: entry.version,
      requiredBy: [],
    });
  }

  // Attribute each copy to the nearest enclosing package that depends on it.
  for (const copy of copies) {
    const parentPath = copy.path.slice(0, copy.path.lastIndexOf("/node_modules/"));
    const candidates = [
      parentPath === "" ? "" : parentPath,
      "",
    ];
    for (const candidate of candidates) {
      const parent = packages[candidate];
      if (parent?.dependencies?.[packageName] === undefined) continue;
      const name = candidate === ""
        ? "(root)"
        : (packages[candidate] as { name?: string }).name ?? candidate;
      (copy.requiredBy as string[]).push(name);
      break;
    }
  }

  copies.sort((a, b) => (a.path < b.path ? -1 : 1));
  return copies;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/** A place in the tool surface where an unbounded array can be supplied. */
export interface ArraySurfaceHit {
  readonly tool: string;
  /** Dotted path to the parameter inside the input schema. */
  readonly path: string;
  readonly bounded: boolean;
}

export interface ArraySurface {
  readonly totalArrayParameters: number;
  readonly unbounded: readonly ArraySurfaceHit[];
  readonly bounded: readonly ArraySurfaceHit[];
}

/**
 * Finds array-typed parameters in the advertised tool schemas.
 *
 * `maxItems` is the JSON Schema projection of zod's `.max()`. Its absence is
 * evidence that the canonical schema has no length constraint, which is the
 * precondition for the unbounded-issue-accumulation weakness. It is evidence,
 * not proof: the advertised schema is a projection, so a missing `maxItems`
 * cannot distinguish "no bound" from "bound not projected".
 */
export function analyzeArraySurface(tools: readonly McpToolDefinition[]): ArraySurface {
  const hits: ArraySurfaceHit[] = [];

  const walk = (node: unknown, tool: string, path: string): void => {
    if (typeof node !== "object" || node === null) return;
    const schema = node as Record<string, unknown>;

    if (schema["type"] === "array") {
      hits.push({ tool, path: path === "" ? "(root)" : path, bounded: schema["maxItems"] !== undefined });
    }

    const properties = schema["properties"];
    if (typeof properties === "object" && properties !== null) {
      for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
        walk(value, tool, path === "" ? key : `${path}.${key}`);
      }
    }

    for (const key of ["items", "additionalProperties"] as const) {
      if (schema[key] !== undefined) walk(schema[key], tool, `${path}<${key}>`);
    }

    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const variants = schema[key];
      if (Array.isArray(variants)) {
        variants.forEach((value, index) => {
          walk(value, tool, `${path}<${key}[${String(index)}]>`);
        });
      }
    }

    const defs = schema["$defs"];
    if (typeof defs === "object" && defs !== null) {
      for (const [name, value] of Object.entries(defs as Record<string, unknown>)) {
        walk(value, tool, `${path}<$defs.${name}>`);
      }
    }
  };

  for (const tool of tools) walk(tool.inputSchema, tool.name, "");

  return {
    totalArrayParameters: hits.length,
    unbounded: hits.filter((hit) => !hit.bounded),
    bounded: hits.filter((hit) => hit.bounded),
  };
}

export type ReachabilityVerdict = "reachable" | "not-reachable" | "undetermined";

export interface AdvisoryAssessment {
  readonly advisory: Advisory;
  /** Installed copies whose version falls inside the advisory range. */
  readonly affectedCopies: readonly InstalledCopy[];
  /** Copies that are installed but already patched. */
  readonly unaffectedCopies: readonly InstalledCopy[];
  readonly verdict: ReachabilityVerdict;
  readonly rationale: string;
  /** Tool-surface evidence behind the verdict, when the weakness class uses it. */
  readonly surface?: ArraySurface;
}

/** Weakness classes this tool can reason about specifically. */
const UNBOUNDED_ARRAY_MARKERS = [
  "oversized constrained collections",
  "uncontrolled resource consumption",
  "array validation",
];

function isUnboundedArrayWeakness(advisory: Advisory): boolean {
  const haystack = `${advisory.summary} ${advisory.description ?? ""}`.toLowerCase();
  return UNBOUNDED_ARRAY_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Assesses advisories against installed copies and, where the weakness class is
 * understood, against the live tool surface.
 *
 * `tools` may be omitted; without it the verdict stays `undetermined` for
 * weakness classes that need surface evidence rather than guessing.
 */
export function assessAdvisories(
  advisories: readonly Advisory[],
  copies: readonly InstalledCopy[],
  tools?: readonly McpToolDefinition[],
): AdvisoryAssessment[] {
  const surface = tools === undefined ? undefined : analyzeArraySurface(tools);

  return advisories.map((advisory) => {
    const affected: InstalledCopy[] = [];
    const unaffected: InstalledCopy[] = [];

    for (const copy of copies) {
      let inRange: boolean;
      try {
        inRange = satisfiesRange(copy.version, advisory.vulnerableRange);
      } catch (error) {
        if (!(error instanceof SemverError)) throw error;
        // An unreadable range must not be reported as "safe".
        affected.push(copy);
        continue;
      }
      (inRange ? affected : unaffected).push(copy);
    }

    if (affected.length === 0) {
      return {
        advisory,
        affectedCopies: [],
        unaffectedCopies: unaffected,
        verdict: "not-reachable" as const,
        rationale:
          `No installed copy falls inside ${advisory.vulnerableRange}; ` +
          `${unaffected.map((copy) => `${copy.path}@${copy.version}`).join(", ") || "none installed"} already outside the range.`,
      };
    }

    const affectedList = affected.map((copy) => `${copy.path}@${copy.version}`).join(", ");

    if (!isUnboundedArrayWeakness(advisory)) {
      return {
        advisory,
        affectedCopies: affected,
        unaffectedCopies: unaffected,
        verdict: "undetermined" as const,
        rationale:
          `Affected: ${affectedList}. This weakness class is not modelled by this ` +
          `tool, so reachability is not assessed. Treat as reachable until reviewed.`,
      };
    }

    if (surface === undefined) {
      return {
        advisory,
        affectedCopies: affected,
        unaffectedCopies: unaffected,
        verdict: "undetermined" as const,
        rationale:
          `Affected: ${affectedList}. The tool surface was not supplied, so the ` +
          `unbounded-array precondition could not be checked.`,
      };
    }

    if (surface.unbounded.length === 0) {
      return {
        advisory,
        affectedCopies: affected,
        unaffectedCopies: unaffected,
        verdict: "not-reachable" as const,
        rationale:
          `Affected: ${affectedList}, but every one of the ${String(surface.totalArrayParameters)} ` +
          `array parameters in the tool surface declares maxItems, so the unbounded-array ` +
          `precondition is absent.`,
        surface,
      };
    }

    const example = surface.unbounded
      .slice(0, 3)
      .map((hit) => `${hit.tool}.${hit.path}`)
      .join(", ");

    return {
      advisory,
      affectedCopies: affected,
      unaffectedCopies: unaffected,
      verdict: "reachable" as const,
      rationale:
        `Affected: ${affectedList}. ${String(surface.unbounded.length)} of ` +
        `${String(surface.totalArrayParameters)} array parameters in the tool surface are ` +
        `unbounded (e.g. ${example}), so a large array can reach the vulnerable validation ` +
        `path. The caller is normally the local model, which a hostile target can try to ` +
        `steer via injected strings — so the input is not trusted.`,
      surface,
    };
  });
}

/**
 * A finding whose risk has been reviewed and accepted.
 *
 * Accepting needs a stated mitigation and a review date. A bare suppression
 * list is how real regressions get buried, so the shape forces the reasoning to
 * be written down and revisited.
 */
export interface KnownFinding {
  readonly id: string;
  readonly package: string;
  readonly rationale: string;
  readonly mitigation: string;
  /** ISO date the acceptance was last reviewed. */
  readonly reviewedAt: string;
  /** ISO date by which it must be revisited. */
  readonly reviewBy?: string;
}

/** Reads accepted findings from a JSON file. */
export async function loadKnownFindings(filePath: string): Promise<KnownFinding[]> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AdvisoryError(`${filePath} is not valid JSON: ${(error as Error).message}`);
  }

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { accepted?: unknown }).accepted)
      ? ((parsed as { accepted: unknown[] }).accepted)
      : undefined;

  if (list === undefined) {
    throw new AdvisoryError(`${filePath} must contain an array, or an object with an "accepted" array`);
  }

  const findings: KnownFinding[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const pkg = record["package"];
    const rationale = record["rationale"];
    const mitigation = record["mitigation"];
    const reviewedAt = record["reviewedAt"];

    if (typeof id !== "string" || typeof pkg !== "string") {
      throw new AdvisoryError(`${filePath}: every accepted finding needs "id" and "package"`);
    }
    if (typeof rationale !== "string" || rationale.trim() === "") {
      throw new AdvisoryError(`${filePath}: ${id} needs a non-empty "rationale"`);
    }
    if (typeof mitigation !== "string" || mitigation.trim() === "") {
      throw new AdvisoryError(`${filePath}: ${id} needs a non-empty "mitigation"`);
    }
    if (typeof reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)) {
      throw new AdvisoryError(`${filePath}: ${id} needs "reviewedAt" as YYYY-MM-DD`);
    }

    findings.push({
      id,
      package: pkg,
      rationale,
      mitigation,
      reviewedAt,
      ...(typeof record["reviewBy"] === "string" ? { reviewBy: record["reviewBy"] } : {}),
    });
  }
  return findings;
}

export interface AdvisoryReport {
  readonly package: string;
  readonly copies: readonly InstalledCopy[];
  readonly assessments: readonly AdvisoryAssessment[];
  readonly reachable: readonly AdvisoryAssessment[];
  readonly undetermined: readonly AdvisoryAssessment[];
  /** True when nothing reachable meets the denial threshold. */
  /**
   * True only when nothing is reachable OR undetermined at or above the denial
   * threshold. "Could not determine" is not a pass.
   */
  readonly ok: boolean;
  /** Set when the advisory lookup itself failed; the report is then incomplete. */
  readonly lookupError?: string;
  /** Why the tool surface was unavailable, when it was needed but missing. */
  readonly surfaceUnavailableReason?: string;
  /** Findings reviewed and accepted, with their mitigations. */
  readonly accepted?: readonly { readonly assessment: AdvisoryAssessment; readonly finding: KnownFinding }[];
  /** Accepted findings whose review date has passed. */
  readonly overdueReviews?: readonly string[];
  /**
   * Findings that actually block the gate, after severity, acceptance and any
   * `allowUndetermined` setting are applied. Callers must key their exit code
   * off this, not off `reachable`/`undetermined`, or they will silently undo
   * the gate.
   */
  readonly blocking: readonly AdvisoryAssessment[];
}

export interface AssessOptions {
  readonly projectRoot: string;
  readonly packageName: string;
  readonly tools?: readonly McpToolDefinition[];
  readonly denySeverity?: Advisory["severity"];
  readonly fetchImpl?: typeof fetch;
  readonly advisoryBaseUrl?: string;
  /** Offline advisory data; skips the network lookup entirely when set. */
  readonly advisoriesFile?: string;
  /**
   * Let an undetermined verdict at or above the threshold pass. Off by default:
   * a security gate that treats "could not check" as success is worse than no
   * gate, because it reports green while the question is open.
   */
  readonly allowUndetermined?: boolean;
  /** Recorded so an undetermined verdict can explain itself. */
  readonly surfaceUnavailableReason?: string;
  /** Findings already reviewed and accepted; everything else still blocks. */
  readonly knownFindings?: readonly KnownFinding[];
}

/**
 * Full assessment for one dependency.
 *
 * A failed lookup produces a report with `lookupError` set and `ok: false`,
 * because "could not check" must never read as "clean".
 */
export async function assessDependency(options: AssessOptions): Promise<AdvisoryReport> {
  const copies = await installedCopies(options.packageName, options.projectRoot);

  let advisories: Advisory[];
  try {
    advisories =
      options.advisoriesFile === undefined
        ? await fetchAdvisories(options.packageName, {
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
            ...(options.advisoryBaseUrl === undefined ? {} : { baseUrl: options.advisoryBaseUrl }),
          })
        : await loadAdvisoriesFromFile(options.advisoriesFile, options.packageName);
  } catch (error) {
    return {
      package: options.packageName,
      copies,
      assessments: [],
      reachable: [],
      undetermined: [],
      blocking: [],
      ok: false,
      lookupError: (error as Error).message,
    };
  }

  const assessments = assessAdvisories(advisories, copies, options.tools);
  const threshold = options.denySeverity ?? "high";

  // Only advisories that actually affect an installed copy can block. An
  // advisory for a version range nothing uses is noise regardless of verdict.
  const material = assessments.filter((assessment) => assessment.affectedCopies.length > 0);
  const reachable = material.filter(
    (assessment) =>
      assessment.verdict === "reachable" &&
      severityAtLeast(assessment.advisory.severity, threshold),
  );
  const undetermined = material.filter(
    (assessment) =>
      assessment.verdict === "undetermined" &&
      severityAtLeast(assessment.advisory.severity, threshold),
  );

  const candidateBlocking =
    options.allowUndetermined === true ? reachable : [...reachable, ...undetermined];

  const known = options.knownFindings ?? [];
  const accepted: { assessment: AdvisoryAssessment; finding: KnownFinding }[] = [];
  const blocking: AdvisoryAssessment[] = [];

  for (const assessment of candidateBlocking) {
    const finding = known.find(
      (entry) => entry.id === assessment.advisory.id && entry.package === options.packageName,
    );
    if (finding === undefined) blocking.push(assessment);
    else accepted.push({ assessment, finding });
  }

  // An acceptance older than its own review date is a stale decision, not a
  // standing one -- surface it rather than letting it pass quietly.
  const today = new Date().toISOString().slice(0, 10);
  const overdueReviews = accepted
    .filter((entry) => entry.finding.reviewBy !== undefined && entry.finding.reviewBy < today)
    .map((entry) => `${entry.finding.id} (review by ${entry.finding.reviewBy ?? "?"})`);

  return {
    package: options.packageName,
    copies,
    assessments,
    reachable,
    undetermined,
    ...(accepted.length === 0 ? {} : { accepted }),
    ...(overdueReviews.length === 0 ? {} : { overdueReviews }),
    blocking,
    ok: blocking.length === 0,
    ...(options.surfaceUnavailableReason === undefined
      ? {}
      : { surfaceUnavailableReason: options.surfaceUnavailableReason }),
  };
}
