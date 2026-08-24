/**
 * Every request this page makes to its own API, and the one thing that can
 * interrupt one: a server that wants a token.
 *
 * Nothing else in the frontend calls `fetch` directly. That is the point — the
 * 401 handling below is worth exactly one implementation, and a second call site
 * that skipped it would fail silently against a locked server.
 */

import { els } from './dom.js';

/**
 * Every request to this app's own API goes through here.
 *
 * With `security.token` empty — the default — this is a plain fetch and nothing
 * about the app changes. With a token set, the server answers 401 to any /api/
 * call without it, while still serving this page: that is the whole reason the
 * shell is left open, so there is somewhere to type the token in.
 *
 * A 401 therefore means "ask", not "fail". Ask once, keep the answer, retry the
 * same request. If the retry is refused too the stored token is wrong, so it is
 * discarded rather than left to fail every call from here on.
 *
 * localStorage is not a vault. It does not need to be: the token guards against
 * other processes on this machine reaching the API, and it came out of a config
 * file sitting on the same disk.
 */
const TOKEN_KEY = 'ls.token';

async function apiFetch(path, init = {}) {
  let res = await withToken(path, init);
  let refused = false;
  // Ask again on a wrong token rather than once. Each turn of this loop waits on
  // a click, so it cannot spin; dismissing the box gives up and returns the 401.
  while (res.status === 401) {
    const typed = await askForToken(refused);
    if (typed === null) return res;
    localStorage.setItem(TOKEN_KEY, typed);
    res = await withToken(path, init);
    if (res.status === 401) {
      // A stored token the server refuses is worse than none: it would fail
      // every request from here on with nothing to show for it.
      localStorage.removeItem(TOKEN_KEY);
      refused = true;
    }
  }
  return res;
}

/**
 * Ask inside the page, not through `window.prompt`.
 *
 * prompt() looks like the cheap answer and is not one. Chrome refuses it outright
 * in some embeddings — the call throws "prompt() is not supported" — and
 * suppresses it after the first dialog in others. Either way the failure lands on
 * the very first request the app makes, so the whole UI comes up empty with
 * nothing on screen to say why. Built out of nodes, never innerHTML.
 *
 * One ask at a time: boot fires several requests and each would otherwise put its
 * own box up. Everything after the first waits on the same answer.
 */
let tokenAsk = null;

function askForToken(refused = false) {
  tokenAsk ??= new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'notice-ask';

    const label = document.createElement('label');
    label.className = 'notice-msg';
    label.htmlFor = 'tokenInput';
    label.textContent = refused
      ? 'That token was refused. Check "security.token" in config.json and try again.'
      : 'This server is locked. Paste its access token — "security.token" in config.json.';

    const input = document.createElement('input');
    input.id = 'tokenInput';
    input.type = 'password';
    input.className = 'search';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const unlock = document.createElement('button');
    unlock.type = 'button';
    unlock.className = 'btn btn-sm btn-accent';
    unlock.textContent = 'Unlock';

    const onDismiss = () => done(null);
    const done = (value) => {
      els.noticeDismiss.removeEventListener('click', onDismiss);
      box.remove();
      els.noticeMsg.hidden = false;
      els.notice.hidden = true;
      tokenAsk = null;
      resolve(value);
    };

    unlock.addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(input.value.trim() || null);
      }
    });
    els.noticeDismiss.addEventListener('click', onDismiss);

    box.append(label, input, unlock);
    // The notice bar already survives every re-render, which is exactly what this
    // needs; its own message is hidden while the ask is up rather than competing.
    els.noticeMsg.hidden = true;
    els.notice.hidden = false;
    els.notice.insertBefore(box, els.noticeDismiss);
    input.focus();
  });
  return tokenAsk;
}

function withToken(path, init) {
  // Bare `fetch`, not `window.fetch`. They are the same function in a browser,
  // but `window` does not exist under the headless UI test, and spelling it the
  // browser-only way turned every one of those tests into "window is not
  // defined" the moment the two changes met.
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return fetch(path, init);
  return fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

export { apiFetch };
