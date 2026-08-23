/**
 * Fake adapter — the test double for the InferenceRuntime seam.
 *
 * Scripted, deterministic and instant by default, so the runtime facade's real
 * behaviour (think separation, timing, abort, token accounting) can be tested
 * without a model server anywhere near it.
 *
 * Also usable at runtime with `runtime.adapter = "fake"` to exercise the whole
 * UI with no model downloaded.
 */

const DEFAULT_SCRIPT = '<think>Working out what they meant.</think>This is a scripted reply.';

export function fakeAdapter(config = {}) {
  const script = config.script ?? DEFAULT_SCRIPT;
  const chunkSize = config.chunkSize ?? 4;
  const delayMs = config.delayMs ?? 0;
  const failWith = config.failWith ?? null;
  const models = config.models ?? ['cold-fusion-9b', 'heretic-instruct-9b'];

  return {
    async health() {
      if (failWith) throw new Error(failWith);
      return { version: 'fake-1', url: 'memory://fake' };
    },

    async listModels() {
      if (failWith) throw new Error(failWith);
      return models;
    },

    async *stream({ signal, options = {} }) {
      if (failWith) throw new Error(failWith);
      const body = options.script ?? script;
      for (let i = 0; i < body.length; i += chunkSize) {
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        if (delayMs) await sleep(delayMs, signal);
        yield { text: body.slice(i, i + chunkSize) };
      }
      yield { promptTokens: 11, completionTokens: Math.ceil(body.length / chunkSize) };
    },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      },
      { once: true },
    );
  });
}
