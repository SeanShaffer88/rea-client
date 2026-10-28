#!/usr/bin/env node
/**
 * Headless entry point.
 *
 * This is the verification harness for the whole engine and the reference for
 * whatever UI tier wraps it:
 *
 *   rea-client doctor              preflight every dependency
 *   rea-client tools               show the discovered catalog by family
 *   rea-client probe <binary>      open a target and print its analysis surface
 *   rea-client ask "..."           run the full agent loop
 *
 * `probe` deliberately requires no model, so the REA + provider half of the
 * stack can be validated independently of inference.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, type ReaClientConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { AgentSession } from "./agent/AgentSession.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { LlamaServerClient } from "./llm/LlamaServerClient.js";
import { ToolCatalog } from "./mcp/catalog.js";
import { ReaClient } from "./mcp/ReaClient.js";
import { projectToolResult } from "./mcp/evidence.js";
import { readBinarySession } from "./mcp/session.js";
import { canonicalizeTargetPath, TargetPathError } from "./platform/paths.js";
import { ManifestError, parseManifest, serializeManifest, verifyManifest } from "./packaging/manifest.js";
import {
  RegistryError,
  buildAnchoredManifest,
  fetchPackument,
  downloadTarball,
  readPackageIdentity,
} from "./packaging/registry.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

const USAGE = `rea-client — headless driver for the REA desktop engine

Usage:
  rea-client doctor [--config <path>] [--json] [--no-llm]
  rea-client tools  [--config <path>] [--json] [--family <id>] [--scope <name>]
  rea-client probe <binary> [--config <path>] [--json]
  rea-client ask "<question>" [--open <binary>] [--config <path>] [--json]
  rea-client vendor manifest <dir> --out <file> [--registry <url>] [--json]
  rea-client vendor verify <dir> --manifest <file> [--json]

Options:
  --config <path>   config.json to load (default: ./config.json)
  --json            machine-readable output
  --no-llm          doctor only: skip the model server probe
  --family <id>     tools only: restrict to one family
  --scope <name>    tools/ask: binary-core | binary-extended | full | custom
  --out <path>      vendor manifest: where to write the manifest
  --manifest <path> vendor verify: manifest to verify against
  --registry <url>  vendor manifest: npm registry (default registry.npmjs.org)
  --help, -h        show this help

Exit codes:
  0 success   1 check failed   2 bad usage
`;

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      "no-llm": { type: "boolean", default: false },
      family: { type: "string" },
      scope: { type: "string" },
      open: { type: "string" },
      out: { type: "string" },
      manifest: { type: "string" },
      registry: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];

  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }

  const config = await loadConfig(resolve(values.config ?? "config.json"));

  switch (command) {
    case "doctor":
      return commandDoctor(config, values.json === true, values["no-llm"] === true);
    case "tools":
      return commandTools(config, values.json === true, values.family, values.scope);
    case "probe":
      return commandProbe(config, positionals[1], values.json === true);
    case "ask":
      return commandAsk(config, positionals.slice(1), values.json === true, values.open, values.scope);
    case "vendor":
      return commandVendor(positionals.slice(1), {
        json: values.json === true,
        out: values.out,
        manifest: values.manifest,
        registry: values.registry,
      });
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

async function commandDoctor(
  config: ReaClientConfig,
  json: boolean,
  skipLlm: boolean,
): Promise<number> {
  const report = await runDoctor(config, { skipLlm });

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.healthy ? 0 : 1;
  }

  const symbols: Record<string, string> = { ok: "PASS", warn: "WARN", fail: "FAIL", skipped: "SKIP" };
  for (const check of report.checks) {
    process.stdout.write(`${symbols[check.status] ?? "?"}  ${check.label}: ${check.detail}\n`);
    if (check.remediation !== undefined && check.status !== "ok") {
      process.stdout.write(`      -> ${check.remediation}\n`);
    }
  }
  process.stdout.write(`\n${report.healthy ? "Ready." : "Not ready — resolve the failures above."}\n`);
  return report.healthy ? 0 : 1;
}

async function commandTools(
  config: ReaClientConfig,
  json: boolean,
  family: string | undefined,
  scopeOption: string | undefined,
): Promise<number> {
  const client = new ReaClient(config.rea);
  try {
    await client.connect();
    const tools = await client.listTools();
    const catalog = ToolCatalog.from(tools);

    const scope = (scopeOption ?? config.agent.toolScope) as typeof config.agent.toolScope;
    const resolved = catalog.resolveScope(scope, config.agent.customTools);

    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            total: catalog.size,
            families: catalog.populatedFamilies().map((group) => ({
              id: group.id,
              label: group.label,
              count: group.tools.length,
              tools: family === undefined || family === group.id ? group.tools.map((t) => t.name) : undefined,
            })),
            scope: { name: resolved.scope, count: resolved.tools.length, missing: resolved.missing },
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    for (const group of catalog.populatedFamilies()) {
      if (family !== undefined && family !== group.id) continue;
      process.stdout.write(`\n${group.label} (${group.id}) — ${group.tools.length}\n`);
      for (const tool of group.tools) {
        process.stdout.write(`  ${tool.name}\n`);
      }
    }
    process.stdout.write(
      `\nTotal: ${catalog.size} tools. Scope "${resolved.scope}" advertises ${resolved.tools.length}.` +
        `${resolved.missing.length > 0 ? ` Missing: ${resolved.missing.join(", ")}` : ""}\n`,
    );
    return 0;
  } finally {
    await client.close();
  }
}

async function commandProbe(
  config: ReaClientConfig,
  target: string | undefined,
  json: boolean,
): Promise<number> {
  if (target === undefined) {
    process.stderr.write("probe requires a binary path.\n");
    return 2;
  }

  let path: string;
  try {
    path = canonicalizeTargetPath(target, { platform: currentPlatform() });
  } catch (error) {
    if (error instanceof TargetPathError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const client = new ReaClient(config.rea);
  try {
    await client.connect();
    const opened = await client.callTool("open_binary", { path });
    const openObservation = projectToolResult(opened, { maxChars: 4_000 });

    const sessionResult = await client.callTool("binary_session", {});
    const session = readBinarySession(sessionResult);

    const overview = await client.callTool("binary_overview", {});
    const overviewObservation = projectToolResult(overview, { maxChars: 6_000 });

    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            open: openObservation.text,
            session: session === undefined ? null : { ...session, raw: undefined },
            overview: overviewObservation.text,
          },
          null,
          2,
        )}\n`,
      );
      return overviewObservation.text.startsWith("TOOL_ERROR") ? 1 : 0;
    }

    process.stdout.write(`Target: ${session?.targetPath ?? path}\n`);
    if (session !== undefined) {
      process.stdout.write(
        `Format: ${session.format ?? "?"}  Arch: ${session.architecture ?? "?"}  Provider: ${session.providerId ?? "none"}\n`,
      );
    }
    process.stdout.write(`\n${openObservation.text}\n\n${overviewObservation.text}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

async function commandAsk(
  config: ReaClientConfig,
  words: readonly string[],
  json: boolean,
  openPath: string | undefined,
  scopeOption: string | undefined,
): Promise<number> {
  const question = words.join(" ").trim();
  if (question === "") {
    process.stderr.write("ask requires a question.\n");
    return 2;
  }

  const client = new ReaClient(config.rea);
  client.on("stderr", ({ line }) => {
    if (!json) process.stderr.write(`[rea] ${line}\n`);
  });

  try {
    await client.connect();
    const tools = await client.listTools();
    const catalog = ToolCatalog.from(tools);
    const scope = catalog.resolveScope(
      (scopeOption ?? config.agent.toolScope) as typeof config.agent.toolScope,
      config.agent.customTools,
    );

    let session = undefined;
    if (openPath !== undefined) {
      const path = canonicalizeTargetPath(openPath, { platform: currentPlatform() });
      await client.callTool("open_binary", { path });
      session = readBinarySession(await client.callTool("binary_session", {}));
    } else {
      session = readBinarySession(await client.callTool("binary_session", {}));
    }

    const chat = new LlamaServerClient({
      baseUrl: config.llm.baseUrl,
      ...(config.llm.apiKey === undefined ? {} : { apiKey: config.llm.apiKey }),
      requestTimeoutMs: config.llm.requestTimeoutMs,
      allowNonLoopback: config.policy.allowNonLoopback,
    });

    const agent = new AgentSession({
      connection: client,
      chat,
      catalog,
      scope,
      model: config.llm.model,
      maxIterations: config.agent.maxIterations,
      maxToolResultChars: config.agent.maxToolResultChars,
      temperature: config.llm.temperature,
      maxTokens: config.llm.maxTokens,
      contextWindow: config.llm.contextWindow,
      systemPrompt: buildSystemPrompt({
        catalog,
        advertisedToolCount: scope.tools.length,
        session,
      }),
    });

    if (scope.missing.length > 0 && !json) {
      process.stderr.write(`[warn] scope "${scope.scope}" is missing: ${scope.missing.join(", ")}\n`);
    }

    agent.on("assistant_delta", ({ text }) => {
      if (!json) process.stdout.write(text);
    });
    agent.on("tool_call_started", ({ name, arguments: args }) => {
      process.stderr.write(`\n  -> ${name} ${JSON.stringify(args)}\n`);
    });
    agent.on("tool_call_finished", ({ name, ok, elapsedMs, evidenceId }) => {
      process.stderr.write(
        `  <- ${ok ? "ok" : "ERROR"} ${name} (${String(elapsedMs)}ms${evidenceId === undefined ? "" : `, ${evidenceId.slice(0, 12)}`})\n`,
      );
    });

    const controller = new AbortController();
    process.once("SIGINT", () => {
      controller.abort();
    });

    const result = await agent.ask(question, { signal: controller.signal });

    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            content: result.content,
            reason: result.reason,
            iterations: result.iterations,
            toolCallsExecuted: result.toolCallsExecuted,
            usage: result.usage ?? null,
            transcript: agent.transcript(),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`\n`);
    }

    return result.reason === "final_answer" ? 0 : 1;
  } finally {
    await client.close();
  }
}

/** True when `candidate` resolves inside `directory`. */
function isInside(directory: string, candidate: string): boolean {
  const relativeTo = relative(resolve(directory), resolve(candidate));
  return relativeTo !== "" && !relativeTo.startsWith("..") && !isAbsolute(relativeTo);
}

interface VendorOptions {
  readonly json: boolean;
  readonly out: string | undefined;
  readonly manifest: string | undefined;
  readonly registry: string | undefined;
}

async function commandVendor(args: readonly string[], options: VendorOptions): Promise<number> {
  const [subcommand, directory] = args;

  if (subcommand === undefined || directory === undefined) {
    process.stderr.write("usage: rea-client vendor <manifest|verify> <dir> [--out|--manifest <file>]\n");
    return 2;
  }

  switch (subcommand) {
    case "manifest":
      return vendorManifest(directory, options);
    case "verify":
      return vendorVerify(directory, options);
    default:
      process.stderr.write(`Unknown vendor subcommand: ${subcommand}\n`);
      return 2;
  }
}

/**
 * Records a manifest for a vendored directory, anchored to the published
 * tarball so the hashes are traceable to one artifact.
 *
 * Refuses to write a manifest when the directory does not match the tarball:
 * a manifest that describes code the registry never published is worse than no
 * manifest at all.
 */
async function vendorManifest(directory: string, options: VendorOptions): Promise<number> {
  let identity: { name: string; version: string };
  try {
    identity = await readPackageIdentity(directory);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  try {
    const packument = await fetchPackument(identity.name, identity.version, {
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    });
    const tarball = await downloadTarball(packument.tarballUrl, packument.integrity);
    const { manifest, comparison } = await buildAnchoredManifest(directory, packument, tarball);

    const problems = [
      ...comparison.metadataMismatches,
      ...(comparison.missing.length > 0 ? [`missing from directory: ${comparison.missing.slice(0, 5).join(", ")}`] : []),
      ...(comparison.extra.length > 0 ? [`not in tarball: ${comparison.extra.slice(0, 5).join(", ")}`] : []),
      ...(comparison.modified.length > 0
        ? [`modified: ${comparison.modified.slice(0, 5).map((entry) => entry.path).join(", ")}`]
        : []),
    ];

    if (problems.length > 0) {
      process.stderr.write(
        `${identity.name}@${identity.version} does not match the published tarball:\n` +
          problems.map((problem) => `  - ${problem}`).join("\n") +
          "\nRefusing to record a manifest for unverified code.\n",
      );
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, comparison }, null, 2)}\n`);
      }
      return 1;
    }

    const text = serializeManifest(manifest);

    if (options.out === undefined) {
      process.stdout.write(text);
    } else {
      // Create the parent so `--out vendor/x.json` works from a clean checkout.
      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(options.out, text, "utf8");
    }

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            package: manifest.package,
            version: manifest.version,
            files: manifest.files.length,
            totalBytes: manifest.totalBytes,
            tarballIntegrity: manifest.tarballIntegrity,
            writtenTo: options.out ?? null,
          },
          null,
          2,
        )}\n`,
      );
    } else if (options.out !== undefined) {
      process.stdout.write(
        `Recorded ${String(manifest.files.length)} files for ${manifest.package}@${manifest.version} ` +
          `-> ${options.out}\nintegrity: ${manifest.tarballIntegrity ?? "(none)"}\n`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof RegistryError || error instanceof ManifestError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/** Verifies a vendored directory against a recorded manifest. Offline. */
async function vendorVerify(directory: string, options: VendorOptions): Promise<number> {
  if (options.manifest === undefined) {
    process.stderr.write("vendor verify requires --manifest <file>\n");
    return 2;
  }

  let manifest;
  try {
    manifest = parseManifest(await readFile(options.manifest, "utf8"));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  // A manifest stored inside the tree it describes is itself an unexpected
  // file, which turns a clean verification into a confusing failure.
  const manifestInsideTree = isInside(directory, options.manifest);
  if (manifestInsideTree) {
    process.stderr.write(
      `warning: ${options.manifest} is inside the directory being verified, so it is ` +
        `counted as an unexpected file. Store manifests outside the vendored tree.\n`,
    );
  }

  const result = await verifyManifest(directory, manifest);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    process.stdout.write(
      `OK  ${manifest.package}@${manifest.version}: ${String(result.checked)} files match the manifest\n`,
    );
    if (manifest.tarballIntegrity !== undefined) {
      process.stdout.write(`    anchored to ${manifest.tarballIntegrity}\n`);
    }
    return 0;
  }

  process.stderr.write(`DRIFT  ${manifest.package}@${manifest.version} does not match its manifest\n`);
  if (result.identityError !== undefined) process.stderr.write(`  - ${result.identityError}\n`);
  for (const path of result.missing) process.stderr.write(`  - missing: ${path}\n`);
  for (const path of result.extra) process.stderr.write(`  - unexpected: ${path}\n`);
  for (const entry of result.modified) {
    process.stderr.write(`  - modified: ${entry.path}\n`);
  }
  return 1;
}

function currentPlatform(): "windows" | "posix" {
  return process.platform === "win32" ? "windows" : "posix";
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
