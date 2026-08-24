/**
 * Message rendering — the one place model output becomes DOM.
 *
 * Interface:
 *   renderText(el, fullText)            build the whole message from scratch
 *   appendStream(el, fullText, chunk)   extend a message that is still arriving
 *
 * Two rules this module exists to hold:
 *
 * 1. **Model output is never HTML.** Everything here is `createTextNode` and
 *    `textContent`. An uncensored local model is untrusted input like any other.
 *
 * 2. **Streamed output must equal reloaded output.** The same reply rendering
 *    one way while it streams and another way after a refresh is a bug the user
 *    experiences as "it broke, then it fixed itself". `appendStream` therefore
 *    never guesses: it appends only into a sink it can prove is still open, and
 *    falls back to a full `renderText` for anything else.
 *
 * Why not just re-render on every chunk: a 4,000-token reply would rebuild a
 * growing string 4,000 times. So plain text — the overwhelming majority of a
 * reply, inside a code fence or outside it — is appended to the trailing text
 * node in constant time. Only backticks, which can change the structure, cost
 * a rebuild.
 *
 * DOM surface used, deliberately small: document.createElement,
 * document.createTextNode, Node.TEXT_NODE, and on nodes childNodes / lastChild /
 * textContent / append / replaceChildren / appendData. Nothing else.
 */

const FENCE = '```';

/**
 * Per-element streaming state: what text the element currently shows, and where
 * the next plain chunk belongs. Weak so a discarded message node is collectable.
 * @type {WeakMap<object, { text: string, sink: object | null }>}
 */
const streams = new WeakMap();

/** Fenced and inline code only, all built from text nodes. Never innerHTML. */
export function renderText(el, text) {
  const full = String(text ?? '');
  el.replaceChildren();

  const parts = full.split(FENCE);
  const last = parts.length - 1;
  let sink = el; // where a following plain chunk would belong

  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const unterminated = i === last;
      const code = document.createElement('code');
      code.textContent = fenceBody(part, unterminated);
      const pre = document.createElement('pre');
      pre.append(code);
      el.append(pre);
      // An unterminated fence is still being written into, so the next plain
      // chunk belongs inside this <code> — but only once the language line has
      // ended. Before that we cannot tell a tag from content.
      if (unterminated) sink = part.includes('\n') ? code : null;
    } else {
      const openInline = appendInline(el, part);
      if (i === last) sink = openInline ? null : el;
    }
  });

  streams.set(el, { text: full, sink });
}

/**
 * Extend an element that already shows `fullText` minus `chunk`.
 * Falls back to a full render whenever the fast path cannot be proven safe.
 */
export function appendStream(el, fullText, chunk) {
  const full = String(fullText ?? '');
  const added = String(chunk ?? '');
  const state = streams.get(el);

  const canAppend =
    state &&
    state.sink &&
    !added.includes('`') && // a backtick can open or close a span; structure may change
    state.text + added === full; // the element really is one chunk behind

  if (!canAppend) {
    renderText(el, full);
    return;
  }

  appendPlain(state.sink, added);
  state.text = full;
}

/* ------------------------------------------------------------------ */

/**
 * The text of a fenced block, with its language line removed.
 *
 * While a fence is still open and no newline has arrived yet, everything after
 * the ``` is a language tag in progress — rendering it would show "py" inside
 * the code box for a moment and leave it there forever if the stream stopped
 * at that point (Stop pressed, num_predict reached).
 */
function fenceBody(part, unterminated) {
  if (unterminated && !part.includes('\n')) return '';
  return part.replace(/^[a-zA-Z0-9+-]*\n/, '');
}

/** @returns {boolean} true when the text ends inside an unclosed inline span. */
function appendInline(el, text) {
  const chunks = String(text).split('`');
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const code = document.createElement('code');
      code.textContent = chunk;
      el.append(code);
    } else if (chunk) {
      el.append(document.createTextNode(chunk));
    }
  });
  return chunks.length % 2 === 0; // an even number of pieces means an odd number of backticks
}

function appendPlain(node, text) {
  if (!text) return;
  const last = node.lastChild;
  if (last && last.nodeType === Node.TEXT_NODE) last.appendData(text);
  else node.append(document.createTextNode(text));
}
