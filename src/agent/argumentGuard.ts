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
      readonly code: "array_too_long" | "payload_too_large" | "depth_exceeded" | "not_an_object";
      readonly message: string;
    };

const MAX_ARGUMENT_DEPTH = 16;

type GuardViolation =
  | { readonly kind: "array_too_long"; readonly path: string; readonly length: number }
  | { readonly kind: "depth_exceeded"; readonly path: string };

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

  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > limits.maxBytes) {
    return {
      ok: false,
      code: "payload_too_large",
      message:
        `Tool arguments are ${String(byteLength)} bytes, over the ${String(limits.maxBytes)}-byte limit. ` +
        `Narrow the request instead of sending a bulk payload.`,
    };
  }

  const violation = findViolation(args, limits.maxArrayItems, "");
  if (violation !== undefined) {
    if (violation.kind === "depth_exceeded") {
      return {
        ok: false,
        code: "depth_exceeded",
        message:
          `Argument "${violation.path}" exceeds the maximum nesting depth (${String(MAX_ARGUMENT_DEPTH)}). ` +
          `Flatten the request instead of sending deeply nested structures.`,
      };
    }
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

function findViolation(
  node: unknown,
  maxItems: number,
  path: string,
  depth = 0,
): GuardViolation | undefined {
  // Fail closed past MAX_ARGUMENT_DEPTH so a deeply nested array cannot slip
  // past the item limit undetected.
  if (depth > MAX_ARGUMENT_DEPTH) {
    return { kind: "depth_exceeded", path: path === "" ? "(root)" : path };
  }

  if (Array.isArray(node)) {
    if (node.length > maxItems) {
      return { kind: "array_too_long", path: path === "" ? "(root)" : path, length: node.length };
    }
    for (const [index, value] of node.entries()) {
      const found = findViolation(value, maxItems, `${path}[${String(index)}]`, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const found = findViolation(value, maxItems, path === "" ? key : `${path}.${key}`, depth + 1);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}
