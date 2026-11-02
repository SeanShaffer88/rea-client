import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../dist/config.js";
import { EngineBridge } from "../dist/desktop/EngineBridge.js";
import { DesktopGateway } from "../dist/desktop/gateway.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ args: process.argv.slice(app.isPackaged ? 1 : 2), options: { config: { type: "string" } }, strict: false });
const configPath = resolve(typeof values.config === "string" ? values.config : "config.json");
let gateway: DesktopGateway | undefined;
let window: BrowserWindow | undefined;
let closing = false;

async function createWindow(): Promise<void> {
  const config = await loadConfig(configPath);
  const bridge = new EngineBridge({ cliPath: resolve(root, "dist/cli.js"), configPath, cwd: process.cwd() });
  gateway = new DesktopGateway({ bridge, config, configPath, staticDir: resolve(root, "dist-desktop"), port: 0, mode: "desktop" });
  await gateway.listen();
  window = new BrowserWindow({
    width: 1480, height: 960, minWidth: 960, minHeight: 680,
    title: "REA Workspace", backgroundColor: "#f7f8fa", show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(root, "dist-electron/preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!gateway || new URL(url).origin !== gateway.origin) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => { window = undefined; });
  await window.loadURL(gateway.origin);
}

ipcMain.handle("rea:choose-binary", async (event) => {
  const owner = window;
  const senderUrl = event.senderFrame?.url;
  if (!owner || event.sender !== owner.webContents || !gateway || senderUrl === undefined) throw new Error("Untrusted file dialog request.");
  let senderOrigin: string;
  try { senderOrigin = new URL(senderUrl).origin; }
  catch { throw new Error("Untrusted file dialog request."); }
  if (senderOrigin !== gateway.origin) throw new Error("Untrusted file dialog request.");
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
