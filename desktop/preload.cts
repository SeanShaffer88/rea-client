import electron = require("electron");

// No filesystem, process, arbitrary IPC, or Node APIs are exposed to React.
// This file compiles to CommonJS because sandboxed Electron preloads cannot be ESM.
const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("reaDesktop", {
  chooseBinary: (): Promise<string | null> => ipcRenderer.invoke("rea:choose-binary"),
});
