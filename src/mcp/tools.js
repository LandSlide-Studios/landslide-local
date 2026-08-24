/**
 * The three tools this MCP server exposes, and what they do.
 *
 * Kept apart from the transport in `server.js` on purpose: the JSON-RPC framing
 * is fixed and boring, the tool surface is the part anyone will ever want to
 * read or argue with, and mixing them meant scrolling past a line-buffered
 * stdin reader to find out what `ask_local_model` actually sends.
 *
 *   ask_local_model    run one prompt against a catalogued local model
 *   list_local_models  what this app ships, what is installed, what fits in VRAM
 *   search_chats       find a conversation already stored on disk
 *
 * There is deliberately no filesystem tool, no shell tool, and no way to name a
 * raw model tag. These models have had their refusal behaviour removed; the
 * honest way to expose one is to keep its reach to generating text. A caller
 * names a model by CATALOG ID or not at all, and the string it sends is looked
 * up rather than forwarded — the same guard `src/api/catalog-guard.js` carries,
 * for the same reason: this machine's Ollama registry holds `dolphin-llama3:70b`
 * at 37.22 GiB alongside the five catalogued models, and "the caller picks the
 * tag" is exactly how a 37 GiB model gets asked of an 8 GB card.
 */

import * as catalog from '../core/model-catalog.js';
import { INVALID_PARAMS, note, rpcError } from './protocol.js';
import { config, runtime, store } from './context.js';

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

export const TOOLS = [
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

export const IMPLEMENTATIONS = new Map([
  ['ask_local_model', askLocalModel],
  ['list_local_models', listLocalModels],
  ['search_chats', searchChats],
]);

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

export { ASK_TIMEOUT_MS, DEFAULT_MODEL_ID, MODEL_IDS };
