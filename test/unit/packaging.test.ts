/**
 * Packaging invariants.
 *
 * An installed app runs from three places at once -- inside `app.asar`, next to
 * it in `app.asar.unpacked`, and under the user's application data -- and a
 * mistake in any of them only shows up after someone installs the build and
 * nothing starts. So the rules the packaging depends on are asserted here:
 * paths that a child process must execute are mapped out of the archive, and
 * `electron-builder.yml` keeps unpacking the directories a child process runs.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { appDataLayout, firstRunConfig, parseConfig, unpackedPath } from "../../src/config.js";

describe("unpackedPath", () => {
  it("moves a packed path to its unpacked sibling on posix and windows", () => {
    expect(unpackedPath("/opt/REA Workspace/resources/app.asar/dist/cli.js")).toBe(
      "/opt/REA Workspace/resources/app.asar.unpacked/dist/cli.js",
    );
    expect(unpackedPath("C:\\Program Files\\REA Workspace\\resources\\app.asar\\dist\\cli.js")).toBe(
      "C:\\Program Files\\REA Workspace\\resources\\app.asar.unpacked\\dist\\cli.js",
    );
  });

  it("leaves unpackaged paths and already-unpacked paths alone", () => {
    expect(unpackedPath("/home/dev/rea-client/dist/cli.js")).toBe("/home/dev/rea-client/dist/cli.js");
    expect(unpackedPath("/opt/app/resources/app.asar.unpacked/dist/cli.js")).toBe(
      "/opt/app/resources/app.asar.unpacked/dist/cli.js",
    );
    // A directory that merely contains "app.asar" in its name is not an archive.
    expect(unpackedPath("/opt/my-app.asar-backup/dist/cli.js")).toBe("/opt/my-app.asar-backup/dist/cli.js");
  });
});

describe("installed-app layout", () => {
  it("keeps config and workspace under application data, not the install directory", () => {
    const layout = appDataLayout(join("/home/user/.config", "REA Workspace"));
    expect(layout.configPath).toBe(join("/home/user/.config", "REA Workspace", "config.json"));
    expect(layout.workspaceDir).toBe(join("/home/user/.config", "REA Workspace", "workspace"));
  });

  it("writes a first-run config that parses and names a writable workspace", () => {
    const layout = appDataLayout(join("/tmp", "REA Workspace"));
    const text = firstRunConfig(layout.workspaceDir);
    const parsed = parseConfig(JSON.parse(text));

    expect(parsed.workspaceDir).toBe(layout.workspaceDir);
    // The bundled REA server is resolved at runtime against the installation,
    // so no build-machine path may be frozen into the seeded config.
    expect(text).not.toContain("rea.mjs");
    expect(parsed.rea.args[0]).toMatch(/rea\.mjs$/);
    expect(parsed.policy.allowNonLoopback).toBe(false);
  });
});

describe("electron-builder configuration", () => {
  it("unpacks everything a child process has to execute", async () => {
    const config = parseYaml(await readFile("electron-builder.yml", "utf8")) as {
      appId?: string;
      extraMetadata?: { main?: string };
      files?: string[];
      asarUnpack?: string[];
      npmRebuild?: boolean;
      win?: { target?: { target?: string; arch?: string[] }[] };
      nsis?: { oneClick?: boolean; perMachine?: boolean; deleteAppDataOnUninstall?: boolean };
    };

    // `dist/` is spawned by the engine bridge and `node_modules` by both that
    // child and the REA server it starts; neither can read inside app.asar.
    expect(config.asarUnpack).toEqual(expect.arrayContaining(["dist/**/*", "node_modules/**/*"]));
    expect(config.files).toEqual(
      expect.arrayContaining(["dist/**/*", "dist-desktop/**/*", "dist-electron/**/*"]),
    );
    expect(config.extraMetadata?.main).toBe("dist-electron/main.js");
    // Platform packages ship prebuilt N-API binaries; rebuilds would require a
    // toolchain and are the usual reason a Windows CI packaging job fails.
    expect(config.npmRebuild).toBe(false);
    expect(config.win?.target?.[0]?.target).toBe("nsis");
    expect(config.nsis?.oneClick).toBe(false);
    expect(config.nsis?.perMachine).toBe(false);
    // Uninstalling may not destroy the user's saved cases.
    expect(config.nsis?.deleteAppDataOnUninstall).toBe(false);
    expect(config.appId).toBe("io.github.morluto.rea-workspace");
  });

  it("agrees with the AppUserModelID the main process sets", async () => {
    const main = await readFile("desktop/main.ts", "utf8");
    const config = parseYaml(await readFile("electron-builder.yml", "utf8")) as { appId?: string };
    expect(main).toContain(`app.setAppUserModelId("${config.appId}")`);
  });
});
