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

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  ConfigError,
  loadConfig,
  type ReaClientConfig,
  type ToolScopeName,
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { createAgentSession } from "./agent/AgentSession.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { LlamaServerClient } from "./llm/LlamaServerClient.js";
import { ToolCatalog } from "./mcp/catalog.js";
import { ReaClient } from "./mcp/ReaClient.js";
import { ToolObservation, projectToolResult } from "./mcp/evidence.js";
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
import { EngineRpcServer } from "./bridge/JsonRpcServer.js";
import {
  CaseStoreError,
  casesRoot,
  deleteCase,
  listCases,
  normalizeCaseName,
  openCase,
  resolveCaseDirectory,
  saveCase,
  withFile,
  type CaseFile,
} from "./cases/store.js";
import type { CaseSummary } from "./cases/report.js";
import { readExportedBundle } from "./mcp/evidenceBundle.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CLI_VERSION = "0.3.0";
const VALID_SCOPES: readonly ToolScopeName[] = [
  "binary-core",
  "binary-extended",
  "full",
  "custom",
];

const USAGE = `rea-client — headless driver for the REA desktop engine

Usage:
  rea-client doctor [--config <path>] [--json] [--no-llm]
  rea-client tools  [--config <path>] [--json] [--family <id>] [--scope <name>]
  rea-client probe <binary> [--config <path>] [--json]
  rea-client ask "<question>" [--open <binary>] [--scope <name>] [--config <path>] [--json]
  rea-client serve  [--config <path>]
  rea-client vendor manifest <dir> [--out <file>] [--registry <url>] [--json]
  rea-client vendor verify <dir> --manifest <file> [--json]
  rea-client vendor advisories [<package>] [--deny <severity>] [--advisories <file>] [--json]
  rea-client case list   [--workspace <dir>] [--json]
  rea-client case show   <name> [--workspace <dir>] [--json] [--report <file>]
  rea-client case save   <name> --report <file> --json-report <file>
                         [--workspace <dir>] [--overwrite] [--with-evidence] [--json]
  rea-client case delete <name> [--workspace <dir>] [--json]
  rea-client evidence export [<case>] [--out <path>] [--workspace <dir>] [--overwrite] [--json]

Options:
  --config <path>   config.json to load (default: ./config.json)
  --json            machine-readable output
  --no-llm          doctor only: skip the model server probe
  --family <id>     tools only: restrict to one family
  --scope <name>    tools/ask: binary-core | binary-extended | full | custom
  --open <path>     ask only: open target binary before starting the turn
  --out <path>      vendor manifest: where to write the manifest
  --manifest <path> vendor verify: manifest to verify against
  --registry <url>  vendor manifest: npm registry (default registry.npmjs.org)
  --deny <sev>       vendor advisories: fail on reachable low|medium|high|critical (default high)
  --allow-undetermined  vendor advisories: let "could not check" pass (not recommended)
  --accept <file>    vendor advisories: findings already reviewed and accepted
  --advisories <f>   vendor advisories: read advisory JSON offline instead of querying
                     (REA_ADVISORY_API overrides the advisory service URL)
  --workspace <dir> case/evidence: workspace root (default: "workspaceDir" from config)
  --report <file>   case save: Markdown report to store ("-" reads stdin)
                    case show: write the stored report to this file
  --json-report <f> case save: analysis JSON to store ("-" reads stdin)
  --with-evidence   case save: also export REA's evidence bundle into the case
  --overwrite       case save / evidence export: replace an existing folder or bundle
  --version, -v     print version
  --help, -h        show this help

Exit codes:
  0 success   1 check failed   2 bad usage
`;

function validateScopeOption(
  scopeOption: string | undefined,
  config: ReaClientConfig,
): { readonly ok: true; readonly scope: ToolScopeName } | { readonly ok: false; readonly message: string } {
  if (scopeOption === undefined) {
    return { ok: true, scope: config.agent.toolScope };
  }
  const match = VALID_SCOPES.find((candidate) => candidate === scopeOption);
  if (match === undefined) {
    return {
      ok: false,
      message: `--scope must be one of: ${VALID_SCOPES.join(", ")} (received ${JSON.stringify(scopeOption)})`,
    };
  }
  if (match === "custom" && config.agent.customTools.length === 0) {
    return {
      ok: false,
      message: '--scope custom requires at least one tool in config "agent.customTools".',
    };
  }
  return { ok: true, scope: match };
}

async function main(argv: readonly string[]): Promise<number> {
  let parsedArgs: ReturnType<typeof parseArgs>;
  try {
    parsedArgs = parseArgs({
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
        workspace: { type: "string" },
        report: { type: "string" },
        "json-report": { type: "string" },
        "with-evidence": { type: "boolean", default: false },
        overwrite: { type: "boolean", default: false },
        version: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const values = parsedArgs.values as {
    config?: string;
    json?: boolean;
    "no-llm"?: boolean;
    family?: string;
    scope?: string;
    open?: string;
    out?: string;
    manifest?: string;
    registry?: string;
    deny?: string;
    advisories?: string;
    "allow-undetermined"?: boolean;
    accept?: string;
    workspace?: string;
    report?: string;
    "json-report"?: string;
    "with-evidence"?: boolean;
    overwrite?: boolean;
    version?: boolean;
    help?: boolean;
  };
  const positionals = parsedArgs.positionals;

  if (values.version === true) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  const command = positionals[0];

  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }

  let config: ReaClientConfig;
  try {
    config = await loadConfig(resolve(values.config ?? "config.json"));
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Configuration error (${error.message})\n`);
      return 2;
    }
    throw error;
  }

  switch (command) {
    case "doctor":
      return commandDoctor(config, values.json === true, values["no-llm"] === true);
    case "tools":
      return commandTools(config, values.json === true, values.family, values.scope);
    case "probe":
      return commandProbe(config, positionals[1], values.json === true);
    case "ask":
      return commandAsk(config, positionals.slice(1), values.json === true, values.open, values.scope);
    case "serve":
      return commandServe(config);
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
    case "case":
      return commandCase(positionals.slice(1), config, {
        json: values.json === true,
        workspace: values.workspace,
        report: values.report,
        jsonReport: values["json-report"],
        overwrite: values.overwrite === true,
        withEvidence: values["with-evidence"] === true,
        out: values.out,
      });
    case "evidence":
      return commandEvidence(positionals.slice(1), config, {
        json: values.json === true,
        workspace: values.workspace,
        report: values.report,
        jsonReport: values["json-report"],
        overwrite: values.overwrite === true,
        withEvidence: values["with-evidence"] === true,
        out: values.out,
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

async function commandServe(config: ReaClientConfig): Promise<number> {
  const server = new EngineRpcServer({
    config,
    input: process.stdin,
    output: process.stdout,
    version: CLI_VERSION,
  });

  const onSignal = (): void => {
    void server.close();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    process.stdin.resume();
    await server.run();
    return 0;
  } finally {
    process.stdin.pause();
    if ("unref" in process.stdin && typeof process.stdin.unref === "function") {
      process.stdin.unref();
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function commandTools(
  config: ReaClientConfig,
  json: boolean,
  family: string | undefined,
  scopeOption: string | undefined,
): Promise<number> {
  const validatedScope = validateScopeOption(scopeOption, config);
  if (!validatedScope.ok) {
    process.stderr.write(`${validatedScope.message}\n`);
    return 2;
  }

  const client = new ReaClient(config.rea, {
    allowNonLoopback: config.policy.allowNonLoopback,
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    const catalog = ToolCatalog.from(tools);

    const resolved = catalog.resolveScope(validatedScope.scope, config.agent.customTools);

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
    path = canonicalizeTargetPath(target, {
      platform: currentPlatform(),
      allowNonLoopback: config.policy.allowNonLoopback,
    });
  } catch (error) {
    if (error instanceof TargetPathError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const client = new ReaClient(config.rea, {
    allowNonLoopback: config.policy.allowNonLoopback,
  });
  try {
    await client.connect();
    const catalog = ToolCatalog.from(await client.listTools());
    const opened = await client.callTool("open_binary", { path });
    const openObservation = projectToolResult(opened, { maxChars: 4_000 });
    const openFailed =
      opened.isError === true || openObservation.text.startsWith(ToolObservation.errorPrefix);

    const sessionResult = await client.callTool("binary_session", {});
    const session = readBinarySession(sessionResult);

    if (openFailed) {
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: false,
              open: openObservation.text,
              session: session === undefined ? null : { ...session, raw: undefined },
              overview: null,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stderr.write(`${openObservation.text}\n`);
      }
      return 1;
    }

    const overviewObservation = catalog.has("binary_overview")
      ? projectToolResult(await client.callTool("binary_overview", {}), { maxChars: 6_000 })
      : undefined;

    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            open: openObservation.text,
            session: session === undefined ? null : { ...session, raw: undefined },
            overview: overviewObservation?.text ?? null,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    process.stdout.write(`Target: ${session?.targetPath ?? path}\n`);
    if (session !== undefined) {
      process.stdout.write(
        `Format: ${session.format ?? "?"}  Arch: ${session.architecture ?? "?"}  Provider: ${session.providerId ?? "none"}\n`,
      );
    }
    process.stdout.write(
      `\n${openObservation.text}${overviewObservation === undefined ? "" : `\n\n${overviewObservation.text}`}\n`,
    );
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

  const validatedScope = validateScopeOption(scopeOption, config);
  if (!validatedScope.ok) {
    process.stderr.write(`${validatedScope.message}\n`);
    return 2;
  }

  let canonicalOpenPath: string | undefined;
  if (openPath !== undefined) {
    try {
      canonicalOpenPath = canonicalizeTargetPath(openPath, {
        platform: currentPlatform(),
        allowNonLoopback: config.policy.allowNonLoopback,
      });
    } catch (error) {
      if (error instanceof TargetPathError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }

  const client = new ReaClient(config.rea, {
    allowNonLoopback: config.policy.allowNonLoopback,
  });
  client.on("stderr", ({ line }) => {
    if (!json) process.stderr.write(`[rea] ${line}\n`);
  });

  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    await client.connect();
    const tools = await client.listTools();
    const catalog = ToolCatalog.from(tools);
    const scope = catalog.resolveScope(validatedScope.scope, config.agent.customTools);

    if (canonicalOpenPath !== undefined) {
      const opened = await client.callTool("open_binary", { path: canonicalOpenPath });
      if (opened.isError === true) {
        const openError = projectToolResult(opened, { maxChars: 4_000 }).text;
        if (json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                content: "",
                reason: "failed",
                error: openError,
                iterations: 0,
                toolCallsExecuted: 0,
                usage: null,
                transcript: [],
              },
              null,
              2,
            )}\n`,
          );
        } else {
          process.stderr.write(`${openError}\n`);
        }
        return 1;
      }
    }

    const session = readBinarySession(await client.callTool("binary_session", {}));

    const chat = new LlamaServerClient({
      baseUrl: config.llm.baseUrl,
      ...(config.llm.apiKey === undefined ? {} : { apiKey: config.llm.apiKey }),
      requestTimeoutMs: config.llm.requestTimeoutMs,
      allowNonLoopback: config.policy.allowNonLoopback,
    });

    const agent = createAgentSession(config, {
      connection: client,
      chat,
      catalog,
      scope,
      systemPrompt: buildSystemPrompt({
        catalog,
        advertisedToolCount: scope.tools.length,
        session,
      }),
    });

    if (scope.missing.length > 0 && !json) {
      process.stderr.write(`[warn] scope "${scope.scope}" is missing: ${scope.missing.join(", ")}\n`);
    }

    if (!json) {
      agent.on("assistant_delta", ({ text }) => {
        process.stdout.write(text);
      });
      agent.on("tool_call_started", ({ name, arguments: args }) => {
        process.stderr.write(`\n  -> ${name} ${JSON.stringify(args)}\n`);
      });
      agent.on("tool_call_finished", ({ name, ok, elapsedMs, evidenceId }) => {
        process.stderr.write(
          `  <- ${ok ? "ok" : "ERROR"} ${name} (${String(elapsedMs)}ms${evidenceId === undefined ? "" : `, ${evidenceId.slice(0, 12)}`})\n`,
        );
      });
    }

    const result = await agent.ask(question, { signal: controller.signal });

    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            content: result.content,
            reason: result.reason,
            ...(result.error === undefined ? {} : { error: result.error }),
            iterations: result.iterations,
            toolCallsExecuted: result.toolCallsExecuted,
            usage: result.usage ?? null,
            transcript: agent.transcript(),
          },
          null,
          2,
        )}\n`,
      );
    } else if (result.reason === "failed") {
      process.stderr.write(`\nError: ${result.error ?? "Agent turn failed."}\n`);
    } else if (result.reason === "max_iterations") {
      process.stderr.write(`\n${result.content}\n`);
    } else if (result.reason === "cancelled") {
      process.stderr.write("\nCancelled.\n");
    } else {
      process.stdout.write("\n");
    }

    return result.reason === "final_answer" ? 0 : 1;
  } finally {
    process.off("SIGINT", onSigint);
    await client.close();
  }
}

/** True when `candidate` resolves inside `directory`. */
function isInside(directory: string, candidate: string): boolean {
  const relativeTo = relative(resolve(directory), resolve(candidate));
  return (
    relativeTo !== "" &&
    relativeTo !== ".." &&
    !relativeTo.startsWith(`..${sep}`) &&
    !isAbsolute(relativeTo)
  );
}

const CASE_USAGE = `usage:
  rea-client case list   [--workspace <dir>] [--json]
  rea-client case show   <name> [--workspace <dir>] [--json] [--report <file>]
  rea-client case save   <name> --report <file> --json-report <file>
                         [--workspace <dir>] [--overwrite] [--with-evidence] [--json]
  rea-client case delete <name> [--workspace <dir>] [--json]
  rea-client evidence export [<case>] [--out <path>] [--workspace <dir>] [--overwrite] [--json]
`;

interface CaseOptions {
  readonly json: boolean;
  readonly workspace: string | undefined;
  readonly report: string | undefined;
  readonly jsonReport: string | undefined;
  readonly overwrite: boolean;
  readonly withEvidence: boolean;
  readonly out: string | undefined;
}

type BundleExport =
  | {
    readonly ok: true;
    readonly path: string;
    readonly bytes: number;
    readonly records: number;
    readonly unknowns: number;
  }
  | { readonly ok: false; readonly path?: string; readonly error: string };

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a `--report`/`--json-report` argument, where `-` means stdin. */
async function readInput(path: string, label: string): Promise<string | undefined> {
  try {
    return path === "-" ? await readStdin() : await readFile(path, "utf8");
  } catch (error) {
    process.stderr.write(`${label}: could not read ${path}: ${(error as Error).message}\n`);
    return undefined;
  }
}

function describeSummary(summary: CaseSummary): string {
  const target = summary.target.name ?? summary.target.path ?? "unknown target";
  const details = [summary.target.format, summary.target.architecture].filter(
    (value): value is string => value !== undefined,
  );
  return (
    `${target}${details.length > 0 ? ` (${details.join(", ")})` : ""}` +
    ` — ${summary.turns} turn(s), ${summary.observations} observation(s)` +
    `${summary.evidenceReferences > 0 ? `, ${summary.evidenceReferences} evidence ref(s)` : ""}`
  );
}

function describeFiles(files: readonly CaseFile[]): string {
  return files.length === 0
    ? "none"
    : files.map((file) => `${file.name} (${formatBytes(file.bytes)})`).join(", ");
}

/**
 * Case commands work on the same folder the desktop bridge writes, through the
 * same module, so `rea-client case show` can read a case the app saved and vice
 * versa. Only the evidence export needs REA to be running.
 */
async function commandCase(
  args: readonly string[],
  config: ReaClientConfig,
  options: CaseOptions,
): Promise<number> {
  const [subcommand, name] = args;
  const workspaceDir = resolve(options.workspace ?? config.workspaceDir);

  if (subcommand === undefined) {
    process.stderr.write(CASE_USAGE);
    return 2;
  }

  try {
    switch (subcommand) {
      case "list":
        return await caseList(workspaceDir, options.json);
      case "show":
        return await caseShow(workspaceDir, name, options);
      case "save":
        return await caseSave(workspaceDir, config, name, options);
      case "delete":
        return await caseDelete(workspaceDir, name, options.json);
      default:
        process.stderr.write(`Unknown case subcommand: ${subcommand}\n${CASE_USAGE}`);
        return 2;
    }
  } catch (error) {
    // Bad input is exit 2 everywhere, matching the JSON-RPC `-32602` mapping.
    if (error instanceof CaseStoreError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

async function caseList(workspaceDir: string, json: boolean): Promise<number> {
  const listed = await listCases(workspaceDir);
  if (json) {
    writeJson({ ok: true, ...listed });
    return 0;
  }

  process.stdout.write(`${listed.casesRoot}\n`);
  if (listed.total === 0) {
    process.stdout.write("No saved cases. Save one from the desktop app or with `rea-client case save`.\n");
    return 0;
  }

  for (const entry of listed.cases) {
    process.stdout.write(`\n${entry.name}  ${entry.savedAt}\n  ${entry.directory}\n`);
    if (entry.summary !== undefined) process.stdout.write(`  ${describeSummary(entry.summary)}\n`);
    process.stdout.write(`  files: ${describeFiles(entry.files)}\n`);
  }
  if (listed.total > listed.cases.length) {
    process.stdout.write(`\nShowing ${listed.cases.length} of ${listed.total} saved cases.\n`);
  }
  return 0;
}

async function caseShow(
  workspaceDir: string,
  name: string | undefined,
  options: CaseOptions,
): Promise<number> {
  if (name === undefined) {
    process.stderr.write("usage: rea-client case show <name>\n");
    return 2;
  }

  const opened = await openCase(workspaceDir, normalizeCaseName(name, ""));
  if (!opened.ok) {
    process.stderr.write(`${opened.error ?? "the case could not be read"}\n`);
    return 1;
  }

  if (options.report !== undefined) {
    await writeFile(options.report, opened.report ?? "", { mode: 0o600 });
  }
  if (options.json) {
    writeJson({ ...opened, ...(options.report === undefined ? {} : { reportPath: options.report }) });
    return 0;
  }

  process.stdout.write(`Case: ${opened.name}\nSaved: ${opened.savedAt ?? "unknown"}\nDirectory: ${opened.directory ?? "?"}\n`);
  if (opened.summary !== undefined) process.stdout.write(`Content: ${describeSummary(opened.summary)}\n`);
  process.stdout.write(`Files: ${describeFiles(opened.files)}\n`);
  if (opened.bundle !== undefined) {
    process.stdout.write(
      `Bundle: ${opened.bundle.records ?? "?"} record(s), ${opened.bundle.unknowns ?? "?"} unknown revision(s)\n`,
    );
  }

  if (options.report !== undefined) {
    process.stdout.write(
      `Report: written to ${options.report} (${formatBytes(Buffer.byteLength(opened.report ?? ""))})\n`,
    );
    return 0;
  }
  if (opened.report === undefined) {
    process.stdout.write("\nThis case has no Markdown report; the JSON companion is intact.\n");
    return 0;
  }
  process.stdout.write(`\n${opened.report}${opened.report.endsWith("\n") ? "" : "\n"}`);
  if (opened.reportTruncated === true) {
    process.stderr.write("The report was truncated for display; use --report <file> to write it in full.\n");
  }
  return 0;
}

async function caseSave(
  workspaceDir: string,
  config: ReaClientConfig,
  name: string | undefined,
  options: CaseOptions,
): Promise<number> {
  if (name === undefined) {
    process.stderr.write("usage: rea-client case save <name> --report <file> --json-report <file>\n");
    return 2;
  }
  if (options.report === undefined || options.jsonReport === undefined) {
    process.stderr.write('case save needs --report <file> and --json-report <file> ("-" reads stdin).\n');
    return 2;
  }
  if (options.report === "-" && options.jsonReport === "-") {
    process.stderr.write("Only one of --report and --json-report may read stdin.\n");
    return 2;
  }

  const markdown = await readInput(options.report, "--report");
  const jsonText = await readInput(options.jsonReport, "--json-report");
  if (markdown === undefined || jsonText === undefined) return 1;

  // A case whose companion does not parse cannot be opened again, so it is
  // refused here rather than written and discovered later by `case show`.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch {
    process.stderr.write("--json-report is not valid JSON; refusing to save an unreadable case.\n");
    return 2;
  }
  if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
    process.stderr.write("--json-report must contain a JSON object, not an array or scalar.\n");
    return 2;
  }

  const saved = await saveCase({
    workspaceDir,
    name,
    markdown,
    json: jsonText,
    overwrite: options.overwrite,
  });
  if (!saved.ok) {
    process.stderr.write(`${saved.error ?? "the case could not be saved"}\n`);
    return 1;
  }

  let files = saved.files;
  let evidence: BundleExport | undefined;
  if (options.withEvidence) {
    evidence = await exportBundle(config, join(saved.directory, "evidence-bundle.json"), true);
    if (evidence.ok) {
      files = withFile(files, "evidence-bundle.json", evidence.bytes);
    } else {
      // The report is the deliverable; the bundle is reported, not fatal.
      process.stderr.write(`Evidence export failed: ${evidence.error}\n`);
    }
  }

  const result = {
    ok: true,
    name: saved.name,
    directory: saved.directory,
    files,
    ...(evidence === undefined ? {} : { evidence }),
  };
  if (options.json) {
    writeJson(result);
  } else {
    process.stdout.write(`Saved case "${saved.name}" to ${saved.directory}\n`);
    process.stdout.write(`Files: ${describeFiles(files)}\n`);
    if (evidence !== undefined && evidence.ok) {
      process.stdout.write(`Evidence: ${evidence.records} record(s), ${evidence.unknowns} unknown revision(s)\n`);
    }
  }
  return evidence !== undefined && !evidence.ok ? 1 : 0;
}

async function caseDelete(
  workspaceDir: string,
  name: string | undefined,
  json: boolean,
): Promise<number> {
  if (name === undefined) {
    process.stderr.write("usage: rea-client case delete <name>\n");
    return 2;
  }

  const removed = await deleteCase(workspaceDir, normalizeCaseName(name, ""));
  if (json) writeJson(removed);
  else if (removed.ok) process.stdout.write(`Removed ${removed.directory ?? name}\n`);
  else process.stderr.write(`${removed.error ?? "the case could not be removed"}\n`);
  return removed.ok ? 0 : 1;
}

/** Asks REA for its evidence bundle, which is the only step that needs a server. */
async function exportBundle(
  config: ReaClientConfig,
  path: string,
  overwrite: boolean,
): Promise<BundleExport> {
  const client = new ReaClient(config.rea, {
    allowNonLoopback: config.policy.allowNonLoopback,
  });
  try {
    await client.connect();
    const catalog = ToolCatalog.from(await client.listTools());
    if (!catalog.has("export_evidence_bundle")) {
      return {
        ok: false,
        path,
        error: "REA does not advertise export_evidence_bundle; the evidence bundle cannot be exported.",
      };
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const raw = await client.callTool("export_evidence_bundle", {
      path,
      ...(overwrite ? { overwrite: true } : {}),
    });
    const exported = readExportedBundle(raw);
    if (raw.isError === true || exported === undefined) {
      return { ok: false, path, error: projectToolResult(raw, { maxChars: 2_000 }).text };
    }
    return { ok: true, ...exported };
  } catch (error) {
    return { ok: false, path, error: (error as Error).message };
  } finally {
    await client.close();
  }
}

/**
 * `evidence export` writes the bundle REA currently holds. A case name keeps it
 * beside the case it belongs to; `--out` writes it anywhere inside the
 * workspace, so the CLI never scatters files outside the tree the app owns.
 */
async function commandEvidence(
  args: readonly string[],
  config: ReaClientConfig,
  options: CaseOptions,
): Promise<number> {
  const [subcommand, name] = args;
  const workspaceDir = resolve(options.workspace ?? config.workspaceDir);

  if (subcommand !== "export") {
    process.stderr.write(CASE_USAGE);
    return 2;
  }
  if (name !== undefined && options.out !== undefined) {
    process.stderr.write("Give either a case name or --out <path>, not both.\n");
    return 2;
  }

  let target: string;
  let overwrite = options.overwrite;
  if (name !== undefined) {
    let stem: string;
    try {
      stem = normalizeCaseName(name, "");
    } catch (error) {
      if (error instanceof CaseStoreError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      throw error;
    }
    const directory = await resolveCaseDirectory(workspaceDir, stem);
    if (directory === undefined) {
      process.stderr.write(`No saved case named "${stem}" in ${casesRoot(workspaceDir)}.\n`);
      return 1;
    }
    target = join(directory, "evidence-bundle.json");
    // Re-exporting into the case it belongs to is the expected refresh.
    overwrite = true;
  } else if (options.out !== undefined) {
    target = resolve(options.out);
    if (!isInside(workspaceDir, target)) {
      process.stderr.write(`--out must stay inside the workspace (${workspaceDir}).\n`);
      return 2;
    }
  } else {
    process.stderr.write(CASE_USAGE);
    return 2;
  }

  const exported = await exportBundle(config, target, overwrite);
  if (!exported.ok) {
    process.stderr.write(`${exported.error}\n`);
    if (options.json) writeJson(exported);
    return 1;
  }

  if (options.json) {
    writeJson(exported);
  } else {
    process.stdout.write(
      `Exported ${exported.records} evidence record(s) (${exported.unknowns} unknown revision(s)) ` +
        `to ${exported.path} (${formatBytes(exported.bytes)})\n`,
    );
  }
  return 0;
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
  const client = new ReaClient(config.rea, {
    allowNonLoopback: config.policy.allowNonLoopback,
  });
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

  const overdueIds = new Set(
    (report.overdueReviews ?? []).map((entry) => entry.split(" ")[0] ?? entry),
  );
  for (const entry of report.accepted ?? []) {
    const statusLabel = overdueIds.has(entry.finding.id) ? "EXPIRED " : "ACCEPTED";
    process.stdout.write(
      `${statusLabel}  ${entry.finding.id}  ${entry.finding.rationale}\n` +
        `          mitigation: ${entry.finding.mitigation}\n` +
        `          reviewed ${entry.finding.reviewedAt}${entry.finding.reviewBy === undefined ? "" : `, review by ${entry.finding.reviewBy}`}\n\n`,
    );
  }
  for (const overdue of report.overdueReviews ?? []) {
    process.stderr.write(`error: accepted finding expired and requires re-review: ${overdue}\n`);
  }

  const blocking = report.blocking.map((assessment) => {
    const suffix = overdueIds.has(assessment.advisory.id) ? ", acceptance expired" : "";
    return `${assessment.advisory.id} (${assessment.verdict}${suffix})`;
  });

  if (report.ok) {
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

    if (options.json && options.out !== undefined) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            package: manifest.package,
            version: manifest.version,
            files: manifest.files.length,
            totalBytes: manifest.totalBytes,
            tarballIntegrity: manifest.tarballIntegrity,
            writtenTo: options.out,
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
