/**
 * Model provisioning — downloads the five GGUFs and registers them with Ollama.
 *
 * This is the only script in the project that needs the internet, and it needs
 * it once. After it finishes, unplug the machine and the app still works.
 *
 * Downloads resume: a partial file is continued with a Range request rather
 * than restarted, which matters when a single file is 8GB.
 *
 *   node scripts/fetch-models.mjs              all models
 *   node scripts/fetch-models.mjs deckard-4b   just one
 *   node scripts/fetch-models.mjs --list       show plan and exit
 *   node scripts/fetch-models.mjs --no-register   download only
 *   node scripts/fetch-models.mjs --keep-raw      keep the .gguf after registering
 *   node scripts/fetch-models.mjs --cleanup-raw   delete raw .gguf already registered
 *
 * `ollama create` copies the GGUF into Ollama's own blob store, so keeping the
 * raw file doubles the disk cost. The raw file is deleted once registration is
 * confirmed against the live registry - never before, and never if it failed.
 */

import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as catalog from '../src/core/model-catalog.js';
import { loadConfig } from '../src/util/config.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const wanted = args.filter((a) => !a.startsWith('--'));

const config = loadConfig();
const MODELS_DIR = config.storage.modelsDir;
const OLLAMA_URL = (config.runtime.ollamaUrl ?? 'http://127.0.0.1:11434').replace(/[/]+$/, '');

const selected = catalog
  .all()
  .filter((m) => wanted.length === 0 || wanted.includes(m.id));

if (selected.length === 0) {
  console.error(`No model matched. Known ids:\n  ${catalog.all().map((m) => m.id).join('\n  ')}`);
  process.exit(1);
}

console.log(`\n  Target folder : ${MODELS_DIR}`);
console.log(`  Models        : ${selected.length}`);
console.log(`  Download size : ${selected.reduce((s, m) => s + m.sizeGb, 0).toFixed(2)} GiB\n`);
for (const m of selected) {
  console.log(`   ${m.id.padEnd(22)} ${String(m.sizeGb).padStart(5)} GiB  ${m.quant}`);
}
console.log('');

if (flags.has('--list')) process.exit(0);

await fs.mkdir(MODELS_DIR, { recursive: true });

let failures = 0;

if (flags.has('--cleanup-raw')) {
  for (const model of selected) {
    await dropRaw(model, path.join(MODELS_DIR, model.file));
  }
  console.log('');
  process.exit(0);
}

for (const model of selected) {
  try {
    const file = await download(model);
    if (!flags.has('--no-register')) {
      const registered = await register(model, file);
      if (registered && !flags.has('--keep-raw')) await dropRaw(model, file);
    }
  } catch (err) {
    failures += 1;
    console.error(`\n  FAILED ${model.id}: ${err.message}\n`);
  }
}

console.log(failures === 0 ? '\n  All done.\n' : `\n  Finished with ${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);

/* ------------------------------------------------------------------ */

function urlFor(model) {
  return `https://huggingface.co/${model.repo}/resolve/main/${encodeURIComponent(model.file)}?download=true`;
}

async function download(model) {
  const target = path.join(MODELS_DIR, model.file);
  const part = `${target}.part`;

  const done = await sizeOf(target);
  if (done > 0) {
    // "non-zero" is not "complete": a truncated GGUF loads as a corrupt model.
    const expected = model.sizeGb * 1024 ** 3;
    if (Math.abs(done - expected) / expected < 0.02) {
      console.log(`  = ${model.id}: already present (${gb(done)} GiB)`);
      return target;
    }
    console.log(`  ! ${model.id}: on disk at ${gb(done)} GiB, expected ~${model.sizeGb} GiB — refetching`);
    await fs.rename(target, part).catch(() => fs.rm(target, { force: true }));
  }

  let from = await sizeOf(part);
  const headers = from > 0 ? { range: `bytes=${from}-` } : {};
  if (from > 0) console.log(`  ~ ${model.id}: resuming at ${gb(from)} GB`);

  const res = await fetch(urlFor(model), { headers, redirect: 'follow' });
  if (res.status === 416) {
    await fs.rename(part, target);
    console.log(`  = ${model.id}: already complete`);
    return target;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from Hugging Face`);
  if (from > 0 && res.status !== 206) {
    from = 0; // server ignored the range; start over rather than corrupt the file
    await fs.rm(part, { force: true });
  }

  const total = Number(res.headers.get('content-length') ?? 0) + from;
  const out = createWriteStream(part, { flags: from > 0 ? 'a' : 'w' });
  let seen = from;
  let lastPrint = 0;

  // A Transform keeps backpressure intact. Enqueuing from a ReadableStream's
  // start() ignores desiredSize entirely, so a slow sink would buffer the whole
  // download in memory - on a file that can be over 7GB.
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      const now = Date.now();
      if (now - lastPrint > 700) {
        lastPrint = now;
        const pct = total ? ((seen / total) * 100).toFixed(1) : '?';
        process.stdout.write(`
  > ${model.id}: ${gb(seen)} / ${gb(total)} GiB (${pct}%)   `);
      }
      cb(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body), progress, out);
  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  const finalSize = await sizeOf(part);
  if (total && finalSize !== total) {
    throw new Error(`size mismatch: got ${finalSize}, expected ${total}. Re-run to resume.`);
  }
  await fs.rename(part, target);
  console.log(`  + ${model.id}: downloaded ${gb(finalSize)} GiB`);
  return target;
}

async function register(model, file) {
  const d = model.defaults;
  const modelfile = [
    `FROM ${file.replace(/\\/g, '/')}`,
    `PARAMETER temperature ${d.temperature}`,
    `PARAMETER top_p ${d.top_p}`,
    `PARAMETER top_k ${d.top_k}`,
    `PARAMETER repeat_penalty ${d.repeat_penalty}`,
    `PARAMETER num_ctx ${d.num_ctx}`,
    '',
  ].join('\n');

  const mfPath = path.join(MODELS_DIR, `${model.id}.Modelfile`);
  await fs.writeFile(mfPath, modelfile, 'utf8');

  const code = await run('ollama', ['create', model.id, '-f', mfPath]);
  if (code === 0) {
    console.log(`  * ${model.id}: registered with Ollama`);
    return true;
  }
  console.log(`  ! ${model.id}: 'ollama create' exited ${code} - Modelfile kept at ${mfPath}`);
  return false;
}

/**
 * Remove the raw GGUF once Ollama holds its own copy. Confirms registration
 * against the live registry first: deleting the only copy of a 7GB file on the
 * strength of an exit code alone is not a trade worth making.
 */
async function dropRaw(model, file) {
  const size = await sizeOf(file);
  if (size === 0) return;
  if (!(await isRegistered(model.id))) {
    console.log(`  ~ ${model.id}: not in the Ollama registry, keeping the raw file`);
    return;
  }
  await fs.rm(file, { force: true });
  console.log(`  - ${model.id}: raw GGUF removed, reclaimed ${gb(size)} GiB`);
}

async function isRegistered(id) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = await res.json();
    return (body.models ?? []).some((m) => m.name === id || m.name === `${id}:latest`);
  } catch {
    return false;
  }
}

function run(cmd, argv) {
  return new Promise((resolve) => {
    const exe = process.platform === 'win32' ? `${cmd}.exe` : cmd;
    const child = spawn(exe, argv, { stdio: 'inherit', shell: false });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

async function sizeOf(p) {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

// Declared as a function, not a const arrow: the top-level await above runs
// before the tail of this module is evaluated, so a const here is still in
// the temporal dead zone when the first chunk arrives.
function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(2);
}
