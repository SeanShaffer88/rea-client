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
  AdvisoryError,
  assessDependency,
  loadKnownFindings,
} from "./packaging/advisories.js";
import type { McpToolDefinition } from "./mcp/types.js";
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
  rea-client vendor advisories [<package>] [--deny <severity>] [--advisories <file>] [--json]

Options:
  --config <path>   config.json to load (default: ./config.json)
  --json            machine-readable output
  --no-llm          doctor only: skip the model server probe
  --family <id>     tools only: restrict to one family
  --scope <name>    tools/ask: binary-core | binary-extended | full | custom
  --out <path>      vendor manifest: where to write the manifest
  --manifest <path> vendor verify: manifest to verify against
  --registry <url>  vendor manifest: npm registry (default registry.npmjs.org)
  --deny <sev>       vendor advisories: fail on reachable low|medium|high|critical (default high)
  --allow-undetermined  vendor advisories: let "could not check" pass (not recommended)
  --accept <file>    vendor advisories: findings already reviewed and accepted
  --advisories <f>   vendor advisories: read advisory JSON offline instead of querying
                     (REA_ADVISORY_API overrides the advisory service URL)
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
      deny: { type: "string" },
      advisories: { type: "string" },
      "allow-undetermined": { type: "boolean", default: false },
      accept: { type: "string" },
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
      return commandVendor(positionals.slice(1), config, {
        json: values.json === true,
        out: values.out,
        manifest: values.manifest,
        registry: values.registry,
        deny: values.deny,
        advisories: values.advisories,
        allowUndetermined: values["allow-undetermined"] === true,
        accept: values.accept,
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
  readonly deny: string | undefined;
  readonly advisories: string | undefined;
  readonly allowUndetermined?: boolean;
  readonly accept: string | undefined;
}

async function commandVendor(
  args: readonly string[],
  config: ReaClientConfig,
  options: VendorOptions,
): Promise<number> {
  const [subcommand, argument] = args;

  if (subcommand === undefined) {
    process.stderr.write(
      "usage: rea-client vendor <manifest|verify|advisories> ...\n",
    );
    return 2;
  }

  switch (subcommand) {
    case "manifest":
      if (argument === undefined) {
        process.stderr.write("usage: rea-client vendor manifest <dir> --out <file>\n");
        return 2;
      }
      return vendorManifest(argument, options);
    case "verify":
      if (argument === undefined) {
        process.stderr.write("usage: rea-client vendor verify <dir> --manifest <file>\n");
        return 2;
      }
      return vendorVerify(argument, options);
    case "advisories":
      // The package is optional here: it defaults to the vendored REA server.
      return vendorAdvisories(argument ?? "zod", config, options);
    default:
      process.stderr.write(`Unknown vendor subcommand: ${subcommand}\n`);
      return 2;
  }
}

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

/**
 * Assesses advisories for a dependency of the shipped bundle.
 *
 * Loads the live tool surface so reachability can be judged against the schemas
 * that actually accept input, rather than against the package name alone.
 */
async function vendorAdvisories(
  packageName: string,
  config: ReaClientConfig,
  options: VendorOptions,
): Promise<number> {
  const denyRaw = (options.deny ?? "high").toLowerCase();
  const deny = SEVERITIES.find((severity) => severity === denyRaw);
  if (deny === undefined) {
    process.stderr.write(`--deny must be one of: ${SEVERITIES.join(", ")}\n`);
    return 2;
  }

  // The tool surface is optional evidence: without a reachable REA server the
  // verdict falls back to "undetermined" rather than assuming safety, and the
  // reason is carried into the report so the verdict can explain itself.
  let tools: readonly McpToolDefinition[] | undefined;
  let surfaceUnavailableReason: string | undefined;
  const client = new ReaClient(config.rea);
  try {
    await client.connect();
    tools = await client.listTools();
  } catch (error) {
    surfaceUnavailableReason =
      `could not enumerate the REA tool surface (${(error as Error).message}); ` +
      `run \`rea-client doctor\` to diagnose`;
    tools = undefined;
  } finally {
    await client.close().catch(() => undefined);
  }

  let knownFindings;
  if (options.accept !== undefined) {
    try {
      knownFindings = await loadKnownFindings(options.accept);
    } catch (error) {
      if (error instanceof AdvisoryError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }

  let report;
  try {
    report = await assessDependency({
      projectRoot: process.cwd(),
      packageName,
      denySeverity: deny,
      ...(tools === undefined ? {} : { tools }),
      ...(options.advisories === undefined ? {} : { advisoriesFile: options.advisories }),
      // An air-gapped site can point this at an internal advisory mirror.
      ...(process.env["REA_ADVISORY_API"] === undefined
        ? {}
        : { advisoryBaseUrl: process.env["REA_ADVISORY_API"] }),
      ...(surfaceUnavailableReason === undefined ? {} : { surfaceUnavailableReason }),
      ...(options.allowUndetermined === true ? { allowUndetermined: true } : {}),
      ...(knownFindings === undefined ? {} : { knownFindings }),
    });
  } catch (error) {
    if (error instanceof AdvisoryError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  if (report.lookupError !== undefined) {
    process.stderr.write(`Could not assess advisories: ${report.lookupError}\n`);
    process.stderr.write(
      "Pass --advisories <file> to assess against recorded advisory data offline.\n",
    );
    return 1;
  }

  process.stdout.write(`${packageName}: ${String(report.copies.length)} installed copies\n`);
  for (const copy of report.copies) {
    const origin = copy.requiredBy.length > 0 ? copy.requiredBy.join(", ") : "transitive";
    process.stdout.write(`  ${copy.version}  ${copy.path}  (from ${origin})\n`);
  }

  if (report.assessments.length === 0) {
    process.stdout.write("No advisories affect this package.\n");
    return 0;
  }

  process.stdout.write("\n");
  for (const assessment of report.assessments) {
    const { advisory } = assessment;
    const affected =
      assessment.affectedCopies.length === 0
        ? "no installed copy"
        : assessment.affectedCopies.map((copy) => `${copy.path}@${copy.version}`).join(", ");
    process.stdout.write(
      `${assessment.verdict.toUpperCase()}  ${advisory.id} [${advisory.severity}]  ${advisory.summary}\n`,
    );
    process.stdout.write(`         range ${advisory.vulnerableRange}  affected: ${affected}\n`);
    if (advisory.patchedVersion !== undefined) {
      process.stdout.write(`         fix: upgrade to ${advisory.patchedVersion}\n`);
    }
    process.stdout.write(`         ${assessment.rationale}\n\n`);
  }

  if (report.surfaceUnavailableReason !== undefined) {
    process.stdout.write(`note: ${report.surfaceUnavailableReason}\n\n`);
  }

  const acceptedIds = new Set((report.accepted ?? []).map((entry) => entry.assessment.advisory.id));
  for (const entry of report.accepted ?? []) {
    process.stdout.write(
      `ACCEPTED  ${entry.finding.id}  ${entry.finding.rationale}\n` +
        `          mitigation: ${entry.finding.mitigation}\n` +
        `          reviewed ${entry.finding.reviewedAt}${entry.finding.reviewBy === undefined ? "" : `, review by ${entry.finding.reviewBy}`}\n\n`,
    );
  }
  for (const overdue of report.overdueReviews ?? []) {
    process.stderr.write(`warning: accepted finding needs re-review: ${overdue}\n`);
  }

  const blocking = report.blocking
    .filter((assessment) => !acceptedIds.has(assessment.advisory.id))
    .map((assessment) => `${assessment.advisory.id} (${assessment.verdict})`);

  if (blocking.length === 0) {
    process.stdout.write(`OK  no reachable advisory at or above "${deny}"\n`);
    return 0;
  }

  process.stdout.write(
    `FAIL  ${String(blocking.length)} advisory at or above "${deny}" needs attention: ` +
      `${blocking.join(", ")}\n`,
  );
  if (
    report.undetermined.some((assessment) =>
      report.blocking.some((entry) => entry.advisory.id === assessment.advisory.id),
    )
  ) {
    process.stdout.write(
      "note: undetermined verdicts block by default; pass --allow-undetermined to accept them\n",
    );
  }
  return 1;
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
