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
  tpl: $('tpl-message'),
};

const state = {
  models: [],
  chats: [],
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
};

/* ---------------- boot ---------------- */

init().catch((err) => fail(`Could not start: ${err.message}`));

async function init() {
  await loadState();
  await loadChats();
  wireEvents();
  autoGrow();
}

async function loadState() {
  const res = await fetch('/api/state');
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
    const { runtime } = await (await fetch('/api/runtime')).json();
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
    const res = await fetch('/api/runtime/start', { method: 'POST' });
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
    const res = await fetch('/api/runtime/warm', {
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
    fetch(`/api/chats/${state.chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: id }),
    }).catch(() => {});
  }
  els.prompt.focus();
}

const currentModel = () => state.models.find((m) => m.id === state.modelId);

/* ---------------- chats ---------------- */

async function loadChats(query = '') {
  const url = query ? `/api/chats?q=${encodeURIComponent(query)}` : '/api/chats';
  const res = await fetch(url);
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
  const res = await fetch('/api/chats', {
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
  const res = await fetch(`/api/chats/${id}`);
  if (!res.ok) return;
  const { chat } = await res.json();
  state.chatId = chat.id;
  if (chat.modelId && state.models.some((m) => m.id === chat.modelId)) {
    state.modelId = chat.modelId;
    localStorage.setItem('ls.modelId', chat.modelId);
    renderModels();
  }
  renderChats();
  renderThread(chat);
  els.prompt.focus();
}

async function deleteChat(id) {
  // Same door as new-chat and the chat rows: deleting the chat being written
  // into detaches the node the stream targets, and the generation runs on with
  // nowhere to land. Deleting any OTHER chat is harmless and stays allowed.
  if (id === state.chatId && busyBlocks('Deleting this chat')) return;
  await fetch(`/api/chats/${id}`, { method: 'DELETE' });
  if (state.chatId === id) {
    state.chatId = null;
    els.thread.replaceChildren(els.emptyState);
    els.emptyState.hidden = false;
  }
  await loadChats(els.chatSearch.value);
}

/* ---------------- thread rendering ---------------- */

function renderThread(chat) {
  els.thread.replaceChildren();
  if (chat.messages.length === 0) {
    els.emptyState.hidden = false;
    els.thread.append(els.emptyState);
    return;
  }
  for (const m of chat.messages) {
    els.thread.append(buildMessage(m.role, m.content, m.thinking, m.stats));
  }
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
    const res = await fetch(`/api/chats/${state.chatId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: state.abort.signal,
      body: JSON.stringify({ content: text, modelId: model.id }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `server returned ${res.status}` }));
      throw new Error(err.error);
    }

    for await (const event of sseEvents(res.body)) {
      if (event.type === 'think') {
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

  els.composer.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, kbd, textarea')) return;
    e.preventDefault();
    els.prompt.focus();
  });

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
