/**
 * The stream event vocabulary — one definition, both sides of the wire.
 *
 * A generation is reported as a sequence of events over SSE. Both ends have to
 * agree on their names down to the character, and for most of this app's life
 * they agreed only by coincidence: the server wrote `{ type: 'answer' }` and the
 * page tested `event.type === 'answer'`, in two files, with nothing connecting
 * them. Renaming one was a silent break — the page simply stopped drawing
 * whichever event it no longer recognised, with no error anywhere.
 *
 * So the names live here and are imported by both. `src/api/chat-routes.js` and
 * `src/runtime/index.js` emit them; `public/stream.js` reads them.
 *
 *   start   sent before a token is generated: chat id, model, and what the
 *           context budget did to the conversation
 *   think   a chunk of reasoning
 *   answer  a chunk of the answer
 *   stats   token counts and throughput, once the generation is finished
 *   done    the reply is saved; carries the final stats and message id
 *   error   the generation failed; carries the message to show
 *
 * WHY IT LIVES UNDER `public/`: the browser has to be able to fetch it, and the
 * server only serves this folder — so this is the one path a `<script
 * type="module">` and a Node `import` can both reach without inventing a build
 * step or a second static route. Node reaches it by relative path; the browser
 * gets it at `/shared/events.js`.
 *
 * Nothing else belongs in this file. It is a vocabulary, not a layer: no DOM, no
 * `node:` imports, no logic that could differ between the two runtimes.
 */

export const EVENT = Object.freeze({
  start: 'start',
  think: 'think',
  answer: 'answer',
  stats: 'stats',
  done: 'done',
  error: 'error',
});

/** Every name in the vocabulary, for a caller that needs to check membership. */
export const EVENT_NAMES = Object.freeze(Object.values(EVENT));
