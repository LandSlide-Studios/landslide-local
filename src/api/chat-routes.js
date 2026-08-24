/**
 * The conversation routes, and the one path that reaches a model.
 *
 *   GET    /api/chats[?q=]             list or search
 *   POST   /api/chats                  create
 *   GET    /api/chats/:id              read
 *   PATCH  /api/chats/:id              rename / model / system prompt / options
 *   DELETE /api/chats/:id              delete
 *   GET    /api/chats/:id/export       the conversation as a file
 *   POST   /api/chats/:id/message      send + stream the reply over SSE
 *   POST   /api/chats/:id/regenerate   replace the last reply, same SSE stream
 *
 * Event names are imported, never spelled: the page reads the same module, so a
 * rename cannot leave one side drawing nothing and no error anywhere.
 */

import * as catalog from '../core/model-catalog.js';
import { budgetFor, planContext } from '../core/context-budget.js';
import { exportChat, isFormat } from '../core/chat-export.js';
import { EVENT } from '../../public/shared/events.js';
import { httpError, openSse } from './http.js';
import { requireModel } from './catalog-guard.js';

export function createChatRoutes({ store, runtime }) {
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
      type: EVENT.start,
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
      sse({ type: EVENT.error, message: String(err.message ?? err) });
      res.end();
      return null;
    }

    const saved = await store.appendMessage(chatId, {
      role: 'assistant',
      content: result.answer,
      thinking: result.thinking,
      stats: result.stats,
      // Stamped at the moment of writing, from the catalog id that actually
      // reached the runtime — not read back off the chat later, which is the
      // same value only until the next model switch.
      modelId: model.id,
    });

    sse({
      type: EVENT.done,
      aborted: result.aborted,
      stats: result.stats,
      title: saved.title,
      messageId: saved.messages.at(-1).id,
    });
    res.end();
    return null;
  }

  return [
    ['GET', /^\/api\/chats$/, listChats],
    ['POST', /^\/api\/chats$/, createChat],
    ['GET', /^\/api\/chats\/([\w-]+)$/, getChat],
    ['PATCH', /^\/api\/chats\/([\w-]+)$/, patchChat],
    ['DELETE', /^\/api\/chats\/([\w-]+)$/, deleteChat],
    ['GET', /^\/api\/chats\/([\w-]+)\/export$/, getExport],
    ['POST', /^\/api\/chats\/([\w-]+)\/message$/, postMessage],
    ['POST', /^\/api\/chats\/([\w-]+)\/regenerate$/, regenerate],
  ];
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
