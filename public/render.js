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
 * This file owns rule 2 and rule 3 — the streaming contract. The parsing it
 * runs lives beside it, one file per question, because at 700 lines nobody
 * opened this to read the streaming logic without scrolling through a markdown
 * parser first:
 *
 *   render/grammar.js   lines -> block descriptors. No DOM at all.
 *   render/blocks.js    a block descriptor -> nodes.
 *   render/inline.js    what happens inside one block: code, emphasis, links,
 *                       and the tags a model writes, defused.
 *
 * They are this module's own internals, not a second door into the DOM: nothing
 * else imports them, and rule 1 binds all four files identically.
 *
 * DOM surface used, deliberately small: document.createElement,
 * document.createTextNode, and on nodes childNodes / lastChild / textContent /
 * className / append / replaceChildren / setAttribute / appendData. Nothing else.
 */

import { renderBlock } from './render/blocks.js';
import { lastBoundary, parseBlocks, splitLines } from './render/grammar.js';

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
