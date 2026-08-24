/**
 * ChatCrypto — the on-disk envelope for an encrypted chat, and nothing else.
 *
 * One job: turn a string into an authenticated, self-describing blob and back.
 * It knows nothing about chats, files or the store; the store knows nothing
 * about AES. Keeping the seam here is what makes the encrypted adapter a thin
 * codec swap rather than a second storage implementation.
 *
 * Scheme — AES-256-GCM over a scrypt-derived key. Nothing invented:
 *
 *   - scrypt(passphrase, salt, 32) with N=2^14, r=8, p=1. That is the standard
 *     interactive setting, costs ~16 MiB and ~60 ms per derivation, and stays
 *     inside node's default 32 MiB `maxmem` so no caller has to know to raise it.
 *   - A fresh 96-bit IV per file. Never reused, never derived from the content:
 *     an IV repeat under one key is what breaks GCM outright.
 *   - The 128-bit GCM tag is checked before a single plaintext byte is returned,
 *     and the whole header — version, KDF parameters, salt, IV — is fed in as
 *     additional authenticated data. Editing the salt to force a different key,
 *     or the parameters to weaken the KDF, fails the tag rather than quietly
 *     producing a different answer.
 *
 * The salt lives in every file it protects. A single salt file next to the chats
 * would be one deleted byte away from making the entire history unrecoverable,
 * and the salt is not a secret — only the passphrase is.
 *
 * There is no path out of here that returns unauthenticated bytes. A failure is
 * an `EDECRYPT` error, never a best-effort answer.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

const MAGIC = Buffer.from('LSENC1', 'latin1'); // 6 bytes, so a file is identifiable at a glance
const VERSION = 1;
const KDF_SCRYPT = 1;

export const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** What we write today. Files carry their own parameters, so this may move. */
export const KDF = { N: 16384, r: 8, p: 1 };

// magic | version | kdf | N | r | p | saltLen | salt | iv
const HEADER_BYTES = MAGIC.length + 1 + 1 + 4 + 1 + 1 + 1 + SALT_BYTES + IV_BYTES;

export const ENVELOPE_OVERHEAD = HEADER_BYTES + TAG_BYTES;

/** Callers need to tell "wrong passphrase or tampered" from "no such file". */
export function decryptionFailed(detail) {
  const err = new Error(
    `could not decrypt: ${detail}. The passphrase is wrong, or the file has been altered.`,
  );
  err.code = 'EDECRYPT';
  return err;
}

/**
 * Bounds on what a file may ask us to compute. A chat file is not hostile input
 * in this threat model, but "the parameters came out of the thing I am about to
 * decrypt" is exactly how a 30-second, multi-gigabyte scrypt gets requested.
 */
function readParams(buf, offset) {
  const N = buf.readUInt32BE(offset);
  const r = buf[offset + 4];
  const p = buf[offset + 5];
  const powerOfTwo = N >= 4096 && N <= 65536 && (N & (N - 1)) === 0;
  if (!powerOfTwo || r < 1 || r > 8 || p < 1 || p > 4) {
    throw decryptionFailed(`refusing implausible KDF parameters (N=${N}, r=${r}, p=${p})`);
  }
  return { N, r, p };
}

function deriveKey(passphrase, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    // 128 * N * r is the scrypt working set; the bounds above cap it at 64 MiB.
    scrypt(passphrase, salt, KEY_BYTES, { N, r, p, maxmem: 96 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * @param {{ passphrase: string }} options
 */
export function createChatCrypto({ passphrase } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error(
      'createChatCrypto needs a non-empty passphrase — refusing to seal with an empty key',
    );
  }

  /**
   * Derived keys, by salt and parameters. scrypt is deliberately slow, and a
   * store shares one salt across its files, so listing 200 chats would otherwise
   * pay for 200 derivations. The cache lives and dies with this instance.
   */
  const keys = new Map();

  function keyFor(salt, params) {
    const id = `${salt.toString('hex')}.${params.N}.${params.r}.${params.p}`;
    let pending = keys.get(id);
    if (!pending) {
      pending = deriveKey(passphrase, salt, params);
      // A rejected derivation must not be cached as the answer for next time.
      pending.catch(() => keys.delete(id));
      keys.set(id, pending);
    }
    return pending;
  }

  return {
    /** A salt for a store that has none yet. Public value; only the passphrase is secret. */
    newSalt() {
      return randomBytes(SALT_BYTES);
    },

    /** Is this one of ours at all? Cheap, and does not touch the key. */
    isEnvelope(buf) {
      return (
        Buffer.isBuffer(buf) &&
        buf.length >= ENVELOPE_OVERHEAD &&
        MAGIC.equals(buf.subarray(0, MAGIC.length))
      );
    },

    /**
     * The salt an existing file was written with, so a store can keep using it
     * instead of paying for another key derivation per salt in the folder.
     * @returns {Buffer|null}
     */
    saltOf(buf) {
      if (!this.isEnvelope(buf)) return null;
      const at = MAGIC.length + 1 + 1 + 4 + 1 + 1;
      if (buf[at] !== SALT_BYTES) return null;
      return Buffer.from(buf.subarray(at + 1, at + 1 + SALT_BYTES));
    },

    /**
     * @param {string} plaintext
     * @param {Buffer} salt
     * @returns {Promise<Buffer>}
     */
    async seal(plaintext, salt) {
      if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES) {
        throw new Error(`seal needs a ${SALT_BYTES}-byte salt`);
      }
      const iv = randomBytes(IV_BYTES);
      const header = Buffer.alloc(HEADER_BYTES);
      let at = 0;
      MAGIC.copy(header, at);
      at += MAGIC.length;
      header[at++] = VERSION;
      header[at++] = KDF_SCRYPT;
      header.writeUInt32BE(KDF.N, at);
      at += 4;
      header[at++] = KDF.r;
      header[at++] = KDF.p;
      header[at++] = SALT_BYTES;
      salt.copy(header, at);
      at += SALT_BYTES;
      iv.copy(header, at);

      const cipher = createCipheriv('aes-256-gcm', await keyFor(salt, KDF), iv);
      cipher.setAAD(header);
      const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
      return Buffer.concat([header, cipher.getAuthTag(), body]);
    },

    /**
     * @param {Buffer} buf
     * @returns {Promise<string>} the exact string that was sealed
     * @throws {Error} code EDECRYPT — never a partial or approximate answer
     */
    async open(buf) {
      if (!this.isEnvelope(buf)) throw decryptionFailed('not an encrypted chat file');
      let at = MAGIC.length;
      const version = buf[at++];
      const kdf = buf[at++];
      if (version !== VERSION) throw decryptionFailed(`unknown envelope version ${version}`);
      if (kdf !== KDF_SCRYPT) throw decryptionFailed(`unknown key derivation ${kdf}`);
      const params = readParams(buf, at);
      at += 6;
      if (buf[at++] !== SALT_BYTES) throw decryptionFailed('unexpected salt length');
      const salt = buf.subarray(at, at + SALT_BYTES);
      at += SALT_BYTES;
      const iv = buf.subarray(at, at + IV_BYTES);

      const decipher = createDecipheriv('aes-256-gcm', await keyFor(salt, params), iv);
      decipher.setAAD(buf.subarray(0, HEADER_BYTES));
      decipher.setAuthTag(buf.subarray(HEADER_BYTES, HEADER_BYTES + TAG_BYTES));
      try {
        const out = Buffer.concat([
          decipher.update(buf.subarray(HEADER_BYTES + TAG_BYTES)),
          // final() is where the tag is checked. Nothing below this line runs
          // for a file that was tampered with or a passphrase that is wrong.
          decipher.final(),
        ]);
        return out.toString('utf8');
      } catch (err) {
        throw decryptionFailed(err.message || 'authentication failed');
      }
    },
  };
}
