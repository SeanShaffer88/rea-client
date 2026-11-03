# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut from `main` as annotated `v*` tags with matching GitHub
releases; see [Releasing](#releasing).

## [Unreleased]

Nothing yet.

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

1. Update the version here and in `package.json`.
2. Merge the release PR into `main` (merge commit, not squash).
3. `git tag -a v0.1.0 -m "rea-client 0.1.0" && git push origin v0.1.0`.
4. Create the GitHub release from that tag, using this file's section for the
   version as the notes.

[Unreleased]: https://github.com/SeanShaffer88/rea-client/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SeanShaffer88/rea-client/releases/tag/v0.1.0
