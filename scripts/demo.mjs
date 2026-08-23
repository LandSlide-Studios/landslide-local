/**
 * Demo launcher — runs the full app against the fake runtime.
 *
 * Exists so the UI can be exercised end to end before any 23GB of GGUF has been
 * downloaded, and so a broken model server is never confused with a broken app.
 * Chats go to a scratch folder, not the real one.
 */

import path from 'node:path';
import { ROOT } from '../src/util/config.js';

process.env.LANDSLIDE_ADAPTER = 'fake';
process.env.LANDSLIDE_CHATS_DIR ??= path.join(ROOT, '.demo-chats');

const SCRIPT = [
  '<think>They want a short worked example. Keep the reasoning visible so the reasoning',
  ' panel and the timer both have something to show, then give a compact answer with a',
  ' code block so the code rendering path gets exercised too.</think>',
  'Here is a compact example.\n\n',
  '```js\n',
  'const total = items.reduce((a, b) => a + b.price, 0);\n',
  '```\n\n',
  'That sums a list of items by price. Swap `price` for whichever field you need.',
].join('');

const { createServer } = await import('../src/server.js');
const { server, config } = await createServer({
  runtime: { adapter: 'fake', delayMs: 18, chunkSize: 3, script: SCRIPT },
});
const { host, port } = config.server;

server.listen(port, host, () => {
  console.log(`\n  Landslide Local — DEMO (fake runtime, scripted replies)`);
  console.log(`  http://${host}:${port}`);
  console.log(`  chats -> ${config.storage.chatsDir}\n`);
});
