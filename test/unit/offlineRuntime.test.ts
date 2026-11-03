import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../../src/config.js";
import { bundlePath, OfflineRuntime, verifyOfflineBundle } from "../../src/desktop/offlineRuntime.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
let root: string;
let manifest: Record<string, unknown>;
let digest: string;
const runtimes: OfflineRuntime[] = [];
async function saveManifest() {
  const text = JSON.stringify(manifest);
  digest = createHash("sha256").update(text).digest("hex");
  await writeFile(join(root, "manifest.json"), text);
}
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), "rea-offline-"));
  const paths = ["model.gguf", "cuda/server.exe", "cpu/server.exe", "java/bin/java.exe", "ghidra/support/analyzeHeadless.bat"];
  const files = [];
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "fixture");
    files.push({ path, size: 7, sha256: createHash("sha256").update("fixture").digest("hex") });
  }
  manifest = { version: 1, model: "fixture", modelPath: paths[0], cudaServer: paths[1], cpuServer: paths[2], javaHome: "java", ghidraHome: "ghidra", files };
  await saveManifest();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("offline payload verification", () => {
  it("verifies every dependency against the application-anchored manifest", async () => {
    expect((await verifyOfflineBundle(root, digest)).model).toBe("fixture");
    await writeFile(join(root, "model.gguf"), "changed");
    await expect(verifyOfflineBundle(root, digest)).rejects.toThrow(/verification failed/);
  });
  it("rejects a replaced manifest, traversal, duplicates and injected DLLs", async () => {
    await expect(verifyOfflineBundle(root, "0".repeat(64))).rejects.toThrow(/checksum/);
    expect(() => bundlePath(root, "../secret")).toThrow();
    expect(() => bundlePath(root, "C:\\outside.exe")).toThrow();
    const files = manifest["files"] as { path: string; size: number; sha256: string }[];
    files.push({ ...files[0]!, path: "MODEL.GGUF" });
    await saveManifest();
    await expect(verifyOfflineBundle(root, digest)).rejects.toThrow(/file entry/);
    files.pop(); await saveManifest();
    await writeFile(join(root, "cuda", "injected.dll"), "malicious");
    await expect(verifyOfflineBundle(root, digest)).rejects.toThrow(/Unlisted/);
  });
});

function childProcess(failed = false) {
  const child = Object.assign(new EventEmitter(), {
    pid: failed ? undefined : 4242,
    exitCode: null as number | null, signalCode: null as string | null,
    stderr: new EventEmitter(),
    kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); return true; }),
  });
  if (failed) queueMicrotask(() => { child.emit("error", new Error("spawn ENOENT")); child.emit("close", -1); });
  return child;
}

describe("offline model lifecycle", () => {
  it("falls back after a failed CUDA spawn, protects the key, and cleans up", async () => {
    const cpu = childProcess();
    spawn.mockImplementationOnce(() => childProcess(true)).mockReturnValueOnce(cpu);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "rea-local-qwen3-8b" }] }))));
    const runtime = new OfflineRuntime(); runtimes.push(runtime);
    const config = await runtime.start(root, parseConfig({ policy: { allowNonLoopback: true } }), join(root, "sessions"), digest);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["--n-gpu-layers", "0"]));
    expect(config.rea.env["JAVA_HOME"]).toBe(join(root, "java"));
    expect(config.llm.apiKey).toHaveLength(64);
    const path = await runtime.writeEffectiveConfig(config);
    expect(JSON.parse(await readFile(path, "utf8")).llm.apiKey).toBe(config.llm.apiKey);
    const roundTrip = await loadConfig(path);
    expect(roundTrip.policy).toEqual(config.policy);
    expect(roundTrip.rea.allowNonLoopback).toBe(config.policy.allowNonLoopback);
    expect(roundTrip.rea.env).toEqual(config.rea.env);
    expect(roundTrip.llm.apiKey).toBe(config.llm.apiKey);
    expect(roundTrip.workspaceDir).toBe(config.workspaceDir);
    await runtime.close(); await runtime.close();
    expect(cpu.kill).toHaveBeenCalled();
    await expect(readFile(path)).rejects.toThrow();
  });
  it("cancels startup and cannot spawn a model after closing", async () => {
    const runtime = new OfflineRuntime(); runtimes.push(runtime);
    const startup = runtime.start(root, DEFAULT_CONFIG, join(root, "sessions"), digest);
    const rejected = expect(startup).rejects.toThrow();
    await runtime.close(); await rejected;
    expect(spawn).not.toHaveBeenCalled();
    await expect(runtime.start(root, DEFAULT_CONFIG, join(root, "sessions"), digest)).rejects.toThrow(/closing/);
  });
});
