/**
 * PromptLibrary — the handful of system prompts worth keeping.
 *
 * Interface:
 *   list()               -> Promise<Prompt[]>   newest first
 *   add({ name, text })  -> Promise<Prompt>
 *   remove(id)           -> Promise<boolean>
 *
 * One small JSON file, written the same way ChatStore writes a chat: encode,
 * fsync, rename. A crash halfway through saving a prompt must not be able to
 * take the whole library with it — the file either holds the old list or the
 * new one, never half of either.
 *
 * It deliberately does NOT live beside the chats as `<chatsDir>/prompts.json`:
 * ChatStore treats every `*.json` in that folder whose stem looks like an id as
 * a conversation, and quarantines the ones that do not parse as a chat. Its own
 * folder keeps the two stores from stepping on each other.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_NAME = 80;
const MAX_TEXT = 8000;
const MAX_PROMPTS = 200;

/** Where the library lives when nothing says otherwise. */
export function defaultPromptFile(chatsDir) {
  return path.join(chatsDir, 'library', 'prompts.json');
}

/**
 * A saved prompt has to be worth loading again: a nameless one is unfindable in
 * a list, and an empty one steers nothing. Both are refused rather than stored,
 * because a library of blanks is how a library stops being used.
 *
 * @returns {{ name: string, text: string } | null} null when it is not one
 */
export function normalisePrompt(input) {
  const name = String(input?.name ?? '').trim().slice(0, MAX_NAME);
  const text = String(input?.text ?? '').trim().slice(0, MAX_TEXT);
  if (!name || !text) return null;
  return { name, text };
}

export function createPromptLibrary({ file }) {
  if (!file) throw new Error('createPromptLibrary requires a file path');
  const dir = path.dirname(file);
  let chain = Promise.resolve();

  /** Serialise every write: two saves racing would lose one of them outright. */
  function withLock(fn) {
    const run = chain.then(fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async function read() {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // An unreadable library is an inconvenience; refusing to start over it
      // would make it an outage. Report empty and let the next save rebuild it.
      return [];
    }
    if (!Array.isArray(parsed?.prompts)) return [];
    return parsed.prompts.filter(
      (p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.text === 'string',
    );
  }

  async function write(prompts) {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const bytes = Buffer.from(JSON.stringify({ prompts }, null, 2), 'utf8');
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(bytes);
      await handle.sync(); // rename is only atomic once the bytes are down
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  }

  return {
    async list() {
      return read();
    },

    async add(input) {
      const clean = normalisePrompt(input);
      if (!clean) return null;
      return withLock(async () => {
        const prompts = await read();
        const prompt = {
          id: randomUUID().replace(/-/g, '').slice(0, 20),
          ...clean,
          createdAt: new Date().toISOString(),
        };
        // Newest first, and bounded: this is a convenience store, not an archive.
        await write([prompt, ...prompts].slice(0, MAX_PROMPTS));
        return prompt;
      });
    },

    async remove(id) {
      return withLock(async () => {
        const prompts = await read();
        const left = prompts.filter((p) => p.id !== id);
        if (left.length === prompts.length) return false;
        await write(left);
        return true;
      });
    },
  };
}
