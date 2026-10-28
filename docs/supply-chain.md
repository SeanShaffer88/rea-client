# Supply-chain verification

The bundle ships a copy of `rea-agents` inside the installer. That makes the
question "what code is actually running?" a question about a directory on disk,
not about a registry install — and the answer has to be checkable without a
network, on a machine that has none.

```
vendor/rea-agents.manifest.json     committed: the reviewed tree, file by file
        │
        ├── build time (connected):  anchored to the published tarball integrity
        │
        └── run/CI time (offline):   re-hashed and compared, no network needed
```

## Why a manifest and not just a lockfile

`package-lock.json` pins *which versions* resolve. It says nothing about what is
on disk after `npm ci` — a lifecycle script can rewrite a file, a partial upgrade
can leave a mixed tree, and a locally edited file is invisible to it.

For a tool that parses untrusted binaries, the difference matters: verifying
`rea-agents` is the specific defence against the client being run against code
nobody reviewed.

## Why the manifest alone is not enough

A manifest proves *"this tree has not changed since the manifest was written."*
It does not prove the tree is the code that was published, because whoever wrote
the manifest could have hashed anything.

The anchor closes that gap. `dist.integrity` is a sha512 over the exact tarball
bytes, recorded by npm at publish time. `vendor manifest` downloads that
tarball, verifies the hash, and refuses to record a manifest if the directory
does not match the archive contents. The integrity string is stored in the
manifest, so the artifact stays identifiable offline later.

```
registry dist.integrity ──► tarball bytes ──► archive entries ──► compare ──► manifest
                             (sha512 gate)      (per-file sha256)   to tree
```

## Commands

Record a manifest (needs network; run at vendoring time):

```bash
node dist/cli.js vendor manifest node_modules/rea-agents \
  --out vendor/rea-agents.manifest.json
```

Verify a tree (offline):

```bash
node dist/cli.js vendor verify node_modules/rea-agents \
  --manifest vendor/rea-agents.manifest.json
```

```
OK  rea-agents@6.8.0: 2398 files match the manifest
    anchored to sha512-9QDeRnGqEDzABZyr04eLnBXBv/c6I9/TWu/6M0MD4pEfkySI/BIgwTODIbAReX3C1x6hjw9+Jlx4A2yUSPZ9ww==
```

Drift is reported per path, with distinct categories so the cause is obvious:

```
DRIFT  rea-agents@6.8.0 does not match its manifest
  - modified: dist/index.js
  - unexpected: dist/backdoor.js
  - missing: dist/old.js
```

Exit codes: `0` clean, `1` drift or verification failure, `2` bad usage. `--json`
emits the full result for tooling.

## Current state

| | |
| --- | --- |
| Package | `rea-agents` |
| Version | `6.8.0` |
| Files | **2398** |
| Total size | 49,251,336 bytes |
| Tarball integrity | `sha512-9QDeRnGq…USPZ9ww==` |
| Tarball sha256 | `8d542ec76a9cb350584b60a6c9c088706ff812d5bb5b094c20c95b6dc25698bb` |

Verified: the installed tree matches the published tarball exactly — 0 missing,
0 extra, 0 modified — and the archive's file count and unpacked size agree with
the registry metadata.

## CI enforcement

`.github/workflows/ci.yml` verifies the vendored dependency after the build and
before the test suite, so a tampered or drifted dependency fails the job instead
of being silently tested:

```yaml
- name: Verify vendored dependency
  run: node dist/cli.js vendor verify node_modules/rea-agents \
    --manifest vendor/rea-agents.manifest.json
```

The placement matters: it runs `dist/cli.js`, so it must follow the build.

## Assessing advisories: which copy ships, and is it reachable

`vendor verify` answers "is this the tree we signed off on". It cannot answer
"is this tree dangerous", because a byte-identical tree can still contain a
vulnerable dependency. `vendor advisories` covers that second question.

```bash
node dist/cli.js vendor advisories zod \
  --advisories vendor/advisories/zod.ghsa.json \
  --accept vendor/advisories/accepted.json
```

Three things make this different from `npm audit`:

**1. It resolves the advisory against every installed copy, not the hoisted one.**
`rea-agents@6.8.0` pins `zod` to exactly `4.4.3`, so npm nests it at
`node_modules/rea-agents/node_modules/zod` while the top-level `zod` is `4.6.7`.
`npm audit` reports zero production vulnerabilities for this project — true for
the hoisted copy, and irrelevant, because the copy REA validates its tool
arguments with is the nested one, inside the vulnerable range.

**2. It assesses reachability, not just version ranges.** A vulnerable package on
a path an attacker cannot drive is paperwork. This weakness (GHSA-mrhx-c7xc-m3w5,
CVSS 7.5) needs an array schema without a length limit fed a large array, so the
check enumerates array parameters in the live tool surface: **69 of 74** have no
`maxItems`. Combined with the fact that tool arguments are produced by a local
model reading strings out of an untrusted binary, the verdict is `REACHABLE`.

**3. "Could not check" fails the gate.** Verdicts are three-valued — `reachable`,
`not-reachable`, `undetermined` — and `undetermined` at or above `--deny`
(default `high`) blocks unless `--allow-undetermined` is passed explicitly. A
lookup that cannot complete (no network, HTTP 500) is reported as an error and
exits non-zero rather than printing a clean bill of health. For the same reason
a range the semver matcher cannot parse is treated as affecting, never as safe.

### Acceptance with an expiry

`--accept` reads findings that were reviewed and accepted. Each entry requires a
`rationale`, a `mitigation`, and a `reviewedAt` date; `reviewBy` marks when the
decision must be revisited, and an expired acceptance prints a warning. A
suppression list without reasons is how regressions get buried, so the file
format refuses entries that lack them.

### The compensating control

Accepting the risk is only honest if something actually reduces it. The nested
`zod` cannot be upgraded from here (it is `rea-agents`' exact pin), so
`src/agent/argumentGuard.ts` bounds every outbound tool call — 256 array items
and 64 KiB of serialized arguments by default, both configurable under
`agent.maxArgumentArrayItems` / `agent.maxArgumentBytes`. An oversized payload is
rejected **before dispatch**, so it never reaches REA's validator at all.
`test/unit/agentSession.test.ts` asserts the tool is not called.

That guard is why the `zod` finding is accepted rather than merely tolerated.
Remove it and the acceptance is no longer justified.

### Offline operation

`vendor/advisories/zod.ghsa.json` is a recording of the GitHub Advisory Database
response, so the check works on an air-gapped machine and in CI. `npm run
advisories:refresh` re-records it when you are online. `REA_ADVISORY_API`
redirects the lookup at an internal mirror.

Recorded data goes stale. CI therefore gates on **the tree and the decision, not
on upstream news**: it proves no *new* nested copy entered the range and that the
acceptance was reviewed. Refreshing the recording is a deliberate, reviewable
act — and the `reviewBy` date is the reminder to do it.

## Upgrading the vendored dependency

1. `npm install rea-agents@<new>`
2. `node dist/cli.js vendor manifest node_modules/rea-agents --out vendor/rea-agents.manifest.json`
3. Review the manifest diff — added and removed paths are the upgrade's real content
4. Re-run `npm run test:all`; the integration suite asserts the version it expects

Step 2 fails if the installed tree does not match the published tarball, so an
upgrade cannot quietly vendor a tree that the registry never served.

## Notes and limits

- **Store manifests outside the tree they describe.** A manifest written into the
  package directory is itself an unexpected file; `vendor verify` warns about
  this explicitly.
- **Symlinks are hashed by target string**, not by content, so a retargeted link
  is reported as drift rather than followed.
- **Path traversal and absolute entries in an archive are rejected**, so a
  malicious tarball cannot write outside the expected root.
- **The tar reader is intentionally narrow**: ustar plus the pax and GNU
  long-name extensions npm needs. Unknown entry types fail loudly rather than
  producing a manifest that omits them.
- **This verifies provenance, not safety.** A correctly-signed tarball can still
  contain a vulnerable dependency — that is what `vendor advisories` is for, and
  the `zod` case shows why the two checks are not substitutes.
- **Reachability is modelled per weakness class.** Only unbounded-array resource
  exhaustion is understood today; every other advisory affecting an installed
  copy is reported `undetermined`, which blocks. Widening the model is safer than
  widening a suppression list.
