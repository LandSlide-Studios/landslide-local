/**
 * ChatExport — a conversation as a file the user can keep.
 *
 * Interface:
 *   FORMATS                -> the set of format names accepted
 *   isFormat(name)         -> boolean
 *   exportChat(chat, fmt)  -> { body, contentType, filename }
 *
 * Markdown rather than a private format on purpose: the chats already live as
 * readable JSON on the user's own disk, so the thing missing was not a second
 * machine format but one a person can paste into anything. Reasoning is kept,
 * folded into a details block so it does not drown the answer.
 */

const MD_TYPE = 'text/markdown; charset=utf-8';

export const FORMATS = Object.freeze(['md', 'markdown']);

export function isFormat(name) {
  return FORMATS.includes(String(name ?? '').toLowerCase());
}

export function exportChat(chat, format = 'md') {
  if (!isFormat(format)) throw new Error(`unsupported export format: ${format}`);
  return {
    body: toMarkdown(chat),
    contentType: MD_TYPE,
    filename: `${slug(chat?.title) || 'chat'}.md`,
  };
}

export function toMarkdown(chat) {
  const out = [`# ${chat?.title ?? 'Chat'}`, ''];

  const messages = chat?.messages ?? [];
  // Replies written before they recorded their own model fall back to the
  // chat's, which is a guess. Said once here rather than hung off every
  // heading: on a chat that predates the field, every heading would carry it.
  const anyInferred = messages.some((m) => m.role !== 'user' && !m.modelId);

  const meta = [];
  if (chat?.modelId) meta.push(`model: ${chat.modelId}`);
  if (chat?.createdAt) meta.push(`started: ${chat.createdAt}`);
  if (anyInferred && chat?.modelId) {
    meta.push('some replies predate per-reply model tracking and are shown under this chat\'s model');
  }
  if (meta.length) out.push(`_${meta.join(' · ')}_`, '');

  if (chat?.systemPrompt) {
    out.push('## System prompt', '', fence(chat.systemPrompt), '');
  }

  for (const m of messages) {
    // The reply's OWN model, same as the page. Reading chat.modelId here meant
    // the exported file — the copy that leaves this machine and outlives the
    // app — reattributed every earlier reply to whatever model the chat had
    // last been switched to.
    // Marked per heading, not only once at the top. A note saying "some replies"
    // raises a question the file then gives the reader no way to answer - three
    // identical headings, one of them a fact and two of them guesses.
    const inferred = m.role !== 'user' && !m.modelId;
    const author = m.role === 'user' ? 'You' : (m.modelId ?? chat?.modelId ?? 'Model');
    out.push(`## ${author}${inferred && chat?.modelId ? ' (assumed)' : ''}`, '');
    if (m.thinking) {
      // A reasoning trace is context, not the answer, and it is routinely
      // longer than the answer it produced. Collapsed keeps the export
      // readable without throwing the trace away.
      out.push('<details><summary>Reasoning</summary>', '', m.thinking.trimEnd(), '', '</details>', '');
    }
    out.push(String(m.content ?? '').trimEnd() || '_[no output]_', '');
  }

  return out.join('\n');
}

/**
 * A fence long enough to contain whatever is inside it. A system prompt that
 * itself contains three backticks would otherwise close the block early and
 * spill the rest of the document into it.
 */
function fence(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}\n${String(text).trimEnd()}\n${ticks}`;
}

/** A filename a filesystem will take, on any of them. */
function slug(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
