/**
 * Autostart — start Landslide Local when Windows logs in, and be able to undo it.
 *
 * The mechanism is the per-user Startup folder:
 *
 *   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\landslide-local.cmd
 *
 * Deliberately not the registry, and deliberately not a scheduled task. Both of
 * those need elevation or leave state a user cannot see; a file in a folder they
 * can open in Explorer can be deleted by hand if this module ever breaks, and
 * that is the whole safety story.
 *
 * Two rules keep it from touching anything it did not create:
 *
 *   - Our file carries a marker line. `uninstall()` deletes the entry only if
 *     that marker is present, so a shortcut the user put there under the same
 *     name is left exactly where it is.
 *   - `status()` reads and nothing else. It creates no folder and writes no
 *     file, so asking the question twice cannot change the answer.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../util/config.js';

const ENTRY_NAME = 'landslide-local.cmd';
const MARKER = 'LANDSLIDE-LOCAL-AUTOSTART';

/** The per-user Startup folder. Nothing here needs administrator rights. */
export function startupDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** Full path of the entry this module owns. */
export function entryPath() {
  return path.join(startupDir(), ENTRY_NAME);
}

/**
 * Is it installed? Read-only, and safe to call as often as you like.
 *
 * @returns {Promise<{installed: boolean, managed: boolean, supported: boolean, path: string, mechanism: string}>}
 */
export async function status() {
  const file = entryPath();
  const base = {
    installed: false,
    managed: false,
    supported: process.platform === 'win32',
    path: file,
    mechanism: 'startup-folder',
  };
  if (!base.supported) return base;

  const text = await readIfPresent(file);
  if (text === null) return base;
  // `managed` separates our own entry from a file that merely shares the name.
  return { ...base, installed: true, managed: text.includes(MARKER) };
}

/**
 * Write the startup entry.
 *
 * @returns {Promise<{ok: boolean, path?: string, replaced?: boolean, error?: string}>}
 */
export async function install({ root = ROOT, nodeBin = process.execPath } = {}) {
  const file = entryPath();
  if (process.platform !== 'win32') {
    return { ok: false, path: file, error: 'start on login is only wired up for Windows' };
  }

  const existing = await readIfPresent(file);
  if (existing !== null && !existing.includes(MARKER)) {
    return { ok: false, path: file, error: `${file} already exists and was not written by this app` };
  }

  try {
    await fs.mkdir(startupDir(), { recursive: true });
    await fs.writeFile(file, entryScript({ root, nodeBin }), 'utf8');
  } catch (err) {
    return { ok: false, path: file, error: err.message };
  }
  return { ok: true, path: file, replaced: existing !== null };
}

/**
 * Remove the startup entry. Removing something that is not there is a success,
 * not an error — that is what makes it safe to run from a cleanup path.
 *
 * @returns {Promise<{ok: boolean, removed: boolean, path: string, error?: string}>}
 */
export async function uninstall() {
  const file = entryPath();
  if (process.platform !== 'win32') return { ok: true, removed: false, path: file };

  const existing = await readIfPresent(file);
  if (existing === null) return { ok: true, removed: false, path: file };
  if (!existing.includes(MARKER)) {
    return { ok: false, removed: false, path: file, error: `${file} was not written by this app; leaving it alone` };
  }

  try {
    await fs.unlink(file);
  } catch (err) {
    if (err?.code !== 'ENOENT') return { ok: false, removed: false, path: file, error: err.message };
  }
  return { ok: true, removed: true, path: file };
}

/* ------------------------------------------------------------------ */

/**
 * The batch file itself.
 *
 * `start "" /min` hands the server off and lets the launcher exit, so login is
 * not held up. The node binary is written in full because a login-time shell
 * does not always have the same PATH a terminal does — with a fallback to plain
 * `node` in case that install ever moves.
 */
function entryScript({ root, nodeBin }) {
  const server = path.join(root, 'src', 'server.js');
  return [
    '@echo off',
    `rem ${MARKER}`,
    'rem Written by Landslide Local (src/core/autostart.js).',
    'rem Deleting this file turns start-on-login off. So does: npm run autostart uninstall',
    `set "NODE_BIN=${nodeBin}"`,
    'if not exist "%NODE_BIN%" set "NODE_BIN=node"',
    `cd /d "${root}"`,
    'start "" /min "%NODE_BIN%" "' + server + '"',
    '',
  ].join('\r\n');
}

async function readIfPresent(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    // Missing, or unreadable — either way there is nothing here we own.
    return null;
  }
}
