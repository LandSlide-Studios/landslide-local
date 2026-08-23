/**
 * ModelCatalog — the five uncensored Qwen 3.5 models this app ships with,
 * with the facts needed to decide whether one will actually run here.
 *
 * Interface:
 *   all()                  -> Model[]
 *   get(id)                -> Model | undefined
 *   fitFor(model, vramGb)  -> { verdict, headroomGb, note }
 *   withAvailability(list) -> Model[]  (marks .installed from runtime tags)
 *
 * Sizes and filenames are verified against the Hugging Face repos with a HEAD request
 * (scripts/verify-urls.mjs), not guessed. Sizes are GiB, matching how VRAM is measured;
 * Hugging Face displays decimal GB, so its numbers read about 7% larger.
 * `runtimeCost` is the KV cache + compute buffer reserve at the default context.
 */

const RUNTIME_RESERVE_GB = 0.85;

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

export function all() {
  return MODELS.map((m) => ({ ...m }));
}

export function get(id) {
  const found = MODELS.find((m) => m.id === id);
  return found ? { ...found } : undefined;
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

export const RESERVE_GB = RUNTIME_RESERVE_GB;
