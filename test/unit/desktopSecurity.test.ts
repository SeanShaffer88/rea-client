import { describe, expect, it } from "vitest";
import {
  isAllowedNavigation,
  isTrustedRendererUrl,
  WINDOW_WEB_PREFERENCES,
} from "../../src/desktop/security.js";

const ORIGIN = "http://127.0.0.1:49321";

describe("Electron trust rules", () => {
  it("accepts only the loopback gateway origin", () => {
    expect(isTrustedRendererUrl(`${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isTrustedRendererUrl(`${ORIGIN}/assets/app.js`, ORIGIN)).toBe(true);

    for (const url of [
      "http://127.0.0.1:49322/",
      "http://localhost:49321/",
      "https://127.0.0.1:49321/",
      "https://evil.example/?http://127.0.0.1:49321",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "about:blank",
      "data:text/html,<script>alert(1)</script>",
      "",
      "not a url",
      undefined,
    ]) {
      expect(isTrustedRendererUrl(url, ORIGIN)).toBe(false);
    }
  });

  it("refuses navigation when the expected origin is unknown", () => {
    expect(isAllowedNavigation(`${ORIGIN}/`, "")).toBe(false);
    expect(isAllowedNavigation("http://127.0.0.1:1/", ORIGIN)).toBe(false);
    expect(isAllowedNavigation(`${ORIGIN}/workspace`, ORIGIN)).toBe(true);
  });

  it("keeps renderer privileges off", () => {
    expect(WINDOW_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
      navigateOnDragDrop: false,
    });
    expect(Object.isFrozen(WINDOW_WEB_PREFERENCES)).toBe(true);
  });
});
