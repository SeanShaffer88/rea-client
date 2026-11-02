#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { EngineBridge } from "./EngineBridge.js";
import { DesktopGateway } from "./gateway.js";

const { values } = parseArgs({ options: {
  config: { type: "string" }, port: { type: "string", default: "5173" },
  host: { type: "string", default: "127.0.0.1" }, preview: { type: "boolean", default: false },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535.");
if (values.host !== "127.0.0.1" && values.host !== "0.0.0.0") throw new Error("--host must be 127.0.0.1 or 0.0.0.0 (preview containers only).");
if (values.host === "0.0.0.0" && !values.preview) throw new Error("Binding all interfaces requires explicit --preview.");
const configPath = resolve(values.config ?? "config.json");
const config = await loadConfig(configPath);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const previewHost = values.preview && process.env.E2B_SANDBOX_ID ? `${port}-${process.env.E2B_SANDBOX_ID}.e2b.app` : undefined;
const previewAccessToken = process.env.REA_PREVIEW_TOKEN?.trim() || undefined;
const bridge = new EngineBridge({ cliPath: resolve(root, "dist/cli.js"), configPath, cwd: process.cwd() });
const gateway = new DesktopGateway({ bridge, config, configPath, staticDir: resolve(root, "dist-desktop"), host: values.host, port, mode: "browser", ...(previewHost ? { previewHost } : {}), ...(previewAccessToken ? { previewAccessToken } : {}) });
await gateway.listen();
const previewUrl = previewHost === undefined ? undefined : `https://${previewHost}/${previewAccessToken === undefined ? "" : `?access_token=${encodeURIComponent(previewAccessToken)}`}`;
console.log(`REA Workspace listening at ${gateway.origin}${previewUrl ? ` (preview: ${previewUrl})` : ""}`);
if (values.host === "0.0.0.0" && previewAccessToken === undefined) {
  console.warn("WARNING: preview mode is reachable from other interfaces without an access token. Set REA_PREVIEW_TOKEN when the URL can be shared.");
}
console.log("The analysis engine stays local. This HTTP adapter is a development/browser preview, not a public service.");
let closing = false;
const close = async (): Promise<void> => { if (closing) return; closing = true; await gateway.close(); process.exit(0); };
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
