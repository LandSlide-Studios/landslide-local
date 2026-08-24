/**
 * McpServer — the bridge that lets an MCP client (Claude, or anything else that
 * speaks the protocol) hand a piece of work to the uncensored models running on
 * this machine, without any of it leaving the machine.
 *
 * Transport is MCP's stdio transport, which is JSON-RPC 2.0 with one message per
 * line on stdin and stdout. That is the whole framing, so the protocol is spoken
 * directly here rather than through an SDK — this project installs nothing.
 *
 *   stdout is the wire. Nothing but a JSON-RPC message may ever be written to
 *   it: one stray line of human-readable output and the client is parsing a
 *   corrupt stream for the rest of the session. Every diagnostic in this file
 *   goes to stderr, which is where the client's log picks it up.
 *
 * Methods: initialize, tools/list, tools/call, ping. A JSON-RPC notification has
 * no id, and a reply to one is itself a protocol error, so notifications are
 * accepted silently. A malformed line is answered and discarded; the session
 * stays up, because the client has no way to recover from a server that exits.
 *
 * The exposed surface is three tools and stops there:
 *
 *   ask_local_model    run one prompt against a catalogued local model
 *   list_local_models  what this app ships, what is installed, what fits in VRAM
 *   search_chats       find a conversation already stored on disk
 *
 * There is deliberately no filesystem tool, no shell tool, and no way to name a
 * raw model tag. These models have had their refusal behaviour removed; the
 * honest way to expose one is to keep its reach to generating text. A caller
 * names a model by CATALOG ID or not at all, and the string it sends is looked
 * up rather than forwarded — the same guard src/api.js carries, for the same
 * reason: this machine's Ollama registry holds `dolphin-llama3:70b` at 37.22
 * GiB alongside the five catalogued models, and "the caller picks the tag" is
 * exactly how a 37 GiB model gets asked of an 8 GB card.
 */

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../util/config.js';
import * as catalog from '../core/model-catalog.js';
import { openChatStore } from '../core/store-open.js';
import { createRuntime } from '../runtime/index.js';

const SERVER_NAME = 'landslide-local';
const SERVER_VERSION = '1.0.0';

/**
 * Newest first. The client states which revision it speaks in `initialize`; we
 * answer with that one when it is a revision we know, and with our newest
 * otherwise, which is what tells the client to fall back or give up.
 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/* JSON-RPC 2.0 error codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** A "line" longer than this is a client fault, not a message. Do not buffer it. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * A generation still running after this long is not going to be useful to the
 * caller, and the client will have given up on the request anyway. The facade
 * treats an abort as a normal end, so whatever the model produced first is
 * still returned rather than thrown away.
 */
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

/** No reasoning block, so it answers in one pass — the right default for a tool. */
const DEFAULT_MODEL_ID = 'heretic-instruct-9b';

const MODEL_IDS = catalog.all().map((m) => m.id);

const config = loadConfig();
// Same folder as the app, so the same decision about how to read it. Two copies
// of that decision is how search_chats ends up reporting an empty history out of
// a folder the app is happily writing encrypted.
const { store, encrypted } = openChatStore(config);
const runtime = createRuntime(config.runtime);

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'ask_local_model',
    description:
      'Ask an uncensored Qwen 3.5 model running locally on this machine and return its answer. ' +
      'Nothing is sent over the network: no account, no API, no telemetry. Use it for work that ' +
      'must stay on the machine, or that you want answered without a hosted model in the loop. ' +
      'One prompt, one answer — this tool holds no conversation state. Reasoning is stripped; ' +
      'only the answer comes back. A local model is slower than a hosted one: the 2B and 4B ' +
      'answer in seconds, the 9B models take tens of seconds, and glm-flash-21b does not fit in ' +
      'VRAM and can take minutes. Call list_local_models if you are unsure which id to use.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The instruction or question to send. Include the full context; nothing is remembered between calls.',
        },
        model: {
          type: 'string',
          enum: MODEL_IDS,
          description: `Which catalogued model answers. Defaults to ${DEFAULT_MODEL_ID}. Ids outside this list are refused.`,
        },
        system: {
          type: 'string',
          description: 'Optional system prompt setting the role, voice or output format.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_local_models',
    description:
      'List the local models this app can run: id, size, whether the model server has it ' +
      'installed, and whether it fits in this GPU. The ids returned are the only ones ' +
      'ask_local_model accepts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_chats',
    description:
      'Search the conversations stored by this app on disk — titles and message text — and ' +
      'return the matches newest first, with a preview of each. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for. Case-insensitive substring match.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'How many matches to return. Defaults to 10.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

const IMPLEMENTATIONS = new Map([
  ['ask_local_model', askLocalModel],
  ['list_local_models', listLocalModels],
  ['search_chats', searchChats],
]);

async function askLocalModel(args) {
  const prompt = requireText(args.prompt, 'prompt');
  const system = args.system === undefined ? '' : requireText(args.system, 'system');
  const model = resolveModel(args.model);

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const result = await runtime.chat({
    // The catalog's id, always — never the caller's string. There is no field on
    // this tool that reaches the runtime as a model name.
    model: model.id,
    messages,
    // The same whitelisted, clamped options the UI sends for this model. Asking
    // for the same context and keep-alive is what stops a call through here from
    // evicting and reloading a model the app already has warm.
    options: catalog.optionsFor(model),
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
  });

  const { tokens, totalMs, tokensPerSecond } = result.stats;
  note(
    `ask_local_model ${model.id}: ${tokens} tokens in ${(totalMs / 1000).toFixed(1)}s (${tokensPerSecond} tok/s)`,
  );

  const answer = result.answer.trim();
  if (result.aborted) {
    const minutes = Math.round(ASK_TIMEOUT_MS / 60000);
    const partial = answer || '(nothing was generated before the cut-off)';
    return `${partial}\n\n[${model.id} was stopped after ${minutes} minutes. This answer is incomplete — a smaller model will finish.]`;
  }
  if (!answer) {
    return result.thinking
      ? `${model.id} produced ${result.thinking.length} characters of reasoning and no answer. Try a shorter prompt, or a model with no reasoning block.`
      : `${model.id} returned an empty answer.`;
  }
  return answer;
}

async function listLocalModels() {
  const [health, installed] = await Promise.all([runtime.health(), runtime.listModels()]);
  const models = catalog.withAvailability(installed);

  const header = health.ok
    ? `Runtime: ${health.adapter}${health.version ? ` ${health.version}` : ''}, answering.`
    : `Runtime: ${health.adapter} is NOT answering (${health.error}). Nothing can be generated until it is started.`;

  const blocks = models.map((m) => {
    const fit = catalog.fitFor(m, config.hardware.vramUsableGb);
    return [
      `${m.id} — ${m.name} · ${m.params} · ${m.quant} · ${m.sizeGb} GiB`,
      `  ${m.installed ? 'installed' : 'NOT installed'} · ${fit.verdict} on ${config.hardware.label} · ${fit.note}`,
      `  ${m.tagline} Reasoning block: ${m.thinks ? 'yes' : 'no'}.`,
    ].join('\n');
  });

  return [
    `${models.length} local models. ask_local_model accepts these ids and no others.`,
    header,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

async function searchChats(args) {
  const query = requireText(args.query, 'query');
  const limit = resolveLimit(args.limit);

  const found = await store.search(query);
  if (found.length === 0) return `No stored chat matches ${JSON.stringify(query)}.`;

  const shown = found.slice(0, limit);
  const head =
    `${found.length} chat${found.length === 1 ? '' : 's'} match ${JSON.stringify(query)}` +
    (shown.length < found.length ? `; showing the ${shown.length} most recently updated:` : ':');

  const blocks = shown.map((c) => {
    const when = String(c.updatedAt).slice(0, 16).replace('T', ' ');
    return [
      `${c.title} — ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}, updated ${when}`,
      `  id: ${c.id}${c.modelId ? ` · model: ${c.modelId}` : ''}`,
      c.preview ? `  ${c.preview}` : '  (no user message yet)',
    ].join('\n');
  });

  return [head, '', blocks.join('\n\n')].join('\n');
}

/* ------------------------------------------------------------------ */
/* Argument checking                                                   */
/* ------------------------------------------------------------------ */

/**
 * A missing or empty argument is the caller's mistake and is reported as one.
 * Guessing a default for a required field is how a tool ends up answering a
 * question nobody asked.
 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw rpcError(INVALID_PARAMS, `"${field}" is required and must be a non-empty string`);
  }
  return value;
}

/** The catalog is the only door. An id it does not know never becomes a request. */
function resolveModel(asked) {
  if (asked === undefined || asked === null || asked === '') return catalog.get(DEFAULT_MODEL_ID);
  const model = typeof asked === 'string' ? catalog.get(asked) : undefined;
  if (!model) {
    throw rpcError(
      INVALID_PARAMS,
      `refusing to run "${String(asked).slice(0, 60)}": it is not in this app's catalog. ` +
        `ask_local_model runs these ids only: ${MODEL_IDS.join(', ')}.`,
    );
  }
  return model;
}

function resolveLimit(asked) {
  if (asked === undefined || asked === null) return 10;
  const n = Number(asked);
  if (!Number.isFinite(n)) throw rpcError(INVALID_PARAMS, '"limit" must be a number');
  return Math.min(50, Math.max(1, Math.round(n)));
}

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

function send(message) {
  // JSON.stringify escapes every newline inside a string, so one message is
  // always exactly one line and the framing cannot be broken by content.
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result: result === undefined ? {} : result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

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

/* ------------------------------------------------------------------ */

function rpcError(code, message) {
  const err = new Error(message);
  err.rpcCode = code;
  return err;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Diagnostics go to stderr. stdout carries the protocol and nothing else. */
function note(text) {
  process.stderr.write(`[mcp] ${text}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) start();

export { TOOLS, dispatch, handleLine };
