/**
 * Vendored-dependency verification.
 *
 * Two layers:
 *
 *  1. A fake registry served over loopback, so the full `vendor manifest` path
 *     (packument -> tarball -> integrity check -> anchoring -> manifest) is
 *     exercised deterministically, including the refusal cases.
 *  2. The committed manifest checked against the installed tree and the real
 *     npm registry, which is the guarantee the shipping bundle actually relies
 *     on: the vendored code is the code that was reviewed.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseManifest, verifyManifest } from "../../src/packaging/manifest.js";
import { buildTarball } from "../support/tarWriter.js";

const CLI = resolve("dist/cli.js");
const MANIFEST_PATH = resolve("vendor/rea-agents.manifest.json");
const VENDORED_DIR = resolve("node_modules/rea-agents");

const hasBuild = existsSync(CLI);
const hasVendored = existsSync(join(VENDORED_DIR, "package.json"));
const hasManifest = existsSync(MANIFEST_PATH);

if (!hasBuild && process.env["CI"] === "true") {
  throw new Error(
    `${CLI} does not exist, so vendor CLI coverage would silently disappear. Build before testing in CI.`,
  );
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): Promise<Run> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1;
        resolveRun({ code, stdout, stderr });
      },
    );
  });
}

function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

// ---------------------------------------------------------------------------
// Fake registry
// ---------------------------------------------------------------------------

const PACKAGE_FILES = {
  "package.json": JSON.stringify({ name: "demo-vendor", version: "1.0.0" }),
  "dist/index.js": "export const value = 42;\n",
  "LICENSE": "MIT\n",
};

describe.skipIf(!hasBuild)("vendor manifest / verify against a fake registry", () => {
  let server: Server;
  let registryUrl = "";
  let tarball: Buffer;
  let workdir = "";

  beforeAll(async () => {
    tarball = buildTarball(
      Object.entries(PACKAGE_FILES).map(([name, content]) => ({
        path: `package/${name}`,
        content,
      })),
    );

    server = createServer((request, response) => {
      if (request.url === "/demo-vendor/1.0.0") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            name: "demo-vendor",
            version: "1.0.0",
            dist: {
              tarball: `${registryUrl}/demo-vendor/-/demo-vendor-1.0.0.tgz`,
              integrity: sha512Integrity(tarball),
              fileCount: Object.keys(PACKAGE_FILES).length,
              unpackedSize: Object.values(PACKAGE_FILES).reduce(
                (sum, content) => sum + Buffer.byteLength(content),
                0,
              ),
            },
          }),
        );
        return;
      }
      if (request.url === "/demo-vendor/-/demo-vendor-1.0.0.tgz") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(tarball);
        return;
      }
      response.writeHead(404);
      response.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("bind failed");
    registryUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  });

  // Manifests live outside the tree they describe; a manifest stored inside is
  // itself an unexpected file, which the CLI warns about explicitly.
  let scratch = "";
  let pkgDir = "";

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "rea-vendor-"));
    pkgDir = join(scratch, "pkg");
    workdir = pkgDir;
    for (const [name, content] of Object.entries(PACKAGE_FILES)) {
      const target = join(pkgDir, name);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  });

  afterEach(async () => {
    if (scratch !== "") await rm(scratch, { recursive: true, force: true });
  });

  it("records an anchored manifest for a tree matching the published tarball", async () => {
    const out = join(scratch, "manifest.json");
    const result = await runCli([
      "vendor",
      "manifest",
      workdir,
      "--out",
      out,
      "--registry",
      registryUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Recorded 3 files for demo-vendor@1.0.0");

    const manifest = parseManifest(await readFile(out, "utf8"));
    expect(manifest.package).toBe("demo-vendor");
    expect(manifest.files.map((file) => file.path)).toEqual([
      "LICENSE",
      "dist/index.js",
      "package.json",
    ]);
    expect(manifest.tarballIntegrity).toBe(sha512Integrity(tarball));
  });

  it("creates the output directory when it does not exist yet", async () => {
    const out = join(scratch, "nested", "deeper", "manifest.json");
    const result = await runCli([
      "vendor",
      "manifest",
      workdir,
      "--out",
      out,
      "--registry",
      registryUrl,
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("verifies a clean tree offline", async () => {
    const out = join(scratch, "manifest.json");
    await runCli(["vendor", "manifest", workdir, "--out", out, "--registry", registryUrl]);

    // No registry argument: verification must not need the network.
    const result = await runCli(["vendor", "verify", workdir, "--manifest", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("3 files match the manifest");
  });

  it("detects tampering and reports each changed path", async () => {
    const out = join(scratch, "manifest.json");
    await runCli(["vendor", "manifest", workdir, "--out", out, "--registry", registryUrl]);

    await writeFile(join(workdir, "dist/index.js"), "export const value = 666;\n", "utf8");
    await writeFile(join(workdir, "dist/backdoor.js"), "steal();\n", "utf8");

    const result = await runCli(["vendor", "verify", workdir, "--manifest", out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DRIFT");
    expect(result.stderr).toContain("modified: dist/index.js");
    expect(result.stderr).toContain("unexpected: dist/backdoor.js");
  });

  it("emits machine-readable verification results", async () => {
    const out = join(scratch, "manifest.json");
    await runCli(["vendor", "manifest", workdir, "--out", out, "--registry", registryUrl]);
    await writeFile(join(workdir, "extra.js"), "x", "utf8");

    const result = await runCli(["vendor", "verify", workdir, "--manifest", out, "--json"]);
    expect(result.code).toBe(1);

    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      extra: string[];
      checked: number;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.extra).toEqual(["extra.js"]);
    expect(parsed.checked).toBe(3);
  });

  it("refuses to record a manifest when the tree does not match the tarball", async () => {
    await writeFile(join(workdir, "dist/injected.js"), "nope", "utf8");

    const result = await runCli([
      "vendor",
      "manifest",
      workdir,
      "--out",
      join(scratch, "should-not-exist.json"),
      "--registry",
      registryUrl,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not match the published tarball");
    expect(result.stderr).toContain("Refusing to record a manifest");
    expect(existsSync(join(scratch, "should-not-exist.json"))).toBe(false);
  });

  it("fails when the registry cannot serve the pinned version", async () => {
    const result = await runCli([
      "vendor",
      "manifest",
      workdir,
      "--out",
      join(scratch, "m.json"),
      "--registry",
      `${registryUrl}/does-not-exist`,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Registry returned HTTP|Could not reach/);
  });

  it("rejects a directory that is not an npm package", async () => {
    const bare = await mkdtemp(join(tmpdir(), "rea-bare-"));
    try {
      const result = await runCli(["vendor", "manifest", bare, "--registry", registryUrl]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/package\.json/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("warns when the manifest is stored inside the tree it describes", async () => {
    const inside = join(pkgDir, "manifest.json");
    await runCli(["vendor", "manifest", pkgDir, "--out", inside, "--registry", registryUrl]);

    const result = await runCli(["vendor", "verify", pkgDir, "--manifest", inside]);
    expect(result.stderr).toContain("is inside the directory being verified");
    // The tree really does differ: the manifest is an unexpected file.
    expect(result.code).toBe(1);
  });

  it("requires --manifest for verify", async () => {
    const result = await runCli(["vendor", "verify", workdir]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--manifest");
  });
});

// ---------------------------------------------------------------------------
// The committed manifest
// ---------------------------------------------------------------------------

describe.skipIf(!hasVendored || !hasManifest)("committed vendor manifest", () => {
  it("describes the rea-agents version this repository pins", async () => {
    const manifest = parseManifest(readFileSync(MANIFEST_PATH, "utf8"));
    expect(manifest.package).toBe("rea-agents");
    expect(manifest.version).toBe("6.8.0");

    const installed = JSON.parse(
      readFileSync(join(VENDORED_DIR, "package.json"), "utf8"),
    ) as { name: string; version: string };
    expect(manifest.package).toBe(installed.name);
    expect(manifest.version).toBe(installed.version);
  });

  it("is anchored to a published tarball integrity", async () => {
    const manifest = parseManifest(readFileSync(MANIFEST_PATH, "utf8"));
    expect(manifest.tarballIntegrity).toMatch(/^sha512-[A-Za-z0-9+/=]+$/);
    expect(manifest.tarballSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches the installed tree, so CI detects a modified dependency", async () => {
    const manifest = parseManifest(readFileSync(MANIFEST_PATH, "utf8"));
    const result = await verifyManifest(VENDORED_DIR, manifest);

    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2398);
  }, 120_000);

  it("agrees with the integrity the registry publishes today", async () => {
    const manifest = parseManifest(readFileSync(MANIFEST_PATH, "utf8"));

    let response: Response;
    try {
      response = await fetch("https://registry.npmjs.org/rea-agents/6.8.0", {
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // Offline runs cannot check the registry; the offline verification above
      // is the guarantee the shipped bundle relies on.
      return;
    }
    if (!response.ok) return;

    const packument = (await response.json()) as { dist?: { integrity?: string } };
    expect(packument.dist?.integrity).toBe(manifest.tarballIntegrity);
  }, 60_000);
});
