/**
 * Outbound tool-argument guard.
 *
 * Compensating control for GHSA-mrhx-c7xc-m3w5 (zod accumulates unbounded
 * validation issues for large arrays). The vulnerable copy is the one
 * `rea-agents` validates its tool arguments with, so the exposure is decided by
 * what this client is willing to *send*.
 *
 * Two facts make that a real attack path rather than a theoretical one:
 *
 *   - 69 of 74 array parameters in REA's tool surface have no `maxItems`.
 *   - Tool arguments are produced by a local model reading strings extracted
 *     from the analysed binary. A hostile target can therefore contain text
 *     that steers the model into emitting a huge array.
 *
 * Clamping here means the payload never reaches REA's validator. It does not fix
 * the dependency; it removes the path this client would otherwise provide.
 */

export interface ArgumentGuardLimits {
  /** Maximum elements allowed in any single array argument. */
  readonly maxArrayItems: number;
  /** Maximum total serialized size of the arguments. */
  readonly maxBytes: number;
}

export const DEFAULT_GUARD_LIMITS: ArgumentGuardLimits = {
  maxArrayItems: 256,
  maxBytes: 65_536,
};

export type ArgumentGuardResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "array_too_long" | "payload_too_large" | "not_an_object";
      readonly message: string;
    };

/**
 * Finds the first violation in a tool-argument object.
 *
 * Traverses arrays and nested objects; a violation anywhere rejects the call,
 * because the guard's job is to keep oversized input away from the validator
 * entirely rather than to sanitise it.
 */
export function checkToolArguments(
  args: Record<string, unknown>,
  limits: ArgumentGuardLimits = DEFAULT_GUARD_LIMITS,
): ArgumentGuardResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "{}";
  } catch {
    return {
      ok: false,
      code: "not_an_object",
      message: "Tool arguments could not be serialized.",
    };
  }

  if (serialized.length > limits.maxBytes) {
    return {
      ok: false,
      code: "payload_too_large",
      message:
        `Tool arguments are ${String(serialized.length)} bytes, over the ${String(limits.maxBytes)}-byte limit. ` +
        `Narrow the request instead of sending a bulk payload.`,
    };
  }

  const violation = findLongArray(args, limits.maxArrayItems, "");
  if (violation !== undefined) {
    return {
      ok: false,
      code: "array_too_long",
      message:
        `Argument "${violation.path}" holds ${String(violation.length)} items, over the ` +
        `${String(limits.maxArrayItems)}-item limit. Send a bounded batch instead — ` +
        `validate against the guard limit rather than relying on the server to reject it.`,
    };
  }

  return { ok: true };
}

function findLongArray(
  node: unknown,
  maxItems: number,
  path: string,
  depth = 0,
): { path: string; length: number } | undefined {
  // Bounded depth: arguments are shallow in practice, and an adversarial
  // structure must not turn the guard itself into the denial of service.
  if (depth > 16) return undefined;

  if (Array.isArray(node)) {
    if (node.length > maxItems) {
      return { path: path === "" ? "(root)" : path, length: node.length };
    }
    for (const [index, value] of node.entries()) {
      const found = findLongArray(value, maxItems, `${path}[${String(index)}]`, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const found = findLongArray(value, maxItems, path === "" ? key : `${path}.${key}`, depth + 1);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}
