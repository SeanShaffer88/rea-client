/**
 * Loopback enforcement for the air-gapped build.
 *
 * The product claim is "runs entirely on localhost, zero telemetry". That claim
 * is only true if the client cannot be pointed at a remote model server or a
 * remote MCP endpoint, so every network destination the engine touches is
 * validated here before use. `allowNonLoopback` is an explicit, logged opt-out
 * for lab setups that run inference on another machine.
 */

import { isIP } from "node:net";

export class NetworkPolicyError extends Error {
  public override readonly name = "NetworkPolicyError";
  public readonly url: string;

  public constructor(url: string, message: string) {
    super(message);
    this.url = url;
  }
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

/** True when `hostname` resolves to a loopback address by name or literal. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "") return false;
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  // Any name ending in .localhost is loopback per RFC 6761.
  if (host.endsWith(".localhost")) return true;

  const family = isIP(host);
  if (family === 4) return host.startsWith("127.");
  if (family === 6) {
    if (host === "::1") return true;
    // IPv4-mapped loopback: ::ffff:127.0.0.1
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped?.[1] !== undefined) return mapped[1].startsWith("127.");
    return false;
  }
  return false;
}

export interface UrlPolicyOptions {
  readonly allowNonLoopback?: boolean;
  /** Human-readable name of the setting, used in error text. */
  readonly settingName?: string;
}

/**
 * Validates that `rawUrl` is an http(s) URL pointing at loopback.
 *
 * @throws {NetworkPolicyError} when the URL is malformed or non-local and the
 * policy does not explicitly allow it.
 */
export function assertLoopbackUrl(
  rawUrl: string,
  options: UrlPolicyOptions = {},
): URL {
  const setting = options.settingName ?? "endpoint";
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new NetworkPolicyError(
      rawUrl,
      `${setting} is not a valid URL: ${JSON.stringify(rawUrl)}`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NetworkPolicyError(
      rawUrl,
      `${setting} must use http or https, but ${JSON.stringify(rawUrl)} uses ${parsed.protocol}`,
    );
  }

  if (isLoopbackHostname(parsed.hostname)) return parsed;

  if (options.allowNonLoopback === true) return parsed;

  throw new NetworkPolicyError(
    rawUrl,
    `${setting} points at ${parsed.hostname}, which is not a loopback address. ` +
      `The air-gapped build only talks to local services. Set allowNonLoopback to ` +
      `true (and record why) if this machine really should use a remote endpoint.`,
  );
}
