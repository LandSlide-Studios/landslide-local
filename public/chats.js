/**
 * The lifecycle of the conversation on screen: create one, open another, delete
 * one, replace its last reply.
 *
 * Every one of these swaps or destroys the node a stream would be writing into,
 * which is why they all go through `busyBlocks` first. Doing it while a reply was
 * generating detached the target node and the GPU carried on producing an answer
 * with nowhere to land.
 */

import { apiFetch } from './api-client.js';
import { busyBlocks, clearNotice, currentModel, els, modelById, notify, state } from './dom.js';
import { renderContext, renderThread, updateChatActions } from './message-view.js';
import { markModelSelected, renderModels } from './models.js';
import { saveSystemPrompt, systemPromptText } from './prompts.js';
import { loadChats, renderChats } from './sidebar.js';
import { streamReply } from './stream.js';

/** Throws on failure: the caller has to decide what a dead server means for it. */
async function newChat() {
  const res = await apiFetch('/api/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: state.modelId }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(payload?.error ?? `could not create a chat (server returned ${res.status})`);
  }
  const { chat } = await res.json();
  state.chatId = chat.id;
  // A fresh chat starts with no system prompt on the server. Whatever is in the
  // box is kept — it is a working mode, not a per-chat accident — but it has to
  // be re-sent, so the record of what the server knows resets with the chat.
  state.savedSystemPrompt = '';
  renderContext(null);
  await loadChats(els.chatSearch.value);
  renderThread(chat);
  els.prompt.focus();
  return chat;
}

async function startNewChat() {
  if (busyBlocks('Starting a new chat')) return;
  try {
    await newChat();
    clearNotice();
  } catch (err) {
    notify(String(err.message ?? err));
  }
}

async function openChat(id) {
  if (busyBlocks('Opening another chat')) return;
  const res = await apiFetch(`/api/chats/${id}`);
  if (!res.ok) return;
  const { chat } = await res.json();
  state.chatId = chat.id;
  if (chat.modelId && state.models.some((m) => m.id === chat.modelId)) {
    state.modelId = chat.modelId;
    localStorage.setItem('ls.modelId', chat.modelId);
    renderModels();
  }
  // The stored prompt is this chat's, not the last one's. Carrying the previous
  // chat's steering into an old conversation would silently change what it is.
  state.savedSystemPrompt = typeof chat.systemPrompt === 'string' ? chat.systemPrompt : '';
  els.systemPrompt.value = state.savedSystemPrompt;
  // The meter reports the last turn that was actually sent, and no turn has
  // been sent in this chat yet this session.
  renderContext(null);
  renderChats();
  renderThread(chat);
  els.prompt.focus();
}

async function deleteChat(id) {
  // Same door as new-chat and the chat rows: deleting the chat being written
  // into detaches the node the stream targets, and the generation runs on with
  // nowhere to land. Deleting any OTHER chat is harmless and stays allowed.
  if (id === state.chatId && busyBlocks('Deleting this chat')) return;
  await apiFetch(`/api/chats/${id}`, { method: 'DELETE' });
  if (state.chatId === id) {
    state.chatId = null;
    els.thread.replaceChildren(els.emptyState);
    els.emptyState.hidden = false;
    renderContext(null);
  }
  await loadChats(els.chatSearch.value);
  updateChatActions();
}

/**
 * Replace the last reply rather than asking the same question twice.
 *
 * The node comes off the thread here and the server drops the message from the
 * chat; the stream then writes a fresh one into the same place. Both halves or
 * neither — leaving the old node on screen while the server replaced the record
 * is how a thread starts disagreeing with what is on disk.
 */
async function regenerateReply(modelId = null) {
  if (busyBlocks('Regenerating')) return;
  if (!state.chatId) return;
  const last = [...els.thread.querySelectorAll('.msg-assistant')].pop();
  if (!last) {
    notify('There is no reply to regenerate yet.');
    return;
  }
  // Retrying with a different model is a real switch, not a one-off override:
  // the regenerate route writes the model onto the chat, so the rail has to
  // follow or it sits there naming a model this chat is no longer on.
  //
  // It follows on the `start` event, NOT before the request. Moving it first
  // was wrong in a way nothing announced: if the request failed - server down,
  // 400, the machine asleep - the rail and localStorage had switched, the chat
  // on disk had not, and the user's next ordinary message then silently went to
  // a model that had produced nothing.
  const chosen = modelId ? modelById(modelId) : currentModel();
  if (!chosen) {
    notify('That model is not one this build ships.');
    return;
  }
  const model = chosen;
  state.busy = true;
  els.thread.removeChild(last);
  await saveSystemPrompt();
  await streamReply({
    path: `/api/chats/${state.chatId}/regenerate`,
    payload: { modelId: model.id, systemPrompt: systemPromptText() },
    model,
    onStarted: () => {
      if (model.id !== state.modelId) markModelSelected(model.id);
    },
  });
}

/**
 * Fork this chat at one message and open the fork.
 *
 * The copy is made server-side in one write, and the original is not touched —
 * so the worst case if this fails is that nothing happened, rather than a
 * half-made branch or a damaged source. The new chat is opened straight away
 * because a branch nobody is looking at is just a duplicate in the sidebar.
 */
let branching = false;

async function branchFromMessage(messageId) {
  // Claimed synchronously, before the first await, and for the same reason
  // send() claims state.busy synchronously: two activations in one tick both
  // pass every check and both fork. Measured at a 10ms gap it self-corrects,
  // because by then openChat() has rebuilt the thread and detached the button -
  // so the window is one round trip, which grows with the chat and grows again
  // under the encrypted adapter's whole-file seal.
  if (branching) return;
  if (busyBlocks('Branching')) return;
  if (!state.chatId || !messageId) return;
  branching = true;
  try {
    // The other two write paths flush the composer's system prompt first; a
    // fork taken without it carries the last SAVED steering while the box on
    // screen shows something else, and openChat then replaces what was typed.
    await saveSystemPrompt();
    const res = await apiFetch(`/api/chats/${state.chatId}/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error ?? `server returned ${res.status}`);
    clearNotice();
    await loadChats(els.chatSearch.value);
    await openChat(payload.chat.id);
  } catch (err) {
    notify(`Could not branch this chat: ${err.message ?? err}`);
  } finally {
    branching = false;
  }
}

export { branchFromMessage, deleteChat, newChat, openChat, regenerateReply, startNewChat };
