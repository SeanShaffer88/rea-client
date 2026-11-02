import electron = require("electron");

// No filesystem, process, arbitrary IPC, or Node APIs are exposed to React.
// This file compiles to CommonJS because sandboxed Electron preloads cannot be ESM.
const { contextBridge, ipcRenderer, webUtils } = electron;

contextBridge.exposeInMainWorld("reaDesktop", {
  chooseBinary: (): Promise<string | null> => ipcRenderer.invoke("rea:choose-binary"),
  // Resolves a dropped File to its real path so the desktop app can open it in
  // place instead of uploading a copy. Returns "" when the platform cannot tell.
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});
