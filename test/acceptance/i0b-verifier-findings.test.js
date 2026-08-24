/**
 * ACCEPTANCE — I0b, findings the air-gapped verifier caught that i0 did not.
 *
 * Authored after round 1, before round 2. Locked; not the builder's to edit.
 * A separate file on purpose: an existing locked suite is never edited, so the
 * round-1 hashes stay provable.
 *
 * Each test exists because a pre-authored criterion was too narrow. i0 checked
 * that render.js was internally consistent; it never checked that the app used
 * it on both paths. That gap is the lesson these tests encode.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'ls-i0b-'));

const run = (args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, ...opts },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });

/* ================================================================== */
/* F4 — reasoning rendered one way while streaming, another on reload  */
/* ================================================================== */

test('I0b-F4a: the reload path renders reasoning through the same renderer as the stream', async () => {
  const files = (await fs.readdir(path.join(ROOT, 'public'))).filter((f) => f.endsWith('.js'));
  let joined = '';
  for (const f of files) joined += await fs.readFile(path.join(ROOT, 'public', f), 'utf8');

  assert.ok(
    !/\.think-text'\)\.textContent\s*=/.test(joined) &&
      !/thinkText\.textContent\s*=(?!=)/.test(joined),
    'assigning textContent for reasoning bypasses the fence-aware renderer, so a reload ' +
      'shows literal backticks where the stream showed a code block',
  );
});

test('I0b-F4b: streamed reasoning and reloaded reasoning produce the same DOM', async () => {
  // Drives the two renderer entry points the app uses for reasoning.
  const TEXT = 3;
  const mkText = (d) => ({
    nodeType: TEXT,
    data: String(d),
    appendData(s) {
      this.data += s;
    },
    get textContent() {
      return this.data;
    },
    serialize() {
      return `#t(${this.data})`;
    },
  });
  const mkEl = (tag = 'div') => ({
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: '',
    attributes: {},
    childNodes: [],
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    },
    get lastChild() {
      return this.childNodes.at(-1) ?? null;
    },
    set textContent(v) {
      this.childNodes = v === '' ? [] : [mkText(v)];
    },
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    },
    append(...k) {
      this.childNodes.push(...k);
    },
    replaceChildren(...k) {
      this.childNodes = k;
    },
    serialize() {
      const t = this.tagName.toLowerCase();
      return `<${t}>${this.childNodes.map((c) => c.serialize()).join('')}</${t}>`;
    },
  });
  globalThis.document = { createElement: mkEl, createTextNode: mkText };
  globalThis.Node = { TEXT_NODE: TEXT, ELEMENT_NODE: 1 };

  const { renderText, appendStream } = await import('../../public/render.js');

  const reasoning = 'Let me check `x` and try:\n```py\nprint(1)\n```\nThat should do it.';

  const reloaded = mkEl();
  renderText(reloaded, reasoning);

  const streamed = mkEl();
  let acc = '';
  for (let i = 0; i < reasoning.length; i += 4) {
    const chunk = reasoning.slice(i, i + 4);
    acc += chunk;
    appendStream(streamed, acc, chunk);
  }

  assert.equal(
    streamed.serialize(),
    reloaded.serialize(),
    'reasoning must not change appearance when the page is reloaded',
  );
});

/* ================================================================== */
/* F8 — a check script exited 0 having measured nothing                */
/* ================================================================== */

test('I0b-F8a: check-uncensored exits non-zero when the selection matches no model', async () => {
  const r = await run([path.join('scripts', 'check-uncensored.mjs'), 'deckard4b-typo-not-a-model']);
  assert.notEqual(r.code, 0, 'probing zero models is not evidence of anything');
  assert.ok(
    !/No refusals\. The catalog flag matches observed behaviour/.test(r.stdout),
    'it must not print an affirmative verdict it did not measure',
  );
});

test('I0b-F8b: check-uncensored names the unknown id rather than failing silently', async () => {
  const r = await run([path.join('scripts', 'check-uncensored.mjs'), 'no-such-model-xyz']);
  assert.ok(
    /no-such-model-xyz/.test(r.stdout + r.stderr),
    'the operator must be told which id matched nothing',
  );
});

test('I0b-F8c: the acceptance lock refuses to certify an empty lock', async () => {
  const r = await run([path.join('scripts', 'acceptance-lock.mjs'), '--verify'], {
    env: { ...process.env, LANDSLIDE_LOCK_SELFTEST: '1' },
  });
  // With real files present this must pass; the guard is asserted structurally below.
  assert.equal(r.code, 0, `lock verify should pass on the real repo: ${r.stdout}`);
  const src = await fs.readFile(path.join(ROOT, 'scripts', 'acceptance-lock.mjs'), 'utf8');
  assert.ok(
    /length === 0|length < 1|!files\.length|Object\.keys\(locked\)\.length === 0/.test(src),
    'verifying zero files must be treated as a failure, not as intact',
  );
});

/* ================================================================== */
/* F9-D — the offline gate could not catch a protocol-relative CDN     */
/* ================================================================== */

test('I0b-F9d: preflight catches a protocol-relative external URL', async () => {
  const probe = path.join(ROOT, 'public', '_i0b_probe_protocol_relative.js');
  await fs.writeFile(probe, 'const s = document.createElement("script");\ns.src = "//cdn.jsdelivr.net/npm/x";\n', 'utf8');
  try {
    const r = await run([path.join('scripts', 'preflight.mjs')]);
    assert.notEqual(r.code, 0, `a //cdn URL must fail the offline gate. Output:\n${r.stdout}`);
    assert.ok(/offline/.test(r.stdout), 'the offline check is what should have caught it');
  } finally {
    await fs.rm(probe, { force: true });
  }
});

test('I0b-F9d2: preflight still catches a plain https CDN url, and passes when clean', async () => {
  const probe = path.join(ROOT, 'public', '_i0b_probe_https.js');
  await fs.writeFile(probe, 'const CDN = "https://cdn.jsdelivr.net/npm/x";\n', 'utf8');
  try {
    const bad = await run([path.join('scripts', 'preflight.mjs')]);
    assert.notEqual(bad.code, 0, 'the control case must still fail');
  } finally {
    await fs.rm(probe, { force: true });
  }
  const clean = await run([path.join('scripts', 'preflight.mjs')]);
  assert.equal(clean.code, 0, `the repo itself must be clean:\n${clean.stdout}`);
});

/* ================================================================== */
/* F9-C — preload offered, and acted on, under the wrong backend       */
/* ================================================================== */

async function appWith(runtime) {
  const dir = await tmpDir();
  const { server, config } = await createServer({
    server: { port: 0 },
    storage: { chatsDir: dir },
    runtime,
  });
  await new Promise((r) => server.listen(0, config.server.host, r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('I0b-F9c1: warm is refused when the configured backend is not the one it can drive', async () => {
  // A live Ollama-shaped stub, but llamacpp is what is configured.
  const seen = [];
  const stub = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push(req.url);
      if (req.url === '/api/version') return res.writeHead(200).end(JSON.stringify({ version: 'stub' }));
      if (req.url === '/api/generate') return res.writeHead(200).end(JSON.stringify({ done: true }));
      res.writeHead(200).end('{}');
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;

  const a = await appWith({ adapter: 'llamacpp', llamaCppUrl: 'http://127.0.0.1:1', ollamaUrl: stubUrl });
  const res = await fetch(`${a.base}/api/runtime/warm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'deckard-4b' }),
  });
  const body = await res.json().catch(() => ({}));
  const succeeded = res.status === 200 && body?.result?.ok === true;
  assert.equal(succeeded, false, 'preloading must not silently drive a backend that is not configured');
  assert.ok(
    !seen.includes('/api/generate'),
    'nothing may be loaded into a runtime the app is not configured to use',
  );

  await a.close();
  stub.closeAllConnections();
  await new Promise((r) => stub.close(r));
});

test('I0b-F9c2: start is refused for a backend the supervisor cannot start', async () => {
  const a = await appWith({ adapter: 'llamacpp', llamaCppUrl: 'http://127.0.0.1:1' });
  const res = await fetch(`${a.base}/api/runtime/start`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  const claimsStarted = body?.result?.ok === true;
  assert.equal(claimsStarted, false, 'the app must not claim it started a backend it cannot start');
  await a.close();
});

test('I0b-F9c3: the UI only offers preload for a backend that supports it', async () => {
  const files = (await fs.readdir(path.join(ROOT, 'public'))).filter((f) => f.endsWith('.js'));
  let joined = '';
  for (const f of files) joined += await fs.readFile(path.join(ROOT, 'public', f), 'utf8');
  assert.match(
    joined,
    /canWarm|canPreload|supportsWarm|adapter\s*===\s*'ollama'/,
    'the preload affordance must be gated on the backend actually supporting it',
  );
});

/* ================================================================== */
/* F9-E/F — remaining false documentation claims                       */
/* ================================================================== */

test('I0b-F9e: CLAUDE.md does not claim a single offline-exempt file when there are two', async () => {
  const doc = await fs.readFile(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const preflight = await fs.readFile(path.join(ROOT, 'scripts', 'preflight.mjs'), 'utf8');
  const allowed = [...preflight.matchAll(/'([\w.-]+\.mjs)'/g)].map((m) => m[1]);
  const exempt = new Set(allowed.filter((f) => /fetch-models|verify-urls/.test(f)));
  if (exempt.size > 1) {
    assert.ok(
      !/single exempt file/i.test(doc),
      `CLAUDE.md says "single exempt file" but preflight exempts ${[...exempt].join(', ')}`,
    );
  }
});

test('I0b-F9f: no doc claims render.js is the only module turning model output into DOM, unless true', async () => {
  const doc = await fs.readFile(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  if (/only module allowed to turn model output into DOM/i.test(doc)) {
    const files = (await fs.readdir(path.join(ROOT, 'public'))).filter((f) => f.endsWith('.js') && f !== 'render.js');
    for (const f of files) {
      const text = await fs.readFile(path.join(ROOT, 'public', f), 'utf8');
      assert.ok(
        !/\.textContent\s*=\s*(thinking|reasoning|m\.thinking)/.test(text),
        `${f} writes model output to the DOM directly, so the claim in CLAUDE.md is false`,
      );
    }
  }
});

test('I0b-F9g: README does not misstate the test count', async () => {
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  const claim = /(\d+)\s+tests?, no model needed/.exec(readme);
  if (claim) {
    const r = await run(['--test', '--test-force-exit', 'test/chat-store.test.js', 'test/think-stream.test.js', 'test/runtime.test.js', 'test/api.test.js', 'test/regression.test.js']);
    const actual = /^# tests (\d+)$/m.exec(r.stdout)?.[1];
    assert.equal(
      claim[1],
      actual,
      `README says ${claim[1]} core tests; the core suites report ${actual}`,
    );
  }
});
