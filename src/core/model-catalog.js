/**
 * ModelCatalog — the five uncensored Qwen 3.5 models this app ships with,
 * with the facts needed to decide whether one will actually run here.
 *
 * Interface:
 *   all()                     -> Model[]
 *   get(id)                   -> Model | undefined
 *   fitFor(model, vramGb)     -> { verdict, headroomGb, note }
 *   withAvailability(list)    -> Model[]  (marks .installed from runtime tags)
 *   optionsFor(model, asked)  -> the generation options that may reach a runtime
 *   KEEP_ALIVE                -> how long a loaded model is asked to stay resident
 *
 * Sizes and filenames are verified against the Hugging Face repos with a HEAD request
 * (scripts/verify-urls.mjs), not guessed. Sizes are GiB, matching how VRAM is measured;
 * Hugging Face displays decimal GB, so its numbers read about 7% larger.
 * `runtimeCost` is the KV cache + compute buffer reserve at the default context.
 */

const RUNTIME_RESERVE_GB = 0.85;

/**
 * How long the runner is asked to keep a model resident.
 *
 * Every request that touches a model must state the SAME value. Ollama resets
 * the eviction timer from whatever the current request says, so a preload
 * asking for 30 minutes followed by a chat call that says nothing drops the
 * model back to the server's 5-minute default — which is how "models stay
 * loaded for 30 minutes" stopped being true after the first message.
 */
export const KEEP_ALIVE = '30m';

/**
 * The only generation options that may reach a runtime, and the range each is
 * allowed to hold. Anything outside this table is dropped rather than
 * forwarded: `num_predict: -1` means "generate until the context is full",
 * which on a shared 8 GB card is a request to hang the machine.
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
  // value is a fact about the model's size on THIS card, not a constant.
  // Ollama's own default is 512; the ceiling is llama.cpp's default logical
  // batch, and the floor is low enough to survive a heavy spill to system RAM
  // without being so low that prompt processing collapses.
  num_batch: { min: 32, max: 2048, integer: true },
});

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
 * Everything the renderer needs is in the object, so an unknown profile name
 * still renders — the name is for the UI and for reading this table.
 */
const FORMAT = Object.freeze({
  structured: { profile: 'structured', tables: true, listsInterruptParagraph: true, indentPerLevel: 2 },
  reasoning: { profile: 'reasoning', tables: true, listsInterruptParagraph: true, indentPerLevel: 4 },
  prose: { profile: 'prose', tables: true, listsInterruptParagraph: false, indentPerLevel: 4 },
});

/**
 * `num_batch` per model — how many prompt tokens are evaluated in one pass.
 *
 * These are MEASURED on this machine, not reasoned about, because reasoning
 * about them got the 21B wrong by 45%. Prompt-eval throughput on a 2,781-token
 * prompt, warm model, no reload (`prompt_eval_count / prompt_eval_duration`):
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
 * A value here is only real if it is also whitelisted in OPTION_LIMITS and
 * mapped by the adapter. An option that no adapter forwards is decoration.
 */
/** @type {ReadonlyArray<Model>} */
const MODELS = Object.freeze([
  {
    id: 'cold-fusion-9b',
    name: 'Cold Fusion GAIN',
    params: '9B',
    tagline: 'Best all-rounder. Sharpest at tables, code and structure.',
    repo: 'DavidAU/Qwen3.5-9B-Cold-Fusion-GAIN-v1.0-Uncensored-Heretic-NEO-MAX-Imatrix-GGUF',
    file: 'Qwen3.5-9B-C-Fusion-GAIN-UnHeretic-NM-DAU-NEO-MAX-NEO-IQ3_M.gguf',
    quant: 'IQ3_M',
    sizeGb: 5.23,
    thinks: true,
    uncensored: true,
    accent: 'ember',
    defaults: { temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.0, num_ctx: 16384, num_batch: 512 },
    format: FORMAT.structured,
    blurb:
      'GAIN training adapts per-sample during the run; the author claims it beats the 27B. ' +
      'Thinks before answering, so expect reasoning time on hard prompts.',
  },
  {
    id: 'heretic-instruct-9b',
    name: 'Heretic Instruct',
    params: '9B',
    tagline: 'No reasoning block. Answers immediately — the daily driver.',
    repo: 'mradermacher/Qwen3.5-9B-Claude-4.6-OS-HERETIC-UNCENSORED-INSTRUCT-i1-GGUF',
    file: 'Qwen3.5-9B-Claude-4.6-OS-HERETIC-UNCENSORED-INSTRUCT.i1-Q4_K_S.gguf',
    quant: 'i1-Q4_K_S',
    sizeGb: 4.97,
    thinks: false,
    uncensored: true,
    accent: 'ember',
    defaults: { temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.0, num_ctx: 16384, num_batch: 512 },
    format: FORMAT.structured,
    blurb:
      'Same Claude 4.6 four-dataset tune as the thinking models with the reasoning block removed. ' +
      'Five to ten times less wall-clock per answer.',
  },
  {
    id: 'glm-flash-21b',
    name: 'GLM-Flash Heretic',
    params: '21B',
    tagline: 'The heavyweight. Smartest here, and the slowest by far.',
    repo: 'mradermacher/Qwen3.5-21B-GLM-4.7-Flash-Heretic-Uncensored-Thinking-i1-GGUF',
    file: 'Qwen3.5-21B-GLM-4.7-Flash-Heretic-Uncensored-Thinking.i1-IQ2_M.gguf',
    quant: 'i1-IQ2_M',
    sizeGb: 7.32,
    thinks: true,
    uncensored: true,
    accent: 'slate',
    defaults: { temperature: 0.6, top_p: 0.9, top_k: 40, repeat_penalty: 1.0, num_ctx: 8192, num_batch: 1024 },
    format: FORMAT.reasoning,
    blurb:
      'Qwen 3.5 27B contracted to 21B, then GLM 4.7 Flash tuned to shorten reasoning. ' +
      'Will not fit entirely in 8GB — some layers run on the CPU, so it is markedly slower.',
  },
  {
    id: 'deckard-4b',
    name: 'Deckard',
    params: '4B',
    tagline: 'Fast and characterful. Fiction, voice and roleplay.',
    repo: 'mradermacher/Qwen3.5-4B-Deckard-HERETIC-UNCENSORED-Thinking-i1-GGUF',
    file: 'Qwen3.5-4B-Deckard-HERETIC-UNCENSORED-Thinking.i1-Q4_K_M.gguf',
    quant: 'i1-Q4_K_M',
    sizeGb: 2.52,
    thinks: true,
    uncensored: true,
    accent: 'moss',
    defaults: { temperature: 0.85, top_p: 0.92, top_k: 50, repeat_penalty: 1.0, num_ctx: 16384, num_batch: 512 },
    format: FORMAT.prose,
    blurb:
      "DavidAU's character, POV and observation datasets at a size that leaves 4GB of VRAM spare. " +
      'Noticeably better prose than its size suggests.',
  },
  {
    id: 'auto-variable-2b',
    name: 'Auto-Variable',
    params: '2B',
    tagline: 'Instant. For quick rewrites and throwaway drafting.',
    repo: 'mradermacher/Qwen3.5-2B-Claude-4.6-OS-Auto-Variable-HERETIC-UNCENSORED-THINKING-i1-GGUF',
    file: 'Qwen3.5-2B-Claude-4.6-OS-Auto-Variable-HERETIC-UNCENSORED-THINKING.i1-Q4_K_M.gguf',
    quant: 'i1-Q4_K_M',
    sizeGb: 1.19,
    thinks: true,
    uncensored: true,
    accent: 'moss',
    defaults: { temperature: 0.8, top_p: 0.9, top_k: 40, repeat_penalty: 1.0, num_ctx: 16384, num_batch: 1024 },
    format: FORMAT.reasoning,
    blurb:
      'Reasoning length scales itself down on easy prompts, so it rarely stalls. ' +
      'Genuinely less capable, but it answers in about a second.',
  },
]);

// Object.freeze is shallow, so a spread copy still shares the same `defaults`
// object. One `model.defaults.temperature = x` anywhere would change what every
// later get() returns, process-wide. `format` is worse again: three models
// share one FORMAT entry, so a caller editing it in place would re-format the
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

function clampOption(raw, limit) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (limit.unboundedMeansMax && n <= 0) return limit.max;
  const bounded = Math.min(limit.max, Math.max(limit.min, n));
  return limit.integer ? Math.round(bounded) : bounded;
}

export const RESERVE_GB = RUNTIME_RESERVE_GB;
export { OPTION_LIMITS };
