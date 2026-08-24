/**
 * Config — one place that knows where things live and what the machine can do.
 *
 * Resolution order: config.json next to the project root, then environment
 * overrides, then defaults. Relative storage paths resolve against the project
 * root so the app can be moved between drives without editing anything.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 4390 },
  runtime: {
    adapter: 'ollama',
    ollamaUrl: 'http://127.0.0.1:11434',
    llamaCppUrl: 'http://127.0.0.1:8080',
  },
  // logFile is relative on purpose: it resolves against the project root, so a
  // copy of this folder on another drive logs next to itself with nothing to edit.
  storage: {
    chatsDir: './chats',
    modelsDir: './models',
    logFile: './logs/app.log',
    logMaxBytes: 2 * 1024 * 1024,
  },
  hardware: { vramTotalGb: 8, vramUsableGb: 6.65, label: 'local GPU' },
  /**
   * Both off unless asked for. `token` is the bearer token the API requires
   * once it is non-empty; `encryptChats` only asserts that encryption is
   * expected, so a missing passphrase is an error instead of a silent
   * downgrade. The passphrase itself is never a config field — it comes from
   * LANDSLIDE_PASSPHRASE. See core/store-open.js.
   */
  security: { token: '', encryptChats: false },
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig({ file = path.join(ROOT, 'config.json'), env = process.env } = {}) {
  let onDisk = {};
  try {
    onDisk = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`config.json is not valid JSON: ${err.message}`);
    }
  }

  const cfg = deepMerge(DEFAULTS, onDisk);

  if (env.LANDSLIDE_PORT) cfg.server.port = Number(env.LANDSLIDE_PORT);
  if (env.LANDSLIDE_ADAPTER) cfg.runtime.adapter = env.LANDSLIDE_ADAPTER;
  if (env.LANDSLIDE_OLLAMA_URL) cfg.runtime.ollamaUrl = env.LANDSLIDE_OLLAMA_URL;
  if (env.LANDSLIDE_CHATS_DIR) cfg.storage.chatsDir = env.LANDSLIDE_CHATS_DIR;
  if (env.LANDSLIDE_MODELS_DIR) cfg.storage.modelsDir = env.LANDSLIDE_MODELS_DIR;
  if (env.LANDSLIDE_LOG_FILE) cfg.storage.logFile = env.LANDSLIDE_LOG_FILE;
  // So the token can be kept out of config.json entirely if you would rather it
  // not sit in a file. LANDSLIDE_PASSPHRASE has no equivalent line on purpose:
  // it must never reach the config object at all.
  if (env.LANDSLIDE_TOKEN) cfg.security.token = env.LANDSLIDE_TOKEN;

  cfg.storage.chatsDir = resolveFrom(ROOT, cfg.storage.chatsDir);
  cfg.storage.modelsDir = resolveFrom(ROOT, cfg.storage.modelsDir);
  // An empty logFile is a deliberate "log nowhere", not a path to the root.
  cfg.storage.logFile = cfg.storage.logFile ? resolveFrom(ROOT, cfg.storage.logFile) : '';

  if (!Number.isFinite(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) {
    throw new Error(`invalid server port: ${cfg.server.port}`);
  }
  return cfg;
}

/** Absolute paths (including Windows drive paths) pass through untouched. */
function resolveFrom(root, target) {
  if (!target) return root;
  if (path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) return path.normalize(target);
  return path.resolve(root, target);
}
