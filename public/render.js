/**
 * Message rendering — the one place model output becomes DOM.
 *
 * Interface:
 *   renderText(el, fullText, profile)   build the whole message from scratch
 *   appendStream(el, fullText, chunk)   extend a message that is still arriving
 *
 * The models write markdown whether anyone asked for it or not: the instruct
 * and GAIN models answer in headings and tables, the reasoning models in nested
 * asterisk bullets. Rendering that as literal asterisks is not "safe", it is
 * just unread. So this module parses markdown itself — and holds three rules
 * while doing it.
 *
 * 1. **Model output is never HTML.** Every visible character arrives through
 *    `createTextNode` or `textContent`. No HTML string is ever handed to the
 *    DOM here, and none ever may be: an uncensored local model is untrusted
 *    input like any other. Markdown becomes elements THIS module creates: a tag
 *    the model writes is shown as text and nothing else, no attribute is ever
 *    carried over from model text, and a link whose URL is not http, https or
 *    mailto loses the URL rather than becoming clickable.
 *
 * 2. **Streamed output must equal reloaded output.** A reply that renders one
 *    way while it streams and another way after a refresh is a bug the user
 *    experiences as "it broke, then it fixed itself". Both paths run the same
 *    parser over the same text, and `appendStream` only ever takes a shortcut
 *    it can prove produces what a full parse would.
 *
 * 3. **Only the tail is ever re-rendered.** A 4,000-token reply must not
 *    rebuild a growing string 4,000 times. Two things stop that:
 *      - a hard boundary — a blank line, or the end of a closed code fence —
 *        after which nothing earlier can change meaning, so the nodes before it
 *        are kept and never looked at again;
 *      - a fast path for plain prose, which appends into the trailing text node
 *        in constant time. Only characters that can change structure
 *        (backtick, asterisk, bracket, angle, pipe, newline) cost a re-parse,
 *        and then only of the text after the last boundary.
 *
 * DOM surface used, deliberately small: document.createElement,
 * document.createTextNode, and on nodes childNodes / lastChild / textContent /
 * className / append / replaceChildren / setAttribute / appendData. Nothing else.
 */

const FENCE = '```';

/**
 * Per-element streaming state.
 *
 *   text       what the element currently shows
 *   opts       the resolved format profile it was rendered with
 *   stable     nodes for the text before `stableLen`; never rebuilt
 *   stableLen  offset of the last hard boundary
 *   sink       the trailing text node a plain chunk may be appended to
 *   fast       whether that append is provably equivalent to a re-parse
 *
 * Weak so a discarded message node is collectable.
 * @type {WeakMap<object, object>}
 */
const streams = new WeakMap();

/**
 * Characters that can change structure. Anything else may be appended to the
 * trailing text node without re-parsing: markers are only meaningful at the
 * start of a line, and no new line can start without a newline arriving.
 *
 * The pipe is here for a reason that is not obvious. A line under a table's
 * separator row joins the table the moment it contains a pipe — so a paragraph
 * that has been sitting under one can turn into a row on a single character,
 * and the reload would render it as a row.
 */
const HOT = /[`*[<|\n]/;

/**
 * Constructs a LATER chunk could complete without using a hot character:
 * `[label` needs only `](url)` after it. A block holding one is never fast.
 */
const OPEN_RISK = /[[<]/;

/** A line that cannot become a block marker no matter what is appended to it. */
const PROSE_LINE = /^[A-Za-z"'(]/;

/* ------------------------------------------------------------------ */
/* Format profiles                                                     */
/* ------------------------------------------------------------------ */

/**
 * How a model writes, not what the renderer can do. The catalog gives each
 * model one of these (see src/core/model-catalog.js); `renderText` takes it as
 * an optional third argument and falls back to the neutral set below.
 *
 * The two knobs that actually differ:
 *   listsInterruptParagraph — the instruct models drop into a bullet list with
 *     no blank line before it. A prose model doing the same is usually not a
 *     list at all: it is a line that happens to start with a dash.
 *   indentPerLevel — the reasoning models indent a sub-bullet by two spaces as
 *     often as four; a prose model that indents at all means a real four.
 */
const PROFILE_DEFAULTS = Object.freeze({
  profile: 'default',
  headings: true,
  tables: true,
  lists: true,
  listsInterruptParagraph: true,
  indentPerLevel: 2,
});

function resolveProfile(profile) {
  if (!profile || typeof profile !== 'object') return PROFILE_DEFAULTS;
  const indent = Number(profile.indentPerLevel);
  return {
    profile: typeof profile.profile === 'string' ? profile.profile : PROFILE_DEFAULTS.profile,
    headings: profile.headings !== false,
    tables: profile.tables !== false,
    lists: profile.lists !== false,
    listsInterruptParagraph: profile.listsInterruptParagraph !== false,
    indentPerLevel: Number.isFinite(indent) && indent > 0 ? indent : PROFILE_DEFAULTS.indentPerLevel,
  };
}

/* ------------------------------------------------------------------ */
/* Public interface                                                    */
/* ------------------------------------------------------------------ */

/** Build the whole message. Same parser the stream uses, so both agree. */
export function renderText(el, text, profile) {
  const full = String(text ?? '');
  const opts = resolveProfile(profile);
  const built = buildRegion(full, 0, opts);
  el.replaceChildren(...built.nodes);
  streams.set(el, {
    text: full,
    opts,
    stable: built.nodes.slice(0, built.stableCount),
    stableLen: built.boundary,
    sink: built.sink,
    fast: built.fast,
  });
}

/**
 * Extend an element that already shows `fullText` minus `chunk`.
 * Falls back to a full render whenever the fast path cannot be proven safe.
 */
export function appendStream(el, fullText, chunk) {
  const full = String(fullText ?? '');
  const added = String(chunk ?? '');
  const state = streams.get(el);

  // Length plus suffix rather than `state.text + added === full`: both strings
  // grow to the length of the whole reply, so comparing them on every token is
  // itself the quadratic cost this module exists to avoid.
  const continues =
    state && full.length === state.text.length + added.length && (added === '' || full.endsWith(added));

  if (!continues) {
    renderText(el, full, state ? state.opts : undefined);
    return;
  }

  if (state.fast && state.sink && !HOT.test(added)) {
    state.sink.appendData(added);
    state.text = full;
    return;
  }

  // Re-parse only what is after the last hard boundary.
  const built = buildRegion(full, state.stableLen, state.opts);
  el.replaceChildren(...state.stable, ...built.nodes);
  if (built.stableCount > 0) {
    state.stable = state.stable.concat(built.nodes.slice(0, built.stableCount));
  }
  state.stableLen = built.boundary;
  state.sink = built.sink;
  state.fast = built.fast;
  state.text = full;
}

/* ------------------------------------------------------------------ */
/* Regions                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse and render `full` from `from` to the end.
 *
 * @returns {{ nodes: object[], stableCount: number, boundary: number,
 *             sink: object | null, fast: boolean }}
 *   `stableCount` leading nodes are final; `boundary` is where the next region
 *   starts; `sink`/`fast` describe whether the last block can be streamed into.
 */
function buildRegion(full, from, opts) {
  const src = from > 0 ? full.slice(from) : full;
  const lines = splitLines(src);
  const blocks = parseBlocks(lines, opts);
  const boundary = lastBoundary(lines);

  const nodes = [];
  let stableCount = 0;
  let sink = null;
  let fast = false;

  for (let i = 0; i < blocks.length; i += 1) {
    const built = renderBlock(blocks[i], opts);
    nodes.push(built.node);
    const settled = blocks[i].end <= boundary;
    if (settled) stableCount = nodes.length;
    // Only the last block may be streamed into, and only while it is still
    // open and still ends where the text does. A paragraph a blank line has
    // closed must not collect the next one's words, and one that ends a line
    // early — `text\n` renders as `text` — must not swallow the newline the
    // reload would keep.
    if (i === blocks.length - 1 && !settled && blocks[i].end === src.length) {
      sink = built.sink;
      fast = built.fast;
    }
  }

  return { nodes, stableCount, boundary: from + boundary, sink, fast };
}

/** Lines with their offsets. `terminated` marks a line that ended in a newline. */
function splitLines(src) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= src.length; i += 1) {
    if (i === src.length || src[i] === '\n') {
      lines.push({ text: src.slice(start, i), start, end: i, terminated: i < src.length });
      start = i + 1;
    }
  }
  return lines;
}

/**
 * The last offset in this region that later text cannot reach back through.
 *
 * A blank line ends a block and a closing fence ends a fence — but only once
 * the line is terminated. A fence marker at the end of a stream may still turn
 * out to have words after it, which would make the line content, not a close.
 */
function lastBoundary(lines) {
  let inFence = false;
  let boundary = 0;
  for (const line of lines) {
    if (inFence) {
      if (isFenceClose(line.text)) {
        inFence = false;
        if (line.terminated) boundary = line.end + 1;
      }
      continue;
    }
    if (isFenceStart(line.text)) {
      inFence = true;
      continue;
    }
    if (line.text.trim() === '' && line.terminated) boundary = line.end + 1;
  }
  return boundary;
}

/* ------------------------------------------------------------------ */
/* Block grammar                                                       */
/* ------------------------------------------------------------------ */

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;

const isFenceStart = (t) => t.trimStart().startsWith(FENCE);
const isFenceClose = (t) => /^[ \t]*```[ \t]*$/.test(t);

function parseBlocks(lines, opts) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.text;

    if (t.trim() === '') {
      i += 1;
      continue;
    }

    if (isFenceStart(t)) {
      const body = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j += 1) {
        if (isFenceClose(lines[j].text)) {
          closed = true;
          break;
        }
        body.push(lines[j].text);
      }
      const endLine = closed ? lines[j] : lines[lines.length - 1];
      blocks.push({ kind: 'code', text: body.join('\n'), end: endLine.end });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    if (opts.headings && HEADING.test(t)) {
      const m = HEADING.exec(t);
      blocks.push({ kind: 'heading', level: m[1].length, text: m[2], end: line.end });
      i += 1;
      continue;
    }

    if (RULE.test(t)) {
      blocks.push({ kind: 'rule', end: line.end });
      i += 1;
      continue;
    }

    if (QUOTE.test(t)) {
      const inner = [];
      let j = i;
      for (; j < lines.length; j += 1) {
        const lt = lines[j].text;
        if (lt.trim() === '') break;
        if (QUOTE.test(lt)) inner.push(lt.replace(/^ {0,3}> ?/, ''));
        else if (j > i && !startsBlock(lt, lines, j, opts)) inner.push(lt);
        else break;
      }
      blocks.push({ kind: 'quote', lines: inner, end: lines[j - 1].end });
      i = j;
      continue;
    }

    const table = opts.tables ? tableAt(lines, i) : null;
    if (table) {
      blocks.push(table);
      i = table.nextLine;
      continue;
    }

    const list = opts.lists ? listAt(lines, i, opts) : null;
    if (list) {
      blocks.push(list);
      i = list.nextLine;
      continue;
    }

    const buf = [];
    let j = i;
    for (; j < lines.length; j += 1) {
      const lt = lines[j].text;
      if (lt.trim() === '') break;
      if (j > i && startsBlock(lt, lines, j, opts)) break;
      buf.push(lt);
    }
    blocks.push({ kind: 'paragraph', text: buf.join('\n'), end: lines[j - 1].end });
    i = j;
  }

  return blocks;
}

/** Would this line end the paragraph (or quote) it is sitting in? */
function startsBlock(t, lines, j, opts) {
  if (isFenceStart(t) || RULE.test(t) || QUOTE.test(t)) return true;
  if (opts.headings && HEADING.test(t)) return true;
  if (opts.tables && tableAt(lines, j)) return true;
  if (opts.lists && opts.listsInterruptParagraph && matchItem(t)) return true;
  return false;
}

/** A pipe row followed by a separator row, and the rows under it. */
function tableAt(lines, i) {
  const head = lines[i] ? lines[i].text : '';
  const sep = lines[i + 1] ? lines[i + 1].text : '';
  if (!head.includes('|') || !isSeparatorRow(sep)) return null;

  const rows = [];
  let j = i + 2;
  for (; j < lines.length; j += 1) {
    const lt = lines[j].text;
    if (lt.trim() === '' || !lt.includes('|')) break;
    rows.push(splitRow(lt));
  }
  return {
    kind: 'table',
    header: splitRow(head),
    rows,
    end: lines[j - 1].end,
    nextLine: j,
  };
}

const isSeparatorRow = (s) => /^[\s|:-]+$/.test(s) && s.includes('-') && s.includes('|');

function splitRow(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * A run of list lines. A blank line ends it, and so does a marker of the other
 * kind at the base indent — an ordered list following a bulleted one is two
 * lists, not one confused list.
 */
function listAt(lines, i, opts) {
  const first = matchItem(lines[i].text);
  if (!first) return null;

  const texts = [lines[i].text];
  let j = i + 1;
  for (; j < lines.length; j += 1) {
    const lt = lines[j].text;
    if (lt.trim() === '') break;
    const m = matchItem(lt);
    if (m) {
      if (m.indent <= first.indent && m.ordered !== first.ordered) break;
      texts.push(lt);
      continue;
    }
    if (isFenceStart(lt) || RULE.test(lt) || QUOTE.test(lt) || (opts.headings && HEADING.test(lt))) break;
    texts.push(lt); // a wrapped continuation of the item above
  }
  return { kind: 'list', lines: texts, end: lines[j - 1].end, nextLine: j };
}

function matchItem(raw) {
  const m = ITEM.exec(raw);
  if (!m) return null;
  const ordered = /\d/.test(m[2]);
  return {
    indent: indentWidth(m[1]),
    ordered,
    number: ordered ? Number.parseInt(m[2], 10) : null,
    text: m[3] ?? '',
  };
}

function indentWidth(ws) {
  let n = 0;
  for (const c of ws) n += c === '\t' ? 4 : 1;
  return n;
}

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

/** Items, nested by indent. A line with no marker is a wrap of the item above. */
function listTree(texts, opts) {
  const first = matchItem(texts[0]);
  const root = { ordered: first.ordered, indent: first.indent, start: first.number, items: [] };
  const stack = [root];
  let current = null;

  for (const raw of texts) {
    const m = matchItem(raw);
    if (!m) {
      if (current) current.text += `\n${raw.trim()}`;
      continue;
    }

    while (stack.length > 1 && m.indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];

    if (m.indent >= top.indent + opts.indentPerLevel && top.items.length > 0) {
      const parent = top.items[top.items.length - 1];
      let child = parent.children[parent.children.length - 1];
      if (!child || child.ordered !== m.ordered) {
        child = { ordered: m.ordered, indent: m.indent, start: m.number, items: [] };
        parent.children.push(child);
      }
      stack.push(child);
      top = child;
    } else if (m.ordered !== top.ordered && stack.length > 1) {
      stack.pop();
      const owner = stack[stack.length - 1].items.at(-1);
      const child = { ordered: m.ordered, indent: m.indent, start: m.number, items: [] };
      owner.children.push(child);
      stack.push(child);
      top = child;
    }

    current = { text: m.text, children: [] };
    top.items.push(current);
  }

  return root;
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

/* ------------------------------------------------------------------ */
/* Inline grammar                                                      */
/* ------------------------------------------------------------------ */

/** A tag written by the model. Matched so it can be defused, not obeyed. */
const RAW_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?:[ \t][^<>]*)?\/?>/y;

/**
 * Inline nodes for one block of text.
 *
 * @returns {{ nodes: object[], tail: object | null }} `tail` is the trailing
 *   text node when the block ends in plain text — what a stream appends into.
 */
function inlineNodes(src) {
  const nodes = [];
  let buf = '';
  let tail = null;

  const flush = () => {
    if (!buf) return;
    tail = document.createTextNode(buf);
    nodes.push(tail);
    buf = '';
  };
  const push = (node) => {
    flush();
    nodes.push(node);
    tail = null;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        const code = document.createElement('code');
        code.textContent = src.slice(i + 1, end);
        push(code);
        i = end + 1;
        continue;
      }
    } else if (c === '*') {
      const span = delimitedAt(src, i, '**') ?? delimitedAt(src, i, '*');
      if (span) {
        const el = document.createElement(span.marker === '**' ? 'strong' : 'em');
        el.append(...inlineNodes(span.inner).nodes);
        push(el);
        i = span.next;
        continue;
      }
    } else if (c === '[') {
      const link = linkAt(src, i);
      if (link) {
        push(linkElement(link));
        i = link.next;
        continue;
      }
    } else if (c === '<') {
      RAW_TAG.lastIndex = i;
      const m = RAW_TAG.exec(src);
      if (m) {
        push(inertTag(`${m[1]}${m[2]}`));
        i = RAW_TAG.lastIndex;
        continue;
      }
    }

    buf += c;
    i += 1;
  }

  flush();
  return { nodes, tail };
}

/**
 * Emphasis starting at `i`, or null.
 *
 * The delimiter must hug its content: `2 * 3 * 4` is arithmetic, and a model
 * that writes it should not have the middle of the line italicised. An
 * unterminated run stays literal — which is also what makes the streaming fast
 * path safe, since only another asterisk can ever close one.
 */
function delimitedAt(src, i, marker) {
  if (!src.startsWith(marker, i)) return null;
  const from = i + marker.length;
  const end = src.indexOf(marker, from);
  if (end === -1) return null;
  const inner = src.slice(from, end);
  if (!inner || /^\s/.test(inner) || /\s$/.test(inner)) return null;
  return { marker, inner, next: end + marker.length };
}

/** A `[label](url)` starting at `i`, or null. */
function linkAt(src, i) {
  const close = src.indexOf(']', i + 1);
  if (close === -1 || src[close + 1] !== '(') return null;
  const end = src.indexOf(')', close + 2);
  if (end === -1) return null;
  return {
    label: src.slice(i + 1, close),
    url: src.slice(close + 2, end),
    next: end + 1,
  };
}

/**
 * A link the page is willing to follow, or null.
 *
 * Anything with a scheme that is not http, https or mailto is refused outright:
 * `javascript:` is the obvious one, but `data:` and `file:` are no better
 * coming from a model. Anything that is not printable ASCII is refused with it,
 * so a scheme cannot be smuggled through a tab, a newline or a lookalike.
 */
function safeUrl(raw) {
  const url = String(raw).trim();
  if (!url || !/^[!-~]+$/.test(url)) return null;
  if (url.startsWith('#')) return url;
  if (url.startsWith('/')) return url.slice(0, 2) === '//' ? null : url;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return /^(?:https?|mailto):/i.test(url) ? url : null;
  return url;
}

function linkElement(link) {
  const url = safeUrl(link.url);
  const label = inlineNodes(link.label || url || '').nodes;
  if (!url) {
    // No URL survives. The label still reads, and the refused target is not
    // written anywhere the DOM could act on.
    const span = document.createElement('span');
    span.append(...label);
    return span;
  }
  const a = document.createElement('a');
  a.append(...label);
  a.setAttribute('href', url);
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noreferrer noopener');
  return a;
}

/**
 * A tag the model wrote, shown as text and nothing else.
 *
 * The name sits in its own element between two bracket text nodes: that is what
 * lets the chip style the name, and it means no serialisation of this subtree
 * ever contains a complete tag. Attributes are dropped rather than displayed —
 * an onerror= payload is not information the reader needs, and keeping it would
 * put an event handler's text back on the page for the next tool to copy.
 */
function inertTag(name) {
  const chip = document.createElement('code');
  chip.className = 'raw-tag';
  const label = document.createElement('span');
  label.textContent = name;
  chip.append(document.createTextNode('<'), label, document.createTextNode('>'));
  return chip;
}
