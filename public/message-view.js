/**
 * One conversation on screen: the message nodes, and the two readings under
 * them — what the last turn cost against the context window, and whether Export
 * and Again mean anything yet.
 *
 * Every character a model produced goes through `render.js` here, on the reload
 * path exactly as on the streaming one. That is not a style choice: the two
 * disagreeing is a bug the user experiences as "it broke, then it fixed itself".
 */

import { NO_OUTPUT, currentModel, els, scrollToEnd, state, statLine } from './dom.js';
import { renderText } from './render.js';

/* ---------------- context meter + chat actions ---------------- */

/**
 * What the last turn cost against the window.
 *
 * `trimmed` is the number that matters: above zero, turns were left out of
 * what the model was shown. They are still on disk — this is a shorter view of
 * the conversation, not a smaller conversation — but the user has to be told,
 * because the alternative is a model that appears to have forgotten things for
 * no reason anyone can see.
 */
function renderContext(context) {
  if (!context || typeof context.estimatedTokens !== 'number') {
    els.contextMeter.textContent = '';
    els.contextMeter.classList.remove('is-tight');
    els.contextMeter.classList.remove('is-trimmed');
    return;
  }
  const used = context.estimatedTokens;
  const limit = context.limitTokens || 0;
  const dropped = context.trimmed || 0;
  els.contextMeter.textContent =
    `${used.toLocaleString()}/${limit.toLocaleString()} ctx` +
    (dropped > 0 ? ` · ${dropped} dropped` : '');
  els.contextMeter.title = dropped
    ? `${dropped} of the oldest turns did not fit this model's window and were left out of the last reply. They are still saved in the chat.`
    : `About ${used.toLocaleString()} of ${limit.toLocaleString()} tokens used by the last reply's prompt.`;
  els.contextMeter.classList.toggle('is-tight', limit > 0 && used / limit >= 0.75);
  els.contextMeter.classList.toggle('is-trimmed', dropped > 0);
}

const hasReply = () => Boolean(els.thread.querySelector('.msg-assistant'));

/** Export and Again only mean anything with a chat, and Again needs a reply. */
function updateChatActions() {
  if (state.chatId) els.exportChat.setAttribute('href', `/api/chats/${state.chatId}/export?format=md`);
  else els.exportChat.removeAttribute('href');
  els.exportChat.setAttribute('aria-disabled', String(!state.chatId));
  els.regenerate.disabled = !state.chatId || state.busy || !hasReply();
}

/* ---------------- thread rendering ---------------- */

function renderThread(chat) {
  els.thread.replaceChildren();
  if (chat.messages.length === 0) {
    els.emptyState.hidden = false;
    els.thread.append(els.emptyState);
    updateChatActions();
    return;
  }
  for (const m of chat.messages) {
    els.thread.append(buildMessage(m.role, m.content, m.thinking, m.stats));
  }
  updateChatActions();
  scrollToEnd();
}

/**
 * Build one message node.
 *
 * `pending` marks the empty shell a stream is about to be written into; every
 * other call is a finished turn, including the ones rebuilt from disk on reload.
 * Both reasoning and answer therefore go through render.js here, exactly as the
 * stream does. Reasoning used to be assigned with `textContent`: a model that
 * emitted a code fence — which reasoning models do constantly — showed a real
 * code block while it thought and literal backticks plus a stray language tag
 * after F5. The placeholder has the same problem in reverse: the stream wrote
 * [no output] and the reload wrote nothing.
 */
function buildMessage(role, content = '', thinking = '', stats = null, { pending = false } = {}) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  node.classList.add(role === 'user' ? 'msg-user' : 'msg-assistant');
  node.querySelector('.msg-role').textContent = role === 'user' ? 'You' : (currentModel()?.name ?? 'Model');

  // How this model writes, straight from the catalog via /api/state. A user's
  // own message is not a model's output, so it gets the neutral profile.
  const format = role === 'user' ? undefined : currentModel()?.format;

  const think = node.querySelector('.think');
  if (thinking) {
    think.hidden = false;
    renderText(node.querySelector('.think-text'), thinking, format);
  }

  const producedNothing = !pending && role !== 'user' && !content && !thinking;
  renderText(node.querySelector('.msg-text'), producedNothing ? NO_OUTPUT : content, format);
  if (stats) node.querySelector('.msg-stats').textContent = statLine(stats);
  return node;
}

export { buildMessage, renderContext, renderThread, updateChatActions };
