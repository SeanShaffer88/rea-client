# rea-client

[![CI](https://github.com/SeanShaffer88/rea-client/actions/workflows/ci.yml/badge.svg)](https://github.com/SeanShaffer88/rea-client/actions/workflows/ci.yml)

The **orchestration engine** for an air-gapped desktop client around
[`morluto/rea`](https://github.com/morluto/rea) (Reverse Engineering Assistant).

It owns the parts that are hard to get right and easy to verify: the MCP
handshake, dynamic tool discovery, the local-LLM ReAct loop, and the projection
of REA's Evidence results into something a 14B model can actually read.

```
user question
   │
   ▼
┌──────────────────────────────────────────────┐
│ AgentSession  (ReAct loop, context budget)   │
└───────┬──────────────────────────┬───────────┘
        │ function definitions     │ observations
        ▼                          ▼
┌──────────────────┐      ┌──────────────────────┐
│ llama-server     │      │ ReaClient (MCP stdio)│
│ /v1/chat/…       │      │ 229 tools, 1 process │
└──────────────────┘      └──────────┬───────────┘
                                     ▼
                          providers (Ghidra, IDA,
                          Hopper, JEB, …)
```

The engine is transport-agnostic, so the bundled headless CLI, an Electron
window, or any other shell can drive the same object graph. This repository now
ships an Electron + React **desktop workspace** on top of the engine, plus a
browser preview of the same UI.

## Status — read this first

Verified in this repository against **rea-agents 6.8.0**, MCP protocol
`2025-11-25`, across Linux (`ubuntu-latest`) and Windows (`windows-latest`) on
Node 22 and Node 24:

| Area | State |
| --- | --- |
| MCP handshake, `tools/list` (229 tools), `tools/call` | **Verified** — integration tests run against the real server on Linux and Windows |
| `binary_session` discovery payload | **Verified** — parsed from live output |
| REA error contract (relative-path rejection, missing file) | **Verified** — real envelopes, asserted in tests |
| `open_binary` on real ELF (`ls`) and PE (`whoami.exe`), provider-unavailable degradation | **Verified** on Linux and Windows CI |
| Evidence projection, truncation, untrusted-content marking | **Unit-tested** |
| Agent loop (scope enforcement, argument guard, recovery, pruning, cancellation, live target prompt refresh) | **Unit-tested** against scripted transports, and **integration-tested** end-to-end over a real HTTP model socket |
| OpenAI-compatible streaming client (SSE, chunk splitting, UTF-8 boundaries, idle timeouts, aborts, non-streamed JSON) | **Tested** over a real TCP socket |
| CLI exit codes, `--json` output, stream separation | **Tested** by spawning the built CLI as a subprocess |
| Persistent JSON-RPC 2.0 stdio bridge (`rea-client serve`) | **Unit-tested** in-process and **integration-tested** as a real subprocess |
| Electron + React desktop workspace (gateway, streaming chat, catalog, evidence, diagnostics, settings) | **Built and exercised** against the live gateway and real REA server, including scripted-model tool calls through the rendered UI. The packaged native Windows workspace and file picker have also been displayed; see [Validation status](docs/desktop.md#validation-status) |
| `doctor` verdicts (Node semver range, policy, workspace, MCP, providers, authenticated `/models`) | **Tested** in-process and against the live server |
| Vendor manifest + offline verification | **Verified** — installed tree matches the published tarball on Linux and Windows (2398 files) |
| Windows path, UNC air-gap policy, and `file://` canonicalization | **Tested** on both Linux (`path.win32`) and Windows (`windows-latest`) |
| Windows installer | The previous app-only installer was **built in CI**. The expanded offline kit includes the model and analysis dependencies; its installation checks are recorded in [Validation status](docs/desktop.md#validation-status) |
| Offline AI and decompilation dependencies | **Implemented, validation in progress** — portable llama.cpp, Qwen3-8B, Ghidra, JDK, and app-local Microsoft runtime; see [Packaging](docs/desktop.md#packaging) |
| Job Object supervisor, macOS/Linux installers | **Not built** — see [Scope](#scope) |

The model client is exercised against a real HTTP server speaking the OpenAI
`/v1/chat/completions` protocol, though CI does not bundle a live `llama-server`
binary or GGUF weights.

Coverage (v8, `npm run test:coverage`): **88.67% statements, 91.68% lines, 79.75%
branches**, including the desktop bridge, gateway, and offline runtime. Thresholds in
`vitest.config.ts` are a ratchet set just below that floor, so a regression
fails CI.

## What changed from the original blueprint

The blueprint's tool names do not exist in REA. Building against them would
produce a client that fails on its first tool call. Full evidence and the
corrected mapping are in [`docs/rea-integration-notes.md`](docs/rea-integration-notes.md).

| Blueprint | Reality (6.8.0) |
| --- | --- |
| `analyze_binary` | `open_binary` |
| `decompile_function` | `procedure_pseudo_code`, `analyze_function`, `decompile_all` |
| `list_imports` | `inspect_pe_imports` (PE only) |
| `query_xrefs` | `xrefs` |
| 4 tools | **229 tools** |
| `node.exe rea/dist/index.js --mcp` | `node rea/scripts/rea.mjs mcp` — `dist/index.js` is not in the package |
| Node 20+ | `^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1` |

## Install on Windows

The **unreleased offline build** is distributed as
`rea-client-<version>-windows-x64-offline.zip`. Extract the complete ZIP, then run
Setup beside its `offline` directory. Keep them together until installation
finishes: Setup verifies and installs that local payload without downloading
anything. The model is larger than NSIS's 2 GB executable limit, so the setup
executable alone is not a complete installer.

The kit includes Electron, the engine, the React workspace, **REA 6.8.0**,
portable **llama.cpp**, **Qwen3-8B Q4_K_M**, **Ghidra 12.1.4**, **Temurin JDK 25**,
and the app-local Microsoft runtime DLLs they need. It requires no separate
Node.js, Ollama, Java, Ghidra, or model installation. CUDA acceleration is tried
first, with a bundled CPU fallback. The default model uses an 8,192-token
context. First startup verifies the bundled files and loads the local model;
the startup window reports the current stage.

Setup is per-user, installs `REA Workspace` into a directory you choose, and
adds desktop and Start menu shortcuts. No service or scheduled task is created.
The previous [v0.3.0 release](https://github.com/SeanShaffer88/rea-client/releases/tag/v0.3.0)
does **not** include this expanded offline payload. A new release has not been
published; release automation is gated until complete multipart distribution
fits GitHub's per-asset limit.

The first launch writes a configuration file and creates an empty workspace:

| Path | Contents |
| --- | --- |
| `%APPDATA%\REA Workspace\config.json` | model endpoint, tool scope, air-gap policy, workspace location |
| `%APPDATA%\REA Workspace\workspace\` | saved cases (`cases/<name>/`), evidence bundles |

Both are reached from the app's **File** and **Help** menus. Uninstalling removes
the program and leaves that directory alone, so saved cases survive.

The installer is **not code-signed**, so Windows may report an unknown publisher.
Ghidra supplies the bundled native decompiler; optional integrations such as IDA
and Hopper remain external. Their presence in REA's catalog does not mean those
separate products are installed. Third-party licenses and notices ship with the
offline payload; the whole kit is not covered solely by this project's MIT license.

## Quick start

```bash
npm ci
npm run build

# Preflight every dependency out of the box (no model required)
node dist/cli.js doctor --no-llm

# Inspect what the server exposes
node dist/cli.js tools

# Open a binary and dump its analysis surface (no model required)
# Linux: /usr/bin/ls   Windows: C:\Windows\System32\whoami.exe
node dist/cli.js probe /usr/bin/ls

# Full agent loop, needs llama-server on llm.baseUrl
node dist/cli.js ask "Explain the main entry point" --open /usr/bin/ls

# Persistent JSON-RPC 2.0 bridge over stdin/stdout for a native desktop shell
node dist/cli.js serve

# Desktop workspace
npm run build:desktop
npm run desktop           # native Electron window
npm run desktop:web       # browser UI on 127.0.0.1:5173
npm run desktop:preview   # browser UI on 0.0.0.0:5173 (explicit opt-in)

# Complete Windows offline kit (build-time downloads, output in release/)
npm run offline:prepare   # verify and stage pinned model/runtime/Ghidra/JDK assets
npm run pack:win          # NSIS setup .exe; requires staged offline payload
npm run offline:kit       # Setup + payload, and a ZIP64 offline kit
npm run pack:linux        # AppImage
npm run pack:dir          # unpacked app directory, no installer
```

`DEFAULT_CONFIG` automatically resolves `vendor/rea-agents/scripts/rea.mjs` (for
packaged bundles) or `node_modules/rea-agents/scripts/rea.mjs` (for source
checkouts). Pass `--config <path>` (see `config.example.json`) to override model
endpoints, tool scopes, or air-gap policies.

## Commands

| Command | Purpose |
| --- | --- |
| `doctor` | Node version, air-gap policy, workspace, MCP connect + inventory, provider availability, model endpoint |
| `tools` | Catalog grouped by family, plus the advertised scope and anything missing |
| `probe <binary>` | `open_binary` + `binary_overview`, no model needed |
| `ask "<question>"` | Full agent loop with streamed output |
| `serve` | Persistent newline-delimited JSON-RPC 2.0 stdio bridge for native desktop shells |
| `vendor manifest` | Record a hash manifest for a vendored dependency, anchored to the published tarball |
| `vendor verify` | Check a vendored tree against its manifest, offline |
| `vendor advisories` | Resolve advisories against every installed copy of a dependency and judge reachability |
| `case list \| show \| save \| delete` | Read and write the case folders the desktop app saves, without opening the app |
| `evidence export [<case>]` | Ask REA to write its evidence bundle, into a case folder or a path inside the workspace |

All one-shot commands accept `--json`.

Cases are the one thing both front ends share, so the CLI is a complete
counterpart: `rea-client case show ls-triage` prints the report the desktop app
saved, and `rea-client case save` produces a folder the app will list.

```bash
# Store a finished analysis, with REA's bundle next to it.
rea-client case save ls-triage --report analysis.md --json-report analysis.json --with-evidence

# Read it back, or hand the Markdown to something else.
rea-client case show ls-triage
rea-client case show ls-triage --report copy.md

# Refresh only the bundle for a case that already exists.
rea-client evidence export ls-triage

# Everything the app shows in its case list, as JSON.
rea-client case list --json
```

`--workspace <dir>` points every case and evidence command at a different
workspace root, which is how the test suite exercises them. `case list`,
`case show`, `case delete`, and `case save` without `--with-evidence` need no
engine: only `--with-evidence` and `evidence export` start REA.

## Desktop bridge (`rea-client serve`)

Native desktop shells spawn `rea-client serve` once (for example inside a
Windows Job Object) and exchange `\n`-delimited JSON-RPC 2.0 messages over
`stdin`/`stdout`:

- **Lifecycle & diagnostics**: `engine.ping`, `engine.doctor`, `engine.shutdown`
- **Catalog & target control**: `tools.list`, `target.session`, `target.open`, `target.close`, `target.probe`
- **Stateful agent turns**: `agent.ask`, `agent.cancel`, `agent.reset`, `agent.transcript`
- **Server notifications**: `agent.event` (`assistant_delta`, `tool_call_started`, `tool_call_finished`, `done` tagged by `requestId`) and `rea.stderr`

Incoming requests are dispatched concurrently, so `agent.cancel` or
`engine.shutdown` aborts an in-flight `agent.ask` turn immediately.

## Desktop workspace

`npm run build:desktop` builds the engine, the React UI (`dist-desktop`), and
the Electron main/preload code (`dist-electron`). Two runtimes share the same
UI and the same supervised `rea-client serve` child process:

- `npm run desktop` opens an Electron window with a loopback gateway on a
  random port and a native file picker.
- `npm run desktop:web` serves the same UI on `127.0.0.1:5173`; adding
  `desktop:preview` binds `0.0.0.0` only when `--preview` is passed. Set
  `REA_PREVIEW_TOKEN` when a preview URL can be shared; without it the preview
  is open to anyone who can reach the host.

The workspace opens binaries by path, by dropping a file on the window, or
(browser only) by upload, streams agent
deltas and tool calls over authenticated SSE, exposes the live 229-tool catalog
with lazily loaded schemas, shows projected evidence and evidence IDs, lists
the evidence REA itself retained (opening one record, or exporting REA's
canonical bundle into the workspace), saves a finished analysis as a case folder
holding the Markdown report, its versioned JSON companion, and REA's canonical
bundle, reopens any saved case to read the report it captured or reopen its target, runs diagnostics
with remediation, and can still download the report from the browser. The renderer has
no Node, filesystem, or arbitrary IPC access: Electron runs with sandbox and
context isolation, the preload exposes exactly one file-dialog method, and all
state changes pass an allowlisted, token-authenticated HTTP gateway.

Start with [`docs/desktop.md`](docs/desktop.md) for the architecture, security
boundaries, validation status, and the honest list of what is not verified
(the native Windows window and packaged REA startup have been exercised; expanded
offline-model and Ghidra validation is recorded separately).
Release history lives in [`CHANGELOG.md`](CHANGELOG.md).

## Library use

```ts
import {
  ReaClient, ToolCatalog, LlamaServerClient,
  buildSystemPrompt, createAgentSession, loadConfig, readBinarySession,
} from "rea-client";

const config = await loadConfig("config.json");
const rea = new ReaClient(config.rea, {
  allowNonLoopback: config.policy.allowNonLoopback,
});
await rea.connect();

const catalog = ToolCatalog.from(await rea.listTools());
const scope = catalog.resolveScope(config.agent.toolScope, config.agent.customTools);
const session = readBinarySession(await rea.callTool("binary_session", {}));

const agent = createAgentSession(config, {
  connection: rea,
  chat: new LlamaServerClient({
    baseUrl: config.llm.baseUrl,
    ...(config.llm.apiKey === undefined ? {} : { apiKey: config.llm.apiKey }),
    requestTimeoutMs: config.llm.requestTimeoutMs,
    allowNonLoopback: config.policy.allowNonLoopback,
  }),
  catalog,
  scope,
  systemPrompt: buildSystemPrompt({
    catalog,
    advertisedToolCount: scope.tools.length,
    session,
  }),
});

agent.on("assistant_delta", ({ text }) => process.stdout.write(text));
agent.on("tool_call_started", ({ name, arguments: args }) => console.error(name, args));

const result = await agent.ask("Explain the decryption loop in sub_1400010a0");
```

## Design decisions worth knowing

**Tool scoping bounds both context and authority.** Sending all 229 schemas to a
14B model at a 16k context consumes most of the window before the question is
asked. `binary-core` advertises 22 tools, and `AgentSession` enforces that active
scope at dispatch time (`agent.allowUnscopedTools` defaults to `false`), so
prompt-injected strings inside an analyzed target cannot invoke unadvertised
tools.

**Failed tool calls go back to the model, not up the stack.** A local model will
occasionally pass a bad address. REA returns a typed error with remediation
advice; the engine renders it compactly and lets the model correct itself
instead of killing the turn.

**`evidence_id` and `limitations` are never truncated away.** The id is how
chained analysis works (`compare_functions` takes a retained reference, not a
payload); `limitations` is what stops "unknown" from becoming confident prose.

**Target-derived text is marked untrusted.** REA sets
`_meta.provenance.untrusted_content`; the engine prefixes those observations so
instruction-like strings inside a hostile binary read as data, not as orders.

**Only loopback endpoints are allowed by default.** The air-gap claim is
enforced at config load, not just documented.

**Advisories are judged on reachability, not version ranges.** `npm audit`
reports zero production vulnerabilities for this project. It is right about the
hoisted `zod@4.6.7` and wrong about what matters: `rea-agents` pins its own
`zod@4.4.3`, nested and inside the vulnerable range, and that is the copy
validating tool arguments. `vendor advisories` resolves the advisory against
every installed copy, then checks the precondition against the live tool
surface — 69 of 74 array parameters have no length limit. The verdict is
`reachable`, not a footnote. Because that nested pin cannot be upgraded from
here, `AgentSession` bounds every outbound tool call (256 array items, 64 KiB)
before dispatch, so the oversized payload never reaches the vulnerable validator
at all. The finding is accepted in `vendor/advisories/accepted.json` with that
mitigation and a review date; remove the guard and the acceptance is void.
See [docs/supply-chain.md](docs/supply-chain.md).

**CI actions are pinned to commit SHAs**, with Dependabot keeping the pins
current — a retagged or compromised action tag cannot inject code into the
build of a tool that analyzes untrusted binaries.

**The vendored `rea-agents` tree is verified, not trusted.**
`vendor/rea-agents.manifest.json` records a sha256 for all 2398 files, anchored
to the sha512 integrity npm published for the tarball. CI re-hashes the installed
tree before running any test against it, so a post-install script, a partial
upgrade, or a tampered tarball fails the build instead of silently becoming the
code under test. Verification is offline — the shipped bundle needs no network.
See [docs/supply-chain.md](docs/supply-chain.md).

## Scope

Built here: the engine, its tests, the headless CLI, an Electron/React desktop
workspace (shared with a browser preview) that drives the real bridge, and the
Windows installer that ships them together with REA.

Not built here: Windows Job Object supervision, code signing, and verified
macOS/Linux installers. The packaging configuration
covers those platforms — `npm run pack:linux` and the `mac` target both build —
the previous Windows app-only installer was built in CI. The expanded Windows
offline kit has its own packaging workflow; its current validation evidence is
recorded below.

The native packaged Windows workspace has been launched, displayed the live
229-tool catalog, opened its native file picker, and opened a real PE target
through the packaged gateway. See
[`docs/desktop.md`](docs/desktop.md#validation-status) for the remaining checks.
The expanded offline kit is an unreleased build; automatic publishing is
blocked until the full payload can be distributed within GitHub's asset limits.
The engine's public surface (events, callbacks, config) remains the integration
point for any other shell.

## Development

```bash
npm run typecheck       # tsc (TypeScript 7)
npm test                # unit tests
npm run build           # required before the CLI integration tests
npm run test:integration  # real rea-agents MCP server + real HTTP model server
npm run test:coverage   # both projects with v8 coverage and thresholds
npm run check           # typecheck + both test projects
npm run build:desktop   # engine + React UI + Electron shell
npm run typecheck:desktop  # UI (bundler resolution) + Electron (NodeNext)
```

Integration tests skip automatically when `rea-agents` is not installed **or**
when `dist/` has not been built — but they hard-fail if `CI` is set, so CI can
never silently lose that coverage. CI runs typecheck, build, tests, then
coverage in that order for exactly this reason.

The four core behaviours that would otherwise fail silently are locked down by
tests rather than convention: SSE frames split across TCP segments, multi-byte
characters split across segments, tool-call arguments arriving in fragments, and
failed tool calls being returned to the model instead of aborting the turn.

## Releases

Releases are annotated `v*` tags on `main` with a matching GitHub release; the
notes are taken from [`CHANGELOG.md`](CHANGELOG.md). The current release is
**v0.3.0**, the first release that ships a Windows installer. Its installer
predates the full offline dependency bundle described above.

Publishing is currently blocked by an explicit offline-distribution gate in
[`release.yml`](.github/workflows/release.yml): the kit exceeds GitHub's 2 GiB
per-asset limit, and an app-only installer must not be published as complete.
Do not tag a new release until multipart distribution is implemented and tested,
the project reaches beta testing, and the user explicitly approves the tag and
release. Passing CI and a merged PR do not authorize a tag or publication.

## License

MIT — see [LICENSE](LICENSE).
