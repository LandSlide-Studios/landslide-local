/**
 * The chat list down the left: what is on disk, filtered by the search box.
 *
 * It imports the chat lifecycle it triggers, and that module imports this one
 * back to refresh the list after a write. The cycle is real and deliberate — a
 * row IS the affordance for opening and deleting one — and it is safe because
 * neither side calls into the other while the modules are being evaluated.
 */

import { apiFetch } from './api-client.js';
import { deleteChat, openChat } from './chats.js';
import { els, state } from './dom.js';

/* ---------------- chats ---------------- */

async function loadChats(query = '') {
  const url = query ? `/api/chats?q=${encodeURIComponent(query)}` : '/api/chats';
  const res = await apiFetch(url);
  state.chats = (await res.json()).chats;
  renderChats();
}

function renderChats() {
  if (state.chats.length === 0) {
    const p = document.createElement('p');
    p.className = 'chat-sub';
    p.style.padding = '6px 8px';
    p.textContent = els.chatSearch.value ? 'No matches.' : 'No chats yet.';
    els.chatList.replaceChildren(p);
    return;
  }

  els.chatList.replaceChildren(
    ...state.chats.map((c) => {
      const row = document.createElement('div');
      row.className = `chat-row${c.id === state.chatId ? ' is-active' : ''}`;
      row.setAttribute('role', 'listitem');

      const main = document.createElement('div');
      main.className = 'chat-main';
      const t = document.createElement('div');
      t.className = 'chat-title';
      t.textContent = c.title;
      const s = document.createElement('div');
      s.className = 'chat-sub';
      const model = state.models.find((m) => m.id === c.modelId);
      s.textContent = `${c.messageCount} msg${c.messageCount === 1 ? '' : 's'}${model ? ` · ${model.name}` : ''}`;
      main.append(t, s);

      const del = document.createElement('button');
      del.className = 'chat-del';
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Delete chat';
      del.setAttribute('aria-label', `Delete ${c.title}`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(c.id);
      });

      row.append(main, del);
      row.addEventListener('click', () => openChat(c.id));
      return row;
    }),
  );
}

export { loadChats, renderChats };
