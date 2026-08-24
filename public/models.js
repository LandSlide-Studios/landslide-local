/**
 * The model rail and the runtime bar — one panel, because they answer one
 * question: what can run here, right now.
 *
 * Which models exist and what each would do on this card comes from
 * `/api/state`; whether anything is answering, and whether this app can start or
 * preload it, comes from `/api/runtime`. Nothing here decides either — the page
 * used to hardcode "ollama" and its own "not reachable", which is how it
 * announced a healthy Ollama while the configured llama-server was dead.
 */

import { apiFetch } from './api-client.js';
import { clearNotice, els, isResident, notify, state } from './dom.js';
import { loadChats } from './sidebar.js';

/**
 * `view` is exactly what the server sends from /api/runtime and as
 * /api/state.supervisor: { adapter, running, version, error, loaded, canStart }.
 * Nothing here decides which adapter is live or invents an error message — the
 * page used to hardcode "ollama" and its own "not reachable", which is how it
 * announced a healthy Ollama while the configured llama-server was dead.
 */
function renderRuntime(view) {
  const adapter = view.adapter ?? 'runtime';
  state.runtimeUp = view.running === true;
  state.loaded = view.loaded ?? [];
  // Whether this backend can be preloaded at all is the server's answer, not a
  // string comparison the page invents. The supervisor speaks Ollama only.
  state.canWarm = view.canWarm === true;

  els.runtimeState.textContent = view.running
    ? `${adapter} ready · ${state.hardwareLabel ?? ''}`
    : `${adapter} not running`;
  els.runtimeState.className = `runtime-state ${view.running ? 'is-ok' : 'is-bad'}`;
  els.runtimeState.title = view.running ? (view.version ? `v${view.version}` : '') : (view.error ?? '');

  if (view.running) {
    els.runtimeBar.hidden = true;
    return;
  }

  const why = view.error ? ` (${view.error})` : '';
  els.runtimeBar.hidden = false;
  els.runtimeBar.classList.remove('is-working');
  if (view.canStart) {
    els.runtimeMsg.textContent = `The model server is not running${why}. Nothing will answer until it is.`;
  } else if (adapter === 'ollama') {
    els.runtimeMsg.textContent =
      `Ollama is not running${why} and its executable was not found. ` +
      'Set runtime.ollamaBin in config.json.';
  } else {
    els.runtimeMsg.textContent =
      `${adapter} is not answering${why}. Start it yourself — this app can only launch Ollama.`;
  }
  els.startRuntime.hidden = !view.canStart;
  els.startRuntime.disabled = false;
  els.startRuntime.textContent = 'Start Ollama';
}

/** What a re-render would actually change. Used to not re-render when nothing did. */
const runtimeSignature = (view) =>
  [
    view.adapter,
    view.running,
    view.canStart,
    view.error ?? '',
    (view.loaded ?? []).map((m) => m.name).sort().join(','),
  ].join('|');

async function refreshRuntime() {
  try {
    const { runtime } = await (await apiFetch('/api/runtime')).json();
    const wasUp = state.runtimeUp;
    const signature = runtimeSignature(runtime);

    // replaceChildren on the radiogroup destroys focus. Doing that every twelve
    // seconds meant a keyboard user could never stay on a model card.
    if (signature !== state.runtimeSig) {
      state.runtimeSig = signature;
      renderRuntime(runtime);
      renderModels();
    } else {
      state.runtimeUp = runtime.running === true;
      state.loaded = runtime.loaded ?? [];
      state.canWarm = runtime.canWarm === true;
    }

    // A runtime that has just come back has an empty VRAM whatever this page
    // remembers loading into it.
    if (!wasUp && runtime.running) {
      forgetPreloads();
      await loadChats(els.chatSearch.value);
    }
  } catch {
    /* a failed poll is not worth surfacing */
  }
}

async function startRuntime() {
  els.startRuntime.disabled = true;
  els.startRuntime.textContent = 'Starting';
  els.runtimeBar.classList.add('is-working');
  els.runtimeMsg.textContent = 'Launching Ollama and waiting for it to answer...';

  try {
    const res = await apiFetch('/api/runtime/start', { method: 'POST' });
    const payload = await res.json().catch(() => null);
    const result = payload?.result;
    if (res.ok && result?.ok) {
      els.runtimeMsg.textContent = `Ollama ${result.version} is up.`;
      await refreshRuntime();
    } else {
      els.runtimeBar.classList.remove('is-working');
      // A refused start — the configured backend is not one the supervisor can
      // drive — answers with an error and no result. Reading .ok off undefined
      // threw a TypeError into the catch and showed that instead of the reason.
      els.runtimeMsg.textContent = result?.error ?? payload?.error ?? 'Could not start Ollama.';
      els.startRuntime.disabled = false;
      els.startRuntime.textContent = 'Try again';
    }
  } catch (err) {
    els.runtimeBar.classList.remove('is-working');
    els.runtimeMsg.textContent = String(err.message ?? err);
    els.startRuntime.disabled = false;
    els.startRuntime.textContent = 'Try again';
  }
}

async function warmModel(id, button) {
  const name = state.models.find((m) => m.id === id)?.name ?? id;
  button.disabled = true;
  button.textContent = 'Loading';
  try {
    const res = await apiFetch('/api/runtime/warm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: id }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error ?? `server returned ${res.status}`);

    if (payload?.result?.ok) {
      clearNotice();
      button.textContent = 'Ready';
      notePreloaded(id);
    } else {
      notify(`Could not preload ${name}: ${payload?.result?.error ?? 'the runtime did not load it'}`);
      button.textContent = 'Retry';
    }
  } catch (err) {
    // Without this, a rejected fetch left the button reading "Loading" forever.
    notify(`Could not preload ${name}: ${err.message ?? err}`);
    button.textContent = 'Retry';
  } finally {
    button.disabled = false;
    await refreshRuntime();
  }
}

function renderFacts(data) {
  const rows = [
    ['Models bundled', `${data.models.length} · ${data.totalSizeGb} GiB`],
    ['Model folder', data.modelsDir],
    ['Chats saved to', data.chatsDir],
    ['Network', 'none — everything is local'],
  ];
  els.emptyFacts.replaceChildren(
    ...rows.map(([k, v]) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = k;
      const s = document.createElement('span');
      s.textContent = v;
      li.append(b, s);
      return li;
    }),
  );
}

/* ---------------- models ---------------- */

function renderModels() {
  els.modelList.replaceChildren(
    ...state.models.map((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `model${m.id === state.modelId ? ' is-active' : ''}`;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(m.id === state.modelId));
      btn.title = `${m.blurb}\n\n${m.quant} · ${m.sizeGb} GB · ${m.fit.note}`;

      const top = document.createElement('div');
      top.className = 'model-top';
      const name = document.createElement('span');
      name.className = 'model-name';
      name.textContent = m.name;
      const params = document.createElement('span');
      params.className = 'model-params';
      params.textContent = m.params;
      top.append(name, params);

      const tag = document.createElement('div');
      tag.className = 'model-tag';
      tag.textContent = m.tagline;

      const meta = document.createElement('div');
      meta.className = 'model-meta';
      const fit = document.createElement('span');
      fit.className = `fit fit-${m.fit.verdict}`;
      fit.textContent = m.fit.verdict;
      const size = document.createElement('span');
      size.textContent = `${m.sizeGb} GB`;
      const mode = document.createElement('span');
      mode.textContent = m.thinks ? 'reasons' : 'instant';
      meta.append(fit, size, mode);

      // Loading a 9B off disk costs about 20 seconds. Show whether it is already
      // resident, and offer to put it there before the first message rather than
      // during it.
      if (isResident(m.id)) {
        const res = document.createElement('span');
        res.className = 'model-resident';
        res.textContent = 'in VRAM';
        meta.append(res);
      } else if (state.runtimeUp && state.canWarm) {
        // Under llamacpp this button loaded the model into Ollama — a different
        // process from the one configured to answer — and reported success.
        const warm = document.createElement('button');
        warm.type = 'button';
        warm.className = 'model-warm';
        warm.textContent = 'Preload';
        warm.title = `Load ${m.name} into VRAM now so the first message is instant`;
        warm.addEventListener('click', (e) => {
          e.stopPropagation();
          warmModel(m.id, warm);
        });
        meta.append(warm);
      }

      btn.append(top, tag, meta);
      btn.addEventListener('click', () => selectModel(m.id));
      return btn;
    }),
  );
}

function selectModel(id) {
  state.modelId = id;
  localStorage.setItem('ls.modelId', id);
  renderModels();
  // Start the load now, not on the first message. Silent, and a no-op on a
  // runtime that cannot be preloaded — see preloadModel below.
  preloadModel(id);
  if (state.chatId) {
    apiFetch(`/api/chats/${state.chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: id }),
    }).catch(() => {});
  }
  els.prompt.focus();
}

/**
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

/**
 * Arrow keys inside the model list.
 *
 * It is a `role="radiogroup"`, and a radiogroup that only answers to clicks and
 * Tab is a lie told to a screen reader: the pattern promises arrows move the
 * selection. Selection is tracked in state rather than read off the focused
 * node, because renderModels() rebuilds every card and the focused element is
 * gone by the time the new one exists.
 */
function moveModelSelection(step) {
  const ids = state.models.map((m) => m.id);
  if (ids.length === 0) return;
  const at = ids.indexOf(state.modelId);
  const next = ids[(((at < 0 ? 0 : at) + step) % ids.length + ids.length) % ids.length];
  selectModel(next);
  els.modelList.children[ids.indexOf(next)]?.focus();
}

export {
  forgetPreloads,
  moveModelSelection,
  preloadModel,
  refreshRuntime,
  renderFacts,
  renderModels,
  renderRuntime,
  runtimeSignature,
  selectModel,
  startRuntime,
};
