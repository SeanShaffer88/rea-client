/**
 * Subprocess integration tests for `rea-client serve` (JSON-RPC 2.0 stdio
 * bridge) and the cross-platform `scripts/refresh-advisories.mjs` utility.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeModelServer, SSE_DONE, sseFrame, textChunk } from "../support/fakeModelServer.js";

const CLI = resolve("dist/cli.js");
const REFRESH_SCRIPT = resolve("scripts/refresh-advisories.mjs");
const REA_ENTRY = resolve("node_modules/rea-agents/scripts/rea.mjs");
const hasBuild = existsSync(CLI);
const hasRea = existsSync(REA_ENTRY);

const SYSTEM_BINARY =
  process.platform === "win32"
    ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe")
    : process.platform === "darwin"
      ? "/bin/ls"
      : "/usr/bin/ls";

const EXPECTED_FORMAT =
  process.platform === "win32"
    ? "pe"
    : process.platform === "darwin"
      ? "macho"
      : "elf";

describe.skipIf(!hasBuild || !hasRea)("rea-client serve — live JSON-RPC 2.0 bridge", () => {
  let tempDir = "";
  let configPath = "";
  let modelServer: FakeModelServer;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rea-bridge-int-"));
    modelServer = new FakeModelServer(() => ({
      chunks: [
        sseFrame(textChunk("Static summary of ")),
        sseFrame(textChunk("the opened binary.")),
        SSE_DONE,
      ],
    }));
    await modelServer.start();

    configPath = join(tempDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        rea: { command: process.execPath, args: [REA_ENTRY, "mcp"] },
        llm: { baseUrl: modelServer.url, model: "test-local-14b" },
        workspaceDir: join(tempDir, "workspace"),
      }),
      "utf8",
    );
  });

  afterAll(async () => {
    await modelServer?.stop().catch(() => undefined);
    if (tempDir !== "") {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it(
    "drives ping, tools.list, target.open, stateful agent.ask, and engine.shutdown over stdio",
    async () => {
      const child = spawn(process.execPath, [CLI, "serve", "--config", configPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      const pending = new Map<
        number,
        (msg: { id: number; result?: unknown; error?: unknown }) => void
      >();
      let stdoutBuf = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        for (;;) {
          const nl = stdoutBuf.indexOf("\n");
          if (nl === -1) break;
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line === "") continue;
          const msg = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: Record<string, unknown>;
            result?: unknown;
            error?: unknown;
          };
          if (typeof msg.method === "string") {
            notifications.push({ method: msg.method, params: msg.params ?? {} });
          } else if (typeof msg.id === "number") {
            const waiter = pending.get(msg.id);
            if (waiter !== undefined) {
              pending.delete(msg.id);
              waiter({ id: msg.id, result: msg.result, error: msg.error });
            }
          }
        }
      });

      const rpc = async (id: number, method: string, params?: Record<string, unknown>) => {
        const wait = new Promise<{ id: number; result?: unknown; error?: unknown }>((res) => {
          pending.set(id, res);
        });
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            ...(params === undefined ? {} : { params }),
          })}\n`,
        );
        return wait;
      };

      try {
        const ping = await rpc(1, "engine.ping");
        expect(ping.result).toMatchObject({ ok: true, version: "0.3.0", connected: false });

        const tools = await rpc(2, "tools.list", { family: "pe" });
        const toolsResult = tools.result as { total: number };
        expect(toolsResult.total).toBeGreaterThan(100);

        const opened = await rpc(3, "target.open", { path: SYSTEM_BINARY });
        const openedResult = opened.result as {
          ok: boolean;
          session: { open: boolean; format: string; sha256: string };
        };
        expect(openedResult.ok).toBe(true);
        expect(openedResult.session.open).toBe(true);
        expect(openedResult.session.format).toBe(EXPECTED_FORMAT);

        const ask = await rpc(4, "agent.ask", {
          question: "Summarize the currently open target.",
        });
        expect(ask.result).toMatchObject({
          content: "Static summary of the opened binary.",
          reason: "final_answer",
        });

        // Streamed notifications arrived with requestId = 4.
        const streamedDeltas = notifications
          .filter((n) => n.method === "agent.event" && n.params["requestId"] === 4)
          .filter((n) => n.params["type"] === "assistant_delta");
        expect(streamedDeltas.length).toBeGreaterThanOrEqual(2);

        // System prompt delivered to the local model included format + sha256!
        const recordedBody = modelServer.recorded[0]?.body as {
          messages?: Array<{ role: string; content: string }>;
        };
        const sysPrompt = recordedBody.messages?.[0]?.content ?? "";
        expect(sysPrompt).toContain(`format: ${EXPECTED_FORMAT}`);
        expect(sysPrompt).toContain(`sha256: ${openedResult.session.sha256}`);

        const shutdown = await rpc(5, "engine.shutdown");
        expect(shutdown.result).toEqual({ ok: true });

        const [exitCode] = (await once(child, "exit")) as [number | null];
        expect(exitCode).toBe(0);
      } finally {
        if (child.exitCode === null) {
          child.kill();
        }
      }
    },
    120_000,
  );
});

describe("scripts/refresh-advisories.mjs", () => {
  it("fetches advisory JSON cross-platform and writes formatted output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rea-adv-refresh-"));
    const outFile = join(dir, "zod.ghsa.json");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ ghsa_id: "GHSA-test-0001", severity: "high" }]));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("failed to bind");

    try {
      await new Promise<void>((resolveRun, rejectRun) => {
        execFile(
          process.execPath,
          [REFRESH_SCRIPT, "zod", outFile],
          {
            env: {
              ...process.env,
              REA_ADVISORY_API: `http://127.0.0.1:${String(addr.port)}/advisories`,
            },
          },
          (error) => {
            if (error !== null) rejectRun(error);
            else resolveRun();
          },
        );
      });

      const saved = JSON.parse(await readFile(outFile, "utf8")) as Array<{ ghsa_id: string }>;
      expect(saved).toEqual([{ ghsa_id: "GHSA-test-0001", severity: "high" }]);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
