/**
 * ChatStore — durable conversation storage.
 *
 * Adapters: `json` (plain files), `encrypted` (the same files, sealed under a
 * passphrase) and `memory`. All three satisfy the interface exactly; the two
 * file-backed ones are literally the same function with a different codec, and
 * all three apply the same record rules, which live in `chat-record.js` so that
 * an adapter gets them by composition rather than by remembering to.
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
import { createChatCrypto, ENVELOPE_OVERHEAD } from './chat-crypto.js';
import {
  ID_RE,
  applyAppend,
  applyDropLast,
  applyPatch,
  assertId,
  blankChat,
  byNewest,
  createSerializer,
  isWellFormed,
  matches,
  normaliseMessage,
  notFound,
  toMeta,
} from './chat-record.js';

/** The two on-disk shapes. Nothing else in the chats folder is a chat. */
export const JSON_EXT = '.json';
export const ENC_EXT = '.enc';

let tmpCounter = 0;

// The record rules are part of this module's published surface: `store-migrate`,
// `store-open` and the tests reach for them here, and moving the definitions to
// their own file is not a reason to make every caller learn a second path.
export { isChatId, newId, notFound } from './chat-record.js';

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
