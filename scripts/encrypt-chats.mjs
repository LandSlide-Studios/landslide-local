/**
 * Move an existing plain chats folder to encrypted files, in place.
 *
 *   set LANDSLIDE_PASSPHRASE=...
 *   npm run encrypt-chats            -> says what it would do, touches nothing
 *   npm run encrypt-chats -- --yes   -> does it
 *   npm run encrypt-chats -- --yes D:/somewhere/chats
 *
 * The passphrase comes from LANDSLIDE_PASSPHRASE and not from an argument, for
 * two reasons: it is the same variable the app itself reads, so the two cannot
 * end up disagreeing, and a command line is visible to every other process on
 * the machine and lands in the shell history besides.
 *
 * `--yes` is required because this is the only command here that deletes a
 * conversation. It only ever deletes one whose encrypted replacement has
 * already been read back off the disk and compared — but a folder encrypted
 * under a passphrase you then mistype has no recovery path at all, and one flag
 * is cheap next to that.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/util/config.js';
import { migrateToEncrypted } from '../src/core/store-migrate.js';
import { PASSPHRASE_ENV } from '../src/core/store-open.js';
import { JSON_EXT } from '../src/core/chat-store.js';

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const where = args.find((a) => !a.startsWith('--'));

const config = loadConfig();
const dir = where ? path.resolve(where) : config.storage.chatsDir;
const passphrase = process.env[PASSPHRASE_ENV] ?? '';

if (!passphrase) {
  console.error(`\n  ${PASSPHRASE_ENV} is not set, so there is nothing to encrypt with.\n`);
  console.error(`    set ${PASSPHRASE_ENV}=your passphrase        this window only`);
  console.error(`    setx ${PASSPHRASE_ENV} "your passphrase"     every future window\n`);
  console.error(`  There is no way to recover chats if you forget it. Write it down first.\n`);
  process.exit(1);
}

const plain = (await fs.readdir(dir).catch(() => [])).filter((n) => n.endsWith(JSON_EXT));

if (!confirmed) {
  console.log(`\n  ${dir}`);
  console.log(`  ${plain.length} plain chat file(s) would be encrypted in place.\n`);
  console.log(`  Each one is encrypted, read back off the disk, compared, and only then`);
  console.log(`  is the plain copy removed. Nothing is deleted that has not been verified.\n`);
  console.log(`  Back it up first:   npm run backup`);
  console.log(`  Then run:           npm run encrypt-chats -- --yes\n`);
  console.log(`  Forgetting the passphrase loses every chat. There is no recovery.\n`);
  process.exit(0);
}

try {
  const report = await migrateToEncrypted({ dir, passphrase });
  console.log(`\n  ${report.dir}`);
  console.log(`  encrypted          ${report.encrypted.length}`);
  if (report.alreadyEncrypted.length) console.log(`  already done       ${report.alreadyEncrypted.length}`);
  for (const line of report.conflicts) console.log(`  [warn] ${line}`);
  for (const id of report.unreadable) {
    console.log(`  [warn] ${id}${JSON_EXT} could not be parsed and was left where it is`);
  }
  for (const name of report.leftBehind) {
    console.log(`  [warn] ${name} is still plaintext — deal with it by hand`);
  }
  console.log(`\n  Start the app with ${PASSPHRASE_ENV} set and it will read them.\n`);
} catch (err) {
  console.error(`\n  migration stopped: ${err.message}`);
  console.error(`  Nothing was deleted that had not already been verified.\n`);
  process.exit(1);
}
