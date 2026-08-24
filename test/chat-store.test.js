import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEncryptedFileStore, createJsonFileStore, createMemoryStore, newId } from '../src/core/chat-store.js';

/**
 * One contract suite, run against all three adapters. If an adapter drifts from the
 * interface, the seam is what breaks — which is exactly what we want to catch.
 */
const adapters = [
  ['memory', async () => ({ store: createMemoryStore(), cleanup: async () => {} })],
  [
    'jsonfile',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-chats-'));
      return {
        store: createJsonFileStore(dir),
        dir,
        cleanup: () => fs.rm(dir, { recursive: true, force: true }),
      };
    },
  ],
  // The encrypted codec is a third live implementation of the same interface
  // and was the one adapter no contract test ran against, so every behaviour
  // pinned here was pinned for two of the three things that have to satisfy it.
  [
    'encrypted',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-chats-enc-'));
      return {
        store: createEncryptedFileStore(dir, { passphrase: 'contract-suite-passphrase' }),
        dir,
        cleanup: () => fs.rm(dir, { recursive: true, force: true }),
      };
    },
  ],
];

for (const [label, make] of adapters) {
  test(`[${label}] create returns a blank chat`, async () => {
    const { store, cleanup } = await make();
    const chat = await store.create({ modelId: 'cold-fusion-9b' });
    assert.match(chat.id, /^[A-Za-z0-9_-]{6,64}$/);
    assert.equal(chat.title, 'New chat');
    assert.equal(chat.modelId, 'cold-fusion-9b');
    assert.deepEqual(chat.messages, []);
    await cleanup();
  });

  test(`[${label}] a reply carries the model that wrote it, a user turn carries none`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({ modelId: 'cold-fusion-9b' });

    await store.appendMessage(id, { role: 'user', content: 'ask' });
    await store.appendMessage(id, { role: 'assistant', content: 'answer', modelId: 'deckard-4b' });
    // Written the way everything was before the field existed.
    await store.appendMessage(id, { role: 'assistant', content: 'older answer' });

    const read = await store.get(id);
    assert.equal(read.messages[0].modelId, null, 'a user turn has no author model');
    assert.equal(read.messages[1].modelId, 'deckard-4b', 'the reply keeps its own model');
    assert.equal(
      read.messages[2].modelId,
      null,
      'and an unstamped reply stays null rather than being backfilled from the chat, ' +
        'which is the whole point: the store does not know, and guessing is what broke this',
    );

    // The chat's own model is a different thing and moves independently.
    await store.updateChat(id, { modelId: 'auto-variable-2b' });
    const after = await store.get(id);
    assert.equal(after.modelId, 'auto-variable-2b');
    assert.equal(after.messages[1].modelId, 'deckard-4b', 'switching the chat must not rewrite authorship');

    await cleanup();
  });

  test(`[${label}] branch copies the chat up to one message and leaves the source alone`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({ title: 'the original', modelId: 'cold-fusion-9b' });
    await store.updateChat(id, { systemPrompt: 'be terse', options: { temperature: 0.4 } });
    await store.appendMessage(id, { role: 'user', content: 'q1' });
    await store.appendMessage(id, { role: 'assistant', content: 'a1', modelId: 'cold-fusion-9b' });
    await store.appendMessage(id, { role: 'user', content: 'q2' });
    await store.appendMessage(id, { role: 'assistant', content: 'a2', modelId: 'deckard-4b' });

    const source = await store.get(id);
    const forkPoint = source.messages[1].id; // the first reply
    const fork = await store.branch(id, forkPoint);

    assert.notEqual(fork.id, id, 'a branch is a different chat');
    assert.equal(fork.messages.length, 2, 'inclusive of the message branched at, and nothing after it');
    assert.deepEqual(
      fork.messages.map((m) => m.content),
      ['q1', 'a1'],
    );
    assert.equal(fork.messages[1].modelId, 'cold-fusion-9b', 'authorship comes with it');
    assert.equal(fork.messages[1].createdAt, source.messages[1].createdAt, 'and so does when it was said');
    assert.ok(
      fork.messages.every((m) => !source.messages.some((o) => o.id === m.id)),
      'message ids are reissued: two chats must not answer to one id',
    );

    // The settings are what make a branch a comparison rather than a fresh start.
    assert.equal(fork.modelId, 'cold-fusion-9b');
    assert.equal(fork.systemPrompt, 'be terse');
    assert.deepEqual(fork.options, { temperature: 0.4 });
    assert.deepEqual(fork.branchedFrom, { chatId: id, messageId: forkPoint });
    assert.match(fork.title, /\(branch\)$/);

    const after = await store.get(id);
    assert.deepEqual(after.messages, source.messages, 'the source must be untouched, message for message');
    assert.equal(after.title, 'the original');
    assert.equal((await store.list()).length, 2);
    await cleanup();
  });

  test(`[${label}] a fork of a long-titled chat is still distinguishable from it`, async () => {
    const { store, cleanup } = await make();
    // At the title cap. Appending the marker and THEN capping cut the marker
    // off instead of the title, and at exactly the cap the fork came out
    // byte-identical to its source.
    const long = 'T'.repeat(200);
    const { id } = await store.create({ title: long });
    await store.appendMessage(id, { role: 'user', content: 'q' });
    const only = (await store.get(id)).messages[0].id;

    const fork = await store.branch(id, only);
    const source = await store.get(id);
    assert.notEqual(fork.title, source.title, 'a fork you cannot tell from its source is not much of a fork');
    assert.ok(fork.title.endsWith(' (branch)'), `marker survived the cap; got "${fork.title}"`);
    assert.ok(fork.title.length <= 120, 'and the cap still holds');

    // And forking the fork does not stack markers.
    const twice = await store.branch(fork.id, fork.messages[0].id);
    assert.equal(twice.title.match(/\(branch\)/g).length, 1);
    await cleanup();
  });

  test(`[${label}] branch refuses a messageId that is not a string`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({ title: 'legacy shape' });
    await store.appendMessage(id, { role: 'user', content: 'a turn' });

    // `undefined === undefined` matched the first message of a chat written
    // before messages carried ids, so branch(undefined) produced a fork instead
    // of refusing. The store must not depend on one caller's guard.
    for (const bad of [undefined, null, 42, '', {}]) {
      await assert.rejects(
        () => store.branch(id, bad),
        (err) => err.code === 'ENOTFOUND_MESSAGE',
        `branch(${JSON.stringify(bad) ?? 'undefined'}) must be refused`,
      );
    }
    assert.equal((await store.list()).length, 1, 'and nothing may have been created');
    await cleanup();
  });

  test(`[${label}] branch refuses a message that is not in the chat`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({ title: 'x' });
    await store.appendMessage(id, { role: 'user', content: 'only turn' });
    const other = await store.create({ title: 'elsewhere' });
    await store.appendMessage(other.id, { role: 'user', content: 'a turn in a different chat' });
    const strangerId = (await store.get(other.id)).messages[0].id;

    for (const bad of ['nope', strangerId]) {
      await assert.rejects(
        () => store.branch(id, bad),
        (err) => err.code === 'ENOTFOUND_MESSAGE',
        `branching at ${bad} must be refused, not silently produce an empty chat`,
      );
    }
    assert.equal((await store.list()).length, 2, 'and must not have created anything');
    await assert.rejects(() => store.branch(newId(), 'whatever'), (err) => err.code === 'ENOTFOUND_CHAT');
    await cleanup();
  });

  test(`[${label}] round-trips a conversation`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({});
    await store.appendMessage(id, { role: 'user', content: 'why is the sky blue' });
    await store.appendMessage(id, {
      role: 'assistant',
      content: 'Rayleigh scattering.',
      thinking: 'recall optics',
      stats: { tokens: 12 },
    });
    const chat = await store.get(id);
    assert.equal(chat.messages.length, 2);
    assert.equal(chat.messages[0].content, 'why is the sky blue');
    assert.equal(chat.messages[1].thinking, 'recall optics');
    assert.deepEqual(chat.messages[1].stats, { tokens: 12 });
    await cleanup();
  });

  test(`[${label}] titles itself from the first user message`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({});
    await store.appendMessage(id, { role: 'user', content: '  Draft a cold email   for roofers ' });
    const chat = await store.get(id);
    assert.equal(chat.title, 'Draft a cold email for roofers');
    await store.appendMessage(id, { role: 'user', content: 'something else entirely' });
    assert.equal((await store.get(id)).title, 'Draft a cold email for roofers');
    await cleanup();
  });

  test(`[${label}] long titles are truncated`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({});
    await store.appendMessage(id, { role: 'user', content: 'x'.repeat(200) });
    const chat = await store.get(id);
    assert.ok(chat.title.length <= 51, `title too long: ${chat.title.length}`);
    assert.ok(chat.title.endsWith('...'));
    await cleanup();
  });

  test(`[${label}] list is newest first and carries a preview`, async () => {
    const { store, cleanup } = await make();
    const a = await store.create({ title: 'first' });
    await store.appendMessage(a.id, { role: 'user', content: 'alpha question' });
    const b = await store.create({ title: 'second' });
    await store.appendMessage(b.id, { role: 'user', content: 'beta question' });
    const list = await store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, b.id);
    assert.equal(list[0].preview, 'beta question');
    assert.equal(list[0].messageCount, 1);
    await cleanup();
  });

  test(`[${label}] rename and model change`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({});
    const renamed = await store.updateChat(id, { title: 'Client outreach', modelId: 'deckard-4b' });
    assert.equal(renamed.title, 'Client outreach');
    assert.equal(renamed.modelId, 'deckard-4b');
    await cleanup();
  });

  test(`[${label}] remove deletes and reports honestly`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({});
    assert.equal(await store.remove(id), true);
    assert.equal(await store.get(id), null);
    assert.equal(await store.remove(id), false);
    await cleanup();
  });

  test(`[${label}] search matches titles and message bodies`, async () => {
    const { store, cleanup } = await make();
    const a = await store.create({});
    await store.appendMessage(a.id, { role: 'user', content: 'tell me about roofing leads' });
    const b = await store.create({});
    await store.appendMessage(b.id, { role: 'user', content: 'write a haiku' });
    assert.equal((await store.search('ROOFING')).length, 1);
    assert.equal((await store.search('haiku'))[0].id, b.id);
    assert.equal((await store.search('   ')).length, 2);
    assert.equal((await store.search('nonexistent')).length, 0);
    await cleanup();
  });

  test(`[${label}] rejects malformed ids and messages`, async () => {
    const { store, cleanup } = await make();
    const { id } = await store.create({});
    await assert.rejects(() => store.get('../etc/passwd'), /invalid chat id/);
    await assert.rejects(() => store.get('x'), /invalid chat id/);
    await assert.rejects(() => store.appendMessage(id, { role: 'root', content: 'x' }), /invalid role/);
    await assert.rejects(() => store.appendMessage(id, { role: 'user', content: 42 }), /must be a string/);
    await cleanup();
  });

  test(`[${label}] unknown chat is null, not a throw`, async () => {
    const { store, cleanup } = await make();
    assert.equal(await store.get(newId()), null);
    await cleanup();
  });
}

/* Adapter-specific: durability behaviours only the file store can have. */

test('[jsonfile] survives a corrupt file by quarantining it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-corrupt-'));
  const store = createJsonFileStore(dir);
  const good = await store.create({ title: 'healthy' });
  await store.appendMessage(good.id, { role: 'user', content: 'still here' });
  const badId = newId();
  await fs.writeFile(path.join(dir, `${badId}.json`), '{ not json at all', 'utf8');

  const list = await store.list();
  assert.equal(list.length, 1, 'corrupt file must not appear in the list');
  assert.equal(list[0].id, good.id);
  const names = await fs.readdir(dir);
  assert.ok(names.includes(`${badId}.json.corrupt`), 'corrupt file should be quarantined');
  await fs.rm(dir, { recursive: true, force: true });
});

test('[jsonfile] leaves no temp files behind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-tmp-'));
  const store = createJsonFileStore(dir);
  const { id } = await store.create({});
  for (let i = 0; i < 5; i++) await store.appendMessage(id, { role: 'user', content: `m${i}` });
  const names = await fs.readdir(dir);
  assert.equal(names.filter((n) => n.endsWith('.tmp')).length, 0);
  assert.equal(names.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Restart durability, for every adapter that has a disk to restart from.
 *
 * It was jsonfile-only, which left it off the one adapter where it is load
 * bearing: the encrypted codec has to re-derive its key from a salt it adopts
 * out of an existing file. If that broke, every chat would be undecryptable on
 * the next launch and the suite would not have noticed.
 */
for (const [label, make] of adapters.filter(([name]) => name !== 'memory')) {
  test(`[${label}] chats persist across store instances`, async () => {
    const { store, dir, cleanup } = await make();
    const { id } = await store.create({ title: 'survives a restart', modelId: 'deckard-4b' });
    await store.appendMessage(id, { role: 'user', content: 'before the restart' });
    await store.appendMessage(id, { role: 'assistant', content: 'a reply', modelId: 'cold-fusion-9b' });

    // A second instance over the same folder is what a relaunch actually is.
    const reopened =
      label === 'encrypted'
        ? createEncryptedFileStore(dir, { passphrase: 'contract-suite-passphrase' })
        : createJsonFileStore(dir);
    const read = await reopened.get(id);
    assert.equal(read.title, 'survives a restart');
    assert.equal(read.messages.length, 2);
    assert.equal(read.messages[1].content, 'a reply');
    assert.equal(read.messages[1].modelId, 'cold-fusion-9b', 'attribution has to survive a restart too');
    assert.equal((await reopened.list()).length, 1);
    await cleanup();
  });
}
