/**
 * ACCEPTANCE — I2 Architecture.
 *
 * Authored before the implementation. Locked; not the builder's to edit.
 *
 * Structure is only worth changing if the change is checkable. Each test below
 * pins a property a maintainer would actually notice losing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function* walk(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith('.js')) yield full;
  }
}

async function sourceFiles() {
  const out = [];
  for (const d of ['src', 'public']) for await (const f of walk(path.join(ROOT, d))) out.push(f);
  return out;
}

/* ------------------------------------------------------------------ */
/* A. The catalog becomes data                                          */
/* ------------------------------------------------------------------ */

test('I2-A1: models are defined in a data file, not in source', async () => {
  const json = path.join(ROOT, 'models.json');
  const raw = await fs.readFile(json, 'utf8');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.models;
  assert.ok(Array.isArray(list), 'models.json must hold an array of models');
  assert.equal(list.length, 5, 'the five shipped models live there');
});

test('I2-A2: model-catalog.js is a loader, not a hardcoded list', async () => {
  const src = await fs.readFile(path.join(ROOT, 'src', 'core', 'model-catalog.js'), 'utf8');
  assert.ok(
    !/cold-fusion-9b/.test(src),
    'a model id hardcoded in the loader means adding a model still needs a source edit',
  );
  assert.ok(/models\.json/.test(src), 'the loader must read models.json');
});

test('I2-A3: a model added to the data file appears without touching source', async () => {
  const jsonPath = path.join(ROOT, 'models.json');
  const original = await fs.readFile(jsonPath, 'utf8');
  const parsed = JSON.parse(original);
  const list = Array.isArray(parsed) ? parsed : parsed.models;

  const added = {
    ...structuredClone(list[0]),
    id: 'acceptance-probe-model',
    name: 'Acceptance Probe',
  };
  const next = Array.isArray(parsed) ? [...list, added] : { ...parsed, models: [...list, added] };

  const backup = path.join(os.tmpdir(), `models-backup-${process.pid}.json`);
  await fs.writeFile(backup, original, 'utf8');
  try {
    await fs.writeFile(jsonPath, JSON.stringify(next, null, 2), 'utf8');
    // A fresh process must see it — module caches would mask a static import.
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        // file:/// is required: a Windows drive letter parses as a URL scheme and
        // Node's ESM loader accepts only file:, data: and node:. I2-C1 fifty lines
        // below gets this right; this line did not, so no implementation could ever
        // have satisfied it.
        `import('file:///${path.join(ROOT, 'src', 'core', 'model-catalog.js').replace(/\\/g, '/')}')` +
          `.then(m => console.log(m.all().map(x => x.id).join(',')))`,
      ],
      { encoding: 'utf8' },
    );
    assert.ok(out.includes('acceptance-probe-model'), 'the new model must be visible with no code change');
  } finally {
    await fs.writeFile(jsonPath, original, 'utf8');
    await fs.rm(backup, { force: true });
  }
});

/* ------------------------------------------------------------------ */
/* B. Module depth — no file that nobody wants to open                  */
/* ------------------------------------------------------------------ */

test('I2-B1: no source file exceeds 400 lines', async () => {
  const offenders = [];
  for (const f of await sourceFiles()) {
    const lines = (await fs.readFile(f, 'utf8')).split('\n').length;
    if (lines > 400) offenders.push(`${path.relative(ROOT, f)}: ${lines}`);
  }
  assert.deepEqual(offenders, [], `files over 400 lines: ${offenders.join(', ')}`);
});

test('I2-B2: api.js is split, not one file holding every route', async () => {
  const apiDir = path.join(ROOT, 'src', 'api');
  const stat = await fs.stat(apiDir).catch(() => null);
  assert.ok(stat?.isDirectory(), 'routes should live under src/api/');
  const files = (await fs.readdir(apiDir)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 2, `expected several route modules, found: ${files.join(', ')}`);
});

test('I2-B3: the frontend is split into ES modules', async () => {
  const files = (await fs.readdir(path.join(ROOT, 'public'))).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 3, `expected app.js to be split, found: ${files.join(', ')}`);
});

/* ------------------------------------------------------------------ */
/* C. One shared event vocabulary                                       */
/* ------------------------------------------------------------------ */

test('I2-C1: a shared event-schema module exists and is imported by both sides', async () => {
  const candidates = [
    path.join(ROOT, 'src', 'shared', 'events.js'),
    path.join(ROOT, 'public', 'shared', 'events.js'),
    path.join(ROOT, 'shared', 'events.js'),
  ];
  let found = null;
  for (const c of candidates) if (await fs.stat(c).then(() => true, () => false)) found = c;
  assert.ok(found, `expected a shared events module at one of: ${candidates.map((c) => path.relative(ROOT, c)).join(' | ')}`);

  const mod = await import(`file://${found.replace(/\\/g, '/')}`);
  const values = Object.values(mod).flatMap((v) => (typeof v === 'object' && v ? Object.values(v) : [v]));
  for (const name of ['start', 'think', 'answer', 'stats', 'done', 'error']) {
    assert.ok(values.includes(name), `the shared module must define the '${name}' event name`);
  }

  const rel = path.relative(ROOT, found).replace(/\\/g, '/');
  const base = path.basename(found);
  const all = await sourceFiles();
  const importers = [];
  for (const f of all) {
    const text = await fs.readFile(f, 'utf8');
    if (f !== found && new RegExp(`from ['"][^'"]*${base}['"]`).test(text)) importers.push(f);
  }
  const hasServer = importers.some((f) => f.includes(`${path.sep}src${path.sep}`));
  const hasClient = importers.some((f) => f.includes(`${path.sep}public${path.sep}`));
  assert.ok(hasServer, `nothing under src/ imports ${rel}`);
  assert.ok(hasClient, `nothing under public/ imports ${rel}`);
});

test('I2-C2: event names are not also hardcoded as string literals on both sides', async () => {
  const apiFiles = [];
  for await (const f of walk(path.join(ROOT, 'src', 'api'))) apiFiles.push(f);
  const routes = apiFiles.length ? apiFiles : [path.join(ROOT, 'src', 'api.js')];
  let hardcoded = 0;
  for (const f of routes) {
    const text = await fs.readFile(f, 'utf8').catch(() => '');
    if (/type:\s*'(start|think|answer|stats|done|error)'/.test(text)) hardcoded += 1;
  }
  assert.equal(hardcoded, 0, 'event types should come from the shared module, not repeated literals');
});

/* ------------------------------------------------------------------ */
/* D. One explicit reasoning path                                       */
/* ------------------------------------------------------------------ */

test('I2-D1: only the facade decides how reasoning is separated', async () => {
  const ollama = await fs.readFile(path.join(ROOT, 'src', 'runtime', 'ollama.js'), 'utf8');
  const llama = await fs.readFile(path.join(ROOT, 'src', 'runtime', 'llamacpp.js'), 'utf8');
  for (const [name, text] of [['ollama.js', ollama], ['llamacpp.js', llama]]) {
    assert.ok(
      !/<think>|<\/think>/.test(text),
      `${name} must not build or parse think tags — that belongs to the facade`,
    );
  }
});

// The runner exports NODE_TEST_CONTEXT=child-v8; a nested `node --test` inherits it
// and emits the V8 stream instead of text, so its stdout is empty and no summary
// can be read. Measured: 0 bytes inherited, 2087 bytes with it cleared.
test('I2-D2: nothing regressed — the whole non-acceptance suite still passes', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(
    process.execPath,
    ['--test', 'test/chat-store.test.js', 'test/think-stream.test.js', 'test/runtime.test.js', 'test/api.test.js', 'test/regression.test.js'],
    { cwd: ROOT, encoding: 'utf8', timeout: 180_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  const fails = /^# fail (\d+)$/m.exec(out);
  assert.equal(fails?.[1], '0', `existing tests must still pass:\n${out.slice(-1500)}`);
});
