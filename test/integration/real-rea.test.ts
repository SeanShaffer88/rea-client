/**
 * Integration tests against a real `rea-agents` MCP server over stdio.
 *
 * These are the tests that would have caught the blueprint's assumptions being
 * wrong: they assert on the *live* catalog rather than on a hardcoded tool list,
 * and they drive the real error paths (`open_binary` rejecting a relative path)
 * through the same projection code the agent loop uses.
 *
 * Skipped automatically when `rea-agents` is not installed.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type ReaServerConfig } from "../../src/config.js";
import { ToolCatalog } from "../../src/mcp/catalog.js";
import { ReaClient } from "../../src/mcp/ReaClient.js";
import { ToolObservation, projectToolResult, readEvidence } from "../../src/mcp/evidence.js";
import { readBinarySession } from "../../src/mcp/session.js";
import type { McpToolDefinition } from "../../src/mcp/types.js";

const REA_ENTRY = resolve("node_modules/rea-agents/scripts/rea.mjs");
const hasRea = existsSync(REA_ENTRY);

/** A real ELF binary that exists on every Linux CI image. */
const SYSTEM_BINARY = "/usr/bin/ls";

describe.skipIf(!hasRea)("real rea-agents MCP server", () => {
  let client: ReaClient;
  let tools: readonly McpToolDefinition[];
  let catalog: ToolCatalog;

  const config: ReaServerConfig = {
    ...DEFAULT_CONFIG.rea,
    command: process.execPath,
    args: [REA_ENTRY, "mcp"],
  };

  beforeAll(async () => {
    client = new ReaClient(config);
    await client.connect();
    tools = await client.listTools();
    catalog = ToolCatalog.from(tools);
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
  });

  describe("handshake and inventory", () => {
    it("completes the MCP handshake and reports a server version", () => {
      const version = client.serverVersion();
      expect(version?.name).toBe("rea");
      expect(version?.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("discovers a large catalog rather than the four tools the blueprint assumed", () => {
      expect(tools.length).toBeGreaterThan(100);
      expect(catalog.size).toBe(tools.length);
    });

    it("exposes the tools the client's core scope depends on", () => {
      for (const name of [
        "open_binary",
        "close_binary",
        "binary_session",
        "analyze_function",
        "procedure_pseudo_code",
        "list_procedures",
        "xrefs",
        "inspect_pe_imports",
        "list_strings",
      ]) {
        expect(catalog.has(name), `missing ${name}`).toBe(true);
      }
    });

    it("has no duplicate tool names", () => {
      expect(catalog.duplicateNames(tools)).toEqual([]);
    });

    it("resolves the binary-core scope with nothing missing", () => {
      const resolved = catalog.resolveScope("binary-core");
      expect(resolved.missing).toEqual([]);
      expect(resolved.tools.length).toBeGreaterThan(15);
    });

    it("provides an input schema for every tool", () => {
      for (const tool of tools) {
        expect(tool.inputSchema, tool.name).toBeTypeOf("object");
      }
    });

    it("classifies every advertised tool into a known family", () => {
      const unknown = tools.filter((tool) => catalog.familyOf(tool.name) === "other");
      // `other` is a deliberate escape hatch, but it should stay small enough
      // that the navigation tree remains useful.
      expect(unknown.map((tool) => tool.name)).toEqual([]);
    });
  });

  describe("binary_session discovery", () => {
    it("parses the live session payload", async () => {
      const result = await client.callTool("binary_session", {});
      const session = readBinarySession(result);

      expect(session).toBeDefined();
      expect(session?.packageName).toBe("rea-agents");
      expect(session?.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(session?.catalogToolCount).toBe(tools.length);
      expect(session?.providers.length).toBeGreaterThan(0);
    });
  });

  describe("error contract", () => {
    it("renders the live relative-path rejection as an actionable observation", async () => {
      const result = await client.callTool("open_binary", { path: "samples/app.exe" });
      expect(result.isError).toBe(true);
      // Verified 6.8.0 behaviour: failures carry no structuredContent.
      expect(result.structuredContent).toBeUndefined();

      const observation = projectToolResult(result, { maxChars: 4_000 });
      expect(observation.text.startsWith(ToolObservation.errorPrefix)).toBe(true);
      expect(observation.text).toContain("invalid_request");
      expect(observation.text).toContain("absolute local filesystem path");
      // REA's own recovery guidance must reach the model.
      expect(observation.text).toMatch(/Do not repeat the unchanged call|Next step/);
    });

    it("renders a missing-file failure without throwing", async () => {
      const result = await client.callTool("open_binary", { path: "/nonexistent/gone.exe" });
      const observation = projectToolResult(result, { maxChars: 2_000 });
      expect(observation.text).toContain("TOOL_ERROR");
      expect(observation.text.length).toBeLessThanOrEqual(2_000);
    });
  });

  describe("opening a real target", () => {
    it("opens an ELF binary and reports identity", async () => {
      const result = await client.callTool("open_binary", { path: SYSTEM_BINARY });
      expect(result.isError).toBeFalsy();

      const observation = projectToolResult(result, { maxChars: 4_000 });
      expect(observation.text).toContain("elf");

      const session = readBinarySession(await client.callTool("binary_session", {}));
      expect(session?.open).toBe(true);
      expect(session?.format).toBe("elf");
      expect(session?.architecture).toBe("x86_64");
      expect(session?.sha256).toMatch(/^[a-f0-9]{64}$/);
      // The server canonicalizes through symlinks; the reported path is
      // authoritative rather than the caller's spelling.
      expect(session?.targetPath).toBeTypeOf("string");
    });
  });

  describe("evidence envelopes", () => {
    it("returns Evidence with an id for an evidence-producing tool, or a clean error", async () => {
      const result = await client.callTool("list_strings", {});
      const evidence = readEvidence(result);

      if (result.isError === true || evidence === undefined) {
        // Without Ghidra/IDA bound, a typed error is the correct outcome. The
        // point is that the client handles it without crashing.
        const observation = projectToolResult(result, { maxChars: 2_000 });
        expect(observation.text.length).toBeGreaterThan(0);
        return;
      }

      expect(evidence.evidence_id).toBeTypeOf("string");
      expect(evidence.operation).toBeTypeOf("string");

      const observation = projectToolResult(result, { maxChars: 8_000 });
      expect(observation.text).toContain(`evidence_id=${evidence.evidence_id as string}`);
      expect(observation.text.length).toBeLessThanOrEqual(8_000);
    });
  });
});
