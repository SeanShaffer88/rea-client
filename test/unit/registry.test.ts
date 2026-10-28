import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RegistryError,
  compareDirectoryToTarball,
  downloadTarball,
  fetchPackument,
  manifestFilesFromTarball,
  readPackageIdentity,
} from "../../src/packaging/registry.js";
import { buildTarball } from "../support/tarWriter.js";

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PACKUMENT = {
  name: "demo",
  version: "1.2.3",
  dist: {
    tarball: "https://registry.example/demo-1.2.3.tgz",
    integrity: "sha512-abc",
    shasum: "deadbeef",
    fileCount: 2,
    unpackedSize: 56,
  },
};

describe("fetchPackument", () => {
  it("returns the pinned identity and integrity", async () => {
    const packument = await fetchPackument("demo", "1.2.3", {
      fetchImpl: (async () => jsonResponse(PACKUMENT)) as typeof fetch,
    });
    expect(packument.version).toBe("1.2.3");
    expect(packument.integrity).toBe("sha512-abc");
    expect(packument.fileCount).toBe(2);
  });

  it("requests the exact version, never a range", async () => {
    const urls: string[] = [];
    await fetchPackument("demo", "1.2.3", {
      registry: "https://registry.example",
      fetchImpl: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return jsonResponse(PACKUMENT);
      }) as typeof fetch,
    });
    expect(urls[0]).toBe("https://registry.example/demo/1.2.3");
  });

  it("rejects a packument with no integrity, rather than trusting it", async () => {
    await expect(
      fetchPackument("demo", "1.2.3", {
        fetchImpl: (async () =>
          jsonResponse({ name: "demo", version: "1.2.3", dist: { tarball: "x" } })) as typeof fetch,
      }),
    ).rejects.toThrow(/dist.tarball\/dist.integrity/);
  });

  it("reports an HTTP failure with its status", async () => {
    try {
      await fetchPackument("demo", "9.9.9", {
        fetchImpl: (async () => jsonResponse({ error: "Not found" }, 404)) as typeof fetch,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as RegistryError).status).toBe(404);
    }
  });

  it("reports a transport failure", async () => {
    await expect(
      fetchPackument("demo", "1.2.3", {
        fetchImpl: (async () => Promise.reject(new Error("ENOTFOUND"))) as typeof fetch,
      }),
    ).rejects.toThrow(/Could not reach/);
  });
});

describe("downloadTarball", () => {
  const archive = buildTarball([
    { path: "package/package.json", content: '{"name":"demo","version":"1.2.3"}' },
    { path: "package/dist/index.js", content: "export const a = 1;\n" },
  ]);

  it("verifies integrity and parses the archive", async () => {
    const data = await downloadTarball("https://registry.example/x.tgz", integrityOf(archive), {
      fetchImpl: (async () => new Response(archive)) as typeof fetch,
    });
    expect(data.integrity).toBe(integrityOf(archive));
    expect(data.entries).toHaveLength(2);
    expect(data.sha256).toHaveLength(64);
  });

  it("refuses a tarball whose bytes do not match the published integrity", async () => {
    const tampered = buildTarball([{ path: "package/evil.js", content: "pwn" }]);
    await expect(
      downloadTarball("https://registry.example/x.tgz", integrityOf(archive), {
        fetchImpl: (async () => new Response(tampered)) as typeof fetch,
      }),
    ).rejects.toThrow(/integrity mismatch/);
  });

  it("reports an HTTP failure", async () => {
    await expect(
      downloadTarball("https://registry.example/x.tgz", "sha512-abc", {
        fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("manifestFilesFromTarball", () => {
  it("includes files only, sorted by path", () => {
    const entries = [
      { path: "b.js", type: "file" as const, size: 2, mode: 0o644, bytes: Buffer.from("bb") },
      { path: "dist", type: "directory" as const, size: 0, mode: 0o755, bytes: Buffer.alloc(0) },
      { path: "a.js", type: "file" as const, size: 2, mode: 0o644, bytes: Buffer.from("aa") },
    ];
    expect(manifestFilesFromTarball(entries).map((file) => file.path)).toEqual(["a.js", "b.js"]);
  });
});

describe("compareDirectoryToTarball", () => {
  let root = "";

  const archive = buildTarball([
    { path: "package/package.json", content: '{"name":"demo","version":"1.2.3"}' },
    { path: "package/dist/index.js", content: "export const a = 1;\n" },
  ]);

  async function tarball() {
    return downloadTarball("https://registry.example/x.tgz", integrityOf(archive), {
      fetchImpl: (async () => new Response(archive)) as typeof fetch,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rea-registry-"));
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"demo","version":"1.2.3"}');
    await writeFile(join(root, "dist/index.js"), "export const a = 1;\n");
  });

  afterEach(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  it("reports a clean match", async () => {
    const result = await compareDirectoryToTarball(root, await tarball());
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(2);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it("detects a file the tarball does not contain", async () => {
    await writeFile(join(root, "dist/extra.js"), "injected");
    const result = await compareDirectoryToTarball(root, await tarball());
    expect(result.ok).toBe(false);
    expect(result.extra).toEqual(["dist/extra.js"]);
  });

  it("detects a modified file", async () => {
    await writeFile(join(root, "dist/index.js"), "// tampered\n");
    const result = await compareDirectoryToTarball(root, await tarball());
    expect(result.ok).toBe(false);
    expect(result.modified.map((entry) => entry.path)).toEqual(["dist/index.js"]);
  });

  it("flags registry metadata that disagrees with the archive", async () => {
    const result = await compareDirectoryToTarball(root, await tarball(), {
      fileCount: 99,
      unpackedSize: 1,
    });
    expect(result.metadataMismatches).toHaveLength(2);
    expect(result.metadataMismatches[0]).toContain("fileCount");
  });

  it("accepts metadata that agrees with the archive", async () => {
    const built = await tarball();
    const total = built.entries.reduce((sum, entry) => sum + entry.size, 0);
    const result = await compareDirectoryToTarball(root, built, {
      fileCount: built.entries.length,
      unpackedSize: total,
    });
    expect(result.metadataMismatches).toEqual([]);
  });
});

describe("readPackageIdentity", () => {
  it("reads name and version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rea-identity-"));
    try {
      await writeFile(join(dir, "package.json"), '{"name":"x","version":"2.0.0"}');
      expect(await readPackageIdentity(dir)).toEqual({ name: "x", version: "2.0.0" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a package.json without identity fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rea-identity-"));
    try {
      await writeFile(join(dir, "package.json"), '{"private":true}');
      await expect(readPackageIdentity(dir)).rejects.toThrow(/name or version/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
