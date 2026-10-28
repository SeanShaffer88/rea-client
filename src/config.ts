/**
 * Configuration schema, defaults, and validation.
 *
 * Hand-validated rather than schema-library-validated so the shipped bundle has
 * exactly one runtime dependency (the MCP client). Every rejection names the
 * offending field path so the desktop shell can surface it verbatim.
 */

import { readFile } from "node:fs/promises";
import { NetworkPolicyError, assertLoopbackUrl } from "./platform/net.js";

export type ReaTransportKind = "stdio" | "http";
export type ToolScopeName = "binary-core" | "binary-extended" | "full" | "custom";

export interface ReaServerConfig {
  readonly transport: ReaTransportKind;
  /** Executable used to launch the REA MCP server. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  /** Streamable-HTTP endpoint, used only when transport === "http". */
  readonly httpUrl: string;
  /** Seconds to wait for `initialize` to complete. */
  readonly startupTimeoutSec: number;
}

export interface LlmConfig {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:8080/v1 */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly temperature: number;
  readonly maxTokens: number;
  /** Total context budget used to size evidence projections. */
  readonly contextWindow: number;
  readonly requestTimeoutMs: number;
}

export interface AgentConfig {
  readonly maxIterations: number;
  /** Character budget for a single tool observation fed back to the model. */
  readonly maxToolResultChars: number;
  readonly toolScope: ToolScopeName;
  readonly customTools: readonly string[];
  /** Maximum elements in any single outbound array argument. */
  readonly maxArgumentArrayItems: number;
  /** Maximum serialized size of outbound tool arguments, in bytes. */
  readonly maxArgumentBytes: number;
}

export interface PolicyConfig {
  readonly allowNonLoopback: boolean;
}

export interface ReaClientConfig {
  readonly rea: ReaServerConfig;
  readonly llm: LlmConfig;
  readonly agent: AgentConfig;
  readonly policy: PolicyConfig;
  /** Working directory for caches and retained evidence. */
  readonly workspaceDir: string;
}

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
  public constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
  }
}

export const DEFAULT_CONFIG: ReaClientConfig = {
  rea: {
    transport: "stdio",
    command: "node",
    args: ["scripts/rea.mjs", "mcp"],
    env: { NODE_ENV: "production" },
    httpUrl: "http://127.0.0.1:8721/mcp",
    startupTimeoutSec: 45,
  },
  llm: {
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "qwen2.5-coder-14b-instruct-q5_k_m",
    temperature: 0.1,
    maxTokens: 1536,
    contextWindow: 16_384,
    requestTimeoutMs: 180_000,
  },
  agent: {
    maxIterations: 8,
    maxToolResultChars: 12_000,
    toolScope: "binary-core",
    customTools: [],
    maxArgumentArrayItems: 256,
    maxArgumentBytes: 65_536,
  },
  policy: {
    allowNonLoopback: false,
  },
  workspaceDir: "workspace",
};

// --------------------------------------------------------------------------
// Minimal typed readers
// --------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function asObject(value: unknown, field: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(field, "expected an object");
  }
  return value as Obj;
}

function optString(source: Obj, key: string, field: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`${field}.${key}`, "expected a string");
  }
  return value;
}

function reqString(source: Obj, key: string, field: string, fallback: string): string {
  const value = optString(source, key, field);
  if (value === undefined) return fallback;
  if (value.trim() === "") {
    throw new ConfigError(`${field}.${key}`, "must not be empty");
  }
  return value;
}

function optNumber(source: Obj, key: string, field: string): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${field}.${key}`, "expected a finite number");
  }
  return value;
}

function numInRange(
  source: Obj,
  key: string,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = optNumber(source, key, field) ?? fallback;
  if (value < min || value > max) {
    throw new ConfigError(`${field}.${key}`, `must be between ${min} and ${max}`);
  }
  return value;
}

function optBool(source: Obj, key: string, field: string): boolean | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ConfigError(`${field}.${key}`, "expected a boolean");
  }
  return value;
}

function optStringArray(source: Obj, key: string, field: string): string[] | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${field}.${key}`, "expected an array of strings");
  }
  return value as string[];
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(field, `expected one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

/**
 * Validates a raw configuration object and returns an immutable config.
 *
 * @throws {ConfigError} on the first invalid field.
 */
export function parseConfig(raw: unknown): ReaClientConfig {
  const root = raw === undefined || raw === null ? {} : asObject(raw, "config");

  const reaRaw = root["rea"] === undefined ? {} : asObject(root["rea"], "rea");
  const llmRaw = root["llm"] === undefined ? {} : asObject(root["llm"], "llm");
  const agentRaw = root["agent"] === undefined ? {} : asObject(root["agent"], "agent");
  const policyRaw = root["policy"] === undefined ? {} : asObject(root["policy"], "policy");

  const transport = oneOf(
    optString(reaRaw, "transport", "rea"),
    ["stdio", "http"] as const,
    "rea.transport",
    DEFAULT_CONFIG.rea.transport,
  );

  const envRaw = reaRaw["env"] === undefined ? {} : asObject(reaRaw["env"], "rea.env");
  const env: Record<string, string> = { ...DEFAULT_CONFIG.rea.env };
  for (const [key, value] of Object.entries(envRaw)) {
    if (typeof value !== "string") {
      throw new ConfigError(`rea.env.${key}`, "expected a string");
    }
    env[key] = value;
  }

  const allowNonLoopback =
    optBool(policyRaw, "allowNonLoopback", "policy") ??
    DEFAULT_CONFIG.policy.allowNonLoopback;

  const llmBaseUrl = reqString(llmRaw, "baseUrl", "llm", DEFAULT_CONFIG.llm.baseUrl);
  // Fail at load time rather than on the first prompt. The policy error is
  // re-thrown as a ConfigError so every configuration failure has one shape.
  try {
    assertLoopbackUrl(llmBaseUrl, { allowNonLoopback, settingName: "llm.baseUrl" });
  } catch (error) {
    if (error instanceof NetworkPolicyError) {
      throw new ConfigError("llm.baseUrl", error.message.replace(/^llm\.baseUrl /, ""));
    }
    throw error;
  }

  const rea: ReaServerConfig = {
    transport,
    command: reqString(reaRaw, "command", "rea", DEFAULT_CONFIG.rea.command),
    args: optStringArray(reaRaw, "args", "rea") ?? [...DEFAULT_CONFIG.rea.args],
    ...optional("cwd", optString(reaRaw, "cwd", "rea")),
    env,
    httpUrl: reqString(reaRaw, "httpUrl", "rea", DEFAULT_CONFIG.rea.httpUrl),
    startupTimeoutSec: numInRange(
      reaRaw,
      "startupTimeoutSec",
      "rea",
      DEFAULT_CONFIG.rea.startupTimeoutSec,
      1,
      600,
    ),
  };

  const llm: LlmConfig = {
    baseUrl: llmBaseUrl,
    model: reqString(llmRaw, "model", "llm", DEFAULT_CONFIG.llm.model),
    ...optional("apiKey", optString(llmRaw, "apiKey", "llm")),
    temperature: numInRange(llmRaw, "temperature", "llm", DEFAULT_CONFIG.llm.temperature, 0, 2),
    maxTokens: numInRange(llmRaw, "maxTokens", "llm", DEFAULT_CONFIG.llm.maxTokens, 1, 262_144),
    contextWindow: numInRange(
      llmRaw,
      "contextWindow",
      "llm",
      DEFAULT_CONFIG.llm.contextWindow,
      1024,
      4_194_304,
    ),
    requestTimeoutMs: numInRange(
      llmRaw,
      "requestTimeoutMs",
      "llm",
      DEFAULT_CONFIG.llm.requestTimeoutMs,
      1_000,
      3_600_000,
    ),
  };

  const agent: AgentConfig = {
    maxIterations: numInRange(
      agentRaw,
      "maxIterations",
      "agent",
      DEFAULT_CONFIG.agent.maxIterations,
      1,
      64,
    ),
    maxToolResultChars: numInRange(
      agentRaw,
      "maxToolResultChars",
      "agent",
      DEFAULT_CONFIG.agent.maxToolResultChars,
      256,
      1_000_000,
    ),
    toolScope: oneOf(
      optString(agentRaw, "toolScope", "agent"),
      ["binary-core", "binary-extended", "full", "custom"] as const,
      "agent.toolScope",
      DEFAULT_CONFIG.agent.toolScope,
    ),
    customTools: optStringArray(agentRaw, "customTools", "agent") ?? [],
    maxArgumentArrayItems: numInRange(
      agentRaw,
      "maxArgumentArrayItems",
      "agent",
      DEFAULT_CONFIG.agent.maxArgumentArrayItems,
      1,
      1_000_000,
    ),
    maxArgumentBytes: numInRange(
      agentRaw,
      "maxArgumentBytes",
      "agent",
      DEFAULT_CONFIG.agent.maxArgumentBytes,
      256,
      16_777_216,
    ),
  };

  if (agent.toolScope === "custom" && agent.customTools.length === 0) {
    throw new ConfigError(
      "agent.customTools",
      "must list at least one tool name when agent.toolScope is \"custom\"",
    );
  }

  return {
    rea,
    llm,
    agent,
    policy: { allowNonLoopback },
    workspaceDir: reqString(root as Obj, "workspaceDir", "config", DEFAULT_CONFIG.workspaceDir),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): {} | Record<K, V> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Reads and parses a config file. A missing file yields defaults. */
export async function loadConfig(path: string): Promise<ReaClientConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_CONFIG;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError("config", `invalid JSON in ${path}: ${(error as Error).message}`);
  }
  return parseConfig(parsed);
}
