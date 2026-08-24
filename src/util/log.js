/**
 * Logger — an append-only file log that rotates at a size cap and never throws.
 *
 * Two properties matter more than features here:
 *
 *   1. It is bounded. A chat client left running for weeks would otherwise fill
 *      the drive the models live on. The active file is kept at or under
 *      `maxBytes`; older content moves to `app.log.1`, `.2`, `.3` and the oldest
 *      is dropped.
 *   2. It never throws, ever. A log line is not worth ending a conversation
 *      over, so every failure path here degrades to silence: a write error is
 *      swallowed, and a path that is not a regular file (a directory sitting
 *      where the file should be) disables the logger instead of raising.
 *
 * Writes are queued and drained on one serialised chain, so lines land in the
 * order they were made and two calls can never interleave inside a file. The
 * queue itself is capped — if the disk cannot keep up, old lines are dropped
 * rather than held in memory forever.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 3;
const MAX_QUEUED_LINES = 5000;
/** Consecutive write failures after which we stop trying. Nothing is retried forever. */
const MAX_FAILURES = 5;

const LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * @param {object} options
 * @param {string} [options.file]        where to write; omit for a no-op logger
 * @param {number} [options.maxBytes]    rotate once the active file would pass this
 * @param {number} [options.maxArchives] how many rotated files to keep
 * @param {string} [options.level]       lowest level that gets written
 */
export function createLogger(options = {}) {
  const file = options.file ? path.resolve(String(options.file)) : null;
  const maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxArchives = Math.max(0, Math.trunc(positive(options.maxArchives, DEFAULT_MAX_ARCHIVES)));
  const floor = Math.max(0, LEVELS.indexOf(options.level ?? 'info'));

  /** @type {Buffer[]} */
  const queue = [];
  let size = null; // bytes currently in the active file; null means "go and look"
  let chain = Promise.resolve();
  let disabled = !file;
  let failures = 0;
  let dirReady = null;

  const archiveName = (n) => `${file}.${n}`;

  function write(level, message, fields) {
    if (disabled || LEVELS.indexOf(level) < floor) return;
    try {
      queue.push(Buffer.from(format(level, message, fields), 'utf8'));
      if (queue.length > MAX_QUEUED_LINES) queue.splice(0, queue.length - MAX_QUEUED_LINES);
      kick();
    } catch {
      /* formatting or allocation failed — logging still must not throw */
    }
  }

  function kick() {
    chain = chain.then(drain).catch(() => {});
    return chain;
  }

  async function ensureDir() {
    dirReady ??= fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    return dirReady;
  }

  /** Size of the active log, or the string 'unusable' if that path is not ours to write. */
  async function activeSize() {
    try {
      const stat = await fs.stat(file);
      return stat.isFile() ? stat.size : 'unusable';
    } catch (err) {
      if (err?.code === 'ENOENT') return 0;
      return 'unusable';
    }
  }

  /**
   * Shift the archives along and move the active file into slot 1.
   *
   * The stat guard is the important line: if the configured path is a directory
   * (or anything else that is not a plain file) we return false and the logger
   * shuts itself off. Renaming it would move something of the user's.
   */
  async function rotate() {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return false;
    } catch (err) {
      if (err?.code === 'ENOENT') {
        size = 0;
        return true;
      }
      return false;
    }

    if (maxArchives === 0) {
      try {
        await fs.rm(file, { force: true });
      } catch {
        return false;
      }
      size = 0;
      return true;
    }

    try {
      await fs.rm(archiveName(maxArchives), { force: true });
    } catch {
      /* the oldest archive is expendable */
    }
    for (let i = maxArchives - 1; i >= 1; i--) {
      try {
        await fs.rename(archiveName(i), archiveName(i + 1));
      } catch {
        /* a gap in the series is not worth failing over */
      }
    }
    try {
      await fs.rename(file, archiveName(1));
    } catch {
      return false;
    }
    size = 0;
    return true;
  }

  async function drain() {
    if (disabled || queue.length === 0) return;
    await ensureDir();

    while (queue.length && !disabled) {
      if (size === null) {
        const current = await activeSize();
        if (current === 'unusable') {
          disabled = true;
          queue.length = 0;
          return;
        }
        size = current;
      }

      // Fill a batch that still fits under the cap. A single line longer than
      // the whole cap is written on its own to an empty file and rotated after.
      const batch = [];
      let bytes = 0;
      while (queue.length) {
        const next = queue[0];
        const fits = size + bytes + next.length <= maxBytes;
        const alone = size === 0 && bytes === 0;
        if (!fits && !alone) break;
        batch.push(queue.shift());
        bytes += next.length;
      }

      if (batch.length === 0) {
        if (!(await rotate())) {
          disabled = true;
          queue.length = 0;
          return;
        }
        continue;
      }

      try {
        await fs.appendFile(file, Buffer.concat(batch));
        size += bytes;
        failures = 0;
      } catch {
        // The batch is dropped: replaying it risks looping on a full disk.
        size = null;
        if (++failures >= MAX_FAILURES) {
          disabled = true;
          queue.length = 0;
          return;
        }
      }
    }
  }

  return {
    file,
    get enabled() {
      return !disabled;
    },
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    /** Resolves once everything queued so far is on disk (or has been given up on). */
    async flush() {
      for (let i = 0; i < 50 && queue.length && !disabled; i++) await kick();
      await chain.catch(() => {});
    },
  };
}

/* ------------------------------------------------------------------ */

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function format(level, message, fields) {
  const stamp = new Date().toISOString();
  const text = String(message ?? '').replace(/[\r\n]+/g, ' ');
  const extra = fields === undefined ? '' : ` ${safeJson(fields)}`;
  return `${stamp} ${level.toUpperCase().padEnd(5)} ${text}${extra}\n`;
}

/** A log line must survive a circular object or a BigInt without throwing. */
function safeJson(value) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    });
  } catch {
    return '"[unserialisable]"';
  }
}
