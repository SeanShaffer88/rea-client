import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { appDataLayout, firstRunConfig, loadConfig, unpackedPath } from "../dist/config.js";
import { EngineBridge } from "../dist/desktop/EngineBridge.js";
import { DesktopGateway } from "../dist/desktop/gateway.js";
import { isAllowedNavigation, isTrustedRendererUrl, WINDOW_WEB_PREFERENCES } from "../dist/desktop/security.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ args: process.argv.slice(app.isPackaged ? 1 : 2), options: { config: { type: "string" } }, strict: false });

// An installed build has no useful working directory -- Explorer can start it
// from anywhere -- and its own folder may be read-only, so config and workspace
// live under the user's application data unless --config says otherwise.
const userDataDir = app.getPath("userData");
const layout = appDataLayout(userDataDir);
const configPath = resolve(typeof values.config === "string" ? values.config : layout.configPath);
const workingDir = dirname(configPath);
let gateway: DesktopGateway | undefined;
let window: BrowserWindow | undefined;
let closing = false;

/**
 * Writes a starting config on first launch, and leaves an existing one alone.
 *
 * The app is not a wizard: the file is ordinary JSON the user can edit, and the
 * Settings page shows what is in it. What matters is that a fresh install has a
 * config naming a writable workspace before the engine is spawned, otherwise
 * saved cases would land wherever the shortcut happened to point.
 */
async function ensureConfig(): Promise<void> {
  if (existsSync(configPath)) return;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, firstRunConfig(layout.workspaceDir), { mode: 0o600 });
}

async function createWindow(): Promise<void> {
  await ensureConfig();
  const config = await loadConfig(configPath);
  await mkdir(resolve(workingDir, config.workspaceDir), { recursive: true });
  // The bridge spawns this script with ELECTRON_RUN_AS_NODE, i.e. plain Node,
  // which cannot read a path inside app.asar; electron-builder unpacks dist/.
  const cliPath = unpackedPath(resolve(root, "dist/cli.js"));
  const bridge = new EngineBridge({ cliPath, configPath, cwd: workingDir, maxLineBytes: 8 * 1024 * 1024 });
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

/**
 * The only menu entries the app needs are the ones that reveal files the user
 * is expected to read or edit. Everything else is in the workspace UI, so the
 * menu stays small rather than duplicating it with accelerators nobody learns.
 */
function buildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        {
          label: "Open configuration file",
          click: () => {
            void ensureConfig().then(() => shell.openPath(configPath));
          },
        },
        { label: "Show workspace folder", click: () => { void shell.openPath(resolve(workingDir, "workspace")); } },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "REA project (morluto/rea)",
          click: () => { void shell.openExternal("https://github.com/morluto/rea"); },
        },
        {
          label: "Configuration folder",
          click: () => { void shell.openPath(workingDir); },
        },
      ],
    },
  ]));
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

// A second copy of the app would spawn a second engine against the same
// workspace, so the lock is taken before any window exists.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  // Windows groups taskbar buttons by AppUserModelID; without it an installed
  // build looks like an unnamed Electron app.
  app.setAppUserModelId("io.github.morluto.rea-workspace");
  app.on("second-instance", () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  void app.whenReady().then(async () => {
    app.setName("REA Workspace");
    buildMenu();
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
