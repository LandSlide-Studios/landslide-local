/**
 * Ollama adapter. Protocol only — newline-delimited JSON over POST /api/chat.
 * Everything else is handled by the runtime facade.
 */

import { lines } from './stream-util.js';

export function ollamaAdapter(config = {}) {
  const base = (config.ollamaUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');

  return {
    async health() {
      const res = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`ollama returned ${res.status}`);
      const body = await res.json();
      return { version: body.version, url: base };
    },

    async listModels() {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`ollama returned ${res.status}`);
      const body = await res.json();
      return (body.models ?? []).map((m) => m.name);
    },

    async *stream({ model, messages, options, signal }) {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model,
          messages: messages.map(({ role, content }) => ({ role, content })),
          stream: true,
          options: {
            temperature: options.temperature,
            top_p: options.top_p,
            top_k: options.top_k,
            repeat_penalty: options.repeat_penalty,
            num_ctx: options.num_ctx,
            num_predict: options.num_predict,
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`ollama /api/chat returned ${res.status}: ${await safeText(res)}`);
      }

      for await (const line of lines(res.body, signal)) {
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue; // a partial or non-JSON keepalive line is not fatal
        }
        if (frame.error) throw new Error(`ollama: ${frame.error}`);

        const text = frame.message?.content ?? '';
        const out = {};
        if (text) out.text = text;
        if (frame.done) {
          if (Number.isFinite(frame.prompt_eval_count)) out.promptTokens = frame.prompt_eval_count;
          if (Number.isFinite(frame.eval_count)) out.completionTokens = frame.eval_count;
        }
        if (out.text || out.promptTokens || out.completionTokens) yield out;
        if (frame.done) return;
      }
    },
  };
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '(no body)';
  }
}
