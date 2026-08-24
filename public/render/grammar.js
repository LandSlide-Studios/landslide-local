/**
 * The block grammar: lines in, block descriptors out. No DOM at all.
 *
 * A block descriptor says what a run of lines IS — a fence, a heading, a table,
 * a list, a paragraph — and where it ends, so the streaming layer can tell
 * which nodes are settled and which are still growing. Turning one into
 * elements is `blocks.js`; this file never touches `document`, which is what
 * makes the parsing testable on its own and keeps the two failure modes apart.
 *
 * `lastBoundary` is the other half of the streaming contract: the last offset
 * that later text cannot reach back through, so everything before it is final.
 */

const FENCE = '```';

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

export { FENCE, HEADING, ITEM, QUOTE, RULE, indentWidth, isFenceClose, isFenceStart, lastBoundary, listAt, listTree, matchItem, parseBlocks, splitLines, splitRow, startsBlock, tableAt };
