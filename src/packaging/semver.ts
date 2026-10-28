/**
 * Minimal semantic-version range matching.
 *
 * Why hand-rolled: the shipped bundle has one runtime dependency by design, and
 * a full semver implementation is far more surface than this needs. Advisory
 * ranges use a small subset of the grammar — `< 4.6.6`, `<= 3.22.2`,
 * `>= 1.0.0 < 2.0.0`, `||` for alternatives — so only that subset is supported.
 *
 * The important property is *conservatism*: when a range cannot be understood,
 * matching throws rather than returning false. A vulnerability scanner that
 * silently reports "not affected" because it misparsed a range is worse than
 * one that refuses to answer.
 */

export class SemverError extends Error {
  public override readonly name = "SemverError";
}

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated pre-release identifiers, e.g. ["rc", "1"]. Empty for a release. */
  readonly prerelease: readonly string[];
}

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses `1.2.3`, `v1.2.3`, `1.2.3-rc.1`. Build metadata is ignored. */
export function parseSemver(input: string): Semver {
  const match = VERSION_PATTERN.exec(input.trim());
  if (match === null) {
    throw new SemverError(`Not a semantic version: ${JSON.stringify(input)}`);
  }
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number.parseInt(major ?? "0", 10),
    minor: Number.parseInt(minor ?? "0", 10),
    patch: Number.parseInt(patch ?? "0", 10),
    prerelease: prerelease === undefined || prerelease === "" ? [] : prerelease.split("."),
  };
}

export function isValidSemver(input: string): boolean {
  return VERSION_PATTERN.test(input.trim());
}

export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // A release outranks any pre-release of the same version.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      return Number.parseInt(left, 10) < Number.parseInt(right, 10) ? -1 : 1;
    }
    // Numeric identifiers sort before alphanumeric ones.
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

type Operator = "<" | "<=" | ">" | ">=" | "=";

interface Comparator {
  readonly operator: Operator;
  readonly version: Semver;
}

/**
 * Parses one comparator such as `< 4.6.6` or `>=1.0.0`.
 *
 * A bare version means exact equality. A partial version (`4.6`) is rejected
 * rather than guessed at, because npm's `4.6` means `4.6.x` and silently
 * treating it as `4.6.0` would under-report.
 */
function parseComparator(raw: string): Comparator {
  const text = raw.trim();
  if (text === "") throw new SemverError("Empty comparator");

  const match = /^(<=|>=|<|>|=)?\s*(.+)$/.exec(text);
  if (match === null) throw new SemverError(`Unparseable comparator: ${JSON.stringify(raw)}`);

  const operator = (match[1] ?? "=") as Operator;
  const versionText = (match[2] ?? "").trim();

  if (!/^\d+\.\d+\.\d+/.test(versionText)) {
    throw new SemverError(
      `Unsupported version form in comparator ${JSON.stringify(raw)}: ` +
        `only full x.y.z versions are supported`,
    );
  }

  return { operator, version: parseSemver(versionText) };
}

/** Splits a range on whitespace-separated comparators within one alternative. */
function parseComparatorSet(raw: string): Comparator[] {
  const text = raw.trim();
  if (text === "") throw new SemverError("Empty range");

  // Hyphen range: "1.2.3 - 2.3.4" is inclusive on both ends.
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen !== null) {
    return [
      { operator: ">=", version: parseSemver(hyphen[1] ?? "") },
      { operator: "<=", version: parseSemver(hyphen[2] ?? "") },
    ];
  }

  // ">=1.0.0 <2.0.0" and ">= 1.0.0" both appear in the wild.
  const tokens = text.replace(/(<=|>=|<|>|=)\s+/g, "$1").split(/\s+/).filter(Boolean);
  return tokens.map((token) => parseComparator(token));
}

function satisfiesComparator(version: Semver, comparator: Comparator): boolean {
  const order = compareSemver(version, comparator.version);
  switch (comparator.operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "=":
      return order === 0;
  }
}

/**
 * True when `version` falls inside `range`.
 *
 * Supports comparator sets joined by `||`, and a wildcard `*` meaning "any".
 *
 * @throws {SemverError} when the range or version cannot be understood.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  const text = range.trim();

  if (text === "" || text === "*" || text === "x" || text === "any") return true;

  const alternatives = text.split("||");
  for (const alternative of alternatives) {
    const comparators = parseComparatorSet(alternative);
    if (comparators.every((comparator) => satisfiesComparator(parsed, comparator))) {
      return true;
    }
  }
  return false;
}
