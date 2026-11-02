/**
 * Pure trust checks for the Electron shell.
 *
 * These live outside `desktop/main.ts` so they can be unit-tested without an
 * Electron runtime: the sandbox this project is developed in cannot launch a
 * window, but the navigation and IPC-origin rules are exactly the kind of
 * security logic that should never be verified only by reading it.
 */

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** True when `url` belongs to the loopback gateway this process started. */
export function isTrustedRendererUrl(url: string | undefined, expectedOrigin: string): boolean {
  if (url === undefined || url === "" || expectedOrigin === "") return false;
  const origin = originOf(url);
  return origin !== null && origin === originOf(expectedOrigin);
}

/** Same-origin navigation only: the renderer must never leave the local gateway. */
export function isAllowedNavigation(url: string, expectedOrigin: string): boolean {
  return isTrustedRendererUrl(url, expectedOrigin);
}

export const WINDOW_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  navigateOnDragDrop: false,
  spellcheck: false,
});
