/**
 * UI — the real page, driven end to end with nobody watching.
 *
 * Every UI defect this project has had was found by a human looking at a
 * screen: a status bar that rendered while idle, a `[hidden]` attribute losing
 * to `display:flex`, a renderer that locked the page at eleven thousand
 * characters of reasoning. None of them had a test, because testing them
 * appeared to need a browser, and a browser is an npm dependency this project
 * is not allowed to have.
 *
 * It does not need one. What those defects actually live in is the DOM the
 * frontend produces, and the DOM is a small object graph. So this file:
 *
 *   1. parses the real `public/index.html` — not a fixture, not a copy — into a
 *      shim implementing only the DOM surface `app.js` and `render.js` touch;
 *   2. starts the real `createServer()` on an ephemeral loopback port with the
 *      fake runtime adapter, so a scripted reply with a real `<think>` block
 *      streams over real SSE;
 *   3. imports the real `public/app.js` against that shim with `fetch` pointed
 *      at that server, and drives a whole send -> stream -> render cycle;
 *   4. asserts on the resulting message DOM and on the busy/idle state.
 *
 * What it cannot see: layout, colour, fonts, and whether `[hidden]` actually
 * wins the cascade. Only a browser sees those, so the CSS half of the hidden
 * defect is pinned the one way a shim honestly can — by asserting the global
 * rule that gives the attribute its authority still exists. Opening the app and
 * looking at it remains a step; this file is the part of it that can run
 * unattended.
 *
 *   node --test --test-force-exit test/ui.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');
const APP_JS = path.join(ROOT, 'public', 'app.js');
const STYLES_CSS = path.join(ROOT, 'public', 'styles.css');

/* ================================================================== */
/* A DOM small enough to read, real enough to fail                     */
/* ================================================================== */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function createTextNode(data) {
  const node = {
    nodeType: TEXT_NODE,
    tagName: null,
    data: String(data),
    parentNode: null,
    childNodes: [],
    appendData(s) {
      node.data += s;
    },
    cloneNode() {
      return createTextNode(node.data);
    },
  };
  Object.defineProperty(node, 'textContent', {
    get: () => node.data,
    set: (v) => {
      node.data = String(v);
    },
    enumerable: true,
  });
  return node;
}

/** Reflected boolean attributes. `hidden` is the one this file exists for. */
const BOOL_PROPS = ['hidden', 'disabled', 'open', 'checked', 'selected'];

function createElement(tag) {
  const el = {
    nodeType: ELEMENT_NODE,
    tagName: String(tag).toUpperCase(),
    attributes: Object.create(null),
    childNodes: [],
    parentNode: null,
    style: {},
    value: '',
    scrollTop: 0,
    scrollHeight: 0,
    _classes: new Set(),
    _listeners: new Map(),
  };

  Object.defineProperty(el, 'className', {
    get: () => [...el._classes].join(' '),
    set: (v) => {
      el._classes = new Set(String(v ?? '').split(/\s+/).filter(Boolean));
      el.attributes.class = el.className;
    },
    enumerable: true,
  });

  el.classList = {
    add: (...names) => names.forEach((n) => el._classes.add(n)),
    remove: (...names) => names.forEach((n) => el._classes.delete(n)),
    contains: (n) => el._classes.has(n),
    toggle: (n, force) => {
      const on = force === undefined ? !el._classes.has(n) : !!force;
      if (on) el._classes.add(n);
      else el._classes.delete(n);
      return on;
    },
  };

  // The DOM reflects these both ways. That matters here: the defect was an
  // element the app believed it had hidden, so `hidden` and the attribute a
  // stylesheet selects on must never be able to disagree.
  for (const name of BOOL_PROPS) {
    let on = false;
    Object.defineProperty(el, name, {
      get: () => on,
      set: (next) => {
        on = !!next;
        if (on) el.attributes[name] = '';
        else delete el.attributes[name];
      },
      enumerable: true,
    });
  }

  for (const name of ['id', 'title']) {
    Object.defineProperty(el, name, {
      get: () => el.attributes[name] ?? '',
      set: (v) => {
        el.attributes[name] = String(v ?? '');
      },
      enumerable: true,
    });
  }

  Object.defineProperty(el, 'textContent', {
    get: () => el.childNodes.map((c) => c.textContent).join(''),
    set: (v) => {
      for (const c of el.childNodes) c.parentNode = null;
      el.childNodes = v === '' || v == null ? [] : [adopt(el, createTextNode(v))];
    },
    enumerable: true,
  });

  Object.defineProperty(el, 'lastChild', { get: () => el.childNodes.at(-1) ?? null });
  Object.defineProperty(el, 'children', {
    get: () => el.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
  });
  Object.defineProperty(el, 'firstElementChild', { get: () => el.children[0] ?? null });

  el.setAttribute = (k, v) => {
    if (k === 'class') el.className = v;
    else if (BOOL_PROPS.includes(k)) el[k] = true;
    else el.attributes[k] = String(v);
  };
  el.getAttribute = (k) => (k in el.attributes ? el.attributes[k] : null);
  el.hasAttribute = (k) => k in el.attributes;
  el.removeAttribute = (k) => {
    if (BOOL_PROPS.includes(k)) el[k] = false;
    else delete el.attributes[k];
  };

  el.append = (...kids) => {
    for (const k of kids) el.childNodes.push(adopt(el, k));
  };
  el.appendChild = (kid) => {
    el.append(kid);
    return kid;
  };
  el.replaceChildren = (...kids) => {
    for (const c of el.childNodes) c.parentNode = null;
    el.childNodes = kids.map((k) => adopt(el, k));
  };
  el.removeChild = (kid) => {
    const i = el.childNodes.indexOf(kid);
    if (i !== -1) {
      el.childNodes.splice(i, 1);
      kid.parentNode = null;
    }
    return kid;
  };
  el.contains = (node) => {
    for (let n = node; n; n = n.parentNode) if (n === el) return true;
    return false;
  };

  el.querySelector = (sel) => descendants(el).find((d) => matches(d, sel)) ?? null;
  el.querySelectorAll = (sel) => descendants(el).filter((d) => matches(d, sel));
  el.closest = (sel) => {
    for (let n = el; n; n = n.parentNode) if (n.nodeType === ELEMENT_NODE && matches(n, sel)) return n;
    return null;
  };

  el.cloneNode = (deep) => {
    const copy = createElement(el.tagName);
    for (const [k, v] of Object.entries(el.attributes)) {
      if (BOOL_PROPS.includes(k)) copy[k] = true;
      else if (k === 'class') copy.className = v;
      else copy.attributes[k] = v;
    }
    copy._classes = new Set(el._classes);
    copy.value = el.value;
    copy.style = { ...el.style };
    if (deep) copy.append(...el.childNodes.map((c) => c.cloneNode(true)));
    return copy;
  };

  el.addEventListener = (type, fn, opts) => {
    if (!el._listeners.has(type)) el._listeners.set(type, []);
    el._listeners.get(type).push({ fn, capture: opts === true || opts?.capture === true });
  };
  el.removeEventListener = (type, fn) => {
    const list = el._listeners.get(type);
    if (list) el._listeners.set(type, list.filter((l) => l.fn !== fn));
  };
  el.dispatchEvent = (event) => dispatch(el, event);

  el.focus = () => {};
  el.blur = () => {};
  el.select = () => {};
  el.requestSubmit = () => dispatch(el, makeEvent('submit'));

  return el;
}

function adopt(parent, child) {
  if (child.parentNode && child.parentNode !== parent) child.parentNode.removeChild(child);
  child.parentNode = parent;
  return child;
}

function descendants(el) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType !== ELEMENT_NODE) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** Simple selectors only — `tag`, `.class`, `#id`, and comma lists of those. */
function matches(el, selector) {
  return String(selector)
    .split(',')
    .some((part) => {
      const tokens = part.trim().match(/^[a-zA-Z][\w-]*|[.#][\w-]+/g);
      if (!tokens) return false;
      return tokens.every((t) => {
        if (t[0] === '.') return el._classes.has(t.slice(1));
        if (t[0] === '#') return el.attributes.id === t.slice(1);
        return el.tagName === t.toUpperCase();
      });
    });
}

function makeEvent(type, extra = {}) {
  const event = {
    type,
    target: null,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.propagationStopped = true;
    },
    ...extra,
  };
  return event;
}

/** Real bubbling: a handler calling stopPropagation() must actually stop it. */
/**
 * Both phases, in the real order: capture from the root down to the target,
 * then the target, then bubble back up.
 *
 * This used to be bubble-only, with the third argument to addEventListener
 * ignored. That is not a simplification, it is an inversion: a capture listener
 * on `document` fires FIRST in a browser and LAST in a bubble-only shim, so a
 * bug where a document-level capture handler pre-empts a control's own click
 * handler could not be expressed here at all. One was shipped behind exactly
 * that gap.
 */
function dispatch(target, event) {
  event.target = event.target ?? target;
  const path = [];
  for (let n = target; n; n = n.parentNode ?? n._parentDocument ?? null) path.push(n);

  // Capture: outermost first, not including the target.
  for (let i = path.length - 1; i >= 1; i--) {
    for (const l of path[i]._listeners?.get(event.type) ?? []) {
      if (!l.capture) continue;
      l.fn.call(path[i], event);
      if (event.propagationStopped) return !event.defaultPrevented;
    }
  }
  // At the target both kinds fire, in registration order; then bubble.
  for (const n of path) {
    for (const l of n._listeners?.get(event.type) ?? []) {
      if (n !== target && l.capture) continue; // already ran in the capture pass
      l.fn.call(n, event);
      if (event.propagationStopped) return !event.defaultPrevented;
    }
  }
  return !event.defaultPrevented;
}

/* ------------------------------------------------------------------ */
/* HTML -> that DOM. Enough of a parser for the page this app serves.  */
/* ------------------------------------------------------------------ */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×' };

const decode = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

function parseHtml(html) {
  const root = createElement('#document');
  const stack = [root];
  const top = () => stack[stack.length - 1];

  const TOKEN =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z][\w:-]*)\s*>|<([a-z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*(\/?)>/gi;

  let cursor = 0;
  let m;
  while ((m = TOKEN.exec(html)) !== null) {
    addText(top(), html.slice(cursor, m.index));
    cursor = TOKEN.lastIndex;

    const [whole, closeTag, openTag, attrText, selfClose] = m;
    if (!closeTag && !openTag) continue; // comment or doctype

    if (closeTag) {
      const name = closeTag.toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const el = createElement(openTag);
    for (const a of attrText.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = a[1].toLowerCase();
      const raw = a[2] ?? a[3] ?? a[4];
      el.setAttribute(name, raw === undefined ? '' : decode(raw));
      if (name === 'value') el.value = raw === undefined ? '' : decode(raw);
    }
    top().append(el);

    const lower = openTag.toLowerCase();
    if (VOID.has(lower) || selfClose) continue;

    if (RAW_TEXT.has(lower)) {
      const end = html.toLowerCase().indexOf(`</${lower}`, cursor);
      const body = end === -1 ? html.slice(cursor) : html.slice(cursor, end);
      if (body.trim()) el.append(createTextNode(body));
      cursor = end === -1 ? html.length : html.indexOf('>', end) + 1;
      TOKEN.lastIndex = cursor;
      continue;
    }

    stack.push(el);
  }
  addText(top(), html.slice(cursor));

  // A <template>'s children are inert and live in .content — which is exactly
  // why app.js can clone one per message without the page ever showing it.
  for (const tpl of descendants(root).filter((d) => d.tagName === 'TEMPLATE')) {
    const content = createElement('#fragment');
    content.append(...tpl.childNodes.slice());
    tpl.childNodes = [];
    tpl.content = content;
  }

  return root;
}

/** Inter-tag whitespace carries nothing this app reads, and hides real text. */
function addText(parent, raw) {
  if (!raw || !raw.trim()) return;
  parent.append(createTextNode(decode(raw)));
}

function makeDocument(root) {
  const doc = {
    nodeType: 9,
    _listeners: new Map(),
    documentElement: root.querySelector('html') ?? root,
    body: root.querySelector('body') ?? root,
    createElement,
    createTextNode,
    createDocumentFragment: () => createElement('#fragment'),
    getElementById: (id) => descendants(root).find((d) => d.attributes.id === id) ?? null,
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    addEventListener: (type, fn, opts) => {
      if (!doc._listeners.has(type)) doc._listeners.set(type, []);
      doc._listeners.get(type).push({ fn, capture: opts === true || opts?.capture === true });
    },
    removeEventListener: () => {},
    dispatchEvent: (event) => dispatch(doc, event),
  };
  // Events dispatched on an element bubble to the document, the way the
  // Ctrl+K and Escape handlers in app.js expect them to.
  root._parentDocument = doc;
  return doc;
}

/* ================================================================== */
/* Mounting the real page against the real server                      */
/* ================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = false;
    try {
      value = predicate();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(2);
  }
}

let mountCount = 0;

/**
 * Start the app's own server on an ephemeral loopback port, build the DOM from
 * public/index.html, and boot the real frontend against both.
 *
 * The fake runtime adapter is a runtime the app already ships; its default
 * script carries a real `<think>` block, so the reasoning path is exercised for
 * the same reason verify-live now names a thinking model.
 */
async function mount({ script, delayMs = 0, chunkSize = 4 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-ui-'));
  const { server, config } = await createServer({
    server: { port: 0 },
    // Never the configured chats dir: that one is the live install, shared by
    // every worktree of this repo.
    storage: { chatsDir: dir, logFile: '' },
    runtime: { adapter: 'fake', delayMs, chunkSize, ...(script ? { script } : {}) },
  });
  await new Promise((r) => server.listen(0, config.server.host, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const root = parseHtml(await fs.readFile(INDEX_HTML, 'utf8'));
  const document = makeDocument(root);

  const saved = {};
  const install = (name, value) => {
    saved[name] = globalThis[name];
    globalThis[name] = value;
  };

  install('document', document);
  install('Node', { ELEMENT_NODE, TEXT_NODE });
  install('localStorage', storageShim());
  // Relative URLs are what the page really uses; this is the only thing
  // standing in for the browser's notion of an origin.
  install('fetch', (input, init) => saved.fetch(new URL(String(input), base), init));
  install('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
  install('cancelAnimationFrame', (h) => clearTimeout(h));
  // app.js polls the runtime on a 12s interval and ticks a timer at 100ms.
  // A browser has no unref; a test runner needs one or the loop never drains.
  install('setInterval', (fn, ms, ...rest) => {
    const handle = saved.setInterval(fn, ms, ...rest);
    handle?.unref?.();
    return handle;
  });

  const app = await import(`${pathToFileURL(APP_JS).href}?mount=${++mountCount}`);
  await app.init();

  const byId = (id) => {
    const el = document.getElementById(id);
    assert.ok(el, `#${id} is missing from index.html`);
    return el;
  };

  return {
    app,
    base,
    dir,
    document,
    byId,
    /** Type into the composer and submit it, exactly as pressing Send does. */
    submit(text) {
      const prompt = byId('prompt');
      prompt.value = text;
      dispatch(prompt, makeEvent('input'));
      return dispatch(byId('composer'), makeEvent('submit'));
    },
    press(key, extra = {}) {
      return dispatch(document, makeEvent('keydown', { key, ...extra }));
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      for (const [name, value] of Object.entries(saved)) globalThis[name] = value;
      // Aborting a reply is one of the things under test, and an aborted
      // request still saves what it generated. That write can land a tick after
      // the socket is gone, so on Windows the rmdir races it and throws
      // ENOTEMPTY. Retry, then let it go: whether the OS temp folder is empty
      // is housekeeping, not something this file asserts.
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
    },
  };
}

function storageShim() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

const SCRIPTED = '<think>Working out what they meant.</think>This is a scripted reply.';

/**
 * A finished turn: the composer is back and the reply carries its stat line.
 * The stat line has to be read off the ASSISTANT message — every message node
 * is cloned from the same template, so the user's `.msg-stats` exists too and
 * is permanently empty.
 */
const finished = (thread) =>
  Boolean(
    globalThis.document.getElementById('statusBar').hidden === true &&
      thread.querySelector('.msg-assistant')?.querySelector('.msg-stats').textContent,
  );

/* ================================================================== */
/* The tests                                                           */
/* ================================================================== */

test('the shim parses the real index.html into the elements app.js reaches for', async () => {
  const root = parseHtml(await fs.readFile(INDEX_HTML, 'utf8'));
  const doc = makeDocument(root);
  for (const id of ['statusBar', 'composer', 'prompt', 'send', 'thread', 'modelList', 'chatList', 'tpl-message']) {
    assert.ok(doc.getElementById(id), `#${id} not found — the shim would be testing a page that is not the app's`);
  }
  // The hidden-by-default elements have to arrive hidden, or a test asserting
  // the idle state would be asserting nothing.
  assert.equal(doc.getElementById('statusBar').hidden, true, 'the status bar must start hidden');
  assert.equal(doc.getElementById('statusBar').getAttribute('hidden'), '', 'and the attribute must reflect it');
  assert.equal(doc.getElementById('notice').hidden, true);

  const tpl = doc.getElementById('tpl-message');
  assert.ok(tpl.content, '<template> content must be inert, not in the page');
  assert.equal(tpl.childNodes.length, 0);
  const msg = tpl.content.firstElementChild;
  assert.equal(msg.tagName, 'ARTICLE');
  for (const sel of ['.msg-role', '.msg-text', '.msg-stats', '.think', '.think-text', '.think-time']) {
    assert.ok(msg.querySelector(sel), `the message template must contain ${sel}`);
  }
  assert.equal(msg.querySelector('.think').hidden, true, 'reasoning starts collapsed and hidden');
});

test('booting the real frontend renders runtime, models and the idle composer', async () => {
  const page = await mount();
  try {
    assert.match(page.byId('runtimeState').textContent, /ready/, 'the runtime line must report the live adapter');
    assert.equal(page.byId('runtimeBar').hidden, true, 'no "start the runtime" bar when it is running');

    const models = page.byId('modelList').querySelectorAll('.model');
    assert.equal(models.length, 5, 'all five catalog models must render');
    assert.equal(models[0].getAttribute('aria-checked'), 'true', 'the first model is selected on a fresh boot');

    // Idle. This is the state that has broken twice.
    assert.equal(page.byId('statusBar').hidden, true, 'the status bar must not render while idle');
    assert.equal(page.byId('send').disabled, false);
    assert.equal(page.byId('prompt').disabled, false);
    assert.equal(page.byId('newChat').disabled, false);
    assert.equal(page.byId('emptyState').hidden, false, 'the empty state shows until a chat exists');
  } finally {
    await page.close();
  }
});

test('a full send -> stream -> render cycle produces the message DOM and returns to idle', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 20, chunkSize: 4 });
  try {
    const statusBar = page.byId('statusBar');
    const thread = page.byId('thread');

    page.submit('why is the sky blue');
    assert.equal(page.byId('prompt').value, '', 'the composer clears the moment it is submitted');

    /* Busy. */
    await waitFor('the status bar to appear', () => statusBar.hidden === false);
    assert.equal(page.byId('send').disabled, true, 'Send must be dead while a reply streams');
    assert.equal(page.byId('prompt').disabled, true);
    assert.equal(page.byId('newChat').disabled, true, 'and so must + New — busyBlocks() refuses it anyway');
    assert.equal(page.byId('statusLabel').textContent, 'Thinking', 'the first catalog model reasons');

    /* Reasoning arrives before the answer and is shown while it does. */
    const reply = await waitFor('the assistant message', () => thread.querySelector('.msg-assistant'));
    const think = reply.querySelector('.think');
    await waitFor('reasoning to stream', () => think.hidden === false && think.querySelector('.think-text').textContent.length > 0);
    assert.equal(think.open, true, 'the reasoning panel opens while it is the only thing happening');

    /* Idle again. */
    await waitFor('the status bar to go away', () => statusBar.hidden === true, 30_000);
    assert.equal(statusBar.getAttribute('hidden'), '', 'hidden must reflect onto the attribute the stylesheet selects');
    assert.equal(page.byId('send').disabled, false, 'Send must come back');
    assert.equal(page.byId('prompt').disabled, false);
    assert.equal(page.byId('newChat').disabled, false);

    /* The rendered thread. */
    const users = thread.querySelectorAll('.msg-user');
    const assistants = thread.querySelectorAll('.msg-assistant');
    assert.equal(users.length, 1, 'exactly one user message');
    assert.equal(assistants.length, 1, 'exactly one reply — not one per chunk');
    assert.equal(users[0].querySelector('.msg-text').textContent, 'why is the sky blue');
    assert.equal(assistants[0].querySelector('.msg-text').textContent, 'This is a scripted reply.');
    assert.equal(
      assistants[0].querySelector('.think-text').textContent,
      'Working out what they meant.',
      'reasoning must land in .think-text and nowhere else',
    );
    assert.ok(
      !assistants[0].querySelector('.msg-text').textContent.includes('<think>'),
      'a reasoning tag reaching the answer is the separation failing',
    );
    assert.equal(think.open, false, 'reasoning collapses once the answer starts');
    assert.match(think.querySelector('.think-time').textContent, /\d/, 'and is stamped with how long it took');
    assert.match(assistants[0].querySelector('.msg-stats').textContent, /tokens/, 'the done event writes the stat line');
    assert.equal(
      assistants[0].querySelector('.msg-text').classList.contains('is-streaming'),
      false,
      'the streaming class must be taken off when the stream ends',
    );

    /* And it is on disk, reasoning included. */
    const { chats } = await (await fetch(`${page.base}/api/chats`)).json();
    assert.equal(chats.length, 1);
    const { chat } = await (await fetch(`${page.base}/api/chats/${chats[0].id}`)).json();
    assert.equal(chat.messages.length, 2);
    assert.equal(chat.messages[1].content, 'This is a scripted reply.');
    assert.equal(chat.messages[1].thinking, 'Working out what they meant.');
  } finally {
    await page.close();
  }
});

test('reopening the chat from the sidebar renders the same DOM the stream built', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  try {
    const thread = page.byId('thread');
    page.submit('first question');
    await waitFor('the reply to finish', () => finished(thread), 30_000);

    const streamed = thread.querySelector('.msg-assistant').querySelector('.msg-text').textContent;
    const streamedThinking = thread.querySelector('.msg-assistant').querySelector('.think-text').textContent;

    // Same door the user uses: click the row in the sidebar.
    await waitFor('the chat to appear in the sidebar', () => page.byId('chatList').querySelector('.chat-row'));
    const row = page.byId('chatList').querySelector('.chat-row');
    const streamedNode = thread.querySelector('.msg-assistant');
    dispatch(row, makeEvent('click'));
    // renderThread() replaces the thread wholesale, so a genuinely rebuilt
    // reply is a DIFFERENT node. Waiting on the selector alone would match the
    // one the stream already left there and prove nothing.
    const reloaded = await waitFor('the thread to be rebuilt from disk', () => {
      const now = thread.querySelector('.msg-assistant');
      return now && now !== streamedNode ? now : false;
    });
    assert.equal(reloaded.querySelector('.msg-text').textContent, streamed, 'a reload must show what the stream showed');
    assert.equal(reloaded.querySelector('.think-text').textContent, streamedThinking);
    assert.equal(reloaded.querySelector('.think').hidden, false, 'reasoning stored on disk must come back visible');
    assert.equal(thread.querySelectorAll('.msg-assistant').length, 1, 'and not be duplicated by the reopen');
    assert.equal(page.byId('statusBar').hidden, true, 'reopening a chat is not a busy state');
  } finally {
    await page.close();
  }
});

test('Escape stops a running reply and the page comes back to idle', async () => {
  const page = await mount({ script: `<think>${'thinking out loud. '.repeat(400)}</think>done`, delayMs: 5, chunkSize: 4 });
  try {
    const thread = page.byId('thread');
    const statusBar = page.byId('statusBar');

    page.submit('take your time');
    await waitFor('the stream to start', () => statusBar.hidden === false);
    const think = await waitFor(
      'reasoning to be on screen',
      () => {
        const t = thread.querySelector('.msg-assistant')?.querySelector('.think');
        return t && t.hidden === false && t.querySelector('.think-text').textContent.length > 50 ? t : false;
      },
    );

    page.press('Escape');

    await waitFor('the page to return to idle', () => statusBar.hidden === true, 30_000);
    assert.equal(page.byId('send').disabled, false, 'Stop must give the composer back');
    assert.equal(page.byId('prompt').disabled, false);
    assert.equal(page.byId('newChat').disabled, false);
    assert.ok(think.querySelector('.think-text').textContent.length > 0, 'what was generated stays on screen');
    assert.equal(
      thread.querySelector('.msg-assistant').querySelector('.msg-text').classList.contains('is-streaming'),
      false,
      'an aborted reply must not be left marked as still streaming',
    );
  } finally {
    await page.close();
  }
});

test('a long reasoning stream renders through the real frontend without a long block', async () => {
  // The soak in test/acceptance/i7-testing.test.js drives render.js directly.
  // This one drives it the way the app does — through app.js, over SSE, into a
  // .think-text node — because that is the path that locked the page.
  const CHARS = 12_000;
  const page = await mount({
    script: `<think>${'reasoning words that go on and on. '.repeat(Math.ceil(CHARS / 34))}</think>fin`,
    delayMs: 0,
    chunkSize: 64,
  });
  try {
    const thread = page.byId('thread');
    const began = process.hrtime.bigint();
    page.submit('reason at length');
    await waitFor('the long reply to finish', () => finished(thread), 60_000);
    const ms = Number(process.hrtime.bigint() - began) / 1e6;

    const reply = thread.querySelector('.msg-assistant');
    const think = reply.querySelector('.think-text');
    assert.ok(think.textContent.length >= CHARS, `only ${think.textContent.length} of ${CHARS} characters of reasoning rendered`);
    assert.equal(reply.querySelector('.msg-text').textContent, 'fin', 'the answer still arrives after all that');
    assert.ok(ms < 20_000, `${(ms / 1000).toFixed(1)}s for ${CHARS} characters of reasoning — a quadratic renderer is what locked the page before`);
  } finally {
    await page.close();
  }
});

test('the frontend is importable without booting itself, and boots itself in a browser', async () => {
  // This file can only drive app.js because importing it does not start it.
  // The guard that makes that true is also the one that must keep the page
  // working, so both halves are pinned here rather than left to a comment.
  const src = await fs.readFile(APP_JS, 'utf8');
  assert.match(src, /export\s+(async\s+)?function\s+init/, 'init() must be exported for a test to drive the page');
  assert.match(src, /typeof\s+window\s*!==\s*['"]undefined['"]/, 'and the browser must still boot on import');
  assert.match(src, /init\(\)\.catch/, 'the browser boot path must survive');
});

test('[hidden] keeps its authority in the stylesheet', async () => {
  // A shim cannot run the cascade. What it can do is refuse to let the rule
  // that makes `hidden` mean anything be removed: .status-bar is display:flex,
  // and once beat the attribute, so the app hid a bar that stayed on screen.
  // Comments first: this rule is explained by a comment that quotes the very
  // declaration being searched for, and the quote is not what ships.
  const css = (await fs.readFile(STYLES_CSS, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = css.match(/\[hidden\]\s*\{([^}]*)\}/);
  assert.ok(rule, 'styles.css must carry a global [hidden] rule');
  assert.match(rule[1], /display\s*:\s*none/, '[hidden] must hide');
  assert.match(rule[1], /!important/, 'without !important a display:flex class wins and the element stays on screen');
  assert.match(css, /\.status-bar\s*\{[^}]*display\s*:\s*flex/, 'the status bar is still the display:flex element that exposed this');
});

/* ------------------------------------------------------------------ */
/* Attribution — the label under a reply names the model that wrote it */
/* ------------------------------------------------------------------ */

/**
 * Issue #1, at the only layer where it was ever visible.
 *
 * The store-side tests pin that a reply keeps its own modelId. They passed
 * against a frontend that read the RAIL instead, which is the whole defect —
 * so this drives the real page and reads the real label.
 */
test('a reply keeps the name of the model that wrote it after switching models', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  try {
    const thread = page.byId('thread');
    const cards = page.byId('modelList').querySelectorAll('.model');
    assert.ok(cards.length >= 2, 'this test needs at least two models to switch between');

    const nameOf = (card) => card.querySelector('.model-name').textContent;
    const firstModel = nameOf(cards[0]);
    const otherCard = [...cards].find((c) => nameOf(c) !== firstModel);
    const otherModel = nameOf(otherCard);

    page.submit('asked of the first model');
    await waitFor('the first reply', () => finished(thread), 30_000);
    assert.equal(
      thread.querySelectorAll('.msg-assistant')[0].querySelector('.msg-role').textContent,
      firstModel,
      'the streaming label names the model actually being used',
    );

    // Switch the rail, then ask again. Same door the user uses.
    dispatch(otherCard, makeEvent('click'));
    page.submit('asked of the second model');
    await waitFor('the second reply', () => thread.querySelectorAll('.msg-assistant').length === 2 && finished(thread), 30_000);

    // Reopening rebuilds every node from disk — the exact path that used to
    // relabel the whole history with whatever was selected.
    const before = thread.querySelector('.msg-assistant');
    dispatch(page.byId('chatList').querySelector('.chat-row'), makeEvent('click'));
    await waitFor('the thread to be rebuilt from disk', () => {
      const now = thread.querySelector('.msg-assistant');
      return now && now !== before ? now : false;
    });

    const labels = [...thread.querySelectorAll('.msg-assistant')].map(
      (m) => m.querySelector('.msg-role').textContent,
    );
    assert.deepEqual(
      labels,
      [firstModel, otherModel],
      `after a reload each reply must still name its own model; got ${labels.join(', ')}`,
    );
    assert.equal(
      [...thread.querySelectorAll('.msg-assistant')].some((m) =>
        m.querySelector('.msg-role').className.includes('is-inferred'),
      ),
      false,
      'a reply that recorded its model is not a guess and must not be marked as one',
    );
  } finally {
    await page.close();
  }
});

test('a reply written before models were recorded is shown as a guess, not as a fact', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  try {
    const thread = page.byId('thread');
    page.submit('a first question so a chat exists');
    await waitFor('the reply', () => finished(thread), 30_000);

    // Plant a reply the way every message on disk looked before this field
    // existed: no modelId at all.
    const { chats } = await (await fetch(`${page.base}/api/chats`)).json();
    const file = path.join(page.dir, `${chats[0].id}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.messages.push({
      id: 'legacy00000000000001',
      role: 'assistant',
      content: 'written before attribution existed',
      thinking: '',
      createdAt: new Date().toISOString(),
      stats: null,
    });
    await fs.writeFile(file, JSON.stringify(raw, null, 2));

    const before = thread.querySelector('.msg-assistant');
    dispatch(page.byId('chatList').querySelector('.chat-row'), makeEvent('click'));
    await waitFor('the thread to be rebuilt from disk', () => {
      const now = thread.querySelector('.msg-assistant');
      return now && now !== before ? now : false;
    });

    const roles = [...thread.querySelectorAll('.msg-assistant')].map((m) => m.querySelector('.msg-role'));
    assert.equal(roles.length, 2);
    assert.equal(roles[0].className.includes('is-inferred'), false, 'the stamped reply is known');
    assert.equal(roles[1].className.includes('is-inferred'), true, 'the unstamped one must be marked as inferred');
    assert.match(
      roles[1].textContent,
      /model not recorded/,
      'the caveat must be real text: the role cell is role=generic, which takes no accessible name, ' +
        'so an aria-label on it would be announced by nobody',
    );
    assert.match(
      roles[1].getAttribute('title') ?? '',
      /never saved/,
      'and the mouse affordance has to survive too',
    );
  } finally {
    await page.close();
  }
});

/**
 * The narrow case the coarse revert could not see.
 *
 * Removing labelMessage entirely turns the other two tests red, but the
 * defect this guards is one token: `modelById(chatModelId) ?? currentModel()`.
 * With every chat pointing at a catalogued model the fallback branch never
 * runs, so that mutation stayed green through two review rounds. This chat
 * points at a model the catalog does not have.
 */
test('a chat naming a retired model never borrows the label from the rail', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  try {
    const thread = page.byId('thread');
    page.submit('a question so a chat exists');
    await waitFor('the reply', () => finished(thread), 30_000);

    const { chats } = await (await fetch(`${page.base}/api/chats`)).json();
    const chatId = chats[0].id;

    // Point the chat at something this build does not ship, the way a restored
    // backup or an edited models.json would, and strip the reply's own model so
    // the fallback is the only path left.
    const patched = await fetch(`${page.base}/api/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'retired-7b' }),
    });
    assert.equal(patched.status, 200, 'a plausible id for a model we no longer ship is still a legal chat');

    const file = path.join(page.dir, `${chatId}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const m of raw.messages) delete m.modelId;
    await fs.writeFile(file, JSON.stringify(raw, null, 2));

    // Highlight a real model in the rail. If the label borrows from there, it
    // will say this one.
    const cards = page.byId('modelList').querySelectorAll('.model');
    const railCard = cards[cards.length - 1];
    const railName = railCard.querySelector('.model-name').textContent;
    dispatch(railCard, makeEvent('click'));

    const before = thread.querySelector('.msg-assistant');
    dispatch(page.byId('chatList').querySelector('.chat-row'), makeEvent('click'));
    await waitFor('the thread to be rebuilt from disk', () => {
      const now = thread.querySelector('.msg-assistant');
      return now && now !== before ? now : false;
    });

    const role = thread.querySelector('.msg-assistant').querySelector('.msg-role');
    assert.ok(
      role.textContent.startsWith('retired-7b'),
      `the chat's own model is the only honest guess; got "${role.textContent}"`,
    );
    assert.ok(
      !role.textContent.includes(railName),
      `the rail's selection (${railName}) must never become a reply's label`,
    );
    assert.equal(role.className.includes('is-inferred'), true, 'and it is still a guess, so it stays marked');
  } finally {
    await page.close();
  }
});

test('a chat modelId that is not a plausible model tag is refused', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  try {
    page.submit('a question so a chat exists');
    await waitFor('the reply', () => finished(page.byId('thread')), 30_000);
    const { chats } = await (await fetch(`${page.base}/api/chats`)).json();

    for (const bad of ['x'.repeat(65), 'has spaces', 'rtl‮override', '<script>', '']) {
      const res = await fetch(`${page.base}/api/chats/${chats[0].id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: bad }),
      });
      assert.equal(res.status, 400, `modelId ${JSON.stringify(bad.slice(0, 20))} must be refused`);
    }

    const { chat } = await (await fetch(`${page.base}/api/chats/${chats[0].id}`)).json();
    assert.match(chat.modelId, /^[A-Za-z0-9._:-]{1,64}$/, 'and none of them can have landed');
  } finally {
    await page.close();
  }
});

/* ------------------------------------------------------------------ */
/* Again, with a different model                                       */
/* ------------------------------------------------------------------ */

test('the Again menu lists every model and marks the current one', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  try {
    page.submit('a question');
    await waitFor('the reply', () => finished(page.byId('thread')), 30_000);

    const trigger = page.byId('regenerateWith');
    const menu = page.byId('regenerateMenu');
    assert.equal(menu.hidden, true, 'the menu starts closed');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');

    dispatch(trigger, makeEvent('click'));
    assert.equal(menu.hidden, false, 'the caret opens it');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'and says so to assistive tech');

    const items = menu.querySelectorAll('.again-item');
    const railCards = page.byId('modelList').querySelectorAll('.model');
    assert.equal(items.length, railCards.length, 'every model the rail offers is offered here');
    assert.equal(
      items.filter((i) => i.className.includes('is-current')).length,
      1,
      'exactly one entry is the model this chat is already on',
    );
  } finally {
    await page.close();
  }
});

test('choosing a model from the Again menu regenerates with it and moves the chat onto it', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  try {
    const thread = page.byId('thread');
    page.submit('a question');
    await waitFor('the first reply', () => finished(thread), 30_000);

    const startedOn = thread.querySelector('.msg-assistant').querySelector('.msg-role').textContent;
    const { chats } = await (await fetch(`${page.base}/api/chats`)).json();
    const chatId = chats[0].id;

    dispatch(page.byId('regenerateWith'), makeEvent('click'));
    const other = page
      .byId('regenerateMenu')
      .querySelectorAll('.again-item')
      .find((i) => i.querySelector('.again-item-name').textContent !== startedOn);
    const otherName = other.querySelector('.again-item-name').textContent;
    const otherId = other.getAttribute('data-model-id');

    dispatch(other, makeEvent('click'));
    assert.equal(page.byId('regenerateMenu').hidden, true, 'choosing closes the menu');
    await waitFor('the replacement reply', () => finished(thread), 30_000);

    assert.equal(thread.querySelectorAll('.msg-assistant').length, 1, 'Again replaces, it does not append');
    assert.equal(
      thread.querySelector('.msg-assistant').querySelector('.msg-role').textContent,
      otherName,
      'the new reply is attributed to the model that was picked',
    );

    // The route writes the model onto the chat, so the rail must not be left
    // naming a model this chat is no longer on.
    const active = page.byId('modelList').querySelector('.model.is-active');
    assert.equal(active.querySelector('.model-name').textContent, otherName, 'the rail follows');

    const { chat } = await (await fetch(`${page.base}/api/chats/${chatId}`)).json();
    assert.equal(chat.modelId, otherId, 'and so does what is on disk');
    assert.equal(chat.messages.at(-1).modelId, otherId);
  } finally {
    await page.close();
  }
});

test('Escape closes the Again menu without aborting anything', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  try {
    page.submit('a question');
    await waitFor('the reply', () => finished(page.byId('thread')), 30_000);

    const menu = page.byId('regenerateMenu');
    dispatch(page.byId('regenerateWith'), makeEvent('click'));
    assert.equal(menu.hidden, false);

    dispatch(menu, makeEvent('keydown', { key: 'Escape' }));
    assert.equal(menu.hidden, true, 'Escape closes it');
    assert.equal(page.byId('regenerateWith').getAttribute('aria-expanded'), 'false');
    assert.equal(page.byId('statusBar').hidden, true, 'and nothing was generating to abort');
  } finally {
    await page.close();
  }
});

test('the Again caret dies with the Again button, and closes any open menu', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 60, chunkSize: 2 });
  try {
    // Nothing to regenerate yet.
    assert.equal(page.byId('regenerate').disabled, true);
    assert.equal(page.byId('regenerateWith').disabled, true, 'the second door must be shut too');

    page.submit('a question');
    await waitFor('the reply', () => finished(page.byId('thread')), 30_000);
    assert.equal(page.byId('regenerateWith').disabled, false);

    dispatch(page.byId('regenerateWith'), makeEvent('click'));
    assert.equal(page.byId('regenerateMenu').hidden, false);

    // Start another turn: Again is disabled while busy, so the open menu must go.
    page.submit('another question');
    await waitFor('the busy state', () => page.byId('statusBar').hidden === false);
    assert.equal(page.byId('regenerateWith').disabled, true, 'no retrying mid-generation');
    assert.equal(
      page.byId('regenerateMenu').hidden,
      true,
      'a menu left open over a streaming reply would still fire',
    );
    await waitFor('it to finish', () => finished(page.byId('thread')), 30_000);
  } finally {
    await page.close();
  }
});

test('the caret toggles the menu shut again, and a click elsewhere dismisses it', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  try {
    page.submit('a question');
    await waitFor('the reply', () => finished(page.byId('thread')), 30_000);

    const trigger = page.byId('regenerateWith');
    const menu = page.byId('regenerateMenu');

    dispatch(trigger, makeEvent('click'));
    assert.equal(menu.hidden, false, 'first click opens');

    // The whole point of a disclosure trigger: pressing it again puts it back.
    dispatch(trigger, makeEvent('click'));
    assert.equal(menu.hidden, true, 'second click on the caret must close it');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');

    // And it must still be dismissable by clicking anything else.
    dispatch(trigger, makeEvent('click'));
    assert.equal(menu.hidden, false);
    dispatch(page.byId('prompt'), makeEvent('click'));
    assert.equal(menu.hidden, true, 'a click outside the menu dismisses it');
  } finally {
    await page.close();
  }
});

test('a retry that never reaches the server does not move the rail or the stored model', async () => {
  const page = await mount({ script: SCRIPTED, delayMs: 4, chunkSize: 8 });
  const realFetch = globalThis.fetch;
  try {
    page.submit('a question');
    await waitFor('the reply', () => finished(page.byId('thread')), 30_000);

    const railBefore = page.byId('modelList').querySelector('.model.is-active').querySelector('.model-name').textContent;
    const { chats } = await realFetch(`${page.base}/api/chats`).then((r) => r.json());
    const chatId = chats[0].id;
    const storedBefore = (await realFetch(`${page.base}/api/chats/${chatId}`).then((r) => r.json())).chat.modelId;
    const localBefore = globalThis.localStorage.getItem('ls.modelId');

    // The model server dies, the box sleeps, the route 500s — all one shape
    // from here: the request does not land.
    globalThis.fetch = (input, init) =>
      String(input).includes('/regenerate')
        ? Promise.reject(new Error('the model server is not answering'))
        : realFetch(input, init);

    dispatch(page.byId('regenerateWith'), makeEvent('click'));
    const other = page
      .byId('regenerateMenu')
      .querySelectorAll('.again-item')
      .find((i) => i.querySelector('.again-item-name').textContent !== railBefore);
    dispatch(other, makeEvent('click'));
    await waitFor('the failure to settle', () => page.byId('statusBar').hidden === true, 30_000);

    assert.equal(
      page.byId('modelList').querySelector('.model.is-active').querySelector('.model-name').textContent,
      railBefore,
      'a retry that never landed must not leave the rail naming the model it would have used',
    );
    assert.equal(globalThis.localStorage.getItem('ls.modelId'), localBefore, 'and must not persist it either');

    const storedAfter = (await realFetch(`${page.base}/api/chats/${chatId}`).then((r) => r.json())).chat.modelId;
    assert.equal(storedAfter, storedBefore, 'the chat on disk never moved, so nothing on screen should say it did');
    assert.ok(
      page.byId('thread').querySelector('.msg-error'),
      'and the failure is shown, not swallowed',
    );
  } finally {
    globalThis.fetch = realFetch;
    await page.close();
  }
});
