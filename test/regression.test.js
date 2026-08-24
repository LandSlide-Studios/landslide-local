/**
 * Regression tests for defects found by adversarial review.
 *
 * Each test names the bug it locks down. These cover the three areas the original
 * suite did not touch at all: concurrency, the real HTTP server, and the two real
 * runtime adapters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJsonFileStore, createMemoryStore, newId } from '../src/core/chat-store.js';
import { createRuntime } from '../src/runtime/index.js';
import { createApi } from '../src/api.js';
import { createServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'ls-reg-'));

/* ================================================================== */
/* Finding 3 — concurrent writes lost messages or corrupted the file   */
/* ================================================================== */

for (const [label, make] of [
  ['jsonfile', async () => ({ store: createJsonFileStore(await tmpDir()) })],
  ['memory', async () => ({ store: createMemoryStore() })],
]) {
  test(`[${label}] concurrent appends to one chat all persist`, async () => {
    const { store } = await make();
    const { id } = await store.create({});
    const N = 16;

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        store.appendMessage(id, { role: 'user', content: `msg-${i}` }),
      ),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 0, `rejections: ${rejected.map((r) => r.reason?.message)}`);

    const chat = await store.get(id);
    assert.ok(chat, 'chat must still be readable, not quarantined as corrupt');
    assert.equal(chat.messages.length, N, 'every concurrent append must survive');

    const contents = new Set(chat.messages.map((m) => m.content));
    assert.equal(contents.size, N, 'no message may be overwritten by another');
  });
}

test('[jsonfile] interleaved appendMessage and updateChat do not lose either', async () => {
  const store = createJsonFileStore(await tmpDir());
  const { id } = await store.create({});
  await Promise.all([
    store.appendMessage(id, { role: 'user', content: 'hello' }),
    store.updateChat(id, { modelId: 'deckard-4b' }),
    store.appendMessage(id, { role: 'assistant', content: 'hi' }),
  ]);
  const chat = await store.get(id);
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.modelId, 'deckard-4b');
});

/* ================================================================== */
/* Finding 8 — one malformed file broke search for the whole store     */
/* ================================================================== */

test('[jsonfile] a record missing its title does not break list or search', async () => {
  const dir = await tmpDir();
  const store = createJsonFileStore(dir);
  const good = await store.create({ title: 'healthy' });
  await store.appendMessage(good.id, { role: 'user', content: 'roofing leads' });

  await fs.writeFile(
    path.join(dir, `${newId()}.json`),
    JSON.stringify({ id: 'x', messages: [] }), // valid JSON, no title
    'utf8',
  );

  const list = await store.list();
  assert.equal(list.length, 1);
  const found = await store.search('roofing');
  assert.equal(found.length, 1, 'search must not throw on a malformed neighbour');
});

test('[jsonfile] a message with a non-string body is quarantined, not thrown', async () => {
  const dir = await tmpDir();
  const store = createJsonFileStore(dir);
  await fs.writeFile(
    path.join(dir, `${newId()}.json`),
    JSON.stringify({ id: 'y', title: 't', messages: [{ role: 'user', content: 42 }] }),
    'utf8',
  );
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.search('anything'), []);
});

/* ================================================================== */
/* Finding 7 — client mistakes were reported as 500                    */
/* ================================================================== */

async function apiHarness(runtimeConfig = { adapter: 'fake' }) {
  const dir = await tmpDir();
  const api = createApi({
    store: createJsonFileStore(dir),
    runtime: createRuntime(runtimeConfig),
    config: {
      hardware: { vramUsableGb: 6.65, label: 'test' },
      storage: { chatsDir: dir, modelsDir: dir },
    },
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await api(req, res, url))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('a missing chat is 404 and a malformed id is 400 — never 500', async () => {
  const h = await apiHarness();

  const missing = await fetch(`${h.base}/api/chats/${newId()}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'hi', modelId: 'deckard-4b' }),
  });
  assert.equal(missing.status, 404);

  const shortId = await fetch(`${h.base}/api/chats/ab`);
  assert.equal(shortId.status, 400, 'an id too short is a client error');

  await h.close();
});

/* ================================================================== */
/* Finding 2 — abort never fired; generation could not be stopped      */
/* ================================================================== */

test('a client disconnect aborts the generation', async () => {
  const h = await apiHarness({ adapter: 'fake', delayMs: 12, chunkSize: 2, script: 'x'.repeat(400) });
  const made = await (await fetch(`${h.base}/api/chats`, { method: 'POST' })).json();
  const id = made.chat.id;

  const ctrl = new AbortController();
  const res = await fetch(`${h.base}/api/chats/${id}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: ctrl.signal,
    body: JSON.stringify({ content: 'go', modelId: 'deckard-4b' }),
  });

  const reader = res.body.getReader();
  await reader.read(); // wait until the stream is genuinely flowing
  ctrl.abort();
  await reader.cancel().catch(() => {});

  // Give the server a moment to notice and unwind.
  await new Promise((r) => setTimeout(r, 350));

  const after = await (await fetch(`${h.base}/api/chats/${id}`)).json();
  const assistant = after.chat.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant, 'the partial reply should still be saved');
  assert.ok(
    assistant.content.length < 400,
    `generation should have stopped early, got ${assistant.content.length} of 400 chars`,
  );
  await h.close();
});

/* ================================================================== */
/* Finding 1 — the server never started on Windows                     */
/* ================================================================== */

test('createServer binds loopback and serves the app', async () => {
  const dir = await tmpDir();
  const { server, config } = await createServer({
    server: { port: 0 },
    runtime: { adapter: 'fake' },
    storage: { chatsDir: dir },
  });
  assert.equal(config.server.host, '127.0.0.1', 'overrides must not drop the loopback host');

  await new Promise((r) => server.listen(config.server.port, config.server.host, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);

  const css = await fetch(`${base}/styles.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const font = await fetch(`${base}/fonts/dm-sans-latin.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');

  for (const attack of ['/../config.json', '/..%2f..%2fconfig.json', '/%2e%2e/package.json']) {
    const res = await fetch(base + attack);
    assert.ok(res.status === 403 || res.status === 404, `${attack} returned ${res.status}`);
  }

  const cross = await fetch(`${base}/api/state`, { headers: { origin: 'http://evil.example' } });
  assert.equal(cross.status, 403);

  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.rm(dir, { recursive: true, force: true });
});

test('`node src/server.js` actually starts and answers', { timeout: 20000 }, async () => {
  const dir = await tmpDir();
  const port = 4300 + Number(process.hrtime.bigint() % 90n);
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      LANDSLIDE_ADAPTER: 'fake',
      LANDSLIDE_PORT: String(port),
      LANDSLIDE_CHATS_DIR: dir,
    },
    stdio: 'ignore',
  });

  try {
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/state`);
        ok = res.ok;
      } catch {
        /* not up yet */
      }
    }
    assert.ok(ok, 'npm start must actually bind a port — it silently did nothing on Windows');
  } finally {
    child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ================================================================== */
/* Findings 5 & 6 — llama.cpp adapter drift                            */
/* ================================================================== */

async function stubServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

const sse = (frames) =>
  frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';

test('llamacpp: a delta carrying both reasoning and content keeps both', async () => {
  const stub = await stubServer((req, res) => {
    if (req.url === '/health') return res.writeHead(200).end('{}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      sse([
        { choices: [{ delta: { reasoning_content: 'why', content: 'THE ANSWER' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
      ]),
    );
  });

  const rt = createRuntime({ adapter: 'llamacpp', llamaCppUrl: stub.url });
  const out = await rt.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(out.thinking, 'why');
  assert.equal(out.answer, 'THE ANSWER', 'the answer must not be dropped by an else-if');
  await stub.close();
});

test('llamacpp: reasoning containing a literal closing tag does not corrupt the split', async () => {
  const stub = await stubServer((req, res) => {
    if (req.url === '/health') return res.writeHead(200).end('{}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      sse([
        { choices: [{ delta: { reasoning_content: 'they typed </think> in the prompt' } }] },
        { choices: [{ delta: { content: 'real answer' } }] },
      ]),
    );
  });

  const rt = createRuntime({ adapter: 'llamacpp', llamaCppUrl: stub.url });
  const out = await rt.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(out.thinking, 'they typed </think> in the prompt');
  assert.equal(out.answer, 'real answer');
  await stub.close();
});

/* ================================================================== */
/* Ollama adapter had no coverage at all                               */
/* ================================================================== */

test('ollama: streams NDJSON, separates thinking, reports token counts', async () => {
  const stub = await stubServer((req, res) => {
    if (req.url === '/api/version') return res.writeHead(200).end(JSON.stringify({ version: '0.32.15' }));
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const frames = [
      { message: { content: '<think>reas' } },
      { message: { content: 'oning</think>Ans' } },
      { message: { content: 'wer.' } },
      { done: true, prompt_eval_count: 7, eval_count: 21 },
    ];
    res.end(frames.map((f) => JSON.stringify(f) + '\n').join(''));
  });

  const rt = createRuntime({ adapter: 'ollama', ollamaUrl: stub.url });
  assert.equal((await rt.health()).ok, true);

  const out = await rt.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(out.thinking, 'reasoning');
  assert.equal(out.answer, 'Answer.');
  assert.equal(out.stats.promptTokens, 7);
  assert.equal(out.stats.tokens, 21);
  await stub.close();
});

test('ollama: reasoning streamed in message.thinking is not discarded', async () => {
  // Ollama 0.32+ emits reasoning out of band. Reading only message.content threw
  // away every reasoning token, so the whole reasoning panel was dead.
  const stub = await stubServer((req, res) => {
    if (req.url === '/api/version') return res.writeHead(200).end('{}');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const frames = [
      { message: { role: 'assistant', content: '', thinking: 'Six times ' } },
      { message: { role: 'assistant', content: '', thinking: 'seven.' } },
      { message: { role: 'assistant', content: '42.' } },
      { done: true, prompt_eval_count: 22, eval_count: 200, eval_duration: 3_040_000_000 },
    ];
    res.end(frames.map((f) => JSON.stringify(f) + '\n').join(''));
  });

  const rt = createRuntime({ adapter: 'ollama', ollamaUrl: stub.url });
  const out = await rt.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(out.thinking, 'Six times seven.');
  assert.equal(out.answer, '42.');
  assert.equal(out.stats.tokens, 200);
  // 200 tokens over the server's reported 3.04s, not over our observed window.
  assert.ok(
    Math.abs(out.stats.tokensPerSecond - 65.8) < 1,
    `throughput should come from eval_duration, got ${out.stats.tokensPerSecond}`,
  );
  await stub.close();
});

test('ollama: an error frame mid-stream surfaces as an error', async () => {
  const stub = await stubServer((req, res) => {
    if (req.url === '/api/version') return res.writeHead(200).end('{}');
    res.writeHead(200);
    res.end(JSON.stringify({ error: 'model not found' }) + '\n');
  });
  const rt = createRuntime({ adapter: 'ollama', ollamaUrl: stub.url });
  await assert.rejects(
    () => rt.chat({ model: 'nope', messages: [{ role: 'user', content: 'x' }] }),
    /model not found/,
  );
  await stub.close();
});

/* ================================================================== */
/* Catalog: shallow freeze let defaults leak between callers           */
/* ================================================================== */

test('mutating a model copy cannot affect the next lookup', async () => {
  const catalog = await import('../src/core/model-catalog.js');
  const first = catalog.get('deckard-4b');
  const original = first.defaults.temperature;
  first.defaults.temperature = 99;
  assert.equal(catalog.get('deckard-4b').defaults.temperature, original);
});

/* ================================================================== */
/* RuntimeSupervisor — the one-click start path                        */
/* ================================================================== */

test('supervisor reports a live runtime and its resident models', async () => {
  const { createRuntimeSupervisor } = await import('../src/core/runtime-supervisor.js');
  const stub = await stubServer((req, res) => {
    if (req.url === '/api/version') return res.writeHead(200).end(JSON.stringify({ version: '9.9.9' }));
    if (req.url === '/api/ps') {
      return res
        .writeHead(200)
        .end(JSON.stringify({ models: [{ name: 'deckard-4b:latest', size: 2.7e9, expires_at: 'later' }] }));
    }
    res.writeHead(404).end();
  });

  const boss = createRuntimeSupervisor({ ollamaUrl: stub.url });
  const s = await boss.status();
  assert.equal(s.running, true);
  assert.equal(s.version, '9.9.9');
  assert.equal(s.loaded[0].name, 'deckard-4b:latest');
  await stub.close();
});

test('supervisor reports a dead runtime without throwing', async () => {
  const { createRuntimeSupervisor } = await import('../src/core/runtime-supervisor.js');
  const boss = createRuntimeSupervisor({ ollamaUrl: 'http://127.0.0.1:1' });
  const s = await boss.status();
  assert.equal(s.running, false);
  assert.deepEqual(s.loaded, []);
});

test('start fails cleanly when the executable cannot be found', async () => {
  const { createRuntimeSupervisor } = await import('../src/core/runtime-supervisor.js');
  const boss = createRuntimeSupervisor({
    ollamaUrl: 'http://127.0.0.1:1',
    ollamaBin: path.join(os.tmpdir(), 'definitely-not-ollama-xyz.exe'),
  });
  const r = await boss.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not find the Ollama executable/);
});

test('start is a no-op when the runtime already answers', async () => {
  const { createRuntimeSupervisor } = await import('../src/core/runtime-supervisor.js');
  const stub = await stubServer((req, res) => {
    if (req.url === '/api/version') return res.writeHead(200).end(JSON.stringify({ version: '1.2.3' }));
    res.writeHead(200).end('{}');
  });
  const boss = createRuntimeSupervisor({ ollamaUrl: stub.url });
  const r = await boss.start();
  assert.equal(r.ok, true);
  assert.equal(r.alreadyRunning, true);
  assert.equal(r.tookMs, 0);
  await stub.close();
});

test('warm preloads through the runtime and reports how long it took', async () => {
  const { createRuntimeSupervisor } = await import('../src/core/runtime-supervisor.js');
  let seen = null;
  const stub = await stubServer((req, res) => {
    if (req.url === '/api/generate') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = JSON.parse(body);
        res.writeHead(200).end(JSON.stringify({ done: true, done_reason: 'load' }));
      });
      return;
    }
    res.writeHead(200).end('{}');
  });
  const boss = createRuntimeSupervisor({ ollamaUrl: stub.url });
  const r = await boss.warm('deckard-4b');
  assert.equal(r.ok, true);
  assert.equal(seen.model, 'deckard-4b');
  assert.equal(seen.prompt, '', 'an empty prompt is what makes this a load rather than a generation');
  assert.equal(seen.keep_alive, '30m');
  await stub.close();
});

test('the warm endpoint refuses a model that is not in the catalog', async () => {
  const h = await apiHarness();
  const res = await fetch(`${h.base}/api/runtime/warm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: '../../etc/passwd' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown model/);
  await h.close();
});

/* ================================================================== */
/* Q3 — a reply is attributed to the model that wrote it              */
/* ================================================================== */

/**
 * Issue #1. `chat.modelId` is the CURRENT choice, so labelling replies from it
 * reassigns authorship of the whole history every time you switch models. The
 * message has to carry its own.
 */

test('Q3: switching models mid-chat leaves earlier replies attributed correctly', async () => {
  const dir = await tmpDir();
  const api = createApi({
    store: createJsonFileStore(dir),
    runtime: createRuntime({ adapter: 'fake' }),
    config: {
      hardware: { vramTotalGb: 8, vramUsableGb: 6.65, label: 'test gpu' },
      storage: { chatsDir: dir, modelsDir: path.join(dir, 'models') },
    },
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await api(req, res, url))) res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const made = await (await fetch(`${base}/api/chats`, { method: 'POST' })).json();
  const id = made.chat.id;
  const send = (content, modelId) =>
    fetch(`${base}/api/chats/${id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, modelId }),
    }).then((r) => r.text());

  await send('first question', 'cold-fusion-9b');
  await send('second question', 'deckard-4b');

  const { chat } = await (await fetch(`${base}/api/chats/${id}`)).json();
  const replies = chat.messages.filter((m) => m.role === 'assistant');
  assert.equal(replies.length, 2);
  assert.equal(replies[0].modelId, 'cold-fusion-9b', 'the first reply keeps the model that wrote it');
  assert.equal(replies[1].modelId, 'deckard-4b');
  assert.equal(chat.modelId, 'deckard-4b', 'the chat itself has moved on, which is exactly why the message needs its own');

  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * The export is the copy that leaves this machine. It read `chat.modelId` for
 * every reply, so a file exported after a model switch reattributed the whole
 * history — the same defect as the on-screen label, in the more durable artifact.
 */
test('Q3: the markdown export attributes each reply to the model that wrote it', async () => {
  const { toMarkdown } = await import('../src/core/chat-export.js');
  const md = toMarkdown({
    title: 'attribution',
    modelId: 'auto-variable-2b', // the chat has since been switched to a third model
    createdAt: '2026-08-24T00:00:00.000Z',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'from cold fusion', modelId: 'cold-fusion-9b' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'from deckard', modelId: 'deckard-4b' },
    ],
  });

  const headings = md.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(headings, ['## You', '## cold-fusion-9b', '## You', '## deckard-4b']);
  assert.ok(
    !md.includes('## auto-variable-2b'),
    "the chat's current model must not be stamped on replies it never wrote",
  );
  assert.ok(!md.includes('predate'), 'nothing was inferred here, so nothing should be caveated');
});

test('Q3: an export containing unstamped replies says so once, not per heading', async () => {
  const { toMarkdown } = await import('../src/core/chat-export.js');
  const md = toMarkdown({
    title: 'legacy',
    modelId: 'deckard-4b',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'written before the field existed' },
    ],
  });
  assert.equal(md.split('predate').length - 1, 1, 'the caveat belongs in the metadata line, once');
  assert.ok(md.includes('## deckard-4b'), "the chat's model is still the best guess available");
});
