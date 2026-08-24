/**
 * ACCEPTANCE — I4 Security & privacy.
 *
 * Authored before the implementation. Locked; not the builder's to edit.
 *
 * The threat model is modest and specific: a personal machine, an app whose
 * contents are private by nature, and other local processes that are not this
 * app. Encryption is opt-in; when it is on it must actually be on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from '../../src/server.js';

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'ls-i4-'));

const SECRET = 'ZEBRA-QUOKKA-SEVENTEEN-marker';

async function readAllBytes(dir) {
  const out = [];
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(await fs.readFile(full));
    }
  };
  await walk(dir).catch(() => {});
  return Buffer.concat(out.length ? out : [Buffer.alloc(0)]);
}

/* ------------------------------------------------------------------ */
/* A. At-rest encryption                                                */
/* ------------------------------------------------------------------ */

test('I4-A1: an encrypted chat store adapter exists', async () => {
  const mod = await import('../../src/core/chat-store.js');
  assert.equal(
    typeof mod.createEncryptedFileStore,
    'function',
    'createEncryptedFileStore must be exported alongside the plain adapters',
  );
});

test('I4-A2: with encryption on, no message text appears anywhere on disk', async () => {
  const { createEncryptedFileStore } = await import('../../src/core/chat-store.js');
  const dir = await tmpDir();
  const store = createEncryptedFileStore(dir, { passphrase: 'correct horse battery staple' });

  const chat = await store.create({ title: 'private' });
  await store.appendMessage(chat.id, { role: 'user', content: `here is the ${SECRET} value` });
  await store.appendMessage(chat.id, { role: 'assistant', content: `I heard ${SECRET}` });

  const bytes = await readAllBytes(dir);
  assert.ok(!bytes.includes(SECRET), 'plaintext message content must not be present on disk');
  assert.ok(!bytes.includes('private'), 'the title is content too');

  await fs.rm(dir, { recursive: true, force: true });
});

test('I4-A3: the encrypted store round-trips through a fresh instance', async () => {
  const { createEncryptedFileStore } = await import('../../src/core/chat-store.js');
  const dir = await tmpDir();
  const pass = 'a passphrase that is long enough';

  const first = createEncryptedFileStore(dir, { passphrase: pass });
  const chat = await first.create({ title: 'kept' });
  await first.appendMessage(chat.id, { role: 'user', content: SECRET });

  const second = createEncryptedFileStore(dir, { passphrase: pass });
  const reread = await second.get(chat.id);
  assert.equal(reread.messages[0].content, SECRET, 'decryption must return exactly what went in');
  assert.equal((await second.list()).length, 1, 'listing must work over encrypted files');
  assert.equal((await second.search(SECRET)).length, 1, 'search must work over encrypted files');

  await fs.rm(dir, { recursive: true, force: true });
});

test('I4-A4: a wrong passphrase fails loudly and never returns garbage', async () => {
  const { createEncryptedFileStore } = await import('../../src/core/chat-store.js');
  const dir = await tmpDir();
  const good = createEncryptedFileStore(dir, { passphrase: 'the right one entirely' });
  const chat = await good.create({ title: 'x' });
  await good.appendMessage(chat.id, { role: 'user', content: SECRET });

  const bad = createEncryptedFileStore(dir, { passphrase: 'the wrong one entirely' });
  let threw = false;
  let value = null;
  try {
    value = await bad.get(chat.id);
  } catch {
    threw = true;
  }
  assert.ok(threw || value === null, 'a wrong passphrase must not yield a readable chat');
  if (value) assert.notEqual(value.messages?.[0]?.content, SECRET);

  await fs.rm(dir, { recursive: true, force: true });
});

test('I4-A5: ciphertext is authenticated — tampering is detected', async () => {
  const { createEncryptedFileStore } = await import('../../src/core/chat-store.js');
  const dir = await tmpDir();
  const pass = 'authenticate this properly';
  const store = createEncryptedFileStore(dir, { passphrase: pass });
  const chat = await store.create({ title: 'x' });
  await store.appendMessage(chat.id, { role: 'user', content: SECRET });

  const files = (await fs.readdir(dir)).filter((f) => !f.endsWith('.tmp'));
  const target = path.join(dir, files[0]);
  const buf = await fs.readFile(target);
  buf[Math.floor(buf.length * 0.8)] ^= 0xff; // flip a bit deep in the payload
  await fs.writeFile(target, buf);

  const fresh = createEncryptedFileStore(dir, { passphrase: pass });
  const got = await fresh.get(chat.id).catch(() => null);
  assert.ok(got === null || got.messages?.[0]?.content !== SECRET, 'tampered ciphertext must not decrypt cleanly');

  await fs.rm(dir, { recursive: true, force: true });
});

test('I4-A6: existing plaintext chats migrate without loss', async () => {
  const { createJsonFileStore, createEncryptedFileStore } = await import('../../src/core/chat-store.js');
  const dir = await tmpDir();
  const plain = createJsonFileStore(dir);
  const chat = await plain.create({ title: 'legacy' });
  await plain.appendMessage(chat.id, { role: 'user', content: SECRET });

  const mod = await import('../../src/core/store-migrate.js');
  assert.equal(typeof mod.migrateToEncrypted, 'function', 'a migration must be provided');
  await mod.migrateToEncrypted({ dir, passphrase: 'migrate me safely please' });

  const enc = createEncryptedFileStore(dir, { passphrase: 'migrate me safely please' });
  const got = await enc.get(chat.id);
  assert.equal(got.messages[0].content, SECRET, 'migrated content must be intact');
  const bytes = await readAllBytes(dir);
  assert.ok(!bytes.includes(SECRET), 'and the plaintext must be gone afterwards');

  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* B. Loopback auth token                                              */
/* ------------------------------------------------------------------ */

async function app(overrides) {
  const dir = await tmpDir();
  const { server, config } = await createServer({
    server: { port: 0 },
    runtime: { adapter: 'fake' },
    storage: { chatsDir: dir },
    ...overrides,
  });
  await new Promise((r) => server.listen(0, config.server.host, r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    config,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('I4-B1: with a token configured, an unauthenticated API request is refused', async () => {
  const a = await app({ security: { token: 'sekrit-token-value' } });
  const res = await fetch(`${a.base}/api/chats`);
  assert.equal(res.status, 401, 'no token means no data');
  await a.close();
});

test('I4-B2: the correct token is accepted, a wrong one is not', async () => {
  const a = await app({ security: { token: 'sekrit-token-value' } });
  const good = await fetch(`${a.base}/api/chats`, {
    headers: { authorization: 'Bearer sekrit-token-value' },
  });
  assert.equal(good.status, 200);
  const bad = await fetch(`${a.base}/api/chats`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);
  await a.close();
});

test('I4-B3: the UI itself still loads so the token can be supplied', async () => {
  const a = await app({ security: { token: 'sekrit-token-value' } });
  const page = await fetch(`${a.base}/`);
  assert.equal(page.status, 200, 'the app shell must be reachable to prompt for a token');
  await a.close();
});

test('I4-B4: with no token configured, nothing changes', async () => {
  const a = await app({});
  assert.equal((await fetch(`${a.base}/api/chats`)).status, 200, 'the token must stay opt-in');
  await a.close();
});

test('I4-B5: token comparison is constant-time', async () => {
  const files = ['src/server.js', 'src/api.js'];
  let found = false;
  for (const f of files) {
    const text = await fs.readFile(new URL(`../../${f}`, import.meta.url), 'utf8').catch(() => '');
    if (/timingSafeEqual/.test(text)) found = true;
  }
  if (!found) {
    for await (const f of (async function* w(d) {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) yield* w(full);
        else if (e.name.endsWith('.js')) yield full;
      }
    })(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', '..', 'src'))) {
      if (/timingSafeEqual/.test(await fs.readFile(f, 'utf8'))) found = true;
    }
  }
  assert.ok(found, 'secret comparison must use crypto.timingSafeEqual');
});

/* ------------------------------------------------------------------ */
/* C. Configuration hygiene                                            */
/* ------------------------------------------------------------------ */

test('I4-C1: a generated token is not committed in config.json', async () => {
  const cfg = JSON.parse(await fs.readFile(new URL('../../config.json', import.meta.url), 'utf8'));
  const token = cfg.security?.token ?? '';
  assert.equal(token, '', 'the shipped config must not carry a real secret');
});

test('I4-C2: encryption and token settings are documented', async () => {
  const readme = await fs.readFile(new URL('../../README.md', import.meta.url), 'utf8');
  assert.ok(/encrypt/i.test(readme), 'README must explain the encryption option');
  assert.ok(/token/i.test(readme), 'README must explain the token option');
});
