/**
 * Landslide Local — front end.
 *
 * Deliberately dependency-free and framework-free: it must run from a folder on
 * a disk with no network. State lives on the server; this file renders it and
 * streams replies.
 *
 * Model output is never inserted as HTML. All message rendering lives in
 * render.js, which parses the markdown the models write and builds the elements
 * itself out of text nodes — nothing from a model is ever handed to the DOM as
 * markup. Each model's `format` profile from the catalog is passed through with
 * the text, so a reasoning trace and a page of prose are read differently.
 */

import { renderText, appendStream } from './render.js';

const $ = (id) => document.getElementById(id);

const els = {
  runtimeState: $('runtimeState'),
  modelList: $('modelList'),
  chatList: $('chatList'),
  chatSearch: $('chatSearch'),
  newChat: $('newChat'),
  thread: $('thread'),
  emptyState: $('emptyState'),
  emptyFacts: $('emptyFacts'),
  composer: $('composer'),
  prompt: $('prompt'),
  send: $('send'),
  charCount: $('charCount'),
  statusBar: $('statusBar'),
  statusLabel: $('statusLabel'),
  statusMeta: $('statusMeta'),
  timer: $('timer'),
  stopBtn: $('stopBtn'),
  storageHint: $('storageHint'),
  runtimeBar: $('runtimeBar'),
  runtimeMsg: $('runtimeMsg'),
  startRuntime: $('startRuntime'),
  notice: $('notice'),
  noticeMsg: $('noticeMsg'),
  noticeDismiss: $('noticeDismiss'),
  systemPrompt: $('systemPrompt'),
  promptLibrary: $('promptLibrary'),
  promptName: $('promptName'),
  savePrompt: $('savePrompt'),
  deletePrompt: $('deletePrompt'),
  contextMeter: $('contextMeter'),
  exportChat: $('exportChat'),
  regenerate: $('regenerate'),
  tpl: $('tpl-message'),
};

const state = {
  models: [],
  chats: [],
  prompts: [],
  modelId: localStorage.getItem('ls.modelId') || null,
  chatId: null,
  busy: false,
  loaded: [],
  runtimeUp: false,
  canWarm: false,
  runtimeSig: null,
  hardwareLabel: '',
  abort: null,
  timerHandle: null,
  startedAt: 0,
  // What the server was last told this chat's system prompt is. Without it
  // every keystroke would be a PATCH, and every send would rewrite an
  // unchanged field.
  savedSystemPrompt: '',
};

/* ---------------- server access ---------------- */

/**
 * Every request to this app's own API goes through here.
 *
 * With `security.token` empty — the default — this is a plain fetch and nothing
 * about the app changes. With a token set, the server answers 401 to any /api/
 * call without it, while still serving this page: that is the whole reason the
 * shell is left open, so there is somewhere to type the token in.
 *
 * A 401 therefore means "ask", not "fail". Ask once, keep the answer, retry the
 * same request. If the retry is refused too the stored token is wrong, so it is
 * discarded rather than left to fail every call from here on.
 *
 * localStorage is not a vault. It does not need to be: the token guards against
 * other processes on this machine reaching the API, and it came out of a config
 * file sitting on the same disk.
 */
const TOKEN_KEY = 'ls.token';

async function apiFetch(path, init = {}) {
  let res = await withToken(path, init);
  let refused = false;
  // Ask again on a wrong token rather than once. Each turn of this loop waits on
  // a click, so it cannot spin; dismissing the box gives up and returns the 401.
  while (res.status === 401) {
    const typed = await askForToken(refused);
    if (typed === null) return res;
    localStorage.setItem(TOKEN_KEY, typed);
    res = await withToken(path, init);
    if (res.status === 401) {
      // A stored token the server refuses is worse than none: it would fail
      // every request from here on with nothing to show for it.
      localStorage.removeItem(TOKEN_KEY);
      refused = true;
    }
  }
  return res;
}

/**
 * Ask inside the page, not through `window.prompt`.
 *
 * prompt() looks like the cheap answer and is not one. Chrome refuses it outright
 * in some embeddings — the call throws "prompt() is not supported" — and
 * suppresses it after the first dialog in others. Either way the failure lands on
 * the very first request the app makes, so the whole UI comes up empty with
 * nothing on screen to say why. Built out of nodes, never innerHTML.
 *
 * One ask at a time: boot fires several requests and each would otherwise put its
 * own box up. Everything after the first waits on the same answer.
 */
let tokenAsk = null;

function askForToken(refused = false) {
  tokenAsk ??= new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'notice-ask';

    const label = document.createElement('label');
    label.className = 'notice-msg';
    label.htmlFor = 'tokenInput';
    label.textContent = refused
      ? 'That token was refused. Check "security.token" in config.json and try again.'
      : 'This server is locked. Paste its access token — "security.token" in config.json.';

    const input = document.createElement('input');
    input.id = 'tokenInput';
    input.type = 'password';
    input.className = 'search';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const unlock = document.createElement('button');
    unlock.type = 'button';
    unlock.className = 'btn btn-sm btn-accent';
    unlock.textContent = 'Unlock';

    const onDismiss = () => done(null);
    const done = (value) => {
      els.noticeDismiss.removeEventListener('click', onDismiss);
      box.remove();
      els.noticeMsg.hidden = false;
      els.notice.hidden = true;
      tokenAsk = null;
      resolve(value);
    };

    unlock.addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(input.value.trim() || null);
      }
    });
    els.noticeDismiss.addEventListener('click', onDismiss);

    box.append(label, input, unlock);
    // The notice bar already survives every re-render, which is exactly what this
    // needs; its own message is hidden while the ask is up rather than competing.
    els.noticeMsg.hidden = true;
    els.notice.hidden = false;
    els.notice.insertBefore(box, els.noticeDismiss);
    input.focus();
  });
  return tokenAsk;
}

function withToken(path, init) {
  // Bare `fetch`, not `window.fetch`. They are the same function in a browser,
  // but `window` does not exist under the headless UI test, and spelling it the
  // browser-only way turned every one of those tests into "window is not
  // defined" the moment the two changes met.
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return fetch(path, init);
  return fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

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
  renderFacts(data);
  els.storageHint.textContent = data.chatsDir;
  els.storageHint.title = data.chatsDir;
}

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

const isResident = (id) => state.loaded.some((m) => m.name === id || m.name === `${id}:latest`);

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

    if (!wasUp && runtime.running) await loadChats(els.chatSearch.value);
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

/**
 * The one place a failure is allowed to live.
 *
 * A message written onto a model card is destroyed milliseconds later by the
 * next renderModels(), so the user never sees it. This element is outside every
 * list that gets rebuilt, and stays until it is dismissed or replaced.
 */
function notify(message) {
  els.noticeMsg.textContent = message;
  els.notice.hidden = false;
}

function clearNotice() {
  els.notice.hidden = true;
  els.noticeMsg.textContent = '';
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
  if (state.chatId) {
    apiFetch(`/api/chats/${state.chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: id }),
    }).catch(() => {});
  }
  preload(id);
  els.prompt.focus();
}

/**
 * Start loading the model once the choice has settled.
 *
 * A 9B off this SATA SSD is about twenty seconds, and the old flow spent every
 * one of them AFTER the first message was written — the one moment the user is
 * watching. Choosing a model is the natural place to pay it instead.
 *
 * The delay is not politeness, it is the difference between this helping and
 * this being unusable. Arrowing from the top of the list to the bottom passes
 * over every model on the way, and firing on each one asks an 8 GB card to load
 * five models back to back — the 21B alone locked the page for minutes when a
 * stray click landed on it. Only where the selection comes to rest is loaded.
 *
 * Failures stay silent: the Preload button on the card is the deliberate
 * version of this, and that one reports.
 */
const PRELOAD_SETTLE_MS = 400;
let preloadTimer = null;

function preload(id) {
  clearTimeout(preloadTimer);
  preloadTimer = null;
  if (!state.runtimeUp || !state.canWarm || isResident(id)) return;
  preloadTimer = setTimeout(() => {
    preloadTimer = null;
    // The selection may have moved on during the wait; only warm what is still
    // chosen, or a fast pass through the list still loads something nobody wants.
    if (state.modelId !== id) return;
    apiFetch('/api/runtime/warm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: id }),
    })
      .then(() => refreshRuntime())
      .catch(() => {});
  }, PRELOAD_SETTLE_MS);
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

const currentModel = () => state.models.find((m) => m.id === state.modelId);

/* ---------------- chats ---------------- */

async function loadChats(query = '') {
  const url = query ? `/api/chats?q=${encodeURIComponent(query)}` : '/api/chats';
  const res = await apiFetch(url);
  state.chats = (await res.json()).chats;
  renderChats();
}

function renderChats() {
  if (state.chats.length === 0) {
    const p = document.createElement('p');
    p.className = 'chat-sub';
    p.style.padding = '6px 8px';
    p.textContent = els.chatSearch.value ? 'No matches.' : 'No chats yet.';
    els.chatList.replaceChildren(p);
    return;
  }

  els.chatList.replaceChildren(
    ...state.chats.map((c) => {
      const row = document.createElement('div');
      row.className = `chat-row${c.id === state.chatId ? ' is-active' : ''}`;
      row.setAttribute('role', 'listitem');

      const main = document.createElement('div');
      main.className = 'chat-main';
      const t = document.createElement('div');
      t.className = 'chat-title';
      t.textContent = c.title;
      const s = document.createElement('div');
      s.className = 'chat-sub';
      const model = state.models.find((m) => m.id === c.modelId);
      s.textContent = `${c.messageCount} msg${c.messageCount === 1 ? '' : 's'}${model ? ` · ${model.name}` : ''}`;
      main.append(t, s);

      const del = document.createElement('button');
      del.className = 'chat-del';
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Delete chat';
      del.setAttribute('aria-label', `Delete ${c.title}`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(c.id);
      });

      row.append(main, del);
      row.addEventListener('click', () => openChat(c.id));
      return row;
    }),
  );
}

/**
 * Switching what the thread shows while a reply is streaming detaches the node
 * the stream is writing into, and the generation carries on with nowhere to go:
 * the GPU keeps working and the answer is lost. Stop first, then switch.
 */
function busyBlocks(action) {
  if (!state.busy) return false;
  notify(`${action} while a reply is generating would discard it. Press Stop (or Esc) first.`);
  return true;
}

/** Throws on failure: the caller has to decide what a dead server means for it. */
async function newChat() {
  const res = await apiFetch('/api/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: state.modelId }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(payload?.error ?? `could not create a chat (server returned ${res.status})`);
  }
  const { chat } = await res.json();
  state.chatId = chat.id;
  // A fresh chat starts with no system prompt on the server. Whatever is in the
  // box is kept — it is a working mode, not a per-chat accident — but it has to
  // be re-sent, so the record of what the server knows resets with the chat.
  state.savedSystemPrompt = '';
  renderContext(null);
  await loadChats(els.chatSearch.value);
  renderThread(chat);
  els.prompt.focus();
  return chat;
}

async function startNewChat() {
  if (busyBlocks('Starting a new chat')) return;
  try {
    await newChat();
    clearNotice();
  } catch (err) {
    notify(String(err.message ?? err));
  }
}

async function openChat(id) {
  if (busyBlocks('Opening another chat')) return;
  const res = await apiFetch(`/api/chats/${id}`);
  if (!res.ok) return;
  const { chat } = await res.json();
  state.chatId = chat.id;
  if (chat.modelId && state.models.some((m) => m.id === chat.modelId)) {
    state.modelId = chat.modelId;
    localStorage.setItem('ls.modelId', chat.modelId);
    renderModels();
  }
  // The stored prompt is this chat's, not the last one's. Carrying the previous
  // chat's steering into an old conversation would silently change what it is.
  state.savedSystemPrompt = typeof chat.systemPrompt === 'string' ? chat.systemPrompt : '';
  els.systemPrompt.value = state.savedSystemPrompt;
  // The meter reports the last turn that was actually sent, and no turn has
  // been sent in this chat yet this session.
  renderContext(null);
  renderChats();
  renderThread(chat);
  els.prompt.focus();
}

async function deleteChat(id) {
  // Same door as new-chat and the chat rows: deleting the chat being written
  // into detaches the node the stream targets, and the generation runs on with
  // nowhere to land. Deleting any OTHER chat is harmless and stays allowed.
  if (id === state.chatId && busyBlocks('Deleting this chat')) return;
  await apiFetch(`/api/chats/${id}`, { method: 'DELETE' });
  if (state.chatId === id) {
    state.chatId = null;
    els.thread.replaceChildren(els.emptyState);
    els.emptyState.hidden = false;
    renderContext(null);
  }
  await loadChats(els.chatSearch.value);
  updateChatActions();
}

/* ---------------- system prompt + prompt library ---------------- */

const systemPromptText = () => els.systemPrompt.value.trim();

/**
 * The prompt travels two ways on purpose: in the body of every send, so this
 * turn is steered even if the write has not landed, and PATCHed onto the chat,
 * so it is still there after a reload. Sending it only with the message would
 * mean a system prompt that quietly evaporates on F5.
 */
async function saveSystemPrompt() {
  if (!state.chatId) return;
  const text = systemPromptText();
  if (text === state.savedSystemPrompt) return;
  state.savedSystemPrompt = text;
  try {
    await apiFetch(`/api/chats/${state.chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt: text }),
    });
  } catch {
    /* the send carries the same text anyway; this only affects the next reload */
  }
}

async function loadPrompts() {
  try {
    const res = await apiFetch('/api/prompts');
    state.prompts = res.ok ? ((await res.json()).prompts ?? []) : [];
  } catch {
    state.prompts = [];
  }
  renderPrompts();
}

function renderPrompts() {
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = state.prompts.length ? 'Load a saved prompt' : 'No saved prompts';
  els.promptLibrary.replaceChildren(
    blank,
    ...state.prompts.map((p) => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      return option;
    }),
  );
  els.promptLibrary.value = '';
  els.deletePrompt.disabled = state.prompts.length === 0;
}

async function savePrompt() {
  const text = systemPromptText();
  if (!text) {
    notify('Write a system prompt before saving it.');
    return;
  }
  // A prompt with no name is unfindable in the list it was saved into, so one
  // is derived rather than refused — the server would refuse it outright.
  const name = els.promptName.value.trim() || text.replace(/\s+/g, ' ').slice(0, 40);
  const res = await apiFetch('/api/prompts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, text }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    notify(payload?.error ?? `could not save that prompt (server returned ${res.status})`);
    return;
  }
  els.promptName.value = '';
  clearNotice();
  await loadPrompts();
}

async function deletePrompt() {
  const id = els.promptLibrary.value;
  if (!id) {
    notify('Choose a saved prompt first, then Del removes it.');
    return;
  }
  await apiFetch(`/api/prompts/${id}`, { method: 'DELETE' }).catch(() => {});
  await loadPrompts();
}

function usePrompt() {
  const found = state.prompts.find((p) => p.id === els.promptLibrary.value);
  if (!found) return;
  els.systemPrompt.value = found.text;
  els.promptName.value = found.name;
  saveSystemPrompt();
}

/* ---------------- context meter + chat actions ---------------- */

/**
 * What the last turn cost against the window.
 *
 * `trimmed` is the number that matters: above zero, turns were left out of
 * what the model was shown. They are still on disk — this is a shorter view of
 * the conversation, not a smaller conversation — but the user has to be told,
 * because the alternative is a model that appears to have forgotten things for
 * no reason anyone can see.
 */
function renderContext(context) {
  if (!context || typeof context.estimatedTokens !== 'number') {
    els.contextMeter.textContent = '';
    els.contextMeter.classList.remove('is-tight');
    els.contextMeter.classList.remove('is-trimmed');
    return;
  }
  const used = context.estimatedTokens;
  const limit = context.limitTokens || 0;
  const dropped = context.trimmed || 0;
  els.contextMeter.textContent =
    `${used.toLocaleString()}/${limit.toLocaleString()} ctx` +
    (dropped > 0 ? ` · ${dropped} dropped` : '');
  els.contextMeter.title = dropped
    ? `${dropped} of the oldest turns did not fit this model's window and were left out of the last reply. They are still saved in the chat.`
    : `About ${used.toLocaleString()} of ${limit.toLocaleString()} tokens used by the last reply's prompt.`;
  els.contextMeter.classList.toggle('is-tight', limit > 0 && used / limit >= 0.75);
  els.contextMeter.classList.toggle('is-trimmed', dropped > 0);
}

const hasReply = () => Boolean(els.thread.querySelector('.msg-assistant'));

/** Export and Again only mean anything with a chat, and Again needs a reply. */
function updateChatActions() {
  if (state.chatId) els.exportChat.setAttribute('href', `/api/chats/${state.chatId}/export?format=md`);
  else els.exportChat.removeAttribute('href');
  els.exportChat.setAttribute('aria-disabled', String(!state.chatId));
  els.regenerate.disabled = !state.chatId || state.busy || !hasReply();
}

/**
 * Replace the last reply rather than asking the same question twice.
 *
 * The node comes off the thread here and the server drops the message from the
 * chat; the stream then writes a fresh one into the same place. Both halves or
 * neither — leaving the old node on screen while the server replaced the record
 * is how a thread starts disagreeing with what is on disk.
 */
async function regenerateReply() {
  if (busyBlocks('Regenerating')) return;
  if (!state.chatId) return;
  const last = [...els.thread.querySelectorAll('.msg-assistant')].pop();
  if (!last) {
    notify('There is no reply to regenerate yet.');
    return;
  }
  const model = currentModel();
  state.busy = true;
  els.thread.removeChild(last);
  await saveSystemPrompt();
  await streamReply({
    path: `/api/chats/${state.chatId}/regenerate`,
    payload: { modelId: model.id, systemPrompt: systemPromptText() },
    model,
  });
}

/* ---------------- thread rendering ---------------- */

function renderThread(chat) {
  els.thread.replaceChildren();
  if (chat.messages.length === 0) {
    els.emptyState.hidden = false;
    els.thread.append(els.emptyState);
    updateChatActions();
    return;
  }
  for (const m of chat.messages) {
    els.thread.append(buildMessage(m.role, m.content, m.thinking, m.stats));
  }
  updateChatActions();
  scrollToEnd();
}

/** What a finished turn that produced nothing shows — while streaming and after. */
const NO_OUTPUT = '[no output]';

/**
 * Build one message node.
 *
 * `pending` marks the empty shell a stream is about to be written into; every
 * other call is a finished turn, including the ones rebuilt from disk on reload.
 * Both reasoning and answer therefore go through render.js here, exactly as the
 * stream does. Reasoning used to be assigned with `textContent`: a model that
 * emitted a code fence — which reasoning models do constantly — showed a real
 * code block while it thought and literal backticks plus a stray language tag
 * after F5. The placeholder has the same problem in reverse: the stream wrote
 * [no output] and the reload wrote nothing.
 */
function buildMessage(role, content = '', thinking = '', stats = null, { pending = false } = {}) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  node.classList.add(role === 'user' ? 'msg-user' : 'msg-assistant');
  node.querySelector('.msg-role').textContent = role === 'user' ? 'You' : (currentModel()?.name ?? 'Model');

  // How this model writes, straight from the catalog via /api/state. A user's
  // own message is not a model's output, so it gets the neutral profile.
  const format = role === 'user' ? undefined : currentModel()?.format;

  const think = node.querySelector('.think');
  if (thinking) {
    think.hidden = false;
    renderText(node.querySelector('.think-text'), thinking, format);
  }

  const producedNothing = !pending && role !== 'user' && !content && !thinking;
  renderText(node.querySelector('.msg-text'), producedNothing ? NO_OUTPUT : content, format);
  if (stats) node.querySelector('.msg-stats').textContent = statLine(stats);
  return node;
}

/** Sub-second values read as "0.0s", which looks broken. Show ms below 1s. */
function dur(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statLine(s) {
  const bits = [];
  if (s.totalMs != null) bits.push(`${dur(s.totalMs)} total`);
  if (s.firstTokenMs != null) bits.push(`${dur(s.firstTokenMs)} to first token`);
  if (s.tokens) bits.push(`${s.tokens} tokens`);
  if (s.tokensPerSecond) bits.push(`${s.tokensPerSecond} tok/s`);
  return bits.join('  ·  ');
}

let thinkScrollQueued = false;
function scheduleThinkScroll(el) {
  if (thinkScrollQueued) return;
  thinkScrollQueued = true;
  requestAnimationFrame(() => {
    thinkScrollQueued = false;
    el.scrollTop = el.scrollHeight;
  });
}

let endScrollQueued = false;
function scrollToEnd() {
  if (endScrollQueued) return;
  endScrollQueued = true;
  requestAnimationFrame(() => {
    endScrollQueued = false;
    els.thread.scrollTop = els.thread.scrollHeight;
  });
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

/**
 * One reply, streamed into a fresh assistant node.
 *
 * Both doors — a new message and a regenerate — come through here so they
 * cannot drift apart: the same pending shell, the same abort handle, the same
 * finally that gives the composer back whatever happened. The caller has
 * already claimed `state.busy`.
 */
async function streamReply({ path, payload, model }) {
  const reply = buildMessage('assistant', '', '', null, { pending: true });
  const replyText = reply.querySelector('.msg-text');
  const think = reply.querySelector('.think');
  const thinkText = reply.querySelector('.think-text');
  const thinkTime = reply.querySelector('.think-time');
  const statsEl = reply.querySelector('.msg-stats');
  replyText.classList.add('is-streaming');
  els.thread.append(reply);
  scrollToEnd();

  setBusy(true, model.thinks ? 'Thinking' : 'Writing');

  state.abort = new AbortController();
  let answer = '';
  let reasoning = '';
  let sawAnswer = false;
  let thinkStartedAt = performance.now();

  try {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: state.abort.signal,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `server returned ${res.status}` }));
      throw new Error(err.error);
    }

    for await (const event of sseEvents(res.body)) {
      if (event.type === 'start') {
        renderContext(event.context);
        // The one thing this item exists to prevent: turns leaving the prompt
        // without anybody being told. It goes in the notice bar, which survives
        // every re-render, rather than anywhere that gets wiped.
        const dropped = event.context?.trimmed ?? 0;
        if (dropped > 0) {
          notify(
            `This conversation is past ${model.name}'s ${Number(event.context.limitTokens).toLocaleString()}-token window. ` +
              `The ${dropped} oldest turn${dropped === 1 ? '' : 's'} ${dropped === 1 ? 'was' : 'were'} left out of this reply — ` +
              'still saved in the chat, just not shown to the model.',
          );
        }
      } else if (event.type === 'think') {
        reasoning += event.text;
        think.hidden = false;
        if (!sawAnswer) think.open = true; // watch it reason, then get out of the way
        // Append, never re-assign: a real model emits thousands of reasoning
        // tokens, and replacing textContent each time is quadratic. Reading
        // scrollHeight here forced a synchronous reflow per token on top of it,
        // which was enough to lock the renderer on a long reasoning pass.
        appendStream(thinkText, reasoning, event.text);
        scheduleThinkScroll(thinkText);
        els.statusLabel.textContent = 'Thinking';
      } else if (event.type === 'answer') {
        if (!sawAnswer) {
          sawAnswer = true;
          els.statusLabel.textContent = 'Writing';
          if (reasoning) {
            thinkTime.textContent = dur(performance.now() - thinkStartedAt);
            think.open = false;
          }
        }
        answer += event.text;
        appendStream(replyText, answer, event.text);
        replyText.classList.add('is-streaming');
        scrollToEnd();
      } else if (event.type === 'stats') {
        els.statusMeta.textContent = `${event.stats.tokens} tok · ${event.stats.tokensPerSecond} tok/s`;
      } else if (event.type === 'done') {
        statsEl.textContent = statLine(event.stats) + (event.aborted ? '  ·  stopped' : '');
        await loadChats(els.chatSearch.value);
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      reply.classList.add('msg-error');
      renderText(replyText, answer ? `${answer}\n\n[${err.message}]` : `[${err.message}]`, model.format);
    }
  } finally {
    replyText.classList.remove('is-streaming');
    if (!answer && !reasoning && !reply.classList.contains('msg-error')) {
      renderText(replyText, NO_OUTPUT, model.format);
    }
    setBusy(false);
    state.abort = null;
    scrollToEnd();
  }
}

async function* sseEvents(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    yield* readFrames(reader, dec, buf);
  } finally {
    // An error thrown by the consumer (an SSE 'error' event) would otherwise
    // leave the reader locked and the body never cancelled.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

async function* readFrames(reader, dec, buf) {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          yield JSON.parse(line.slice(6));
        } catch {
          /* ignore a malformed frame rather than killing the stream */
        }
      }
    }
  }
}

/* ---------------- busy state + timer ---------------- */

function setBusy(busy, label = 'Thinking') {
  state.busy = busy;
  clearInterval(state.timerHandle); // never leave an orphaned interval ticking
  state.timerHandle = null;
  els.send.disabled = busy;
  els.prompt.disabled = busy;
  // Honest affordance for the gate in busyBlocks(): the button is not merely
  // ignored while a reply is streaming, it visibly cannot be pressed.
  els.newChat.disabled = busy;
  els.statusBar.hidden = !busy;
  updateChatActions();

  if (busy) {
    els.statusLabel.textContent = label;
    els.statusMeta.textContent = '';
    state.startedAt = performance.now();
    els.timer.textContent = '0.0s';
    state.timerHandle = setInterval(() => {
      els.timer.textContent = `${((performance.now() - state.startedAt) / 1000).toFixed(1)}s`;
    }, 100);
  } else {
    els.prompt.focus();
  }
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
