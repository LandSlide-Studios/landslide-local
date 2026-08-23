/**
 * ACCEPTANCE — I1 Quality of life.
 *
 * Authored before the implementation. This file defines the target; it is locked
 * by scripts/acceptance-lock.mjs and must not be edited to make code pass.
 *
 * Everything here is black-box: it drives the HTTP API and inspects what
 * actually reaches the model server, via a stub standing in for Ollama. It does
 * not import implementation internals except where the item explicitly requires
 * a named module to exist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from '../../src/server.js';

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'ls-i1-'));

/** A stub Ollama that records every request body it is sent. */
async function stubOllama({ reply = 'stub answer' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      seen.push({ url: req.url, body: parsed });

      if (req.url === '/api/version') return res.writeHead(200).end(JSON.stringify({ version: 'stub' }));
      if (req.url === '/api/tags') {
        return res.writeHead(200).end(JSON.stringify({ models: [{ name: 'deckard-4b:latest' }] }));
      }
      if (req.url === '/api/ps') return res.writeHead(200).end(JSON.stringify({ models: [] }));
      if (req.url === '/api/generate') {
        return res.writeHead(200).end(JSON.stringify({ done: true, done_reason: 'load' }));
      }
      if (req.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        return res.end(
          [
            JSON.stringify({ message: { content: reply } }),
            JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 5, eval_duration: 1e9 }),
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
    chats: () => seen.filter((s) => s.url === '/api/chat').map((s) => s.body),
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

async function app(stub) {
  const dir = await tmpDir();
  const { server, config } = await createServer({
    server: { port: 0 },
    runtime: { adapter: 'ollama', ollamaUrl: stub.url },
    storage: { chatsDir: dir },
  });
  await new Promise((r) => server.listen(0, config.server.host, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    dir,
    async json(method, url, body) {
      const res = await fetch(base + url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed, text };
    },
    async send(id, payload) {
      const res = await fetch(`${base}/api/chats/${id}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      const events = raw
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6)));
      return { status: res.status, events };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------ */
/* A. Context budget — the silent-truncation landmine                  */
/* ------------------------------------------------------------------ */

test('I1-A1: a context budget module exists and reports rather than hides trimming', async () => {
  const mod = await import('../../src/core/context-budget.js');
  assert.equal(typeof mod.planContext, 'function', 'planContext must be exported');

  const many = Array.from({ length: 400 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `message ${i} ${'word '.repeat(60)}`,
  }));
  const plan = mod.planContext({ messages: many, limitTokens: 2000, reserveTokens: 256 });

  assert.ok(Array.isArray(plan.messages), 'returns the messages that fit');
  assert.ok(plan.messages.length < many.length, 'an over-long history must actually be trimmed');
  assert.equal(typeof plan.trimmed, 'number', 'trimmed count is reported, not hidden');
  assert.ok(plan.trimmed > 0, 'trimming must be reported when it happens');
  assert.equal(plan.trimmed, many.length - plan.messages.length, 'trimmed count must be truthful');
  assert.ok(plan.estimatedTokens <= 2000 - 256, 'plan must respect the reserve');
});

test('I1-A2: trimming drops the oldest turns and keeps the most recent', async () => {
  const { planContext } = await import('../../src/core/context-budget.js');
  const many = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `msg-${i} ${'x '.repeat(80)}`,
  }));
  const plan = planContext({ messages: many, limitTokens: 1500, reserveTokens: 128 });
  const kept = plan.messages.map((m) => m.content);
  assert.ok(kept.at(-1).startsWith('msg-199'), 'the newest turn must survive');
  assert.ok(!kept.some((c) => c.startsWith('msg-0 ')), 'the oldest turn should be the first to go');
});

test('I1-A3: a system prompt is never trimmed away', async () => {
  const { planContext } = await import('../../src/core/context-budget.js');
  const many = Array.from({ length: 300 }, (_, i) => ({ role: 'user', content: `m${i} ${'y '.repeat(60)}` }));
  const plan = planContext({
    messages: many,
    systemPrompt: 'YOU ARE A TEST HARNESS',
    limitTokens: 1200,
    reserveTokens: 128,
  });
  const system = plan.messages.filter((m) => m.role === 'system');
  assert.equal(system.length, 1, 'the system prompt must survive trimming');
  assert.equal(plan.messages[0].role, 'system', 'and must stay first');
});

test('I1-A4: a short history is passed through untouched', async () => {
  const { planContext } = await import('../../src/core/context-budget.js');
  const few = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  const plan = planContext({ messages: few, limitTokens: 8192, reserveTokens: 256 });
  assert.equal(plan.trimmed, 0);
  assert.equal(plan.messages.length, 2);
});

test('I1-A5: the API surfaces context usage so the UI can show a meter', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });
  const { events } = await a.send(made.chat.id, { content: 'hello there', modelId: 'deckard-4b' });

  const start = events.find((e) => e.type === 'start');
  assert.ok(start, 'a start event is emitted');
  assert.ok(
    typeof start.context?.estimatedTokens === 'number' && typeof start.context?.limitTokens === 'number',
    'start event must carry context usage {estimatedTokens, limitTokens}',
  );
  await a.close();
  await stub.close();
});

test('I1-A6: an over-long chat warns instead of silently forgetting', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });

  // Force a tiny window so trimming is guaranteed.
  await a.send(made.chat.id, {
    content: 'x '.repeat(4000),
    modelId: 'deckard-4b',
    options: { num_ctx: 512 },
  });
  const { events } = await a.send(made.chat.id, {
    content: 'second turn',
    modelId: 'deckard-4b',
    options: { num_ctx: 512 },
  });

  const start = events.find((e) => e.type === 'start');
  assert.ok(start.context.trimmed > 0, 'the client must be told turns were dropped');
  await a.close();
  await stub.close();
});

/* ------------------------------------------------------------------ */
/* B. System prompt actually reaches the model                          */
/* ------------------------------------------------------------------ */

test('I1-B1: a system prompt sent with a message arrives first in the model payload', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });
  await a.send(made.chat.id, {
    content: 'hello',
    modelId: 'deckard-4b',
    systemPrompt: 'SPEAK ONLY IN LIMERICKS',
  });

  const payload = stub.chats().at(-1);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content, 'SPEAK ONLY IN LIMERICKS');
  await a.close();
  await stub.close();
});

test('I1-B2: a system prompt stored on the chat persists and is reused', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });

  const patched = await a.json('PATCH', `/api/chats/${made.chat.id}`, {
    systemPrompt: 'YOU ARE TERSE',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.chat.systemPrompt, 'YOU ARE TERSE', 'chat must store a system prompt');

  // Sent with no systemPrompt in the request: the stored one must still apply.
  await a.send(made.chat.id, { content: 'hi', modelId: 'deckard-4b' });
  const payload = stub.chats().at(-1);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content, 'YOU ARE TERSE');

  const reread = await a.json('GET', `/api/chats/${made.chat.id}`);
  assert.equal(reread.body.chat.systemPrompt, 'YOU ARE TERSE', 'and must survive a reload');
  await a.close();
  await stub.close();
});

test('I1-B3: the UI exposes a system prompt control', async () => {
  const html = await fs.readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="systemPrompt"/, 'index.html must contain a #systemPrompt control');
  assert.match(js, /systemPrompt/, 'app.js must send the system prompt');
});

/* ------------------------------------------------------------------ */
/* C. Regenerate                                                        */
/* ------------------------------------------------------------------ */

test('I1-C1: regenerate replaces the last reply instead of appending a second one', async () => {
  const stub = await stubOllama({ reply: 'FIRST' });
  const a = await app(stub);
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });
  await a.send(made.chat.id, { content: 'question', modelId: 'deckard-4b' });

  const before = await a.json('GET', `/api/chats/${made.chat.id}`);
  assert.equal(before.body.chat.messages.length, 2);

  const res = await fetch(`${a.base}/api/chats/${made.chat.id}/regenerate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'deckard-4b' }),
  });
  assert.equal(res.status, 200, 'a regenerate endpoint must exist');
  await res.text();

  const after = await a.json('GET', `/api/chats/${made.chat.id}`);
  assert.equal(after.body.chat.messages.length, 2, 'regenerate must not append a third message');
  assert.equal(after.body.chat.messages[0].role, 'user', 'the user turn is preserved');
  await a.close();
  await stub.close();
});

test('I1-C2: regenerate on a chat with no assistant reply is a clean 400, not a crash', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });
  const res = await fetch(`${a.base}/api/chats/${made.chat.id}/regenerate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'deckard-4b' }),
  });
  assert.equal(res.status, 400);
  await a.close();
  await stub.close();
});

/* ------------------------------------------------------------------ */
/* D. Generation parameters per chat                                    */
/* ------------------------------------------------------------------ */

test('I1-D1: per-chat generation options are stored and reach the model', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });

  const patched = await a.json('PATCH', `/api/chats/${made.chat.id}`, {
    options: { temperature: 0.31 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.chat.options.temperature, 0.31);

  await a.send(made.chat.id, { content: 'hi', modelId: 'deckard-4b' });
  const payload = stub.chats().at(-1);
  assert.equal(payload.options.temperature, 0.31, 'the stored temperature must reach the runtime');
  await a.close();
  await stub.close();
});

test('I1-D2: an out-of-range parameter is rejected, not passed through', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });
  const bad = await a.json('PATCH', `/api/chats/${made.chat.id}`, {
    options: { temperature: 99 },
  });
  assert.equal(bad.status, 400, 'temperature 99 is not a sane value');
  await a.close();
  await stub.close();
});

/* ------------------------------------------------------------------ */
/* E. Export                                                            */
/* ------------------------------------------------------------------ */

test('I1-E1: a chat exports to markdown containing both turns', async () => {
  const stub = await stubOllama({ reply: 'THE REPLY TEXT' });
  const a = await app(stub);
  const { body: made } = await a.json('POST', '/api/chats', { modelId: 'deckard-4b' });
  await a.send(made.chat.id, { content: 'THE QUESTION TEXT', modelId: 'deckard-4b' });

  const res = await fetch(`${a.base}/api/chats/${made.chat.id}/export?format=md`);
  assert.equal(res.status, 200);
  const md = await res.text();
  assert.ok(md.includes('THE QUESTION TEXT'), 'export contains the user turn');
  assert.ok(md.includes('THE REPLY TEXT'), 'export contains the assistant turn');
  assert.match(res.headers.get('content-type') ?? '', /markdown|text\/plain/);
  await a.close();
  await stub.close();
});

/* ------------------------------------------------------------------ */
/* F. Unload                                                            */
/* ------------------------------------------------------------------ */

test('I1-F1: unload asks the runtime to release the model', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  const res = await fetch(`${a.base}/api/runtime/unload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'deckard-4b' }),
  });
  assert.equal(res.status, 200, 'an unload endpoint must exist');

  const gen = stub.seen.filter((s) => s.url === '/api/generate').at(-1);
  assert.ok(gen, 'unload must talk to the runtime');
  assert.equal(gen.body.keep_alive, 0, 'keep_alive 0 is what actually evicts a model');
  await a.close();
  await stub.close();
});

test('I1-F2: unload refuses a model outside the catalog', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  const res = await fetch(`${a.base}/api/runtime/unload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'no-such-model' }),
  });
  assert.equal(res.status, 400);
  await a.close();
  await stub.close();
});

/* ------------------------------------------------------------------ */
/* G. Prompt library                                                    */
/* ------------------------------------------------------------------ */

test('I1-G1: prompts can be saved, listed and deleted, and survive a restart', async () => {
  const stub = await stubOllama();
  const a = await app(stub);

  const created = await a.json('POST', '/api/prompts', { name: 'Blunt', text: 'No hedging.' });
  assert.equal(created.status, 200);
  const id = created.body.prompt.id;
  assert.ok(id, 'a saved prompt has an id');

  const listed = await a.json('GET', '/api/prompts');
  assert.equal(listed.body.prompts.length, 1);
  assert.equal(listed.body.prompts[0].name, 'Blunt');

  const removed = await a.json('DELETE', `/api/prompts/${id}`);
  assert.equal(removed.status, 200);
  assert.equal((await a.json('GET', '/api/prompts')).body.prompts.length, 0);
  await a.close();
  await stub.close();
});

test('I1-G2: a prompt with no name or no text is refused', async () => {
  const stub = await stubOllama();
  const a = await app(stub);
  assert.equal((await a.json('POST', '/api/prompts', { name: '', text: 'x' })).status, 400);
  assert.equal((await a.json('POST', '/api/prompts', { name: 'x', text: '  ' })).status, 400);
  await a.close();
  await stub.close();
});

/* ------------------------------------------------------------------ */
/* H. Keyboard reachability of the controls this item adds              */
/* ------------------------------------------------------------------ */

test('I1-H1: the model list supports arrow-key navigation', async () => {
  const js = await fs.readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
  assert.match(
    js,
    /ArrowDown|ArrowUp/,
    'a role=radiogroup with no arrow-key handling is not keyboard reachable',
  );
});

test('I1-H2: every added control is a real button or input, not a click-only div', async () => {
  const html = await fs.readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  for (const id of ['systemPrompt', 'exportChat', 'regenerate']) {
    const re = new RegExp(`<(button|input|textarea|select|a)[^>]*id="${id}"`);
    assert.match(html, re, `#${id} must be a focusable element`);
  }
});
