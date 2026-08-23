/**
 * llama.cpp server adapter (OpenAI-compatible endpoints on llama-server).
 *
 * Worth having as a real second adapter, not a hypothetical one: Ollama's
 * Qwen 3.5 support has known rough edges, and llama-server is measurably faster
 * on the same GGUF. Flipping `runtime.adapter` in config.json is the whole
 * migration.
 */

import { sseData } from './stream-util.js';

export function llamaCppAdapter(config = {}) {
  const base = (config.llamaCppUrl ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

  return {
    async health() {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`llama-server returned ${res.status}`);
      let detail = {};
      try {
        detail = await res.json();
      } catch {
        /* /health may return a bare 200 */
      }
      return { version: detail.status ?? 'ok', url: base };
    },

    async listModels() {
      const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`llama-server returned ${res.status}`);
      const body = await res.json();
      return (body.data ?? []).map((m) => m.id);
    },

    async *stream({ model, messages, options, signal }) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model,
          messages: messages.map(({ role, content }) => ({ role, content })),
          stream: true,
          stream_options: { include_usage: true },
          temperature: options.temperature,
          top_p: options.top_p,
          top_k: options.top_k,
          repeat_penalty: options.repeat_penalty,
          max_tokens: options.num_predict,
        }),
      });

      if (!res.ok) {
        throw new Error(`llama-server chat returned ${res.status}: ${await safeText(res)}`);
      }

      for await (const payload of sseData(res.body, signal)) {
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          continue;
        }
        if (frame.error) throw new Error(`llama-server: ${frame.error.message ?? frame.error}`);

        const out = {};
        const delta = frame.choices?.[0]?.delta ?? {};
        // Reasoning arrives out of band on some builds. Pass it through as a
        // typed field rather than re-wrapping it in literal <think> tags: one
        // frame can carry BOTH fields (the old else-if dropped the answer), and
        // reasoning containing the string "</think>" would corrupt the split.
        if (delta.reasoning_content) out.thinking = delta.reasoning_content;
        if (delta.content) out.text = delta.content;

        if (frame.usage) {
          if (Number.isFinite(frame.usage.prompt_tokens)) out.promptTokens = frame.usage.prompt_tokens;
          if (Number.isFinite(frame.usage.completion_tokens)) {
            out.completionTokens = frame.usage.completion_tokens;
          }
        }
        if (out.text || out.thinking || out.promptTokens || out.completionTokens) yield out;
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
