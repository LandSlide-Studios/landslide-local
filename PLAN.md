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

## Phase 5 — Live run (needs Tommy)

| # | Item | Status | Blocking on |
|---|---|---|---|
| T-20 | Update Ollama past 0.7.0 | blocked | Tommy — `winget upgrade --id Ollama.Ollama` |
| T-21 | Download the 5 GGUFs (~22.8 GB) | blocked | T-20, and ~30 min of bandwidth |
| T-22 | Measure real tokens/sec per model and correct the README | blocked | T-21 |

Everything up to T-19 is verified. T-20 onward cannot be done for him: the Ollama
update is a machine change and the download is his bandwidth. The speed figures in
the earlier analysis are calculated from memory bandwidth, **not measured** — T-22 is
what turns them into facts.
