# Landslide Local

An offline chat client for five uncensored Qwen 3.5 models, tuned for an RTX 5060 (8 GB).

No accounts, no telemetry, no internet. Everything — the app, the models, the chat
history — sits on your N: drive.

---

## First run

**1. Update Ollama.** Your installed 0.7.0 predates Qwen 3.5 and cannot load these models.

```
winget upgrade --id Ollama.Ollama
```

**2. Set the Ollama environment once.** These matter a great deal on 8 GB of VRAM —
flash attention plus an 8-bit KV cache roughly halves context memory, which is what
buys the 9B models room to run entirely on the GPU.

```
setx OLLAMA_CONTEXT_LENGTH 16384
setx OLLAMA_FLASH_ATTENTION 1
setx OLLAMA_KV_CACHE_TYPE q8_0
```

**3. Download the models** (~21.2 GiB / 22.8 GB, one time, resumable).

```
node scripts/fetch-models.mjs
```

Or just one to start: `node scripts/fetch-models.mjs deckard-4b`

**4. Start it.** Double-click `start.cmd`, or:

```
npm start
```

Then open <http://127.0.0.1:4390>.

To try the interface before downloading anything, double-click `start-demo.cmd` — it
runs the whole app against a scripted fake model.

---

## The models

All five are uncensored (Heretic-processed). Sizes are the real GGUF download.

Speeds below are **measured on this machine** (RTX 5060 8 GB, warm model), not estimated.

| Model | Size | Fit | Measured | What it is for |
|---|---|---|---|---|
| **Heretic Instruct** 9B | 4.97 GiB | fits | **73 tok/s**, 0.3s to first token | No reasoning block — answers immediately. The daily driver |
| **Cold Fusion GAIN** 9B | 5.23 GiB | fits | **66 tok/s** | Best all-rounder; sharpest at tables, code and structure |
| **Deckard** 4B | 2.52 GiB | fits | **107 tok/s** | Fast and characterful — fiction, voice, roleplay |
| **Auto-Variable** 2B | 1.19 GiB | fits | **125 tok/s** | Near-instant, for quick rewrites and drafting |
| **GLM-Flash Heretic** 21B | 7.32 GiB | spills | **8.9 tok/s** | Smartest here — and it took 3m15s to answer one short question |

The 21B is the honest disappointment: it does not fit in 8 GB, so part of it runs on
DDR4-2133 system RAM. One sentence cost 195 seconds. Keep it for something you are
willing to walk away from.

A reasoning model's wall-clock is dominated by how long it thinks, not by tok/s — the
4B spent 2,869 tokens reasoning about a single sentence. The Instruct model skips that
entirely, which is why it feels several times faster than its 73 tok/s suggests.

Sizes are GiB, the same unit VRAM is measured in (Hugging Face shows decimal GB, which
reads about 7% larger).

---

## Using it

| | |
|---|---|
| `Enter` | send |
| `Shift`+`Enter` | new line |
| `Ctrl`+`K` | search chats |
| `Ctrl`+`N` | new chat |
| `Esc` | stop generating |

Pick a model in the left sidebar. Switching models mid-conversation is fine — the
next turn uses the new one. The reasoning panel opens itself while the model thinks
and folds away once it starts answering; click it any time to reread.

The status bar shows a live timer while generating, then each reply records how long
it took, time to first token, token count and tokens per second.

---

## Where your data is

| | |
|---|---|
| Chats | `N:\landslide-local\chats` — one JSON file per conversation |
| Models | `N:\models` |

Chat files are plain JSON. Back them up by copying the folder; delete one and it is
gone. Nothing is written anywhere else.

---

## Checking it still works

```
npm test          # 58 tests
npm run preflight # environment, fonts, models, and the offline check
```

Preflight's `offline` check greps every served and runtime file for an external host.
If it passes, the app genuinely has no network dependency.

---

## Switching to llama.cpp

Ollama's Qwen 3.5 support has known rough edges and llama-server is faster on the same
GGUF. Start `llama-server` on port 8080, then change one line in `config.json`:

```json
{ "runtime": { "adapter": "llamacpp" } }
```

That is the entire migration — the app talks to both through the same interface.
