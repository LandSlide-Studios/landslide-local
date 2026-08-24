# Landslide Local

An offline chat client for five uncensored Qwen 3.5 models, tuned for an RTX 5060 (8 GB).

No accounts, no telemetry, no internet. Everything — the app, the models, the chat
history — sits on your N: drive.

---

## First run

**1. Ollama must be 0.32 or newer.** Anything from the 0.x series before that predates
Qwen 3.5 and cannot load these models. This machine is on **0.32.15**, so there is
nothing to do here; on a fresh machine:

```
winget upgrade --id Ollama.Ollama
```

`npm run preflight` prints the version it actually found and warns if it is too old.

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

## Starting the models

You do not need to start Ollama yourself. If it is not running, the sidebar says so
and gives you a **Start Ollama** button - one click, and the app waits until the
server actually answers before clearing the warning.

This is more reliable than launching Ollama from the Start Menu, because the app
passes the environment from `config.json` (`runtime.ollamaEnv`) when it starts it.
That is what guarantees the model store on N: is found. A Start Menu launch inherits
whatever environment Explorer happens to be holding, which is how `ollama list` came
back empty after the store moved.

**Preload** on each model card loads it into VRAM ahead of time. Loading a 9B off the
SSD costs about 20 seconds, and without preloading you pay that on your first message.
A model already resident shows **in VRAM** instead.

Once loaded, a model stays resident for 30 minutes after the last request that touched
it. Both the preload and every chat message ask for the same 30 minutes, and both ask
for the same context size — otherwise Ollama resets the timer to its own 5-minute
default and reloads the model at a different context on the first message, which is
exactly the reload the preload was meant to avoid. This applies to Ollama; llama-server
has no equivalent and keeps its model loaded for as long as it runs.

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

## Calling these models from Claude (MCP)

`src/mcp/server.js` is an MCP server, so Claude — or any other MCP client — can hand
work to the models on this machine. That is the point of it: a prompt you would rather
not send to a hosted model, or one you want answered without a filter, gets delegated
here instead, and the whole exchange stays on the N: drive.

It speaks MCP's stdio transport directly (JSON-RPC 2.0, one message per line). There is
no SDK and nothing to install — same zero-dependency rule as the rest of the app.

**Register it.** In Claude Code:

```
claude mcp add landslide-local -- node N:\landslide-local\src\mcp\server.js
```

Or paste this into the client's MCP config file (Claude Desktop:
`%APPDATA%\Claude\claude_desktop_config.json`) and restart the client:

```json
{
  "mcpServers": {
    "landslide-local": {
      "command": "node",
      "args": ["N:\\landslide-local\\src\\mcp\\server.js"]
    }
  }
}
```

The doubled backslashes are JSON escaping, not a typo — `N:/landslide-local/src/mcp/server.js`
works just as well and is easier to read. Ollama has to be running for
`ask_local_model` to answer; the other two tools work regardless.

**The three tools**, which are the entire surface:

| Tool | Does |
|---|---|
| `ask_local_model` | Sends one prompt to one catalogued model and returns the answer. Optional `model` (defaults to `heretic-instruct-9b`) and `system`. Reasoning is stripped; you get the answer |
| `list_local_models` | The five ids, their size, whether Ollama has them installed, and whether each fits in 8 GB |
| `search_chats` | Searches the chats in `N:\landslide-local\chats` by title and message text |

There is no filesystem tool, no shell tool, and no way to pass a raw model tag. A model
with its refusal behaviour removed, reachable as a tool, should be able to write text
and nothing else. `ask_local_model` looks its `model` argument up in the catalog rather
than forwarding it, so a request naming anything else in the local registry — this
machine also has `dolphin-llama3:70b` registered, 37.22 GiB against 8 GB of VRAM — is
refused rather than loaded.

**If you are editing it:** stdout is the transport. A single line of ordinary output
written there corrupts the stream for the rest of the session, which is why every
diagnostic in that file goes to stderr, and why the acceptance suite greps the source
for the function that writes to stdout.

To check it by hand without a client at all, pipe three messages into it:

```
(echo {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}} ^
 & echo {"jsonrpc":"2.0","id":2,"method":"tools/list"} ^
 & echo {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_local_models","arguments":{}}}) ^
 | node src\mcp\server.js
```

Three JSON lines come back on stdout, the startup line and per-call timings on stderr.

---

## Checking it still works

```
npm run test:core # the five core suites: 79 tests, none of which touches a model
npm run preflight # environment, fonts, models, and the offline check
```

`npm test` runs everything in the folder instead, acceptance suites included — and
those describe work that is still queued, so it reports failures on purpose. Use it
to see what is left, not to decide whether the app is healthy.

Neither of the two commands above touches a model. To prove the whole path really works - Ollama up,
store readable, a real model generating, and the reply saved - double-click
`verify.cmd` or run:

```
node scripts/verify-live.mjs
```

That is the one to run after a reboot.

Preflight's `offline` check greps every served and runtime file for an external host.
If it passes, the app genuinely has no network dependency.

---

## Switching to llama.cpp

Ollama's Qwen 3.5 support has known rough edges and llama-server is faster on the same
GGUF. Start `llama-server` on port 8080, then change one line in `config.json`:

```json
{ "runtime": { "adapter": "llamacpp" } }
```

Chatting works immediately: both runtimes sit behind the same interface, and the
sidebar names whichever one is configured and reports its real health.

What does **not** carry over, because it is Ollama-specific:

- **Start Ollama** — the app can only launch Ollama. Start `llama-server` yourself.
- **Preload / in VRAM** — llama-server holds one model for its whole lifetime;
  there is nothing to preload and no residency list to show.
- **Model choice** — llama-server serves the single GGUF it was started with, so
  picking another card in the sidebar does not switch models. Restart it with a
  different `-m` instead.
- `fetch-models.mjs --cleanup-raw` — it deletes a raw GGUF only once Ollama's registry
  holds a copy. With llama.cpp the raw file *is* the model. Never run it.

So: one line to switch what answers, and four Ollama-only conveniences you lose.
