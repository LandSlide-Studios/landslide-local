/**
 * ContextBudget — decides what actually fits in the model's window, and says
 * out loud what it had to leave out.
 *
 * The defect this module exists to remove: the app sent the whole conversation
 * every turn and counted nothing. Past `num_ctx` the runner drops tokens off
 * the front on its own — the earliest turns and any system prompt — with no
 * error and no signal. The chat simply starts forgetting, and the user is the
 * last to know. That is data loss dressed up as a quiet afternoon.
 *
 * Interface:
 *   planContext({ messages, systemPrompt, limitTokens, reserveTokens })
 *     -> { messages, trimmed, estimatedTokens, limitTokens }
 *   estimateTokens(text)   -> number   the same heuristic, for a live meter
 *   reserveFor(limit)      -> number   room left for the answer
 *
 * Contract:
 *   - `messages` is the conversation, oldest first. The system prompt is NOT in
 *     it; it comes in as `systemPrompt` and is pinned to the front of the plan,
 *     because it is the one turn whose loss changes every answer that follows.
 *   - Trimming takes from the oldest end. The newest turn always survives, even
 *     if it alone is over budget — there is no useful plan that drops the
 *     question just asked.
 *   - `trimmed` counts the turns dropped from `messages`. It is the number the
 *     UI shows the user, so it is never rounded, softened or hidden.
 */

/**
 * Characters per token, and deliberately low.
 *
 * English through a BPE tokenizer averages nearer four characters per token, so
 * three over-estimates by about a third. That direction is the entire point:
 * under-estimating means planning a payload that does not fit, and a payload
 * that does not fit is silently truncated by the runner — the exact failure
 * this module was written to stop. Costing a few turns of history we could have
 * kept is the cheap mistake; losing turns without noticing is the expensive one.
 */
const CHARS_PER_TOKEN = 3;

/**
 * Anything outside the Latin range is counted as a token per character.
 *
 * Dividing by three is only conservative for text that tokenizes like English.
 * CJK runs at roughly one token per character and emoji at several, so the
 * same division would under-count a Japanese conversation threefold — turning
 * the safety margin into a deficit precisely where the user cannot read the
 * warning signs.
 */
function textCost(value) {
  const text = String(value ?? '');
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN) + wide;
}

/**
 * What the chat template wraps around every turn — a role, and the delimiters
 * that mark where the turn starts and stops. Small, and it is charged per
 * message, so a long conversation of one-word replies is not costed at zero.
 */
const PER_MESSAGE_OVERHEAD = 4;

/** The public estimate. A meter and the planner must never disagree. */
export function estimateTokens(text) {
  return textCost(text);
}

function costOf(message) {
  return textCost(message?.content) + PER_MESSAGE_OVERHEAD;
}

/** With no `num_ctx` stated, assume the smallest window any bundled model uses. */
export const DEFAULT_LIMIT_TOKENS = 8192;

/**
 * How much of the window is held back for the reply.
 *
 * The window is shared: prompt and answer come out of the same allowance. Fill
 * it entirely with history and the model has room to say nothing. A quarter,
 * floored at 128 tokens and capped at 2048, leaves an answer room to exist
 * without spending a 16k window on an answer that will be four lines long.
 */
export function reserveFor(limitTokens) {
  const limit = positiveInt(limitTokens, DEFAULT_LIMIT_TOKENS);
  return Math.min(2048, Math.max(128, Math.floor(limit / 4)));
}

/**
 * The window and the hold-back implied by a set of generation options.
 *
 * `num_ctx` is the whole allowance and `num_predict`, when a caller sets one,
 * is a floor on how much of it the answer will want. Never more than half the
 * window, though: a caller asking for a 32k answer inside a 16k window has
 * asked for something impossible, and honouring it literally would leave room
 * for one turn of history and call that a plan.
 *
 * @param {{ num_ctx?: number, num_predict?: number }} [options]
 * @returns {{ limitTokens: number, reserveTokens: number }}
 */
export function budgetFor(options = {}) {
  const limitTokens = positiveInt(options?.num_ctx, DEFAULT_LIMIT_TOKENS);
  const reserveTokens = Math.min(
    Math.floor(limitTokens / 2),
    Math.max(reserveFor(limitTokens), positiveInt(options?.num_predict, 0)),
  );
  return { limitTokens, reserveTokens };
}

/**
 * @param {object} input
 * @param {Array<{role: string, content: string}>} input.messages oldest first
 * @param {string} [input.systemPrompt] pinned first, never trimmed
 * @param {number} [input.limitTokens]  the model's context window
 * @param {number} [input.reserveTokens] room held back for the reply
 * @returns {{ messages: Array, trimmed: number, estimatedTokens: number, limitTokens: number }}
 */
export function planContext({ messages, systemPrompt, limitTokens, reserveTokens } = {}) {
  const limit = positiveInt(limitTokens, DEFAULT_LIMIT_TOKENS);
  const reserve = clampReserve(reserveTokens, limit);
  const budget = Math.max(1, limit - reserve);

  const history = Array.isArray(messages) ? messages : [];
  const prompt = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  const system = prompt ? { role: 'system', content: prompt } : null;

  // The system prompt is charged against the budget but never competes for it:
  // it is spent before the first turn is considered, so what gets squeezed is
  // always old conversation and never the instruction steering the model.
  let used = system ? costOf(system) : 0;

  const kept = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const cost = costOf(history[i]);
    // `kept.length === 0` is the newest turn, and it goes in whatever it costs.
    // Refusing it would mean answering a question the model was never shown.
    if (kept.length > 0 && used + cost > budget) break;
    used += cost;
    kept.unshift(history[i]);
  }

  return {
    messages: system ? [system, ...kept] : kept,
    trimmed: history.length - kept.length,
    estimatedTokens: used,
    limitTokens: limit,
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** A reserve at or past the whole window would leave no room for any history. */
function clampReserve(value, limit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return reserveFor(limit);
  return Math.min(Math.floor(n), limit - 1);
}
