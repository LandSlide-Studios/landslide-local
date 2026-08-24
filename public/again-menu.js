/**
 * "Again, but with a different model."
 *
 * The server has always accepted a `modelId` on the regenerate route; there was
 * simply no control that sent a different one. This is that control.
 *
 * It is a menu of buttons rather than a `<select>` on purpose. A select is less
 * code and would have been wrong: arrowing a *closed* select in Chrome fires
 * `change` once per option passed over, and every one of those would have
 * replaced the reply. An action this destructive has to be committed to
 * deliberately, which means a widget where moving the highlight and choosing
 * are two different events.
 *
 * Everything here is real focus and real buttons, so Enter and Space activate
 * natively and nothing needs a keydown handler to be usable.
 */

import { els, state } from './dom.js';

let pick = () => {};
let isOpen = false;

const items = () => [...els.regenerateMenu.querySelectorAll('.again-item')];

/** Rebuilt on every open: the catalog and the current selection both move. */
function render() {
  els.regenerateMenu.replaceChildren(
    ...state.models.map((m) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'again-item';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('data-model-id', m.id);
      // Roving tabindex: a menu is ONE tab stop, and arrows move within it.
      // Five reachable tab stops is the widget lying about its own shape.
      item.setAttribute('tabindex', '-1');
      // The one it is already on is still offered — retrying with the same
      // model is what the plain Again button does, and a menu that silently
      // omits the obvious entry reads as a bug.
      const current = m.id === state.modelId;
      if (current) item.classList.add('is-current');

      const name = document.createElement('span');
      name.className = 'again-item-name';
      name.textContent = m.name;

      const note = document.createElement('span');
      note.className = `again-item-fit fit-${m.fit?.verdict ?? 'unknown'}`;
      // The same honesty as the rail: a model that will not fit says so here
      // too, because this menu is a second door to committing the card.
      const verdict = m.fit?.verdict ?? '';
      note.textContent = current ? `current · ${verdict}`.trim().replace(/ ·$/, '') : verdict;

      item.append(name, note);
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-model-id');
        close();
        pick(id);
      });
      return item;
    }),
  );
}

function open() {
  if (isOpen || els.regenerateWith.disabled) return;
  render();
  els.regenerateMenu.hidden = false;
  els.regenerateWith.setAttribute('aria-expanded', 'true');
  isOpen = true;
  items()[0]?.focus();
}

function close({ restoreFocus = false } = {}) {
  if (!isOpen) return;
  els.regenerateMenu.hidden = true;
  els.regenerateWith.setAttribute('aria-expanded', 'false');
  isOpen = false;
  if (restoreFocus) els.regenerateWith.focus();
}

/** Wraps, so Up from the first entry lands on the last. */
function move(step) {
  const list = items();
  if (list.length === 0) return;
  const at = list.findIndex((el) => el === document.activeElement);
  const next = ((at < 0 ? 0 : at + step) % list.length + list.length) % list.length;
  list[next]?.focus();
}

function initAgainMenu(onPick) {
  pick = onPick;

  els.regenerateWith.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen) close({ restoreFocus: true });
    else open();
  });

  els.regenerateWith.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
      if (e.key === 'ArrowUp') items().at(-1)?.focus();
    }
  });

  els.regenerateMenu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      items()[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items().at(-1)?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // An open menu consumes Escape. Today the only document-level Escape
      // handler aborts a running reply, and a running reply already closes this
      // menu — so this stops nothing that can currently happen. It stays because
      // the alternative is a menu whose dismissal also fires whatever else the
      // page later binds to Escape, which is a bug waiting for its second cause.
      e.stopPropagation();
      close({ restoreFocus: true });
    } else if (e.key === 'Tab') {
      // Tabbing out of a menu closes it; the browser moves focus for us.
      close();
    }
  });

  // Anywhere else on the page — and deliberately NOT in the capture phase.
  //
  // Capture was the first attempt and it silently broke the trigger. A capture
  // listener on `document` runs BEFORE the target's own handler, so every click
  // on the caret closed the menu first and the toggle then read isOpen as false
  // and re-opened it. The menu could be opened and never shut by the same
  // button. Bubbling puts this after the trigger, where its stopPropagation
  // actually means something.
  document.addEventListener('click', () => close());
}

/** Used by the code that disables Again, so a menu cannot outlive its trigger. */
function closeAgainMenu() {
  close();
}

export { closeAgainMenu, initAgainMenu };
