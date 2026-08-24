/**
 * HttpApi — deliberately thin, and now thin enough to read in one screen.
 *
 * This file does three things: build the dependencies a route module needs,
 * concatenate the route tables, and run the match-parse-answer loop. Every
 * route itself lives under `src/api/`, one module per group, because "all the
 * routes" was never a thing anyone wanted to open — it was a thing they had to
 * scroll past to reach the one route they came for.
 *
 *   src/api/runtime-routes.js   the model server: health, start, warm, unload, state
 *   src/api/chat-routes.js      conversations, and the one path that reaches a model
 *   src/api/prompt-routes.js    the saved system prompts
 *   src/api/catalog-guard.js    the single door between a request and a model id
 *   src/api/http.js             body reading, JSON and SSE writing, status codes
 *
 * All behaviour lives behind ChatStore, ModelCatalog and InferenceRuntime; if
 * logic starts accumulating in a route, it belongs in one of them.
 */

import { createRuntimeSupervisor } from './core/runtime-supervisor.js';
import { createPromptLibrary, defaultPromptFile } from './core/prompt-library.js';
import { httpError, readJson, send, statusForCode } from './api/http.js';
import { createRuntimeRoutes } from './api/runtime-routes.js';
import { createChatRoutes } from './api/chat-routes.js';
import { createPromptRoutes } from './api/prompt-routes.js';

export function createApi({ store, runtime, config, supervisor, prompts }) {
  const boss = supervisor ?? createRuntimeSupervisor(config.runtime ?? {});
  const library =
    prompts ??
    createPromptLibrary({
      file: config.storage?.promptsFile || defaultPromptFile(config.storage.chatsDir),
    });

  // Every pattern is anchored, so this is a lookup and not a fall-through
  // chain: the order below is for reading, not for resolution.
  const routes = [
    ...createRuntimeRoutes({ runtime, config, boss }),
    ...createPromptRoutes({ library }),
    ...createChatRoutes({ store, runtime }),
  ];

  /** @returns {boolean} true when this request was an API request and is handled. */
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;

    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) {
      send(res, 404, { error: 'no such endpoint' });
      return true;
    }

    try {
      const body = await readJson(req);
      const match = url.pathname.match(route[1]);
      const result = await route[2](match, body, url, res, req);
      if (result !== null) send(res, 200, result);
    } catch (err) {
      const status = err.status ?? statusForCode(err.code);
      if (!res.headersSent) send(res, status, { error: String(err.message ?? err) });
      else res.end();
    }
    return true;
  };
}

export { httpError };
