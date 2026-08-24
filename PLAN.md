# Landslide Local — build plan

Status legend: `done` · `todo` · `blocked`

## Phase 1 — Core (done, tag `phase-1-core`)

| # | Item | Status | Done when |
|---|---|---|---|
| T-01 | `ThinkStream` splits reasoning from answer across chunk boundaries | done | [x] tags split at every chunk size 1–23 still parse |
| T-02 | `ChatStore` with json + memory adapters | done | [x] one contract suite passes against both |
| T-03 | Atomic writes and corrupt-file quarantine | done | [x] a corrupt file is renamed, list still works |
| T-04 | `ModelCatalog` with verified GGUF filenames and sizes | done | [x] every size matches the Hugging Face repo |

## Phase 2 — Server (done, tag `phase-2-server`)

| # | Item | Status | Done when |
|---|---|---|---|
| T-05 | `InferenceRuntime` facade owning think/timing/abort | done | [x] fake adapter drives every facade behaviour |
| T-06 | Ollama adapter (NDJSON) | done | [x] streams and reports eval counts |
| T-07 | llama.cpp adapter (SSE, OpenAI shape) | done | [x] second real adapter exists, so the seam is earned |
| T-08 | HTTP API with SSE streaming | done | [x] both turns persist; unknown model is a 400 |
| T-09 | Loopback server, path containment, static serving | done | [x] traversal rejected; non-loopback Origin rejected |

## Phase 3 — Interface (done)

| # | Item | Status | Done when |
|---|---|---|---|
| T-10 | Sidebar model picker with honest VRAM fit badges | done | [x] 21B reads "spills", not "fits" |
| T-11 | Multiple chats: create, open, rename, delete, search | done | [x] survives a reload from disk |
| T-12 | Streaming reply with reasoning panel | done | [x] panel opens while thinking, folds when writing |
| T-13 | Live timer + per-message stats | done | [x] sub-second values show ms, not "0.0s" |
| T-14 | Composer: auto-grow, Enter/Shift+Enter, char count, shortcuts | done | [x] verified in Chrome, not just asserted |
| T-15 | Landslide neobrutalist styling, fonts bundled locally | done | [x] `document.fonts.check` true for both faces |

## Phase 4 — Provisioning and verification (done)

| # | Item | Status | Done when |
|---|---|---|---|
| T-16 | `fetch-models.mjs` — resumable download + Ollama registration | done | [x] resumes with a Range request rather than restarting |
| T-17 | `preflight.mjs` — offline proof, fonts, deps, models, runtime | done | [x] 0 FAIL |
| T-18 | Launchers, README, CLAUDE.md | done | [x] double-click starts it |
| T-19 | Adversarial review by a separate agent | done | [x] findings triaged; real ones fixed |

## Phase 5 — Live run (done)

| # | Item | Status | Done when |
|---|---|---|---|
| T-20 | Update Ollama past 0.7.0 | done | [x] 0.7.0 -> 0.32.15 |
| T-21 | Download and register the 5 GGUFs | done | [x] 5/5 in the registry |
| T-22 | Measure real tokens/sec and correct the README | done | [x] all five measured, estimates removed |
| T-23 | Move the Ollama store to N: and delete raw GGUFs | done | [x] 60 GB moved, 21.2 GiB reclaimed, generation proven first |

## Phase 6 — Found only by running it for real

| # | Item | Status | Note |
|---|---|---|---|
| T-24 | Ollama 0.32 streams reasoning in `message.thinking` | done | [x] adapter read only `content`, so every reasoning token was dropped |
| T-25 | Throughput used our stream window, not the server's eval clock | done | [x] reported 420 tok/s where the truth was 66 |
| T-26 | Reasoning panel re-rendered and reflowed per token | done | [x] locked the renderer on a 2,869-token reasoning pass |

None of these were reachable with the fake adapter — its scripts are 200 characters
long and carry `<think>` tags inline. Only a real model on real hardware exposed them.

---

# Phase 8 — Seven-category hardening (build-loop)

Approved scope: categories 1-7 of the improvement roadmap. Nothing outside this
table gets built; anything discovered along the way is noted for Tommy, not
absorbed.

## The loop protocol (anti-bias)

The weakness in a plain build-review loop is that the reviewer inherits the
builder's framing. Every mechanism below exists to break that.

**1. Acceptance criteria are written before the build.**
Each item gets an executable suite at `test/acceptance/<item>.test.js`, authored
by the planner, not the builder. The builder is told the criteria and is
**forbidden to edit any file under `test/acceptance/`**.

**2. The acceptance suite is checksummed.**
`scripts/acceptance-lock.mjs` records a SHA-256 per acceptance file before the
build and re-checks after. **A changed checksum is an automatic FAIL for that
round**, regardless of test results. This is the mechanism that stops a builder
from tuning the target to fit the shot.

**3. The verifier is air-gapped.**
The verifying subagent receives ONLY: the repo path, and the acceptance criteria
for its category, written as a black-box spec. It does **not** receive the diff,
the builder's report, the branch name, the round number, or any statement that
the work is finished. It is instructed to assume the feature is broken and to
find the failure, and to write its own probes rather than only running ours.

**4. One verifier per category.**
Seven independent verifications, each ignorant of the others.

**5. Verdict is machine-checked, not narrated.**
An item closes only when: acceptance suite green, checksum intact, full `node --test`
green, `preflight` 0 FAIL, and `verify-live` green. A verifier's prose opinion
cannot close an item, and cannot by itself keep one open if every gate passes -
it is recorded as a finding for the next round instead.

**6. Three rounds, then blocked.**
A fourth round means the item was underspecified. Mark `blocked` with the reason
and move on rather than grinding.

## Gates (every item, every round)

```
node scripts/acceptance-lock.mjs --verify   # checksums intact
node --test --test-force-exit               # whole suite incl. acceptance
node scripts/preflight.mjs                  # 0 FAIL
node scripts/verify-live.mjs                # reaches a real model
```

`--test-force-exit` is required, not cosmetic. An acceptance test that fails
skips its own trailing `close()`, leaking a listening server that holds the
event loop open forever - the runner printed a correct summary and then hung.
The flag is the fix; the leak itself is logged as a harness debt item.

## Branching

No git remote exists, so "open a PR" is not available. Equivalent gate: each item
builds on `loop/<slug>` and merges into `loop/integration`. **`master` is not
touched.** Tommy's approval to merge `loop/integration` into `master` is the
second approval the loop is designed to stop at.

## Queue

| # | Item | Status | Branch | Done when |
|---|------|--------|--------|-----------|
| I0 | Second-review findings: C1 raw-GGUF deleted by name not identity (data loss), I2 poll lies about which adapter is live, I3 preload keep_alive/num_ctx mismatch so it does not actually help, I4 streamed code blocks render outside the code box, I5 `runtimeModelTag`/`options` bypass the catalog, M6 failed newChat wedges the composer, M7 preload failure shows nothing, M8 switching chats mid-stream eats the reply, M9 spawn errors swallowed, L10-L14, plus the false README/CLAUDE claims | done | loop/i0-review-findings | acceptance/i0 green: cleanup cannot delete a file whose size disagrees with the registry entry; the adapter shown is the adapter configured; a warmed model serves the next message without reloading; a stream ending inside a fence renders identically to a reload; no request-supplied string reaches the runtime as a model id |
| I8 | Per-model output formatting: render markdown (headings, lists, bold, tables, blockquotes) not just fenced code, with a per-model profile so a prose model and a table-heavy model each render the way they actually write | building | loop/i8-formatting | acceptance/i8 green: markdown tables, lists, headings and emphasis render as elements not literal asterisks; each catalog model declares a format profile; model output is still never inserted as HTML |
| I1 | Quality of life: context meter + auto-trim, system prompt panel, regenerate/edit/branch, parameter controls, rename in UI, markdown export, unload-model, prompt library, model-list keyboard nav, auto-preload on select | todo | - | acceptance/i1 green: a chat exceeding num_ctx never silently drops turns; a system prompt set in the UI reaches the model; regenerate replaces the last reply; every listed control is reachable by keyboard |
| I2 | Architecture: catalog becomes data (`models.json`), split `api.js`, split `public/app.js` into ES modules, one shared event-schema module used by both sides, single explicit reasoning path | todo | - | acceptance/i2 green: adding a model requires no source edit; no file over 400 lines in `src/` or `public/`; front and back import the same event constants; `node --test` still green |
| I3 | MCP: server exposing local models to Claude (`ask_local_model`, `list_local_models`, `search_chats`) over stdio, zero dependencies | done | loop/i3-mcp | acceptance/i3 green: the server speaks MCP initialize/tools-list/tools-call over stdio and returns a real completion from a local model; refuses unknown model ids |
| I4 | Security & privacy: at-rest encryption for chats (opt-in, node:crypto), loopback auth token, app lock | building | loop/i4-security | acceptance/i4 green: with encryption on, no plaintext message body appears in any file on disk; a request without the token is refused; existing plaintext chats migrate without loss |
| I5 | Performance: auto-preload selected model, `num_batch` tuning, search index, documented llama.cpp/MTP path | todo | - | acceptance/i5 green: search over 500 synthetic chats completes under 200ms; selecting a model preloads it; no regression in measured tok/s |
| I6 | Reliability & ops: start-on-login, rotating log file, chat backup/restore, server auto-restart | done | loop/i6-reliability | acceptance/i6 green: logs are written and rotate at a size cap; backup produces a restorable archive and restore round-trips byte-identical; install/uninstall of the login entry is reversible |
| I7 | Testing gaps: headless browser-level UI test, long-stream soak test, verify-live exercises the thinking path on a slow model | building | loop/i7-testing | acceptance/i7 green: a UI test drives a real conversation and asserts DOM state without a human; a 20k-character reasoning stream renders without the main thread blocking over 100ms |

Status: `todo` · `building` · `review` · `done` · `blocked`
