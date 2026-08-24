/**
 * ACCEPTANCE — I5 Performance.
 *
 * Authored before the implementation. Locked; not the builder's to edit.
 *
 * Every threshold here is a wall-clock measurement on this machine, not a claim
 * about complexity. A performance item that cannot be timed is an opinion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from '../../src/server.js';

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'ls-i5-'));

async function stubOllama() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url === '/api/version') return res.writeHead(200).end(JSON.stringify({ version: 'stub' }));
      if (req.url === '/api/tags') return res.writeHead(200).end(JSON.stringify({ models: [] }));
      if (req.url === '/api/ps') return res.writeHead(200).end(JSON.stringify({ models: [] }));
      if (req.url === '/api/generate') return res.writeHead(200).end(JSON.stringify({ done: true }));
      if (req.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        return res.end(JSON.stringify({ message: { content: 'x' } }) + '\n' + JSON.stringify({ done: true }) + '\n');
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    generates: () => seen.filter((s) => s.url === '/api/generate'),
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/* ------------------------------------------------------------------ */
/* A. Search must stay usable as history grows                          */
/* ------------------------------------------------------------------ */

test('I5-A1: search over 500 chats completes in under 200ms', { timeout: 300_000 }, async () => {
  const { createJsonFileStore } = await import('../../src/core/chat-store.js');
  const dir = await tmpDir();
  const store = createJsonFileStore(dir);

  for (let i = 0; i < 500; i++) {
    const chat = await store.create({ title: `conversation number ${i}` });
    await store.appendMessage(chat.id, {
      role: 'user',
      content: `filler ${i} ${'lorem ipsum dolor sit amet '.repeat(20)}`,
    });
    if (i === 250) {
      await store.appendMessage(chat.id, { role: 'assistant', content: 'NEEDLE-IN-HAYSTACK-TOKEN' });
    }
  }

  // Warm any index, then measure a cold-ish query.
  await store.search('lorem');
  const began = process.hrtime.bigint();
  const hits = await store.search('NEEDLE-IN-HAYSTACK-TOKEN');
  const ms = Number(process.hrtime.bigint() - began) / 1e6;

  assert.equal(hits.length, 1, 'the needle must be found');
  assert.ok(ms < 200, `search took ${ms.toFixed(0)}ms over 500 chats; must be under 200ms`);

  await fs.rm(dir, { recursive: true, force: true });
});

test('I5-A2: listing 500 chats is also under 200ms', { timeout: 300_000 }, async () => {
  const { createJsonFileStore } = await import('../../src/core/chat-store.js');
  const dir = await tmpDir();
  const store = createJsonFileStore(dir);
  for (let i = 0; i < 500; i++) {
    const c = await store.create({ title: `chat ${i}` });
    await store.appendMessage(c.id, { role: 'user', content: `body ${i} ${'x '.repeat(50)}` });
  }
  await store.list();
  const began = process.hrtime.bigint();
  const all = await store.list();
  const ms = Number(process.hrtime.bigint() - began) / 1e6;
  assert.equal(all.length, 500);
  assert.ok(ms < 200, `list took ${ms.toFixed(0)}ms; must be under 200ms`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('I5-A3: an index, if used, survives an externally added file', async () => {
  const { createJsonFileStore, newId } = await import('../../src/core/chat-store.js');
  const dir = await tmpDir();
  const store = createJsonFileStore(dir);
  await store.create({ title: 'first' });
  await store.list();

  // Something else writes a chat directly — a restore, a sync, a second window.
  const id = newId();
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: 'EXTERNALLY-ADDED',
      modelId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ id: newId(), role: 'user', content: 'hello', thinking: '', createdAt: new Date().toISOString(), stats: null }],
    }),
    'utf8',
  );

  const found = await store.search('EXTERNALLY-ADDED');
  assert.equal(found.length, 1, 'a cache must not hide a file that exists on disk');
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* B. Selecting a model preloads it                                     */
/* ------------------------------------------------------------------ */

test('I5-B1: the frontend preloads on model selection', async () => {
  const files = (await fs.readdir(new URL('../../public/', import.meta.url))).filter((f) => f.endsWith('.js'));
  let joined = '';
  for (const f of files) joined += await fs.readFile(new URL(`../../public/${f}`, import.meta.url), 'utf8');
  assert.match(
    joined,
    /selectModel[\s\S]{0,600}(warm|preload)/i,
    'choosing a model should start loading it rather than waiting for the first message',
  );
});

test('I5-B2: preloading an already-resident model does not reload it', async () => {
  const stub = await stubOllama();
  const dir = await tmpDir();
  const { server, config } = await createServer({
    server: { port: 0 },
    runtime: { adapter: 'ollama', ollamaUrl: stub.url },
    storage: { chatsDir: dir },
  });
  await new Promise((r) => server.listen(0, config.server.host, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const warm = () =>
    fetch(`${base}/api/runtime/warm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'deckard-4b' }),
    }).then((r) => r.json());

  await warm();
  const afterFirst = stub.generates().length;
  await warm();
  const afterSecond = stub.generates().length;
  assert.ok(
    afterSecond - afterFirst <= 1,
    'repeated preloads must not stack up work on the runtime',
  );

  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await stub.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* C. No regression in what we already measured                         */
/* ------------------------------------------------------------------ */

test('I5-C1: streaming overhead per token stays small', async () => {
  const { createRuntime } = await import('../../src/runtime/index.js');
  const rt = createRuntime({ adapter: 'fake', chunkSize: 1, script: 'y'.repeat(20_000) });
  const began = process.hrtime.bigint();
  const out = await rt.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  const ms = Number(process.hrtime.bigint() - began) / 1e6;
  assert.equal(out.answer.length, 20_000);
  assert.ok(ms < 3000, `20k single-character deltas took ${ms.toFixed(0)}ms; the facade must not be the bottleneck`);
});

test('I5-C2: batch size is configurable per model rather than hardcoded', async () => {
  const catalog = await import('../../src/core/model-catalog.js');
  const models = catalog.all();
  assert.ok(
    models.every((m) => 'num_batch' in m.defaults),
    'every model must declare num_batch so prompt processing can be tuned per model',
  );
});

/* ------------------------------------------------------------------ */
/* D. The faster runtime path is documented and reachable               */
/* ------------------------------------------------------------------ */

test('I5-D1: switching to llama.cpp is a config change that the app reports honestly', async () => {
  const dir = await tmpDir();
  const { server, config } = await createServer({
    server: { port: 0 },
    runtime: { adapter: 'llamacpp', llamaCppUrl: 'http://127.0.0.1:1' },
    storage: { chatsDir: dir },
  });
  await new Promise((r) => server.listen(0, config.server.host, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.runtime.adapter, 'llamacpp');
  assert.equal(state.runtime.ok, false, 'a dead llama-server must read as dead');

  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.rm(dir, { recursive: true, force: true });
});
