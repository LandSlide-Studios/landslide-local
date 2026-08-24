/**
 * ACCEPTANCE — I6 Reliability & ops.
 *
 * Authored before the implementation. Locked; not the builder's to edit.
 *
 * The bar: a restore must return exactly what was backed up, a log must not grow
 * without bound, and anything installed into the user's machine must be
 * removable by the same tool that installed it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'ls-i6-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

/* ------------------------------------------------------------------ */
/* A. Logging                                                           */
/* ------------------------------------------------------------------ */

test('I6-A1: a logger module exists and writes to a file', async () => {
  const mod = await import('../../src/util/log.js');
  assert.equal(typeof mod.createLogger, 'function', 'createLogger must be exported');

  const dir = await tmpDir();
  const file = path.join(dir, 'app.log');
  const log = mod.createLogger({ file, maxBytes: 1024 * 1024 });
  log.info('hello from the acceptance suite');
  await log.flush?.();
  await new Promise((r) => setTimeout(r, 50));

  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes('hello from the acceptance suite'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('I6-A2: the log rotates at its size cap instead of growing forever', async () => {
  const { createLogger } = await import('../../src/util/log.js');
  const dir = await tmpDir();
  const file = path.join(dir, 'app.log');
  const log = createLogger({ file, maxBytes: 4096 });

  for (let i = 0; i < 500; i++) log.info(`line ${i} ${'padding '.repeat(20)}`);
  await log.flush?.();
  await new Promise((r) => setTimeout(r, 120));

  const entries = await fs.readdir(dir);
  const current = await fs.stat(file);
  assert.ok(current.size <= 4096 * 2, `active log is ${current.size} bytes; cap was 4096`);
  assert.ok(entries.length > 1, `rotation must produce an archive; found: ${entries.join(', ')}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('I6-A3: a logger failure never takes the app down', async () => {
  const { createLogger } = await import('../../src/util/log.js');
  // A path that cannot be written: a directory where a file should be.
  const dir = await tmpDir();
  const bogus = path.join(dir, 'as-a-directory');
  await fs.mkdir(bogus);
  const log = createLogger({ file: bogus, maxBytes: 1024 });
  assert.doesNotThrow(() => log.info('this must not throw'), 'logging is not worth crashing over');
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* B. Backup and restore                                                */
/* ------------------------------------------------------------------ */

test('I6-B1: backup and restore round-trip byte-identical content', async () => {
  const mod = await import('../../src/core/backup.js');
  assert.equal(typeof mod.createBackup, 'function');
  assert.equal(typeof mod.restoreBackup, 'function');

  const { createJsonFileStore } = await import('../../src/core/chat-store.js');
  const src = await tmpDir();
  const store = createJsonFileStore(src);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const c = await store.create({ title: `chat ${i}` });
    await store.appendMessage(c.id, { role: 'user', content: `content ${i} éü中` });
    ids.push(c.id);
  }

  const before = {};
  for (const f of await fs.readdir(src)) before[f] = sha(await fs.readFile(path.join(src, f)));

  const out = await tmpDir();
  const archive = path.join(out, 'backup.lsb');
  await mod.createBackup({ chatsDir: src, target: archive });
  assert.ok((await fs.stat(archive)).size > 0, 'the archive must not be empty');

  const dest = await tmpDir();
  await mod.restoreBackup({ archive, chatsDir: dest });

  const after = {};
  for (const f of await fs.readdir(dest)) after[f] = sha(await fs.readFile(path.join(dest, f)));
  assert.deepEqual(after, before, 'restore must reproduce every file byte for byte');

  const restored = createJsonFileStore(dest);
  assert.equal((await restored.list()).length, 5);

  for (const d of [src, out, dest]) await fs.rm(d, { recursive: true, force: true });
});

test('I6-B2: restore refuses to silently overwrite a non-empty target', async () => {
  const mod = await import('../../src/core/backup.js');
  const { createJsonFileStore } = await import('../../src/core/chat-store.js');

  const src = await tmpDir();
  const s = createJsonFileStore(src);
  const c = await s.create({ title: 'original' });
  await s.appendMessage(c.id, { role: 'user', content: 'keep me' });

  const out = await tmpDir();
  const archive = path.join(out, 'b.lsb');
  await mod.createBackup({ chatsDir: src, target: archive });

  const occupied = await tmpDir();
  const other = createJsonFileStore(occupied);
  const existing = await other.create({ title: 'PRE-EXISTING' });
  await other.appendMessage(existing.id, { role: 'user', content: 'DO NOT LOSE ME' });

  let refused = false;
  try {
    await mod.restoreBackup({ archive, chatsDir: occupied });
  } catch {
    refused = true;
  }
  if (!refused) {
    const still = await other.get(existing.id);
    assert.ok(still, 'if restore proceeds it must not destroy existing chats without being told to');
  }

  for (const d of [src, out, occupied]) await fs.rm(d, { recursive: true, force: true });
});

test('I6-B3: a corrupt archive is rejected rather than half-restored', async () => {
  const mod = await import('../../src/core/backup.js');
  const out = await tmpDir();
  const archive = path.join(out, 'broken.lsb');
  await fs.writeFile(archive, Buffer.from('this is not an archive at all'), 'utf8');

  const dest = await tmpDir();
  let threw = false;
  try {
    await mod.restoreBackup({ archive, chatsDir: dest });
  } catch {
    threw = true;
  }
  assert.ok(threw, 'a corrupt archive must be rejected');
  const left = await fs.readdir(dest);
  assert.equal(left.length, 0, 'and must leave nothing behind');

  for (const d of [out, dest]) await fs.rm(d, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* C. Start on login — installable and, crucially, removable            */
/* ------------------------------------------------------------------ */

test('I6-C1: an autostart module reports status without changing anything', async () => {
  const mod = await import('../../src/core/autostart.js');
  for (const fn of ['status', 'install', 'uninstall']) {
    assert.equal(typeof mod[fn], 'function', `autostart.${fn} must exist`);
  }
  const before = await mod.status();
  assert.equal(typeof before.installed, 'boolean', 'status must report whether it is installed');
  const again = await mod.status();
  assert.equal(again.installed, before.installed, 'status must have no side effects');
});

test('I6-C2: install then uninstall leaves the machine as it was', async () => {
  const mod = await import('../../src/core/autostart.js');
  const before = await mod.status();

  if (before.installed) {
    assert.ok(true, 'already installed by the user; not touching it');
    return;
  }

  const installed = await mod.install();
  try {
    assert.equal(installed.ok, true, `install failed: ${installed.error ?? ''}`);
    assert.equal((await mod.status()).installed, true, 'status must reflect the install');
  } finally {
    const removed = await mod.uninstall();
    assert.equal(removed.ok, true, 'uninstall must succeed');
    assert.equal((await mod.status()).installed, false, 'and must leave nothing behind');
  }
});

test('I6-C3: uninstalling when nothing is installed is not an error', async () => {
  const mod = await import('../../src/core/autostart.js');
  if ((await mod.status()).installed) return;
  const r = await mod.uninstall();
  assert.equal(r.ok, true, 'a no-op uninstall must succeed quietly');
});

/* ------------------------------------------------------------------ */
/* D. The server survives what it should                                */
/* ------------------------------------------------------------------ */

test('I6-D1: an unhandled rejection is logged, not fatal', async () => {
  const files = [];
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.js')) files.push(full);
    }
  };
  await walk(new URL('../../src/', import.meta.url).pathname.slice(1));
  let guarded = false;
  for (const f of files) {
    const text = await fs.readFile(f, 'utf8');
    if (/unhandledRejection|uncaughtException/.test(text)) guarded = true;
  }
  assert.ok(guarded, 'the process must install a top-level guard so one stray rejection cannot end the session');
});
