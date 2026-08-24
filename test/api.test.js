import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonFileStore } from '../src/core/chat-store.js';
import { createRuntime } from '../src/runtime/index.js';
import { createApi } from '../src/api.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-api-'));
  const config = {
    hardware: { vramTotalGb: 8, vramUsableGb: 6.65, label: 'test gpu' },
    storage: { chatsDir: dir, modelsDir: path.join(dir, 'models') },
  };
  const api = createApi({
    store: createJsonFileStore(dir),
    runtime: createRuntime({ adapter: 'fake' }),
    config,
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await api(req, res, url))) res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    dir,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const json = async (base, method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

test('GET /api/state reports runtime, hardware and per-model fit', async () => {
  const h = await harness();
  const { status, body } = await json(h.base, 'GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(body.runtime.ok, true);
  assert.equal(body.models.length, 5);
  assert.equal(body.totalSizeGb, 21.23);

  const nine = body.models.find((m) => m.id === 'cold-fusion-9b');
  assert.equal(nine.fit.verdict, 'fits');
  const four = body.models.find((m) => m.id === 'deckard-4b');
  assert.equal(four.fit.verdict, 'fits');
  const twentyOne = body.models.find((m) => m.id === 'glm-flash-21b');
  assert.equal(twentyOne.fit.verdict, 'spills', '21B must be honestly flagged as not fitting');
  assert.ok(body.models.every((m) => m.uncensored === true), 'every shipped model is uncensored');
  await h.close();
});

test('chat CRUD lifecycle', async () => {
  const h = await harness();
  const created = await json(h.base, 'POST', '/api/chats', { modelId: 'deckard-4b' });
  assert.equal(created.status, 200);
  const id = created.body.chat.id;

  assert.equal((await json(h.base, 'GET', `/api/chats/${id}`)).body.chat.id, id);
  assert.equal((await json(h.base, 'GET', '/api/chats')).body.chats.length, 1);

  const renamed = await json(h.base, 'PATCH', `/api/chats/${id}`, { title: 'Renamed' });
  assert.equal(renamed.body.chat.title, 'Renamed');

  assert.equal((await json(h.base, 'DELETE', `/api/chats/${id}`)).body.removed, true);
  assert.equal((await json(h.base, 'GET', `/api/chats/${id}`)).status, 404);
  await h.close();
});

test('unknown endpoints and bad bodies fail cleanly', async () => {
  const h = await harness();
  assert.equal((await json(h.base, 'GET', '/api/nope')).status, 404);

  const bad = await fetch(`${h.base}/api/chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ broken',
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not valid JSON/);
  await h.close();
});

test('POST message streams SSE and persists both turns', async () => {
  const h = await harness();
  const { body: made } = await json(h.base, 'POST', '/api/chats', {});
  const id = made.chat.id;

  const res = await fetch(`${h.base}/api/chats/${id}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'why is the sky blue', modelId: 'cold-fusion-9b' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const events = [];
  const raw = await res.text();
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
  }

  assert.equal(events[0].type, 'start');
  assert.equal(events.at(-1).type, 'done');
  assert.ok(events.some((e) => e.type === 'think'), 'reasoning should stream');
  assert.ok(events.some((e) => e.type === 'answer'), 'answer should stream');

  const doneEvent = events.at(-1);
  assert.ok(doneEvent.stats.tokens > 0);
  assert.equal(doneEvent.aborted, false);

  const { body: after } = await json(h.base, 'GET', `/api/chats/${id}`);
  assert.equal(after.chat.messages.length, 2);
  assert.equal(after.chat.messages[0].role, 'user');
  assert.equal(after.chat.messages[1].role, 'assistant');
  assert.equal(after.chat.messages[1].thinking, 'Working out what they meant.');
  assert.equal(after.chat.title, 'why is the sky blue', 'chat should auto-title');
  await h.close();
});

test('a message rejects an unknown model and empty content', async () => {
  const h = await harness();
  const { body: made } = await json(h.base, 'POST', '/api/chats', {});
  const id = made.chat.id;

  const badModel = await json(h.base, 'POST', `/api/chats/${id}/message`, {
    content: 'hi',
    modelId: 'not-a-model',
  });
  assert.equal(badModel.status, 400);
  assert.match(badModel.body.error, /unknown model/);

  const empty = await json(h.base, 'POST', `/api/chats/${id}/message`, {
    content: '   ',
    modelId: 'deckard-4b',
  });
  assert.equal(empty.status, 400);
  await h.close();
});

test('search endpoint filters chats', async () => {
  const h = await harness();
  const a = (await json(h.base, 'POST', '/api/chats', { title: 'roofing outreach' })).body.chat;
  await json(h.base, 'POST', '/api/chats', { title: 'poetry' });
  const found = await json(h.base, 'GET', '/api/chats?q=roofing');
  assert.equal(found.body.chats.length, 1);
  assert.equal(found.body.chats[0].id, a.id);
  await h.close();
});

test('path traversal via a chat id is rejected', async () => {
  const h = await harness();
  const res = await fetch(`${h.base}/api/chats/${encodeURIComponent('../../secret')}`);
  assert.ok(res.status === 404 || res.status === 500, `unexpected status ${res.status}`);
  await h.close();
});

test('POST /api/chats/:id/branch forks the chat, and says why when it will not', async () => {
  const h = await harness();
  const { body: made } = await json(h.base, 'POST', '/api/chats', { modelId: 'deckard-4b' });
  const id = made.chat.id;
  await fetch(`${h.base}/api/chats/${id}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'the question', modelId: 'deckard-4b' }),
  }).then((r) => r.text());

  const { body: read } = await json(h.base, 'GET', `/api/chats/${id}`);
  const userTurnId = read.chat.messages[0].id;

  const forked = await json(h.base, 'POST', `/api/chats/${id}/branch`, { messageId: userTurnId });
  assert.equal(forked.status, 200);
  assert.notEqual(forked.body.chat.id, id);
  assert.equal(forked.body.chat.messages.length, 1, 'branching at the question keeps only the question');
  assert.equal(forked.body.chat.modelId, 'deckard-4b');

  // The source is untouched and both now exist.
  const { body: after } = await json(h.base, 'GET', `/api/chats/${id}`);
  assert.equal(after.chat.messages.length, 2);
  assert.equal((await json(h.base, 'GET', '/api/chats')).body.chats.length, 2);

  // A message that is not in this chat is the caller's mistake, not a 404: the
  // URL resolved perfectly well.
  assert.equal((await json(h.base, 'POST', `/api/chats/${id}/branch`, { messageId: 'nope' })).status, 400);
  assert.equal((await json(h.base, 'POST', `/api/chats/${id}/branch`, {})).status, 400);
  assert.equal((await json(h.base, 'POST', `/api/chats/${id}/branch`, { messageId: 42 })).status, 400);
  // A chat that does not exist is.
  assert.equal(
    (await json(h.base, 'POST', '/api/chats/aaaaaaaaaaaa/branch', { messageId: userTurnId })).status,
    404,
  );
  await h.close();
});

test('the start event carries the id of the turn it just saved, so the page can branch from it', async () => {
  const h = await harness();
  const { body: made } = await json(h.base, 'POST', '/api/chats', {});
  const raw = await fetch(`${h.base}/api/chats/${made.chat.id}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'hello', modelId: 'cold-fusion-9b' }),
  }).then((r) => r.text());

  const events = raw
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
  const start = events.find((e) => e.type === 'start');
  const done = events.find((e) => e.type === 'done');

  const { body: read } = await json(h.base, 'GET', `/api/chats/${made.chat.id}`);
  assert.equal(start.userMessageId, read.chat.messages[0].id, 'start names the user turn');
  assert.equal(done.messageId, read.chat.messages[1].id, 'done names the reply');
  await h.close();
});
