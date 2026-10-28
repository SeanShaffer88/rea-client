/**
 * Vendored-dependency manifests.
 *
 * The air-gapped bundle ships a copy of `rea-agents` inside the installer, so
 * "what actually runs" is a directory on disk rather than a registry install.
 * Without a recorded expectation there is no way to answer the two questions
 * that matter for a tool that parses untrusted binaries:
 *
 *   1. Is the vendored tree the code that was reviewed and pinned?
 *   2. Did anything change it after it was vendored — a post-install script, a
 *      partial upgrade, an edited file?
 *
 * A manifest records the expected hash of every file. Verification is offline
 * and needs no registry access, which is the whole point: the shipped bundle
 * has no network.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestFile {
  /** POSIX-style path relative to the package root. */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  /** True when the entry is a symlink; `sha256` then hashes the link target. */
  readonly link?: boolean;
}

export interface VendorManifest {
  readonly schemaVersion: number;
  readonly package: string;
  readonly version: string;
  /**
   * `sha512-…` integrity string from the registry's `dist.integrity`, when the
   * manifest was generated from a published tarball. This is the anchor: it ties
   * the file hashes to one specific published artifact.
   */
  readonly tarballIntegrity?: string;
  readonly tarballSha256?: string;
  /** Files sorted by path, so the file is byte-stable across runs. */
  readonly files: readonly ManifestFile[];
  readonly totalBytes: number;
}

export class ManifestError extends Error {
  public override readonly name = "ManifestError";
}

/** sha256 of a file's bytes, hex. */
export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface BuildManifestOptions {
  /**
   * Directory names skipped at any depth. Defaults cover the noise a package
   * manager creates that is not part of the published artifact.
   */
  readonly ignore?: readonly string[];
}

const DEFAULT_IGNORE = [".bin", "node_modules", ".cache"];

/**
 * Walks `root` and records every file.
 *
 * Symlinks are recorded with `link: true` and hashed by target string, so a
 * replaced link is detected as a change rather than silently followed.
 */
export async function buildManifest(
  root: string,
  meta: { readonly package: string; readonly version: string },
  options: BuildManifestOptions = {},
): Promise<VendorManifest> {
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
  const files: ManifestFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    // Sorted so traversal order cannot vary between runs or filesystems.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const absolute = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      const path = relative(root, absolute).split(sep).join("/");

      if (entry.isSymbolicLink()) {
        // Hashed by target string, not by the content it points at, so a
        // retargeted link is reported as drift instead of being followed.
        const linkTarget = await readlink(absolute);
        files.push({ path, sha256: sha256(linkTarget), size: 0, link: true });
        continue;
      }

      if (!entry.isFile()) continue;

      const bytes = await readFile(absolute);
      files.push({ path, sha256: sha256(bytes), size: bytes.length });
    }
  }

  const rootStat = await stat(root).catch(() => undefined);
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new ManifestError(`Not a directory: ${root}`);
  }

  await walk(root);

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    package: meta.package,
    version: meta.version,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly checked: number;
  /** In the manifest, absent on disk. */
  readonly missing: readonly string[];
  /** On disk, absent from the manifest. */
  readonly extra: readonly string[];
  /** Present in both but with different bytes. */
  readonly modified: readonly { readonly path: string; readonly expected: string; readonly actual: string }[];
  /** Package identity mismatch, if the caller supplied expectations. */
  readonly identityError?: string;
}

/**
 * Compares a directory against a manifest.
 *
 * Never throws for a mismatch — the caller decides whether drift is fatal. It
 * does throw if the manifest itself is malformed, because a corrupt manifest
 * would otherwise report a false success.
 */
export async function verifyManifest(
  root: string,
  manifest: VendorManifest,
  options: BuildManifestOptions & {
    readonly expectPackage?: string;
    readonly expectVersion?: string;
  } = {},
): Promise<VerifyResult> {
  assertManifestShape(manifest);

  const actual = await buildManifest(
    root,
    { package: manifest.package, version: manifest.version },
    options,
  );

  const expectedByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));

  const missing: string[] = [];
  const modified: { path: string; expected: string; actual: string }[] = [];

  for (const [path, expected] of expectedByPath) {
    const found = actualByPath.get(path);
    if (found === undefined) {
      missing.push(path);
      continue;
    }
    if (found.sha256 !== expected.sha256) {
      modified.push({ path, expected: expected.sha256, actual: found.sha256 });
    }
  }

  const extra = [...actualByPath.keys()].filter((path) => !expectedByPath.has(path));

  let identityError: string | undefined;
  if (options.expectPackage !== undefined && manifest.package !== options.expectPackage) {
    identityError = `manifest is for package ${manifest.package}, expected ${options.expectPackage}`;
  } else if (options.expectVersion !== undefined && manifest.version !== options.expectVersion) {
    identityError = `manifest is for version ${manifest.version}, expected ${options.expectVersion}`;
  }

  return {
    ok:
      missing.length === 0 &&
      extra.length === 0 &&
      modified.length === 0 &&
      identityError === undefined,
    checked: expectedByPath.size,
    missing: missing.sort(),
    extra: extra.sort(),
    modified: modified.sort((a, b) => (a.path < b.path ? -1 : 1)),
    ...(identityError === undefined ? {} : { identityError }),
  };
}

/** Rejects a manifest that is not structurally sound. */
export function assertManifestShape(value: unknown): asserts value is VendorManifest {
  if (typeof value !== "object" || value === null) {
    throw new ManifestError("Manifest must be a JSON object");
  }
  const record = value as Record<string, unknown>;

  if (record["schemaVersion"] !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestError(
      `Unsupported manifest schemaVersion ${String(record["schemaVersion"])}; this build reads ${String(MANIFEST_SCHEMA_VERSION)}`,
    );
  }
  if (typeof record["package"] !== "string" || record["package"] === "") {
    throw new ManifestError("Manifest is missing a package name");
  }
  if (typeof record["version"] !== "string" || record["version"] === "") {
    throw new ManifestError("Manifest is missing a version");
  }
  if (!Array.isArray(record["files"])) {
    throw new ManifestError("Manifest is missing a file list");
  }

  for (const entry of record["files"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      throw new ManifestError("Manifest contains a non-object file entry");
    }
    const file = entry as Record<string, unknown>;
    if (typeof file["path"] !== "string" || file["path"] === "") {
      throw new ManifestError("Manifest file entry is missing a path");
    }
    if (typeof file["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(file["sha256"])) {
      throw new ManifestError(`Manifest entry ${String(file["path"])} has an invalid sha256`);
    }
  }
}

/** Serializes a manifest deterministically, for committing or diffing. */
export function serializeManifest(manifest: VendorManifest): string {
  const sorted: VendorManifest = {
    ...manifest,
    files: [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** Parses manifest JSON, validating structure. */
export function parseManifest(text: string): VendorManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`Manifest is not valid JSON: ${(error as Error).message}`);
  }
  assertManifestShape(parsed);
  return parsed;
}
