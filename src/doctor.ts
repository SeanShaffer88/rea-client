/**
 * Preflight diagnostics.
 *
 * Mirrors the checks a support engineer would run before blaming the model:
 * is Node new enough, does REA start and answer `tools/list`, does the local
 * inference endpoint answer, is the deep-analysis provider actually usable on
 * this host, and is anything pointed off-box.
 *
 * Every check returns data rather than throwing, so one broken component does
 * not hide the state of the others.
 */

import { access, mkdir, constants } from "node:fs/promises";
import { join } from "node:path";
import type { ReaClientConfig } from "./config.js";
import { assertLoopbackUrl, isLoopbackHostname } from "./platform/net.js";
import { ToolCatalog } from "./mcp/catalog.js";
import { ReaClient } from "./mcp/ReaClient.js";
import { readBinarySession } from "./mcp/session.js";
import type { BinarySessionSummary } from "./mcp/types.js";
import { isValidSemver, satisfiesRange } from "./packaging/semver.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface CheckResult {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly healthy: boolean;
  readonly checks: readonly CheckResult[];
  readonly catalogSize?: number;
  readonly serverVersion?: string;
  readonly providers?: readonly { readonly id: string; readonly available: boolean }[];
}

/** REA 6.8.0 requires Node ^22.23.4 || ^24.22.1 || >=26.12.1. */
const MIN_NODE_MAJOR = 22;
const REA_DECLARED_NODE_RANGE = ">= 22.23.4 < 23.0.0 || >= 24.22.1 < 25.0.0 || >= 26.12.1";
const VALIDATED_REA_VERSION = "6.8.0";

export function checkNodeVersion(nodeVersion: string = process.versions.node): CheckResult {
  const [major] = nodeVersion.split(".").map(Number);
  const majorNumber = major ?? 0;

  if (majorNumber < MIN_NODE_MAJOR) {
    return {
      id: "node-version",
      label: "Node.js runtime",
      status: "fail",
      detail: `Node ${nodeVersion} is too old for REA 6.8.x.`,
      remediation: "Ship Node 22.23.4+ (or 24.22.1+ / 26.12.1+) with the bundle.",
    };
  }

  // REA's own engine range is narrower than the major-22 floor; matching it
  // exactly avoids surprising differences between bundled and reference runtimes.
  const inDeclaredRange =
    isValidSemver(nodeVersion) && satisfiesRange(nodeVersion, REA_DECLARED_NODE_RANGE);

  return {
    id: "node-version",
    label: "Node.js runtime",
    status: inDeclaredRange ? "ok" : "warn",
    detail: inDeclaredRange
      ? `Node ${nodeVersion}`
      : `Node ${nodeVersion} runs REA but is outside its declared engine range (^22.23.4 || ^24.22.1 || >=26.12.1).`,
    ...(inDeclaredRange
      ? {}
      : { remediation: "Bundle a Node version matching REA's package.json engines field." }),
  };
}

function checkLoopbackPolicy(config: ReaClientConfig): CheckResult {
  const llmHost = safeHostname(config.llm.baseUrl);
  const reaHost = config.rea.transport === "http" ? safeHostname(config.rea.httpUrl) : "stdio";

  if (config.policy.allowNonLoopback) {
    return {
      id: "network-policy",
      label: "Air-gap policy",
      status: "warn",
      detail: `allowNonLoopback is enabled; the engine may contact non-local hosts (llm=${llmHost}).`,
    };
  }

  const offBox =
    llmHost !== undefined && !isLoopbackHostname(llmHost)
      ? `llm.baseUrl -> ${llmHost}`
      : reaHost !== undefined && reaHost !== "stdio" && !isLoopbackHostname(reaHost)
        ? `rea.httpUrl -> ${reaHost}`
        : undefined;

  return offBox === undefined
    ? {
        id: "network-policy",
        label: "Air-gap policy",
        status: "ok",
        detail: `All endpoints are loopback (llm=${llmHost ?? "n/a"}, rea=${reaHost ?? "n/a"}).`,
      }
    : {
        id: "network-policy",
        label: "Air-gap policy",
        status: "fail",
        detail: `Non-loopback endpoint configured: ${offBox}`,
        remediation: "Point the endpoint at 127.0.0.1, or set policy.allowNonLoopback deliberately.",
      };
}

function safeHostname(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return undefined;
  }
}

async function checkWorkspace(config: ReaClientConfig): Promise<CheckResult> {
  const dir = join(config.workspaceDir);
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return {
      id: "workspace",
      label: "Workspace directory",
      status: "ok",
      detail: dir,
    };
  } catch (error) {
    return {
      id: "workspace",
      label: "Workspace directory",
      status: "fail",
      detail: `Not writable: ${(error as Error).message}`,
      remediation: "Use %LOCALAPPDATA%\\ReaDesktop\\cache, which is always writable.",
    };
  }
}

async function checkRea(config: ReaClientConfig): Promise<{
  readonly check: CheckResult;
  readonly catalogSize?: number;
  readonly serverVersion?: string;
  readonly session?: BinarySessionSummary;
}> {
  const client = new ReaClient(config.rea, {
    allowNonLoopback: config.policy.allowNonLoopback,
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    const version = client.serverVersion();

    const sessionResult = await client.callTool("binary_session", {});
    const session = readBinarySession(sessionResult);

    const problems: string[] = [];
    if (session?.catalogToolCount !== undefined && session.catalogToolCount !== tools.length) {
      problems.push(
        `tools/list returned ${tools.length} but binary_session reports ${session.catalogToolCount}`,
      );
    }
    if (session?.packageVersion !== undefined && session.packageVersion !== VALIDATED_REA_VERSION) {
      problems.push(
        `rea-agents ${session.packageVersion} differs from validated ${VALIDATED_REA_VERSION}`,
      );
    }
    const catalog = ToolCatalog.from(tools);
    const dupes = catalog.duplicateNames(tools);
    if (dupes.length > 0) problems.push(`duplicate tool names: ${dupes.slice(0, 5).join(", ")}`);

    const detailParts = [
      `${version?.name ?? "rea"} ${version?.version ?? "?"}`,
      `${tools.length} tools`,
      ...(session?.protocolVersion === undefined ? [] : [`protocol ${session.protocolVersion}`]),
      ...(session?.packageVersion === undefined ? [] : [`package ${session.packageVersion}`]),
    ];

    return {
      check: {
        id: "rea-mcp",
        label: "REA MCP server",
        status: problems.length === 0 ? "ok" : "warn",
        detail: problems.length === 0 ? detailParts.join(" · ") : problems.join("; "),
        ...(problems.length === 0
          ? {}
          : {
              remediation:
                `Pin rea-agents to the version this client was validated against (${VALIDATED_REA_VERSION}).`,
            }),
      },
      catalogSize: tools.length,
      ...(version === undefined ? {} : { serverVersion: version.version }),
      ...(session === undefined ? {} : { session }),
    };
  } catch (error) {
    return {
      check: {
        id: "rea-mcp",
        label: "REA MCP server",
        status: "fail",
        detail: (error as Error).message,
        remediation:
          "Check rea.command/args and that the bundled Node can execute scripts/rea.mjs.",
      },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function checkProviders(session: BinarySessionSummary | undefined): CheckResult {
  if (session === undefined) {
    return {
      id: "providers",
      label: "Analysis providers",
      status: "skipped",
      detail: "binary_session was unavailable.",
    };
  }

  const available = session.providers.filter((provider) => provider.available);
  if (available.length === 0) {
    return {
      id: "providers",
      label: "Analysis providers",
      status: "warn",
      detail:
        session.providers.length === 0
          ? "No providers advertised."
          : `None usable. Advertised: ${session.providers.map((p) => p.id).join(", ")}`,
      remediation:
        "Install/bundle Ghidra 11.x with a JDK, or set REA_ANALYSIS_PROVIDER to a provider that exists.",
    };
  }

  return {
    id: "providers",
    label: "Analysis providers",
    status: "ok",
    detail: available.map((provider) => provider.id).join(", "),
  };
}

async function checkLlm(config: ReaClientConfig, fetchImpl: typeof fetch): Promise<CheckResult> {
  const base = config.llm.baseUrl.replace(/\/+$/, "");
  const url = `${base}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.llm.apiKey !== undefined && config.llm.apiKey !== "") {
    headers["authorization"] = `Bearer ${config.llm.apiKey}`;
  }
  try {
    assertLoopbackUrl(url, { allowNonLoopback: config.policy.allowNonLoopback });
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        id: "llm",
        label: "Local model server",
        status: "fail",
        detail: `${url} returned HTTP ${response.status}.`,
        remediation:
          response.status === 401 || response.status === 403
            ? "Check llm.apiKey against the --api-key passed to llama-server.exe."
            : "Start llama-server.exe with --port matching llm.baseUrl.",
      };
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
    return {
      id: "llm",
      label: "Local model server",
      status: "ok",
      detail:
        models.length === 0
          ? `${url} reachable`
          : `${url} -> ${models.slice(0, 3).join(", ")}`,
    };
  } catch (error) {
    return {
      id: "llm",
      label: "Local model server",
      status: "fail",
      detail: `Unreachable: ${(error as Error).message}`,
      remediation: "Start llama-server.exe, or point llm.baseUrl at the running server.",
    };
  }
}

export interface DoctorOptions {
  /** Skips the LLM probe, for a toolchain-only check. */
  readonly skipLlm?: boolean;
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to `process.versions.node`. */
  readonly nodeVersion?: string;
}

export async function runDoctor(
  config: ReaClientConfig,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  checks.push(checkNodeVersion(options.nodeVersion));
  checks.push(checkLoopbackPolicy(config));
  checks.push(await checkWorkspace(config));

  const rea = await checkRea(config);
  checks.push(rea.check);
  checks.push(checkProviders(rea.session));

  if (options.skipLlm === true) {
    checks.push({
      id: "llm",
      label: "Local model server",
      status: "skipped",
      detail: "Skipped by request.",
    });
  } else {
    checks.push(await checkLlm(config, options.fetchImpl ?? fetch));
  }

  const healthy = checks.every((check) => check.status !== "fail");
  return {
    healthy,
    checks,
    ...(rea.catalogSize === undefined ? {} : { catalogSize: rea.catalogSize }),
    ...(rea.serverVersion === undefined ? {} : { serverVersion: rea.serverVersion }),
    ...(rea.session === undefined
      ? {}
      : { providers: rea.session.providers.map((p) => ({ id: p.id, available: p.available })) }),
  };
}
