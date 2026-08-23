import test from 'node:test';
import assert from 'node:assert/strict';
import { createThinkStream, splitThinking } from '../src/core/think-stream.js';

const collect = (chunks, opts) => {
  const s = createThinkStream(opts);
  const out = [];
  for (const c of chunks) out.push(...s.feed(c));
  out.push(...s.end());
  return out;
};

const joinOf = (events, type) =>
  events.filter((e) => e.type === type).map((e) => e.text).join('');

test('plain text with no tags is all answer', () => {
  const ev = collect(['Hello ', 'world']);
  assert.equal(joinOf(ev, 'answer'), 'Hello world');
  assert.equal(joinOf(ev, 'think'), '');
});

test('a complete think block is separated from the answer', () => {
  const ev = collect(['<think>reasoning here</think>Final answer.']);
  assert.equal(joinOf(ev, 'think'), 'reasoning here');
  assert.equal(joinOf(ev, 'answer'), 'Final answer.');
});

test('open tag split across chunk boundary', () => {
  const ev = collect(['<thi', 'nk>abc</think>done']);
  assert.equal(joinOf(ev, 'think'), 'abc');
  assert.equal(joinOf(ev, 'answer'), 'done');
});

test('close tag split across many single-character chunks', () => {
  const src = '<think>reason</think>answer';
  const ev = collect(src.split(''));
  assert.equal(joinOf(ev, 'think'), 'reason');
  assert.equal(joinOf(ev, 'answer'), 'answer');
});

test('startInThink handles templates that pre-open the block', () => {
  const ev = collect(['thinking...</think>the answer'], { startInThink: true });
  assert.equal(joinOf(ev, 'think'), 'thinking...');
  assert.equal(joinOf(ev, 'answer'), 'the answer');
});

test('multiple think blocks are all captured', () => {
  const ev = collect(['<think>a</think>X<think>b</think>Y']);
  assert.equal(joinOf(ev, 'think'), 'ab');
  assert.equal(joinOf(ev, 'answer'), 'XY');
});

test('an unterminated think block flushes as think on end', () => {
  const ev = collect(['<think>never closed']);
  assert.equal(joinOf(ev, 'think'), 'never closed');
  assert.equal(joinOf(ev, 'answer'), '');
});

test('a dangling partial tag is flushed as literal text on end', () => {
  const ev = collect(['answer text <thi']);
  assert.equal(joinOf(ev, 'answer'), 'answer text <thi');
});

test('never emits an empty event', () => {
  const ev = collect(['<think></think>', '', 'x']);
  assert.ok(ev.every((e) => e.text.length > 0), 'found a zero-length event');
});

test('text is never lost across random chunk splits', () => {
  const src = 'pre<think>mid one</think>post<think>mid two</think>tail';
  for (const size of [1, 2, 3, 5, 7, 11, 23]) {
    const chunks = [];
    for (let i = 0; i < src.length; i += size) chunks.push(src.slice(i, i + size));
    const ev = collect(chunks);
    assert.equal(joinOf(ev, 'think'), 'mid onemid two', `size ${size}`);
    assert.equal(joinOf(ev, 'answer'), 'preposttail', `size ${size}`);
  }
});

test('state reflects the current section', () => {
  const s = createThinkStream();
  assert.equal(s.state, 'answer');
  s.feed('<think>x');
  assert.equal(s.state, 'think');
  s.feed('</think>');
  assert.equal(s.state, 'answer');
});

test('splitThinking convenience wrapper', () => {
  const { think, answer } = splitThinking('<think>why</think>because');
  assert.equal(think, 'why');
  assert.equal(answer, 'because');
});

test('custom tags are honoured', () => {
  const ev = collect(['<reasoning>r</reasoning>a'], {
    openTag: '<reasoning>',
    closeTag: '</reasoning>',
  });
  assert.equal(joinOf(ev, 'think'), 'r');
  assert.equal(joinOf(ev, 'answer'), 'a');
});
