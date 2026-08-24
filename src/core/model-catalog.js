/**
 * ModelCatalog — a LOADER, not a list.
 *
 * The models themselves live in `models.json` at the repo root: id, repo, file,
 * quant, size, per-model generation defaults and which format profile the model
 * writes in. Adding, removing or re-tuning a model is an edit to that file and
 * nothing else — no source change and no second place to keep in step.
 * `fetch-models.mjs`, `verify-urls.mjs`, `preflight.mjs` and the MCP server all
 * read this module, so they all see that one file.
 *
 * What stays here is the behaviour: what a model means for the machine it has to
 * run on, and which generation options are allowed to reach a runtime.
 *
 * Interface:
 *   all()                     -> Model[]
 *   get(id)                   -> Model | undefined
 *   fitFor(model, vramGb)     -> { verdict, headroomGb, note }
 *   withAvailability(list)    -> Model[]  (marks .installed from runtime tags)
 *   totalSizeGb()             -> number
 *   optionsFor(model, asked)  -> the generation options that may reach a runtime
 *   checkOptions(asked)       -> string[]  (the strict door, for stored options)
 *   KEEP_ALIVE                -> how long a loaded model is asked to stay resident
 *   RESERVE_GB                -> the runtime's VRAM reserve at the default context
 *
 * Sizes and filenames are verified against the Hugging Face repos with a HEAD
 * request (scripts/verify-urls.mjs), not guessed. Sizes are GiB, matching how
 * VRAM is measured; Hugging Face displays decimal GB, so its numbers read about
 * 7% larger. `runtimeCost` is the KV cache + compute buffer reserve at the
 * default context.
 */

import { readFileSync } from 'node:fs';

/**
 * Read once, at import, and synchronously.
 *
 * Every caller of `all()` and `get()` is synchronous — the HTTP layer, the MCP
 * tool schema, preflight — so a promise here would ripple through all of them
 * for no gain. The file is a few kilobytes on the same disk as the code.
 */
const CATALOG_FILE = new URL('../../models.json', import.meta.url);

/**
 * Reading a file somebody might be halfway through writing.
 *
 * `models.json` is a plain file meant to be edited by hand, and a plain
 * `writeFile` truncates before it writes — so a reader that arrives in that
 * window sees zero bytes or half a document. Failing on the first attempt would
 * turn "the editor happened to save while the app started" into a hard crash
 * with a confusing message. A few immediate retries cover a window measured in
 * microseconds; a file that is genuinely malformed still fails, and says so.
 */
const READ_ATTEMPTS = 5;

function readCatalogFile() {
  let last;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    try {
      return JSON.parse(readFileSync(CATALOG_FILE, 'utf8'));
    } catch (err) {
      last = err;
      // A missing file is not a race and will not fix itself; only a bad parse
      // is worth waiting out.
      if (err.code === 'ENOENT') break;
      if (attempt < READ_ATTEMPTS - 1) pause(4);
    }
  }
  throw new Error(`could not read the model catalog (models.json): ${last.message}`);
}

/** Sleep without going async: every caller of this module is synchronous. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadCatalog() {
  const parsed = readCatalogFile();
  // Either shape reads: a bare array of models, or an object that also carries
  // the settings they share. A file trimmed to just the array still works.
  const list = Array.isArray(parsed) ? parsed : parsed?.models;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('models.json must hold a non-empty array of models');
  }
  const profiles = (!Array.isArray(parsed) && parsed?.formats) || {};
  return {
    keepAlive: (!Array.isArray(parsed) && parsed?.keepAlive) || '30m',
    reserveGb: Number.isFinite(parsed?.reserveGb) ? Number(parsed.reserveGb) : 0.85,
    models: Object.freeze(
      list.map((m) =>
        Object.freeze({
          ...m,
          defaults: Object.freeze({ ...(m.defaults ?? {}) }),
          format: Object.freeze(resolveFormat(m.format, profiles)),
        }),
      ),
    ),
  };
}

/**
 * How each model writes, which is not the same question as what the renderer
 * can draw. `public/render.js` takes one of these as `renderText`'s third
 * argument; the knobs are the two places a wrong guess is visible.
 *
 * - `structured` — the instruct and GAIN tunes. They answer in headings and
 *   pipe tables, they drop into a bullet list with no blank line above it, and
 *   they nest with the two spaces markdown actually asks for.
 * - `reasoning` — the thinking tunes. A trace is nested asterisk bullets under
 *   a numbered step, indented a full four spaces (that is verbatim what Deckard
 *   emitted), so two spaces is a wrapped line rather than a new level.
 * - `prose` — the writing tunes. A line starting with a dash mid-paragraph is
 *   far more likely to be dialogue than a bullet, so it is left as prose; a
 *   real list still renders when a blank line announces it.
 *
 * A model NAMES its profile and the profile is defined once under `formats`,
 * because three of the five share one and a table of five copies is a table
 * that drifts. An unknown name — or an inline object, which the file is also
 * allowed to carry — still resolves: everything the renderer needs is in the
 * object it is handed, so the name is for the UI and for reading the file.
 */
function resolveFormat(format, profiles) {
  if (format && typeof format === 'object') return { ...format };
  const named = typeof format === 'string' ? profiles[format] : null;
  if (named && typeof named === 'object') return { profile: format, ...named };
  return { profile: typeof format === 'string' && format ? format : 'default' };
}

const CATALOG = loadCatalog();

/** @type {ReadonlyArray<Model>} */
const MODELS = CATALOG.models;

const RUNTIME_RESERVE_GB = CATALOG.reserveGb;

/**
 * How long the runner is asked to keep a model resident.
 *
 * Every request that touches a model must state the SAME value. Ollama resets
 * the eviction timer from whatever the current request says, so a preload
 * asking for 30 minutes followed by a chat call that says nothing drops the
 * model back to the server's 5-minute default — which is how "models stay
 * loaded for 30 minutes" stopped being true after the first message.
 */
export const KEEP_ALIVE = CATALOG.keepAlive;

/**
 * The only generation options that may reach a runtime, and the range each is
 * allowed to hold. Anything outside this table is dropped rather than
 * forwarded: `num_predict: -1` means "generate until the context is full",
 * which on a shared 8 GB card is a request to hang the machine.
 *
 * This is code and not data on purpose. It is the whitelist that keeps the HTTP
 * layer honest, and a whitelist a caller could widen by editing a data file
 * would not be one.
 *
 * `unboundedMeansMax` reads Ollama's "no limit" sentinels (-1, 0) as "as much
 * as this app allows" instead of clamping them to one token.
 */
const OPTION_LIMITS = Object.freeze({
  temperature: { min: 0, max: 2 },
  top_p: { min: 0, max: 1 },
  top_k: { min: 1, max: 1000, integer: true },
  repeat_penalty: { min: 0.1, max: 2 },
  num_ctx: { min: 256, max: 262144, integer: true },
  num_predict: { min: 1, max: 32768, integer: true, unboundedMeansMax: true },
  // How many prompt tokens are evaluated in one pass. Bigger reads a long
  // prompt faster and costs more VRAM for the compute buffer, so the right
  // value is a fact about the model's size on THIS card, not a constant — which
  // is why it sits per model in models.json. Ollama's own default is 512; the
  // ceiling is llama.cpp's default logical batch, and the floor is low enough
  // to survive a heavy spill to system RAM without being so low that prompt
  // processing collapses. The measurements behind each value are below.
  num_batch: { min: 32, max: 2048, integer: true },
});

/*
 * `num_batch` per model — the values in models.json are MEASURED on this
 * machine, not reasoned about, because reasoning about them got the 21B wrong
 * by 45%. Prompt-eval throughput on a 2,781-token prompt, warm model, no reload
 * (`prompt_eval_count / prompt_eval_duration`):
 *
 *              256      512     1024     2048   tok/s
 *   2B        5,661    6,006   *6,382*   6,108
 *   4B        3,222   *3,425*   3,391    3,375
 *   9B inst   2,264   *2,423*   2,418    2,400
 *   9B GAIN   2,065   *2,428*   2,311    2,273
 *   21B         434      536   *  630*     632
 *
 * So: 1024 for the 2B and the 21B, 512 for the rest. Two shapes of answer, and
 * neither is "more VRAM headroom means a bigger batch":
 *
 * - Three of the four that fit on the card peak at 512 and get *slower* above
 *   it. The compute buffer a larger batch needs competes with the weights and
 *   the KV cache for the same 6.65 GB, and past 512 it costs more than the
 *   extra parallelism returns. 4B at 1024 is within noise of its 512; 512 is
 *   both the measured peak and the smaller allocation, so it takes it.
 * - The 21B wants MORE, monotonically to 1024 — 630 tok/s against 434 at the
 *   256 that seemed obvious for a model already 1.5 GB over the card. It is not
 *   competing for VRAM in the same way: layers are on the CPU either way, and a
 *   bigger batch amortises that pass instead of aggravating it. 2048 is flat
 *   (632), so 1024 is the knee, not a ceiling being avoided.
 * - The 2B, with the most room and the smallest weights, is the only fitting
 *   model that still gains at 1024 (6,382 against 6,006).
 *
 * Generation speed is untouched by all of this — it is a prompt-processing
 * knob, and tok/s during generation stayed flat for every model at every value.
 *
 * A value in models.json is only real if it is also whitelisted in
 * OPTION_LIMITS and mapped by the adapter. An option that no adapter forwards
 * is decoration.
 */

// Object.freeze is shallow, so a spread copy still shares the same `defaults`
// object. One `model.defaults.temperature = x` anywhere would change what every
// later get() returns, process-wide. `format` is worse again: three models
// share one profile, so a caller editing it in place would re-format the
// others too.
export function all() {
  return MODELS.map((m) => ({ ...m, defaults: { ...m.defaults }, format: { ...m.format } }));
}

export function get(id) {
  const found = MODELS.find((m) => m.id === id);
  return found
    ? { ...found, defaults: { ...found.defaults }, format: { ...found.format } }
    : undefined;
}

export function totalSizeGb() {
  return Number(MODELS.reduce((sum, m) => sum + m.sizeGb, 0).toFixed(2));
}

/**
 * Will this model run entirely on the GPU?
 * @returns {{ verdict: 'fits'|'tight'|'spills', headroomGb: number, note: string }}
 */
export function fitFor(model, vramUsableGb) {
  const needed = model.sizeGb + RUNTIME_RESERVE_GB;
  const headroomGb = Number((vramUsableGb - needed).toFixed(2));
  if (headroomGb >= 0.5) {
    return { verdict: 'fits', headroomGb, note: 'Runs entirely on the GPU.' };
  }
  if (headroomGb >= 0) {
    return {
      verdict: 'tight',
      headroomGb,
      note: 'Fits, but close the browser and other GPU apps first.',
    };
  }
  return {
    verdict: 'spills',
    headroomGb,
    note: `About ${Math.abs(headroomGb).toFixed(1)}GB runs on the CPU. Expect a large slowdown.`,
  };
}

/** Mark which catalog entries the runtime actually has loaded. */
export function withAvailability(installedTags = []) {
  const norm = new Set(installedTags.map((t) => String(t).toLowerCase()));
  return all().map((m) => ({
    ...m,
    installed: norm.has(m.id) || norm.has(`${m.id}:latest`),
  }));
}

/**
 * The generation options a runtime is allowed to receive for this model.
 *
 * A whitelist, not a merge: the model's own defaults are the base, a caller may
 * move a known knob within a sane range, and everything else is dropped. This
 * is what keeps the HTTP layer honest — a request cannot invent a parameter,
 * and cannot ask for an unbounded generation.
 *
 * @param {{ defaults?: Record<string, number> }} model
 * @param {Record<string, unknown>} [asked] caller-supplied overrides, untrusted
 * @returns {Record<string, number>}
 */
export function optionsFor(model, asked = {}) {
  const defaults = model?.defaults ?? {};
  const overrides = asked && typeof asked === 'object' && !Array.isArray(asked) ? asked : {};

  const out = {};
  for (const [key, limit] of Object.entries(OPTION_LIMITS)) {
    // An override that cannot be read as a number falls back to the MODEL's
    // default rather than dropping the key. Dropping it looked conservative and
    // was not: temperature: "abc" removed temperature from the request, so the
    // runner answered at its own default instead of this model's tuned one.
    let value = key in overrides ? clampOption(overrides[key], limit) : null;
    if (value === null && key in defaults) value = clampOption(defaults[key], limit);
    if (value !== null) out[key] = value;
  }
  return out;
}

/**
 * The strict door, for options being STORED rather than sent.
 *
 * `optionsFor` clamps, because a live request should still produce an answer.
 * Persisting is different: a temperature of 99 saved onto a chat is silently
 * rewritten to 2 on every send, and the settings panel then shows a number the
 * model never sees. Refusing it once, at the point it is written, is the only
 * moment the user is present to be told.
 *
 * @param {unknown} asked
 * @returns {string[]} what is wrong with it; empty means fine
 */
export function checkOptions(asked) {
  if (asked === null || typeof asked !== 'object' || Array.isArray(asked)) {
    return ['options must be an object'];
  }
  const problems = [];
  for (const [key, raw] of Object.entries(asked)) {
    const limit = OPTION_LIMITS[key];
    if (!limit) {
      problems.push(`unknown option: ${key}`);
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      problems.push(`${key} must be a number`);
      continue;
    }
    // The "no limit" sentinels are a legitimate way to ask for the maximum,
    // and optionsFor already reads them as exactly that.
    if (limit.unboundedMeansMax && n <= 0) continue;
    if (n < limit.min || n > limit.max) {
      problems.push(`${key} must be between ${limit.min} and ${limit.max} (got ${n})`);
    }
  }
  return problems;
}

function clampOption(raw, limit) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (limit.unboundedMeansMax && n <= 0) return limit.max;
  const bounded = Math.min(limit.max, Math.max(limit.min, n));
  return limit.integer ? Math.round(bounded) : bounded;
}

export const RESERVE_GB = RUNTIME_RESERVE_GB;
export { OPTION_LIMITS };
