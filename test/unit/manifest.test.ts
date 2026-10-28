import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANIFEST_SCHEMA_VERSION,
  ManifestError,
  buildManifest,
  parseManifest,
  serializeManifest,
  sha256,
  verifyManifest,
} from "../../src/packaging/manifest.js";

let root = "";

async function write(relativePath: string, content: string): Promise<void> {
  const absolute = join(root, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-manifest-"));
  await write("package.json", '{"name":"demo","version":"1.0.0"}');
  await write("dist/index.js", "export const a = 1;\n");
  await write("dist/nested/b.js", "export const b = 2;\n");
});

afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

const meta = { package: "demo", version: "1.0.0" };

describe("buildManifest", () => {
  it("records every file with a stable POSIX path", async () => {
    const manifest = await buildManifest(root, meta);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "dist/index.js",
      "dist/nested/b.js",
      "package.json",
    ]);
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.package).toBe("demo");
  });

  it("records sizes and hashes that match the bytes", async () => {
    const manifest = await buildManifest(root, meta);
    const entry = manifest.files.find((file) => file.path === "dist/index.js");
    expect(entry?.size).toBe("export const a = 1;\n".length);
    expect(entry?.sha256).toBe(sha256("export const a = 1;\n"));
  });

  it("totals the recorded bytes", async () => {
    const manifest = await buildManifest(root, meta);
    const expected = manifest.files.reduce((sum, file) => sum + file.size, 0);
    expect(manifest.totalBytes).toBe(expected);
  });

  it("is deterministic across runs", async () => {
    const first = await buildManifest(root, meta);
    const second = await buildManifest(root, meta);
    expect(serializeManifest(first)).toBe(serializeManifest(second));
  });

  it("ignores directories that are not part of the published artifact", async () => {
    await write("node_modules/dep/index.js", "dep");
    await write(".bin/thing", "bin");
    const manifest = await buildManifest(root, meta);
    expect(manifest.files.some((file) => file.path.startsWith("node_modules/"))).toBe(false);
    expect(manifest.files.some((file) => file.path.startsWith(".bin/"))).toBe(false);
  });

  it("hashes a symlink by its target string and marks it", async () => {
    await symlink("dist/index.js", join(root, "link.js"));
    const manifest = await buildManifest(root, meta);
    const link = manifest.files.find((file) => file.path === "link.js");
    expect(link?.link).toBe(true);
    expect(link?.sha256).toBe(sha256("dist/index.js"));
  });

  it("rejects a path that is not a directory", async () => {
    await expect(buildManifest(join(root, "package.json"), meta)).rejects.toThrow(ManifestError);
    await expect(buildManifest(join(root, "nope"), meta)).rejects.toThrow(ManifestError);
  });
});

describe("verifyManifest", () => {
  it("passes for an unchanged tree", async () => {
    const manifest = await buildManifest(root, meta);
    const result = await verifyManifest(root, manifest);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(manifest.files.length);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it("detects a modified file", async () => {
    const manifest = await buildManifest(root, meta);
    await write("dist/index.js", "export const a = 999;\n");

    const result = await verifyManifest(root, manifest);
    expect(result.ok).toBe(false);
    expect(result.modified.map((entry) => entry.path)).toEqual(["dist/index.js"]);
    expect(result.modified[0]?.expected).not.toBe(result.modified[0]?.actual);
  });

  it("detects a deleted file", async () => {
    const manifest = await buildManifest(root, meta);
    await rm(join(root, "dist/nested/b.js"));

    const result = await verifyManifest(root, manifest);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["dist/nested/b.js"]);
  });

  it("detects an added file, which is how a post-install payload would appear", async () => {
    const manifest = await buildManifest(root, meta);
    await write("dist/injected.js", "require('child_process').exec('calc');");

    const result = await verifyManifest(root, manifest);
    expect(result.ok).toBe(false);
    expect(result.extra).toEqual(["dist/injected.js"]);
  });

  it("detects a retargeted symlink", async () => {
    await symlink("dist/index.js", join(root, "link.js"));
    const manifest = await buildManifest(root, meta);
    await rm(join(root, "link.js"));
    await symlink("package.json", join(root, "link.js"));

    const result = await verifyManifest(root, manifest);
    expect(result.ok).toBe(false);
    expect(result.modified.some((entry) => entry.path === "link.js")).toBe(true);
  });

  it("reports a package identity mismatch", async () => {
    const manifest = await buildManifest(root, meta);
    const result = await verifyManifest(root, manifest, { expectVersion: "2.0.0" });
    expect(result.ok).toBe(false);
    expect(result.identityError).toContain("2.0.0");
  });

  it("accepts matching expectations", async () => {
    const manifest = await buildManifest(root, meta);
    const result = await verifyManifest(root, manifest, {
      expectPackage: "demo",
      expectVersion: "1.0.0",
    });
    expect(result.ok).toBe(true);
    expect(result.identityError).toBeUndefined();
  });

  it("rejects a malformed manifest rather than reporting success", async () => {
    const broken = { schemaVersion: 1, package: "demo", version: "1.0.0", files: [{ path: "x" }] };
    await expect(verifyManifest(root, broken as never)).rejects.toThrow(/invalid sha256/);
  });
});

describe("manifest serialization", () => {
  it("sorts files so the committed file diffs cleanly", async () => {
    const manifest = await buildManifest(root, meta);
    const shuffled = { ...manifest, files: [...manifest.files].reverse() };
    expect(serializeManifest(shuffled)).toBe(serializeManifest(manifest));
  });

  it("round-trips through parse and serialize", async () => {
    const manifest = await buildManifest(root, meta);
    const reparsed = parseManifest(serializeManifest(manifest));
    expect(reparsed).toEqual(manifest);
  });

  it("rejects an unsupported schema version", () => {
    expect(() =>
      parseManifest(JSON.stringify({ schemaVersion: 99, package: "p", version: "1", files: [] })),
    ).toThrow(/schemaVersion/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseManifest("{oops")).toThrow(/not valid JSON/);
  });

  it("rejects a manifest with no file list", () => {
    expect(() =>
      parseManifest(JSON.stringify({ schemaVersion: 1, package: "p", version: "1" })),
    ).toThrow(/file list/);
  });

  it("rejects a non-object manifest", () => {
    expect(() => parseManifest("[]")).toThrow(ManifestError);
  });
});
