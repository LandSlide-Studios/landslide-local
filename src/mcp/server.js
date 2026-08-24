/**
 * McpServer — the bridge that lets an MCP client (Claude, or anything else that
 * speaks the protocol) hand a piece of work to the uncensored models running on
 * this machine, without any of it leaving the machine.
 *
 * Transport is MCP's stdio transport, which is JSON-RPC 2.0 with one message per
 * line on stdin and stdout. That is the whole framing, so the protocol is spoken
 * directly here rather than through an SDK — this project installs nothing.
 *
 * This file is the transport and the method table. What the server actually
 * OFFERS is next door:
 *
 *   src/mcp/tools.js      the three tools, their schemas and what they do
 *   src/mcp/protocol.js   JSON-RPC codes, and the stdout/stderr split
 *   src/mcp/context.js    config, chat store and runtime, opened once
 *
 * Methods: initialize, tools/list, tools/call, ping. A JSON-RPC notification has
 * no id, and a reply to one is itself a protocol error, so notifications are
 * accepted silently. A malformed line is answered and discarded; the session
 * stays up, because the client has no way to recover from a server that exits.
 */

import { pathToFileURL } from 'node:url';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  isPlainObject,
  note,
  rpcError,
  sendError,
  sendResult,
} from './protocol.js';
import { IMPLEMENTATIONS, TOOLS } from './tools.js';
import { config, encrypted } from './context.js';

const SERVER_NAME = 'landslide-local';
const SERVER_VERSION = '1.0.0';

/**
 * Newest first. The client states which revision it speaks in `initialize`; we
 * answer with that one when it is a revision we know, and with our newest
 * otherwise, which is what tells the client to fall back or give up.
 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** A "line" longer than this is a client fault, not a message. Do not buffer it. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* JSON-RPC methods                                                    */
/* ------------------------------------------------------------------ */

const METHODS = new Map([
  ['initialize', initialize],
  ['ping', () => ({})],
  ['tools/list', () => ({ tools: TOOLS })],
  ['tools/call', callTool],
]);

function initialize(params) {
  const asked = params?.protocolVersion;
  const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
  note(`initialize from ${params?.clientInfo?.name ?? 'an unnamed client'} (protocol ${asked ?? 'unstated'})`);
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      'Three tools onto the uncensored models on this machine. Nothing leaves it. ' +
      'ask_local_model runs one prompt; list_local_models says which ids exist and which are ' +
      'installed; search_chats reads the local chat history.',
  };
}

/**
 * Two different failures, reported two different ways, because a client and a
 * model need different things from them.
 *
 * A bad call — unknown tool, missing or invalid argument — is a JSON-RPC error:
 * the request was never valid and nothing ran. A tool that ran and failed (the
 * model server is down, a chat file is unreadable) comes back as a normal result
 * carrying isError, so the model on the other end can read what went wrong and
 * choose differently instead of the client swallowing it.
 */
async function callTool(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (!isPlainObject(args)) throw rpcError(INVALID_PARAMS, '"arguments" must be an object');

  const run = typeof name === 'string' ? IMPLEMENTATIONS.get(name) : undefined;
  if (!run) {
    throw rpcError(
      INVALID_PARAMS,
      `unknown tool: ${JSON.stringify(name ?? null)}. This server exposes ${[...IMPLEMENTATIONS.keys()].join(', ')}.`,
    );
  }

  try {
    return { content: [{ type: 'text', text: await run(args) }] };
  } catch (err) {
    if (err?.rpcCode === INVALID_PARAMS) throw err;
    const message = String(err?.message ?? err);
    note(`${name} failed: ${message}`);
    return { content: [{ type: 'text', text: `${name} failed: ${message}` }], isError: true };
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function dispatch(message) {
  if (!isPlainObject(message)) {
    sendError(null, INVALID_REQUEST, 'a JSON-RPC message must be an object');
    return;
  }

  // No id means a notification: it gets no reply, whatever happens to it.
  const isNotification = message.id === undefined;
  const id = message.id ?? null;

  if (typeof message.method !== 'string') {
    // A response to a request we never sent, or a malformed request. Neither is
    // answerable; only the second is worth an error.
    if (!isNotification && !('result' in message) && !('error' in message)) {
      sendError(id, INVALID_REQUEST, 'a JSON-RPC request must carry a "method" string');
    }
    return;
  }

  const handler = METHODS.get(message.method);
  if (!handler) {
    // notifications/initialized, notifications/cancelled and friends land here
    // and are correctly ignored.
    if (!isNotification) sendError(id, METHOD_NOT_FOUND, `unknown method: ${message.method}`);
    else note(`ignoring notification: ${message.method}`);
    return;
  }

  try {
    const result = await handler(message.params ?? {});
    if (!isNotification) sendResult(id, result);
  } catch (err) {
    const code = err?.rpcCode ?? INTERNAL_ERROR;
    const detail = String(err?.message ?? err);
    note(`${message.method} errored: ${detail}`);
    if (!isNotification) sendError(id, code, detail);
  }
}

/**
 * One line in, one message handled. A line that is not JSON is answered with a
 * parse error and dropped: the client owns the stream and can carry on, and a
 * server that exited on a junk byte would take every in-flight call with it.
 */
function handleLine(raw) {
  const line = raw.trim();
  if (!line) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (err) {
    note(`ignoring unparseable line (${line.length} bytes): ${err.message}`);
    sendError(null, PARSE_ERROR, `invalid JSON: ${err.message}`);
    return;
  }

  if (Array.isArray(message)) {
    sendError(null, INVALID_REQUEST, 'batched requests are not supported');
    return;
  }

  // Calls are not serialised: a long generation must not stop tools/list from
  // answering, and the client matches replies by id in any order.
  inFlight += 1;
  dispatch(message)
    .catch((err) => note(`dispatch failed: ${String(err?.message ?? err)}`))
    .finally(() => {
      inFlight -= 1;
      exitWhenDrained();
    });
}

/**
 * Closing stdin is how a stdio server is told to stop, but exiting the instant
 * it closes throws away every reply still being computed. A client that shuts
 * down mid-call would get silence, and the obvious way to try this server by
 * hand — piping three lines into it — closes stdin before the first answer
 * exists, so it would have printed nothing at all. Stop reading, finish what
 * was asked, then leave. Every call is bounded by its own timeout, so "finish"
 * always arrives.
 */
let inFlight = 0;
let stdinEnded = false;

function exitWhenDrained() {
  if (stdinEnded && inFlight === 0) process.exit(0);
}

function start() {
  process.stdin.setEncoding('utf8');

  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = '';
      sendError(null, PARSE_ERROR, `message exceeded ${MAX_LINE_BYTES} bytes without a newline`);
    }
  });

  process.stdin.on('end', () => {
    stdinEnded = true;
    exitWhenDrained();
  });
  process.stdin.on('error', (err) => {
    note(`stdin error: ${err.message}`);
    process.exit(0);
  });

  // A client that vanishes mid-write must not turn into an unhandled crash.
  process.stdout.on('error', () => process.exit(0));

  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));

  note(
    `${SERVER_NAME} ${SERVER_VERSION} on stdio — adapter ${config.runtime.adapter}, ` +
      `chats ${config.storage.chatsDir}${encrypted ? ' (encrypted)' : ''}`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) start();

export { TOOLS, dispatch, handleLine };
