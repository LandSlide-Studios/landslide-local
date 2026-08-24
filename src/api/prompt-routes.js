/**
 * The saved system prompts.
 *
 *   GET    /api/prompts        list
 *   POST   /api/prompts        save one
 *   DELETE /api/prompts/:id    forget one
 *
 * Thin even by this layer's standards: PromptLibrary already owns validation,
 * ids and the file, so there is nothing here but the shape of the answer.
 */

import { httpError } from './http.js';

export function createPromptRoutes({ library }) {
  async function listPrompts() {
    return { prompts: await library.list() };
  }

  async function createPrompt(_m, body) {
    const prompt = await library.add(body);
    if (!prompt) throw httpError(400, 'a saved prompt needs both a name and some text');
    return { prompt };
  }

  async function deletePrompt(match) {
    return { removed: await library.remove(match[1]) };
  }

  return [
    ['GET', /^\/api\/prompts$/, listPrompts],
    ['POST', /^\/api\/prompts$/, createPrompt],
    ['DELETE', /^\/api\/prompts\/([\w-]+)$/, deletePrompt],
  ];
}
