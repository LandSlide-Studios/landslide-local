/**
 * Verify every catalog entry actually resolves on Hugging Face, and that the
 * recorded size matches the real file.
 *
 * Separate from preflight because it needs the network, and preflight must be
 * runnable with the machine offline. Run this after editing the catalog.
 *
 * Sizes in the catalog are GiB (1024^3), matching how VRAM is measured. Hugging
 * Face's web UI shows decimal GB, which reads about 7% larger for the same file.
 */

import * as catalog from '../src/core/model-catalog.js';

const TOLERANCE_GIB = 0.05;
let bad = 0;

for (const m of catalog.all()) {
  const url = `https://huggingface.co/${m.repo}/resolve/main/${encodeURIComponent(m.file)}?download=true`;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const bytes = Number(res.headers.get('content-length') ?? 0);
    const actual = bytes / 1024 ** 3;
    const drift = Math.abs(actual - m.sizeGb);

    if (!res.ok || bytes === 0) {
      bad += 1;
      console.log(`FAIL ${m.id.padEnd(22)} HTTP ${res.status} — filename or repo is wrong`);
    } else if (drift > TOLERANCE_GIB) {
      bad += 1;
      console.log(
        `FAIL ${m.id.padEnd(22)} size drift: catalog ${m.sizeGb} GiB, actual ${actual.toFixed(2)} GiB`,
      );
    } else {
      console.log(`ok   ${m.id.padEnd(22)} ${actual.toFixed(2)} GiB`);
    }
  } catch (err) {
    bad += 1;
    console.log(`FAIL ${m.id.padEnd(22)} ${err.message}`);
  }
}

console.log(bad === 0 ? '\nAll catalog URLs resolve and sizes match.\n' : `\n${bad} problem(s).\n`);
process.exit(bad === 0 ? 0 : 1);
