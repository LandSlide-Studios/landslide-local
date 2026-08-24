/**
 * Acceptance lock — the mechanism that keeps a builder from moving the target.
 *
 * Acceptance suites live in test/acceptance/ and are authored before the code
 * that has to satisfy them. A builder that can edit its own acceptance test can
 * always make it pass, and every review after that is theatre.
 *
 * This records a SHA-256 for each acceptance file, and refuses later if any of
 * them changed. A changed checksum is an automatic FAIL for the round - it is
 * not a judgement call and there is no argument to be had about it.
 *
 *   node scripts/acceptance-lock.mjs --write    record current hashes (planner only)
 *   node scripts/acceptance-lock.mjs --verify   fail if any acceptance file changed
 *   node scripts/acceptance-lock.mjs --status   show what is locked
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/util/config.js';

const DIR = path.join(ROOT, 'test', 'acceptance');
const LOCK = path.join(ROOT, 'test', 'acceptance.lock.json');

const mode = process.argv.find((a) => a.startsWith('--')) ?? '--verify';

const files = await listAcceptance();
const current = {};
for (const f of files) {
  current[f] = createHash('sha256')
    .update(await fs.readFile(path.join(DIR, f)))
    .digest('hex');
}

if (mode === '--write') {
  if (files.length === 0) {
    console.log('  nothing to lock — test/acceptance/ holds no .test.js file');
    process.exit(1);
  }
  await fs.writeFile(LOCK, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.log(`  locked ${files.length} acceptance file(s)`);
  for (const f of files) console.log(`    ${f}  ${current[f].slice(0, 12)}`);
  process.exit(0);
}

let locked = {};
try {
  locked = JSON.parse(await fs.readFile(LOCK, 'utf8'));
} catch {
  console.log('  no lock file yet — run with --write');
  process.exit(mode === '--status' ? 0 : 1);
}

if (mode === '--status') {
  for (const [f, h] of Object.entries(locked)) console.log(`  ${f}  ${h.slice(0, 12)}`);
  process.exit(0);
}

/* --verify */
// Every comparison below is vacuously satisfied by an empty lock, so a lock that
// was emptied — or written before any suite existed — printed "intact (0
// file(s))" and exited 0. A gate that reports success having checked nothing is
// worse than no gate: it is the one result nobody re-reads.
if (Object.keys(locked).length === 0) {
  console.log('\n  ACCEPTANCE LOCK EMPTY — nothing is locked, so nothing was verified\n');
  console.log('    Run --write as planner once the acceptance suites exist.\n');
  process.exit(1);
}

const problems = [];
for (const [f, hash] of Object.entries(locked)) {
  if (!(f in current)) problems.push(`${f}: DELETED`);
  else if (current[f] !== hash) problems.push(`${f}: MODIFIED`);
}
for (const f of Object.keys(current)) {
  if (!(f in locked)) problems.push(`${f}: added but not locked (run --write as planner)`);
}

if (problems.length === 0) {
  console.log(`  acceptance lock intact (${Object.keys(locked).length} file(s))`);
  process.exit(0);
}

console.log('\n  ACCEPTANCE LOCK BROKEN — automatic fail for this round\n');
for (const p of problems) console.log(`    ${p}`);
console.log('\n  Acceptance tests define the target. They are not the builder\'s to edit.\n');
process.exit(1);

async function listAcceptance() {
  try {
    return (await fs.readdir(DIR)).filter((f) => f.endsWith('.test.js')).sort();
  } catch {
    return [];
  }
}
