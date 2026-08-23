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
