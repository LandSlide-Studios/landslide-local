/**
 * The one door between a request and a model id.
 *
 * Nothing a request says becomes a model id. Every route that names a model
 * calls this, gets the CATALOG's entry back, and forwards `model.id` — there is
 * no field a caller can set that reaches a runtime as a model name. It is one
 * function in its own file precisely so that "which routes enforce this" is a
 * grep for one import rather than a reading of every route.
 *
 * This machine's Ollama registry holds a 37 GiB model alongside the five this
 * app ships, and "the caller picks the tag" is exactly how one of those gets
 * asked of an 8 GB card.
 */

import * as catalog from '../core/model-catalog.js';
import { httpError } from './http.js';

/** @returns {object} the catalog's own model record; never the caller's string. */
export function requireModel(modelId) {
  const model = catalog.get(modelId);
  if (!model) throw httpError(400, `unknown model: ${modelId}`);
  return model;
}
