/**
 * What a chat IS, with nothing about where it is kept.
 *
 * Every ChatStore adapter — plain files, encrypted files, memory — applies the
 * same rules to the same record: how an id is made and checked, what a blank
 * chat looks like, which fields a patch may move, what a message must carry,
 * how a chat is summarised for the sidebar, and the order a list comes back in.
 * Those rules used to sit above the adapters in one file, close enough to the
 * filesystem code to look like part of it; two of them (the title cap, the
 * monotonic clock) had already been re-derived somewhere else by the time this
 * was written.
 *
 * Nothing here touches `node:fs`. That is the point: these are the pure
 * functions an adapter composes, so a new adapter gets the behaviour by using
 * them rather than by remembering to.
 *
 * @see chat-store.js for the adapters and the interface they satisfy.
 */

import { randomUUID } from 'node:crypto';

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Titles are capped where they are created as well as where they are patched.
 * Only the patch door was guarded, so a title handed to POST /api/chats reached
 * disk at whatever length the caller sent and came back in every list response.
 * One cap, used by both.
 */
const MAX_TITLE = 120;

/**
 * A system prompt is the one field here whose length has a cost per turn: it is
 * re-sent with every message for the life of the chat, out of the same context
 * window the conversation needs. Long enough to be a real brief, short enough
 * that it cannot quietly eat the window on its own.
 */
const MAX_SYSTEM_PROMPT = 8000;

export function newId() {
  return randomUUID().replace(/-/g, '').slice(0, 20);
}

/** Also the test a filename stem has to pass before it is treated as a chat. */
export function isChatId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

export function assertId(id) {
  if (!isChatId(id)) {
    const err = new Error(`invalid chat id: ${String(id).slice(0, 40)}`);
    err.code = 'EINVALID_ID';
    throw err;
  }
}

/**
 * Per-key promise chain. Two requests appending to the same chat would otherwise
 * interleave read-modify-write and silently drop a message, or collide on the
 * temp file and leave a half-written JSON that then gets quarantined — losing the
 * conversation. Serialising per chat id costs nothing for a single user.
 */
export function createSerializer() {
  const chains = new Map();
  return function withLock(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const settled = run.then(
      () => {},
      () => {},
    );
    chains.set(key, settled);
    settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return run;
  };
}

/**
 * Monotonic ISO clock. Two writes inside the same millisecond would otherwise
 * tie on updatedAt and make list order arbitrary, so we never hand out a
 * timestamp that is not strictly greater than the previous one. Drift is at
 * most one millisecond per write and self-corrects as the wall clock catches up.
 */
let lastIssuedMs = 0;
export function nowIso() {
  const ms = Math.max(Date.now(), lastIssuedMs + 1);
  lastIssuedMs = ms;
  return new Date(ms).toISOString();
}

export function toMeta(chat) {
  return {
    id: chat.id,
    title: chat.title,
    modelId: chat.modelId,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messageCount: chat.messages.length,
    preview: previewOf(chat),
  };
}

function previewOf(chat) {
  const firstUser = chat.messages.find((m) => m.role === 'user');
  const text = (firstUser?.content ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
}

function cleanTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TITLE) : '';
}

/**
 * Both new fields are present from birth rather than appearing on first patch.
 * A chat that sometimes has a `systemPrompt` key and sometimes does not is a
 * chat every reader has to guess about; the shape on disk stays one shape.
 * Chats written before these existed simply read back as undefined, which every
 * caller already treats as "none".
 */
export function blankChat({ title, modelId }) {
  const ts = nowIso();
  return {
    id: newId(),
    title: cleanTitle(title) || 'New chat',
    modelId: modelId ?? null,
    systemPrompt: '',
    options: null,
    createdAt: ts,
    updatedAt: ts,
    messages: [],
  };
}

export function normaliseMessage(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  const { role, content } = message;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    throw new Error(`invalid role: ${String(role)}`);
  }
  if (typeof content !== 'string') throw new Error('message.content must be a string');
  return {
    id: newId(),
    role,
    content,
    thinking: typeof message.thinking === 'string' ? message.thinking : '',
    createdAt: nowIso(),
    stats: message.stats && typeof message.stats === 'object' ? message.stats : null,
  };
}

/** Title a chat from its first user message, once. */
function autoTitle(chat) {
  if (chat.title !== 'New chat') return chat.title;
  const first = chat.messages.find((m) => m.role === 'user');
  if (!first) return chat.title;
  const clean = first.content.replace(/\s+/g, ' ').trim();
  if (!clean) return chat.title;
  return clean.length > 48 ? `${clean.slice(0, 48)}...` : clean;
}

export function applyAppend(chat, message) {
  const next = {
    ...chat,
    messages: [...chat.messages, normaliseMessage(message)],
    updatedAt: nowIso(),
  };
  next.title = autoTitle(next);
  return next;
}

/**
 * Regenerate needs the last reply gone before a new one is generated, or the
 * chat grows a second answer to the same question every time the button is
 * pressed. Dropping the tail is the store's business: it is a write, and the
 * per-chat lock that makes concurrent writes safe lives with the adapters.
 */
export function applyDropLast(chat) {
  return { ...chat, messages: chat.messages.slice(0, -1), updatedAt: nowIso() };
}

/**
 * Only the four fields a caller is allowed to move, and each with its own
 * notion of "cleared". `null` clears; an absent key leaves what is there. A
 * blanket merge would let any caller write over `messages` or `createdAt`.
 */
export function applyPatch(chat, patch) {
  const next = { ...chat, updatedAt: nowIso() };
  const title = cleanTitle(patch.title);
  if (title) next.title = title;
  if (typeof patch.modelId === 'string' || patch.modelId === null) next.modelId = patch.modelId;
  if (typeof patch.systemPrompt === 'string') {
    next.systemPrompt = patch.systemPrompt.trim().slice(0, MAX_SYSTEM_PROMPT);
  } else if (patch.systemPrompt === null) {
    next.systemPrompt = '';
  }
  if (patch.options === null) next.options = null;
  else if (patch.options && typeof patch.options === 'object' && !Array.isArray(patch.options)) {
    next.options = { ...patch.options };
  }
  return next;
}

/** A record we can operate on without throwing later. */
export function isWellFormed(chat) {
  return (
    chat &&
    typeof chat === 'object' &&
    typeof chat.id === 'string' &&
    typeof chat.title === 'string' &&
    Array.isArray(chat.messages) &&
    chat.messages.every((m) => m && typeof m.content === 'string' && typeof m.role === 'string')
  );
}

/** Callers (and the HTTP layer) need to tell "missing" from "broken". */
export function notFound(id) {
  const err = new Error(`chat not found: ${id}`);
  err.code = 'ENOTFOUND_CHAT';
  return err;
}

export function matches(chat, needle) {
  if (chat.title.toLowerCase().includes(needle)) return true;
  return chat.messages.some((m) => m.content.toLowerCase().includes(needle));
}

// Deterministic even when two chats share a millisecond, so list order never flaps.
export const byNewest = (a, b) =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

export { ID_RE, MAX_TITLE, MAX_SYSTEM_PROMPT };
