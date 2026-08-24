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
});

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
    defaults: { temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.0, num_ctx: 16384 },
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
    defaults: { temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.0, num_ctx: 16384 },
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
    defaults: { temperature: 0.6, top_p: 0.9, top_k: 40, repeat_penalty: 1.0, num_ctx: 8192 },
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
    defaults: { temperature: 0.85, top_p: 0.92, top_k: 50, repeat_penalty: 1.0, num_ctx: 16384 },
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
    defaults: { temperature: 0.8, top_p: 0.9, top_k: 40, repeat_penalty: 1.0, num_ctx: 16384 },
    blurb:
      'Reasoning length scales itself down on easy prompts, so it rarely stalls. ' +
      'Genuinely less capable, but it answers in about a second.',
  },
]);

// Object.freeze is shallow, so a spread copy still shares the same `defaults`
// object. One `model.defaults.temperature = x` anywhere would change what every
// later get() returns, process-wide.
export function all() {
  return MODELS.map((m) => ({ ...m, defaults: { ...m.defaults } }));
}

export function get(id) {
  const found = MODELS.find((m) => m.id === id);
  return found ? { ...found, defaults: { ...found.defaults } } : undefined;
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
  const overrides = asked && typeof asked === 'object' && !Array.isArray(asked) ? asked : {};
  const merged = { ...(model?.defaults ?? {}), ...overrides };

  const out = {};
  for (const [key, limit] of Object.entries(OPTION_LIMITS)) {
    if (!(key in merged)) continue;
    const value = clampOption(merged[key], limit);
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
