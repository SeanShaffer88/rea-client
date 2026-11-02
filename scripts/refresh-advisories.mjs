#!/usr/bin/env node
/**
 * Cross-platform updater for `vendor/advisories/zod.ghsa.json`.
 *
 * Replaces a POSIX-only `curl` one-liner so maintainers on Windows PowerShell,
 * cmd.exe, macOS, and Linux run the exact same command.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const pkg = process.argv[2] ?? "zod";
const outPath = resolve(process.argv[3] ?? `vendor/advisories/${pkg}.ghsa.json`);
const baseUrl = (process.env["REA_ADVISORY_API"] ?? "https://api.github.com/advisories").replace(
  /\/+$/,
  "",
);
const url = `${baseUrl}?ecosystem=npm&affects=${encodeURIComponent(pkg)}&per_page=100`;

const response = await fetch(url, {
  headers: {
    accept: "application/vnd.github+json",
    "user-agent": "rea-client-advisory-refresh/0.1.0",
  },
  signal: AbortSignal.timeout(30_000),
});

if (!response.ok) {
  process.stderr.write(`Advisory refresh failed: HTTP ${String(response.status)} from ${url}\n`);
  process.exit(1);
}

const payload = await response.json();
if (!Array.isArray(payload)) {
  process.stderr.write(`Advisory refresh failed: expected JSON array from ${url}\n`);
  process.exit(1);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
process.stdout.write(`Recorded ${String(payload.length)} advisories for ${pkg} -> ${outPath}\n`);
