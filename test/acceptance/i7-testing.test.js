/**
 * ACCEPTANCE — I7 Testing gaps.
 *
 * Authored before the implementation. Locked; not the builder's to edit.
 *
 * Every UI defect in this project so far was found by a human looking at the
 * screen, and the renderer lockup only appeared at eleven thousand characters of
 * reasoning. This item closes both gaps with tests that could have caught them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'ls-i7-'));

/* ------------------------------------------------------------------ */
/* A. A UI test that drives a conversation with no human present        */
/* ------------------------------------------------------------------ */

test('I7-A1: a headless UI test exists and is part of the suite', async () => {
  const candidates = ['test/ui.test.js', 'test/ui/ui.test.js', 'test/browser.test.js'];
  let found = null;
  for (const c of candidates) {
    if (await fs.stat(path.join(ROOT, c)).then(() => true, () => false)) found = c;
  }
  assert.ok(found, `expected a UI test at one of: ${candidates.join(' | ')}`);
});

test('I7-A2: the UI test drives the real page, not a mock of it', async () => {
  const candidates = ['test/ui.test.js', 'test/ui/ui.test.js', 'test/browser.test.js'];
  let src = '';
  for (const c of candidates) {
    src = await fs.readFile(path.join(ROOT, c), 'utf8').catch(() => '');
    if (src) break;
  }
  assert.ok(src, 'no UI test found');
  assert.ok(/index\.html/.test(src), 'the UI test must load the real index.html');
  assert.ok(/app\.js|createServer/.test(src), 'and exercise the real frontend against the real server');
});

test('I7-A3: the UI test asserts on DOM state after a full send/stream/render cycle', async () => {
  const candidates = ['test/ui.test.js', 'test/ui/ui.test.js', 'test/browser.test.js'];
  let src = '';
  for (const c of candidates) {
    src = await fs.readFile(path.join(ROOT, c), 'utf8').catch(() => '');
    if (src) break;
  }
  assert.ok(/msg-assistant|msg-text|\.think/.test(src), 'it must assert on rendered message DOM');
  assert.ok(/statusBar|hidden|disabled/.test(src), 'and on the busy/idle state that has broken twice');
});

/* ------------------------------------------------------------------ */
/* B. Soak: long reasoning must not block the main thread               */
/* ------------------------------------------------------------------ */

test('I7-B1: 20k characters of reasoning render without a long block', { timeout: 120_000 }, async () => {
  // The renderer is the thing under test, so it is driven directly with the
  // same shim shape the other acceptance suites use.
  const TEXT = 3;
  const mkText = (data) => ({
    nodeType: TEXT,
    data: String(data),
    appendData(s) {
      this.data += s;
    },
    get textContent() {
      return this.data;
    },
  });
  const mkEl = () => ({
    nodeType: 1,
    childNodes: [],
    className: '',
    attributes: {},
    setAttribute() {},
    get lastChild() {
      return this.childNodes.at(-1) ?? null;
    },
    set textContent(v) {
      this.childNodes = v === '' ? [] : [mkText(v)];
    },
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    },
    append(...k) {
      this.childNodes.push(...k);
    },
    replaceChildren(...k) {
      this.childNodes = k;
    },
  });
  globalThis.document = { createElement: mkEl, createTextNode: mkText };
  globalThis.Node = { TEXT_NODE: TEXT, ELEMENT_NODE: 1 };

  const { appendStream } = await import('../../public/render.js');

  const el = mkEl();
  const chunk = 'reasoning words that go on and on ';
  let acc = '';
  let worst = 0;
  const target = 20_000;

  while (acc.length < target) {
    acc += chunk;
    const began = process.hrtime.bigint();
    appendStream(el, acc, chunk);
    const ms = Number(process.hrtime.bigint() - began) / 1e6;
    if (ms > worst) worst = ms;
  }

  assert.ok(el.textContent.length >= target, 'all of it must actually be rendered');
  assert.ok(
    worst < 100,
    `the worst single append took ${worst.toFixed(1)}ms; a quadratic renderer is what locked the page before`,
  );
});

test('I7-B2: total time to render 20k characters incrementally stays linear', { timeout: 120_000 }, async () => {
  const TEXT = 3;
  const mkText = (d) => ({
    nodeType: TEXT,
    data: String(d),
    appendData(s) {
      this.data += s;
    },
    get textContent() {
      return this.data;
    },
  });
  const mkEl = () => ({
    nodeType: 1,
    childNodes: [],
    className: '',
    attributes: {},
    setAttribute() {},
    get lastChild() {
      return this.childNodes.at(-1) ?? null;
    },
    set textContent(v) {
      this.childNodes = v === '' ? [] : [mkText(v)];
    },
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    },
    append(...k) {
      this.childNodes.push(...k);
    },
    replaceChildren(...k) {
      this.childNodes = k;
    },
  });
  globalThis.document = { createElement: mkEl, createTextNode: mkText };
  globalThis.Node = { TEXT_NODE: TEXT, ELEMENT_NODE: 1 };
  const { appendStream } = await import('../../public/render.js');

  const time = (target) => {
    const el = mkEl();
    let acc = '';
    const began = process.hrtime.bigint();
    while (acc.length < target) {
      const c = 'word words wording ';
      acc += c;
      appendStream(el, acc, c);
    }
    return Number(process.hrtime.bigint() - began) / 1e6;
  };

  const small = Math.max(time(5_000), 1);
  const large = time(20_000);
  assert.ok(
    large < small * 12,
    `4x the text took ${(large / small).toFixed(1)}x the time — that is superlinear (${small.toFixed(0)}ms -> ${large.toFixed(0)}ms)`,
  );
});

/* ------------------------------------------------------------------ */
/* C. The live check must exercise a reasoning model                    */
/* ------------------------------------------------------------------ */

test('I7-C1: verify-live can be pointed at a specific model', async () => {
  const src = await fs.readFile(path.join(ROOT, 'scripts', 'verify-live.mjs'), 'utf8');
  assert.match(
    src,
    /process\.argv/,
    'verify-live must accept a model argument so the thinking path can be checked deliberately',
  );
});

test('I7-C2: verify-live asserts on the reasoning path, not only on an answer', async () => {
  const src = await fs.readFile(path.join(ROOT, 'scripts', 'verify-live.mjs'), 'utf8');
  assert.match(
    src,
    /think/i,
    'a live check that never looks at reasoning would not have caught the dropped message.thinking field',
  );
});

/* ------------------------------------------------------------------ */
/* D. The suite policices itself                                        */
/* ------------------------------------------------------------------ */

test('I7-D1: the acceptance lock is verified as part of the gates', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = Object.values(pkg.scripts ?? {}).join(' ');
  assert.ok(
    /acceptance-lock/.test(scripts),
    'checking the lock must be a scripted step, not something a human remembers',
  );
});

test('I7-D2: every queue item has an acceptance suite', async () => {
  const files = await fs.readdir(path.join(ROOT, 'test', 'acceptance'));
  const suites = files.filter((f) => f.endsWith('.test.js'));
  for (const item of ['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8']) {
    assert.ok(
      suites.some((s) => s.startsWith(`${item}-`)),
      `no acceptance suite for ${item}; found: ${suites.join(', ')}`,
    );
  }
});

test('I7-D3: no acceptance suite is trivially empty', async () => {
  const dir = path.join(ROOT, 'test', 'acceptance');
  for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith('.test.js'))) {
    const src = await fs.readFile(path.join(dir, f), 'utf8');
    const count = (src.match(/^test\(/gm) ?? []).length;
    assert.ok(count >= 5, `${f} has only ${count} tests — too thin to be a gate`);
  }
});
