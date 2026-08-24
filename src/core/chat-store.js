/**
 * ChatStore — durable conversation storage.
 *
 * Interface (both adapters satisfy it exactly):
 *   list()                        -> Promise<ChatMeta[]>   newest first
 *   get(id)                       -> Promise<Chat | null>
 *   create({ title, modelId })    -> Promise<Chat>
 *   appendMessage(id, message)    -> Promise<Chat>
 *   updateChat(id, patch)         -> Promise<Chat>         title / modelId only
 *   remove(id)                    -> Promise<boolean>
 *   search(query)                 -> Promise<ChatMeta[]>
 *
 * Invariants:
 *   - Every write is atomic: a crash mid-write never truncates an existing chat.
 *   - A corrupt file is quarantined, not thrown; the rest of the store stays usable.
 *   - ids are filesystem-safe and collision-resistant without any dependency.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Per-key promise chain. Two requests appending to the same chat would otherwise
 * interleave read-modify-write and silently drop a message, or collide on the
 * temp file and leave a half-written JSON that then gets quarantined — losing the
 * conversation. Serialising per chat id costs nothing for a single user.
 */
function createSerializer() {
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

let tmpCounter = 0;

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function newId() {
  return randomUUID().replace(/-/g, '').slice(0, 20);
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    const err = new Error(`invalid chat id: ${String(id).slice(0, 40)}`);
    err.code = 'EINVALID_ID';
    throw err;
  }
}

/**
 * Monotonic ISO clock. Two writes inside the same millisecond would otherwise
 * tie on updatedAt and make list order arbitrary, so we never hand out a
 * timestamp that is not strictly greater than the previous one. Drift is at
 * most one millisecond per write and self-corrects as the wall clock catches up.
 */
let lastIssuedMs = 0;
function nowIso() {
  const ms = Math.max(Date.now(), lastIssuedMs + 1);
  lastIssuedMs = ms;
  return new Date(ms).toISOString();
}

function toMeta(chat) {
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

/**
 * Titles are capped where they are created as well as where they are patched.
 * Only the patch door was guarded, so a title handed to POST /api/chats reached
 * disk at whatever length the caller sent and came back in every list response.
 * One cap, used by both.
 */
const MAX_TITLE = 120;

function cleanTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TITLE) : '';
}

function blankChat({ title, modelId }) {
  const ts = nowIso();
  return {
    id: newId(),
    title: cleanTitle(title) || 'New chat',
    modelId: modelId ?? null,
    createdAt: ts,
    updatedAt: ts,
    messages: [],
  };
}

function normaliseMessage(message) {
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

function applyAppend(chat, message) {
  const next = {
    ...chat,
    messages: [...chat.messages, normaliseMessage(message)],
    updatedAt: nowIso(),
  };
  next.title = autoTitle(next);
  return next;
}

function applyPatch(chat, patch) {
  const next = { ...chat, updatedAt: nowIso() };
  const title = cleanTitle(patch.title);
  if (title) next.title = title;
  if (typeof patch.modelId === 'string' || patch.modelId === null) next.modelId = patch.modelId;
  return next;
}

/** A record we can operate on without throwing later. */
function isWellFormed(chat) {
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

function matches(chat, needle) {
  if (chat.title.toLowerCase().includes(needle)) return true;
  return chat.messages.some((m) => m.content.toLowerCase().includes(needle));
}

// Deterministic even when two chats share a millisecond, so list order never flaps.
const byNewest = (a, b) =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

/* ------------------------------------------------------------------ */
/* JSON file adapter                                                   */
/* ------------------------------------------------------------------ */

export function createJsonFileStore(dir) {
  const fileFor = (id) => path.join(dir, `${id}.json`);
  const withLock = createSerializer();
  let ready = null;

  async function ensureDir() {
    ready ??= fs.mkdir(dir, { recursive: true });
    return ready;
  }

  async function writeAtomic(chat) {
    await ensureDir();
    const target = fileFor(chat.id);
    const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(chat, null, 2), 'utf8');
      await handle.sync(); // rename is only atomic if the bytes are actually down
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    return chat;
  }

  async function readOne(id) {
    try {
      const raw = await fs.readFile(fileFor(id), 'utf8');
      const parsed = JSON.parse(raw);
      if (!isWellFormed(parsed)) {
        await quarantine(id);
        return null;
      }
      return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (err instanceof SyntaxError) {
        await quarantine(id);
        return null;
      }
      throw err;
    }
  }

  async function quarantine(id) {
    try {
      await fs.rename(fileFor(id), `${fileFor(id)}.corrupt`);
    } catch {
      /* best effort — a corrupt file must never take the app down */
    }
  }

  async function readAll() {
    await ensureDir();
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((n) => ID_RE.test(n));
    const chats = await Promise.all(ids.map((id) => readOne(id)));
    return chats.filter(Boolean);
  }

  return {
    async list() {
      const chats = await readAll();
      return chats.map(toMeta).sort(byNewest);
    },
    async get(id) {
      assertId(id);
      return readOne(id);
    },
    async create(input = {}) {
      return writeAtomic(blankChat(input));
    },
    async appendMessage(id, message) {
      assertId(id);
      normaliseMessage(message); // reject bad input before taking the lock
      return withLock(id, async () => {
        const chat = await readOne(id);
        if (!chat) throw notFound(id);
        return writeAtomic(applyAppend(chat, message));
      });
    },
    async updateChat(id, patch = {}) {
      assertId(id);
      return withLock(id, async () => {
        const chat = await readOne(id);
        if (!chat) throw notFound(id);
        return writeAtomic(applyPatch(chat, patch));
      });
    },
    async remove(id) {
      assertId(id);
      try {
        await fs.unlink(fileFor(id));
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    },
    async search(query) {
      const needle = String(query ?? '').trim().toLowerCase();
      if (!needle) return this.list();
      const chats = await readAll();
      return chats.filter((c) => matches(c, needle)).map(toMeta).sort(byNewest);
    },
  };
}

/* ------------------------------------------------------------------ */
/* In-memory adapter (tests, and a --ephemeral mode)                   */
/* ------------------------------------------------------------------ */

export function createMemoryStore() {
  const chats = new Map();

  return {
    async list() {
      return [...chats.values()].map(toMeta).sort(byNewest);
    },
    async get(id) {
      assertId(id);
      const c = chats.get(id);
      return c ? structuredClone(c) : null;
    },
    async create(input = {}) {
      const chat = blankChat(input);
      chats.set(chat.id, chat);
      return structuredClone(chat);
    },
    async appendMessage(id, message) {
      assertId(id);
      normaliseMessage(message);
      const chat = chats.get(id);
      if (!chat) throw notFound(id);
      const next = applyAppend(chat, message);
      chats.set(id, next);
      return structuredClone(next);
    },
    async updateChat(id, patch = {}) {
      assertId(id);
      const chat = chats.get(id);
      if (!chat) throw notFound(id);
      const next = applyPatch(chat, patch);
      chats.set(id, next);
      return structuredClone(next);
    },
    async remove(id) {
      assertId(id);
      return chats.delete(id);
    },
    async search(query) {
      const needle = String(query ?? '').trim().toLowerCase();
      if (!needle) return this.list();
      return [...chats.values()].filter((c) => matches(c, needle)).map(toMeta).sort(byNewest);
    },
  };
}
