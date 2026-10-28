import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TarError, normalizeEntryPath, readTarball } from "../../src/packaging/tar.js";
import { LONG_PATH, buildTarball } from "../support/tarWriter.js";

function files(archive: Buffer): Array<{ path: string; content: string }> {
  return readTarball(archive)
    .filter((entry) => entry.type === "file")
    .map((entry) => ({ path: entry.path, content: entry.bytes.toString("utf8") }));
}

describe("readTarball", () => {
  it("reads a simple archive and strips the package/ prefix", () => {
    const archive = buildTarball([
      { path: "package/package.json", content: '{"name":"x"}' },
      { path: "package/dist/index.js", content: "export {};" },
    ]);

    expect(files(archive)).toEqual([
      { path: "package.json", content: '{"name":"x"}' },
      { path: "dist/index.js", content: "export {};" },
    ]);
  });

  it("preserves entry order", () => {
    const archive = buildTarball([
      { path: "package/b.txt", content: "b" },
      { path: "package/a.txt", content: "a" },
    ]);
    expect(files(archive).map((file) => file.path)).toEqual(["b.txt", "a.txt"]);
  });

  it("handles binary content without corrupting bytes", () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x00]);
    const archive = buildTarball([{ path: "package/bin.dat", content: bytes }]);
    const entry = readTarball(archive).find((candidate) => candidate.path === "bin.dat");
    expect(entry?.bytes.equals(bytes)).toBe(true);
  });

  it("reads a path longer than 100 bytes from a pax header", () => {
    const archive = buildTarball([{ path: LONG_PATH, content: "pax", forcePax: true }]);
    const parsed = files(archive);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.path).toBe(LONG_PATH.replace(/^package\//, ""));
  });

  it("reads a path longer than 100 bytes from a GNU longname record", () => {
    const archive = buildTarball([{ path: LONG_PATH, content: "gnu", gnuLongName: true }]);
    const parsed = files(archive);
    expect(parsed[0]?.path).toBe(LONG_PATH.replace(/^package\//, ""));
    expect(parsed[0]?.content).toBe("gnu");
  });

  it("reads a path split across the ustar prefix field", () => {
    const archive = buildTarball([{ path: LONG_PATH, content: "prefix", usePrefix: true }]);
    const parsed = files(archive);
    expect(parsed[0]?.path).toBe(LONG_PATH.replace(/^package\//, ""));
  });

  it("skips directory entries but keeps their files", () => {
    const archive = buildTarball([
      { path: "package/dist/", type: "directory" },
      { path: "package/dist/a.js", content: "a" },
    ]);
    const entries = readTarball(archive);
    expect(entries.some((entry) => entry.type === "directory")).toBe(true);
    expect(files(archive).map((file) => file.path)).toEqual(["dist/a.js"]);
  });

  it("handles an empty file", () => {
    const archive = buildTarball([{ path: "package/empty.txt", content: "" }]);
    const entry = readTarball(archive).find((candidate) => candidate.path === "empty.txt");
    expect(entry?.size).toBe(0);
    expect(entry?.bytes.length).toBe(0);
  });
});

describe("readTarball — malformed input", () => {
  it("rejects a non-gzip buffer", () => {
    expect(() => readTarball(Buffer.from("not a tarball"))).toThrow(TarError);
  });

  it("rejects a corrupt header checksum", () => {
    const inflated = gunzipSync(buildTarball([{ path: "package/a.txt", content: "a" }]));
    // Flip a byte inside the first header's name field without touching the
    // recorded checksum.
    inflated[0] = 0x41;
    expect(() => readTarball(gzipSync(inflated))).toThrow(/checksum/i);
  });

  it("rejects an archive that is truncated mid-entry", () => {
    const inflated = gunzipSync(buildTarball([{ path: "package/a.txt", content: "a".repeat(2000) }]));
    const truncated = inflated.subarray(0, 700);
    expect(() => readTarball(gzipSync(truncated))).toThrow(TarError);
  });

  it("rejects an archive with no entries", () => {
    expect(() => readTarball(gzipSync(Buffer.alloc(1024)))).toThrow(/no entries/i);
  });
});

describe("normalizeEntryPath", () => {
  it("strips the npm prefix and a leading ./", () => {
    expect(normalizeEntryPath("package/dist/a.js")).toBe("dist/a.js");
    expect(normalizeEntryPath("./package/dist/a.js")).toBe("dist/a.js");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeEntryPath("package\\dist\\a.js")).toBe("dist/a.js");
  });

  it("trims trailing separators", () => {
    expect(normalizeEntryPath("package/dist/")).toBe("dist");
  });

  it("rejects path traversal", () => {
    expect(() => normalizeEntryPath("package/../../etc/passwd")).toThrow(/traversal/i);
    expect(() => normalizeEntryPath("package/a/../../b")).toThrow(/traversal/i);
  });

  it("rejects absolute paths, including Windows drive letters", () => {
    expect(() => normalizeEntryPath("/etc/passwd")).toThrow(/Absolute/i);
    expect(() => normalizeEntryPath("C:\\Windows\\System32\\evil.dll")).toThrow(/Absolute/i);
  });
});
