/**
 * HttpApi — deliberately thin. It parses requests, calls one module, and
 * serialises the answer. All behaviour lives behind ChatStore, ModelCatalog and
 * InferenceRuntime; if logic starts accumulating here, it belongs in one of them.
 *
 * Routes:
 *   GET    /api/state                  runtime health + catalog + fit verdicts
 *   GET    /api/chats[?q=]             list or search
 *   POST   /api/chats                  create
 *   GET    /api/chats/:id              read
 *   PATCH  /api/chats/:id              rename / switch model
 *   DELETE /api/chats/:id              delete
 *   POST   /api/chats/:id/message      send + stream the reply over SSE
 */

import * as catalog from './core/model-catalog.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function createApi({ store, runtime, config }) {
  const routes = [
    ['GET', /^\/api\/state$/, getState],
    ['GET', /^\/api\/chats$/, listChats],
    ['POST', /^\/api\/chats$/, createChat],
    ['GET', /^\/api\/chats\/([\w-]+)$/, getChat],
    ['PATCH', /^\/api\/chats\/([\w-]+)$/, patchChat],
    ['DELETE', /^\/api\/chats\/([\w-]+)$/, deleteChat],
    ['POST', /^\/api\/chats\/([\w-]+)\/message$/, postMessage],
  ];

  async function getState() {
    const [health, installed] = await Promise.all([runtime.health(), runtime.listModels()]);
    const models = catalog.withAvailability(installed).map((m) => ({
      ...m,
      fit: catalog.fitFor(m, config.hardware.vramUsableGb),
    }));
    return {
      ok: true,
      runtime: health,
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

  async function patchChat(match, body) {
    return { chat: await store.updateChat(match[1], body ?? {}) };
  }

  async function deleteChat(match) {
    return { removed: await store.remove(match[1]) };
  }

  /* Streaming reply. Returns a handler rather than a value. */
  async function postMessage(match, body, _url, res, req) {
    const chatId = match[1];
    const text = String(body?.content ?? '').trim();
    if (!text) throw httpError(400, 'content is required');

    const modelId = body?.modelId;
    const model = catalog.get(modelId);
    if (!model) throw httpError(400, `unknown model: ${modelId}`);

    let chat = await store.appendMessage(chatId, { role: 'user', content: text });
    if (chat.modelId !== modelId) chat = await store.updateChat(chatId, { modelId });

    const sse = openSse(res);
    const controller = new AbortController();
    // NOT req.on('close'): readJson has already consumed the request by this
    // point, so that event fired before the listener was attached and Stop never
    // reached the model — it kept generating with nobody listening. The response
    // stream is what stays open for the life of the generation.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    sse({ type: 'start', chatId, model: model.id, title: chat.title });

    const history = buildHistory(chat, body?.systemPrompt);
    let result;
    try {
      result = await runtime.chat({
        model: body?.runtimeModelTag || model.id,
        messages: history,
        options: { ...model.defaults, ...(body?.options ?? {}) },
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

  function buildHistory(chat, systemPrompt) {
    const msgs = [];
    if (systemPrompt && String(systemPrompt).trim()) {
      msgs.push({ role: 'system', content: String(systemPrompt).trim() });
    }
    for (const m of chat.messages) {
      if (m.role === 'system') continue;
      msgs.push({ role: m.role, content: m.content });
    }
    return msgs;
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
