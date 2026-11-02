# Desktop workspace

`rea-client` ships a local-first graphical workspace on top of the same
orchestration engine and `rea-client serve` bridge the CLI uses. There are two
runtimes for the identical React UI:

| Runtime | Command | Purpose |
| --- | --- | --- |
| Native shell | `npm run desktop` | Electron window, loopback gateway on a random port, native file picker |
| Browser preview | `npm run desktop:preview` | Explicit `0.0.0.0:5173` preview for containers and remote review |

Both runtimes talk to the engine through one supervised child process. There is
no second implementation of the agent loop, and the renderer never receives a
filesystem, process, or Node API.

```
┌──────────────────────────────┐
│ React renderer (dist-desktop)│
│  fetch + SSE, token in memory│
└──────────────┬───────────────┘
               │ same-origin HTTP + X-REA-Token
┌──────────────▼───────────────┐
│ DesktopGateway (loopback)    │
│  static, RPC allowlist, SSE, │
│  browser uploads             │
└──────────────┬───────────────┘
               │ newline JSON-RPC over stdio
┌──────────────▼───────────────┐
│ dist/cli.js serve            │
│  MCP + local model + evidence│
└──────────────────────────────┘
```

## Build and run

```bash
npm ci
npm run build:desktop      # engine (dist), React UI (dist-desktop), shell (dist-electron)

npm run desktop            # native Electron window
npm run desktop:web        # browser UI on 127.0.0.1:5173
npm run desktop:preview    # browser UI on 0.0.0.0:5173 (explicit opt-in)
```

A preview bound to `0.0.0.0` is reachable by anything that can route to the
host. Set `REA_PREVIEW_TOKEN` to require an access token before the UI can
bootstrap:

```bash
REA_PREVIEW_TOKEN="$(openssl rand -hex 24)" npm run desktop:preview
# open https://<preview-host>/?access_token=<the token>
```

The UI forwards that query only to `GET /api/session`, then removes it from the
address bar. Without the environment variable the preview is open to whoever
can reach the URL, which is why `--preview` is never implied and a warning is
logged.

`desktop:web` and `desktop:preview` accept `--config <path>` after `--`:

```bash
node dist/desktop/server.js --config config.example.json --port 5173
```

The default config path is `config.json`; `config.example.json` is a working
starting point. The engine is only spawned on the first RPC, so opening the page
does not touch a binary or a model.

## What the UI covers

- **Drag and drop** — drop a single file on the window. In Electron the preload
  resolves the real path (`webUtils.getPathForFile`) and REA opens it in place
  with no copy; in the browser preview the file is uploaded to the local
  workspace. Empty, multi-file, oversized, and unresolved-path drops are
  rejected with a specific reason instead of silently doing nothing.
- **Workspace** — open a target by path or (browser) upload, read the format,
  architecture, SHA-256 and provider summary, start a conversation, watch tool
  calls stream in, stop a turn, switch scope, close the target. Reloading the
  page re-attaches to the running engine and restores the conversation from
  `agent.transcript` instead of starting over.
- **Tool catalog** — the live 229-tool inventory with family filters, scope
  indicators, and lazily loaded JSON schemas (`tools.describe`). A tool can
  prefill a question; it cannot be invoked directly from the catalog.
- **Evidence** — projected observations and evidence IDs, each attributed to
  the target that was open when that tool ran (not whichever target happens to
  be open now), truncation and error states, and a local export in two formats:
  a human-readable Markdown report and a versioned JSON document
  (`schemaVersion: 1`) containing the same turns, observations, and diagnostics.
  Observation previews are fenced with a backtick run longer than anything they
  contain, so untrusted target text cannot break out of its block.
- **Diagnostics** — `engine.doctor` verdicts with remediation, reconnection, and
  a live engine event log.
- **Settings** — read-only model/network/scope configuration, workspace
  instructions, recent paths, and the active security boundaries.

## Security boundaries

- **Same-origin only.** Host and `Origin`/`Sec-Fetch-Site` are checked exactly;
  there is no CORS. A random 256-bit token is required on every API request
  except the bootstrap document, and it lives only in page memory. Shared
  previews can additionally require `REA_PREVIEW_TOKEN`.
- **RPC allowlist.** The gateway exposes a fixed set of bridge methods. Engine
  shutdown, arbitrary methods, and raw tool execution are not reachable.
- **Reports are local files.** Both export formats are assembled in the page
  from state already in memory; nothing is uploaded, and no report is written
  into the workspace unless you save it. A report contains target paths and
  untrusted observation text, so treat exported files as sensitive.
- **No renderer privileges.** Electron uses `contextIsolation`, `sandbox`,
  `nodeIntegration: false`, denies window creation, navigation, webviews, and
  all permission requests. The preload exposes exactly one method
  (`chooseBinary`) and is CommonJS because sandboxed preloads cannot be ESM.
- **Bounded inputs.** RPC bodies are capped at 1 MiB, questions at 32k
  characters, instructions at 8k, and uploads at 100 MiB. Uploads are written
  with `wx`/0600 into `<workspace>/uploads` under a random file name; the
  original name is only echoed back to the client.
- **No target execution.** The engine only opens and inspects files. The UI
  labels target-derived text as untrusted and renders Markdown without raw HTML,
  remote images, or external navigation.
- **Loopback by default.** `0.0.0.0` binding requires an explicit `--preview`.
  The browser preview is a development/review surface, not a public service.

## Accessibility

- Dialogs are native `<dialog>` elements with `aria-modal`, labelled headings,
  explicit initial focus, and a Tab cycle (the fallback path for environments
  without `showModal` gets the same behaviour). Focus returns to the control
  that opened the dialog.
- The transcript is an `aria-live="polite"` region with `aria-busy` while a turn
  is running, so streaming answers are announced rather than silently changing.
- Icon-only controls carry `aria-label`s, tabs expose `aria-selected`, and all
  animation respects `prefers-reduced-motion`.

## Event correlation

`agent.ask` accepts an optional `clientRequestId` (≤128 chars). When present,
the bridge tags every `agent.event` notification with that value instead of the
JSON-RPC request id, so the renderer can attach streamed deltas and tool calls to
the optimistic message it already rendered. Existing stdio clients that omit
the field keep the old behaviour.

## Bridge additions made for the workspace

- `tools.list` with `{ includeDetails: true }` — lightweight entries
  (name/title/description/family/read-only/destructive) plus scope names, not
  the 3.5 MB of full schemas.
- `tools.describe { name }` — full live schema and scope membership for one
  tool, so the catalog stays lazy.
- `agent.transcript` is used to rehydrate the visible conversation after a
  reload; system and tool messages are dropped, and no transcript content is
  written to browser storage.
- `target.probe` now distinguishes an opened target from an unavailable
  overview: `{ ok: true, overview: null, overviewError: "..." }`. An error string
  is never presented as analysis output.
- Additional forwarded events: `iteration`, `context_pruned`, `error`.

## Validation status

Verified in the build sandbox against the real `rea-agents@6.8.0` server and a
real ELF target (`/usr/bin/ls`):

- The gateway served the built UI, bootstrapped the token, listed **229 tools in
  15 families (22 in scope)**, opened the target (`elf`, `x86_64`, SHA-256), and
  returned the honest `provider_unavailable` overview error.
- The built React bundle was executed in a DOM runtime against that live
  gateway: welcome screen, sample target, overview error panel, catalog and tool
  detail, diagnostics (5/6 checks passing; local model absent), settings,
  evidence empty state, and the close-target dialog all rendered with **no
  console or page errors**.
- A local model was simulated with the repository's own
  `FakeModelServer` (a real HTTP SSE server, not a stub) to drive the built UI
  end to end: the composer enabled, a question streamed, a real
  `binary_session` tool call reached the live REA server, the answer rendered as
  Markdown, the turn footer reported "Investigation complete · 2 steps",
  evidence gained that observation, and Diagnostics flipped the model check to
  Passed — with no console or page errors.
- Drag-and-drop, report export, and the upload path were re-checked against the
  running gateway: a real `POST /api/upload` of `/usr/bin/ls` returned a
  workspace path that `target.probe` then opened (`elf`, `x86_64`), the drop
  overlay renders and cancels the browser's default, and both export buttons
  produced `rea-analysis-YYYY-MM-DD.md` / `.json` containing the turn, the
  evidence ID, and `schemaVersion: 1`.
- `npm run typecheck`, `npm run typecheck:desktop`, all unit tests, and the
  coverage gate pass.

Automated coverage for the desktop tier:

| Layer | Test |
| --- | --- |
| Engine supervisor | `test/unit/engineBridge.test.ts` (spawns a fixture CLI), `test/integration/gatewayBridge.test.ts` |
| Gateway security | `test/unit/gateway.test.ts` — host/origin/token/allowlist, uploads, traversal and symlink escape, preview token |
| Electron trust rules | `test/unit/desktopSecurity.test.ts` — navigation/IPC origins and locked-down `webPreferences` |
| Streaming UI state | `test/unit/desktopState.test.ts` — deltas, tool activity, completion, interruption |
| API client | `test/unit/uiApi.test.ts` — 401 re-bootstrap, upload contract, error surfacing |
| Rendered App | `test/unit/uiApp.test.tsx` (jsdom) — boot, catalog, diagnostics, target open, overview failure, retry, transcript restore, report export, drop overlay |
| Report export | `test/unit/report.test.ts` — turn pairing, per-target attribution, Markdown fencing, file names |
| Drop routing | `test/unit/drop.test.ts` — open-in-place vs upload vs reject |

Not verified here, and not claimed:

- **The native Electron window was never launched.** This sandbox has no GUI
  display, no Electron binary (the postinstall download is blocked), and no
  system GTK/NSS libraries. The main/preload code is typechecked and compiled to
  ESM/CommonJS respectively, but native runtime behaviour needs a desktop
  machine.
- **Browser uploads were not exercised from a real browser engine.** The
  endpoint was validated with real HTTP requests, and the client explicitly
  turns an aborted/incompatible upload into "open it by path instead" rather
  than a raw stream error.
- **No screenshot-based visual regression.** CSS is reviewed for layout and
  responsive breakpoints, but no rendering engine with layout was available.
- **No live model turn.** There is no `llama-server` in the sandbox, so the
  conversation, streaming-tool-activity, stop, and evidence-population paths are
  covered by unit tests and reducer tests rather than a live model.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm run desktop` fails with "Electron failed to install correctly" | The npm postinstall download was skipped or blocked. Run `node node_modules/electron/install.js`, or set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and use the browser preview instead. |
| Electron exits immediately on Linux with a missing `libnss3.so` / `libgtk-3.so` | Install the distribution's Electron runtime dependencies (`libnss3`, `libgtk-3-0`, `libgbm1`, `libasound2`). This sandbox is exactly that situation. |
| The page shows "Could not connect to the local workspace service." | `dist-desktop` is missing or the gateway is not running. Run `npm run build:desktop`, then `npm run desktop:web`. |
| "This preview requires an access token" | The server was started with `REA_PREVIEW_TOKEN`; open the URL including `?access_token=…` as printed at startup. |
| "Desktop assets not found. Run npm run build:desktop." | The gateway started before the UI was built; rebuild and restart. |
| Diagnostics says the local model is unavailable | Start a loopback OpenAI-compatible server (for example `llama-server`) matching `llm.baseUrl` in the config, then press *Run diagnostics*. |

## Packaging notes (not implemented)

`npm run desktop` runs from a source checkout. A distributable build still
needs: an Electron packager step, code signing, a Windows Job Object or POSIX
process-group supervisor around the engine child, and bundled `rea-agents` /
model assets. None of that is claimed by this repository yet.
