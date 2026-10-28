# REA integration notes (verified)

Everything below was observed against a live `rea-agents@6.8.0` MCP server over
stdio, not inferred from documentation. Reproduce with:

```bash
npm run build
node dist/cli.js doctor --config config.local.json
node dist/cli.js tools  --config config.local.json
npm run test:integration
```

Environment used: Node 22.22.3, `@modelcontextprotocol/client` 2.3.1, Linux
x86_64. Server reported protocol `2025-11-25`.

---

## 1. Identity

`rea mcp doctor --format json` and `binary_session` both report:

| Field | Value |
| --- | --- |
| package | `rea-agents` 6.8.0 |
| server name | `rea` |
| negotiated protocol | `2025-11-25` |
| SDK | 2.3.1 |
| tools | **229** |
| prompts | 6 |
| combined catalog digest | `fe938a7c…b04da0b` |
| tools digest | `a98940ba…f98e5e9` |

`binary_session` returns `server_identity.catalog.counts.mcp_tools = 229` and
`catalog.digests.combined_sha256`. The client compares the digest and the count
against its own `tools/list` result in `doctor`, so a server that silently
changes shape is visible rather than assumed healthy.

## 2. Launching the server

The blueprint's command does not work:

```diff
- node.exe rea/dist/index.js --mcp
+ node.exe rea/scripts/rea.mjs mcp
```

`dist/index.js` does **not exist** in the published package. `package.json`
declares:

```json
"bin": { "rea": "scripts/rea.mjs", "rea-agents": "scripts/rea.mjs" }
```

The subcommand is positionally `mcp`, not a `--mcp` flag.

**Engines.** `^22.23.4 || ^24.22.1 || >=26.12.1`. The blueprint's "Node 20+"
would run outside the supported range; Node 22.22.3 works but is below the
declared floor, which `doctor` reports as a warning rather than a failure.

## 3. Tool inventory — the blueprint's names do not exist

`tools/list` returns 229 tools. None of the blueprint's four are among them.

| Blueprint name | Exists? | Real equivalent(s) |
| --- | --- | --- |
| `analyze_binary` | ✗ | `open_binary` |
| `decompile_function` | ✗ | `procedure_pseudo_code`, `analyze_function`, `decompile_all`, `batch_decompile` |
| `list_imports` | ✗ | `inspect_pe_imports` (PE only; other formats use `inspect_macho`, `inspect_elf_notes`, …) |
| `query_xrefs` | ✗ | `xrefs`, `find_xrefs_to_name` |

A client built on the blueprint's names fails with an unknown-tool error on the
first call. This engine discovers the catalog dynamically and never hardcodes a
tool list; the `binary-core` scope names 22 tools and reports any that the
connected server does not expose.

Relevant real signatures:

```jsonc
// open_binary
{ "path": "…",        // REQUIRED, absolute; relative paths are rejected
  "format": "…",      // optional: dos-com | raw-binary | gamecube-dol
  "provider_id": "…" } // optional: concrete provider id or "auto"

// analyze_function
{ "procedure": "…",   // symbol or provider-returned address
  "detail": "complete | summary" }

// procedure_pseudo_code
{ "procedure": "…", "document": "…" }

// xrefs
{ "address": "…", "document": "…" }
```

## 4. Path handling

`open_binary.path` must be **absolute**. Passing `samples/app.exe` returns:

```json
{"error":{"code":"invalid_request","category":"invalid_input",
  "message":"The arguments for MCP tool open_binary do not match its advertised input schema.",
  "retryable":false,
  "remediation":{"action":"… Do not repeat the unchanged call."},
  "details":{"issues":[{"reason":"invalid_value",
    "message":"path: must be an absolute local filesystem path"}]}}}
```

Note the actionable sentence lives in `details.issues[].message`, **not** in the
top-level `message`. This client renders both.

The server also **canonicalizes through symlinks**: `open_binary` on `/bin/ls`
reports `path: "/usr/bin/ls"`. Callers must treat the returned path as
authoritative and key caches on it, not on the string they passed in.

## 5. Result envelopes

### Success

Two shapes exist, and they are not interchangeable:

1. **Evidence tools** — `structuredContent` is the Evidence record:

   ```jsonc
   { "evidence_id": "ev_…", "subject": …, "provider": …,
     "predicate_type": …, "operation": …,
     "normalized_result": { … },   // read this
     "raw_result": …,              // often null, else provider-native duplicate
     "confidence": …, "authority": …, "environment": …,
     "limitations": [ … ],          // what could not be established
     "relationship_coverage": …, "locations": …, "evidence_links": … }
   ```

   `analyze_function` with default `detail` returns paged summary Evidence whose
   `normalized_result.parent_evidence_id` points at the retained dossier; the
   dossier is read back with `inspect_analysis_view`.

2. **Discovery tools** — `binary_session` wraps its payload:
   `structuredContent = { result: { open, path, format, kind, sha256,
   architecture, capabilities, tool_availability, server_identity, … } }`.

### Failure — no `structuredContent`

This is the trap. A failed call returns `isError: true` **and** an
**undefined** `structuredContent`. The error contract arrives as a JSON string
inside `content[0].text`:

```
{ "error": { "code", "category", "message", "retryable",
             "remediation": { "action" }, "recovery", "details" } }
```

Any client that reads only `structuredContent` will report "no content" for
every failure. `src/mcp/errors.ts` parses both and renders a directive
observation.

### Provenance

Results derived from the analyzed target carry:

```json
"_meta": { "provenance": { "untrusted_content": true, "source": "analysis_target" } }
```

Strings, symbol names, comments, and decompiled code can therefore contain
attacker-controlled text. The engine prefixes those observations with an
explicit untrusted-data marker so the model does not treat binary content as
instructions.

## 6. Providers

REA is a **provider-composing MCP server**, not a Ghidra wrapper. On a host
without deep-analysis engines, `binary_session.capabilities` still listed
`native-macos` (unavailable), `rea-artifact-graph`, and `rea-dotnet-static`.

`open_binary` succeeds and reports identity (format, kind, sha256, architecture)
even with no deep provider bound. The next deep call degrades honestly:

```
TOOL_ERROR: REA rejected the call: provider_unavailable (unavailable)
The selected analysis provider is unavailable. Review the reported local
diagnostics or run `rea doctor`, then retry.
REA marked this failure retryable.
```

So the bundling story is: Ghidra is **one** provider to ship, selected via
`open_binary.provider_id` or `REA_ANALYSIS_PROVIDER`, not a structural
requirement of the client.

## 7. Transports

- **stdio** (default) — `rea mcp`. One process per client. This is what the
  engine uses and what `doctor` assumes.
- **HTTP** (opt-in) — `rea mcp --http [--host H] [--port N]`, serving `/mcp`,
  announced as a JSON log line on stderr. Plain HTTP, no TLS, no client auth,
  one client at a time. Bind validation is by loopback address class; a
  non-loopback bind requires `MCP_ALLOWED_HOSTS`.

The engine supports both (`rea.transport = "stdio" | "http"`).

## 8. Practical limits found while integrating

- **Advertised schema cost.** All 229 input schemas plus descriptions is far
  more than a 16k-context local model can hold alongside a conversation. REA's
  `REA_MCP_INPUT_SCHEMA_PROFILE=compact` reduces each schema but not the count.
  Hence client-side scoping.
- **`analyze_function` is the efficient primitive.** One dossier call replaces
  pseudocode + assembly + callers + xrefs + strings, which matters when each
  extra turn re-sends the whole transcript.
- **`binary_session` is cheap and authoritative** for open state, provider
  binding, and catalog identity; call it after every `open_binary` rather than
  tracking state client-side.
