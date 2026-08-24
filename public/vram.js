/**
 * What is holding the card right now, and how to get it back.
 *
 * `POST /api/runtime/unload` and `supervisor.unload()` have existed since the
 * app could preload; nothing in the page ever called either. On an 8 GB card a
 * resident 9B is most of the card, KEEP_ALIVE is thirty minutes, and the next
 * thing that wants the GPU is usually not this app — so "wait half an hour" was
 * the only answer the interface had.
 *
 * Collapsed by default and hidden outright when nothing is resident. The
 * sidebar is already the tallest column in the app and a panel that is empty
 * most of the time should cost nothing most of the time.
 */

import { apiFetch } from './api-client.js';
import { els, modelForTag, notify, state } from './dom.js';

/** Set by initVram(). Runs after an unload lands, to re-read residency. */
let refreshRuntime = async () => {};
let open = false;

function initVram({ onChanged }) {
  refreshRuntime = onChanged;
  els.vramToggle.addEventListener('click', () => {
    open = !open;
    applyOpen();
  });
}

function applyOpen() {
  els.vramList.hidden = !open;
  els.vramToggle.setAttribute('aria-expanded', String(open));
}

const gb = (n) => `${Number(n).toFixed(2)} GB`;

/**
 * Ask the runtime to drop one model now.
 *
 * `keep_alive: 0` is the only thing Ollama treats as "evict it" — a short
 * duration merely re-arms the timer — and the route already knows that. What
 * this has to get right is the two-step: the button dies while the request is
 * in flight, and residency is re-read afterwards whether it succeeded or not,
 * because a failed unload leaves the model exactly where it was and the panel
 * has to keep saying so.
 */
async function unloadOne(model, button) {
  button.disabled = true;
  const was = button.textContent;
  button.textContent = 'Unloading';
  try {
    const res = await apiFetch('/api/runtime/unload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: model.id }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.result?.ok) {
      throw new Error(payload?.result?.error ?? payload?.error ?? `runtime returned ${res.status}`);
    }
  } catch (err) {
    notify(`Could not unload ${model.name}: ${err.message ?? err}`);
    button.disabled = false;
    button.textContent = was;
  } finally {
    await refreshRuntime();
  }
}

function renderVram() {
  const loaded = state.loaded ?? [];
  if (loaded.length === 0) {
    els.vram.hidden = true;
    els.vramList.replaceChildren();
    // `open` is deliberately NOT reset. It is the user's choice about this
    // disclosure, not a property of what happens to be resident — and residency
    // reads do flicker, so resetting on empty collapses a panel somebody
    // deliberately opened, for reasons invisible from where they are sitting.
    applyOpen();
    return;
  }

  els.vram.hidden = false;
  const total = loaded.reduce((sum, m) => sum + (Number(m.sizeGb) || 0), 0);
  els.vramSummary.textContent =
    `${loaded.length} model${loaded.length === 1 ? '' : 's'} in VRAM · ${gb(total)}`;

  els.vramList.replaceChildren(
    ...loaded.map((entry) => {
      const row = document.createElement('div');
      row.className = 'vram-row';

      const name = document.createElement('span');
      name.className = 'vram-name';
      const known = modelForTag(entry.name);
      name.textContent = known?.name ?? entry.name;

      const size = document.createElement('span');
      size.className = 'vram-size';
      size.textContent = gb(entry.sizeGb);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vram-unload';
      button.textContent = 'Unload';
      if (known) {
        button.title = `Give ${gb(entry.sizeGb)} back now instead of waiting out the keep-alive`;
        button.addEventListener('click', () => unloadOne(known, button));
      } else {
        // The unload route validates against the catalog, so offering this would
        // be offering a 400. Something else loaded it; something else can drop it.
        button.disabled = true;
        button.title =
          `${entry.name} is resident but is not one of this build's models, ` +
          'so this app will not unload it.';
      }

      row.append(name, size, button);
      return row;
    }),
  );
  applyOpen();
}

export { initVram, renderVram };
