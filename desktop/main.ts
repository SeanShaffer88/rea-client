import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../dist/config.js";
import { EngineBridge } from "../dist/desktop/EngineBridge.js";
import { DesktopGateway } from "../dist/desktop/gateway.js";
import { isAllowedNavigation, isTrustedRendererUrl, WINDOW_WEB_PREFERENCES } from "../dist/desktop/security.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ args: process.argv.slice(app.isPackaged ? 1 : 2), options: { config: { type: "string" } }, strict: false });
const configPath = resolve(typeof values.config === "string" ? values.config : "config.json");
let gateway: DesktopGateway | undefined;
let window: BrowserWindow | undefined;
let closing = false;

async function createWindow(): Promise<void> {
  const config = await loadConfig(configPath);
  const bridge = new EngineBridge({ cliPath: resolve(root, "dist/cli.js"), configPath, cwd: process.cwd(), maxLineBytes: 8 * 1024 * 1024 });
  const activeGateway = new DesktopGateway({ bridge, config, configPath, staticDir: resolve(root, "dist-desktop"), port: 0, mode: "desktop" });
  await activeGateway.listen();
  gateway = activeGateway;

  const activeWindow = new BrowserWindow({
    width: 1480, height: 960, minWidth: 960, minHeight: 680,
    title: "REA Workspace", backgroundColor: "#f7f8fa", show: false,
    autoHideMenuBar: true,
    webPreferences: { ...WINDOW_WEB_PREFERENCES, preload: resolve(root, "dist-electron/preload.cjs") },
  });
  window = activeWindow;

  activeWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  activeWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, activeGateway.origin)) event.preventDefault();
  });
  activeWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedNavigation(url, activeGateway.origin)) event.preventDefault();
  });
  activeWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  activeWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  activeWindow.webContents.session.setPermissionCheckHandler(() => false);
  // No devtools shortcut or context menu reaches the local workspace surface.
  activeWindow.webContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();
    const devtools = input.key === "F12" || (input.control && input.shift && (key === "i" || key === "j" || key === "c"));
    if (devtools) event.preventDefault();
  });
  activeWindow.once("ready-to-show", () => activeWindow.show());
  activeWindow.on("closed", () => {
    if (window === activeWindow) window = undefined;
    // Closing the window must stop the engine, not leave an orphaned child.
    if (!closing) void activeGateway.close().catch(() => undefined);
  });
  await activeWindow.loadURL(activeGateway.origin);
}

ipcMain.handle("rea:choose-binary", async (event) => {
  const owner = window;
  const senderUrl = event.senderFrame?.url;
  const trusted =
    owner !== undefined &&
    event.sender === owner.webContents &&
    gateway !== undefined &&
    isTrustedRendererUrl(senderUrl, gateway.origin);
  if (!owner || !trusted) throw new Error("Untrusted file dialog request.");
  const result = await dialog.showOpenDialog(owner, { title: "Open an analysis target", properties: ["openFile"], buttonLabel: "Open binary" });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  void app.whenReady().then(async () => {
    app.setName("REA Workspace");
    await createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  }).catch((error: unknown) => {
    dialog.showErrorBox("REA Workspace could not start", error instanceof Error ? error.message : String(error));
    app.quit();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (closing || !gateway) return;
    event.preventDefault();
    closing = true;
    void gateway.close().finally(() => app.quit());
  });
}
