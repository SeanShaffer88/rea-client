// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../desktop/ui/App.js";

interface StubOptions {
  status?: number;
  body?: unknown;
  stream?: boolean;
}

function stubResponse({ status = 200, body, stream = false }: StubOptions = {}): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  const neverEnding = {
    getReader: () => ({ read: () => new Promise<never>(() => { /* stays open */ }) }),
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
    body: stream ? neverEnding : null,
  } as unknown as Response;
}

const BOOTSTRAP = {
  token: "session-token",
  mode: "browser" as const,
  version: "0.1.0",
  platform: "linux",
  config: {
    model: "validation-model",
    baseUrl: "http://127.0.0.1:8080/v1",
    contextWindow: 16384,
    maxIterations: 8,
    toolScope: "binary-core" as const,
    customTools: [],
    allowNonLoopback: false,
    workspaceDir: "/tmp/workspace",
    configPath: "/tmp/config.json",
    transport: "stdio",
  },
};

const CATALOG = {
  total: 2,
  families: [{ id: "binary-core", label: "Binary core", count: 2 }],
  scope: { name: "binary-core" as const, count: 2, missing: [], names: ["binary_overview"] },
  entries: [
    {
      name: "binary_overview",
      title: "Binary overview",
      description: "Summarise the open target.",
      family: "binary-core",
      readOnly: true,
      destructive: false,
    },
    {
      name: "xrefs",
      title: "Cross references",
      description: "List references to an address.",
      family: "binary-core",
      readOnly: false,
      destructive: false,
    },
  ],
};

const DOCTOR = {
  healthy: true,
  checks: [
    { id: "rea-mcp", label: "REA MCP server", status: "ok" as const, detail: "rea 6.8.0 · 229 tools" },
    { id: "llm", label: "Local model server", status: "ok" as const, detail: "loopback model available" },
  ],
  catalogSize: 229,
  serverVersion: "6.8.0",
};

type Handler = (params: Record<string, unknown>) => StubOptions;

function installFetch(handlers: Record<string, Handler> = {}): { calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const defaults: Record<string, Handler> = {
    "engine.ping": () => ({ body: { result: { ok: true, version: "0.1.0", pid: 42, connected: true, running: true } } }),
    "tools.list": () => ({ body: { result: CATALOG } }),
    "target.session": () => ({ body: { result: { session: null } } }),
    "engine.doctor": () => ({ body: { result: DOCTOR } }),
    "tools.describe": ({ name }) => ({
      body: {
        result: {
          tool: {
            name,
            description: "Summarise the open target.",
            inputSchema: { type: "object", properties: { detail: { type: "string", description: "Level of detail" } }, required: ["detail"] },
            annotations: { readOnlyHint: true },
          },
          inScope: true,
          family: "binary-core",
        },
      },
    }),
    "target.probe": ({ path }) => ({
      body: {
        result: {
          ok: true,
          session: {
            open: true,
            targetPath: String(path),
            format: "elf",
            architecture: "x86_64",
            sha256: "ab".repeat(32),
            packageVersion: "6.8.0",
          },
          overview: null,
          overviewError: "provider_unavailable",
        },
      },
    }),
    "target.close": () => ({ body: { result: { ok: true, session: null } } }),
    "agent.ask": () => ({ body: { result: { content: "Done.", reason: "final_answer", iterations: 1, toolCallsExecuted: 0, usage: null, transcriptLength: 3 } } }),
  };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/session")) return stubResponse({ body: BOOTSTRAP });
    if (url.startsWith("/api/events")) return stubResponse({ stream: true });
    if (url.startsWith("/api/rpc")) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { method: string; params?: Record<string, unknown> };
      const params = payload.params ?? {};
      calls.push({ method: payload.method, params });
      const handler = handlers[payload.method] ?? defaults[payload.method];
      if (!handler) return stubResponse({ status: 403, body: { error: `unexpected method ${payload.method}` } });
      return stubResponse(handler(params));
    }
    return stubResponse({ status: 404, body: { error: "unknown" } });
  });
  return { calls };
}

async function waitFor(label: string, query: () => boolean, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (!query()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  if (!container) throw new Error("test container missing");
  root = createRoot(container);
  await act(async () => {
    root?.render(<App />);
  });
}

const buttonWith = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(label)) as HTMLButtonElement | undefined;

describe("App", () => {
  it("boots the workspace, navigates the catalog, and lazily loads a tool schema", async () => {
    const { calls } = installFetch();
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1")?.textContent === "Analysis workspace");
    expect(document.querySelector(".target-header")).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining(["tools.list", "target.session", "engine.ping"]));

    await act(async () => buttonWith("Tool catalog")?.click());
    await waitFor("catalog rows", () => document.querySelectorAll(".tool-row").length === 2);
    await act(async () => (document.querySelectorAll(".tool-row")[0] as HTMLButtonElement).click());
    await waitFor("tool detail", () => document.querySelector(".tool-detail h2")?.textContent === "binary_overview");
    expect(calls.some((call) => call.method === "tools.describe" && call.params["name"] === "binary_overview")).toBe(true);
    expect(document.querySelector(".tool-detail")?.textContent).toContain("Level of detail");
    expect(document.querySelector(".detail-badges")?.textContent).toContain("In active scope");

    await act(async () => buttonWith("Diagnostics")?.click());
    await waitFor("diagnostics", () => document.querySelectorAll(".check-row").length === 2);
    expect(document.querySelector(".health-banner h2")?.textContent).toBe("All systems ready");
  });

  it("opens a target by path and reports an unavailable overview instead of showing an error as analysis", async () => {
    installFetch();
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);

    await act(async () => buttonWith("Open binary")?.click());
    await waitFor("dialog", () => document.querySelector("dialog[open]") !== null);
    const input = document.querySelector("#target-path") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "/usr/bin/ls");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (document.querySelector("dialog[open] button[type=submit]") as HTMLButtonElement).click());
    await waitFor("target header", () => document.querySelector(".target-heading h2")?.textContent === "ls");
    expect(document.querySelector(".target-heading p")?.textContent).toBe("/usr/bin/ls");
    expect(document.querySelector(".inspector")?.textContent).toContain("x86_64");

    await act(async () => buttonWith("Target overview")?.click());
    expect(document.querySelector(".overview-failure h3")?.textContent).toBe("Target opened, but no overview was available.");
    expect(document.querySelector(".overview-failure .code-panel")?.textContent).toContain("provider_unavailable");
    expect(document.querySelector(".overview-content .untrusted-note")).toBeNull();
  });

  it("disables the composer when the local model fails diagnostics", async () => {
    installFetch({
      "engine.doctor": () => ({
        body: {
          result: {
            healthy: false,
            checks: [
              { id: "rea-mcp", label: "REA MCP server", status: "ok", detail: "ok" },
              { id: "llm", label: "Local model server", status: "fail", detail: "ECONNREFUSED", remediation: "Start llama-server." },
            ],
          },
        },
      }),
    });
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Diagnostics")?.click());
    await waitFor("doctor", () => document.querySelectorAll(".check-row").length === 2);
    expect(document.querySelector(".health-banner h2")?.textContent).toBe("Your workspace, at a glance");
    expect(document.querySelector(".check-remediation")?.textContent).toContain("Start llama-server.");
    expect(document.querySelector(".nav-alert")).not.toBeNull();

    await act(async () => buttonWith("Workspace")?.click());
    await waitFor("composer", () => document.querySelector(".send-button") !== null);
    expect((document.querySelector(".send-button") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".composer-model-note")).toBeNull();
  });

  it("surfaces a boot failure with a retry control and reconnects on demand", async () => {
    let failSession = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/session")) {
        if (failSession) {
          failSession = false;
          return stubResponse({ status: 503, body: { error: "service unavailable" } });
        }
        return stubResponse({ body: BOOTSTRAP });
      }
      if (url.startsWith("/api/events")) return stubResponse({ stream: true });
      if (url.includes("/api/rpc")) return stubResponse({ status: 200, body: { result: { ok: true } } });
      return stubResponse({ status: 404, body: { error: "unknown" } });
    });

    await render();
    await waitFor("boot error", () => document.querySelector(".boot-screen .error-notice") !== null);
    expect(document.querySelector(".boot-screen")?.textContent).toContain("Could not connect to the local workspace service.");
    await act(async () => buttonWith("Retry connection")?.click());
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    expect(document.querySelector(".boot-screen")).toBeNull();
  });
});
