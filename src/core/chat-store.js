/**
 * ChatStore — durable conversation storage.
 *
 * Adapters: `json` (plain files), `encrypted` (the same files, sealed under a
 * passphrase) and `memory`. All three satisfy the interface exactly; the two
 * file-backed ones are literally the same function with a different codec.
 *
 * Interface:
 *   list()                        -> Promise<ChatMeta[]>   newest first
 *   get(id)                       -> Promise<Chat | null>
 *   create({ title, modelId })    -> Promise<Chat>
 *   appendMessage(id, message)    -> Promise<Chat>
 *   removeLastMessage(id)         -> Promise<Chat>         for regenerate
 *   updateChat(id, patch)         -> Promise<Chat>         title / modelId / systemPrompt / options
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
import { createChatCrypto, ENVELOPE_OVERHEAD } from './chat-crypto.js';

/** The two on-disk shapes. Nothing else in the chats folder is a chat. */
export const JSON_EXT = '.json';
export const ENC_EXT = '.enc';

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

/** Also the test a filename stem has to pass before it is treated as a chat. */
export function isChatId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function assertId(id) {
  if (!isChatId(id)) {
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

/**
 * A system prompt is the one field here whose length has a cost per turn: it is
 * re-sent with every message for the life of the chat, out of the same context
 * window the conversation needs. Long enough to be a real brief, short enough
 * that it cannot quietly eat the window on its own.
 */
const MAX_SYSTEM_PROMPT = 8000;

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
function blankChat({ title, modelId }) {
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

/**
 * Regenerate needs the last reply gone before a new one is generated, or the
 * chat grows a second answer to the same question every time the button is
 * pressed. Dropping the tail is the store's business: it is a write, and the
 * per-chat lock that makes concurrent writes safe lives here.
 */
function applyDropLast(chat) {
  return { ...chat, messages: chat.messages.slice(0, -1), updatedAt: nowIso() };
}

/**
 * Only the four fields a caller is allowed to move, and each with its own
 * notion of "cleared". `null` clears; an absent key leaves what is there. A
 * blanket merge would let any caller write over `messages` or `createdAt`.
 */
function applyPatch(chat, patch) {
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
/* File-backed adapters — one folder, one file per conversation        */
/* ------------------------------------------------------------------ */

/**
 * Everything both file adapters do, which is everything except turning a chat
 * into bytes. Keeping this one function is the point: `createEncryptedFileStore`
 * is not a second storage implementation that has to be kept in step, it is the
 * same one with a different codec. A behaviour added here reaches both, which is
 * what "both adapters satisfy the contract exactly" is supposed to mean.
 *
 * @param {string} dir
 * @param {object} codec
 * @param {string} codec.ext            file extension, including the dot
 * @param {(chat: object) => Promise<Buffer>} codec.encode
 * @param {(bytes: Buffer) => Promise<object>} codec.decode
 * @param {(err: Error, id: string, quarantine: Function) => Promise<object|null>} codec.onDecodeError
 */
function createFileStore(dir, { ext, encode, decode, onDecodeError }) {
  const fileFor = (id) => path.join(dir, `${id}${ext}`);
  const withLock = createSerializer();
  let ready = null;

  async function ensureDir() {
    ready ??= fs.mkdir(dir, { recursive: true });
    return ready;
  }

  async function writeAtomic(chat) {
    await ensureDir();
    // Encode before anything is opened: a codec that fails must leave no file
    // behind at all, not an empty temp file for the next readdir to trip over.
    const bytes = await encode(chat);
    const target = fileFor(chat.id);
    const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(bytes);
      await handle.sync(); // rename is only atomic if the bytes are actually down
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    return chat;
  }

  async function readOne(id) {
    let raw;
    try {
      raw = await fs.readFile(fileFor(id));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    let parsed;
    try {
      parsed = await decode(raw);
    } catch (err) {
      // What unreadable bytes MEAN depends on the codec, so the codec decides.
      // Plain JSON: a truncated file — quarantine it and keep the store usable.
      // Encrypted: a wrong passphrase or a tampered file — and quietly skipping
      // either one is exactly how an encrypted store presents as an empty one.
      return onDecodeError(err, id, quarantine);
    }
    if (!isWellFormed(parsed)) {
      await quarantine(id);
      return null;
    }
    return parsed;
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
    const ids = names
      .filter((n) => n.endsWith(ext))
      .map((n) => n.slice(0, -ext.length))
      .filter((n) => ID_RE.test(n));
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
    async removeLastMessage(id) {
      assertId(id);
      return withLock(id, async () => {
        const chat = await readOne(id);
        if (!chat) throw notFound(id);
        if (chat.messages.length === 0) return chat;
        return writeAtomic(applyDropLast(chat));
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

/** Plain JSON on disk. Readable with any text editor, and unprotected. */
export function createJsonFileStore(dir) {
  return createFileStore(dir, {
    ext: JSON_EXT,
    encode: async (chat) => Buffer.from(JSON.stringify(chat, null, 2), 'utf8'),
    decode: async (bytes) => JSON.parse(bytes.toString('utf8')),
    async onDecodeError(err, id, quarantine) {
      // Only malformed JSON is a corrupt file. Anything else is a real fault
      // and pretending it is a bad chat would hide it.
      if (!(err instanceof SyntaxError)) throw err;
      await quarantine(id);
      return null;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Encrypted file adapter (opt-in)                                      */
/* ------------------------------------------------------------------ */

/**
 * The same store, with every file sealed under a passphrase. See chat-crypto.js
 * for the envelope; the only thing this layer adds is which salt new files get.
 *
 * **There is no recovery path.** The passphrase is not stored anywhere, by
 * design — a key kept beside the data it protects protects nothing. Forget it
 * and the chats are gone.
 *
 * Two deliberate absences:
 *
 *   - No fallback to plaintext. A file that will not decrypt raises, and keeps
 *     raising. An adapter that shrugged and read the plain copy instead would
 *     turn an encrypted store into an unencrypted one at the first hiccup.
 *   - No quarantine on a decryption failure. Under a mistyped passphrase EVERY
 *     file fails, and renaming the entire history to `.corrupt` on a typo is a
 *     worse outcome than the error the user came to see.
 *
 * @param {string} dir
 * @param {{ passphrase: string }} options
 */
export function createEncryptedFileStore(dir, { passphrase } = {}) {
  const box = createChatCrypto({ passphrase });
  let saltReady = null;

  /**
   * One salt for the folder, adopted from whatever is already in it.
   *
   * Per-file salts would be more orthodox, and would also mean one ~60 ms scrypt
   * per chat on every `list()`. Sharing the salt lets the key cache do its job.
   * The salt is still written into every file, so the folder stays readable if
   * any subset of it is copied elsewhere, and there is no separate key file
   * whose loss would take the history with it.
   */
  function storeSalt() {
    saltReady ??= (async () => {
      let names = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        /* a folder that does not exist yet simply has no salt to adopt */
      }
      for (const name of names.filter((n) => n.endsWith(ENC_EXT)).sort()) {
        const head = await readEnvelopeHead(path.join(dir, name));
        const salt = head && box.saltOf(head);
        if (salt) return salt;
      }
      return box.newSalt();
    })();
    return saltReady;
  }

  return createFileStore(dir, {
    ext: ENC_EXT,
    encode: async (chat) => box.seal(JSON.stringify(chat), await storeSalt()),
    decode: async (bytes) => JSON.parse(await box.open(bytes)),
    onDecodeError(err) {
      throw err;
    },
  });
}

/** Just the fixed-size head of an envelope — enough for the salt, no key needed. */
async function readEnvelopeHead(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(ENVELOPE_OVERHEAD);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return bytesRead === buf.length ? buf : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
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
    async removeLastMessage(id) {
      assertId(id);
      const chat = chats.get(id);
      if (!chat) throw notFound(id);
      if (chat.messages.length === 0) return structuredClone(chat);
      const next = applyDropLast(chat);
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
