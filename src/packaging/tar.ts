/**
 * Minimal tar reader for npm package tarballs.
 *
 * Why hand-rolled: the verification tool has to run in the air-gapped bundle,
 * on Windows 11, with no `tar.exe` dependency and no extra runtime package.
 * Node ships gzip in `node:zlib`, so only the archive format is missing.
 *
 * Scope is deliberately narrow — it parses what npm publishes (ustar, plus the
 * pax and GNU extensions that long paths require) and refuses anything it does
 * not understand rather than guessing. A verifier that silently misparses an
 * archive is worse than one that fails.
 */

import { gunzipSync } from "node:zlib";

export class TarError extends Error {
  public override readonly name = "TarError";
}

export interface TarEntry {
  /** Path as stored in the archive, with the npm `package/` prefix removed. */
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number;
  readonly mode: number;
  readonly bytes: Buffer;
}

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

function cString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  const bytes = end === -1 ? slice : slice.subarray(0, end);
  return bytes.toString("utf8");
}

function octal(block: Buffer, offset: number, length: number, field: string): number {
  const raw = cString(block, offset, length).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new TarError(`Invalid octal value ${JSON.stringify(raw)} in tar field ${field}`);
  }
  return Number.parseInt(raw, 8);
}

type PaxRecord = Record<string, string>;

/**
 * Parses a pax extended header body.
 *
 * Records are `<length> <key>=<value>\n`, where `<length>` counts the whole
 * record including its own digits — so parsing has to re-read the length.
 */
function parsePax(body: Buffer): PaxRecord {
  const out: PaxRecord = {};
  let offset = 0;

  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;

    const lengthText = body.subarray(offset, space).toString("utf8");
    const recordLength = Number.parseInt(lengthText, 10);
    if (!Number.isFinite(recordLength) || recordLength <= 0) {
      throw new TarError("Malformed pax record length");
    }

    const recordEnd = offset + recordLength;
    if (recordEnd > body.length) throw new TarError("pax record overruns its header");

    // Skip "<len> ", drop the trailing newline.
    const record = body.subarray(space + 1, recordEnd - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1) {
      out[record.slice(0, eq)] = record.slice(eq + 1);
    }
    offset = recordEnd;
  }

  return out;
}

/**
 * Parses a gzipped tar archive into entries.
 *
 * @throws {TarError} on a truncated or unsupported archive.
 */
export function readTarball(gzipped: Buffer): TarEntry[] {
  let archive: Buffer;
  try {
    archive = gunzipSync(gzipped);
  } catch (error) {
    throw new TarError(`Not a gzip stream: ${(error as Error).message}`);
  }

  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingPath: string | undefined;
  let pendingSize: number | undefined;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.equals(ZERO_BLOCK)) break;

    // A checksum mismatch means the archive is corrupt or we have lost framing.
    const expected = octal(header, 148, 8, "chksum");
    const actual = header.reduce((sum, byte, index) => {
      // The checksum field itself counts as spaces.
      const inChecksumField = index >= 148 && index < 156;
      return sum + (inChecksumField ? 0x20 : byte);
    }, 0);
    if (expected !== actual) {
      throw new TarError(
        `Tar header checksum mismatch at offset ${String(offset)} (expected ${String(expected)}, computed ${String(actual)})`,
      );
    }

    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    let size = octal(header, 124, 12, "size");
    const mode = octal(header, 100, 8, "mode");
    const dataStart = offset + BLOCK;

    // Metadata entries describe the *next* entry and carry no file content.
    if (typeflag === "x" || typeflag === "g") {
      const body = archive.subarray(dataStart, dataStart + size);
      if (typeflag === "x") {
        const pax = parsePax(body);
        if (pax["path"] !== undefined) pendingPath = pax["path"];
        if (pax["size"] !== undefined) {
          const parsed = Number.parseInt(pax["size"], 10);
          if (Number.isFinite(parsed)) pendingSize = parsed;
        }
      }
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    if (typeflag === "L") {
      // GNU longname: the body is the next entry's path, NUL-terminated.
      pendingPath = cString(archive.subarray(dataStart, dataStart + size), 0, size);
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    if (pendingSize !== undefined) size = pendingSize;
    const rawPath = pendingPath ?? (prefix === "" ? name : `${prefix}/${name}`);
    pendingPath = undefined;
    pendingSize = undefined;

    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new TarError(`Tar entry ${JSON.stringify(rawPath)} overruns the archive`);
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "5") {
      entries.push({ path: normalizeEntryPath(rawPath), type: "directory", size: 0, mode, bytes: Buffer.alloc(0) });
      continue;
    }
    if (typeflag === "0" || typeflag === "\u0000" || typeflag === "7") {
      entries.push({
        path: normalizeEntryPath(rawPath),
        type: "file",
        size,
        mode,
        bytes: archive.subarray(dataStart, dataEnd),
      });
      continue;
    }

    // Symlinks, devices and FIFOs are not expected in an npm tarball. Fail
    // loudly rather than producing a manifest that omits them.
    throw new TarError(
      `Unsupported tar entry type ${JSON.stringify(typeflag)} for ${JSON.stringify(rawPath)}`,
    );
  }

  if (entries.length === 0) throw new TarError("Archive contained no entries");
  return entries;
}

/**
 * Strips the npm `package/` prefix and normalizes separators.
 *
 * @throws {TarError} if an entry would escape the package root.
 */
export function normalizeEntryPath(rawPath: string): string {
  const path = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");

  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw new TarError(`Absolute path in archive: ${JSON.stringify(rawPath)}`);
  }
  if (path.split("/").includes("..")) {
    throw new TarError(`Path traversal in archive: ${JSON.stringify(rawPath)}`);
  }

  const stripped = path.startsWith("package/") ? path.slice("package/".length) : path;
  return stripped.replace(/\/+$/, "");
}
