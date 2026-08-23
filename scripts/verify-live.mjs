/**
 * Live end-to-end check. Starts nothing, assumes nothing, and proves the whole
 * path works: Ollama is up, the model store is readable, and a real model
 * generates real tokens through this app's own API.
 *
 * Written to be run after a reboot, when the question is "does it still work"
 * and a green test suite is not an answer - the suite never touches a model.
 *
 *   node scripts/verify-live.mjs
 */

import { loadConfig } from '../src/util/config.js';
import { createRuntimeSupervisor } from '../src/core/runtime-supervisor.js';
import * as catalog from '../src/core/model-catalog.js';
import { createServer } from '../src/server.js';

const config = loadConfig();
const boss = createRuntimeSupervisor(config.runtime);
let failures = 0;

const ok = (name, detail = '') => console.log(`  [ ok ] ${name.padEnd(26)} ${detail}`);
const bad = (name, detail = '') => {
  failures += 1;
  console.log(`  [FAIL] ${name.padEnd(26)} ${detail}`);
};

console.log('\n  Landslide Local - live check\n');

/* 1. Runtime up, or start it. */
let status = await boss.status();
if (!status.running) {
  console.log('  ...Ollama is not running, starting it');
  const started = await boss.start();
  if (!started.ok) {
    bad('ollama', started.error);
    report();
  }
  status = await boss.status();
}
ok('ollama', `v${status.version}`);

/* 2. The store is readable and holds our models. */
const tags = await (await fetch(`${config.runtime.ollamaUrl}/api/tags`)).json();
const names = new Set((tags.models ?? []).map((m) => m.name));
const missing = catalog.all().filter((m) => !names.has(`${m.id}:latest`) && !names.has(m.id));
if (missing.length) bad('models registered', `missing: ${missing.map((m) => m.id).join(', ')}`);
else ok('models registered', `${catalog.all().length}/${catalog.all().length}, ${names.size} total in store`);

/* 3. The app's own server starts and serves. */
const { server, config: cfg } = await createServer({ server: { port: 0 } });
await new Promise((r) => server.listen(0, cfg.server.host, r));
const base = `http://127.0.0.1:${server.address().port}`;
const state = await (await fetch(`${base}/api/state`)).json();
if (state.ok && state.runtime.ok) ok('app server', `serving on ${cfg.server.host}`);
else bad('app server', JSON.stringify(state.runtime));

/* 4. A real model actually generates through the app. */
const probe = catalog.all().reduce((a, b) => (a.sizeGb <= b.sizeGb ? a : b)); // smallest = fastest
console.log(`  ...generating with ${probe.id} (this loads it into VRAM)`);
const made = await (
  await fetch(`${base}/api/chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'live check', modelId: probe.id }),
  })
).json();

const res = await fetch(`${base}/api/chats/${made.chat.id}/message`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: 'Reply with the single word: working', modelId: probe.id }),
});

let answer = '';
let stats = null;
const dec = new TextDecoder();
let buf = '';
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const e = JSON.parse(line.slice(6));
      if (e.type === 'answer') answer += e.text;
      else if (e.type === 'done') stats = e.stats;
      else if (e.type === 'error') bad('generation', e.message);
    }
  }
}

if (answer.trim()) ok('generation', `${stats?.tokens ?? '?'} tokens at ${stats?.tokensPerSecond ?? '?'} tok/s`);
else bad('generation', 'no output');

/* 5. It persisted. */
const after = await (await fetch(`${base}/api/chats/${made.chat.id}`)).json();
if (after.chat?.messages?.length === 2) ok('persisted to disk', cfg.storage.chatsDir);
else bad('persisted to disk', `expected 2 messages, got ${after.chat?.messages?.length}`);

await fetch(`${base}/api/chats/${made.chat.id}`, { method: 'DELETE' });
server.closeAllConnections();
await new Promise((r) => server.close(r));
report();

function report() {
  console.log(
    failures === 0
      ? '\n  Everything works.\n'
      : `\n  ${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
