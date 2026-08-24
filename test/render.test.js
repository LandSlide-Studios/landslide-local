/**
 * render.js — the markdown parser behind the message view.
 *
 * The acceptance suite (test/acceptance/i8-*.test.js) fixes WHAT has to render.
 * This file guards the one invariant that is easy to break by accident while
 * changing that: a streamed reply and the same text re-rendered after a reload
 * must produce the same DOM, at every chunk size. Both bugs named below were
 * found by the fuzz case at the bottom and not by any hand-written example.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* The same minimal DOM the acceptance suites use, plus attributes so a link is
   compared on its href too. */
function makeDom() {
  const TEXT = 3;
  const ELEMENT = 1;
  const mkText = (data) => ({
    nodeType: TEXT,
    data: String(data),
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
    tagName: String(tag).toUpperCase(),
    className: '',
    childNodes: [],
    attributes: {},
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    },
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
      const t = this.tagName.toLowerCase();
      const cls = this.className ? ` class="${this.className}"` : '';
      const at = Object.entries(this.attributes)
        .map(([k, v]) => ` ${k}="${v}"`)
        .join('');
      return `<${t}${cls}${at}>${this.childNodes.map((c) => c.serialize()).join('')}</${t}>`;
    },
  });
  return { Node: { TEXT_NODE: TEXT, ELEMENT_NODE: ELEMENT }, document: { createElement: mkEl, createTextNode: mkText }, mkEl };
}

const dom = makeDom();
globalThis.document = dom.document;
globalThis.Node = dom.Node;
const { renderText, appendStream } = await import('../public/render.js');

/**
 * Stream `text` in fixed-size chunks and compare with a one-shot render.
 * Seeded exactly as the app seeds it: the empty pending message first, so the
 * stream carries the model's format profile.
 */
function converges(text, profile, sizes = [1, 2, 3, 5, 13, 64]) {
  const oneShot = dom.mkEl('div');
  renderText(oneShot, text, profile);
  for (const size of sizes) {
    const streamed = dom.mkEl('div');
    renderText(streamed, '', profile);
    let acc = '';
    for (let i = 0; i < text.length; i += size) {
      const chunk = text.slice(i, i + size);
      acc += chunk;
      appendStream(streamed, acc, chunk);
    }
    assert.equal(
      streamed.serialize(),
      oneShot.serialize(),
      `chunk size ${size} diverged for ${JSON.stringify(text)}`,
    );
  }
}

const PROSE = { profile: 'prose', listsInterruptParagraph: false, indentPerLevel: 4 };
const REASONING = { profile: 'reasoning', indentPerLevel: 4 };

test('a paragraph that has gained a newline does not swallow it', () => {
  // The fast path appends into the trailing text node. A block ending one line
  // early — "text\n" renders as "text" — must therefore leave the fast path, or
  // the next word lands where the newline should be.
  converges('unclosed ```py\nstill going');
  converges('Ends with a newline\nand then more words');
});

test('a line under a table separator becomes a row the moment it gains a pipe', () => {
  // The retroactive case: the paragraph was already rendered, and one character
  // turns it into a row of the table above it.
  converges('| a |\n|---|\n| 1 |\nplain then a pipe |');
  converges('| Model | Speed |\n|---|---|\n| Deckard | 107 |\n');
});

test('streamed markdown converges on the reload rendering', () => {
  const corpus = [
    'plain words with periods. and 1 digit, plus (parens) and a dash - here',
    '# H1\n## H2\n### H3\ntext right after',
    'Intro:\n- a\n- b\n\n1. one\n2. two\n',
    '1.  **Step:**\n    *   sub one\n    *   sub two\n  wrapped continuation\n',
    '> quoted\n> more quoted\nlazy line\n\nout',
    '---\n***\ntext',
    'code `inline` and **bold `mix`** end',
    '```js\nconst x = **1**;\n```\ntrailing',
    'a [link](http://127.0.0.1/x) and [bad](javascript:alert(1)) done',
    'raw <script>alert(1)</script> <img src=x onerror=y> done',
    'para one\n\n\n\npara two',
    'nested:\n- top\n  - two space\n    - four space\n- back',
    'mixed markers:\n- bullet\n1. number\n- bullet again',
    'text with * stray and ** double and [ bracket and < angle',
    '## Head\n\n- one\n- two\n\n```js\nx\n```\n\nAfter **that**.',
  ];
  for (const text of corpus) {
    for (const profile of [undefined, PROSE, REASONING]) converges(text, profile);
  }
});

test('fuzz: random markdown converges at every chunk size', () => {
  // Deterministic on purpose. A seed that fails is a reproducible failure.
  let seed = 20260824;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const tokens = [
    'word ', 'the ', '\n', '\n\n', '- ', '* ', '1. ', '2)  ', '#', '## ', '> ', '|', '---',
    '```', '```js\n', '`', '**', '*', '[', '](http://127.0.0.1)', ']', '<b>',
    '<img src=x onerror=y>', '    ', '  ', '\t', '.', ':', ' ', 'text', 'a|b', '|---|', 'end',
  ];
  const profiles = [undefined, PROSE, REASONING];
  for (let n = 0; n < 600; n += 1) {
    let text = '';
    const len = 1 + Math.floor(rnd() * 12);
    for (let i = 0; i < len; i += 1) text += pick(tokens);
    converges(text, pick(profiles), [1, 3, 8]);
  }
});
