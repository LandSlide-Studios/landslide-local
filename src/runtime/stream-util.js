/**
 * Shared stream plumbing for the runtime adapters.
 *
 * `lines`  — yields complete newline-delimited strings from a byte stream,
 *            joining chunks that split a line in half.
 * `sseData`— yields the payload of `data:` frames from a Server-Sent Events
 *            stream, stopping at the `[DONE]` sentinel.
 *
 * Both tolerate the stream being aborted mid-frame; a partial trailing line is
 * emitted only if it is non-empty at end of stream.
 */

const decoder = () => new TextDecoder('utf-8');

export async function* lines(body, signal) {
  if (!body) return;
  const dec = decoder();
  let buf = '';
  for await (const chunk of body) {
    if (signal?.aborted) return;
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  buf += dec.decode();
  const tail = buf.trim();
  if (tail) yield tail;
}

export async function* sseData(body, signal) {
  for await (const line of lines(body, signal)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') return;
    yield payload;
  }
}
