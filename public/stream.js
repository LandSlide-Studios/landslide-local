/**
 * One reply, from the request to the composer coming back.
 *
 * Both doors into a generation — a new message and a regenerate — come through
 * `streamReply`, so they cannot drift apart: the same pending shell, the same
 * abort handle, the same `finally` that gives the composer back whatever
 * happened.
 *
 * Event names come from the shared vocabulary rather than from string literals.
 * The server writes that same module's names, so a rename cannot leave this loop
 * quietly ignoring an event with no error anywhere.
 */

import { apiFetch } from './api-client.js';
import { NO_OUTPUT, dur, els, notify, scheduleThinkScroll, scrollToEnd, state, statLine } from './dom.js';
import { buildMessage, renderContext, updateChatActions } from './message-view.js';
import { appendStream, renderText } from './render.js';
import { EVENT } from './shared/events.js';
import { loadChats } from './sidebar.js';

/**
 * One reply, streamed into a fresh assistant node.
 *
 * Both doors — a new message and a regenerate — come through here so they
 * cannot drift apart: the same pending shell, the same abort handle, the same
 * finally that gives the composer back whatever happened. The caller has
 * already claimed `state.busy`.
 */
async function streamReply({ path, payload, model }) {
  const reply = buildMessage('assistant', '', '', null, { pending: true });
  const replyText = reply.querySelector('.msg-text');
  const think = reply.querySelector('.think');
  const thinkText = reply.querySelector('.think-text');
  const thinkTime = reply.querySelector('.think-time');
  const statsEl = reply.querySelector('.msg-stats');
  replyText.classList.add('is-streaming');
  els.thread.append(reply);
  scrollToEnd();

  setBusy(true, model.thinks ? 'Thinking' : 'Writing');

  state.abort = new AbortController();
  let answer = '';
  let reasoning = '';
  let sawAnswer = false;
  let thinkStartedAt = performance.now();

  try {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: state.abort.signal,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `server returned ${res.status}` }));
      throw new Error(err.error);
    }

    for await (const event of sseEvents(res.body)) {
      if (event.type === 'start') {
        renderContext(event.context);
        // The one thing this item exists to prevent: turns leaving the prompt
        // without anybody being told. It goes in the notice bar, which survives
        // every re-render, rather than anywhere that gets wiped.
        const dropped = event.context?.trimmed ?? 0;
        if (dropped > 0) {
          notify(
            `This conversation is past ${model.name}'s ${Number(event.context.limitTokens).toLocaleString()}-token window. ` +
              `The ${dropped} oldest turn${dropped === 1 ? '' : 's'} ${dropped === 1 ? 'was' : 'were'} left out of this reply — ` +
              'still saved in the chat, just not shown to the model.',
          );
        }
      } else if (event.type === 'think') {
        reasoning += event.text;
        think.hidden = false;
        if (!sawAnswer) think.open = true; // watch it reason, then get out of the way
        // Append, never re-assign: a real model emits thousands of reasoning
        // tokens, and replacing textContent each time is quadratic. Reading
        // scrollHeight here forced a synchronous reflow per token on top of it,
        // which was enough to lock the renderer on a long reasoning pass.
        appendStream(thinkText, reasoning, event.text);
        scheduleThinkScroll(thinkText);
        els.statusLabel.textContent = 'Thinking';
      } else if (event.type === 'answer') {
        if (!sawAnswer) {
          sawAnswer = true;
          els.statusLabel.textContent = 'Writing';
          if (reasoning) {
            thinkTime.textContent = dur(performance.now() - thinkStartedAt);
            think.open = false;
          }
        }
        answer += event.text;
        appendStream(replyText, answer, event.text);
        replyText.classList.add('is-streaming');
        scrollToEnd();
      } else if (event.type === 'stats') {
        els.statusMeta.textContent = `${event.stats.tokens} tok · ${event.stats.tokensPerSecond} tok/s`;
      } else if (event.type === 'done') {
        statsEl.textContent = statLine(event.stats) + (event.aborted ? '  ·  stopped' : '');
        await loadChats(els.chatSearch.value);
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      reply.classList.add('msg-error');
      renderText(replyText, answer ? `${answer}\n\n[${err.message}]` : `[${err.message}]`, model.format);
    }
  } finally {
    replyText.classList.remove('is-streaming');
    if (!answer && !reasoning && !reply.classList.contains('msg-error')) {
      renderText(replyText, NO_OUTPUT, model.format);
    }
    setBusy(false);
    state.abort = null;
    scrollToEnd();
  }
}

async function* sseEvents(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    yield* readFrames(reader, dec, buf);
  } finally {
    // An error thrown by the consumer (an SSE 'error' event) would otherwise
    // leave the reader locked and the body never cancelled.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

async function* readFrames(reader, dec, buf) {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          yield JSON.parse(line.slice(6));
        } catch {
          /* ignore a malformed frame rather than killing the stream */
        }
      }
    }
  }
}

/* ---------------- busy state + timer ---------------- */

function setBusy(busy, label = 'Thinking') {
  state.busy = busy;
  clearInterval(state.timerHandle); // never leave an orphaned interval ticking
  state.timerHandle = null;
  els.send.disabled = busy;
  els.prompt.disabled = busy;
  // Honest affordance for the gate in busyBlocks(): the button is not merely
  // ignored while a reply is streaming, it visibly cannot be pressed.
  els.newChat.disabled = busy;
  els.statusBar.hidden = !busy;
  updateChatActions();

  if (busy) {
    els.statusLabel.textContent = label;
    els.statusMeta.textContent = '';
    state.startedAt = performance.now();
    els.timer.textContent = '0.0s';
    state.timerHandle = setInterval(() => {
      els.timer.textContent = `${((performance.now() - state.startedAt) / 1000).toFixed(1)}s`;
    }, 100);
  } else {
    els.prompt.focus();
  }
}

export { setBusy, streamReply };
