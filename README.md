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
| Log | `logs\app.log` inside this folder |
| Backups | `backups\` inside this folder, when you make one |

Chat files are plain JSON. Delete one and it is gone. Nothing is written anywhere else,
and nothing leaves the machine.

---

## Reliability

Three things that matter once you actually live in this app: it keeps a log, it can
hand you your chats back, and it can start itself at login.

### The log

Every run appends to `logs\app.log` — startup, shutdown, failed requests, and anything
that would otherwise have vanished with the console window. The path comes from
`config.json`:

```json
{ "storage": { "logFile": "./logs/app.log" } }
```

It is relative on purpose, so it follows the folder if you move it to another drive.
Set it to `""` to turn logging off entirely.

The file cannot grow without bound. At 2 MB it rotates: `app.log` becomes `app.log.1`,
`.1` becomes `.2`, and the fourth one is dropped. Three archives plus the active file
is the whole footprint.

Logging never takes the app down with it. If the path is unwritable — the drive filled
up, or something is sitting where the file should be — the logger switches itself off
and the app carries on. A log line is not worth losing a conversation over.

The same reasoning is why the server installs `unhandledRejection` and
`uncaughtException` handlers. Node's default is to exit on a stray rejection; here it
gets written to the log and the session keeps going.

### Backing up your chats

```
npm run backup                       creates backups\chats-<timestamp>.lsb
npm run backup -- D:/keep/chats.lsb  writes exactly there
```

One file holds the whole chats folder, gzipped, with a SHA-256 of every file inside it.
Copy it to a second drive and that is a real backup.

```
npm run restore -- backups\chats-2026-08-24T10-31-02.lsb
npm run restore -- <archive> --into D:/somewhere    restore beside the live folder first
npm run restore -- <archive> --force                write over a folder that is not empty
```

Restore checks every checksum in the archive *before* it writes anything. A truncated
or edited archive is refused with the destination still empty — a half-restored chat
folder is worse than no restore, because it looks like it worked. It also refuses a
destination that already holds files unless you pass `--force`, so an old backup cannot
land on top of a live folder by accident. Restoring into an empty folder to look first
costs nothing.

The archive format is a header plus the file bytes; there is no dependency involved and
nothing to install to read it back.

### Starting at login

```
npm run autostart              is it on?
npm run autostart install
npm run autostart uninstall
```

Install writes one file — `landslide-local.cmd` — into your own Startup folder
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`). No registry key, no
scheduled task, no administrator prompt. Deleting that file by hand is a complete
uninstall, and `uninstall` removes it only if it is the file this app wrote, so a
shortcut you put there yourself is never touched.

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
