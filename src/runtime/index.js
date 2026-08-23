/**
 * InferenceRuntime — the seam between this app and whatever local model server
 * is running. Callers never learn which one it is.
 *
 * Interface:
 *   name                                     -> string
 *   health()                                 -> Promise<{ ok, adapter, version?, error? }>
 *   listModels()                             -> Promise<string[]>
 *   chat({ model, messages, options, signal, onEvent }) -> Promise<Result>
 *
 *   Event   = { type: 'think'|'answer', text } | { type: 'stats', stats }
 *   Result  = { answer, thinking, stats, aborted }
 *   stats   = { firstTokenMs, totalMs, tokens, tokensPerSecond, promptTokens }
 *
 * The adapters below supply only protocol: how to open a stream and how to pull
 * text deltas out of it. Everything a caller actually cares about — reasoning
 * separation, timing, token accounting, abort semantics — lives here once.
 */

import { createThinkStream } from '../core/think-stream.js';
import { ollamaAdapter } from './ollama.js';
import { llamaCppAdapter } from './llamacpp.js';
import { fakeAdapter } from './fake.js';

const ADAPTERS = {
  ollama: ollamaAdapter,
  llamacpp: llamaCppAdapter,
  fake: fakeAdapter,
};

export function createRuntime(runtimeConfig = {}) {
  const key = String(runtimeConfig.adapter ?? 'ollama').toLowerCase();
  const build = ADAPTERS[key];
  if (!build) {
    throw new Error(`unknown runtime adapter: ${key} (have: ${Object.keys(ADAPTERS).join(', ')})`);
  }
  const adapter = build(runtimeConfig);

  return {
    name: key,

    async health() {
      try {
        const info = await adapter.health();
        return { ok: true, adapter: key, ...info };
      } catch (err) {
        return { ok: false, adapter: key, error: describe(err) };
      }
    },

    async listModels() {
      try {
        return await adapter.listModels();
      } catch {
        return [];
      }
    },

    async chat({ model, messages, options = {}, signal, onEvent = () => {} }) {
      if (!model) throw new Error('chat requires a model');
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('chat requires at least one message');
      }

      const think = createThinkStream({ startInThink: options.startInThink === true });
      const started = Date.now();
      let firstTokenMs = null;
      let answer = '';
      let thinking = '';
      let tokens = 0;
      let promptTokens = 0;
      let aborted = false;

      const push = (events) => {
        for (const e of events) {
          if (e.type === 'think') thinking += e.text;
          else answer += e.text;
          onEvent(e);
        }
      };

      try {
        for await (const delta of adapter.stream({ model, messages, options, signal })) {
          // Out-of-band reasoning is already unambiguous; re-parsing it through
          // ThinkStream could only lose information, so it bypasses.
          if (delta.thinking) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            tokens += 1;
            push([{ type: 'think', text: delta.thinking }]);
          }
          if (delta.text) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            tokens += 1;
            push(think.feed(delta.text));
          }
          if (delta.promptTokens) promptTokens = delta.promptTokens;
          if (delta.completionTokens) tokens = delta.completionTokens;
        }
      } catch (err) {
        if (isAbort(err, signal)) aborted = true;
        else throw err;
      }

      push(think.end());

      const totalMs = Date.now() - started;
      const genMs = firstTokenMs === null ? totalMs : Math.max(1, totalMs - firstTokenMs);
      const stats = {
        firstTokenMs,
        totalMs,
        tokens,
        promptTokens,
        tokensPerSecond: tokens > 0 ? Number(((tokens / genMs) * 1000).toFixed(1)) : 0,
      };
      onEvent({ type: 'stats', stats });

      return { answer, thinking, stats, aborted };
    },
  };
}

function isAbort(err, signal) {
  return err?.name === 'AbortError' || signal?.aborted === true;
}

function describe(err) {
  const msg = String(err?.message ?? err);
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    return 'Not reachable — is the model server running?';
  }
  return msg;
}

export { ADAPTERS };
