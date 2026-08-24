/**
 * Landslide Local — front end.
 *
 * Deliberately dependency-free and framework-free: it must run from a folder on
 * a disk with no network. State lives on the server; this file boots the page,
 * loads that state, and wires the controls to the modules that own each part of
 * it.
 *
 * Model output is never inserted as HTML. All message rendering lives in
 * render.js, which parses the markdown the models write and builds the elements
 * itself out of text nodes — nothing from a model is ever handed to the DOM as
 * markup. Each model's `format` profile from the catalog is passed through with
 * the text, so a reasoning trace and a page of prose are read differently.
 *
 * What used to be one file is now one module per part of the page. The seams are
 * the ones the page already had:
 *
 *   dom.js           the element table, the shared state, and the notice bar
 *   api-client.js    every request to this app's own API, and the token prompt
 *   models.js        the model rail and the runtime bar
 *   sidebar.js       the chat list
 *   chats.js         create / open / delete / regenerate
 *   message-view.js  a conversation as nodes, plus the context meter
 *   stream.js        one reply, from request to composer coming back
 *   prompts.js       the system prompt and its library
 *   render.js        markdown -> DOM, and the only module allowed to do it
 */

import { apiFetch } from './api-client.js';
import { branchFromMessage, newChat, regenerateReply, startNewChat } from './chats.js';
import { clearNotice, currentModel, els, mountDom, notify, state } from './dom.js';
import { initAgainMenu } from './again-menu.js';
import { initPreload } from './preload.js';
import { initVram, renderVram } from './vram.js';
import { buildMessage, updateChatActions } from './message-view.js';
import {
  moveModelSelection,
  refreshRuntime,
  renderFacts,
  renderModels,
  renderRuntime,
  runtimeSignature,
  startRuntime,
} from './models.js';
import { deletePrompt, loadPrompts, savePrompt, saveSystemPrompt, systemPromptText, usePrompt } from './prompts.js';
import { loadChats } from './sidebar.js';
import { streamReply } from './stream.js';

/* ---------------- boot ---------------- */

/**
 * In a browser this module still starts itself the moment it is imported — the
 * `<script type="module">` at the end of index.html loads it after the elements
 * above exist, exactly as before.
 *
 * There is no `window` under Node, and that is the whole point of the guard:
 * `test/ui.test.js` builds a DOM from the real index.html, imports this file
 * against it and calls `init()` itself, so a full send/stream/render cycle can
 * be driven and awaited with no human and no browser present. Booting on import
 * would leave that test racing a promise it has no handle on.
 */
if (typeof window !== 'undefined') {
  init().catch((err) => fail(`Could not start: ${err.message}`));
}

export async function init() {
  // Bind the element table to THIS document before anything reads it.
  mountDom();
  await loadState();
  await loadChats();
  await loadPrompts();
  wireEvents();
  autoGrow();
  updateChatActions();
}

async function loadState() {
  const res = await apiFetch('/api/state');
  // Boot used to walk straight into `data.models[0]` on the assumption that a
  // server on this machine always answers. A refused token is a 401 with a JSON
  // body, and reading it as state turned an expected outcome into a TypeError
  // where the reason should be.
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(
      res.status === 401
        ? 'this server needs an access token — reload and paste it in'
        : (payload?.error ?? `the server answered ${res.status}`),
    );
  }
  const data = await res.json();
  state.models = data.models;

  if (!state.modelId || !state.models.some((m) => m.id === state.modelId)) {
    state.modelId = state.models[0].id;
  }

  state.hardwareLabel = data.hardware.label;
  const view = data.supervisor ?? {};
  state.runtimeSig = runtimeSignature(view);
  renderRuntime(view);
  renderModels();
  // Boot draws the same three things the poll redraws. Leaving this one out is
  // not a missing frame: loadState also seeds runtimeSig, so the poll sees no
  // change and never redraws either - the panel would stay hidden until
  // residency happened to move, which is the one case where it matters least.
  renderVram();
  renderFacts(data);
  els.storageHint.textContent = data.chatsDir;
  els.storageHint.title = data.chatsDir;
}

/* ---------------- sending ---------------- */

async function send(text) {
  if (state.busy) return;
  state.busy = true; // claim synchronously: `await newChat()` below yields, and
  // Enter autorepeat walks straight into the gap, creating two chats and two
  // concurrent streams that overwrite each other's abort handle and timer.
  if (!state.chatId) {
    try {
      await newChat();
    } catch (err) {
      // The claim above is only safe if every path out of here releases it.
      // It did not: a failed create threw before setBusy(true) ever ran, so
      // busy stayed true, the composer stayed dead and only a reload recovered.
      state.busy = false;
      notify(`Could not start a chat: ${err.message ?? err}. Your message was not sent.`);
      els.prompt.value = text;
      updateCount();
      autoGrow();
      els.prompt.focus();
      return;
    }
  }

  const model = currentModel();
  els.emptyState.hidden = true;
  if (els.thread.contains(els.emptyState)) els.thread.removeChild(els.emptyState);

  els.thread.append(buildMessage('user', text));
  await saveSystemPrompt();
  await streamReply({
    path: `/api/chats/${state.chatId}/message`,
    payload: { content: text, modelId: model.id, systemPrompt: systemPromptText() },
    model,
  });
}

function fail(message) {
  els.runtimeState.textContent = message;
  els.runtimeState.className = 'runtime-state is-bad';
}

/* ---------------- events ---------------- */

function wireEvents() {
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.prompt.value.trim();
    if (!text || state.busy) return;
    els.prompt.value = '';
    autoGrow();
    updateCount();
    send(text);
  });

  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });

  els.prompt.addEventListener('input', () => {
    autoGrow();
    updateCount();
  });

  // `a` is in this list for the Export link: swallowing its mousedown would
  // take focus off it, and a download link the keyboard cannot reach is the
  // same defect this item is fixing everywhere else.
  els.composer.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, kbd, textarea, a')) return;
    e.preventDefault();
    els.prompt.focus();
  });

  els.modelList.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    moveModelSelection(e.key === 'ArrowDown' ? 1 : -1);
  });

  els.systemPrompt.addEventListener('change', () => saveSystemPrompt());
  els.promptLibrary.addEventListener('change', () => usePrompt());
  els.savePrompt.addEventListener('click', () => savePrompt());
  els.deletePrompt.addEventListener('click', () => deletePrompt());
  els.regenerate.addEventListener('click', () => regenerateReply());
  // Delegated: renderThread() rebuilds every node, so per-node handlers would be
  // re-bound on every open — and message-view.js importing chats.js to bind them
  // would close a cycle.
  els.thread.addEventListener('click', (e) => {
    const button = e.target.closest?.('.msg-branch');
    if (!button) return;
    branchFromMessage(button.closest('.msg')?.getAttribute('data-message-id'));
  });
  initAgainMenu((modelId) => regenerateReply(modelId));
  // Preloading finishes by refreshing the runtime view, which redraws the
  // rail. Handed in here rather than imported so preload.js never has to
  // import the rail it redraws.
  initPreload({ onSettled: refreshRuntime });
  initVram({ onChanged: refreshRuntime });

  els.startRuntime.addEventListener('click', () => startRuntime());
  setInterval(() => {
    if (!state.busy) refreshRuntime();
  }, 12000);

  els.stopBtn.addEventListener('click', () => state.abort?.abort());
  els.newChat.addEventListener('click', () => startNewChat());
  els.noticeDismiss.addEventListener('click', () => clearNotice());

  let searchTimer;
  els.chatSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadChats(els.chatSearch.value), 160);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      els.chatSearch.focus();
      els.chatSearch.select();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      startNewChat();
    }
    if (e.key === 'Escape' && state.busy) state.abort?.abort();
  });
}

function autoGrow() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 260)}px`;
}

function updateCount() {
  const n = els.prompt.value.length;
  els.charCount.textContent = n > 0 ? `${n.toLocaleString()} chars` : '';
  els.charCount.classList.toggle('is-long', n > 6000);
}
