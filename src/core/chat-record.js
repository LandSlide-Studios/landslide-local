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
    // Which model actually wrote this. The chat carries a modelId too, but that
    // one is the CURRENT choice — switch models and it retroactively reassigns
    // authorship of every earlier reply. This field is the only place the truth
    // can live, and it is null for anything written before it existed rather
    // than being guessed at on read.
    modelId: typeof message.modelId === 'string' && message.modelId ? message.modelId : null,
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

/**
 * A copy of this chat up to and including one message, as a new chat.
 *
 * Inclusive of the named message whatever its role. Branching at a reply means
 * "keep that answer and go somewhere else from here"; branching at a question
 * means "ask this again and take the other road". Both are useful and both are
 * the same slice, so there is no role rule to remember.
 *
 * Message ids are reissued. Two chats sharing an id would be two different
 * things answering to the same name — `done.messageId` already identifies a
 * message to the page, and the export and the store both assume ids are
 * theirs. Everything else about a message is preserved verbatim, timestamps and
 * authorship included: this is the same conversation, not a re-enactment of it.
 *
 * Returns null when the message is not in this chat, so the caller can tell
 * "no such message" from "no such chat".
 */
export function applyBranch(chat, messageId, { title } = {}) {
  // Without this, `undefined === undefined` matches the first message of a chat
  // written before messages carried ids - a supported shape - and branch(undefined)
  // quietly produces a one-message fork instead of refusing.
  if (typeof messageId !== 'string' || !messageId) return null;
  const at = chat.messages.findIndex((m) => m.id === messageId);
  if (at < 0) return null;
  const ts = nowIso();
  return {
    id: newId(),
    title: cleanTitle(title) || branchTitle(chat.title),
    // The settings are what make a branch a fair comparison rather than a fresh
    // start: same model, same system prompt, same sampling.
    modelId: chat.modelId ?? null,
    systemPrompt: typeof chat.systemPrompt === 'string' ? chat.systemPrompt : '',
    options: chat.options ?? null,
    createdAt: ts,
    updatedAt: ts,
    // Provenance. Nothing reads this yet - it is here so a fork can later be
    // traced to its source without guessing from the title, and because the
    // moment to record where a copy came from is the moment it is made.
    branchedFrom: { chatId: chat.id, messageId },
    messages: chat.messages.slice(0, at + 1).map((m) => ({
      id: newId(),
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      thinking: typeof m.thinking === 'string' ? m.thinking : '',
      createdAt: m.createdAt ?? ts,
      stats: m.stats && typeof m.stats === 'object' ? m.stats : null,
      modelId: typeof m.modelId === 'string' && m.modelId ? m.modelId : null,
    })),
  };
}

const BRANCH_MARKER = ' (branch)';

/**
 * Branches of branches stay one word long: strip the marker before re-adding it,
 * or three forks deep reads "Why is X (branch) (branch) (branch)".
 *
 * The base is capped with room for the marker RESERVED. Capping afterwards is
 * what the first version did, and on a title at or near the 120-character limit
 * the cap ate the marker instead of the title - at exactly 120 the fork came out
 * byte-identical to its source, which is the one case where telling them apart
 * matters most.
 */
function branchTitle(title) {
  const stripped = cleanTitle(String(title ?? '').replace(/ \(branch\)$/, ''));
  const base = stripped.slice(0, MAX_TITLE - BRANCH_MARKER.length).trim() || 'New chat';
  return `${base}${BRANCH_MARKER}`;
}

/** The message named is not in this chat. Distinct from the chat being absent. */
export function noSuchMessage(messageId) {
  const err = new Error(`no such message in this chat: ${String(messageId).slice(0, 40)}`);
  err.code = 'ENOTFOUND_MESSAGE';
  return err;
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
