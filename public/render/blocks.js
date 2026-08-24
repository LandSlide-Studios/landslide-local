/**
 * Block descriptors -> DOM.
 *
 * The grammar next door decides WHAT a run of lines is; this decides what it
 * looks like as nodes. The split is worth having because the two change for
 * different reasons: a parsing bug is a question about markdown, and a
 * rendering bug is a question about the DOM the app expects.
 *
 * `renderBlock` also answers the streaming layer's question — can a chunk be
 * appended to this block's trailing text node without re-parsing? Only a
 * paragraph can, and only when nothing half-open sits earlier in it.
 *
 * DOM surface: document.createElement, and on nodes append / textContent /
 * setAttribute. Nothing else.
 */

import { inlineNodes } from './inline.js';
import { listTree, parseBlocks, splitLines } from './grammar.js';

/**
 * Constructs a LATER chunk could complete without using a hot character:
 * `[label` needs only `](url)` after it. A block holding one is never fast.
 */
const OPEN_RISK = /[[<]/;

/** A line that cannot become a block marker no matter what is appended to it. */
const PROSE_LINE = /^[A-Za-z"'(]/;

/* ------------------------------------------------------------------ */
/* Block rendering                                                     */
/* ------------------------------------------------------------------ */

/** @returns {{ node: object, sink: object | null, fast: boolean }} */
function renderBlock(block, opts) {
  if (block.kind === 'code') {
    const code = document.createElement('code');
    code.textContent = block.text;
    const pre = document.createElement('pre');
    pre.append(code);
    return { node: pre, sink: null, fast: false };
  }

  if (block.kind === 'heading') {
    const h = document.createElement(`h${Math.min(block.level, 6)}`);
    h.append(...inlineNodes(block.text).nodes);
    return { node: h, sink: null, fast: false };
  }

  if (block.kind === 'rule') {
    return { node: document.createElement('hr'), sink: null, fast: false };
  }

  if (block.kind === 'quote') {
    const quote = document.createElement('blockquote');
    for (const inner of parseBlocks(splitLines(block.lines.join('\n')), opts)) {
      quote.append(renderBlock(inner, opts).node);
    }
    return { node: quote, sink: null, fast: false };
  }

  if (block.kind === 'table') {
    return { node: renderTable(block), sink: null, fast: false };
  }

  if (block.kind === 'list') {
    return { node: listElement(listTree(block.lines, opts)), sink: null, fast: false };
  }

  const p = document.createElement('p');
  const inline = inlineNodes(block.text);
  p.append(...inline.nodes);
  // The fast path needs three things: somewhere to append (a trailing text
  // node), no half-open construct earlier in the block that plain text could
  // complete, and a current line that can never become a marker line.
  const fast =
    inline.tail !== null && !OPEN_RISK.test(block.text) && PROSE_LINE.test(lastLineOf(block.text));
  return { node: p, sink: inline.tail, fast };
}

function lastLineOf(text) {
  const nl = text.lastIndexOf('\n');
  return nl === -1 ? text : text.slice(nl + 1);
}

function renderTable(block) {
  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const cell of block.header) {
    const th = document.createElement('th');
    th.append(...inlineNodes(cell).nodes);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const row of block.rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.append(...inlineNodes(cell).nodes);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function listElement(list) {
  const el = document.createElement(list.ordered ? 'ol' : 'ul');
  // A blank line between items ends the list, so a step list written with gaps
  // arrives here as several lists. Without the start number every one of them
  // would restart at 1, and a model that numbers from 4 would be renumbered.
  if (list.ordered && Number.isFinite(list.start) && list.start !== 1) {
    el.setAttribute('start', String(list.start));
  }
  for (const item of list.items) {
    const li = document.createElement('li');
    li.append(...inlineNodes(item.text).nodes);
    for (const child of item.children) li.append(listElement(child));
    el.append(li);
  }
  return el;
}

export { renderBlock };
