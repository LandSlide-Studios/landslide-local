# Landslide Local — folder rules

Offline chat client for uncensored Qwen 3.5 GGUF models. Runs on Tommy's machine only.

## Hard constraints — do not break these

1. **Zero npm dependencies.** Node 22 stdlib only. `package.json` has no `dependencies`
   or `devDependencies` and must stay that way. `npm run preflight` fails the build if
   one appears. The whole point is that this installs and runs with no network.
2. **No external hosts anywhere in `src/` or `public/`.** No CDN scripts, no Google
   Fonts link, no remote images. Fonts are local `.woff2` files in `public/fonts`.
   Two files are exempt from that grep and no others: `scripts/fetch-models.mjs`, the
   one-time downloader, and `scripts/verify-urls.mjs`, which HEADs the Hugging Face
   URLs the catalog claims. Preflight holds that list and FAILs on any other file.
   The check catches a scheme-less URL as well as an `https` one.
3. **Model output never reaches `innerHTML`.** `public/render.js` — with its parser
   internals under `public/render/`, which nothing else imports — parses the markdown
   the models write and builds every element itself from text nodes; no string from a
   model is ever handed to the DOM as markup, and it is the only module allowed to turn
   model output into DOM. An uncensored local model is untrusted input like any other:
   a tag the model writes is shown inert, with its attributes dropped, and a link whose
   URL is not http, https or mailto loses the URL. Streamed output must render
   identically to the same text re-rendered after a reload — that equivalence is what
   `test/acceptance/i0-*.test.js` pins, and `i8-*` pins it again for markdown.
4. **Loopback only.** The server binds `127.0.0.1` and rejects non-loopback `Origin`.
   Do not add a `0.0.0.0` bind or a CORS allowance.

## Where things live

| Path | Holds |
|---|---|
| `<repo>` | the app (this folder) — SATA SSD, not the M.2 |
| the folder `storage.modelsDir` points at | the GGUF files, ~22.8 GB. Never inside the repo; `.gitignore` excludes `*.gguf` |
| `<repo>/chats` | one JSON file per conversation |

Keep the GGUFs off the boot drive if it is short of space; they are ~21 GiB.

## Architecture

Deep modules, small interfaces. Each seam has at least two real adapters, so none of
them is hypothetical.

- `InferenceRuntime` (`src/runtime/index.js`) — the facade owns think-separation,
  timing, token accounting and abort. Adapters (`ollama`, `llamacpp`, `fake`) carry
  **protocol only**. If you find yourself parsing `<think>` in an adapter, it belongs
  in the facade.
- `ChatStore` (`src/core/chat-store.js`) — `json`, `memory` and `encrypted` adapters share
  one contract suite in `test/chat-store.test.js`. Add a behaviour there, not to one adapter.
- `ThinkStream` (`src/core/think-stream.js`) — pure. Holds back any suffix that could
  still become a tag, so tags split across chunks work. Do not "simplify" the holdback.
- `src/api.js` is deliberately thin: it builds the dependencies, concatenates the
  route tables from `src/api/` and runs the match-parse-answer loop. Logic
  accumulating in a route is a smell; push it down.
- The models are DATA. `models.json` at the repo root holds all five;
  `src/core/model-catalog.js` is the loader and holds no model id. Adding or
  re-tuning a model is an edit to that file and nothing else.
- The stream event names (`start`, `think`, `answer`, `stats`, `done`, `error`) are
  defined once, in `public/shared/events.js`, and imported by both sides. It lives
  under `public/` because that is the only folder the server serves, so it is the one
  path a browser `<script type="module">` and a Node `import` can both reach.
- `RuntimeSupervisor` (`src/core/runtime-supervisor.js`) starts Ollama with the env
  from `config.json` rather than an inherited one. That is deliberate and load-bearing:
  a stale environment block is why a model store on another drive goes unseen. The
  executable path comes from config or a known absolute install location, **never from
  a request**.
- **Nothing a request says becomes a model id.** `src/api.js` sends `model.id` from the
  catalog and nothing else; there is no field a caller can set to name a different one.
  The only other value it forwards is generation options, and those go through
  `catalog.optionsFor()`, which is a whitelist with a clamp — an unknown key is
  dropped and `num_predict: -1` cannot be reached.
- `src/core/raw-cleanup.js` owns the decision to delete a downloaded GGUF. Name plus
  size, never name alone: the raw file is frequently the only copy, and there is no
  offline path to fetch it again.

## Conventions

- Timestamps come from the monotonic clock in `chat-store.js`, not `Date.now()`
  directly. Two writes in the same millisecond would otherwise tie and make list
  order arbitrary.
- Windows paths in `config.json` use **forward slashes**. A single backslash is
  invalid JSON and the failure is confusing.
- `node --test` (auto-discovery). `node --test test/` fails on Windows.

## Before calling anything done

```
npm run test:core                          # the five core suites — must be 96/96
node scripts/acceptance-lock.mjs --verify  # the target has not moved
node scripts/preflight.mjs                 # must be 0 FAIL
node scripts/verify-live.mjs               # must reach a real model
```

`npm test` is bare auto-discovery: it also picks up the acceptance suites for queue
items that have not been built yet, and those fail by design until they are. It is a
progress reading, not a gate. The five core suites above are the gate.

The first three never touch a model. Three real bugs shipped past them because the
fake adapter emits 200-character scripts with inline `<think>` tags, and Ollama does
neither. **A change to the runtime layer is not verified until `verify-live.mjs`
passes.**

Then open it in a browser and actually look at it. Neither command can see a font that
did not load or a panel that renders on top of the composer.

## Never

- Push, deploy, or publish. This is local software; there is no remote.
- Weaken a test to make an item close.
- Add a model to the catalog that is not uncensored — `preflight` asserts this.
