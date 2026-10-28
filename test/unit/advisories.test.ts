import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdvisoryError,
  analyzeArraySurface,
  assessAdvisories,
  assessDependency,
  fetchAdvisories,
  installedCopies,
  loadAdvisoriesFromFile,
  loadKnownFindings,
  normalizeAdvisoryPayload,
  severityAtLeast,
  type Advisory,
  type InstalledCopy,
} from "../../src/packaging/advisories.js";
import type { McpToolDefinition } from "../../src/mcp/types.js";

// The two real zod advisories, in the GitHub API shape.
const GHSA_ARRAY = {
  ghsa_id: "GHSA-mrhx-c7xc-m3w5",
  cve_id: "CVE-2023-54404",
  severity: "high",
  summary: "Zod can exhaust memory while validating oversized constrained collections",
  description:
    "Uncontrolled resource consumption: attackers exhaust memory by submitting a large array to an array schema without a length constraint.",
  html_url: "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
  vulnerabilities: [
    {
      package: { name: "zod", ecosystem: "npm" },
      vulnerable_version_range: "< 4.6.6",
      first_patched_version: "4.6.6",
    },
  ],
};

const GHSA_OTHER = {
  ghsa_id: "GHSA-m95q-7qp3-xv42",
  severity: "moderate",
  summary: "Zod denial of service vulnerability",
  vulnerabilities: [
    {
      package: { name: "zod", ecosystem: "npm" },
      vulnerable_version_range: "<= 3.22.2",
      first_patched_version: "3.22.3",
    },
    // A different package in the same advisory must not be attributed to zod.
    {
      package: { name: "other-pkg", ecosystem: "npm" },
      vulnerable_version_range: "1.0.0",
      first_patched_version: "1.0.1",
    },
  ],
};

function tool(name: string, inputSchema: Record<string, unknown>): McpToolDefinition {
  return { name, inputSchema };
}

describe("normalizeAdvisoryPayload", () => {
  it("maps the GitHub shape onto the internal shape", () => {
    const advisories = normalizeAdvisoryPayload([GHSA_ARRAY], "zod");
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({
      id: "GHSA-mrhx-c7xc-m3w5",
      severity: "high",
      vulnerableRange: "< 4.6.6",
      patchedVersion: "4.6.6",
      cveId: "CVE-2023-54404",
    });
  });

  it("keeps only ranges naming the requested package", () => {
    const advisories = normalizeAdvisoryPayload([GHSA_OTHER], "zod");
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.vulnerableRange).toBe("<= 3.22.2");
  });

  it("normalizes the alternate 'moderate' spelling to medium", () => {
    expect(normalizeAdvisoryPayload([GHSA_OTHER], "zod")[0]?.severity).toBe("medium");
  });

  it("accepts an already-normalized list", () => {
    const advisories = normalizeAdvisoryPayload([
      { id: "X-1", severity: "low", summary: "s", vulnerableRange: "< 2.0.0" },
    ]);
    expect(advisories[0]?.id).toBe("X-1");
  });

  it("accepts an object wrapper", () => {
    expect(normalizeAdvisoryPayload({ advisories: [GHSA_ARRAY] }, "zod")).toHaveLength(1);
  });

  it("rejects an unexpected payload shape", () => {
    expect(() => normalizeAdvisoryPayload({ nope: true })).toThrow(AdvisoryError);
  });
});

describe("fetchAdvisories", () => {
  it("queries by ecosystem and package", async () => {
    const urls: string[] = [];
    await fetchAdvisories("zod", {
      fetchImpl: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify([GHSA_ARRAY]), { status: 200 });
      }) as typeof fetch,
    });
    expect(urls[0]).toContain("ecosystem=npm");
    expect(urls[0]).toContain("affects=zod");
  });

  it("throws on an HTTP failure, so a network problem never reads as clean", async () => {
    await expect(
      fetchAdvisories("zod", {
        fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("throws on a transport failure", async () => {
    await expect(
      fetchAdvisories("zod", {
        fetchImpl: (async () => Promise.reject(new Error("ECONNRESET"))) as typeof fetch,
      }),
    ).rejects.toThrow(/Could not query advisories/);
  });
});

describe("installedCopies", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rea-advisories-"));
  });

  afterEach(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  async function lockfile(packages: Record<string, unknown>): Promise<void> {
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }), "utf8");
  }

  it("finds top-level and nested copies", async () => {
    await lockfile({
      "": { dependencies: {} },
      "node_modules/zod": { version: "4.6.7" },
      "node_modules/rea-agents/node_modules/zod": { version: "4.4.3" },
    });

    const copies = await installedCopies("zod", root);
    expect(copies.map((copy) => `${copy.path}@${copy.version}`)).toEqual([
      "node_modules/rea-agents/node_modules/zod@4.4.3",
      "node_modules/zod@4.6.7",
    ]);
  });

  it("attributes a nested copy to the package that requires it", async () => {
    await lockfile({
      "": { dependencies: { "rea-agents": "6.8.0" } },
      "node_modules/rea-agents": { version: "6.8.0", dependencies: { zod: "4.4.3" } },
      "node_modules/rea-agents/node_modules/zod": { version: "4.4.3" },
    });

    const copies = await installedCopies("zod", root);
    expect(copies[0]?.requiredBy).toEqual(["node_modules/rea-agents"]);
  });

  it("ignores other packages and path prefixes", async () => {
    await lockfile({
      "node_modules/zodiac": { version: "1.0.0" },
      "node_modules/@scope/zod-extra": { version: "1.0.0" },
      "node_modules/zod": { version: "4.6.7" },
    });

    const copies = await installedCopies("zod", root);
    expect(copies).toHaveLength(1);
  });

  it("rejects a corrupt lockfile", async () => {
    await writeFile(join(root, "package-lock.json"), "{not json", "utf8");
    await expect(installedCopies("zod", root)).rejects.toThrow(AdvisoryError);
  });
});

describe("analyzeArraySurface", () => {
  it("finds bounded and unbounded array parameters", () => {
    const surface = analyzeArraySurface([
      tool("a", {
        type: "object",
        properties: {
          addresses: { type: "array", items: { type: "string" } },
          types: { type: "array", maxItems: 8, items: { type: "string" } },
        },
      }),
    ]);

    expect(surface.totalArrayParameters).toBe(2);
    expect(surface.unbounded.map((hit) => hit.path)).toEqual(["addresses"]);
    expect(surface.bounded.map((hit) => hit.path)).toEqual(["types"]);
  });

  it("descends into nested objects, arrays, unions and $defs", () => {
    const surface = analyzeArraySurface([
      tool("deep", {
        type: "object",
        properties: {
          options: {
            type: "object",
            properties: { roots: { type: "array", items: { type: "string" } } },
          },
          choice: { oneOf: [{ type: "array", items: { type: "string" } }] },
        },
        // JSON Schema 2020-12 keeps shared definitions at the schema root.
        $defs: { Names: { type: "array", items: { type: "string" } } },
      }),
    ]);

    const paths = surface.unbounded.map((hit) => hit.path);
    expect(paths).toContain("options.roots");
    expect(paths).toContain("choice<oneOf[0]>");
    expect(paths).toContain("<$defs.Names>");
  });

  it("returns an empty surface for tools with no arrays", () => {
    const surface = analyzeArraySurface([tool("scalar", { type: "object", properties: { p: { type: "string" } } })]);
    expect(surface.totalArrayParameters).toBe(0);
    expect(surface.unbounded).toEqual([]);
  });
});

describe("assessAdvisories verdicts", () => {
  const advisory: Advisory = {
    id: "GHSA-mrhx-c7xc-m3w5",
    severity: "high",
    summary: "Zod can exhaust memory while validating oversized constrained collections",
    vulnerableRange: "< 4.6.6",
  };

  const affected: InstalledCopy[] = [
    { path: "node_modules/rea-agents/node_modules/zod", version: "4.4.3", requiredBy: [] },
  ];
  const patched: InstalledCopy[] = [{ path: "node_modules/zod", version: "4.6.7", requiredBy: [] }];

  const unboundedTool = tool("batch_decompile", {
    type: "object",
    properties: { addresses: { type: "array", items: { type: "string" } } },
  });
  const boundedTool = tool("bounded", {
    type: "object",
    properties: { addresses: { type: "array", maxItems: 10, items: { type: "string" } } },
  });

  it("reports not-reachable when no installed copy is affected", () => {
    const [assessment] = assessAdvisories([advisory], patched, [unboundedTool]);
    expect(assessment?.verdict).toBe("not-reachable");
    expect(assessment?.affectedCopies).toEqual([]);
  });

  it("reports reachable when an affected copy meets an unbounded array surface", () => {
    const [assessment] = assessAdvisories([advisory], affected, [unboundedTool]);
    expect(assessment?.verdict).toBe("reachable");
    expect(assessment?.rationale).toContain("1 of 1");
    expect(assessment?.rationale).toContain("batch_decompile.addresses");
  });

  it("reports not-reachable when the array surface is fully bounded", () => {
    const [assessment] = assessAdvisories([advisory], affected, [boundedTool]);
    expect(assessment?.verdict).toBe("not-reachable");
    expect(assessment?.rationale).toContain("maxItems");
  });

  it("reports undetermined when the surface was not supplied", () => {
    const [assessment] = assessAdvisories([advisory], affected);
    expect(assessment?.verdict).toBe("undetermined");
    expect(assessment?.rationale).toContain("could not be checked");
  });

  it("reports undetermined for weakness classes it does not model", () => {
    const unknown: Advisory = {
      id: "X-1",
      severity: "high",
      summary: "Prototype pollution in deep merge",
      vulnerableRange: "< 2.0.0",
    };
    const [assessment] = assessAdvisories(
      [unknown],
      [{ path: "node_modules/x", version: "1.0.0", requiredBy: [] }],
      [boundedTool],
    );
    expect(assessment?.verdict).toBe("undetermined");
    expect(assessment?.rationale).toContain("not modelled");
  });

  it("lists only the copies inside the range", () => {
    const [assessment] = assessAdvisories([advisory], [...affected, ...patched], [unboundedTool]);
    expect(assessment?.affectedCopies.map((copy) => copy.version)).toEqual(["4.4.3"]);
    expect(assessment?.unaffectedCopies.map((copy) => copy.version)).toEqual(["4.6.7"]);
  });

  it("treats an unparseable range as affecting, never as safe", () => {
    const weird: Advisory = { ...advisory, vulnerableRange: ">= 4.6" };
    const [assessment] = assessAdvisories([weird], patched, [boundedTool]);
    expect(assessment?.affectedCopies).toHaveLength(1);
  });
});

describe("severityAtLeast", () => {
  it("orders severities", () => {
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("high", "high")).toBe(true);
    expect(severityAtLeast("medium", "high")).toBe(false);
    expect(severityAtLeast("low", "low")).toBe(true);
  });
});

describe("assessDependency gating", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rea-assess-"));
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "": {},
          "node_modules/rea-agents/node_modules/zod": { version: "4.4.3" },
        },
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  const unbounded = tool("t", {
    type: "object",
    properties: { items: { type: "array", items: { type: "string" } } },
  });

  function fakeFetch(payload: unknown, status = 200): typeof fetch {
    return (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch;
  }

  it("fails when a high-severity advisory is reachable", async () => {
    const report = await assessDependency({
      projectRoot: root,
      packageName: "zod",
      tools: [unbounded],
      fetchImpl: fakeFetch([GHSA_ARRAY]),
      denySeverity: "high",
    });
    expect(report.ok).toBe(false);
    expect(report.reachable.map((entry) => entry.advisory.id)).toEqual(["GHSA-mrhx-c7xc-m3w5"]);
  });

  it("fails when the verdict is undetermined at or above the threshold", async () => {
    const report = await assessDependency({
      projectRoot: root,
      packageName: "zod",
      fetchImpl: fakeFetch([GHSA_ARRAY]),
      denySeverity: "high",
    });
    expect(report.ok).toBe(false);
    expect(report.undetermined).toHaveLength(1);
  });

  it("passes undetermined only when explicitly allowed", async () => {
    const report = await assessDependency({
      projectRoot: root,
      packageName: "zod",
      fetchImpl: fakeFetch([GHSA_ARRAY]),
      denySeverity: "high",
      allowUndetermined: true,
    });
    expect(report.ok).toBe(true);
  });

  it("ignores advisories no installed copy is affected by", async () => {
    const report = await assessDependency({
      projectRoot: root,
      packageName: "zod",
      tools: [unbounded],
      fetchImpl: fakeFetch([GHSA_OTHER]),
      denySeverity: "low",
    });
    expect(report.ok).toBe(true);
    expect(report.reachable).toEqual([]);
  });

  it("respects the denial threshold", async () => {
    const report = await assessDependency({
      projectRoot: root,
      packageName: "zod",
      tools: [unbounded],
      fetchImpl: fakeFetch([GHSA_ARRAY]),
      denySeverity: "critical",
    });
    // high < critical, so nothing blocks.
    expect(report.ok).toBe(true);
    expect(report.reachable).toEqual([]);
  });

  it("reports a lookup failure as not-ok rather than clean", async () => {
    const report = await assessDependency({
      projectRoot: root,
      packageName: "zod",
      fetchImpl: (async () => Promise.reject(new Error("no route to host"))) as typeof fetch,
    });
    expect(report.ok).toBe(false);
    expect(report.lookupError).toContain("no route to host");
  });

  it("accepts a known finding and stops blocking", async () => {
    const report = await assessDependency({
      projectRoot: root,
      packageName: "zod",
      tools: [unbounded],
      fetchImpl: fakeFetch([GHSA_ARRAY]),
      knownFindings: [
        {
          id: "GHSA-mrhx-c7xc-m3w5",
          package: "zod",
          rationale: "pinned upstream",
          mitigation: "argument guard",
          reviewedAt: "2026-10-27",
        },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.accepted).toHaveLength(1);
    expect(report.reachable).toHaveLength(1);
  });

  it("does not accept a finding recorded for a different package", async () => {
    const report = await assessDependency({
      projectRoot: root,
      packageName: "zod",
      tools: [unbounded],
      fetchImpl: fakeFetch([GHSA_ARRAY]),
      knownFindings: [
        {
          id: "GHSA-mrhx-c7xc-m3w5",
          package: "something-else",
          rationale: "r",
          mitigation: "m",
          reviewedAt: "2026-10-27",
        },
      ],
    });
    expect(report.ok).toBe(false);
  });

  it("flags an acceptance whose review date has passed", async () => {
    const report = await assessDependency({
      projectRoot: root,
      packageName: "zod",
      tools: [unbounded],
      fetchImpl: fakeFetch([GHSA_ARRAY]),
      knownFindings: [
        {
          id: "GHSA-mrhx-c7xc-m3w5",
          package: "zod",
          rationale: "r",
          mitigation: "m",
          reviewedAt: "2020-01-01",
          reviewBy: "2020-06-01",
        },
      ],
    });
    expect(report.overdueReviews).toHaveLength(1);
    expect(report.overdueReviews?.[0]).toContain("review by 2020-06-01");
  });
});

describe("offline advisory and accepted-finding files", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rea-files-"));
  });

  afterEach(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  it("loads advisories from a recorded API payload", async () => {
    const file = join(root, "adv.json");
    await writeFile(file, JSON.stringify([GHSA_ARRAY]), "utf8");
    const advisories = await loadAdvisoriesFromFile(file, "zod");
    expect(advisories[0]?.id).toBe("GHSA-mrhx-c7xc-m3w5");
  });

  it("rejects a malformed advisory file", async () => {
    const file = join(root, "adv.json");
    await writeFile(file, "{oops", "utf8");
    await expect(loadAdvisoriesFromFile(file, "zod")).rejects.toThrow(/not valid JSON/);
  });

  it("requires rationale, mitigation and review date on accepted findings", async () => {
    const cases = [
      [{ id: "X", package: "p", mitigation: "m", reviewedAt: "2026-01-01" }, /rationale/],
      [{ id: "X", package: "p", rationale: "r", reviewedAt: "2026-01-01" }, /mitigation/],
      [{ id: "X", package: "p", rationale: "r", mitigation: "m" }, /reviewedAt/],
      [{ id: "X", package: "p", rationale: "r", mitigation: "m", reviewedAt: "Jan 2026" }, /reviewedAt/],
    ] as const;

    for (const [entry, pattern] of cases) {
      const file = join(root, "acc.json");
      await writeFile(file, JSON.stringify([entry]), "utf8");
      await expect(loadKnownFindings(file)).rejects.toThrow(pattern);
    }
  });

  it("loads a valid accepted-findings file", async () => {
    const file = join(root, "acc.json");
    await writeFile(
      file,
      JSON.stringify({
        accepted: [
          { id: "X", package: "p", rationale: "r", mitigation: "m", reviewedAt: "2026-01-01" },
        ],
      }),
      "utf8",
    );
    const findings = await loadKnownFindings(file);
    expect(findings[0]?.id).toBe("X");
  });
});
