import type { Bootstrap, DesktopEvent } from "../../src/desktop/protocol";

declare global {
  interface Window {
    reaDesktop?: { chooseBinary: () => Promise<string | null> };
  }
}

let token = "";
let refreshInFlight: Promise<Bootstrap> | null = null;

export class WorkspaceApiError extends Error {
  public override readonly name = "WorkspaceApiError";
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function readJson<T>(response: Response): Promise<T | undefined> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function failure(body: { error?: string } | undefined, status: number): WorkspaceApiError {
  return new WorkspaceApiError(body?.error ?? `The local workspace service returned HTTP ${status}.`, status);
}

async function requestSession(): Promise<Bootstrap> {
  const response = await fetch(`/api/session${window.location.search}`);
  if (response.status === 401) {
    throw new WorkspaceApiError(
      "This preview requires an access token. Append ?access_token=… to the preview URL.",
      401,
    );
  }
  if (!response.ok) throw new WorkspaceApiError("Could not connect to the local workspace service.", response.status);
  const result = await readJson<Bootstrap>(response);
  if (!result || typeof result.token !== "string" || result.token === "") {
    throw new WorkspaceApiError("The local workspace service returned an invalid session.", response.status);
  }
  return result;
}

/** Re-bootstraps after the gateway restarts with a new token. Deduplicated across concurrent calls. */
async function refreshSession(): Promise<void> {
  refreshInFlight ??= requestSession()
    .then((result) => {
      token = result.token;
      return result;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  await refreshInFlight;
}

export async function bootstrap(): Promise<Bootstrap> {
  const result = await requestSession();
  token = result.token;
  if (new URLSearchParams(window.location.search).has("access_token")) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  return result;
}

export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-REA-Token": token },
      body: JSON.stringify({ method, params }),
    });
    const body = await readJson<{ result?: T; error?: string }>(response);
    if (response.status === 401 && attempt === 0) {
      await refreshSession();
      continue;
    }
    if (!response.ok || body?.error) throw failure(body, response.status);
    if (body === undefined) throw new WorkspaceApiError("The local workspace service returned an empty response.", response.status);
    return body.result as T;
  }
}

export async function uploadBinary(file: File): Promise<{ path: string; name: string; size: number }> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-REA-Token": token },
      body: file,
    });
    const body = await readJson<{ error?: string; path?: string; name?: string; size?: number }>(response);
    if (response.status === 401 && attempt === 0) {
      await refreshSession();
      continue;
    }
    if (!response.ok || body?.error) throw failure(body, response.status);
    if (body === undefined || typeof body.path !== "string" || typeof body.name !== "string" || typeof body.size !== "number") {
      throw new WorkspaceApiError("The upload response was incomplete.", response.status);
    }
    return { path: body.path, name: body.name, size: body.size };
  }
}

export async function subscribeEvents(
  signal: AbortSignal,
  onEvent: (event: DesktopEvent) => void,
  onStatus: (connected: boolean) => void,
): Promise<void> {
  let lastId = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch("/api/events", {
        headers: { "X-REA-Token": token, "Last-Event-ID": String(lastId) },
        signal,
      });
      if (response.status === 401 && !signal.aborted) {
        await refreshSession();
        continue;
      }
      if (!response.ok || !response.body) throw new Error("Event stream unavailable.");
      onStatus(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              const event = JSON.parse(line.slice(6)) as DesktopEvent;
              if (event.id > lastId) {
                lastId = event.id;
                onEvent(event);
              }
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    onStatus(false);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 2000);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`rea:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(`rea:${key}`, JSON.stringify(value));
  } catch {
    /* Storage may be disabled by desktop policy. */
  }
}
