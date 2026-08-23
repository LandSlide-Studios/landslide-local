/**
 * Landslide Local — front end.
 *
 * Deliberately dependency-free and framework-free: it must run from a folder on
 * a disk with no network. State lives on the server; this file renders it and
 * streams replies.
 *
 * Model output is never inserted as HTML. The only rich rendering is fenced code
 * and inline code, both built as DOM nodes from escaped text.
 */

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
  tpl: $('tpl-message'),
};

const state = {
  models: [],
  chats: [],
  modelId: localStorage.getItem('ls.modelId') || null,
  chatId: null,
  busy: false,
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

  renderRuntime(data);
  renderModels();
  renderFacts(data);
  els.storageHint.textContent = data.chatsDir;
  els.storageHint.title = data.chatsDir;
}

function renderRuntime(data) {
  const r = data.runtime;
  els.runtimeState.textContent = r.ok
    ? `${r.adapter} ready · ${data.hardware.label}`
    : `${r.adapter} offline`;
  els.runtimeState.className = `runtime-state ${r.ok ? 'is-ok' : 'is-bad'}`;
  els.runtimeState.title = r.ok ? (r.url ?? '') : r.error ?? '';
}

function renderFacts(data) {
  const rows = [
    ['Models bundled', `${data.models.length} · ${data.totalSizeGb} GB`],
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

async function newChat() {
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: state.modelId }),
  });
  const { chat } = await res.json();
  state.chatId = chat.id;
  await loadChats(els.chatSearch.value);
  renderThread(chat);
  els.prompt.focus();
}

async function openChat(id) {
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

function buildMessage(role, content = '', thinking = '', stats = null) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  node.classList.add(role === 'user' ? 'msg-user' : 'msg-assistant');
  node.querySelector('.msg-role').textContent = role === 'user' ? 'You' : (currentModel()?.name ?? 'Model');

  const think = node.querySelector('.think');
  if (thinking) {
    think.hidden = false;
    node.querySelector('.think-text').textContent = thinking;
  }

  renderText(node.querySelector('.msg-text'), content);
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

/** Fenced and inline code only, all built from text nodes. Never innerHTML. */
function renderText(el, text) {
  el.replaceChildren();
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.replace(/^[a-zA-Z0-9+-]*\n/, '');
      pre.append(code);
      el.append(pre);
    } else {
      appendInline(el, part);
    }
  });
}

function appendInline(el, text) {
  const chunks = String(text).split(/`/);
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const code = document.createElement('code');
      code.textContent = chunk;
      el.append(code);
    } else if (chunk) {
      el.append(document.createTextNode(chunk));
    }
  });
}

function scrollToEnd() {
  els.thread.scrollTop = els.thread.scrollHeight;
}

/* ---------------- sending ---------------- */

async function send(text) {
  if (state.busy) return;
  if (!state.chatId) await newChat();

  const model = currentModel();
  els.emptyState.hidden = true;
  if (els.thread.contains(els.emptyState)) els.thread.removeChild(els.emptyState);

  els.thread.append(buildMessage('user', text));
  const reply = buildMessage('assistant', '');
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
        thinkText.textContent = reasoning;
        thinkText.scrollTop = thinkText.scrollHeight;
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
        renderText(replyText, answer);
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
      renderText(replyText, answer ? `${answer}\n\n[${err.message}]` : `[${err.message}]`);
    }
  } finally {
    replyText.classList.remove('is-streaming');
    if (!answer && !reasoning && !reply.classList.contains('msg-error')) {
      renderText(replyText, '[no output]');
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
  els.send.disabled = busy;
  els.prompt.disabled = busy;
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
    clearInterval(state.timerHandle);
    state.timerHandle = null;
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

  els.stopBtn.addEventListener('click', () => state.abort?.abort());
  els.newChat.addEventListener('click', () => newChat());

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
      newChat();
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
