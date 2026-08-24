/**
 * Drop a text or code file onto the composer and it becomes part of the prompt.
 *
 * Deliberately not an "attachment". The file's text is inserted into the box,
 * fenced and labelled, so what is about to be sent is visible before it is
 * sent — and so it counts against the character count and the context meter
 * like everything else typed there. An invisible attachment that silently
 * consumes two thirds of a 16k window is the failure mode this avoids.
 *
 * Refusals, each naming the file and the reason:
 *   - anything that is not decodable text, because a GGUF pasted as mojibake
 *     helps nobody;
 *   - anything over the size cap, because the window is finite;
 *   - anything unreadable, which is what a dragged FOLDER is;
 *   - anything empty, which would insert a fence around nothing;
 *   - nothing at all, when a drag carries no files.
 *
 * The document-level handlers are not optional. A browser's default action for
 * a dropped file is to NAVIGATE TO IT, which throws away the conversation and
 * whatever was typed. Every drop in this window is swallowed; only the ones on
 * the composer do anything.
 */

import { els, notify } from './dom.js';

/** Generous for source and prose, far short of what would blow the window. */
const MAX_BYTES = 256 * 1024;

/** What was dropped, or why it cannot be used. Pure, so it can be tested alone. */
async function readDropped(file) {
  const name = file.name || 'dropped file';
  if (file.size > MAX_BYTES) {
    const got = size(file.size);
    const cap = size(MAX_BYTES);
    // One byte over rounds to the same string as the limit, and "big.log is
    // 256 KB; the limit is 256 KB" reads as a bug rather than a rule.
    return {
      ok: false,
      name,
      error: got === cap ? `${name} is just over the ${cap} limit` : `${name} is ${got}; the limit is ${cap}`,
    };
  }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    // A folder dragged from the file manager is the likeliest cause, and it is
    // the first thing anyone tries. A file moved or locked since the drag began
    // is the other. Unguarded, this rejected out of Promise.all and took every
    // OTHER file in the same drop with it, silently.
    return { ok: false, name, error: `${name} could not be read — a folder, or a file that has moved` };
  }
  // A NUL byte is the oldest and most reliable "this is not text" signal, and
  // it survives files that happen to be valid UTF-8 by accident.
  if (bytes.includes(0)) {
    return { ok: false, name, error: `${name} looks like a binary file, not text` };
  }
  let text;
  try {
    // fatal: the decoder refuses rather than papering over bad bytes with U+FFFD.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, name, error: `${name} is not valid UTF-8 text` };
  }
  if (text.trim() === '') return { ok: false, name, error: `${name} is empty` };
  return { ok: true, name, text };
}

/** Enough precision to be useful, and never more digits than the value earns. */
function size(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${trim(bytes / 1024)} KB`;
  return `${trim(bytes / 1024 ** 2)} MB`;
}
const trim = (n) => String(Number(n.toFixed(1)));

/**
 * A fence long enough to contain what is inside it. A dropped markdown file
 * containing three backticks would otherwise close the block early and the rest
 * of it would render as prose.
 */
function fence(name, text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${name}\n${ticks}\n${text.replace(/\s+$/, '')}\n${ticks}`;
}

let afterInsert = () => {};

async function insertFiles(files) {
  const list = [...files];
  if (list.length === 0) return;

  const results = await Promise.all(list.map(readDropped));
  const good = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);

  if (bad.length > 0) {
    // Every reason, not just the first: dropping a folder's worth of files and
    // being told about one of them is how you end up dropping it again.
    notify(bad.map((b) => b.error).join(' · '));
  }
  if (good.length === 0) return;

  const blocks = good.map((g) => fence(g.name, g.text)).join('\n\n');
  const existing = els.prompt.value;
  els.prompt.value = existing ? `${existing.replace(/\s+$/, '')}\n\n${blocks}\n` : `${blocks}\n`;
  els.prompt.focus();
  // The caret goes to the end, so the next thing typed is the question about
  // the file rather than an edit in the middle of it.
  els.prompt.setSelectionRange?.(els.prompt.value.length, els.prompt.value.length);
  afterInsert();
}

function setDragging(on) {
  els.composer.classList.toggle('is-dropping', on);
}

/**
 * Is this drag carrying files, as opposed to text?
 *
 * Dropping selected text onto a textarea is a standard browser affordance, and
 * cancelling it broke that: the composer lit up promising to take what you were
 * carrying, then swallowed it, because `dataTransfer.files` was empty and
 * insertFiles returned early. Only file drags are ours.
 */
const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

function initFileDrop({ onInserted }) {
  afterInsert = onInserted;

  // Swallow the default for FILE drags everywhere in the window. Without this a
  // miss navigates the page to the file and the conversation is gone. A text
  // drag is left completely alone.
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      // Reaching here at all means the composer's handler did not stop this
      // event, so the pointer is somewhere else and the composer should stop
      // advertising itself as the target.
      setDragging(false);
    });
  }
  document.addEventListener('dragleave', (e) => {
    // Only when the pointer actually leaves the window, not on every crossing
    // between child elements inside it.
    if (!e.relatedTarget) setDragging(false);
  });

  els.composer.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  });
  els.composer.addEventListener('drop', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    insertFiles(e.dataTransfer?.files ?? []).catch((err) => {
      notify(`Could not read what was dropped: ${err?.message ?? err}`);
    });
  });
}

export { MAX_BYTES, fence, initFileDrop, insertFiles, readDropped };
