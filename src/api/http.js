/**
 * The HTTP plumbing every route module shares — and the only thing in `src/api/`
 * that knows what a `res` is beyond writing to it.
 *
 * Reading a body, writing a JSON answer, opening an SSE stream and turning a
 * failure into a status code are the four things every route needed and none of
 * them wanted to own. Keeping them here is what lets a route module read as
 * "call one thing, return a value".
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** A client mistake is not a server fault; report it as one of theirs. */
export function statusForCode(code) {
  if (code === 'ENOTFOUND_CHAT') return 404;
  if (code === 'EINVALID_ID') return 400;
  return 500;
}

export function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Open a Server-Sent Events stream and return the function that writes one
 * event onto it. Writing after the response has ended is a no-op rather than a
 * throw: an aborted generation still has a few frames in flight behind it.
 */
export function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  return (event) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

const MAX_BODY = 4 * 1024 * 1024;

export function readJson(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export { JSON_HEADERS, MAX_BODY };
