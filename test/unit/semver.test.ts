import { describe, expect, it } from "vitest";
import {
  SemverError,
  compareSemver,
  isValidSemver,
  parseSemver,
  satisfiesRange,
} from "../../src/packaging/semver.js";

describe("parseSemver", () => {
  it("parses a plain release", () => {
    expect(parseSemver("4.6.6")).toEqual({ major: 4, minor: 6, patch: 6, prerelease: [] });
  });

  it("strips a leading v and ignores build metadata", () => {
    expect(parseSemver("v1.2.3+build.5").major).toBe(1);
  });

  it("keeps pre-release identifiers", () => {
    expect(parseSemver("4.0.0-rc.1").prerelease).toEqual(["rc", "1"]);
  });

  it("rejects partial and malformed versions", () => {
    for (const bad of ["4.6", "4", "not-a-version", "4.6.x", "", "4.6.6.7"]) {
      expect(() => parseSemver(bad)).toThrow(SemverError);
    }
  });

  it("validates without throwing", () => {
    expect(isValidSemver("1.0.0")).toBe(true);
    expect(isValidSemver("1.0")).toBe(false);
  });
});

describe("compareSemver", () => {
  it("orders by major, minor, then patch", () => {
    expect(compareSemver(parseSemver("1.0.0"), parseSemver("2.0.0"))).toBe(-1);
    expect(compareSemver(parseSemver("1.2.0"), parseSemver("1.1.9"))).toBe(1);
    expect(compareSemver(parseSemver("1.1.1"), parseSemver("1.1.1"))).toBe(0);
  });

  it("ranks a release above its pre-releases", () => {
    expect(compareSemver(parseSemver("4.6.6"), parseSemver("4.6.6-rc.1"))).toBe(1);
    expect(compareSemver(parseSemver("4.6.6-rc.1"), parseSemver("4.6.6"))).toBe(-1);
  });

  it("orders pre-release identifiers per the spec", () => {
    expect(compareSemver(parseSemver("1.0.0-alpha"), parseSemver("1.0.0-alpha.1"))).toBe(-1);
    expect(compareSemver(parseSemver("1.0.0-alpha.1"), parseSemver("1.0.0-beta"))).toBe(-1);
    // Numeric identifiers sort below alphanumeric ones.
    expect(compareSemver(parseSemver("1.0.0-1"), parseSemver("1.0.0-alpha"))).toBe(-1);
  });
});

describe("satisfiesRange", () => {
  it("handles the operators used by advisory ranges", () => {
    expect(satisfiesRange("4.4.3", "< 4.6.6")).toBe(true);
    expect(satisfiesRange("4.6.6", "< 4.6.6")).toBe(false);
    expect(satisfiesRange("4.6.6", "<= 4.6.6")).toBe(true);
    expect(satisfiesRange("4.6.7", "<= 4.6.6")).toBe(false);
    expect(satisfiesRange("3.22.2", "<= 3.22.2")).toBe(true);
    expect(satisfiesRange("3.22.3", "<= 3.22.2")).toBe(false);
    expect(satisfiesRange("2.0.0", "> 1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", "> 1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0", ">= 1.0.0")).toBe(true);
  });

  it("handles a conjunctive comparator set", () => {
    expect(satisfiesRange("1.5.0", ">= 1.0.0 < 2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", ">= 1.0.0 < 2.0.0")).toBe(false);
    expect(satisfiesRange("0.9.0", ">= 1.0.0 < 2.0.0")).toBe(false);
  });

  it("handles alternatives joined by ||", () => {
    expect(satisfiesRange("1.2.0", "<= 1.0.0 || >= 1.2.0")).toBe(true);
    expect(satisfiesRange("1.1.0", "<= 1.0.0 || >= 1.2.0")).toBe(false);
  });

  it("handles hyphen ranges", () => {
    expect(satisfiesRange("1.5.0", "1.2.3 - 2.3.4")).toBe(true);
    expect(satisfiesRange("2.3.5", "1.2.3 - 2.3.4")).toBe(false);
  });

  it("treats a bare version as exact", () => {
    expect(satisfiesRange("4.6.6", "4.6.6")).toBe(true);
    expect(satisfiesRange("4.6.7", "4.6.6")).toBe(false);
  });

  it("treats wildcards as matching anything", () => {
    expect(satisfiesRange("1.0.0", "*")).toBe(true);
    expect(satisfiesRange("1.0.0", "")).toBe(true);
  });

  it("refuses to guess at partial version ranges", () => {
    // npm reads "4.6" as 4.6.x; treating it as 4.6.0 would under-report.
    expect(() => satisfiesRange("4.6.5", ">= 4.6")).toThrow(SemverError);
    expect(() => satisfiesRange("4.6.5", "^4.6.0")).toThrow(SemverError);
    expect(() => satisfiesRange("4.6.5", "~4.6.0")).toThrow(SemverError);
  });

  it("refuses an unparseable installed version", () => {
    expect(() => satisfiesRange("4.6", "< 4.6.6")).toThrow(SemverError);
  });

  it("matches the real advisory range for the zod finding", () => {
    // GHSA-mrhx-c7xc-m3w5
    expect(satisfiesRange("4.4.3", "< 4.6.6")).toBe(true);
    expect(satisfiesRange("4.6.7", "< 4.6.6")).toBe(false);
  });
});
