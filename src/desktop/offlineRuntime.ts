import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { createServer } from "node:net";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ReaClientConfig } from "../config.js";

interface BundleManifest {
  version: number; model: string; modelPath: string; cudaServer: string; cpuServer: string;
  javaHome: string; ghidraHome: string;
  files: { path: string; sha256: string; size: number }[];
}

export function bundlePath(root: string, path: string): string {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes(":") || path.includes("\\") || path.split("/").includes("..")) throw new Error("Invalid offline payload path.");
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Offline payload path escapes its directory.");
  return target;
}

export async function verifyOfflineBundle(root: string, expectedHash: string, signal?: AbortSignal): Promise<BundleManifest> {
  signal?.throwIfAborted();
  const text = await readFile(resolve(root, "manifest.json"), "utf8");
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || createHash("sha256").update(text).digest("hex") !== expectedHash) throw new Error("Offline payload manifest checksum mismatch.");
  const manifest = JSON.parse(text) as BundleManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Invalid offline payload manifest.");
  const canonicalRoot = await realpath(root);
  const files = new Set<string>();
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    if (typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || files.has(file.path.toLowerCase())) throw new Error("Invalid offline payload file entry.");
    const path = bundlePath(root, file.path);
    const canonical = await realpath(path);
    const rel = relative(canonicalRoot, canonical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Offline payload symlink escapes its directory.");
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of createReadStream(path, { signal })) { hash.update(chunk); size += chunk.length; }
    if (size !== file.size || hash.digest("hex") !== file.sha256) throw new Error(`Offline payload verification failed: ${file.path}`);
    files.add(file.path.toLowerCase());
  }
  for (const path of [manifest.modelPath, manifest.cudaServer, manifest.cpuServer, `${manifest.javaHome}/bin/java.exe`, `${manifest.ghidraHome}/support/analyzeHeadless.bat`]) {
    bundlePath(root, path);
    if (!files.has(path.toLowerCase())) throw new Error(`Offline payload required file is not verified: ${path}`);
  }
  async function rejectExtras(folder: string): Promise<void> {
    signal?.throwIfAborted();
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Offline payload must not contain symlinks.");
      if (entry.isDirectory()) await rejectExtras(path);
      else {
        const name = relative(root, path).replaceAll("\\", "/");
        if (name !== "manifest.json" && !files.has(name.toLowerCase())) throw new Error(`Unlisted offline payload file: ${name}`);
      }
    }
  }
  await rejectExtras(root);
  return manifest;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot reserve local model port.");
  await new Promise<void>((ok, fail) => server.close((error) => error ? fail(error) : ok()));
  return address.port;
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((ok) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000);
    const done = () => { clearTimeout(timer); ok(); };
    child.once("exit", done);
    child.once("close", done);
    child.kill("SIGTERM");
  });
}

/** Owns only this application's bundled server, never an external model service. */
export class OfflineRuntime {
  private child: ChildProcess | undefined;
  private temporaryDir: string | undefined;
  private readonly abort = new AbortController();
  private starting: Promise<ReaClientConfig> | undefined;
  private closing: Promise<void> | undefined;
  public start(root: string, config: ReaClientConfig, sessionDir: string, manifestHash: string, progress: (stage: string) => void = () => undefined): Promise<ReaClientConfig> {
    if (this.abort.signal.aborted) return Promise.reject(new Error("Offline runtime is closing."));
    this.starting ??= this.startInternal(root, config, sessionDir, manifestHash, progress);
    return this.starting;
  }
  private async startInternal(root: string, config: ReaClientConfig, sessionDir: string, manifestHash: string, progress: (stage: string) => void): Promise<ReaClientConfig> {
    progress("Verifying Bundled Files");
    const manifest = await verifyOfflineBundle(root, manifestHash, this.abort.signal);
    this.abort.signal.throwIfAborted();
    await mkdir(sessionDir, { recursive: true });
    this.temporaryDir = resolve(sessionDir, `session-${process.pid}-${randomBytes(6).toString("hex")}`);
    await mkdir(this.temporaryDir, { mode: 0o700 });
    const key = randomBytes(32).toString("hex");
    const keyPath = resolve(this.temporaryDir, "model.key");
    await writeFile(keyPath, key, { mode: 0o600 });
    let lastError: unknown;
    for (const [server, layers] of [[manifest.cudaServer, "99"], [manifest.cpuServer, "0"]] as const) {
      progress(layers === "99" ? "Loading Local Model" : "Loading Local Model On CPU");
      this.abort.signal.throwIfAborted();
      const port = await availablePort();
      let stderr = "";
      const child = spawn(bundlePath(root, server), ["--model", bundlePath(root, manifest.modelPath), "--alias", "rea-local-qwen3-8b", "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "8192", "--parallel", "1", "--n-gpu-layers", layers, "--jinja", "--chat-template-kwargs", '{"enable_thinking":false}', "--no-webui", "--api-key-file", keyPath, "--top-p", "0.8", "--top-k", "20", "--min-p", "0"], { cwd: dirname(bundlePath(root, server)), env: getDefaultEnvironment(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      this.child = child;
      let spawnError: Error | undefined;
      child.on("error", (error) => { spawnError = error; });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
      try {
        const deadline = Date.now() + 120_000;
        let ready = false;
        while (Date.now() < deadline) {
          this.abort.signal.throwIfAborted();
          if (spawnError || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) throw spawnError ?? new Error(`Bundled model exited: ${stderr}`);
          const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(2000)]) }).catch(() => undefined);
          if (response?.ok) {
            const models = await response.json() as { data?: { id?: string }[] };
            if (models.data?.some((model) => model.id === "rea-local-qwen3-8b")) { ready = true; break; }
          }
          await new Promise((ok) => setTimeout(ok, 250));
        }
        if (!ready) throw new Error(`Bundled model startup timed out: ${stderr}`);
        this.abort.signal.throwIfAborted();
        return {
          ...config,
          llm: { ...config.llm, baseUrl: `http://127.0.0.1:${port}/v1`, model: "rea-local-qwen3-8b", apiKey: key, contextWindow: 8192, temperature: 0.7 },
          rea: { ...config.rea, env: { ...config.rea.env, GHIDRA_INSTALL_DIR: bundlePath(root, manifest.ghidraHome), JAVA_HOME: bundlePath(root, manifest.javaHome) } },
        };
      } catch (error) { lastError = error; await stop(child); this.child = undefined; }
    }
    throw lastError;
  }
  public async writeEffectiveConfig(config: ReaClientConfig): Promise<string> {
    this.abort.signal.throwIfAborted();
    if (!this.temporaryDir) throw new Error("Offline runtime is not started.");
    const path = resolve(this.temporaryDir, "config.json");
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    return path;
  }
  public close(): Promise<void> {
    this.abort.abort();
    this.closing ??= (async () => {
      await stop(this.child); this.child = undefined;
      await this.starting?.catch(() => undefined);
      await stop(this.child); this.child = undefined;
      if (this.temporaryDir) { await rm(this.temporaryDir, { recursive: true, force: true }); this.temporaryDir = undefined; }
    })();
    return this.closing;
  }
}
