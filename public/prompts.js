/**
 * The system prompt box and the library behind it.
 *
 * The prompt travels two ways on purpose, and `saveSystemPrompt` is the half
 * that makes it survive a reload; the other half rides in the body of every
 * send. `state.savedSystemPrompt` is what stops every keystroke becoming a PATCH.
 */

import { apiFetch } from './api-client.js';
import { clearNotice, els, notify, state } from './dom.js';

/* ---------------- system prompt + prompt library ---------------- */

const systemPromptText = () => els.systemPrompt.value.trim();

/**
 * The prompt travels two ways on purpose: in the body of every send, so this
 * turn is steered even if the write has not landed, and PATCHed onto the chat,
 * so it is still there after a reload. Sending it only with the message would
 * mean a system prompt that quietly evaporates on F5.
 */
async function saveSystemPrompt() {
  if (!state.chatId) return;
  const text = systemPromptText();
  if (text === state.savedSystemPrompt) return;
  state.savedSystemPrompt = text;
  try {
    await apiFetch(`/api/chats/${state.chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt: text }),
    });
  } catch {
    /* the send carries the same text anyway; this only affects the next reload */
  }
}

async function loadPrompts() {
  try {
    const res = await apiFetch('/api/prompts');
    state.prompts = res.ok ? ((await res.json()).prompts ?? []) : [];
  } catch {
    state.prompts = [];
  }
  renderPrompts();
}

function renderPrompts() {
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = state.prompts.length ? 'Load a saved prompt' : 'No saved prompts';
  els.promptLibrary.replaceChildren(
    blank,
    ...state.prompts.map((p) => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      return option;
    }),
  );
  els.promptLibrary.value = '';
  els.deletePrompt.disabled = state.prompts.length === 0;
}

async function savePrompt() {
  const text = systemPromptText();
  if (!text) {
    notify('Write a system prompt before saving it.');
    return;
  }
  // A prompt with no name is unfindable in the list it was saved into, so one
  // is derived rather than refused — the server would refuse it outright.
  const name = els.promptName.value.trim() || text.replace(/\s+/g, ' ').slice(0, 40);
  const res = await apiFetch('/api/prompts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, text }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    notify(payload?.error ?? `could not save that prompt (server returned ${res.status})`);
    return;
  }
  els.promptName.value = '';
  clearNotice();
  await loadPrompts();
}

async function deletePrompt() {
  const id = els.promptLibrary.value;
  if (!id) {
    notify('Choose a saved prompt first, then Del removes it.');
    return;
  }
  await apiFetch(`/api/prompts/${id}`, { method: 'DELETE' }).catch(() => {});
  await loadPrompts();
}

function usePrompt() {
  const found = state.prompts.find((p) => p.id === els.promptLibrary.value);
  if (!found) return;
  els.systemPrompt.value = found.text;
  els.promptName.value = found.name;
  saveSystemPrompt();
}

export { deletePrompt, loadPrompts, savePrompt, saveSystemPrompt, systemPromptText, usePrompt };
