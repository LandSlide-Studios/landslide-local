/**
 * JSON-RPC 2.0 as this server speaks it: the error codes, the two ways of
 * writing to the wire, and the one rule that governs both.
 *
 *   stdout is the wire. Nothing but a JSON-RPC message may ever be written to
 *   it: one stray line of human-readable output and the client is parsing a
 *   corrupt stream for the rest of the session. Every diagnostic goes to
 *   stderr, which is where the client's log picks it up. That is why `note()`
 *   lives beside `send()` rather than anywhere more convenient — the two are a
 *   pair, and the only reason the pair exists is to make the wrong one hard to
 *   reach for.
 */

/* JSON-RPC 2.0 error codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function send(message) {
  // JSON.stringify escapes every newline inside a string, so one message is
  // always exactly one line and the framing cannot be broken by content.
  process.stdout.write(JSON.stringify(message) + '\n');
}

export function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result: result === undefined ? {} : result });
}

export function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

export function rpcError(code, message) {
  const err = new Error(message);
  err.rpcCode = code;
  return err;
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Diagnostics go to stderr. stdout carries the protocol and nothing else. */
export function note(text) {
  process.stderr.write(`[mcp] ${text}\n`);
}
