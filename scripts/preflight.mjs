/**
 * Preflight — proves the claims this project makes about itself.
 *
 * The important one is OFFLINE: it greps every served asset for a reference to
 * an external host. A claim of "works with no internet" that nobody checked is
 * just a hope, and this is the check that would catch a stray CDN link.
 *
 *   node scripts/preflight.mjs
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/util/config.js';
import * as catalog from '../src/core/model-catalog.js';

const results = [];
const pass = (name, detail = '') => results.push({ level: 'PASS', name, detail });
const warn = (name, detail = '') => results.push({ level: 'WARN', name, detail });
const fail = (name, detail = '') => results.push({ level: 'FAIL', name, detail });

/* 1. Runtime -------------------------------------------------------- */
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) pass('node version', `v${process.versions.node}`);
else fail('node version', `v${process.versions.node} — needs 20 or newer`);

/* 2. Zero dependencies ---------------------------------------------- */
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
if (Object.keys(deps).length === 0) pass('zero dependencies', 'nothing to npm install');
else fail('zero dependencies', `found ${Object.keys(deps).join(', ')}`);

/* 3. Offline: no external hosts referenced anywhere we serve or run --- */
const EXTERNAL = /\b(?:https?:)?\/\/(?!127\.0\.0\.1|localhost\b)[a-z0-9.-]+\.[a-z]{2,}/gi;
const ALLOWED_FILES = new Set(['fetch-models.mjs', 'verify-urls.mjs']); // the only files that may reach out
const offenders = [];

for (const dir of ['public', 'src', 'scripts']) {
  for await (const file of walk(path.join(ROOT, dir))) {
    if (/\.(woff2|png|ico|svg|gguf)$/i.test(file)) continue;
    const text = await fs.readFile(file, 'utf8');
    for (const m of text.matchAll(EXTERNAL)) {
      offenders.push(`${path.relative(ROOT, file)} -> ${m[0]}`);
    }
  }
}
if (offenders.length === 0) {
  pass('offline', 'no external host referenced by any served or runtime file');
} else {
  fail('offline', offenders.join('; '));
}

/* 4. Fonts are local and real --------------------------------------- */
const fontDir = path.join(ROOT, 'public', 'fonts');
let fonts = [];
try {
  fonts = (await fs.readdir(fontDir)).filter((f) => f.endsWith('.woff2'));
} catch {
  /* handled below */
}
if (fonts.length === 0) {
  fail('fonts bundled', 'public/fonts holds no .woff2 — the UI would fall back to system fonts');
} else {
  let bad = 0;
  for (const f of fonts) {
    const head = (await fs.readFile(path.join(fontDir, f))).subarray(0, 4).toString('latin1');
    if (head !== 'wOF2') bad += 1;
  }
  if (bad === 0) pass('fonts bundled', `${fonts.length} valid woff2 files`);
  else fail('fonts bundled', `${bad} file(s) are not valid woff2`);
}

/* 5. Config is loadable and paths are sane --------------------------- */
let config;
try {
  config = loadConfig();
  pass('config', `port ${config.server.port}, adapter ${config.runtime.adapter}`);
} catch (err) {
  fail('config', err.message);
}

/* 6. Which models are actually available ---------------------------- */
if (config) {
  // The raw GGUF is deleted once Ollama has its own copy, so the registry -
  // not the models folder - is the source of truth for "do I have this".
  const registered = await ollamaTags(config);
  const missing = [];
  let rawBytes = 0;
  for (const m of catalog.all()) {
    const rawSize = await sizeOf(path.join(config.storage.modelsDir, m.file));
    rawBytes += rawSize;
    const have = registered.has(m.id) || registered.has(`${m.id}:latest`) || rawSize > 0;
    if (!have) missing.push(m.id);
  }
  const have = catalog.all().length - missing.length;
  const detail =
    `${have}/${catalog.all().length} available` +
    (rawBytes > 0 ? `; ${(rawBytes / 1024 ** 3).toFixed(2)} GiB of raw GGUF still on disk` : '');
  if (missing.length === 0) pass('models available', detail);
  else warn('models available', `${detail || `${have}/${catalog.all().length} available`}; missing: ${missing.join(', ')}`);

  if (rawBytes > 1024 ** 3 && have === catalog.all().length) {
    warn('raw GGUF duplicates', `run: node scripts/fetch-models.mjs --cleanup-raw`);
  }

  /* 7. Catalog flag check - NOT a behavioural claim ------------------ */
  // This only confirms nobody added a model marked censored. It cannot tell you
  // whether a model actually refuses; that is measured by check-uncensored.mjs,
  // which asks the models. Do not let this line stand in for that one.
  const censored = catalog.all().filter((m) => !m.uncensored);
  if (censored.length === 0) pass('catalog flagged uncensored', `${catalog.all().length} models (behaviour: check-uncensored.mjs)`);
  else fail('catalog flagged uncensored', `censored: ${censored.map((m) => m.id).join(', ')}`);

  /* 8. Is a model server reachable ---------------------------------- */
  const url =
    config.runtime.adapter === 'llamacpp'
      ? `${config.runtime.llamaCppUrl}/health`
      : `${config.runtime.ollamaUrl}/api/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const version = body.version ?? 'ok';
      pass('runtime reachable', `${config.runtime.adapter} ${version}`);
      if (config.runtime.adapter === 'ollama' && /^0\.[0-9]\./.test(String(body.version ?? ''))) {
        warn('ollama version', `${body.version} is too old for Qwen 3.5 — update Ollama`);
      }
    } else {
      warn('runtime reachable', `${url} returned ${res.status}`);
    }
  } catch {
    warn('runtime reachable', `${config.runtime.adapter} is not running (start it before chatting)`);
  }
}

/* Report ------------------------------------------------------------ */
console.log('\n  Landslide Local — preflight\n');
for (const r of results) {
  const mark = r.level === 'PASS' ? ' ok ' : r.level === 'WARN' ? 'warn' : 'FAIL';
  console.log(`  [${mark}] ${r.name.padEnd(22)} ${r.detail}`);
}
const fails = results.filter((r) => r.level === 'FAIL').length;
const warns = results.filter((r) => r.level === 'WARN').length;
console.log(`\n  ${results.length - fails - warns} passed, ${warns} warnings, ${fails} failures\n`);
process.exit(fails > 0 ? 1 : 0);

/* ------------------------------------------------------------------ */

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (!ALLOWED_FILES.has(e.name)) yield full;
  }
}

async function ollamaTags(config) {
  if (config.runtime.adapter === 'llamacpp') return new Set();
  try {
    const res = await fetch(`${config.runtime.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return new Set();
    const body = await res.json();
    return new Set((body.models ?? []).map((m) => m.name));
  } catch {
    return new Set();
  }
}

async function sizeOf(p) {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
