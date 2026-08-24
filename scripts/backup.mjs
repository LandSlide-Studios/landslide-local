/**
 * Back up every chat into one archive.
 *
 *   npm run backup                          -> backups/chats-<timestamp>.lsb
 *   npm run backup -- D:/keep/chats.lsb     -> exactly that file
 *
 * The chats folder is whatever config.json says it is. Restore with:
 *   npm run restore -- <archive>
 */

import path from 'node:path';
import { loadConfig, ROOT } from '../src/util/config.js';
import { createBackup } from '../src/core/backup.js';

const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
const config = loadConfig();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = target ? path.resolve(target) : path.join(ROOT, 'backups', `chats-${stamp}.lsb`);

try {
  const result = await createBackup({ chatsDir: config.storage.chatsDir, target: out });
  const mb = (result.archiveBytes / 1024 ** 2).toFixed(2);
  console.log(`\n  backed up ${result.files} file(s) from ${config.storage.chatsDir}`);
  console.log(`  -> ${result.target}  (${mb} MiB)\n`);
  console.log(`  restore it with:  npm run restore -- "${result.target}"\n`);
} catch (err) {
  console.error(`\n  backup failed: ${err.message}\n`);
  process.exit(1);
}
