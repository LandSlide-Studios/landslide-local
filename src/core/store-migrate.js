/**
 * StoreMigrate — turning a folder of plain chat files into an encrypted one.
 *
 * This is the only code in the project that deletes a conversation, and it runs
 * against the user's real history. The whole design follows from one rule:
 *
 *   **Nothing is deleted until its replacement has been read back off the disk
 *   and found to be byte-identical.**
 *
 * So each file goes encrypt -> fsync -> rename -> re-open -> compare -> delete,
 * in that order, one file at a time. Every interruption point leaves a folder a
 * second run can finish:
 *
 *   crashed before the rename   the `.tmp` is orphaned, the plaintext is intact
 *   crashed after the rename    both files exist; the rerun verifies and deletes
 *   crashed during the wipe     the `.enc` is already verified; the rerun
 *                               finishes the delete it started
 *
 * The plaintext text is sealed verbatim rather than re-serialised from a parsed
 * object. A migration that reformats what it moves cannot prove it moved it: the
 * check that matters is `open(sealed) === the original text`, and that is only
 * available if nothing was rewritten on the way through.
 *
 * What it refuses to do:
 *
 *   - Overwrite an existing `.enc` that will not open under this passphrase.
 *     That file is somebody's chat under a different key; the plaintext beside
 *     it stays too, and both are reported.
 *   - Touch a `.json` it cannot parse, unless a verified `.enc` already stands
 *     in for it. A file we do not understand is not a file we may delete.
 *   - Touch quarantined `.corrupt` files. They still hold plaintext, so they are
 *     reported loudly — but they are also, by definition, the copy that already
 *     went wrong once, and deleting it is not this function's decision.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createChatCrypto } from './chat-crypto.js';
import { ENC_EXT, JSON_EXT, isChatId } from './chat-store.js';

/**
 * @param {{ dir: string, passphrase: string }} options
 * @returns {Promise<{
 *   dir: string, encrypted: string[], alreadyEncrypted: string[],
 *   unreadable: string[], conflicts: string[], leftBehind: string[]
 * }>}
 */
export async function migrateToEncrypted({ dir, passphrase } = {}) {
  if (!dir) throw new Error('migrateToEncrypted needs { dir }');
  // Throws on an empty passphrase, before a single file has been touched.
  const box = createChatCrypto({ passphrase });

  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no chats folder at ${dir}`);
    throw err;
  }

  const report = {
    dir,
    encrypted: [],
    alreadyEncrypted: [],
    unreadable: [],
    conflicts: [],
    leftBehind: [],
  };

  const salt = (await adoptSalt(dir, names, box)) ?? box.newSalt();

  // One at a time. Concurrency here would buy nothing on a folder this size and
  // would make the state after an interruption harder to reason about.
  for (const name of names.filter((n) => n.endsWith(JSON_EXT)).sort()) {
    const stem = name.slice(0, -JSON_EXT.length);
    if (!isChatId(stem)) {
      report.leftBehind.push(name);
      continue;
    }
    await migrateOne({ dir, stem, box, salt, report });
  }

  // Plaintext the store already gave up on. Still plaintext.
  for (const name of names.filter((n) => n.endsWith('.corrupt'))) report.leftBehind.push(name);

  return report;
}

async function migrateOne({ dir, stem, box, salt, report }) {
  const plainPath = path.join(dir, `${stem}${JSON_EXT}`);
  const encPath = path.join(dir, `${stem}${ENC_EXT}`);

  let raw;
  try {
    raw = await fs.readFile(plainPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return; // vanished between readdir and here
    throw err;
  }

  const parsed = tryParse(raw);
  const existing = await openExisting(encPath, box);

  if (existing.present) {
    if (!existing.text) {
      // An encrypted file we cannot read sitting next to a plaintext one. Either
      // could be the real chat. Guessing destroys one of them, so leave both.
      report.conflicts.push(`${stem}: an encrypted file exists but will not open under this passphrase`);
      return;
    }
    if (existing.text === raw || parsed === null) {
      // Same content, or plaintext we can no longer read while the encrypted
      // copy is fine — either way this file's move already completed.
      await wipe(plainPath);
      report.alreadyEncrypted.push(stem);
      return;
    }
    report.conflicts.push(`${stem}: the encrypted and plain copies differ — neither was touched`);
    return;
  }

  if (parsed === null) {
    // Unparseable plaintext with nothing standing in for it. Not ours to delete.
    report.unreadable.push(stem);
    return;
  }

  const sealed = await box.seal(raw, salt);
  await writeAtomic(encPath, sealed);

  // Read it back off the disk, not out of the variable we just wrote. This is
  // the line that makes the delete below safe, and it is worth the extra read.
  const verify = await openExisting(encPath, box);
  if (verify.text !== raw) {
    throw new Error(
      `refusing to delete ${stem}${JSON_EXT}: the encrypted copy did not read back identically`,
    );
  }

  await wipe(plainPath);
  report.encrypted.push(stem);
}

/** Reuse the salt already in the folder so the store pays for one key derivation. */
async function adoptSalt(dir, names, box) {
  for (const name of names.filter((n) => n.endsWith(ENC_EXT)).sort()) {
    const bytes = await fs.readFile(path.join(dir, name)).catch(() => null);
    const salt = bytes && box.saltOf(bytes);
    if (salt) return salt;
  }
  return null;
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** @returns {Promise<{present: boolean, text: string|null}>} */
async function openExisting(file, box) {
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { present: false, text: null };
    throw err;
  }
  try {
    return { present: true, text: await box.open(bytes) };
  } catch {
    return { present: true, text: null };
  }
}

async function writeAtomic(target, bytes) {
  const tmp = `${target}.${process.pid}.migrate.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync(); // the rename is only atomic if the bytes are down first
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, target);
}

/**
 * Overwrite, then unlink.
 *
 * The overwrite is best-effort and is honest about it: on an SSD the controller
 * may well have written the new bytes to a different block and left the old ones
 * readable to anything that can address the flash directly. It costs one write
 * and it does help on a spinning disk, so it is worth doing and not worth
 * believing in. Nothing here runs before the encrypted copy has been verified.
 */
async function wipe(file) {
  try {
    const { size } = await fs.stat(file);
    if (size > 0) {
      const handle = await fs.open(file, 'r+');
      try {
        await handle.write(randomBytes(size), 0, size, 0);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } catch {
    /* the unlink is what actually has to happen */
  }
  await fs.unlink(file).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}
