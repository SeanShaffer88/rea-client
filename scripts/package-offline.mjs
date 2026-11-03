import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyOfflineBundle } from "../dist/desktop/offlineRuntime.js";

const root = resolve(import.meta.dirname, "..");
const release = join(root, "release");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const hash = (await readFile(join(root, "build/offline-manifest.sha256"), "utf8")).trim();
await verifyOfflineBundle(join(root, "offline"), hash);
const installer = join(release, `rea-client-${version}-windows-x64-setup.exe`);
if (!(await stat(installer)).isFile()) throw new Error("Build the Windows installer first.");
const kit = join(release, "offline-kit");
if (kit !== resolve(root, "release", "offline-kit")) throw new Error("Unsafe kit output path");
await rm(kit, { recursive: true, force: true });
await mkdir(kit, { recursive: true });
await cp(installer, join(kit, "Setup.exe"));
await cp(join(root, "offline"), join(kit, "offline"), { recursive: true });
await writeFile(join(kit, "INSTALL.txt"), "Extract the entire ZIP, keeping Setup.exe beside the offline folder. Run Setup.exe. All analysis/model dependencies install locally; no network or separate tools are required. Keep this kit for repair or reinstall. Windows 11 x64 required. Allow at least 25 GB free space for the downloaded ZIP, extracted kit, installed dependencies, and working data together. An NVIDIA driver may accelerate the model; CPU fallback is included.\r\n");
const zip = join(release, `rea-client-${version}-windows-x64-offline.zip`);
if (process.argv.includes("--no-zip")) { console.log(`Offline kit: ${kit}`); process.exit(0); }
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; if([IO.File]::Exists($env:REA_KIT_ZIP)){[IO.File]::Delete($env:REA_KIT_ZIP)}; [IO.Compression.ZipFile]::CreateFromDirectory($env:REA_KIT_ROOT,$env:REA_KIT_ZIP,[IO.Compression.CompressionLevel]::Fastest,$false)"], { env: { ...process.env, REA_KIT_ROOT: kit, REA_KIT_ZIP: zip }, windowsHide: true, stdio: "inherit" });
console.log(`Offline kit: ${kit}\nZip64: ${zip}`);
