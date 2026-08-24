/**
 * Routes about the model server itself: is it up, start it, preload a model,
 * give the VRAM back — and `/api/state`, which is the same answer plus the
 * catalog and what each model would do on this card.
 *
 *   GET  /api/runtime          runtime health as the page needs to read it
 *   POST /api/runtime/start    launch the model server, if we can drive it
 *   POST /api/runtime/warm     load a catalogued model into VRAM now
 *   POST /api/runtime/unload   evict one without waiting out KEEP_ALIVE
 *   GET  /api/state            the above, plus catalog + fit verdicts
 */

import * as catalog from '../core/model-catalog.js';
import { httpError } from './http.js';
import { requireModel } from './catalog-guard.js';

/**
 * The adapters the supervisor can actually drive. It speaks Ollama's HTTP API
 * and nothing else, so under any other adapter both start and warm would act
 * on a DIFFERENT process from the one configured to answer.
 */
const SUPERVISED_ADAPTERS = new Set(['ollama']);

export function createRuntimeRoutes({ runtime, config, boss }) {
  /**
   * One answer to "is anything actually answering", shared by /api/runtime and
   * /api/state so the two cannot disagree.
   *
   * The supervisor only ever talks to Ollama. Reporting its health while
   * `runtime.adapter` is llamacpp is reporting a different process's state as
   * this one's: the page warned correctly on load, then twelve seconds later
   * announced "ollama ready" and hid the warning while nothing could answer.
   *
   * `canWarm` is here for the same reason `canStart` is: whether an affordance
   * does anything is a fact about the configured backend, and the page has to be
   * told it rather than deciding it. Under llamacpp all five Preload buttons
   * rendered, and each one loaded a model into Ollama.
   */
  async function runtimeView() {
    const [health, sup] = await Promise.all([runtime.health(), boss.status()]);
    const supervised = SUPERVISED_ADAPTERS.has(health.adapter);
    return {
      adapter: health.adapter,
      running: health.ok,
      version: health.ok ? (health.version ?? null) : null,
      error: health.ok ? null : (health.error ?? 'not reachable'),
      loaded: health.ok && supervised ? sup.loaded : [],
      canStart: supervised && sup.canStart,
      canWarm: supervised,
      bin: supervised ? sup.bin : null,
      starting: supervised ? sup.starting : false,
    };
  }

  /**
   * Refuse before the supervisor is touched. A hidden button is a courtesy; the
   * endpoint is the guarantee. `POST /api/runtime/start` under llamacpp
   * answered {"ok":true,"alreadyRunning":true} — Ollama's state, reported as the
   * configured runtime's — and warm loaded a model into that same wrong process.
   */
  async function requireSupervised(action) {
    const { adapter } = await runtime.health();
    if (SUPERVISED_ADAPTERS.has(adapter)) return;
    throw httpError(
      409,
      `cannot ${action}: runtime.adapter is "${adapter}" and this app can only drive ollama`,
    );
  }

  async function runtimeStatus() {
    return { runtime: await runtimeView() };
  }

  async function startRuntime() {
    await requireSupervised('start the model server');
    const result = await boss.start();
    return { result, runtime: await runtimeView() };
  }

  async function warmModel(_m, body) {
    // Only a model this app ships may be preloaded; the id never reaches the
    // runtime unvalidated. A bad id is the caller's mistake whatever the backend
    // is, so it keeps answering 400 before the backend question is asked.
    const model = requireModel(body?.modelId);
    await requireSupervised('preload a model');
    return { result: await boss.warm(model.id) };
  }

  /**
   * The other half of preload. On an 8 GB card a resident 9B is most of the
   * card, and waiting out KEEP_ALIVE is not a plan when the next thing that
   * wants the GPU is already open. Same gate as warm: catalog id or nothing.
   */
  async function unloadModel(_m, body) {
    const model = requireModel(body?.modelId);
    await requireSupervised('unload a model');
    return { result: await boss.unload(model.id) };
  }

  async function getState() {
    const [view, installed] = await Promise.all([runtimeView(), runtime.listModels()]);
    const models = catalog.withAvailability(installed).map((m) => ({
      ...m,
      fit: catalog.fitFor(m, config.hardware.vramUsableGb),
    }));
    return {
      ok: true,
      runtime: { ok: view.running, adapter: view.adapter, version: view.version, error: view.error },
      supervisor: view,
      hardware: config.hardware,
      modelsDir: config.storage.modelsDir,
      chatsDir: config.storage.chatsDir,
      totalSizeGb: catalog.totalSizeGb(),
      models,
    };
  }

  return [
    ['GET', /^\/api\/runtime$/, runtimeStatus],
    ['POST', /^\/api\/runtime\/start$/, startRuntime],
    ['POST', /^\/api\/runtime\/warm$/, warmModel],
    ['POST', /^\/api\/runtime\/unload$/, unloadModel],
    ['GET', /^\/api\/state$/, getState],
  ];
}

export { SUPERVISED_ADAPTERS };
