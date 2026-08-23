/**
 * Server — binds the modules together and serves the UI. Loopback only.
 *
 * Nothing here talks to a model or a chat file directly; it wires ChatStore and
 * InferenceRuntime into the API and serves ./public. Static serving is
 * deliberately paranoid about paths even though this only listens on 127.0.0.1.
 */

import http from 'node:http';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { loadConfig, ROOT } from './util/config.js';
import { createJsonFileStore } from './core/chat-store.js';
import { createRuntime } from './runtime/index.js';
import { createApi } from './api.js';

const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function createServer(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = createJsonFileStore(config.storage.chatsDir);
  const runtime = createRuntime(config.runtime);
  const api = createApi({ store, runtime, config });

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${config.server.host}`);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // Local-only app: reject cross-origin form posts outright.
    const origin = req.headers.origin;
    if (origin && !isLoopback(origin)) {
      res.writeHead(403).end('cross-origin requests are not accepted');
      return;
    }

    try {
      if (await api(req, res, url)) return;
      await serveStatic(req, res, url);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`server error: ${err.message}`);
    }
  });

  return { server, config, store, runtime };
}

function isLoopback(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }

  const requested = decodeURIComponent(url.pathname);
  const rel = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);

  // Containment check: resolve first, then confirm the result is still inside.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(403).end('forbidden');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

/* Entry point ----------------------------------------------------- */

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (isMain) {
  const { server, config } = await createServer();
  const { host, port } = config.server;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${port} is already in use.`);
      console.error(`  Either the app is already running, or change "server.port" in config.json.\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    console.log(`\n  Landslide Local`);
    console.log(`  ---------------`);
    console.log(`  UI       http://${host}:${port}`);
    console.log(`  runtime  ${config.runtime.adapter}`);
    console.log(`  chats    ${config.storage.chatsDir}`);
    console.log(`  models   ${config.storage.modelsDir}`);
    console.log(`\n  Ctrl+C to stop.\n`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
