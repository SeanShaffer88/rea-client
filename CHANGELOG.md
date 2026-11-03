# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut from `main` as annotated `v*` tags with matching GitHub
releases; see [Releasing](#releasing).

## [Unreleased]

### Added

- A Windows offline installation kit containing Setup and its adjacent verified
  dependency payload: portable llama.cpp with CUDA and CPU backends, Qwen3-8B
  Q4_K_M, Ghidra 12.1.4, Temurin JDK 25, and app-local Microsoft runtime DLLs.
  Setup and first launch use local files; they do not download dependencies.
- A native startup status window for bundle verification and local model loading.
- Hash-anchored payload verification, authenticated loopback model startup,
  bounded CUDA-to-CPU fallback, and cleanup of owned runtime processes and
  temporary model credentials.

### Fixed

- Packaged REA child processes retain Electron's required Node-mode flag while
  preserving the SDK's restricted environment inheritance.
- Custom desktop workspace paths resolve beside the configuration file and are
  reused consistently by the gateway, directory creation, and workspace menu.
- Engine shutdown allows the MCP server's graceful cleanup phases to finish
  before force termination.
- Windows security fixtures use native directory junctions to test the same
  link containment and manifest guarantees without elevated symlink privileges.

### Distribution Status

- The full model exceeds NSIS's 2 GB executable limit; distribute the complete
  offline ZIP, not the setup executable alone.
- Publishing is explicitly gated until verified multipart delivery fits
  GitHub's 2 GiB per-asset limit. No new tag or release is published by this work.
- Native Windows rendering, the file picker, and packaged REA target opening
  have been exercised. The offline installer and uninstaller both exited 0;
  all 5,794 installed payload files passed integrity checks, and uninstall
  preserved AppData and the workspace. Real model and Ghidra observations are
  recorded separately in `docs/desktop.md`.

## [0.3.0] — 2026-11-03

The first release with a downloadable Windows installer.

### Added

- **A Windows installer.** `npm run pack:win` builds
  `rea-client-<version>-windows-x64-setup.exe`: a per-user NSIS install (no
  elevation, choosable directory) that contains the Electron runtime, the
  engine, the workspace UI, and REA itself (`rea-agents` 6.8.0 from
  [morluto/rea](https://github.com/morluto/rea)), so an installed copy needs no
  Node.js, no network, and no separate REA install. The app writes its config and
  workspace to `%APPDATA%\rea-client`, and uninstalling leaves both behind.
- **`installer.yml`**, which builds that installer on `windows-latest` — called
  by the release workflow, runnable on demand, and run automatically on pull
  requests that touch packaging. `release.yml` now refuses to publish without
  the installer, attaches it plus `SHA256SUMS-windows.txt`, and writes the
  unsigned-build warning into the release notes.

### Changed

- **`rea-agents` is a runtime dependency, not a dev dependency.** The CLI
  launches it, so a consumer of this package needs it installed, and the
  installer has to contain it.
- **Packaged paths are asar-aware.** `unpackedPath()` maps a script path inside
  `app.asar` to the copy electron-builder unpacks beside it, because the engine
  child processes are plain Node and cannot read an archive. Covered by
  `test/unit/packaging.test.ts`, which also asserts the invariants
  `electron-builder.yml` has to keep.

## [0.2.0] — 2026-11-03

First release cut by `.github/workflows/release.yml` rather than by hand: the
tag builds, tests, packs, and publishes itself.

### Added

- **Case commands in the headless CLI.** `rea-client case list`, `show`, `save`,
  and `delete` read and write the same `cases/<name>/` folders the desktop app
  produces, so a case saved in one front end opens in the other. `case save`
  takes `--report` and `--json-report` (either may be `-` for stdin), refuses a
  companion that is not JSON, and only replaces an existing folder with
  `--overwrite`. `case list`, `show`, `delete`, and a `save` without
  `--with-evidence` need no engine, which makes them usable on a machine where
  REA is not running.
- **`rea-client evidence export [<case>]`.** Asks REA for its evidence bundle and
  writes it to `cases/<name>/evidence-bundle.json`, or to `--out <path>` inside
  the workspace. The only case-family command that connects to REA, and it
  reports the bundle's record and unknown-revision counts instead of claiming
  success on an empty file.
- **Tag-triggered releases.** `.github/workflows/release.yml` publishes on a
  `v*` tag: it re-verifies the vendored dependency and both test projects, packs
  the npm tarball with `SHA256SUMS`, and creates the GitHub release from the
  changelog section for that version. It fails when the tag, the built CLI
  version, or the changelog disagree.

### Changed

- **One implementation of a case folder.** The name rules, permission bits,
  conflict behaviour, and containment checks now live in `src/cases/store.ts`,
  shared by the bridge's `case.*` methods and the CLI commands, instead of being
  reachable only through the desktop RPC surface.

## [0.1.0] — 2026-11-03

First tagged release. The engine, the headless CLI, and the desktop workspace
that ships on top of them.

### Added

**Orchestration engine**

- MCP handshake with `rea-agents` 6.8.0, dynamic tool discovery (229 tools), and
  a `binary_session` reader so the target, providers, and catalog identity come
  from the server rather than from assumptions.
- ReAct loop with scope enforcement, argument validation, tool-error recovery,
  context pruning and budgeting, cancellation, and a system prompt that refreshes
  when the open target changes.
- OpenAI-compatible streaming client: SSE framing, chunk splitting, UTF-8
  boundary handling, idle timeouts, aborts, and non-streamed JSON responses.
- Evidence projection that keeps `evidence_id` and `limitations` intact while
  bounding everything else for a 14B context, and marks target-derived text as
  untrusted.

**Headless CLI (`rea-client`)**

- `doctor`, `tools`, `probe`, `ask`, `serve`, and the `vendor` commands
  (`manifest`, `verify`, `advisories`), with `--json` output, separated
  streams, and documented exit codes (`0` success, `1` check failed, `2` usage).
- `serve`: a persistent JSON-RPC 2.0 stdio bridge for shells that need the same
  engine object graph as the CLI.

**Desktop workspace (Electron + React, with a browser preview of the same UI)**

- One UI, two runtimes, one supervised `dist/cli.js serve` child process:
  loopback-only Electron gateway on a random port, or `127.0.0.1:5173` for the
  browser. The renderer never receives Node, filesystem, or arbitrary IPC.
- Open a target by path, by dropping a file on the window (opened in place in
  Electron, uploaded in the browser), or from the recent list; streamed agent
  turns with tool activity, cancellation, scope switching, and transcript restore
  after a reload.
- Live 229-tool catalog with family filters, scope indicators, and lazily loaded
  schemas.
- Evidence page with per-target attribution, and reports exported as Markdown or
  a versioned JSON document (`schemaVersion: 1`).
- Diagnostics (`engine.doctor` verdicts with remediation, reconnection, engine
  event log) and a read-only settings view.
- Retained evidence: list what REA itself retained (`get_evidence_bundle`
  summary), open a single record, and export REA's canonical bundle into
  `<workspaceDir>/evidence/`.
- Case folders: save an analysis as `cases/<name>/` holding `analysis.md`,
  `analysis.json`, and REA's `evidence-bundle.json`; reopen a saved case to read
  the report it captured, reopen its recorded target, search saved cases, and
  delete one behind a confirmation that names every file.

### Changed

- The blueprint's tool names do not exist in REA 6.8.0; the client is built
  against the real catalog and the corrected mapping is documented in
  [`docs/rea-integration-notes.md`](docs/rea-integration-notes.md).
- Tool definitions are ~3.5 MB for 229 tools, so the desktop bridge raises its
  frame limit and fetches lightweight catalog entries by default.
- Dependency advisories are judged by reachability, not by version range alone.

### Fixed

- `binary_overview` can fail while a target is open; that is now reported as
  `overviewError` instead of being shown as analysis output.
- Attachment upload errors surface an actionable message ("open it by path
  instead") rather than a stream `TypeError`.
- Report and bundle exports can no longer be written outside the workspace, and
  oversized requests are refused before the body is read.

### Security

- Loopback-only networking by default, exact Host/`Origin` checks, no CORS, a
  random per-session token on every API call, an RPC allowlist, `default-src
  'self'` CSP, and realpath-contained static file serving.
- Electron runs with `contextIsolation` and `sandbox`, one preload IPC method,
  and navigation, webview, permission, and devtools denial.
- Evidence and case exports are written by the service into `0700` directories
  with `0600` files; the page names a case, never a directory.
- Offline supply-chain verification of the vendored dependency and a
  reachability-aware advisory gate.

### Known limitations

- No native installers, Job Object supervisor, or bundled model/Ghidra
  providers; `npm run desktop` runs from a source checkout.
- The native Electron window could not be launched in the build sandbox (no GUI,
  no Electron binary); the main/preload code is typechecked and compiled, and
  the UI is exercised in a DOM runtime against the live gateway.
- CI does not bundle a `llama-server` binary or weights, so model turns in CI are
  scripted against a real HTTP server speaking the OpenAI protocol.
- Bundle counts in the sandbox runs are empty (no local model), so a populated
  retained bundle is covered by tests rather than by a live capture.

## Releasing

Release publishing is currently blocked by the offline-distribution gate in
`release.yml`. Implement and test complete multipart delivery first; never
publish the setup executable without its required payload. Do not create a tag
or release before beta testing and the user's explicit approval.

The earlier release procedure, after that gate is resolved and approval is given:

1. Add the `## [x.y.z]` section here and update the version in `package.json`
   and `src/cli.ts`.
2. Merge the release PR into `main` (merge commit, not squash).
3. `git tag -a v0.1.0 -m "rea-client 0.1.0" && git push origin v0.1.0`.

Pushing the tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds and tests the tagged tree, checks that the tag matches the built
CLI version, packs the npm tarball plus `SHA256SUMS`, and publishes the GitHub
release with this file's section as its notes. There is no separate manual
publishing step; a tag without a matching section fails the job.

[Unreleased]: https://github.com/SeanShaffer88/rea-client/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/SeanShaffer88/rea-client/releases/tag/v0.3.0
[0.2.0]: https://github.com/SeanShaffer88/rea-client/releases/tag/v0.2.0
[0.1.0]: https://github.com/SeanShaffer88/rea-client/releases/tag/v0.1.0
