/**
 * Restore chats from an archive made by `npm run backup`.
 *
 *   npm run restore -- <archive>                  into the configured chats folder
 *   npm run restore -- <archive> --into D:/tmp    somewhere else
 *   npm run restore -- <archive> --force          overwrite a folder that is not empty
 *
 * Without --force it refuses a destination that already holds files, because
 * the common mistake is restoring an old backup on top of a live folder.
 * Restoring into an empty folder first and looking at it is free.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig, ROOT } from '../src/util/config.js';
import { restoreBackup, inspectBackup } from '../src/core/backup.js';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const intoAt = argv.indexOf('--into');
const into = intoAt >= 0 ? argv[intoAt + 1] : null;
const archive = argv.find((a, i) => !a.startsWith('--') && i !== intoAt + 1);

if (!archive) {
  console.log('\n  usage: npm run restore -- <archive> [--into <folder>] [--force]\n');
  const dir = path.join(ROOT, 'backups');
  const found = await fs.readdir(dir).catch(() => []);
  if (found.length) {
    console.log(`  archives in ${dir}:`);
    for (const f of found.filter((f) => f.endsWith('.lsb')).sort()) console.log(`    ${f}`);
    console.log('');
  }
  process.exit(1);
}

const config = loadConfig();
const dest = into ? path.resolve(into) : config.storage.chatsDir;

try {
  const info = await inspectBackup({ archive });
  console.log(`\n  archive : ${path.resolve(archive)}`);
  console.log(`  made    : ${info.createdAt ?? 'unknown'}  (${info.files} file(s))`);
  console.log(`  into    : ${dest}${force ? '  [--force]' : ''}`);

  const result = await restoreBackup({ archive, chatsDir: dest, force });
  console.log(`\n  restored ${result.files} file(s), ${result.bytes} bytes\n`);
} catch (err) {
  console.error(`\n  restore failed: ${err.message}\n`);
  process.exit(1);
}
