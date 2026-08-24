/**
 * ACCEPTANCE — I3 MCP server.
 *
 * Authored before the implementation. Locked; not the builder's to edit.
 *
 * The server must speak real MCP over stdio with zero dependencies, so a Claude
 * client can call the local uncensored models as tools. Every test here drives
 * the actual process over its actual transport — nothing is imported and poked
 * at directly, because the thing being verified is the protocol.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'src', 'mcp', 'server.js');

/** A stub Ollama so these tests never depend on a real model being loaded. */
async function stubOllama(reply = 'LOCAL MODEL SAID THIS') {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/version') return res.writeHead(200).end(JSON.stringify({ version: 'stub' }));
      if (req.url === '/api/tags') {
        return res.writeHead(200).end(JSON.stringify({ models: [{ name: 'deckard-4b:latest', size: 1 }] }));
      }
      if (req.url === '/api/ps') return res.writeHead(200).end(JSON.stringify({ models: [] }));
      if (req.url === '/api/generate') return res.writeHead(200).end(JSON.stringify({ done: true }));
      if (req.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        return res.end(
          [
            JSON.stringify({ message: { content: reply } }),
            JSON.stringify({ done: true, eval_count: 3, eval_duration: 1e9 }),
          ].join('\n') + '\n',
        );
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/**
 * Speaks newline-delimited JSON-RPC to the MCP server over stdio.
 *
 * Fails immediately when the server file is absent. Spawning a path that does
 * not exist and then waiting on a reply that can never come turned this suite
 * into a hang that blocked every other gate — a red test is useful, a hung
 * runner is not.
 */
async function mcpClient({ ollamaUrl, chatsDir }) {
  if (!(await fs.stat(SERVER).then(() => true, () => false))) {
    throw new Error(`MCP server not implemented yet: ${path.relative(ROOT, SERVER)}`);
  }
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      LANDSLIDE_ADAPTER: 'ollama',
      LANDSLIDE_OLLAMA_URL: ollamaUrl,
      LANDSLIDE_CHATS_DIR: chatsDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  const pending = new Map();
  let nextId = 1;
  let stderr = '';

  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  return {
    stderr: () => stderr,
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout on ${method}; stderr: ${stderr.slice(0, 400)}`)),
          15_000,
        );
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    kill: () => child.kill(),
  };
}

async function harness(reply) {
  const stub = await stubOllama(reply);
  const chatsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-mcp-'));
  let client;
  try {
    client = await mcpClient({ ollamaUrl: stub.url, chatsDir });
  } catch (err) {
    // Do not leave a listening socket and a temp dir behind on the red path.
    await stub.close();
    await fs.rm(chatsDir, { recursive: true, force: true });
    throw err;
  }
  return {
    stub,
    client,
    chatsDir,
    async close() {
      client.kill();
      await stub.close();
      await fs.rm(chatsDir, { recursive: true, force: true });
    },
  };
}

const textOf = (result) =>
  (result?.content ?? []).map((c) => c.text ?? '').join('\n');

/* ------------------------------------------------------------------ */

test('I3-A1: the MCP server file exists and has no dependencies', async () => {
  const src = await fs.readFile(SERVER, 'utf8');
  assert.ok(src.length > 0);
  const bad = /from ['"](?!node:|\.\.?\/)/.exec(src);
  assert.equal(bad, null, `MCP server must import only node: builtins and local files, found: ${bad?.[0]}`);
});

test('I3-A2: initialize returns a protocol version and server info', async () => {
  const h = await harness();
  const res = await h.client.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'acceptance', version: '1' },
  });
  assert.ok(res.result, `initialize must return a result, got: ${JSON.stringify(res).slice(0, 300)}`);
  assert.ok(res.result.protocolVersion, 'a protocolVersion must be reported');
  assert.ok(res.result.serverInfo?.name, 'serverInfo.name must be reported');
  assert.ok(res.result.capabilities?.tools, 'the server must advertise tool capability');
  await h.close();
});

test('I3-A3: tools/list advertises the three tools with input schemas', async () => {
  const h = await harness();
  await h.client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  h.client.notify('notifications/initialized');
  const res = await h.client.call('tools/list');
  const names = (res.result?.tools ?? []).map((t) => t.name);
  for (const expected of ['ask_local_model', 'list_local_models', 'search_chats']) {
    assert.ok(names.includes(expected), `tools/list must include ${expected}; got ${names.join(', ')}`);
  }
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema?.type, 'object', `${t.name} must declare an object input schema`);
    assert.ok(t.description, `${t.name} must have a description`);
  }
  await h.close();
});

test('I3-A4: list_local_models returns the catalog', async () => {
  const h = await harness();
  await h.client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const res = await h.client.call('tools/call', { name: 'list_local_models', arguments: {} });
  const text = textOf(res.result);
  for (const id of ['cold-fusion-9b', 'deckard-4b', 'glm-flash-21b']) {
    assert.ok(text.includes(id), `${id} should be listed; got: ${text.slice(0, 300)}`);
  }
  await h.close();
});

test('I3-A5: ask_local_model returns a real completion from the runtime', async () => {
  const h = await harness('LOCAL MODEL SAID THIS');
  await h.client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const res = await h.client.call('tools/call', {
    name: 'ask_local_model',
    arguments: { model: 'deckard-4b', prompt: 'say something' },
  });
  assert.ok(!res.error, `tools/call errored: ${JSON.stringify(res.error)}`);
  assert.ok(
    textOf(res.result).includes('LOCAL MODEL SAID THIS'),
    `the model's answer must come back; got: ${JSON.stringify(res.result).slice(0, 300)}`,
  );
  await h.close();
});

test('I3-A6: ask_local_model refuses a model outside the catalog', async () => {
  const h = await harness();
  await h.client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const res = await h.client.call('tools/call', {
    name: 'ask_local_model',
    arguments: { model: 'dolphin-llama3:70b', prompt: 'hi' },
  });
  const failed = res.error != null || res.result?.isError === true;
  assert.ok(failed, 'an unknown model id must be refused, not silently run');
  await h.close();
});

test('I3-A7: a missing required argument is an error, not a crash', async () => {
  const h = await harness();
  await h.client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const res = await h.client.call('tools/call', { name: 'ask_local_model', arguments: {} });
  const failed = res.error != null || res.result?.isError === true;
  assert.ok(failed, 'a missing prompt must be reported');
  const still = await h.client.call('tools/list');
  assert.ok(still.result, 'the server must survive a bad call');
  await h.close();
});

test('I3-A8: an unknown tool name is an error, not a crash', async () => {
  const h = await harness();
  await h.client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const res = await h.client.call('tools/call', { name: 'rm_rf', arguments: {} });
  const failed = res.error != null || res.result?.isError === true;
  assert.ok(failed);
  await h.close();
});

test('I3-A9: search_chats finds a stored conversation', async () => {
  const h = await harness();
  const { createJsonFileStore } = await import('../../src/core/chat-store.js');
  const store = createJsonFileStore(h.chatsDir);
  const chat = await store.create({ title: 'roofing outreach' });
  await store.appendMessage(chat.id, { role: 'user', content: 'draft a cold email for roofers' });

  await h.client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const res = await h.client.call('tools/call', {
    name: 'search_chats',
    arguments: { query: 'roofers' },
  });
  assert.ok(textOf(res.result).toLowerCase().includes('roofing'), 'the matching chat must be found');
  await h.close();
});

test('I3-A10: malformed JSON on stdin does not kill the server', async () => {
  const h = await harness();
  await h.client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  h.client.notify('notifications/initialized');
  // Deliberately not valid JSON-RPC.
  const res = await h.client.call('tools/list');
  assert.ok(res.result, 'server still answers after junk input');
  await h.close();
});

test('I3-A11: nothing is written to stdout except JSON-RPC', async () => {
  // stdout is the transport; a stray console.log corrupts the protocol.
  const src = await fs.readFile(SERVER, 'utf8');
  assert.ok(
    !/console\.log/.test(src),
    'console.log writes to stdout and would corrupt the MCP stream — use stderr',
  );
});

test('I3-A12: the app documents how to register the server with a client', async () => {
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(/mcp/i.test(readme), 'README must explain how to wire the MCP server up');
});
