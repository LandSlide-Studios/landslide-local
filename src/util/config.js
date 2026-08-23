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
  storage: { chatsDir: './chats', modelsDir: './models' },
  hardware: { vramTotalGb: 8, vramUsableGb: 6.65, label: 'local GPU' },
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
  if (env.LANDSLIDE_CHATS_DIR) cfg.storage.chatsDir = env.LANDSLIDE_CHATS_DIR;
  if (env.LANDSLIDE_MODELS_DIR) cfg.storage.modelsDir = env.LANDSLIDE_MODELS_DIR;

  cfg.storage.chatsDir = resolveFrom(ROOT, cfg.storage.chatsDir);
  cfg.storage.modelsDir = resolveFrom(ROOT, cfg.storage.modelsDir);

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
