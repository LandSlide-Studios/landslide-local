# Landslide Local

A private, offline chat client for uncensored local language models.

No accounts, no telemetry, no network. The app, the models and every conversation
stay on your machine. It talks to [Ollama](https://ollama.com) (or llama.cpp) over
loopback and to nothing else — a check in the test suite greps every shipped file
for an external host and fails the build if one appears.

**Zero dependencies.** Node's standard library only. No `npm install`, no lockfile,
no supply chain. The markdown renderer, the archive format and the MCP protocol
implementation are all written here.

---

## What it does

- **Five models, one sidebar.** Switch mid-conversation. Each card says whether it
  actually fits your VRAM *before* you pick it.
- **Reasoning shown separately.** Models that think stream their reasoning into a
  panel that opens while they work and folds away when the answer starts.
- **Markdown that renders.** Headings, nested lists, tables, code — with a
  per-model profile, because a prose model and a table-heavy model write
  differently.
- **Context budgeting.** Long chats are trimmed oldest-first *with the count
  reported*, rather than silently forgotten by the runtime.
- **A system prompt that reaches the model**, saved per chat, with a prompt library.
- **Optional AES-256-GCM encryption at rest** and an optional loopback auth token.
- **An MCP server**, so an MCP client can call your local models as tools.
- Live timer, tokens/sec, time-to-first-token, regenerate, markdown export,
  search, backup and restore, start-at-login.

---

## Requirements

| | |
|---|---|
| **Node** | 22 or newer |
| **Ollama** | 0.32 or newer — earlier versions predate the Qwen 3.5 architecture |
| **GPU** | Any. The sizing below assumes 8 GB; the smaller models want far less |
| **Disk** | ~21 GiB for all five models, or ~1.2 GiB for just the smallest |

Windows, macOS and Linux — CI runs the suite on all three. Start-at-login is
Windows-only today.

---

## Install

```bash
git clone https://github.com/LandSlide-Studios/landslide-local.git
cd landslide-local
node scripts/fetch-models.mjs      # downloads and registers the models
npm start                          # http://127.0.0.1:4390
```

No build step and nothing to install — `npm start` is `node src/server.js`.

To try the interface before committing 21 GiB of downloads, `npm run demo` runs the
whole app against a scripted fake model.

**Ollama settings that matter on 8 GB.** Flash attention and an 8-bit KV cache
roughly halve context memory, which is what lets a 9B run entirely on the GPU:

```bash
setx OLLAMA_FLASH_ATTENTION 1
setx OLLAMA_KV_CACHE_TYPE q8_0
setx OLLAMA_CONTEXT_LENGTH 16384
```

Machine-specific settings — where models live, your GPU, a token — belong in
`config.local.json`, which git ignores. Copy `config.example.json` to start.

---

## The models

These are [DavidAU](https://huggingface.co/DavidAU)'s Qwen 3.5 variants, processed
with [Heretic](https://github.com/p-e-w/heretic) to remove refusal behaviour. They
are ordinary GGUF files — the app has no opinion about which models you run, and
`models.json` is a plain data file you can edit.

**Speeds are measured on an RTX 5060 (8 GB), warm model.** Not estimated.

| Model | Size | Fit on 8 GB | Measured | For |
|---|---|---|---|---|
| **Heretic Instruct** 9B | 4.97 GiB | fits | **73 tok/s**, 0.3 s to first token | No reasoning block. The daily driver |
| **Cold Fusion GAIN** 9B | 5.23 GiB | fits | **66 tok/s** | Best all-rounder; tables, code, structure |
| **Deckard** 4B | 2.52 GiB | fits | **107 tok/s** | Fiction, voice, roleplay |
| **Auto-Variable** 2B | 1.19 GiB | fits | **125 tok/s** | Quick rewrites and drafting |
| **GLM-Flash Heretic** 21B | 7.32 GiB | **spills** | **8.9 tok/s** | Smartest here — and it took 3m 15s to answer one short question |

The 21B is the honest disappointment: it does not fit in 8 GB, so part of it runs on
system RAM. Keep it for something you can walk away from.

A reasoning model's wall-clock is dominated by how long it *thinks*, not by tok/s.
The 4B once spent 2,869 reasoning tokens on a single sentence.

`node scripts/check-uncensored.mjs` measures refusal behaviour rather than trusting
a flag in the catalog — a claim that checks itself proves nothing. All five score
0/4 refused.

---

## Architecture

Deep modules behind small interfaces, with real seams: every abstraction has at
least two live implementations, so none of them is speculative.

| Module | Interface | Adapters |
|---|---|---|
| `InferenceRuntime` | `listModels · chat · health` | Ollama, llama.cpp, fake |
| `ChatStore` | `list · get · create · append · search` | JSON file, encrypted, in-memory |
| `ThinkStream` | `feed(chunk) → events` | pure |
| `ContextBudget` | `planContext(…)` | pure |
| `RuntimeSupervisor` | `status · start · warm · unload` | Ollama |

The runtime facade owns everything a caller cares about — reasoning separation,
timing, token accounting, abort. Adapters carry protocol only: NDJSON for Ollama,
SSE for llama.cpp. Switching backends is one line of config.

Front end and back end share one event vocabulary (`public/shared/events.js`), so a
renamed event is a broken import rather than a silent mismatch.

No file exceeds 400 lines.

---

## Tests

```bash
npm test              # 228 tests
npm run preflight     # environment, offline check, model availability
npm run verify-live   # proves the real path against an actual model
```

Three things about the suite that are deliberate and slightly unusual:

**Acceptance tests are written before the code, and checksummed.** Each feature has
a suite under `test/acceptance/` authored ahead of its implementation and locked
with SHA-256. `npm run lock` fails if one changed. An implementer who can edit its
own acceptance test can always pass it, and every review after that is theatre.

**The UI test has no browser engine.** `test/ui.test.js` parses the real
`index.html` into a DOM shim, imports the real front end against it, and drives a
full send → stream → render cycle with no Playwright and no jsdom. It is verified
to *fail* when the app breaks: forcing the status bar visible fails 4 of its 8 tests.

**`verify-live` checks the reasoning path specifically.** The worst bug this project
had was a dropped `message.thinking` field — reasoning arrived from the model, never
reached the page, and shipped past a green suite *and* a green preflight, because
the fake adapter emits inline `<think>` tags and Ollama does not. A live check that
only looked for an answer would have waved it through too.

---

## Calling your local models from an MCP client

`src/mcp/server.js` speaks JSON-RPC 2.0 over stdio, with no SDK.

```bash
claude mcp add landslide-local -- node /path/to/landslide-local/src/mcp/server.js
```

| Tool | Does |
|---|---|
| `ask_local_model` | Runs a prompt against one of the catalogued models |
| `list_local_models` | Lists them with sizes and fit verdicts |
| `search_chats` | Searches your saved conversations |

Three tools, no filesystem, no shell. The `model` argument is looked up in the
catalog and the caller's string is never passed through — without that guard a
client could name any model in your Ollama registry, including one far too large
for your card.

---

## Where your data is

| | |
|---|---|
| Chats | `./chats` — one JSON file per conversation |
| Models | wherever `modelsDir` points; Ollama also keeps its own copy |
| Logs | `./logs/app.log`, rotated at 2 MB |

Chat files are plain JSON. Back them up by copying the folder, or `npm run backup`.
With encryption enabled they are AES-256-GCM, and **a forgotten passphrase means
they are gone** — there is no recovery, by design.

---

## Limitations

Stated plainly, because a README that only lists strengths is an advertisement.

- **No hosted demo is possible.** It needs a local model server; that is the point.
- **Vision is unavailable.** Qwen 3.5 is multimodal, but the quants bundled here
  ship without the projector file.
- **Start-at-login is Windows-only.**
- **Single user.** Writes are serialised per chat; there is no multi-user story.
- **Plain JavaScript, no types.**
- The context estimate is a heuristic that deliberately over-counts, not a real
  tokenizer.
- The bundled models have had their refusal behaviour removed. They will attempt
  whatever they are asked. What you do with that is on you.

---

## Licence

MIT — see [LICENSE](LICENSE).
