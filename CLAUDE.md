# Landslide Local — folder rules

Offline chat client for uncensored Qwen 3.5 GGUF models. Runs on Tommy's machine only.

## Hard constraints — do not break these

1. **Zero npm dependencies.** Node 22 stdlib only. `package.json` has no `dependencies`
   or `devDependencies` and must stay that way. `npm run preflight` fails the build if
   one appears. The whole point is that this installs and runs with no network.
2. **No external hosts anywhere in `src/` or `public/`.** No CDN scripts, no Google
   Fonts link, no remote images. Fonts are local `.woff2` files in `public/fonts`.
   `scripts/fetch-models.mjs` is the single exempt file — it is the one-time downloader.
   Preflight greps for this and FAILs on a violation.
3. **Model output never reaches `innerHTML`.** `renderText` in `public/app.js` builds
   text nodes and `<pre><code>` elements only. An uncensored local model is untrusted
   input like any other.
4. **Loopback only.** The server binds `127.0.0.1` and rejects non-loopback `Origin`.
   Do not add a `0.0.0.0` bind or a CORS allowance.

## Where things live

| Path | Holds |
|---|---|
| `N:\landslide-local` | the app (this folder) — SATA SSD, not the M.2 |
| `N:\models` | the GGUF files, ~22.8 GB. Never inside the repo; `.gitignore` excludes `*.gguf` |
| `N:\landslide-local\chats` | one JSON file per conversation |

`C:` is the M.2 NVMe with only ~75 GB free — do not put models there.

## Architecture

Deep modules, small interfaces. Each seam has at least two real adapters, so none of
them is hypothetical.

- `InferenceRuntime` (`src/runtime/index.js`) — the facade owns think-separation,
  timing, token accounting and abort. Adapters (`ollama`, `llamacpp`, `fake`) carry
  **protocol only**. If you find yourself parsing `<think>` in an adapter, it belongs
  in the facade.
- `ChatStore` (`src/core/chat-store.js`) — `json` and `memory` adapters share one
  contract suite in `test/chat-store.test.js`. Add a behaviour there, not to one adapter.
- `ThinkStream` (`src/core/think-stream.js`) — pure. Holds back any suffix that could
  still become a tag, so tags split across chunks work. Do not "simplify" the holdback.
- `src/api.js` is deliberately thin. Logic accumulating there is a smell; push it down.

## Conventions

- Timestamps come from the monotonic clock in `chat-store.js`, not `Date.now()`
  directly. Two writes in the same millisecond would otherwise tie and make list
  order arbitrary.
- Windows paths in `config.json` use **forward slashes**. A single backslash is
  invalid JSON and the failure is confusing.
- `node --test` (auto-discovery). `node --test test/` fails on Windows.

## Before calling anything done

```
node --test              # must be all green
node scripts/preflight.mjs   # must be 0 FAIL
```

Then open it in a browser and actually look at it. Neither command can see a font that
did not load or a panel that renders on top of the composer.

## Never

- Push, deploy, or publish. This is local software; there is no remote.
- Weaken a test to make an item close.
- Add a model to the catalog that is not uncensored — `preflight` asserts this.
