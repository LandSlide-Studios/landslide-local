/**
 * HttpApi — deliberately thin. It parses requests, calls one module, and
 * serialises the answer. All behaviour lives behind ChatStore, ModelCatalog and
 * InferenceRuntime; if logic starts accumulating here, it belongs in one of them.
 *
 * Routes:
 *   GET    /api/state                  runtime health + catalog + fit verdicts
 *   POST   /api/runtime/unload         ask the runtime to give the VRAM back
 *   GET    /api/chats[?q=]             list or search
 *   POST   /api/chats                  create
 *   GET    /api/chats/:id              read
 *   PATCH  /api/chats/:id              rename / model / system prompt / options
 *   DELETE /api/chats/:id              delete
 *   GET    /api/chats/:id/export       the conversation as a file
 *   POST   /api/chats/:id/message      send + stream the reply over SSE
 *   POST   /api/chats/:id/regenerate   replace the last reply, same SSE stream
 *   GET    /api/prompts                the saved system prompts
 *   POST   /api/prompts                save one
 *   DELETE /api/prompts/:id            forget one
 */

import * as catalog from './core/model-catalog.js';
import { createRuntimeSupervisor } from './core/runtime-supervisor.js';
import { budgetFor, planContext } from './core/context-budget.js';
import { exportChat, isFormat } from './core/chat-export.js';
import { createPromptLibrary, defaultPromptFile } from './core/prompt-library.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function createApi({ store, runtime, config, supervisor, prompts }) {
  const boss = supervisor ?? createRuntimeSupervisor(config.runtime ?? {});
  const library =
    prompts ??
    createPromptLibrary({
      file: config.storage?.promptsFile || defaultPromptFile(config.storage.chatsDir),
    });
  const routes = [
    ['GET', /^\/api\/runtime$/, runtimeStatus],
    ['POST', /^\/api\/runtime\/start$/, startRuntime],
    ['POST', /^\/api\/runtime\/warm$/, warmModel],
    ['POST', /^\/api\/runtime\/unload$/, unloadModel],
    ['GET', /^\/api\/state$/, getState],
    ['GET', /^\/api\/prompts$/, listPrompts],
    ['POST', /^\/api\/prompts$/, createPrompt],
    ['DELETE', /^\/api\/prompts\/([\w-]+)$/, deletePrompt],
    ['GET', /^\/api\/chats$/, listChats],
    ['POST', /^\/api\/chats$/, createChat],
    ['GET', /^\/api\/chats\/([\w-]+)$/, getChat],
    ['PATCH', /^\/api\/chats\/([\w-]+)$/, patchChat],
    ['DELETE', /^\/api\/chats\/([\w-]+)$/, deleteChat],
    ['GET', /^\/api\/chats\/([\w-]+)\/export$/, getExport],
    ['POST', /^\/api\/chats\/([\w-]+)\/message$/, postMessage],
    ['POST', /^\/api\/chats\/([\w-]+)\/regenerate$/, regenerate],
  ];

  /**
   * The adapters the supervisor can actually drive. It speaks Ollama's HTTP API
   * and nothing else, so under any other adapter both start and warm would act
   * on a DIFFERENT process from the one configured to answer.
   */
  const SUPERVISED_ADAPTERS = new Set(['ollama']);

  /**
   * One answer to "is anything actually answering", shared by /api/runtime and
   * /api/state so the two cannot disagree.
   *
   * The supervisor only ever talks to Ollama. Reporting its health while
   * `runtime.adapter` is llamacpp is reporting a different process's state as
   * this one's: the page warned correctly on load, then twelve seconds later
   * announced "ollama ready" and hid the warning while nothing could answer.
   *
   * `canWarm` is here for the same reason `canStart` is: whether an affordance
   * does anything is a fact about the configured backend, and the page has to be
   * told it rather than deciding it. Under llamacpp all five Preload buttons
   * rendered, and each one loaded a model into Ollama.
   */
  async function runtimeView() {
    const [health, sup] = await Promise.all([runtime.health(), boss.status()]);
    const supervised = SUPERVISED_ADAPTERS.has(health.adapter);
    return {
      adapter: health.adapter,
      running: health.ok,
      version: health.ok ? (health.version ?? null) : null,
      error: health.ok ? null : (health.error ?? 'not reachable'),
      loaded: health.ok && supervised ? sup.loaded : [],
      canStart: supervised && sup.canStart,
      canWarm: supervised,
      bin: supervised ? sup.bin : null,
      starting: supervised ? sup.starting : false,
    };
  }

  /**
   * Refuse before the supervisor is touched. A hidden button is a courtesy; the
   * endpoint is the guarantee. `POST /api/runtime/start` under llamacpp
   * answered {"ok":true,"alreadyRunning":true} — Ollama's state, reported as the
   * configured runtime's — and warm loaded a model into that same wrong process.
   */
  async function requireSupervised(action) {
    const { adapter } = await runtime.health();
    if (SUPERVISED_ADAPTERS.has(adapter)) return;
    throw httpError(
      409,
      `cannot ${action}: runtime.adapter is "${adapter}" and this app can only drive ollama`,
    );
  }

  async function runtimeStatus() {
    return { runtime: await runtimeView() };
  }

  async function startRuntime() {
    await requireSupervised('start the model server');
    const result = await boss.start();
    return { result, runtime: await runtimeView() };
  }

  async function warmModel(_m, body) {
    // Only a model this app ships may be preloaded; the id never reaches the
    // runtime unvalidated. A bad id is the caller's mistake whatever the backend
    // is, so it keeps answering 400 before the backend question is asked.
    const model = requireModel(body?.modelId);
    await requireSupervised('preload a model');
    return { result: await boss.warm(model.id) };
  }

  /**
   * The other half of preload. On an 8 GB card a resident 9B is most of the
   * card, and waiting out KEEP_ALIVE is not a plan when the next thing that
   * wants the GPU is already open. Same gate as warm: catalog id or nothing.
   */
  async function unloadModel(_m, body) {
    const model = requireModel(body?.modelId);
    await requireSupervised('unload a model');
    return { result: await boss.unload(model.id) };
  }

  /** Nothing a request says becomes a model id — it names one, or it is refused. */
  function requireModel(modelId) {
    const model = catalog.get(modelId);
    if (!model) throw httpError(400, `unknown model: ${modelId}`);
    return model;
  }

  async function getState() {
    const [view, installed] = await Promise.all([runtimeView(), runtime.listModels()]);
    const models = catalog.withAvailability(installed).map((m) => ({
      ...m,
      fit: catalog.fitFor(m, config.hardware.vramUsableGb),
    }));
    return {
      ok: true,
      runtime: { ok: view.running, adapter: view.adapter, version: view.version, error: view.error },
      supervisor: view,
      hardware: config.hardware,
      modelsDir: config.storage.modelsDir,
      chatsDir: config.storage.chatsDir,
      totalSizeGb: catalog.totalSizeGb(),
      models,
    };
  }

  async function listChats(_m, _b, url) {
    const q = url.searchParams.get('q');
    return { chats: q ? await store.search(q) : await store.list() };
  }

  async function createChat(_m, body) {
    return { chat: await store.create({ title: body?.title, modelId: body?.modelId }) };
  }

  async function getChat(match) {
    const chat = await store.get(match[1]);
    if (!chat) throw httpError(404, 'chat not found');
    return { chat };
  }

  /**
   * Generation options are checked here rather than clamped, because these are
   * being WRITTEN. A stored temperature of 99 would be quietly rewritten to 2
   * on every send, and the panel would go on showing a number no model ever
   * sees — this is the one moment the user is present to be told otherwise.
   */
  async function patchChat(match, body) {
    const patch = body ?? {};
    if ('options' in patch && patch.options !== null) {
      const problems = catalog.checkOptions(patch.options);
      if (problems.length > 0) throw httpError(400, problems.join('; '));
    }
    if ('systemPrompt' in patch && patch.systemPrompt !== null && typeof patch.systemPrompt !== 'string') {
      throw httpError(400, 'systemPrompt must be a string');
    }
    return { chat: await store.updateChat(match[1], patch) };
  }

  async function deleteChat(match) {
    return { removed: await store.remove(match[1]) };
  }

  /** A conversation as a file. Not JSON: the point is something to paste. */
  async function getExport(match, _body, url, res) {
    const format = url.searchParams.get('format') ?? 'md';
    if (!isFormat(format)) throw httpError(400, `unsupported export format: ${format}`);
    const chat = await store.get(match[1]);
    if (!chat) throw httpError(404, 'chat not found');

    const file = exportChat(chat, format);
    const bytes = Buffer.from(file.body, 'utf8');
    res.writeHead(200, {
      'content-type': file.contentType,
      'content-length': bytes.length,
      'content-disposition': `attachment; filename="${file.filename}"`,
    });
    res.end(bytes);
    return null;
  }

  /* ---------------- the prompt library ---------------- */

  async function listPrompts() {
    return { prompts: await library.list() };
  }

  async function createPrompt(_m, body) {
    const prompt = await library.add(body);
    if (!prompt) throw httpError(400, 'a saved prompt needs both a name and some text');
    return { prompt };
  }

  async function deletePrompt(match) {
    return { removed: await library.remove(match[1]) };
  }

  /* Streaming reply. Returns a handler rather than a value. */
  async function postMessage(match, body, _url, res) {
    const chatId = match[1];
    const text = String(body?.content ?? '').trim();
    if (!text) throw httpError(400, 'content is required');
    const model = requireModel(body?.modelId);

    let chat = await store.appendMessage(chatId, { role: 'user', content: text });
    if (chat.modelId !== model.id) chat = await store.updateChat(chatId, { modelId: model.id });

    return streamReply({ chatId, chat, model, body, res });
  }

  /**
   * Regenerate: the last reply is REPLACED, not answered a second time.
   *
   * Dropping it before generating is what makes that true, and it happens
   * through the store so it takes the same per-chat lock every other write
   * does. A chat whose last turn is the user's has no reply to replace, and
   * saying so is a 400 rather than something to guess at.
   */
  async function regenerate(match, body, _url, res) {
    const chatId = match[1];
    const model = requireModel(body?.modelId);

    const current = await store.get(chatId);
    if (!current) throw httpError(404, 'chat not found');
    if (current.messages.at(-1)?.role !== 'assistant') {
      throw httpError(400, 'nothing to regenerate: this chat has no reply to replace');
    }

    let chat = await store.removeLastMessage(chatId);
    if (chat.modelId !== model.id) chat = await store.updateChat(chatId, { modelId: model.id });

    return streamReply({ chatId, chat, model, body, res });
  }

  /**
   * One generation, from a chat that is already in the state it should be in.
   * Both doors into the model come through here, so what reaches it — the
   * budget, the system prompt, the options whitelist — cannot differ between
   * sending and regenerating.
   */
  async function streamReply({ chatId, chat, model, body, res }) {
    const sse = openSse(res);
    const controller = new AbortController();
    // NOT req.on('close'): readJson has already consumed the request by this
    // point, so that event fired before the listener was attached and Stop never
    // reached the model — it kept generating with nobody listening. The response
    // stream is what stays open for the life of the generation.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    // The chat's own settings are the base; this request may move a knob for
    // one turn. Both go through the catalog whitelist before a runtime sees them.
    const options = catalog.optionsFor(model, { ...(chat.options ?? {}), ...(body?.options ?? {}) });
    const systemPrompt = firstText(body?.systemPrompt, chat.systemPrompt);
    const { limitTokens, reserveTokens } = budgetFor(options);
    const plan = planContext({
      messages: conversation(chat),
      systemPrompt,
      limitTokens,
      reserveTokens,
    });

    sse({
      type: 'start',
      chatId,
      model: model.id,
      title: chat.title,
      // The whole point of the budget: what fits, what the window is, and how
      // many turns did not make it — sent before a token is generated, so a
      // truncated conversation is something the user is TOLD about rather than
      // something they eventually notice the model forgetting.
      context: {
        estimatedTokens: plan.estimatedTokens,
        limitTokens: plan.limitTokens,
        trimmed: plan.trimmed,
      },
    });

    let result;
    try {
      result = await runtime.chat({
        // The catalog id, always. A caller-supplied tag used to win here, which
        // meant any model in the registry — a 37 GiB one on an 8 GB card — was
        // one JSON field away.
        model: model.id,
        messages: plan.messages,
        options,
        signal: controller.signal,
        onEvent: (e) => sse(e),
      });
    } catch (err) {
      sse({ type: 'error', message: String(err.message ?? err) });
      res.end();
      return null;
    }

    const saved = await store.appendMessage(chatId, {
      role: 'assistant',
      content: result.answer,
      thinking: result.thinking,
      stats: result.stats,
    });

    sse({
      type: 'done',
      aborted: result.aborted,
      stats: result.stats,
      title: saved.title,
      messageId: saved.messages.at(-1).id,
    });
    res.end();
    return null;
  }

  /**
   * The turns, and only the turns. A `system` message that ended up stored in
   * the history is dropped here: the system prompt is a property of the chat
   * now, and letting a second one ride along in the middle of the transcript
   * is how models start arguing with their own instructions.
   */
  function conversation(chat) {
    return chat.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
  }

  /** The first of these that actually says something. */
  function firstText(...values) {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }

  /** @returns {boolean} true when this request was an API request and is handled. */
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;

    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) {
      send(res, 404, { error: 'no such endpoint' });
      return true;
    }

    try {
      const body = await readJson(req);
      const match = url.pathname.match(route[1]);
      const result = await route[2](match, body, url, res, req);
      if (result !== null) send(res, 200, result);
    } catch (err) {
      const status = err.status ?? statusForCode(err.code);
      if (!res.headersSent) send(res, status, { error: String(err.message ?? err) });
      else res.end();
    }
    return true;
  };
}

/* ---------------------------------------------------------------- */

/** A client mistake is not a server fault; report it as one of theirs. */
function statusForCode(code) {
  if (code === 'ENOTFOUND_CHAT') return 404;
  if (code === 'EINVALID_ID') return 400;
  return 500;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function openSse(res) {
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

function readJson(req) {
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
