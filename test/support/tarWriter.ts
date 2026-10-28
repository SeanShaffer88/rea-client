/**
 * Minimal ustar writer, used to build synthetic archives for parser tests.
 *
 * Writing archives as well as reading them means the parser is tested against
 * structure that is built from the format spec rather than round-tripped
 * through the parser itself, and lets tests express malformed cases (bad
 * checksum, truncated body, traversal paths) that a real package would never
 * contain.
 */

import { gzipSync } from "node:zlib";

const BLOCK = 512;

export interface EntrySpec {
  /** Path inside the archive. Defaults to being placed under `package/`. */
  readonly path: string;
  readonly content?: string | Buffer;
  readonly type?: "file" | "directory";
  /** Force a pax extended header even for short paths. */
  readonly forcePax?: boolean;
  /** Emit a GNU longname ('L') record instead of pax. */
  readonly gnuLongName?: boolean;
  /** Use the ustar `prefix` field instead of pax for long paths. */
  readonly usePrefix?: boolean;
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  // Zero-padded octal, NUL-terminated, as the classic tar format expects.
  const text = value.toString(8).padStart(length - 1, "0");
  block.write(text, offset, length - 1, "ascii");
  block[offset + length - 1] = 0;
}

function checksum(block: Buffer): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return sum;
}

function header(options: {
  name: string;
  prefix?: string;
  size: number;
  typeflag: string;
  mode?: number;
}): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(options.name.slice(0, 100), 0, 100, "utf8");
  writeOctal(block, 100, 8, options.mode ?? 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, options.size);
  writeOctal(block, 136, 12, 0);
  block.write("        ", 148, 8, "ascii");
  block[156] = options.typeflag.charCodeAt(0);
  block.write("ustar", 257, 5, "ascii");
  block[262] = 0;
  block.write("00", 263, 2, "ascii");
  if (options.prefix !== undefined) block.write(options.prefix.slice(0, 155), 345, 155, "utf8");
  writeOctal(block, 148, 8, checksum(block));
  return block;
}

function pad(body: Buffer): Buffer {
  const remainder = body.length % BLOCK;
  if (remainder === 0) return Buffer.alloc(0);
  return Buffer.alloc(BLOCK - remainder);
}

/** Builds a pax extended header body for one path. */
function paxBody(path: string): Buffer {
  const record = ` path=${path}\n`;
  // The length prefix counts its own digits.
  let length = record.length;
  for (;;) {
    const candidate = `${String(length)}${record}`;
    if (candidate.length === length) return Buffer.from(candidate, "utf8");
    length = candidate.length;
  }
}

/** Serializes entries into a gzipped tar archive. */
export function buildTarball(entries: readonly EntrySpec[]): Buffer {
  const parts: Buffer[] = [];

  for (const entry of entries) {
    const isDirectory = entry.type === "directory";
    const body = isDirectory ? Buffer.alloc(0) : Buffer.from(entry.content ?? "");
    const fullPath = entry.path;

    if (entry.forcePax) {
      const pax = paxBody(fullPath);
      parts.push(header({ name: "PaxHeader", size: pax.length, typeflag: "x" }), pax, pad(pax));
    } else if (entry.gnuLongName) {
      const long = Buffer.from(`${fullPath}\0`, "utf8");
      parts.push(header({ name: "././@LongLink", size: long.length, typeflag: "L" }), long, pad(long));
    }

    let name = fullPath;
    let prefix: string | undefined;
    if (fullPath.length > 100 && entry.usePrefix) {
      // Split at a '/' so the name fits in 100 and the prefix in 155.
      const split = fullPath.lastIndexOf("/", 155);
      prefix = fullPath.slice(0, split);
      name = fullPath.slice(split + 1);
    }

    parts.push(
      header({
        name: entry.forcePax || entry.gnuLongName ? "short" : name,
        ...(prefix === undefined ? {} : { prefix }),
        size: body.length,
        typeflag: isDirectory ? "5" : "0",
        mode: isDirectory ? 0o755 : 0o644,
      }),
      body,
      pad(body),
    );
  }

  // Two zero blocks terminate the archive.
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

/** A long path that cannot fit in a 100-byte ustar name field. */
export const LONG_PATH =
  "package/dist/deeply/nested/directory/structure/with/many/segments/application__javascript__RuntimeReconciliationService-Dkmneppp.js";
