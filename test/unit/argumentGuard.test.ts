import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUARD_LIMITS,
  checkToolArguments,
} from "../../src/agent/argumentGuard.js";

const limits = { maxArrayItems: 3, maxBytes: 200 };

describe("checkToolArguments", () => {
  it("accepts ordinary arguments", () => {
    expect(checkToolArguments({ procedure: "0x1400010a0", detail: "complete" }, limits)).toEqual({
      ok: true,
    });
  });

  it("accepts an array exactly at the limit", () => {
    expect(checkToolArguments({ addresses: ["a", "b", "c"] }, limits).ok).toBe(true);
  });

  it("rejects an array one element over the limit", () => {
    const result = checkToolArguments({ addresses: ["a", "b", "c", "d"] }, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("array_too_long");
      expect(result.message).toContain("addresses");
      expect(result.message).toContain("4 items");
    }
  });

  it("rejects an oversized nested array", () => {
    const result = checkToolArguments({ options: { candidate_paths: [1, 2, 3, 4, 5] } }, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("options.candidate_paths");
  });

  it("rejects an oversized array inside an array", () => {
    const result = checkToolArguments({ groups: [[1, 2], [3, 4, 5, 6]] }, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("groups[1]");
  });

  it("rejects a payload over the byte limit", () => {
    const result = checkToolArguments({ note: "x".repeat(500) }, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("payload_too_large");
  });

  it("checks bytes before arrays, so a huge array reports the size limit first", () => {
    const result = checkToolArguments({ addresses: Array.from({ length: 500 }, () => "0x1") }, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("payload_too_large");
  });

  it("does not flag long strings on their own", () => {
    // A single large string is not the unbounded-array weakness.
    expect(checkToolArguments({ pseudocode: "a".repeat(150) }, limits).ok).toBe(true);
  });

  it("fails closed when nesting exceeds MAX_ARGUMENT_DEPTH", () => {
    let nested: Record<string, unknown> = { hidden: [1, 2, 3, 4, 5] };
    for (let index = 0; index < 20; index += 1) nested = { next: nested };
    const result = checkToolArguments(nested, { maxArrayItems: 3, maxBytes: 10_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("depth_exceeded");
  });

  it("counts UTF-8 bytes rather than UTF-16 code units", () => {
    // 60 four-byte emoji = 120 UTF-16 code units (< 200), but > 240 UTF-8 bytes (> 200).
    const emojiPayload = { note: "🔥".repeat(60) };
    const result = checkToolArguments(emojiPayload, { maxArrayItems: 10, maxBytes: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("payload_too_large");
  });

  it("uses conservative defaults when no limits are given", () => {
    const withinDefault = Array.from({ length: DEFAULT_GUARD_LIMITS.maxArrayItems }, () => 1);
    expect(checkToolArguments({ items: withinDefault }).ok).toBe(true);

    const overDefault = [...withinDefault, 1];
    expect(checkToolArguments({ items: overDefault }).ok).toBe(false);
  });

  it("rejects unserializable arguments", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const result = checkToolArguments(circular, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_an_object");
  });
});
