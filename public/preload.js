/**
 * Preloading the chosen model, and the page's memory of what it has loaded.
 *
 * Split out of models.js when that file crossed the 400-line ceiling. The
 * dependency runs ONE way on purpose: this module never imports models.js.
 * Preloading finishes by refreshing the runtime view, which redraws the rail —
 * so importing the rail from here would close a cycle between the two halves
 * of the same panel. The refresh is handed in at wiring time instead, which
 * also makes the settle-and-chase behaviour testable without a rail at all.
 */

import { apiFetch } from './api-client.js';
import { isResident, state } from './dom.js';

/** Set by initPreload(). Called after every attempt, successful or not. */
let refreshRuntime = async () => {};

function initPreload({ onSettled }) {
  refreshRuntime = onSettled;
}

/**
 * Start loading the model once the choice has settled.
 *
 * A 9B off this SATA SSD is about twenty seconds, and the old flow spent every
 * one of them AFTER the first message was written — the one moment the user is
 * watching. Choosing a model is the natural place to pay it instead.
 *
 * Three rules, each of which was a bug before it was a rule:
 *
 * - **It waits.** Arrowing from the top of the list to the bottom passes over
 *   every model on the way, and firing on each one asks an 8 GB card to load
 *   five models back to back — the 21B alone locked the page for minutes when a
 *   stray click landed on it. Only where the selection comes to rest is loaded.
 * - **It never stacks and never repeats.** One in flight at a time, nothing for
 *   a model already resident or already loaded by this page.
 * - **It never says anything.** Nobody asked for this request. `warm` answers
 *   409 whenever the configured adapter is not one the supervisor can drive, so
 *   under llamacpp a visible failure would fire on every card click for using
 *   the app exactly as intended. `state.canWarm` is the server's own answer to
 *   whether this backend can be preloaded, and anything else is swallowed.
 *
 * The Preload button on the card is the deliberate version of this, and that
 * one does report.
 */
const PRELOAD_SETTLE_MS = 400;
let preloadTimer = null;
let preloading = false;
const preloaded = new Set();

function preloadModel(id) {
  clearTimeout(preloadTimer);
  preloadTimer = null;
  if (!id || !state.runtimeUp || !state.canWarm) return;
  if (preloaded.has(id) || isResident(id)) return;

  preloadTimer = setTimeout(() => {
    preloadTimer = null;
    // The selection may have moved on during the wait; only warm what is still
    // chosen, or a fast pass through the list still loads something nobody wants.
    if (state.modelId !== id || preloading) return;
    if (preloaded.has(id) || isResident(id)) return;

    preloading = true;
    apiFetch('/api/runtime/warm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: id }),
    })
      .then(async (res) => {
        // Only a load that actually happened is worth remembering. A 409, a 401
        // or a runtime that refused leaves the id out, so selecting the card
        // again tries once more rather than going quiet for the session.
        const payload = res.ok ? await res.json().catch(() => null) : null;
        if (payload?.result?.ok) notePreloaded(id);
        return refreshRuntime();
      })
      .catch(() => {
        /* An unasked-for preload has no failure the user needs to read. */
      })
      .finally(() => {
        preloading = false;
        // Chase the CURRENT selection, never a queue of everything clicked
        // past. It cannot recurse: the follow-up only fires for a DIFFERENT id,
        // so the chain ends the moment it catches up with the user.
        if (state.modelId && state.modelId !== id) preloadModel(state.modelId);
      });
  }, PRELOAD_SETTLE_MS);
}

/**
 * `isResident()` is the better answer and is not always available: it is read
 * from the runtime's own residency list, and a runtime that does not report one
 * would leave every re-selection of the same card firing another load. This is
 * the page's own memory of what it put there, cleared only by `forgetPreloads()`
 * when the runtime restarts and VRAM is genuinely empty.
 *
 * It deliberately does not model the thirty-minute eviction: a model that ages
 * out is not preloaded again by re-selecting it. The card stops saying "in VRAM",
 * the Preload button returns, and the next message reloads it regardless — so
 * the cost of being wrong is one first message at full load time, which is where
 * this started.
 */
function notePreloaded(id) {
  preloaded.add(id);
}

function forgetPreloads() {
  preloaded.clear();
}
export { forgetPreloads, initPreload, notePreloaded, preloadModel };
