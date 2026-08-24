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
import { busyBlocks, clearNotice, currentModel, els, notify, state } from './dom.js';
import { renderContext, renderThread, updateChatActions } from './message-view.js';
import { renderModels } from './models.js';
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
async function regenerateReply() {
  if (busyBlocks('Regenerating')) return;
  if (!state.chatId) return;
  const last = [...els.thread.querySelectorAll('.msg-assistant')].pop();
  if (!last) {
    notify('There is no reply to regenerate yet.');
    return;
  }
  const model = currentModel();
  state.busy = true;
  els.thread.removeChild(last);
  await saveSystemPrompt();
  await streamReply({
    path: `/api/chats/${state.chatId}/regenerate`,
    payload: { modelId: model.id, systemPrompt: systemPromptText() },
    model,
  });
}

export { deleteChat, newChat, openChat, regenerateReply, startNewChat };
