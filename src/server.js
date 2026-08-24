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
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig, ROOT } from './util/config.js';
import { createLogger } from './util/log.js';
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
  // Shallow-merging overrides drops sibling keys: {server:{port:0}} would lose
  // `host` and bind 0.0.0.0 on an app whose entire premise is loopback-only.
  const config = mergeConfig(loadConfig(), overrides);
  const log = createLogger({
    file: config.storage.logFile,
    maxBytes: config.storage.logMaxBytes,
  });
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

    // An Origin check alone does not stop DNS rebinding: a page on evil.example
    // whose name resolves to 127.0.0.1 is same-origin with itself, sends no
    // cross-origin Origin, and could read every chat on disk. What gives it away
    // is the Host header, which still says evil.example. Only loopback names are
    // accepted. (A request with no Host cannot have been rebound to one.)
    if (req.headers.host && !isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end('this server only answers to a loopback host name');
      return;
    }

    try {
      if (await api(req, res, url)) return;
      await serveStatic(req, res, url, log);
    } catch (err) {
      // The only record of a 500 used to be the browser's network tab, which is
      // gone the moment it is closed. The file is what makes a report actionable.
      log.error('request failed', { method: req.method, path: url.pathname, message: err.message });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`server error: ${err.message}`);
    }
  });

  return { server, config, store, runtime, log };
}

function mergeConfig(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeConfig(base[k] ?? {}, v) : v;
  }
  return out;
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopback(origin) {
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_NAMES.has(hostname) || LOOPBACK_NAMES.has(`[${hostname}]`);
  } catch {
    return false;
  }
}

/** A Host header is `name` or `name:port`, and may be a bracketed IPv6 literal. */
function isLoopbackHost(host) {
  const value = String(host).trim().toLowerCase();
  const name = value.startsWith('[')
    ? value.slice(0, value.indexOf(']') + 1)
    : value.split(':')[0];
  return LOOPBACK_NAMES.has(name);
}

async function serveStatic(req, res, url, log) {
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
  // .pipe() does not forward source errors, so a file vanishing or being locked
  // mid-read (git checkout, editor save, antivirus) became an uncaughtException
  // and killed the process. pipeline surfaces it to the caller's try/catch.
  try {
    await pipeline(createReadStream(target), res);
  } catch (err) {
    if (!res.writableEnded) res.destroy();
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error(`static read failed for ${path.basename(target)}: ${err.message}`);
      log?.error('static read failed', { file: path.basename(target), message: err.message });
    }
  }
}

/* Entry point ----------------------------------------------------- */

// On Windows a drive path becomes file://N:/... under naive string building while
// import.meta.url is file:///N:/... — they never match, so the whole startup block
// silently never ran and `npm start` exited 0 doing nothing. pathToFileURL is correct
// on every platform.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { server, config, log } = await createServer();
  const { host, port } = config.server;

  /**
   * Top-level guards.
   *
   * Without these, one rejected promise anywhere — an aborted fetch to Ollama,
   * a socket that went away mid-stream — takes the whole process down under
   * Node's default behaviour, ending every open conversation with it and
   * leaving nothing on disk to say why. A local single-user app should stay up
   * and write the reason down instead. Both handlers log; neither exits.
   */
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error('unhandled rejection', { message: err.message, stack: err.stack });
    console.error(`  [warn] unhandled rejection: ${err.message} (logged to ${config.storage.logFile})`);
  });

  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { message: err?.message ?? String(err), stack: err?.stack });
    console.error(`  [warn] uncaught exception: ${err?.message ?? err} (logged to ${config.storage.logFile})`);
  });

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
    console.log(`  log      ${config.storage.logFile || 'off'}`);
    console.log(`\n  Ctrl+C to stop.\n`);
    log.info('server started', {
      host,
      port,
      adapter: config.runtime.adapter,
      node: process.versions.node,
      pid: process.pid,
    });
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log.info('shutting down', { signal: sig });
      // Give the log a moment to reach disk, but never let it hold the exit.
      log.flush().finally(() => server.close(() => process.exit(0)));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
