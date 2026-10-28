import { describe, expect, it } from "vitest";
import {
  TargetPathError,
  canonicalizeTargetPath,
  isSameTarget,
  targetCacheKey,
  toFileUrl,
} from "../../src/platform/paths.js";

const win = { platform: "windows" as const };

describe("canonicalizeTargetPath (windows)", () => {
  it("accepts a plain drive path and normalizes separators", () => {
    expect(canonicalizeTargetPath("C:\\Windows\\System32\\notepad.exe", win)).toBe(
      "C:\\Windows\\System32\\notepad.exe",
    );
    expect(canonicalizeTargetPath("C:/Windows/System32/notepad.exe", win)).toBe(
      "C:\\Windows\\System32\\notepad.exe",
    );
  });

  it("collapses dot segments but keeps the drive", () => {
    expect(canonicalizeTargetPath("C:\\a\\b\\..\\c.dll", win)).toBe("C:\\a\\c.dll");
  });

  it("strips the extended-length prefix", () => {
    expect(canonicalizeTargetPath("\\\\?\\C:\\targets\\app.exe", win)).toBe(
      "C:\\targets\\app.exe",
    );
  });

  it("converts an extended UNC prefix into a plain UNC path", () => {
    expect(canonicalizeTargetPath("\\\\?\\UNC\\server\\share\\app.exe", win)).toBe(
      "\\\\server\\share\\app.exe",
    );
  });

  it("strips the NT object-manager prefix", () => {
    expect(canonicalizeTargetPath("\\??\\C:\\targets\\app.exe", win)).toBe(
      "C:\\targets\\app.exe",
    );
  });

  it("preserves a plain UNC path", () => {
    expect(canonicalizeTargetPath("\\\\server\\share\\app.exe", win)).toBe(
      "\\\\server\\share\\app.exe",
    );
  });

  it("rejects relative paths, matching REA's contract", () => {
    expect(() => canonicalizeTargetPath("samples\\app.exe", win)).toThrow(TargetPathError);
    try {
      canonicalizeTargetPath(".\\app.exe", win);
    } catch (error) {
      expect((error as TargetPathError).code).toBe("relative_path");
      expect((error as Error).message).toMatch(/absolute/i);
    }
  });

  it("rejects drive-relative paths, which Win32 resolves against a per-drive cwd", () => {
    expect(() => canonicalizeTargetPath("C:app.exe", win)).toThrow(TargetPathError);
  });

  it("resolves relative input when a base is supplied", () => {
    expect(
      canonicalizeTargetPath("samples\\app.exe", { ...win, resolveRelativeTo: "C:\\work" }),
    ).toBe("C:\\work\\samples\\app.exe");
  });

  it("converts file URLs", () => {
    expect(canonicalizeTargetPath("file:///C:/targets/app.exe", win)).toBe(
      "C:\\targets\\app.exe",
    );
    expect(canonicalizeTargetPath("file://server/share/app.exe", win)).toBe(
      "\\\\server\\share\\app.exe",
    );
  });

  it("rejects non-file URL schemes", () => {
    expect(() => canonicalizeTargetPath("https://example.com/app.exe", win)).toThrow(
      /Unsupported URL scheme/,
    );
  });

  it("rejects empty input and NUL bytes", () => {
    expect(() => canonicalizeTargetPath("   ", win)).toThrow(TargetPathError);
    expect(() => canonicalizeTargetPath("C:\\a\u0000b.exe", win)).toThrow(/NUL/);
  });

  it("emits forward slashes in forward style", () => {
    expect(
      canonicalizeTargetPath("\\\\?\\C:\\prog files\\app.exe", { ...win, style: "forward" }),
    ).toBe("C:/prog files/app.exe");
  });
});

describe("canonicalizeTargetPath (posix)", () => {
  const posix = { platform: "posix" as const };

  it("keeps a posix absolute path", () => {
    expect(canonicalizeTargetPath("/usr/bin/ls", posix)).toBe("/usr/bin/ls");
    expect(canonicalizeTargetPath("/usr//bin/../bin/ls", posix)).toBe("/usr/bin/ls");
  });

  it("rejects relative posix paths", () => {
    expect(() => canonicalizeTargetPath("bin/ls", posix)).toThrow(TargetPathError);
  });
});

describe("identity helpers", () => {
  it("treats separator and case differences as the same Windows target", () => {
    expect(isSameTarget("C:/Targets/App.exe", "c:\\targets\\app.exe")).toBe(true);
    expect(isSameTarget("C:\\targets\\app.exe", "C:\\targets\\other.exe")).toBe(false);
  });

  it("is case-sensitive on posix", () => {
    expect(isSameTarget("/usr/bin/Ls", "/usr/bin/ls", "posix")).toBe(false);
  });

  it("produces a stable cache key", () => {
    expect(targetCacheKey("C:/Targets/APP.EXE")).toBe(targetCacheKey("C:\\targets\\app.exe"));
  });

  it("round-trips through a file URL", () => {
    expect(toFileUrl("C:\\targets\\app.exe")).toBe("file:///C:/targets/app.exe");
  });
});
