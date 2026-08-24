/**
 * Live end-to-end check. Starts nothing, assumes nothing, and proves the whole
 * path works: Ollama is up, the model store is readable, and a real model
 * generates real tokens - and real reasoning - through this app's own API.
 *
 * Written to be run after a reboot, when the question is "does it still work"
 * and a green test suite is not an answer - the suite never touches a model.
 *
 * It checks the REASONING path on purpose. The worst bug this project has had
 * was a dropped `message.thinking` field: the reasoning arrived from the model,
 * never reached the page, and shipped past a green suite and a green preflight
 * because the fake adapter emits inline `<think>` tags and Ollama does not. A
 * live check that only looked for an answer would have waved it through too.
 * So the probe is a model that reasons, the stream is watched for `think`
 * events, and the saved message is re-read to confirm the reasoning survived
 * the trip to disk.
 *
 *   node scripts/verify-live.mjs                  the smallest reasoning model
 *   node scripts/verify-live.mjs cold-fusion-9b   a model named deliberately
 *   node scripts/verify-live.mjs --list           what may be named
 */

import { loadConfig } from '../src/util/config.js';
import { createRuntimeSupervisor } from '../src/core/runtime-supervisor.js';
import * as catalog from '../src/core/model-catalog.js';
import { createServer } from '../src/server.js';

/* Which model to prove ---------------------------------------------- */

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h') || args.includes('--list')) {
  console.log('\n  node scripts/verify-live.mjs [modelId]\n');
  for (const m of catalog.all()) {
    console.log(`    ${m.id.padEnd(22)} ${m.sizeGb} GB  ${m.thinks ? 'reasons' : 'no reasoning block'}`);
  }
  console.log('\n  With no argument, the smallest reasoning model is used.\n');
  process.exit(0);
}

const asked = args.find((a) => !a.startsWith('-'));
const smallest = (list) => list.reduce((a, b) => (a.sizeGb <= b.sizeGb ? a : b));
const thinkers = catalog.all().filter((m) => m.thinks);

let probe;
if (asked) {
  probe = catalog.get(asked);
  if (!probe) {
    console.log(`\n  Unknown model: ${asked}`);
    console.log(`  Have: ${catalog.all().map((m) => m.id).join(', ')}\n`);
    process.exit(1);
  }
} else {
  // Smallest = fastest, but only among the models that reason, because the
  // reasoning path is the one that broke silently.
  probe = smallest(thinkers.length ? thinkers : catalog.all());
}

const config = loadConfig();
const boss = createRuntimeSupervisor(config.runtime);
let failures = 0;

const ok = (name, detail = '') => console.log(`  [ ok ] ${name.padEnd(26)} ${detail}`);
const bad = (name, detail = '') => {
  failures += 1;
  console.log(`  [FAIL] ${name.padEnd(26)} ${detail}`);
};
const note = (name, detail = '') => console.log(`  [ -- ] ${name.padEnd(26)} ${detail}`);

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
  // Worth a moment of thought, so a reasoning model actually reasons, and short
  // enough that the answer is checkable.
  body: JSON.stringify({
    content: 'Work out 17 x 3 step by step, then reply with only the number.',
    modelId: probe.id,
  }),
});

let answer = '';
let reasoning = '';
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
      else if (e.type === 'think') reasoning += e.text;
      else if (e.type === 'done') stats = e.stats;
      else if (e.type === 'error') bad('generation', e.message);
    }
  }
}

if (answer.trim()) ok('generation', `${stats?.tokens ?? '?'} tokens at ${stats?.tokensPerSecond ?? '?'} tok/s`);
else bad('generation', 'no output');

/* 5. The reasoning path, checked rather than assumed. */
if (probe.thinks) {
  if (reasoning.trim()) ok('reasoning streamed', `${reasoning.length} chars of think events`);
  else {
    bad(
      'reasoning streamed',
      `${probe.id} reasons, but no think event arrived - the thinking field is being dropped`,
    );
  }
} else {
  note('reasoning streamed', `${probe.id} has no reasoning block; name a thinking model to check that path`);
}

if (/<\/?think>/.test(answer)) bad('reasoning separated', 'a reasoning tag reached the answer text');
else ok('reasoning separated', 'no reasoning tag in the answer');

/* 6. It persisted - reasoning included. */
const after = await (await fetch(`${base}/api/chats/${made.chat.id}`)).json();
const saved = after.chat?.messages ?? [];
if (saved.length === 2) ok('persisted to disk', cfg.storage.chatsDir);
else bad('persisted to disk', `expected 2 messages, got ${saved.length}`);

if (probe.thinks) {
  // The exact shape of the worst bug this project has had: reasoning that
  // streamed fine and then was not on the message that got saved, so it
  // vanished on the next reload.
  if (saved[1]?.thinking?.trim()) ok('reasoning persisted', `${saved[1].thinking.length} chars survived the save`);
  else bad('reasoning persisted', 'the saved message carries no thinking - it will be gone after a reload');
}

await fetch(`${base}/api/chats/${made.chat.id}`, { method: 'DELETE' });
server.closeAllConnections();
await new Promise((r) => server.close(r));
report();

function report() {
  console.log(
    failures === 0
      ? `\n  Everything works (checked with ${probe.id}).\n`
      : `\n  ${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
