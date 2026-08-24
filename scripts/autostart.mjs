/**
 * Start Landslide Local when Windows logs in — and take it back off again.
 *
 *   npm run autostart              what is it right now
 *   npm run autostart install
 *   npm run autostart uninstall
 *
 * This writes one .cmd file into your own Startup folder. No registry keys, no
 * scheduled task, no administrator prompt. You can delete the file by hand and
 * that is a complete uninstall.
 */

import { status, install, uninstall } from '../src/core/autostart.js';

const action = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'status';

const show = async () => {
  const s = await status();
  console.log(`\n  start on login : ${s.installed ? 'ON' : 'off'}`);
  console.log(`  entry          : ${s.path}`);
  if (s.installed && !s.managed) {
    console.log('  note           : that file was not written by this app, so it is left alone');
  }
  console.log('');
};

if (action === 'status') {
  await show();
} else if (action === 'install') {
  const r = await install();
  if (!r.ok) {
    console.error(`\n  could not install: ${r.error}\n`);
    process.exit(1);
  }
  console.log(`\n  ${r.replaced ? 'updated' : 'installed'}: ${r.path}\n`);
} else if (action === 'uninstall') {
  const r = await uninstall();
  if (!r.ok) {
    console.error(`\n  could not uninstall: ${r.error}\n`);
    process.exit(1);
  }
  console.log(`\n  ${r.removed ? 'removed' : 'nothing was installed'}: ${r.path}\n`);
} else {
  console.error(`\n  unknown action "${action}" — use status, install or uninstall\n`);
  process.exit(1);
}
