/**
 * Reads REA's `binary_session` discovery payload.
 *
 * `binary_session` is the authoritative discovery call: it reports the open
 * target, the bound deep-analysis provider, catalog identity, and per-tool
 * availability *without* starting analysis. The client calls it once at
 * startup and after every `open_binary` so the UI status line and the system
 * prompt reflect reality.
 *
 * Shape verified against rea-agents 6.8.0 — see `docs/rea-integration-notes.md`.
 */

import type { McpCallToolResult } from "./types.js";
import type { BinarySessionSummary, ProviderAvailability } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

function num(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readProviders(result: Record<string, unknown>): ProviderAvailability[] {
  const capabilities = result["capabilities"];
  if (!Array.isArray(capabilities)) return [];

  const providers: ProviderAvailability[] = [];
  for (const entry of capabilities) {
    const record = asRecord(entry);
    const provider = asRecord(record?.["provider"]);
    const id = str(provider, "id");
    if (id === undefined) continue;

    const groups = record?.["groups"];
    // A provider is usable when at least one of its operation groups is
    // available on this host.
    let available = false;
    let reason: string | undefined;
    if (Array.isArray(groups)) {
      for (const group of groups) {
        const groupRecord = asRecord(group);
        if (groupRecord?.["available"] === true) {
          available = true;
          break;
        }
        if (reason === undefined) reason = str(groupRecord, "reason");
      }
    }

    providers.push({
      id,
      ...(str(provider, "name") === undefined ? {} : { name: str(provider, "name") as string }),
      ...(str(provider, "version") === undefined
        ? {}
        : { version: str(provider, "version") as string }),
      available,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return providers;
}

/**
 * Parses a `binary_session` result.
 *
 * Returns `undefined` when the payload is not the expected envelope, so callers
 * treat an unreadable session as "unknown" instead of inventing state.
 */
export function readBinarySession(
  result: McpCallToolResult,
): BinarySessionSummary | undefined {
  const structured = asRecord(result.structuredContent);
  if (structured === undefined) return undefined;

  const inner = asRecord(structured["result"]) ?? structured;
  if (!("open" in inner)) return undefined;

  const identity = asRecord(inner["server_identity"]);
  const pkg = asRecord(identity?.["package"]);
  const catalog = asRecord(identity?.["catalog"]);
  const counts = asRecord(catalog?.["counts"]);
  const digests = asRecord(catalog?.["digests"]);
  const run = asRecord(inner["analysis_run"]);
  const binding = asRecord(inner["analysis_provider_binding"]);

  return {
    open: inner["open"] === true,
    cleanupPending: inner["cleanup_pending"] === true,
    ...fill("targetPath", str(inner, "path")),
    ...fill("sessionKind", str(inner, "kind")),
    ...fill("format", str(inner, "format")),
    ...fill("sha256", str(inner, "sha256")),
    ...fill("architecture", str(inner, "architecture")),
    ...fill("packageName", str(pkg, "name")),
    ...fill("packageVersion", str(pkg, "version")),
    ...fill("protocolVersion", str(identity, "negotiated_protocol_version")),
    ...fill("catalogDigest", str(digests, "combined_sha256")),
    ...fill("catalogToolCount", num(counts, "mcp_tools")),
    ...fill("runId", str(run, "run_id")),
    ...fill("providerId", str(binding, "provider_id") ?? str(asRecord(binding?.["provider"]), "id")),
    ...fill(
      "providerVersion",
      str(binding, "provider_version") ?? str(asRecord(binding?.["provider"]), "version"),
    ),
    providers: readProviders(inner),
    raw: inner,
  };
}

function fill<K extends string, V>(key: K, value: V | undefined): {} | Record<K, V> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
