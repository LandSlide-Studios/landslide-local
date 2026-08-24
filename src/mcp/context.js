/**
 * The three things every tool needs, opened once for the process.
 *
 * Config, chat store and runtime are singletons for this server, and they have
 * to be: `openChatStore(config)` decides whether the folder is read as plain
 * JSON or as encrypted files, and two copies of that decision is how
 * `search_chats` ends up reporting an empty history out of a folder the app is
 * happily writing to. Same folder as the app, so the same decision about how to
 * read it, made in one place that both `tools.js` and `server.js` import.
 */

import { loadConfig } from '../util/config.js';
import { openChatStore } from '../core/store-open.js';
import { createRuntime } from '../runtime/index.js';

export const config = loadConfig();

const opened = openChatStore(config);

export const store = opened.store;
export const encrypted = opened.encrypted;
export const runtime = createRuntime(config.runtime);
