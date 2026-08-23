import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime/index.js';
import { lines, sseData } from '../src/runtime/stream-util.js';

const fake = (cfg = {}) => createRuntime({ adapter: 'fake', ...cfg });

test('unknown adapter fails loudly at construction', () => {
  assert.throws(() => createRuntime({ adapter: 'nope' }), /unknown runtime adapter/);
});

test('health reports ok with adapter name', async () => {
  const h = await fake().health();
  assert.equal(h.ok, true);
  assert.equal(h.adapter, 'fake');
});

test('health failure is returned, not thrown', async () => {
  const h = await fake({ failWith: 'ECONNREFUSED' }).health();
  assert.equal(h.ok, false);
  assert.match(h.error, /is the model server running/);
});

test('listModels degrades to an empty list rather than throwing', async () => {
  assert.deepEqual(await fake({ failWith: 'boom' }).listModels(), []);
});

test('chat separates thinking from the answer', async () => {
  const res = await fake().chat({
    model: 'cold-fusion-9b',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.thinking, 'Working out what they meant.');
  assert.equal(res.answer, 'This is a scripted reply.');
  assert.equal(res.aborted, false);
});

test('chat streams events in order and they reconstruct the result', async () => {
  const seen = [];
  const res = await fake().chat({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    onEvent: (e) => seen.push(e),
  });
  const think = seen.filter((e) => e.type === 'think').map((e) => e.text).join('');
  const answer = seen.filter((e) => e.type === 'answer').map((e) => e.text).join('');
  assert.equal(think, res.thinking);
  assert.equal(answer, res.answer);
  assert.equal(seen.at(-1).type, 'stats', 'stats must be the final event');
});

test('stats carry timing and throughput', async () => {
  const res = await fake().chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(Number.isFinite(res.stats.firstTokenMs), 'firstTokenMs should be measured');
  assert.ok(res.stats.totalMs >= 0);
  assert.ok(res.stats.tokens > 0);
  assert.equal(res.stats.promptTokens, 11);
  assert.ok(res.stats.tokensPerSecond >= 0);
});

test('an instruct-style reply with no think block yields empty thinking', async () => {
  const res = await fake().chat({
    model: 'heretic-instruct-9b',
    messages: [{ role: 'user', content: 'hi' }],
    options: { script: 'Straight to the point.' },
  });
  assert.equal(res.thinking, '');
  assert.equal(res.answer, 'Straight to the point.');
});

test('abort mid-stream returns partial text and flags aborted', async () => {
  const ctrl = new AbortController();
  const rt = createRuntime({ adapter: 'fake', delayMs: 5, chunkSize: 2 });
  const p = rt.chat({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    signal: ctrl.signal,
    options: { script: 'abcdefghijklmnopqrstuvwxyz' },
  });
  setTimeout(() => ctrl.abort(), 20);
  const res = await p;
  assert.equal(res.aborted, true);
  assert.ok(res.answer.length < 26, 'should not have finished the script');
  assert.ok(res.stats.totalMs >= 0);
});

test('chat validates its inputs', async () => {
  const rt = fake();
  await assert.rejects(() => rt.chat({ messages: [{ role: 'user', content: 'x' }] }), /requires a model/);
  await assert.rejects(() => rt.chat({ model: 'm', messages: [] }), /at least one message/);
});

test('startInThink handles a template that pre-opens reasoning', async () => {
  const res = await fake().chat({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    options: { script: 'reasoning first</think>then the answer', startInThink: true },
  });
  assert.equal(res.thinking, 'reasoning first');
  assert.equal(res.answer, 'then the answer');
});

/* stream-util is the shared plumbing both real adapters depend on. */

const streamOf = (...chunks) =>
  (async function* () {
    for (const c of chunks) yield Buffer.from(c, 'utf8');
  })();

test('lines rejoins a line split across chunks', async () => {
  const out = [];
  for await (const l of lines(streamOf('{"a":', '1}\n{"b":2}\n'))) out.push(l);
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('lines strips CR and drops blanks, but keeps a non-empty tail', async () => {
  const out = [];
  for await (const l of lines(streamOf('one\r\n\r\ntwo'))) out.push(l);
  assert.deepEqual(out, ['one', 'two']);
});

test('lines handles a multi-byte character split across chunks', async () => {
  const emoji = Buffer.from('héllo\n', 'utf8');
  const out = [];
  for await (const l of lines(
    (async function* () {
      yield emoji.subarray(0, 2);
      yield emoji.subarray(2);
    })(),
  )) {
    out.push(l);
  }
  assert.deepEqual(out, ['héllo']);
});

test('sseData unwraps data frames and stops at DONE', async () => {
  const out = [];
  for await (const d of sseData(streamOf('data: {"x":1}\n', 'event: ping\n', 'data: [DONE]\n', 'data: {"y":2}\n'))) {
    out.push(d);
  }
  assert.deepEqual(out, ['{"x":1}']);
});
