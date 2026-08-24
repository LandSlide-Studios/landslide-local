/**
 * Which ChatStore this process opens.
 *
 * One function, used by both entry points. The HTTP server and the MCP server
 * read the same folder, and a version of this decision in each of them is a
 * version of this decision that can disagree — the MCP server happily listing
 * plaintext chats out of a folder the app is writing encrypted.
 *
 * The passphrase comes from the environment and is deliberately NOT a config
 * field. A key stored beside the data it protects protects nothing, and a
 * config object is one `JSON.stringify` away from the log file.
 *
 * The two knobs, and why they are shaped this way:
 *
 *   LANDSLIDE_PASSPHRASE set        -> encrypted, whatever the config says.
 *   security.encryptChats, no key   -> refuse to start.
 *
 * Both rules point the same direction: the failure mode that must never happen
 * is a user who believes their chats are encrypted while this process quietly
 * writes plain files. Erring toward "encrypted" costs a visible error at worst;
 * erring the other way is silent and unrecoverable after the fact.
 */

import { promises as fs } from 'node:fs';
import { createEncryptedFileStore, createJsonFileStore, JSON_EXT } from './chat-store.js';

export const PASSPHRASE_ENV = 'LANDSLIDE_PASSPHRASE';

/**
 * @param {object} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ store: object, encrypted: boolean, dir: string }}
 */
export function openChatStore(config, env = process.env) {
  const dir = config.storage.chatsDir;
  const passphrase = String(env[PASSPHRASE_ENV] ?? '');

  if (!passphrase) {
    if (config.security?.encryptChats === true) {
      throw new Error(
        `security.encryptChats is on but ${PASSPHRASE_ENV} is not set. ` +
          `Refusing to start: opening ${dir} as plain files here would write every ` +
          `conversation unencrypted without telling you.`,
      );
    }
    return { store: createJsonFileStore(dir), encrypted: false, dir };
  }

  return { store: createEncryptedFileStore(dir, { passphrase }), encrypted: true, dir };
}

/**
 * Plain chat files sitting in a folder now being read encrypted. They are not
 * lost and nothing has touched them — but they are invisible to the running
 * app, and "where did my chats go" deserves a better answer than an empty list.
 *
 * @returns {Promise<number>}
 */
export async function countPlaintextChats(dir) {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith(JSON_EXT)).length;
  } catch {
    return 0;
  }
}
