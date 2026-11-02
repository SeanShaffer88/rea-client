// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, rpc, uploadBinary, WorkspaceApiError } from "../../desktop/ui/api.js";

function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    body: null,
  } as unknown as Response;
}

const SESSION = { token: "first-token", mode: "browser", version: "0.1.0", platform: "linux", config: { toolScope: "binary-core" } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace API client", () => {
  it("stores the session token and strips the preview access token from the address bar", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return respond(200, SESSION);
    });
    window.history.replaceState({}, "", "/?access_token=secret");

    const result = await bootstrap();
    expect(result.token).toBe("first-token");
    expect(seen[0]).toBe("/api/session?access_token=secret");
    expect(window.location.search).toBe("");
  });

  it("explains a protected preview instead of a generic connection error", async () => {
    vi.stubGlobal("fetch", async () => respond(401, { error: "This preview requires an access token." }));
    await expect(bootstrap()).rejects.toThrow(/access token/);
  });

  it("re-bootstraps once and retries after the gateway rotates its token", async () => {
    const headers: Array<string | null> = [];
    let sessions = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/session")) {
        sessions += 1;
        return respond(200, { ...SESSION, token: `token-${sessions}` });
      }
      const token = new Headers(init?.headers).get("X-REA-Token");
      headers.push(token);
      if (token === "token-1") return respond(401, { error: "Missing or invalid workspace session token." });
      return respond(200, { result: { ok: true } });
    });

    await bootstrap();
    await expect(rpc("engine.ping")).resolves.toEqual({ ok: true });
    expect(headers).toEqual(["token-1", "token-2"]);
    expect(sessions).toBe(2);
  });

  it("surfaces bridge errors with their HTTP status", async () => {
    vi.stubGlobal("fetch", async () => respond(502, { error: "The REA engine exited unexpectedly." }));
    await expect(rpc("engine.ping")).rejects.toBeInstanceOf(WorkspaceApiError);
    await expect(rpc("engine.ping")).rejects.toThrow("The REA engine exited unexpectedly.");
  });

  it("rejects malformed upload responses and passes the reported path through", async () => {
    vi.stubGlobal("fetch", async () => respond(200, { path: "/workspace/uploads/abc.elf", name: "ls", size: 5 }));
    const file = new File(["hello"], "ls");
    await expect(uploadBinary(file)).resolves.toEqual({ path: "/workspace/uploads/abc.elf", name: "ls", size: 5 });

    vi.stubGlobal("fetch", async () => respond(200, { unexpected: true }));
    await expect(uploadBinary(file)).rejects.toThrow(/incomplete/);

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("object.stream is not a function");
    });
    await expect(uploadBinary(file)).rejects.toThrow(/could not be uploaded.*open it by path/i);
  });
});
