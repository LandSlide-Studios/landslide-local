/**
 * ACCEPTANCE — I8 Per-model output formatting.
 *
 * Authored before the implementation. Locked; not the builder's to edit.
 *
 * The models write differently: one is claimed to be sharpest at tables and
 * structure, another writes prose, and the reasoning models emit markdown lists
 * and bold headers. Today all of that arrives as literal asterisks. This suite
 * defines what "formatted" has to mean, and pins the rule that model output is
 * still never inserted as HTML.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ */
/* Minimal DOM shim — deliberately small. render.js may use only this. */
/* ------------------------------------------------------------------ */

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
      const cls = this.className ? ` class="${this.className}"` : '';
      return `<${this.tagName.toLowerCase()}${cls}>${this.childNodes.map((c) => c.serialize()).join('')}</${this.tagName.toLowerCase()}>`;
    },
    tags() {
      const out = [this.tagName];
      for (const c of this.childNodes) if (c.nodeType === ELEMENT) out.push(...c.tags());
      return out;
    },
  });

  return { Node: { TEXT_NODE: TEXT, ELEMENT_NODE: ELEMENT }, document: { createElement: mkEl, createTextNode: mkText }, mkEl };
}

async function loadRender() {
  const dom = makeDom();
  globalThis.document = dom.document;
  globalThis.Node = dom.Node;
  const mod = await import('../../public/render.js');
  return { ...mod, mkEl: dom.mkEl };
}

const render = async (text, profile) => {
  const { renderText, mkEl } = await loadRender();
  const el = mkEl('div');
  renderText(el, text, profile);
  return el;
};

/* ------------------------------------------------------------------ */
/* A. Markdown actually becomes elements                                */
/* ------------------------------------------------------------------ */

test('I8-A1: bold and italic become elements, not literal asterisks', async () => {
  const el = await render('This is **bold** and this is *italic*.');
  const html = el.serialize();
  assert.ok(/<strong>bold<\/strong>/.test(html), `expected <strong>, got: ${html}`);
  assert.ok(/<em>italic<\/em>/.test(html), `expected <em>, got: ${html}`);
  assert.ok(!el.textContent.includes('**'), 'asterisks must not survive as visible text');
});

test('I8-A2: headings become heading elements', async () => {
  const el = await render('# Title\n\n## Section\n\n### Sub\n\nbody text');
  const tags = el.tags();
  assert.ok(tags.includes('H1'), 'a # line must render as a heading');
  assert.ok(tags.includes('H2'));
  assert.ok(tags.includes('H3'));
  assert.ok(!el.textContent.includes('# '), 'hashes must not survive as visible text');
});

test('I8-A3: unordered lists become ul/li', async () => {
  const el = await render('Reasons:\n\n- first\n- second\n- third\n');
  const tags = el.tags();
  assert.ok(tags.includes('UL'), 'expected a <ul>');
  assert.equal(tags.filter((t) => t === 'LI').length, 3, 'expected three <li>');
  assert.ok(el.textContent.includes('first'));
});

test('I8-A4: ordered lists become ol/li and keep their text', async () => {
  const el = await render('Steps:\n\n1. split it\n2. multiply\n3. add\n');
  const tags = el.tags();
  assert.ok(tags.includes('OL'), 'expected an <ol>');
  assert.equal(tags.filter((t) => t === 'LI').length, 3);
  assert.ok(!/^\s*1\./m.test(el.textContent), 'the "1." marker must not remain as text');
});

test('I8-A5: the asterisk-bullet style the reasoning models emit is handled', async () => {
  // This is verbatim the shape Deckard produced in a real run.
  const el = await render('Thinking Process:\n\n1.  **Analyze the Request:**\n    *   Topic: A rainstorm.\n    *   Format: One vivid sentence.\n');
  assert.ok(!el.textContent.includes('**'), 'bold markers must not survive');
  assert.ok(!el.textContent.includes('*   '), 'asterisk bullets must not survive as text');
  const tags = el.tags();
  assert.ok(tags.includes('LI'), 'the nested bullets must become list items');
});

test('I8-A6: markdown tables become a real table', async () => {
  const md = [
    '| Model | Size | Speed |',
    '|---|---|---|',
    '| Deckard | 2.52 | 107 |',
    '| Auto | 1.19 | 125 |',
  ].join('\n');
  const el = await render(md);
  const tags = el.tags();
  assert.ok(tags.includes('TABLE'), 'expected a <table>');
  assert.ok(tags.includes('TH'), 'expected header cells');
  assert.equal(tags.filter((t) => t === 'TR').length, 3, 'header plus two body rows');
  assert.ok(!el.textContent.includes('|---'), 'the separator row must not be visible');
});

test('I8-A7: blockquotes and horizontal rules render', async () => {
  const el = await render('> a quotation\n\n---\n\nafter');
  const tags = el.tags();
  assert.ok(tags.includes('BLOCKQUOTE'), 'expected a <blockquote>');
  assert.ok(tags.includes('HR'), 'expected an <hr>');
});

test('I8-A8: fenced code still wins over markdown inside it', async () => {
  const el = await render('```js\nconst a = **not bold**;\n# not a heading\n```');
  const html = el.serialize();
  assert.ok(/<pre><code>/.test(html), 'fenced code must still be a code block');
  assert.ok(el.textContent.includes('**not bold**'), 'markdown inside code is literal');
  assert.ok(!/<strong>/.test(html), 'no markdown parsing inside a fence');
});

test('I8-A9: inline code inside a paragraph still works alongside markdown', async () => {
  const el = await render('Use **`reduce`** for that.');
  const html = el.serialize();
  assert.ok(/<code>reduce<\/code>/.test(html), 'inline code must survive');
  assert.ok(/<strong>/.test(html), 'and the emphasis around it');
});

/* ------------------------------------------------------------------ */
/* B. Safety — the rule that must not be traded away for prettiness     */
/* ------------------------------------------------------------------ */

test('I8-B1: HTML in model output is shown as text, never executed', async () => {
  const nasty = 'Hello <script>alert(1)</script> and <img src=x onerror=alert(2)> done';
  const el = await render(nasty);
  const html = el.serialize();
  assert.ok(!/<script>/i.test(html), 'a script tag must never reach the DOM as an element');
  assert.ok(!/onerror/i.test(html), 'no event-handler attribute may survive');
  assert.ok(el.textContent.includes('<script>'), 'it should be visible as literal text instead');
});

test('I8-B2: a markdown link does not become a javascript: navigation', async () => {
  const el = await render('[click me](javascript:alert(1))');
  const html = el.serialize();
  assert.ok(!/javascript:/i.test(html), 'javascript: URLs must not survive into an href');
});

test('I8-B3: render.js never uses innerHTML', async () => {
  const { promises: fs } = await import('node:fs');
  const src = await fs.readFile(new URL('../../public/render.js', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), 'no HTML injection API may appear');
});

/* ------------------------------------------------------------------ */
/* C. Per-model format profiles                                         */
/* ------------------------------------------------------------------ */

test('I8-C1: every catalog model declares a format profile', async () => {
  const catalog = await import('../../src/core/model-catalog.js');
  for (const m of catalog.all()) {
    assert.ok(m.format, `${m.id} must declare a format profile`);
    assert.equal(typeof m.format.profile, 'string', `${m.id}.format.profile must be a name`);
  }
});

test('I8-C2: the profiles are not all identical — they describe how each model writes', async () => {
  const catalog = await import('../../src/core/model-catalog.js');
  const profiles = new Set(catalog.all().map((m) => m.format.profile));
  assert.ok(profiles.size > 1, 'if every model gets the same profile the feature is decorative');
});

test('I8-C3: a prose profile does not mangle a paragraph into list items', async () => {
  const catalog = await import('../../src/core/model-catalog.js');
  const deckard = catalog.get('deckard-4b');
  const el = await render(
    'The sky tore open overhead, hurling a torrent that hammered the pavement.',
    deckard.format,
  );
  const tags = el.tags();
  assert.ok(!tags.includes('UL') && !tags.includes('OL'), 'plain prose must stay prose');
  assert.ok(el.textContent.startsWith('The sky tore open'));
});

test('I8-C4: a structured profile still renders a table', async () => {
  const catalog = await import('../../src/core/model-catalog.js');
  const coldFusion = catalog.get('cold-fusion-9b');
  const el = await render('| a | b |\n|---|---|\n| 1 | 2 |', coldFusion.format);
  assert.ok(el.tags().includes('TABLE'), 'the table-strong model must render tables');
});

test('I8-C5: the API exposes the format profile so the UI can use it', async () => {
  const catalog = await import('../../src/core/model-catalog.js');
  const withAvail = catalog.withAvailability([]);
  assert.ok(withAvail[0].format, 'format must survive withAvailability()');
});

/* ------------------------------------------------------------------ */
/* D. Streaming still agrees with one-shot                              */
/* ------------------------------------------------------------------ */

const STREAM_CASES = [
  ['markdown list', 'Reasons:\n\n- alpha\n- beta\n'],
  ['heading and bold', '# Title\n\nSome **bold** text.'],
  ['table', '| a | b |\n|---|---|\n| 1 | 2 |'],
  ['mixed', '## Head\n\n- one\n- two\n\n```js\nx\n```\n\nAfter **that**.'],
];

for (const [name, text] of STREAM_CASES) {
  test(`I8-D (${name}): streamed markdown converges on the one-shot rendering`, async () => {
    const { renderText, appendStream, mkEl } = await loadRender();
    const oneShot = mkEl('div');
    renderText(oneShot, text);

    for (const size of [1, 5, 25]) {
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
        `chunk size ${size}: the finished stream must match a reload`,
      );
    }
  });
}
