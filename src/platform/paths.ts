/**
 * Target-path canonicalization for REA tool calls.
 *
 * Why this module exists:
 *
 * REA validates `open_binary.path` / `inspect_pe_imports.path` as an *absolute*
 * local filesystem path and rejects relative input outright. On Windows the
 * shell, the file dialog, drag-and-drop, and `\\?\`-prefixed APIs each hand the
 * client a different spelling of the same file. Feeding those spellings
 * straight through produces three classes of failure:
 *
 *   1. Relative or drive-relative paths (`.\a.exe`, `C:a.exe`) are rejected.
 *   2. Extended-length prefixes (`\\?\C:\a.exe`, `\??\C:\a.exe`,
 *      `\\?\UNC\srv\share\a.exe`) are valid Win32 but not recognized as an
 *      ordinary absolute path by path handling that expects a drive letter.
 *   3. Mixed separators make equality checks, cache keys, and "already open"
 *      tests fail for the same underlying file.
 *
 * `canonicalizeTargetPath` resolves all three to a single stable spelling that
 * is safe to send to REA and safe to use as a cache key.
 */

import { pathToFileURL } from "node:url";
import { win32 as pathWin32, posix as pathPosix } from "node:path";

export type PathPlatform = "windows" | "posix";

export class TargetPathError extends Error {
  public override readonly name = "TargetPathError";
  public readonly code:
    | "empty"
    | "invalid_character"
    | "relative_path"
    | "unsupported_url";

  public constructor(code: TargetPathError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface CanonicalizeOptions {
  readonly platform?: PathPlatform;
  /**
   * Base directory for relative input. When omitted (the default) relative
   * paths are rejected, matching REA's own contract instead of silently
   * guessing an origin.
   */
  readonly resolveRelativeTo?: string;
  /** Separator style in the returned path. Defaults to the target platform's. */
  readonly style?: "native" | "forward";
}

const EXTENDED_PREFIX = /^\\\\[?.]\\/;
const NT_OBJECT_PREFIX = /^\\\?\?\\/;
const UNC_EXTENDED_PREFIX = /^\\\\[?.]\\UNC\\/i;

/**
 * Strips Win32 extended-length / NT object prefixes.
 *
 * `\\?\C:\x`   -> `C:\x`
 * `\\?\UNC\srv\share\x` -> `\\srv\share\x`
 * `\??\C:\x`   -> `C:\x`
 */
function stripWin32Prefixes(input: string): string {
  if (UNC_EXTENDED_PREFIX.test(input)) {
    return `\\\\${input.slice("\\\\?\\UNC\\".length)}`;
  }
  if (EXTENDED_PREFIX.test(input)) {
    return input.slice(4);
  }
  return input;
}

/**
 * Converts a `file:` URL to a path for the *target* platform.
 *
 * Deliberately not `fileURLToPath`: that helper is host-platform aware, so on a
 * POSIX host `file:///C:/x` becomes `/C:/x` and a Windows-target build would
 * then treat it as a root-relative path.
 */
function fromFileUrl(input: string, platform: PathPlatform): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TargetPathError(
      "unsupported_url",
      `Cannot parse ${JSON.stringify(input)} as a file URL.`,
    );
  }

  if (url.protocol !== "file:") {
    throw new TargetPathError(
      "unsupported_url",
      `Unsupported URL scheme in ${JSON.stringify(input)}. Only file:// URLs are accepted.`,
    );
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new TargetPathError("unsupported_url", `Malformed percent-encoding in ${JSON.stringify(input)}.`);
  }

  const host = url.hostname;
  const isLocalHost = host === "" || host === "localhost";

  if (platform === "posix") {
    return isLocalHost ? pathname : `//${host}${pathname}`;
  }

  if (!isLocalHost) {
    // file://server/share/x -> \\server\share\x
    return `\\\\${host}${pathname.replace(/\//g, "\\")}`;
  }

  // file:///C:/x -> C:\x ; file:///x stays root-relative and is rejected later.
  const withoutLeadingSlash = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const driveForm = /^[a-zA-Z]:/.test(withoutLeadingSlash)
    ? withoutLeadingSlash
    : pathname;
  return driveForm.replace(/\//g, "\\");
}

function hasForeignScheme(input: string): boolean {
  // `file:` is handled explicitly; a single letter before ':' is a drive letter.
  if (/^file:/i.test(input)) return false;
  return /^[a-z][a-z0-9+.-]+:\/\//i.test(input);
}

/**
 * Canonicalizes a user-supplied analysis target path.
 *
 * @throws {TargetPathError} when the input cannot be made absolute.
 */
export function canonicalizeTargetPath(
  input: string,
  options: CanonicalizeOptions = {},
): string {
  const platform = options.platform ?? "windows";
  const style = options.style ?? "native";

  if (hasForeignScheme(input)) {
    throw new TargetPathError(
      "unsupported_url",
      `Unsupported URL scheme in ${JSON.stringify(input)}. Service and network locations must be mapped to a local path first.`,
    );
  }

  let value = input.trim();

  if (value === "") {
    throw new TargetPathError("empty", "Target path is empty.");
  }
  if (value.includes("\u0000")) {
    throw new TargetPathError(
      "invalid_character",
      "Target path contains a NUL byte.",
    );
  }
  if (/^file:/i.test(value)) {
    value = fromFileUrl(value, platform);
  }

  const pathImpl = platform === "windows" ? pathWin32 : pathPosix;

  if (platform === "windows") {
    value = stripWin32Prefixes(NT_OBJECT_PREFIX.test(value) ? value.slice(4) : value);
    // Windows accepts '/' everywhere; normalize early so drive-relative
    // detection and absolute checks see one form.
    value = value.replace(/\//g, "\\");
  }

  if (!pathImpl.isAbsolute(value)) {
    const base = options.resolveRelativeTo;
    if (base === undefined) {
      throw new TargetPathError(
        "relative_path",
        `REA requires an absolute target path, but received ${JSON.stringify(input)}. Resolve it against the workspace before calling a tool.`,
      );
    }
    const normalizedBase = canonicalizeTargetPath(base, {
      platform,
      style: "native",
    });
    value = pathImpl.join(normalizedBase, value);
  }

  const normalized = pathImpl.normalize(value);

  if (style === "forward") {
    return platform === "windows"
      ? normalized.replace(/\\/g, "/")
      : normalized;
  }
  return normalized;
}

/**
 * True when two spellings refer to the same file on the given platform,
 * accounting for case-insensitive Windows drives and separator differences.
 */
export function isSameTarget(a: string, b: string, platform: PathPlatform = "windows"): boolean {
  try {
    const left = canonicalizeTargetPath(a, { platform });
    const right = canonicalizeTargetPath(b, { platform });
    return platform === "windows"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  } catch {
    return false;
  }
}

/** Stable cache-key form: forward slashes, no extended prefix. */
export function targetCacheKey(input: string, platform: PathPlatform = "windows"): string {
  const canonical = canonicalizeTargetPath(input, { platform, style: "forward" });
  return platform === "windows" ? canonical.toLowerCase() : canonical;
}

/**
 * Inverse of path parsing, used when a tool result reports a path.
 *
 * Built explicitly for Windows rather than via `pathToFileURL`, which is
 * host-platform aware and would treat `C:\\x` as a relative path on POSIX.
 */
export function toFileUrl(input: string, platform: PathPlatform = "windows"): string {
  const canonical = canonicalizeTargetPath(input, { platform });
  if (platform !== "windows") return pathToFileURL(canonical).href;

  if (canonical.startsWith("\\\\")) {
    // UNC: \\server\share\x  ->  file://server/share/x
    return `file://${canonical.slice(2).replace(/\\/g, "/")}`;
  }
  return `file:///${canonical.replace(/\\/g, "/")}`;
}
