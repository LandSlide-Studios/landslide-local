/**
 * The page itself: the elements, the state they show, and the few readings of
 * that state everything else asks for.
 *
 * `els` and `state` are the two objects every other frontend module needs, so
 * they sit at the bottom of the import graph and nothing here imports anything.
 *
 * `mountDom()` is why `els` starts empty. Binding the element table at module
 * scope would tie it to whichever document existed the first time this file was
 * evaluated — and `test/ui.test.js` builds a fresh DOM from the real index.html
 * for each of its cases, re-importing app.js per case while the modules under it
 * stay cached. Filling the SAME object on every `init()` is what keeps those
 * cases independent. In a browser it changes nothing: the page loads this module
 * once, `init()` runs once, and the elements exist by then either way.
 */

export const els = {};

export const state = {};

const $ = (id) => document.getElementById(id);

/** Bind the element table and reset the state to a fresh page's. */
export function mountDom() {
  for (const key of Object.keys(els)) delete els[key];
  Object.assign(els, {
  runtimeState: $('runtimeState'),
  modelList: $('modelList'),
  chatList: $('chatList'),
  chatSearch: $('chatSearch'),
  newChat: $('newChat'),
  thread: $('thread'),
  emptyState: $('emptyState'),
  emptyFacts: $('emptyFacts'),
  composer: $('composer'),
  prompt: $('prompt'),
  send: $('send'),
  charCount: $('charCount'),
  statusBar: $('statusBar'),
  statusLabel: $('statusLabel'),
  statusMeta: $('statusMeta'),
  timer: $('timer'),
  stopBtn: $('stopBtn'),
  storageHint: $('storageHint'),
  runtimeBar: $('runtimeBar'),
  runtimeMsg: $('runtimeMsg'),
  startRuntime: $('startRuntime'),
  notice: $('notice'),
  noticeMsg: $('noticeMsg'),
  noticeDismiss: $('noticeDismiss'),
  systemPrompt: $('systemPrompt'),
  promptLibrary: $('promptLibrary'),
  promptName: $('promptName'),
  savePrompt: $('savePrompt'),
  deletePrompt: $('deletePrompt'),
  contextMeter: $('contextMeter'),
  exportChat: $('exportChat'),
  regenerate: $('regenerate'),
  tpl: $('tpl-message'),
  });

  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, {
  models: [],
  chats: [],
  prompts: [],
  modelId: localStorage.getItem('ls.modelId') || null,
  chatId: null,
  busy: false,
  loaded: [],
  runtimeUp: false,
  canWarm: false,
  runtimeSig: null,
  hardwareLabel: '',
  abort: null,
  timerHandle: null,
  startedAt: 0,
  // What the server was last told this chat's system prompt is. Without it
  // every keystroke would be a PATCH, and every send would rewrite an
  // unchanged field.
  savedSystemPrompt: '',
  });
}

/**
 * The one place a failure is allowed to live.
 *
 * A message written onto a model card is destroyed milliseconds later by the
 * next renderModels(), so the user never sees it. This element is outside every
 * list that gets rebuilt, and stays until it is dismissed or replaced.
 */
function notify(message) {
  els.noticeMsg.textContent = message;
  els.notice.hidden = false;
}

function clearNotice() {
  els.notice.hidden = true;
  els.noticeMsg.textContent = '';
}

/**
 * Switching what the thread shows while a reply is streaming detaches the node
 * the stream is writing into, and the generation carries on with nowhere to go:
 * the GPU keeps working and the answer is lost. Stop first, then switch.
 */
function busyBlocks(action) {
  if (!state.busy) return false;
  notify(`${action} while a reply is generating would discard it. Press Stop (or Esc) first.`);
  return true;
}

const isResident = (id) => state.loaded.some((m) => m.name === id || m.name === `${id}:latest`);

const currentModel = () => state.models.find((m) => m.id === state.modelId);

/** A model by id, whatever is selected right now. Used to label a reply with
    the model that wrote it rather than the one currently highlighted. */
const modelById = (id) => (id ? state.models.find((m) => m.id === id) : undefined);

/** What a finished turn that produced nothing shows — while streaming and after. */
const NO_OUTPUT = '[no output]';

/** Sub-second values read as "0.0s", which looks broken. Show ms below 1s. */
function dur(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statLine(s) {
  const bits = [];
  if (s.totalMs != null) bits.push(`${dur(s.totalMs)} total`);
  if (s.firstTokenMs != null) bits.push(`${dur(s.firstTokenMs)} to first token`);
  if (s.tokens) bits.push(`${s.tokens} tokens`);
  if (s.tokensPerSecond) bits.push(`${s.tokensPerSecond} tok/s`);
  return bits.join('  ·  ');
}

let thinkScrollQueued = false;
function scheduleThinkScroll(el) {
  if (thinkScrollQueued) return;
  thinkScrollQueued = true;
  requestAnimationFrame(() => {
    thinkScrollQueued = false;
    el.scrollTop = el.scrollHeight;
  });
}

let endScrollQueued = false;
function scrollToEnd() {
  if (endScrollQueued) return;
  endScrollQueued = true;
  requestAnimationFrame(() => {
    endScrollQueued = false;
    els.thread.scrollTop = els.thread.scrollHeight;
  });
}

export { NO_OUTPUT, busyBlocks, clearNotice, currentModel, dur, isResident, modelById, notify, scheduleThinkScroll, scrollToEnd, statLine };
