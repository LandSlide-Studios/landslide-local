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
          // Ollama resets the eviction timer from whatever each request says.
          // Omitting it dropped a model preloaded for 30 minutes back to the
          // 5-minute default on the very first message.
          keep_alive: options.keepAlive,
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

        const out = {};
        // Ollama 0.32+ streams reasoning out of band in message.thinking rather
        // than as <think> tags inside content. Reading only content silently
        // discarded every reasoning token.
        const thinking = frame.message?.thinking ?? '';
        const text = frame.message?.content ?? '';
        if (thinking) out.thinking = thinking;
        if (text) out.text = text;
        if (frame.done) {
          if (Number.isFinite(frame.prompt_eval_count)) out.promptTokens = frame.prompt_eval_count;
          if (Number.isFinite(frame.eval_count)) out.completionTokens = frame.eval_count;
          // The server's own generation clock is authoritative; ours cannot see
          // time spent before the first token is flushed.
          if (Number.isFinite(frame.eval_duration)) out.evalMs = frame.eval_duration / 1e6;
        }
        if (out.text || out.thinking || out.promptTokens || out.completionTokens || out.evalMs) {
          yield out;
        }
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
