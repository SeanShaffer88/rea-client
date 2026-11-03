// Build-time only. Installed applications never download dependencies.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const cache = resolve(process.env.REA_ASSET_CACHE ?? join(root, "..", "offline-assets"));
const output = resolve(root, ".offline-staging");
const finalOutput = resolve(root, "offline");
const llamaBase = "https://github.com/ggml-org/llama.cpp/releases/download/b12065/";
const assets = [
  ["Qwen3-8B-Q4_K_M.gguf", "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/7c41481f57cb95916b40956ab2f0b139b296d974/Qwen3-8B-Q4_K_M.gguf", "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785", "models"],
  ["ghidra_12.1.4_PUBLIC_20260921.zip", "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip", "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db", "ghidra"],
  ["OpenJDK25U-jdk_x64_windows_hotspot_25.0.5_8.zip", "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jdk_x64_windows_hotspot_25.0.5_8.zip", "636bdc13dc649ddc7d5921c5c7d23cca6e44fd19d662b45cc9c02135a6c96c42", "java"],
  ["llama-b12065-bin-win-cuda-13.4-x64.zip", llamaBase + "llama-b12065-bin-win-cuda-13.4-x64.zip", "189a579bb94f539dca421bd80a1b9d4989a49fe7b0a6c25e03c602386d915b9b", "llama/cuda"],
  ["cudart-llama-bin-win-cuda-13.4-x64.zip", llamaBase + "cudart-llama-bin-win-cuda-13.4-x64.zip", "738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668", "llama/cuda"],
  ["llama-b12065-bin-win-cpu-x64.zip", llamaBase + "llama-b12065-bin-win-cpu-x64.zip", "7c4135dd85af0764ae14206cb98843c731970200fcc803d85cf21a7e1df4306c", "llama/cpu"],
  ["VC_redist.x64.exe", "https://download.visualstudio.microsoft.com/download/pr/73aabf2e-9532-4f68-99f7-3247081a619c/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe", "cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b", "crt"],
];
async function hash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
await mkdir(cache, { recursive: true });
await Promise.all(assets.map(async ([name, url, sha256]) => {
  const path = join(cache, name);
  if (!(await stat(path).catch(() => undefined)) || await hash(path) !== sha256) {
    console.log(`Downloading ${name}`);
    const temporary = path + ".part";
    await promisify(execFile)("curl.exe", ["--fail", "--location", "--retry", "3", "--max-time", "600", "--speed-time", "30", "--speed-limit", "1024", "--silent", "--show-error", "--output", temporary, url], { windowsHide: true });
    if (await hash(temporary) !== sha256) throw new Error(`${name}: downloaded SHA256 mismatch`);
    await rm(path, { force: true });
    await rename(temporary, path);
  }
  if (await hash(path) !== sha256) throw new Error(`${name}: SHA256 mismatch; remove the incomplete cache file and retry`);
}));
// Rebuild only this fixed, workspace-owned output after every input is verified.
if (output !== join(root, ".offline-staging")) throw new Error("Unsafe staging directory");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const [name, , , destination] of assets) {
  if (name === "VC_redist.x64.exe") continue;
  const path = join(cache, name);
  const target = join(output, destination);
  await mkdir(target, { recursive: true });
  if (name.endsWith(".zip")) {
    // Paths are passed through environment variables, never interpolated into shell code.
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:REA_ARCHIVE); try { foreach($entry in $zip.Entries) { $dest=[IO.Path]::GetFullPath([IO.Path]::Combine($env:REA_DESTINATION,$entry.FullName)); if(-not $dest.StartsWith($env:REA_DESTINATION+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe archive entry' }; if($entry.Name) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest)) | Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$dest,$true) } else { [IO.Directory]::CreateDirectory($dest) | Out-Null } } } finally { $zip.Dispose() }"], {
      env: { ...process.env, REA_ARCHIVE: path, REA_DESTINATION: target }, windowsHide: true, stdio: "inherit",
    });
  } else await cp(path, join(target, name));
  console.log(`Verified and staged ${name}`);
}

// Extract the pinned Microsoft redistributable's CABs; never execute its installer.
const crtExtraction = join(cache, "crt-14.44.35211.0");
await mkdir(crtExtraction, { recursive: true });
const redist = await readFile(join(cache, "VC_redist.x64.exe"));
for (const [name, offset, length] of [["ux", 479744, 195988], ["payload", 686152, 24939223]]) {
  const cab = redist.subarray(offset, offset + length);
  if (cab.length !== length || cab.toString("ascii", 0, 4) !== "MSCF" || cab.readUInt32LE(8) !== length) throw new Error("Pinned Microsoft CAB layout changed");
  const cabPath = join(crtExtraction, `${name}.cab`);
  const target = join(crtExtraction, name);
  await writeFile(cabPath, cab); await mkdir(target, { recursive: true });
  execFileSync("expand.exe", [cabPath, "-F:*", target], { windowsHide: true, stdio: "pipe" });
}
const crtRoot = join(crtExtraction, "minimum");
await mkdir(crtRoot, { recursive: true });
execFileSync("expand.exe", [join(crtExtraction, "payload", "a12"), "-F:*", crtRoot], { windowsHide: true, stdio: "pipe" });
const crt = JSON.parse(await readFile(join(root, "build", "crt-pins.json"), "utf8"));
for (const entry of crt.files) {
  const path = join(crtRoot, `${entry.name}_amd64`);
  if (await hash(path) !== entry.sha256) throw new Error(`Microsoft CRT ${entry.name} does not match pinned VS ${crt.version}`);
  for (const target of ["llama/cpu", "llama/cuda", "ghidra/ghidra_12.1.4_PUBLIC/Ghidra/Features/PDB/os/win_x86_64"]) {
    await mkdir(join(output, target), { recursive: true });
    await cp(path, join(output, target, entry.name));
  }
}
const licenses = join(output, "licenses");
await mkdir(licenses, { recursive: true });
for (const [name, url] of [
  ["llama-MIT.txt", "https://raw.githubusercontent.com/ggml-org/llama.cpp/b12065/LICENSE"],
  ["Qwen-Apache-2.0.txt", "https://www.apache.org/licenses/LICENSE-2.0.txt"],
  ["NVIDIA-CUDA-EULA.html", "https://docs.nvidia.com/cuda/eula/index.html"],
]) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cannot stage license ${name}: ${response.status}`);
  await writeFile(join(licenses, name), await response.text());
}
const crtLicense = join(crtExtraction, "ux", "u4");
if (await hash(crtLicense) !== "8099dc3cf9502c335da829e5c755948a12e3e6de490eb492a99deb673d883d8b") throw new Error("Microsoft runtime EULA checksum mismatch");
await cp(crtLicense, join(licenses, "Microsoft-VC-Runtime-EULA.rtf"));
await writeFile(join(licenses, "SOURCES.txt"), [
  "Qwen3-8B Q4_K_M: Apache 2.0; official immutable model repository: https://huggingface.co/Qwen/Qwen3-8B-GGUF/tree/7c41481f57cb95916b40956ab2f0b139b296d974",
  "llama.cpp b12065: MIT; https://github.com/ggml-org/llama.cpp/tree/b12065",
  "Ghidra 12.1.4: Apache 2.0 plus bundled third-party notices retained in full distribution; https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build",
  "Temurin OpenJDK 25.0.5+8: GPLv2 with Classpath Exception; full legal directory retained; corresponding source https://github.com/adoptium/jdk25u/tree/jdk-25.0.5+8",
  `Microsoft VC143 CRT ${crt.version}: app-local distributable files extracted from the SHA256-pinned official Microsoft VC_redist.x64.exe without executing its installer; bundled Microsoft runtime EULA applies; https://learn.microsoft.com/visualstudio/releases/2022/redistribution`,
  "NVIDIA CUDA runtime redistributable libraries: accompanying EULA; https://docs.nvidia.com/cuda/eula/index.html",
].join("\n") + "\n");

async function find(folder, filename) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) { const found = await find(path, filename); if (found) return found; }
    else if (entry.name === filename) return path;
  }
}
const relative = (path) => path.slice(output.length + 1).replaceAll("\\", "/");
const required = async (folder, name) => { const path = await find(join(output, folder), name); if (!path) throw new Error(`Missing ${folder}/${name}`); return relative(path); };
const manifest = {
  version: 1, model: "Qwen3-8B-Q4_K_M", modelPath: "models/Qwen3-8B-Q4_K_M.gguf",
  cudaServer: await required("llama/cuda", "llama-server.exe"), cpuServer: await required("llama/cpu", "llama-server.exe"),
  javaHome: (await required("java", "java.exe")).replace(/\/bin\/java.exe$/, ""),
  ghidraHome: (await required("ghidra", "analyzeHeadless.bat")).replace(/\/support\/analyzeHeadless.bat$/, ""),
  files: [], sources: assets.map(([name, url, sha256]) => ({ name, url, sha256 })),
};
async function inventory(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else if (entry.name !== "manifest.json") manifest.files.push({ path: relative(path), sha256: await hash(path), size: (await stat(path)).size });
  }
}
await inventory(output);
await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const manifestHash = await hash(join(output, "manifest.json"));
if (finalOutput !== join(root, "offline")) throw new Error("Unsafe payload directory");
await rm(finalOutput, { recursive: true, force: true });
await rename(output, finalOutput);
await writeFile(join(root, "build", "offline-manifest.sha256"), manifestHash + "\n");
await writeFile(join(root, "build", "offline-pins.nsh"), `!define OFFLINE_MANIFEST_SHA256 "${manifestHash}"\n`);
console.log(`Offline payload ready: ${finalOutput} (${manifest.files.length} verified files)`);
