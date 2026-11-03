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
  version: "0.3.0",
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

const EVIDENCE_ID = `ev_${"4e8c8fb7".repeat(8)}`;

const EVIDENCE_INVENTORY = {
  ok: true,
  totalRetained: 2,
  matching: 2,
  unknownRevisions: 0,
  records: [
    {
      evidenceId: EVIDENCE_ID,
      operation: "inspect_artifact",
      subjectName: "/usr/bin/ls",
      providerId: "rea-binary",
      confidence: "high",
      authority: "observed",
      retention: "session",
    },
    { evidenceId: `ev_${"1f".repeat(32)}`, operation: "xrefs", subjectName: "ntdll.dll" },
  ],
};

type Handler = (params: Record<string, unknown>) => StubOptions;

function installFetch(handlers: Record<string, Handler> = {}): { calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const defaults: Record<string, Handler> = {
    "engine.ping": () => ({ body: { result: { ok: true, version: "0.3.0", pid: 42, connected: true, running: true } } }),
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
    "agent.transcript": () => ({ body: { result: { messages: [] } } }),
    "evidence.list": () => ({ body: { result: EVIDENCE_INVENTORY } }),
    "evidence.get": ({ evidenceId }) => ({
      body: {
        result: {
          ok: true,
          evidenceId,
          text: JSON.stringify({ evidence_id: evidenceId, imports: ["puts"] }, null, 2),
          truncated: false,
          untrusted: true,
        },
      },
    }),
    "evidence.export": () => ({
      body: { result: { ok: true, path: "/tmp/workspace/evidence/bundle.json", bytes: 8117, records: 2, unknowns: 0 } },
    }),
    "case.list": () => ({ body: { result: { ok: true, casesRoot: "/tmp/workspace/cases", cases: [], total: 0 } } }),
    "case.delete": ({ name }) => ({ body: { result: { ok: true, name, directory: `/tmp/workspace/cases/${String(name)}` } } }),
    "case.open": ({ name }) => ({
      body: {
        result: {
          ok: true,
          name,
          directory: `/tmp/workspace/cases/${String(name)}`,
          savedAt: "2026-11-02T12:00:00.000Z",
          files: [
            { name: "analysis.json", bytes: 1200 },
            { name: "analysis.md", bytes: 900 },
            { name: "evidence-bundle.json", bytes: 8117 },
          ],
          summary: {
            schemaVersion: 1,
            exportedAt: "2026-11-02T12:00:00.000Z",
            engineVersion: "6.8.0",
            scope: "binary-core",
            target: { name: "ls", path: "/usr/bin/ls", format: "elf", architecture: "x86_64", sha256: "ab".repeat(32) },
            turns: 1,
            observations: 2,
            evidenceReferences: 1,
          },
          report: "# REA analysis report\n\nThe target is an ELF binary.\n\n## Turn 1",
          reportTruncated: false,
          reportJson: JSON.stringify({ schemaVersion: 1, turns: [] }),
          jsonTruncated: false,
          bundle: { path: `/tmp/workspace/cases/${String(name)}/evidence-bundle.json`, bytes: 8117, records: 2, unknowns: 0 },
        },
      },
    }),
    "case.save": () => ({
      body: {
        result: {
          ok: true,
          name: "case-2026-11-02T00-00-00-000Z",
          directory: "/tmp/workspace/cases/case-2026-11-02T00-00-00-000Z",
          files: [
            { name: "analysis.md", bytes: 900 },
            { name: "analysis.json", bytes: 1200 },
            { name: "evidence-bundle.json", bytes: 8117 },
          ],
          evidence: { ok: true, path: "/tmp/workspace/cases/case-2026-11-02T00-00-00-000Z/evidence-bundle.json", bytes: 8117, records: 2, unknowns: 0 },
        },
      },
    }),
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
  Object.defineProperty(window, "innerWidth", {value:1440,writable:true,configurable:true});
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

describe("Responsive Session Inspector", () => {
  it("starts beside the desktop conversation and leaves no grid item when closed", async () => {
    const { calls } = installFetch();
    await render();
    await waitFor("desktop inspector", () => document.querySelector("aside.inspector") !== null);
    await act(async () => (document.querySelector('[aria-label="Close Session Inspector"]') as HTMLButtonElement).click());
    expect(document.querySelector(".inspector")).toBeNull();
    expect(document.querySelector(".workspace-layout")?.children.length).toBe(1);
    await act(async () => (document.querySelector(".inspector-toggle") as HTMLButtonElement).click());
    expect(document.querySelector("aside.inspector")).not.toBeNull();
    expect(calls.some((call) => call.method === "agent.reset")).toBe(false);
  });

  it("traps compact drawer focus and restores the opener without losing the draft or scope", async () => {
    window.innerWidth = 700;
    const { calls } = installFetch({ "target.session": () => ({ body: { result: { session: { open: true, targetPath: "/usr/bin/ls", format: "elf", architecture: "x86_64" } } } }) });
    await render();
    await waitFor("target", () => document.querySelector(".target-header") !== null);
    expect(document.querySelector(".inspector")).toBeNull();
    const opener = document.querySelector(".inspector-toggle") as HTMLButtonElement;
    await act(async () => { opener.focus(); opener.click(); });
    const dialog = document.querySelector("dialog.inspector-dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Session Inspector");
    const scope = dialog.querySelector("select") as HTMLSelectElement;
    scope.focus();
    await act(async () => {
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "Keep this draft");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.activeElement).toBe(scope);
    expect(scope.value).toBe("binary-core");
    const buttons = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled])')];
    buttons.at(-1)?.focus();
    await act(async () => buttons.at(-1)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons.at(-1));
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector("dialog.inspector-dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(calls.some((call) => call.method === "agent.reset")).toBe(false);
  });
});

describe("App", () => {
  it("boots the workspace, navigates the catalog, and lazily loads a tool schema", async () => {
    const { calls } = installFetch();
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1")?.textContent === "Workspace");
    expect(document.querySelector(".target-header")).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining(["tools.list", "target.session", "engine.ping"]));

    await act(async () => buttonWith("Tool Catalog")?.click());
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

    await act(async () => buttonWith("Open Program")?.click());
    await waitFor("dialog", () => document.querySelector("dialog[open]") !== null);
    // Focus moves into the modal so keyboard users are not left behind it.
    expect(document.querySelector("dialog[open]")?.contains(document.activeElement)).toBe(true);
    expect(document.querySelector("dialog[open]")?.getAttribute("aria-modal")).toBe("true");
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

    await act(async () => buttonWith("Target Overview")?.click());
    expect(document.querySelector(".overview-failure h3")?.textContent).toBe("Target opened, but no overview was available.");
    expect(document.querySelector(".overview-failure .code-panel")?.textContent).toContain("provider_unavailable");
    expect(document.querySelector(".overview-content .untrusted-note")).toBeNull();
  });

  it("restores a conversation the engine already holds", async () => {
    installFetch({
      "agent.transcript": () => ({
        body: {
          result: {
            messages: [
              { role: "system", content: "You are REA." },
              { role: "user", content: "What is open?" },
              { role: "assistant", content: "Nothing yet." },
            ],
          },
        },
      }),
    });
    await render();
    await waitFor("restored messages", () => document.querySelectorAll(".chat-message").length === 2);
    expect(document.querySelector(".chat-message.message-user")?.textContent).toContain("What is open?");
    expect(document.querySelectorAll(".chat-message.message-assistant")[0]?.textContent).toContain("Nothing yet.");
    expect(document.querySelector(".toast")?.textContent).toContain("Previous conversation restored");
    expect(document.querySelector(".message-footer")).toBeNull();
  });

  it("exports a Markdown analysis report and a JSON companion", async () => {
    installFetch({
      "agent.transcript": () => ({
        body: {
          result: {
            messages: [
              { role: "user", content: "What is open?" },
              { role: "assistant", content: "An ELF binary." },
            ],
          },
        },
      }),
    });
    const blobs: Array<{ type: string; text: string }> = [];
    const names: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        blobs.push({ type: blob.type, text: "" });
        // Blob.text() is async; capture synchronously through the array index later.
        void blob.text().then((text) => { const entry = blobs[blobs.length - 1]; if (entry && entry.text === "") entry.text = text; });
        return `blob:${blobs.length}`;
      },
      revokeObjectURL: () => undefined,
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      names.push(this.download);
    });

    try {
      await render();
      await waitFor("restored conversation", () => document.querySelectorAll(".chat-message").length === 2);
      await act(async () => buttonWith("Evidence")?.click());
      await waitFor("evidence page", () => document.querySelector(".evidence-page") !== null);
      await act(async () => buttonWith("Export report")?.click());
      await act(async () => buttonWith("JSON")?.click());

      await waitFor("both exports", () => names.length === 2);
      expect(names[0]).toMatch(/^rea-analysis-\d{4}-\d{2}-\d{2}\.md$/);
      expect(names[1]).toMatch(/^rea-analysis-\d{4}-\d{2}-\d{2}\.json$/);
      await waitFor("markdown blob", () => blobs.some((blob) => blob.type.startsWith("text/markdown") && blob.text.includes("# REA analysis report")));
      await waitFor("json blob", () => blobs.some((blob) => blob.type === "application/json" && blob.text.includes("\"schemaVersion\"")));
      expect(document.querySelector(".toast")?.textContent).toContain("exported");
    } finally {
      click.mockRestore();
    }
  });

  it("lists retained evidence, opens one record, and exports the bundle", async () => {
    const { calls } = installFetch();
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());

    await waitFor("retained rows", () => document.querySelectorAll(".retained-row").length === 2);
    expect(calls.some((call) => call.method === "evidence.list")).toBe(true);
    expect(document.querySelector(".retained-heading")?.textContent).toContain("2 retained records · 0 unknown revisions");
    expect(document.querySelectorAll(".retained-row")[1]?.textContent).toContain("xrefs");

    await act(async () => (document.querySelectorAll(".retained-row")[0] as HTMLButtonElement).click());
    await waitFor("retained record", () => document.querySelector(".retained-record .code-panel") !== null);
    expect(calls.at(-1)).toEqual({ method: "evidence.get", params: { evidenceId: EVIDENCE_ID } });
    expect(document.querySelector(".retained-record")?.textContent).toContain("puts");

    await act(async () => (document.querySelectorAll(".retained-row")[0] as HTMLButtonElement).click());
    expect(document.querySelector(".retained-record")).toBeNull();

    await act(async () => buttonWith("Export bundle")?.click());
    await waitFor("export toast", () => (document.querySelector(".toast")?.textContent ?? "").includes("Evidence bundle exported"));
    expect(calls.at(-1)).toEqual({ method: "evidence.export", params: {} });
    expect(document.querySelector(".toast")?.textContent).toContain("2 records · 0 unknowns");
  });

  it("saves the analysis as a case folder and lists what is already saved", async () => {
    const saved = {
      name: "ls-triage",
      directory: "/tmp/workspace/cases/ls-triage",
      savedAt: "2026-11-02T12:00:00.000Z",
      files: [
        { name: "analysis.json", bytes: 1200 },
        { name: "analysis.md", bytes: 900 },
        { name: "evidence-bundle.json", bytes: 8117 },
      ],
    };
    let listed = false;
    const { calls } = installFetch({
      "case.list": () => {
        if (listed) return { body: { result: { ok: true, casesRoot: "/tmp/workspace/cases", cases: [saved], total: 1 } } };
        listed = true;
        return { body: { result: { ok: true, casesRoot: "/tmp/workspace/cases", cases: [], total: 0 } } };
      },
    });
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());
    await waitFor("cases panel", () => document.querySelector(".cases-panel") !== null);
    await waitFor("empty cases", () => document.querySelector(".cases-panel .empty-state") !== null);

    const save = [...document.querySelectorAll(".cases-panel button")].find((button) => button.textContent?.includes("Save current analysis")) as HTMLButtonElement;
    await act(async () => save.click());
    await waitFor("save dialog", () => document.querySelector("#case-name") !== null);
    // The dialog offers a name derived from the target and the date.
    const name = document.querySelector("#case-name") as HTMLInputElement;
    expect(name.value).toMatch(/^case-\d{4}-\d{2}-\d{2}$/);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(name, "ls-triage");
      name.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => (document.querySelector(".modal button[type=\"submit\"]") as HTMLButtonElement).click());
    await waitFor("save toast", () => (document.querySelector(".toast")?.textContent ?? "").includes("Case saved"));
    const request = calls.filter((call) => call.method === "case.save").at(-1);
    expect(request?.params["name"]).toBe("ls-triage");
    expect(request?.params["includeEvidence"]).toBe(true);
    expect(document.querySelector("#case-name")).toBeNull();
    expect(String(request?.params["report"])).toContain("# REA analysis report");
    expect(JSON.parse(String(request?.params["reportJson"]))).toMatchObject({ schemaVersion: 1 });
    expect(document.querySelector(".toast")?.textContent).toContain("canonical bundle included");

    await waitFor("saved case row", () => document.querySelectorAll(".case-row").length === 1);
    expect(document.querySelector(".case-row")?.textContent).toContain("ls-triage");
    expect(document.querySelector(".case-row")?.textContent).toContain("cases/ls-triage");
    expect(document.querySelector(".cases-panel .retained-heading p")?.textContent).toContain("1 case");
  });

  it("explains an unusable case name instead of sending it", async () => {
    const { calls } = installFetch();
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());
    await waitFor("cases panel", () => document.querySelector(".cases-panel") !== null);
    await act(async () => ([...document.querySelectorAll(".cases-panel button")].find((button) => button.textContent?.includes("Save current analysis")) as HTMLButtonElement | undefined)?.click());
    await waitFor("save dialog", () => document.querySelector("#case-name") !== null);

    const name = document.querySelector("#case-name") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(name, "../escape");
      name.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => (document.querySelector(".modal button[type=\"submit\"]") as HTMLButtonElement).click());

    await waitFor("name error", () => document.querySelector(".field-error") !== null);
    expect(document.querySelector(".field-error")?.textContent).toContain("Start with a letter or digit");
    expect(document.querySelector("#case-name")?.getAttribute("aria-invalid")).toBe("true");
    expect(calls.some((call) => call.method === "case.save")).toBe(false);
  });

  it("opens a saved case and shows what the folder actually contains", async () => {
    const saved = {
      name: "ls-triage",
      directory: "/tmp/workspace/cases/ls-triage",
      savedAt: "2026-11-02T12:00:00.000Z",
      files: [{ name: "analysis.json", bytes: 1200 }, { name: "analysis.md", bytes: 900 }],
      summary: {
        schemaVersion: 1,
        scope: "binary-core",
        target: { name: "ls", format: "elf", architecture: "x86_64" },
        turns: 1,
        observations: 2,
        evidenceReferences: 1,
      },
    };
    const { calls } = installFetch({
      "case.list": () => ({ body: { result: { ok: true, casesRoot: "/tmp/workspace/cases", cases: [saved], total: 1 } } }),
    });
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());
    await waitFor("case row", () => document.querySelectorAll(".case-row").length === 1);
    // The list says what the case is about, not just its folder name.
    expect(document.querySelector(".case-row")?.textContent).toContain("ls · elf · x86_64");

    await act(async () => (document.querySelector(".case-row") as HTMLButtonElement).click());
    await waitFor("case viewer", () => document.querySelector(".case-summary") !== null);
    expect(calls.at(-1)).toEqual({ method: "case.open", params: { name: "ls-triage" } });
    const summary = document.querySelector(".case-summary")?.textContent ?? "";
    expect(summary).toContain("ls · elf · x86_64");
    expect(summary).toContain("1 turn · 2 observations · 1 evidence reference");
    expect(summary).toContain("2 records · 0 unknowns");
    expect(document.querySelector(".case-doc")?.textContent).toContain("The target is an ELF binary.");

    // The JSON companion is one tab away.
    await act(async () => (document.querySelectorAll(".case-doc-tabs button")[1] as HTMLButtonElement).click());
    await waitFor("json tab", () => document.querySelector(".case-doc .code-panel") !== null);
    expect(document.querySelector(".case-doc")?.textContent).toContain("\"schemaVersion\"");
  });

  it("explains a case that cannot be read instead of showing an empty report", async () => {
    const saved = {
      name: "broken",
      directory: "/tmp/workspace/cases/broken",
      savedAt: "2026-11-02T12:00:00.000Z",
      files: [{ name: "analysis.json", bytes: 12 }],
    };
    installFetch({
      "case.list": () => ({ body: { result: { ok: true, casesRoot: "/tmp/workspace/cases", cases: [saved], total: 1 } } }),
      "case.open": ({ name }) => ({
        body: {
          result: {
            ok: false,
            name,
            files: [{ name: "analysis.json", bytes: 12 }],
            error: "analysis.json is not valid JSON, so this case cannot be read.",
          },
        },
      }),
    });
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());
    await waitFor("case row", () => document.querySelectorAll(".case-row").length === 1);
    expect(document.querySelector(".case-row")?.textContent).toContain("Summary unavailable");

    await act(async () => (document.querySelector(".case-row") as HTMLButtonElement).click());
    await waitFor("case error", () => document.querySelector(".modal .error-notice") !== null);
    expect(document.querySelector(".modal .error-notice")?.textContent).toContain("not valid JSON");
    expect(document.querySelector(".modal .error-notice")?.textContent).toContain("analysis.json");
    expect(document.querySelector(".modal .case-doc")).toBeNull();
  });

  it("deletes a case only after an explicit confirmation", async () => {
    let listed = 0;
    const { calls } = installFetch({
      "case.list": () => {
        listed += 1;
        const entries = listed === 1
          ? [{ name: "ls-triage", directory: "/tmp/workspace/cases/ls-triage", savedAt: "2026-11-02T12:00:00.000Z", files: [{ name: "analysis.md", bytes: 10 }] }]
          : [];
        return { body: { result: { ok: true, casesRoot: "/tmp/workspace/cases", cases: entries, total: entries.length } } };
      },
    });
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());
    await waitFor("case row", () => document.querySelectorAll(".case-row").length === 1);

    await act(async () => (document.querySelector(".case-row") as HTMLButtonElement).click());
    await waitFor("case viewer", () => document.querySelector(".case-summary") !== null);
    await act(async () => buttonWith("Delete case")?.click());

    await waitFor("delete confirmation", () => document.querySelector(".case-warning") !== null);
    // Nothing is deleted until the confirmation is accepted.
    expect(document.querySelector(".case-warning")?.textContent).toContain("workspace/cases/ls-triage");
    expect(document.querySelector(".case-warning")?.textContent).toContain("cannot be undone");
    expect(calls.some((call) => call.method === "case.delete")).toBe(false);

    await act(async () => buttonWith("Delete folder")?.click());
    await waitFor("delete toast", () => (document.querySelector(".toast")?.textContent ?? "").includes("deleted from the workspace"));
    expect(calls.at(-2)).toEqual({ method: "case.delete", params: { name: "ls-triage" } });
    // The viewer closes and the list is reloaded from the service.
    await waitFor("viewer closed", () => document.querySelector(".case-summary") === null);
    await waitFor("case list refreshed", () => document.querySelectorAll(".case-row").length === 0);
    expect(document.querySelector(".cases-panel .empty-state")).not.toBeNull();
  });

  it("keeps a case when the confirmation is declined, and reports a failed delete", async () => {
    installFetch({
      "case.list": () => ({ body: { result: { ok: true, casesRoot: "/tmp/workspace/cases", cases: [{ name: "kept", directory: "/tmp/workspace/cases/kept", savedAt: "2026-11-02T12:00:00.000Z", files: [] }], total: 1 } } }),
      "case.delete": ({ name }) => ({ body: { result: { ok: false, name, error: "EBUSY: the folder is in use" } } }),
    });
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());
    await waitFor("case row", () => document.querySelectorAll(".case-row").length === 1);
    await act(async () => (document.querySelector(".case-row") as HTMLButtonElement).click());
    await waitFor("case viewer", () => document.querySelector(".case-summary") !== null);

    await act(async () => buttonWith("Delete case")?.click());
    await waitFor("delete confirmation", () => document.querySelector(".case-warning") !== null);
    await act(async () => buttonWith("Keep the case")?.click());
    expect(document.querySelector(".case-warning")).toBeNull();
    expect(document.querySelector(".case-summary")).not.toBeNull();

    await act(async () => buttonWith("Delete case")?.click());
    await act(async () => buttonWith("Delete folder")?.click());
    await waitFor("delete error", () => document.querySelector(".modal .error-notice") !== null);
    expect(document.querySelector(".modal .error-notice")?.textContent).toContain("EBUSY");
    // The viewer stays open so the user can see what happened.
    expect(document.querySelector(".case-summary")).not.toBeNull();
  });

  it("filters saved cases by target and reopens the recorded target", async () => {
    const caseFor = (name: string, targetName: string, format: string) => ({
      name,
      directory: `/tmp/workspace/cases/${name}`,
      savedAt: "2026-11-02T12:00:00.000Z",
      files: [{ name: "analysis.md", bytes: 10 }],
      summary: {
        schemaVersion: 1,
        scope: "binary-core",
        target: { name: targetName, path: `/usr/bin/${targetName}`, format },
        turns: 1,
        observations: 1,
        evidenceReferences: 0,
      },
    });
    const saved = [caseFor("ls-case", "ls", "elf"), caseFor("app-case", "app.exe", "pe")];
    const { calls } = installFetch({
      "case.list": () => ({ body: { result: { ok: true, casesRoot: "/tmp/workspace/cases", cases: saved, total: saved.length } } }),
      "case.open": ({ name }) => {
        const entry = saved.find((candidate) => candidate.name === name);
        return { body: { result: { ok: true, ...entry, report: "# saved", reportJson: "{}" } } };
      },
    });
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());
    await waitFor("case rows", () => document.querySelectorAll(".case-row").length === 2);

    const search = document.querySelector('input[aria-label="Search saved cases"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "app.exe");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await waitFor("filtered case rows", () => document.querySelectorAll(".case-row").length === 1);
    expect(document.querySelector(".case-row")?.textContent).toContain("app-case");

    await act(async () => (document.querySelector(".case-row") as HTMLButtonElement).click());
    await waitFor("case viewer", () => document.querySelector(".case-summary") !== null);
    await act(async () => buttonWith("Reopen target")?.click());
    await waitFor("target probe", () => calls.some((call) => call.method === "target.probe"));
    expect(calls.filter((call) => call.method === "target.probe").at(-1)?.params).toEqual({ path: "/usr/bin/app.exe" });
  });

  it("offers to overwrite a case whose folder name is taken", async () => {
    installFetch({
      "case.save": ({ overwrite }) =>
        overwrite === true
          ? {
            body: {
              result: {
                ok: true,
                name: "ls-triage",
                directory: "/tmp/workspace/cases/ls-triage",
                files: [{ name: "analysis.md", bytes: 10 }, { name: "analysis.json", bytes: 12 }],
                evidence: { ok: false, error: "REA is not connected" },
              },
            },
          }
          : {
            body: {
              result: {
                ok: false,
                name: "ls-triage",
                directory: "/tmp/workspace/cases/ls-triage",
                files: [],
                error: 'A case named "ls-triage" already exists. Choose another name or allow overwrite.',
              },
            },
          },
    });
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());
    await waitFor("cases panel", () => document.querySelector(".cases-panel") !== null);

    const save = [...document.querySelectorAll(".cases-panel button")].find((button) => button.textContent?.includes("Save current analysis")) as HTMLButtonElement;
    await act(async () => save.click());
    await waitFor("save dialog", () => document.querySelector("#case-name") !== null);
    const name = document.querySelector("#case-name") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(name, "ls-triage");
      name.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => (document.querySelector(".modal button[type=\"submit\"]") as HTMLButtonElement).click());
    await waitFor("case conflict", () => buttonWith("Overwrite it") !== undefined);
    expect(document.querySelector(".modal .error-notice")?.textContent ?? "").toContain("already exists");

    await act(async () => buttonWith("Overwrite it")?.click());
    await waitFor("overwrite toast", () => (document.querySelector(".toast")?.textContent ?? "").includes("Case saved"));
    // A missing bundle is reported next to the saved report, not hidden.
    expect(document.querySelector(".cases-panel .error-notice, .error-notice")?.textContent).toContain("could not write the evidence bundle");
  });

  it("filters retained records and offers an overwrite when the bundle exists", async () => {
    installFetch({
      "evidence.export": ({ overwrite }) =>
        overwrite === true
          ? { body: { result: { ok: true, path: "/tmp/workspace/evidence/bundle.json", bytes: 8117, records: 2, unknowns: 0 } } }
          : { body: { result: { ok: false, error: "EEXIST: file already exists, open '/tmp/workspace/evidence/bundle.json'" } } },
    });
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);
    await act(async () => buttonWith("Evidence")?.click());
    await waitFor("retained rows", () => document.querySelectorAll(".retained-row").length === 2);

    const search = document.querySelector('input[aria-label="Search evidence"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "xrefs");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await waitFor("filtered rows", () => document.querySelectorAll(".retained-row").length === 1);

    await act(async () => buttonWith("Export bundle")?.click());
    await waitFor("conflict", () => buttonWith("Overwrite the existing bundle") !== undefined);
    expect(document.querySelector(".error-notice")?.textContent).toContain("already exists");

    await act(async () => buttonWith("Overwrite the existing bundle")?.click());
    await waitFor("overwrite toast", () => (document.querySelector(".toast")?.textContent ?? "").includes("Evidence bundle exported"));
  });

  it("shows a drop target while files hover and explains a rejected drop", async () => {
    installFetch();
    await render();
    await waitFor("workspace", () => document.querySelector(".page-heading h1") !== null);

    const dragOver = new window.Event("dragover", { bubbles: true, cancelable: true }) as Event & { dataTransfer?: { types: string[] } };
    dragOver.dataTransfer = { types: ["Files"] };
    await act(async () => {
      window.dispatchEvent(dragOver);
    });
    expect(dragOver.defaultPrevented).toBe(true);
    expect(document.querySelector(".drop-overlay")).not.toBeNull();
    expect(document.querySelector(".drop-overlay")?.textContent).toContain("Drop to upload to this workspace");

    const drop = new window.Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer?: { types: string[]; files: unknown[] } };
    drop.dataTransfer = { types: ["Files"], files: [] };
    await act(async () => {
      window.dispatchEvent(drop);
    });
    expect(document.querySelector(".drop-overlay")).toBeNull();

    // A single empty file is reported, not opened or uploaded.
    const emptyDrop = new window.Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer?: { types: string[]; files: unknown[] } };
    emptyDrop.dataTransfer = { types: ["Files"], files: [new File([], "empty.bin")] };
    await act(async () => {
      window.dispatchEvent(emptyDrop);
    });
    expect(document.querySelector(".error-notice")?.textContent).toContain("empty");
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
