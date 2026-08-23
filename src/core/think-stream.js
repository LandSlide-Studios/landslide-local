/**
 * ThinkStream — separates reasoning blocks from answer text in a token stream.
 *
 * Interface:
 *   const s = createThinkStream({ openTag, closeTag, startInThink })
 *   s.feed(chunk) -> Event[]     Event = { type: 'think' | 'answer', text }
 *   s.end()       -> Event[]     flushes anything held back
 *   s.state       -> 'think' | 'answer'
 *
 * Guarantees:
 *   - Tags split across arbitrary chunk boundaries are handled. A suffix that
 *     could still become a tag is held back rather than mis-emitted.
 *   - Never emits a zero-length event.
 *   - Concatenating all emitted text of both types, plus the tags, reproduces
 *     the input exactly.
 */

const DEFAULT_OPEN = '<think>';
const DEFAULT_CLOSE = '</think>';

/** Longest suffix of `buf` that is a proper prefix of `tag`. */
function danglingPrefixLength(buf, tag) {
  const max = Math.min(buf.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

export function createThinkStream(opts = {}) {
  const openTag = opts.openTag ?? DEFAULT_OPEN;
  const closeTag = opts.closeTag ?? DEFAULT_CLOSE;
  let state = opts.startInThink ? 'think' : 'answer';
  let buf = '';

  function drain(flush) {
    const events = [];
    for (;;) {
      const tag = state === 'think' ? closeTag : openTag;
      const idx = buf.indexOf(tag);
      if (idx !== -1) {
        if (idx > 0) events.push({ type: state, text: buf.slice(0, idx) });
        buf = buf.slice(idx + tag.length);
        state = state === 'think' ? 'answer' : 'think';
        continue;
      }
      // No complete tag. Emit everything except a possible partial tag tail.
      const hold = flush ? 0 : danglingPrefixLength(buf, tag);
      const emit = buf.slice(0, buf.length - hold);
      if (emit) events.push({ type: state, text: emit });
      buf = buf.slice(buf.length - hold);
      return events;
    }
  }

  return {
    feed(chunk) {
      if (!chunk) return [];
      buf += chunk;
      return drain(false);
    },
    end() {
      return drain(true);
    },
    get state() {
      return state;
    },
  };
}

/** Convenience for non-streaming callers. */
export function splitThinking(text, opts = {}) {
  const s = createThinkStream(opts);
  const events = [...s.feed(text), ...s.end()];
  let think = '';
  let answer = '';
  for (const e of events) {
    if (e.type === 'think') think += e.text;
    else answer += e.text;
  }
  return { think, answer };
}
