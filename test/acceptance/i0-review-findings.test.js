/**
 * ACCEPTANCE — I0 Second-review findings.
 *
 * Authored from the review report before any fix. Locked; not the builder's to edit.
 * Each test names the finding it pins.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from '../../src/server.js';

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'ls-i0-'));

async function stubOllama({ tags = [], onChat } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      seen.push({ url: req.url, body: parsed });
      if (req.url === '/api/version') return res.writeHead(200).end(JSON.stringify({ version: 'stub' }));
      if (req.url === '/api/tags') return res.writeHead(200).end(JSON.stringify({ models: tags }));
      if (req.url === '/api/ps') return res.writeHead(200).end(JSON.stringify({ models: [] }));
      if (req.url === '/api/generate') return res.writeHead(200).end(JSON.stringify({ done: true }));
      if (req.url === '/api/chat') {
        onChat?.(parsed);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        return res.end(
          [
            JSON.stringify({ message: { content: 'ok' } }),
            JSON.stringify({ done: true, eval_count: 2, eval_duration: 1e9 }),
          ].join('\n') + '\n',
        );
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    lastChat: () => seen.filter((s) => s.url === '/api/chat').at(-1)?.body,
    lastGenerate: () => seen.filter((s) => s.url === '/api/generate').at(-1)?.body,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

async function app(overrides) {
  const dir = await tmpDir();
  const { server, config } = await createServer({
    server: { port: 0 },
    storage: { chatsDir: dir },
    ...overrides,
  });
  await new Promise((r) => server.listen(0, config.server.host, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async json(method, url, body) {
      const res = await fetch(base + url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async send(id, payload) {
      const res = await fetch(`${base}/api/chats/${id}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await res.text();
      return res.status;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/* ================================================================== */
/* C1 — raw GGUF deleted by NAME, not by identity. Data loss.          */
/* ================================================================== */

test('I0-C1a: a raw-cleanup decision module exists and is pure', async () => {
  const mod = await import('../../src/core/raw-cleanup.js');
  assert.equal(typeof mod.canDeleteRaw, 'function', 'canDeleteRaw must be exported');
});

test('I0-C1b: deletion is refused when the registry entry size disagrees with the file', async () => {
  const { canDeleteRaw } = await import('../../src/core/raw-cleanup.js');
  const verdict = canDeleteRaw({
    modelId: 'cold-fusion-9b',
    fileBytes: 5.23 * 1024 ** 3,
    registryEntry: { name: 'cold-fusion-9b:latest', size: 2.0 * 1024 ** 3 }, // a DIFFERENT build
  });
  assert.equal(verdict.ok, false, 'a size mismatch means the registry was not built from this file');
  assert.match(String(verdict.reason), /size|match|identity/i);
});

test('I0-C1c: deletion is refused when the model is absent from the registry', async () => {
  const { canDeleteRaw } = await import('../../src/core/raw-cleanup.js');
  const verdict = canDeleteRaw({
    modelId: 'cold-fusion-9b',
    fileBytes: 5.23 * 1024 ** 3,
    registryEntry: null,
  });
  assert.equal(verdict.ok, false);
});

test('I0-C1d: deletion is allowed only when name AND size agree', async () => {
  const { canDeleteRaw } = await import('../../src/core/raw-cleanup.js');
  const bytes = 5.23 * 1024 ** 3;
  const verdict = canDeleteRaw({
    modelId: 'cold-fusion-9b',
    fileBytes: bytes,
    registryEntry: { name: 'cold-fusion-9b:latest', size: bytes },
  });
  assert.equal(verdict.ok, true, 'matching identity may be deleted');
});

test('I0-C1e: a small rounding difference is tolerated, a real difference is not', async () => {
  const { canDeleteRaw } = await import('../../src/core/raw-cleanup.js');
  const bytes = 5.23 * 1024 ** 3;
  assert.equal(
    canDeleteRaw({
      modelId: 'x',
      fileBytes: bytes,
      registryEntry: { name: 'x:latest', size: bytes * 1.005 },
    }).ok,
    true,
    'half a percent is rounding',
  );
  assert.equal(
    canDeleteRaw({
      modelId: 'x',
      fileBytes: bytes,
      registryEntry: { name: 'x:latest', size: bytes * 1.5 },
    }).ok,
    false,
    'fifty percent is a different file',
  );
});

/* ================================================================== */
/* I2 — the UI must not claim a different adapter than the one live    */
/* ================================================================== */

test('I0-I2a: /api/runtime reports the configured adapter, not always ollama', async () => {
  const stub = await stubOllama();
  // Configure llamacpp, and point it somewhere dead, while Ollama's stub IS alive.
  const a = await app({
    runtime: { adapter: 'llamacpp', llamaCppUrl: 'http://127.0.0.1:1', ollamaUrl: stub.url },
  });
  const { body } = await a.json('GET', '/api/runtime');
  const rt = body.runtime ?? body;
  assert.equal(rt.adapter, 'llamacpp', 'the endpoint must name the configured adapter');
  assert.equal(
    rt.running,
    false,
    'a live Ollama must not make a dead llama-server look healthy',
  );
  await a.close();
  await stub.close();
});

test('I0-I2b: /api/runtime agrees with /api/state about health', async () => {
  const stub = await stubOllama();
  const a = await app({
    runtime: { adapter: 'llamacpp', llamaCppUrl: 'http://127.0.0.1:1', ollamaUrl: stub.url },
  });
  const state = (await a.json('GET', '/api/state')).body;
  const rt = (await a.json('GET', '/api/runtime')).body;
  const running = (rt.runtime ?? rt).running;
  assert.equal(
    state.runtime.ok,
    running,
    'the poll endpoint and the state endpoint must not disagree about whether anything is answering',
  );
  await a.close();
  await stub.close();
});

/* ================================================================== */
/* I3 — preload must actually spare the next message a reload          */
/* ================================================================== */

test('I0-I3a: warm loads with the same options the chat call will request', async () => {
  const stub = await stubOllama();
  const a = await app({ runtime: { adapter: 'ollama', ollamaUrl: stub.url } });
  await a.json('POST', '/api/runtime/warm', { modelId: 'glm-flash-21b' });

  const gen = stub.lastGenerate();
  assert.ok(gen, 'warm must reach the runtime');
  assert.ok(gen.options, 'warm must send options, or the runner loads at a different context');
  assert.equal(
    gen.options.num_ctx,
    8192,
    "warm must use the model's own num_ctx (glm-flash-21b is 8192, not the server default)",
  );
  await a.close();
  await stub.close();
});

test('I0-I3b: the chat call sends keep_alive so a warmed model is not evicted early', async () => {
  const stub = await stubOllama();
  const a = await app({ runtime: { adapter: 'ollama', ollamaUrl: stub.url } });
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });
  await a.send(made.chat.id, { content: 'hi', modelId: 'deckard-4b' });

  const chat = stub.lastChat();
  assert.ok(chat.keep_alive !== undefined, 'chat must state keep_alive, not inherit a 5-minute default');
  await a.close();
  await stub.close();
});

test('I0-I3c: warm and chat request the same context size for every model', async () => {
  const catalog = await import('../../src/core/model-catalog.js');
  for (const m of catalog.all()) {
    const stub = await stubOllama();
    const a = await app({ runtime: { adapter: 'ollama', ollamaUrl: stub.url } });
    await a.json('POST', '/api/runtime/warm', { modelId: m.id });
    const { body: made } = await a.json('POST', '/api/chats', { modelId: m.id });
    await a.send(made.chat.id, { content: 'hi', modelId: m.id });

    assert.equal(
      stub.lastGenerate().options?.num_ctx,
      stub.lastChat().options?.num_ctx,
      `${m.id}: warm and chat must agree on num_ctx or the model reloads`,
    );
    await a.close();
    await stub.close();
  }
});

/* ================================================================== */
/* I4 — streamed rendering must equal one-shot rendering               */
/* ================================================================== */

/** Minimal DOM shim: enough for text nodes, elements and serialisation. */
function makeDom() {
  const TEXT = 3;
  const ELEMENT = 1;
  const mkText = (data) => ({
    nodeType: TEXT,
    data,
    appendData(s) {
      this.data += s;
    },
    get textContent() {
      return this.data;
    },
    serialize() {
      return this.data;
    },
  });
  const mkEl = (tag) => ({
    nodeType: ELEMENT,
    tagName: tag.toUpperCase(),
    childNodes: [],
    get lastChild() {
      return this.childNodes.at(-1) ?? null;
    },
    set textContent(v) {
      this.childNodes = v === '' ? [] : [mkText(v)];
    },
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    },
    append(...kids) {
      this.childNodes.push(...kids);
    },
    replaceChildren(...kids) {
      this.childNodes = kids;
    },
    serialize() {
      return `<${tag}>${this.childNodes.map((c) => c.serialize()).join('')}</${tag}>`;
    },
  });
  return {
    Node: { TEXT_NODE: TEXT, ELEMENT_NODE: ELEMENT },
    document: { createElement: mkEl, createTextNode: mkText },
    mkEl,
  };
}

async function loadRender() {
  const dom = makeDom();
  globalThis.document = dom.document;
  globalThis.Node = dom.Node;
  const mod = await import('../../public/render.js');
  return { ...mod, mkEl: dom.mkEl };
}

const CASES = [
  ['plain prose', 'Just some words with no code at all.'],
  ['inline code', 'Use `reduce` here and `map` there.'],
  ['complete fence', 'Here:\n```js\nconst a = 1;\n```\nDone.'],
  ['fence truncated mid-block', 'Here:\n```python\ndef f():\n    return 1\n'],
  ['fence opened only', 'Starting now:\n```'],
  ['two fences', '```js\na\n```\nmid\n```py\nb\n```'],
];

for (const [name, text] of CASES) {
  test(`I0-I4 (${name}): streamed output matches one-shot output`, async () => {
    const { renderText, appendStream, mkEl } = await loadRender();

    const oneShot = mkEl('div');
    renderText(oneShot, text);

    for (const size of [1, 3, 7, 40]) {
      const streamed = mkEl('div');
      let acc = '';
      for (let i = 0; i < text.length; i += size) {
        const chunk = text.slice(i, i + size);
        acc += chunk;
        appendStream(streamed, acc, chunk);
      }
      assert.equal(
        streamed.serialize(),
        oneShot.serialize(),
        `chunk size ${size}: a reply must not render differently while streaming than after reload`,
      );
    }
  });
}

/* ================================================================== */
/* I5 — no caller-supplied string may reach the runtime as a model     */
/* ================================================================== */

test('I0-I5a: runtimeModelTag cannot override the catalog model', async () => {
  const stub = await stubOllama();
  const a = await app({ runtime: { adapter: 'ollama', ollamaUrl: stub.url } });
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });

  await a.send(made.chat.id, {
    content: 'hi',
    modelId: 'deckard-4b',
    runtimeModelTag: 'dolphin-llama3:70b',
  });

  const chat = stub.lastChat();
  if (chat) {
    assert.equal(chat.model, 'deckard-4b', 'the catalog id must win over any caller-supplied tag');
  }
  await a.close();
  await stub.close();
});

test('I0-I5b: absurd generation options are rejected or clamped, never forwarded raw', async () => {
  const stub = await stubOllama();
  const a = await app({ runtime: { adapter: 'ollama', ollamaUrl: stub.url } });
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });

  await a.send(made.chat.id, {
    content: 'hi',
    modelId: 'deckard-4b',
    options: { num_predict: -1, num_ctx: 9_000_000, temperature: 50 },
  });

  const chat = stub.lastChat();
  if (chat) {
    assert.notEqual(chat.options?.num_predict, -1, 'unbounded generation must not be reachable');
    assert.ok((chat.options?.num_ctx ?? 0) <= 262144, 'num_ctx must be clamped to something real');
    assert.ok((chat.options?.temperature ?? 0) <= 2, 'temperature must be clamped to something sane');
  }
  await a.close();
  await stub.close();
});

/* ================================================================== */
/* L12 — a verification script must fail when it cannot verify         */
/* ================================================================== */

test('I0-L12: check-uncensored counts a non-answer as an error, not a pass', async () => {
  const src = await fs.readFile(new URL('../../scripts/check-uncensored.mjs', import.meta.url), 'utf8');
  assert.match(
    src,
    /errors?\s*(\+=|\+\+|=)/,
    'the script must track probe errors separately from refusals',
  );
  assert.ok(
    /errors?\b[^\n]*\bexit|exit[^\n]*\berrors?\b/i.test(src) || /errors > 0/.test(src),
    'a run that could not reach the model must not exit 0 claiming "uncensored"',
  );
});

/* ================================================================== */
/* M9 — spawn failures must surface fast with the real reason          */
/* ================================================================== */

test('I0-M9: a supervisor spawn failure reports the real cause quickly', async () => {
  const { createRuntimeSupervisor } = await import('../../src/core/runtime-supervisor.js');
  const dir = await tmpDir();
  const notABinary = path.join(dir, 'not-really-ollama.txt');
  await fs.writeFile(notABinary, 'this is not an executable', 'utf8');

  const boss = createRuntimeSupervisor({ ollamaUrl: 'http://127.0.0.1:1', ollamaBin: notABinary });
  const began = Date.now();
  const r = await boss.start();
  const took = Date.now() - began;

  assert.equal(r.ok, false);
  assert.ok(took < 20_000, `a doomed spawn must fail fast, took ${took}ms`);
  await fs.rm(dir, { recursive: true, force: true });
});
