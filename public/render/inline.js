/**
 * The inline grammar: what happens INSIDE one block of text.
 *
 * Code spans, emphasis, links and the tags a model writes — turned into nodes
 * this module creates, never into markup. `inlineNodes` also reports the
 * trailing text node it produced, which is what lets the streaming layer append
 * a plain chunk in constant time instead of re-parsing the block.
 *
 * Rule 1 of render.js applies here more than anywhere: every visible character
 * arrives through `createTextNode` or `textContent`, no attribute is ever
 * carried over from model text, and a link whose URL is not http, https or
 * mailto loses the URL rather than becoming clickable.
 *
 * DOM surface: document.createElement, document.createTextNode, and on nodes
 * append / textContent / className / setAttribute. Nothing else.
 */


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

export { inlineNodes };
