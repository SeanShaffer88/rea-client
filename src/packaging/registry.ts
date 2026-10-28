/**
 * Anchoring a vendored tree to a published npm artifact.
 *
 * The manifest alone proves "this tree has not changed since I built the
 * manifest". It does not prove the tree is the code that was reviewed, because
 * whoever built the manifest could have hashed anything.
 *
 * The registry supplies the missing anchor: `dist.integrity` is a sha512 over
 * the exact tarball bytes, recorded by npm at publish time. Comparing the
 * vendored files against the tarball contents ties the tree to one published
 * artifact, and the integrity string makes that artifact identifiable offline
 * later.
 *
 * This module is build-time only. The shipped bundle verifies against the
 * recorded manifest and never contacts the network.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readTarball, type TarEntry } from "./tar.js";
import { buildManifest, sha256, type ManifestFile, type VendorManifest } from "./manifest.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export class RegistryError extends Error {
  public override readonly name = "RegistryError";
  public readonly status: number | undefined;

  public constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface Packument {
  readonly name: string;
  readonly version: string;
  readonly tarballUrl: string;
  /** `sha512-…` over the tarball, as published. */
  readonly integrity: string;
  /** sha1, legacy field; recorded but not relied on. */
  readonly shasum?: string;
  readonly fileCount?: number;
  readonly unpackedSize?: number;
}

export interface RegistryOptions {
  readonly registry?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Reads a packument for one exact version. Never resolves a range. */
export async function fetchPackument(
  name: string,
  version: string,
  options: RegistryOptions = {},
): Promise<Packument> {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const url = `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RegistryError(`Could not reach ${url}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new RegistryError(
      `Registry returned HTTP ${String(response.status)} for ${name}@${version}`,
      response.status,
    );
  }

  const body = (await response.json()) as {
    name?: string;
    version?: string;
    dist?: {
      tarball?: string;
      integrity?: string;
      shasum?: string;
      fileCount?: number;
      unpackedSize?: number;
    };
  };

  const dist = body.dist;
  if (dist?.tarball === undefined || dist.integrity === undefined) {
    throw new RegistryError(
      `${name}@${version} has no dist.tarball/dist.integrity; refusing to verify against an unsigned artifact`,
    );
  }

  return {
    name: body.name ?? name,
    version: body.version ?? version,
    tarballUrl: dist.tarball,
    integrity: dist.integrity,
    ...(dist.shasum === undefined ? {} : { shasum: dist.shasum }),
    ...(dist.fileCount === undefined ? {} : { fileCount: dist.fileCount }),
    ...(dist.unpackedSize === undefined ? {} : { unpackedSize: dist.unpackedSize }),
  };
}

export interface TarballData {
  readonly bytes: Buffer;
  readonly sha256: string;
  /** Computed `sha512-…` in the same format as the registry field. */
  readonly integrity: string;
  readonly entries: readonly TarEntry[];
}

/** Downloads a tarball and verifies it against an expected integrity string. */
export async function downloadTarball(
  url: string,
  expectedIntegrity: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<TarballData> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) });
  } catch (error) {
    throw new RegistryError(`Could not download ${url}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new RegistryError(`HTTP ${String(response.status)} downloading ${url}`, response.status);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

  if (integrity !== expectedIntegrity) {
    throw new RegistryError(
      `Tarball integrity mismatch for ${url}: expected ${expectedIntegrity}, got ${integrity}`,
    );
  }

  return {
    bytes,
    sha256: sha256(bytes),
    integrity,
    entries: readTarball(bytes),
  };
}

export interface TarballComparison {
  readonly ok: boolean;
  readonly fileCount: number;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly modified: readonly { readonly path: string; readonly expected: string; readonly actual: string }[];
  /** Populated when the registry metadata disagrees with the archive contents. */
  readonly metadataMismatches: readonly string[];
}

/** Converts archive entries into manifest entries (files only). */
export function manifestFilesFromTarball(entries: readonly TarEntry[]): ManifestFile[] {
  return entries
    .filter((entry) => entry.type === "file")
    .map((entry) => ({ path: entry.path, sha256: sha256(entry.bytes), size: entry.size }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Compares a directory to a tarball's contents.
 *
 * This is the check that answers "is the vendored tree the published code?".
 * It reports rather than throws on content differences, but throws on a
 * malformed archive.
 */
export async function compareDirectoryToTarball(
  directory: string,
  tarball: TarballData,
  meta: { readonly fileCount?: number; readonly unpackedSize?: number } = {},
): Promise<TarballComparison> {
  const expected = manifestFilesFromTarball(tarball.entries);
  const actual = await buildManifest(directory, { package: "compare", version: "0" });

  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));

  const missing: string[] = [];
  const modified: { path: string; expected: string; actual: string }[] = [];

  for (const [path, want] of expectedByPath) {
    const got = actualByPath.get(path);
    if (got === undefined) {
      missing.push(path);
    } else if (got.sha256 !== want.sha256) {
      modified.push({ path, expected: want.sha256, actual: got.sha256 });
    }
  }
  const extra = [...actualByPath.keys()].filter((path) => !expectedByPath.has(path));

  const metadataMismatches: string[] = [];
  if (meta.fileCount !== undefined && meta.fileCount !== expected.length) {
    metadataMismatches.push(
      `registry fileCount ${String(meta.fileCount)} but archive holds ${String(expected.length)} files`,
    );
  }
  const unpacked = expected.reduce((sum, file) => sum + file.size, 0);
  if (meta.unpackedSize !== undefined && meta.unpackedSize !== unpacked) {
    metadataMismatches.push(
      `registry unpackedSize ${String(meta.unpackedSize)} but archive totals ${String(unpacked)} bytes`,
    );
  }

  return {
    ok: missing.length === 0 && extra.length === 0 && modified.length === 0,
    fileCount: expected.length,
    missing: missing.sort(),
    extra: extra.sort(),
    modified: modified.sort((a, b) => (a.path < b.path ? -1 : 1)),
    metadataMismatches,
  };
}

/**
 * Builds a manifest for a directory and anchors it to a published tarball.
 *
 * The returned manifest is the exact artifact to commit and ship; `integrity`
 * is what makes it verifiable offline later.
 */
export async function buildAnchoredManifest(
  directory: string,
  packument: Packument,
  tarball: TarballData,
): Promise<{ readonly manifest: VendorManifest; readonly comparison: TarballComparison }> {
  const comparison = await compareDirectoryToTarball(directory, tarball, {
    ...(packument.fileCount === undefined ? {} : { fileCount: packument.fileCount }),
    ...(packument.unpackedSize === undefined ? {} : { unpackedSize: packument.unpackedSize }),
  });

  const base = await buildManifest(directory, {
    package: packument.name,
    version: packument.version,
  });

  return {
    manifest: {
      ...base,
      tarballIntegrity: packument.integrity,
      tarballSha256: tarball.sha256,
    },
    comparison,
  };
}

/** Convenience: read a package.json to learn the vendored identity. */
export async function readPackageIdentity(
  directory: string,
): Promise<{ name: string; version: string }> {
  const raw = await readFile(join(directory, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { name?: string; version?: string };
  if (parsed.name === undefined || parsed.version === undefined) {
    throw new RegistryError(`${directory}/package.json is missing name or version`);
  }
  return { name: parsed.name, version: parsed.version };
}
