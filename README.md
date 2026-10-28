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

The engine is transport-agnostic, so a native shell (Rust/egui, Slint) or the
bundled headless CLI can drive the same object graph.

## Status — read this first

Verified in this repository against **rea-agents 6.8.0**, MCP protocol
`2025-11-25`, on Node 22:

| Area | State |
| --- | --- |
| MCP handshake, `tools/list` (229 tools), `tools/call` | **Verified** — integration tests run against the real server |
| `binary_session` discovery payload | **Verified** — parsed from live output |
| REA error contract (relative-path rejection, missing file) | **Verified** — real envelopes, asserted in tests |
| `open_binary` on a real ELF, provider-unavailable degradation | **Verified** |
| Evidence projection, truncation, untrusted-content marking | **Unit-tested** |
| Agent loop (tool calls, recovery, pruning, cancellation) | **Unit-tested** against scripted transports, and **integration-tested** end-to-end over a real HTTP model socket |
| OpenAI-compatible streaming client (SSE, chunk splitting, UTF-8 boundaries, timeouts, aborts) | **Tested** over a real TCP socket |
| CLI exit codes, `--json` output, stream separation | **Tested** by spawning the built CLI as a subprocess |
| `doctor` verdicts (policy, workspace, MCP, providers, model) | **Tested** in-process and against the live server |
| Vendor manifest + offline verification | **Verified** — installed tree matches the published tarball exactly (2398 files) |
| Windows path canonicalization | **Unit-tested on Linux** via `path.win32`; **not executed on Windows** |
| Rust/egui shell, packaging pipeline, model bundling | **Not built** — see [Scope](#scope) |

Anything marked "unit-tested" has not been run against a live `llama-server`
process or on Windows. The model client is exercised against a real HTTP server
speaking the same protocol, but not against llama.cpp itself.

Coverage (v8, `npm run test:coverage`): **88% statements, 90% lines, 78%
branches**. Thresholds in `vitest.config.ts` are a ratchet set just below that
floor, so a regression fails CI.

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

## Quick start

```bash
npm install
npm run build

# Preflight every dependency (no model required)
node dist/cli.js doctor --config config.local.json --no-llm

# Inspect what the server actually exposes
node dist/cli.js tools --config config.local.json

# Open a binary and dump its analysis surface (no model required)
node dist/cli.js probe /usr/bin/ls --config config.local.json

# Full agent loop, needs llama-server on llm.baseUrl
node dist/cli.js ask "Explain the main entry point" --open /usr/bin/ls
```

For a source checkout, `config.local.json` only needs to point at the installed
server:

```json
{
  "rea": { "command": "node", "args": ["node_modules/rea-agents/scripts/rea.mjs", "mcp"] }
}
```

## Commands

| Command | Purpose |
| --- | --- |
| `doctor` | Node version, air-gap policy, workspace, MCP connect + inventory, provider availability, model endpoint |
| `vendor manifest` | Record a hash manifest for a vendored dependency, anchored to the published tarball |
| `vendor verify` | Check a vendored tree against its manifest, offline |
| `vendor advisories` | Resolve advisories against every installed copy of a dependency and judge reachability |
| `tools` | Catalog grouped by family, plus the advertised scope and anything missing |
| `probe <binary>` | `open_binary` + `binary_overview`, no model needed |
| `ask "<question>"` | Full agent loop with streamed output |

All commands accept `--json`.

## Library use

```ts
import {
  ReaClient, ToolCatalog, AgentSession, LlamaServerClient,
  buildSystemPrompt, readBinarySession,
} from "rea-client";

const rea = new ReaClient(config.rea);
await rea.connect();

const catalog = ToolCatalog.from(await rea.listTools());
const scope = catalog.resolveScope("binary-core");

const agent = new AgentSession({
  connection: rea,
  chat: new LlamaServerClient({ baseUrl: config.llm.baseUrl }),
  catalog, scope,
  model: config.llm.model,
  maxIterations: 8,
  maxToolResultChars: 12_000,
  temperature: 0.1,
  maxTokens: 1536,
  contextWindow: 16_384,
  systemPrompt: buildSystemPrompt({
    catalog, advertisedToolCount: scope.tools.length,
    session: readBinarySession(await rea.callTool("binary_session", {})),
  }),
});

agent.on("assistant_delta", ({ text }) => process.stdout.write(text));
agent.on("tool_call_started", ({ name, arguments: args }) => console.log(name, args));

const result = await agent.ask("Explain the decryption loop in sub_1400010a0");
```

## Design decisions worth knowing

**Tool scoping exists because 229 schemas do not fit.** Sending the whole
catalog to a 14B model at a 16k context consumes most of the window before the
question is asked. `binary-core` advertises 22 tools; calls are still validated
against the complete inventory, so nothing is silently unavailable.

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

Built here: the engine, its tests, and the headless CLI.

Not built here: the Rust/egui desktop shell, Windows Job Object supervision,
Ghidra/JRE bundling, model distribution, installer generation. This sandbox has
no Rust toolchain and no access to crates.io, so shipping a GUI half here would
mean untested code. The engine's public surface (events, callbacks, config) is
the integration point those tiers should consume.

## Development

```bash
npm run typecheck       # tsc (TypeScript 7)
npm test                # unit tests
npm run build           # required before the CLI integration tests
npm run test:integration  # real rea-agents MCP server + real HTTP model server
npm run test:coverage   # both projects with v8 coverage and thresholds
npm run check           # typecheck + both test projects
```

Integration tests skip automatically when `rea-agents` is not installed **or**
when `dist/` has not been built — but they hard-fail if `CI` is set, so CI can
never silently lose that coverage. CI runs typecheck, build, tests, then
coverage in that order for exactly this reason.

The four core behaviours that would otherwise fail silently are locked down by
tests rather than convention: SSE frames split across TCP segments, multi-byte
characters split across segments, tool-call arguments arriving in fragments, and
failed tool calls being returned to the model instead of aborting the turn.

## License

MIT — see [LICENSE](LICENSE).
