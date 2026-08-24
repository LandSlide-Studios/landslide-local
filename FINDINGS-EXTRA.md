# FINDINGS-EXTRA — noticed while building I0, deliberately NOT fixed

Out of scope for I0. Recorded here rather than absorbed, per the loop protocol.
Ordered by how much they would cost to leave.

---

## E1. `deleteChat` is the third door onto the M8 bug (frontend)

`public/app.js` — M8 named the New-chat button, Ctrl+N and chat rows, and all
three are now gated by `busyBlocks()`. `deleteChat(id)` is the same bug through a
door the finding did not name: deleting the chat that is currently streaming runs
`els.thread.replaceChildren(els.emptyState)`, detaching the node the stream is
writing into, and the generation is never aborted — the GPU keeps working with
nowhere to put the answer.

One line, same helper: `if (busyBlocks('Deleting this chat')) return;` — but only
when `id === state.chatId`, since deleting some *other* chat mid-stream is
harmless and should stay allowed.

## E2. Old replies are labelled with the currently selected model

`public/app.js` `buildMessage()` sets the role line from `currentModel()?.name`
for every assistant message, including ones loaded from disk. Open a chat that
was answered by Deckard while Cold Fusion is selected and every historical reply
claims Cold Fusion wrote it. The correct name is not recoverable per message:
chats store one `modelId`, so proper provenance needs `messages[].modelId`
recorded at append time. Directly undermines the "switching models
mid-conversation is fine" line in the README.

## E3. `PATCH /api/chats/:id` accepts any string as `modelId`

`applyPatch()` in `src/core/chat-store.js` is already a whitelist (title and
modelId only), but `modelId` is never checked against the catalog, so a request
can persist `"modelId": "dolphin-llama3:70b"` onto a chat record. It is not an
execution path — `postMessage` validates `body.modelId` against the catalog
independently and I0-I5 closed the runtime side — so this is data integrity, not
a way to run an unlisted model. It does mean a chat can be left pointing at a
model the sidebar cannot show.

## E4. A failing acceptance test hangs `node --test`

Every test in `test/acceptance/` does `await a.close()` / `await stub.close()` as
its *last* statements, so an assertion failure skips them and leaves the stub and
the app server listening. Node then cannot exit and the run sits there until the
outer timeout — before the I0 fixes, `node --test "test/acceptance/i0-*.test.js"`
never terminated, which reads as "the suite is hung" rather than "19 tests
failed". The fix is `t.after(() => ...)` (or try/finally) instead of trailing
closes.

Worse, and separate: **`node --test` (the PLAN.md gate) never returns at all
right now.** All 200 tests run and report, then the process hangs. Isolated by
running each suite alone: `i3-mcp.test.js` is the one that hangs — it waits on an
MCP stdio server that does not exist yet, and `--test-force-exit` does not
release it. Every other suite finishes in under 10 seconds. Until I3 is built,
that gate has to be run with an external timeout and read from the printed
summary. Acceptance files are not the builder's to edit; this is for the planner.

## E5. `config.json` breaks the convention CLAUDE.md states

CLAUDE.md: *"Windows paths in `config.json` use **forward slashes**."*
`runtime.ollamaEnv.OLLAMA_MODELS` is `"N:\ollama-models"`. It parses — the
backslash is escaped — but it is the one place in the file that does it, and the
convention exists because the unescaped version is a confusing JSON failure.

## E6. Dead code in `scripts/preflight.mjs`

`exists()` at the bottom of the file has no callers.

## E7. `src/runtime/llamacpp.js` sends non-OpenAI fields

`stream()` puts `top_k` and `repeat_penalty` at the top level of the
`/v1/chat/completions` body. llama-server accepts both as extensions; any other
OpenAI-compatible server would reject the request. Fine while llama-server is the
only target — worth a comment saying so, since the file describes itself as
"OpenAI-compatible".

## E8. `I0b-F9g` can never read a test count, whatever the README says

`test/acceptance/i0b-verifier-findings.test.js` parses `# tests (\d+)` out of a
nested `node --test` run. The outer runner exports `NODE_TEST_CONTEXT=child-v8`,
`execFile` inherits it, and the nested runner therefore emits the V8-serialised
child stream instead of TAP — its stdout is empty. Measured: `o.length === 0`,
`/^# tests (\d+)$/m.test(o) === false`, while the same command standalone prints
`# tests 79`.

So the comparison branch is unreachable and the assertion can only ever hold by
the README not making a `N tests, no model needed` claim at all — which is what
round 2 did, and is the right outcome for a different reason (the count was
attached to `npm test`, which no longer runs only those suites). Recorded because
the test reads as if it verifies the number, and it does not. Passing
`env: { ...process.env, NODE_TEST_CONTEXT: undefined }` to `run()` would make it
real. Acceptance files are not the builder's to edit; this is for the planner.

## E9. A stale app process from an earlier round is still listening on 4399

`http://127.0.0.1:4399` answers with this app running pre-round-2 code — its
`/api/state` has no `supervisor` key at all — against
`chatsDir=N:\landslide-local\.smoke-chats`. It survived whatever session started
it. Left running: killing someone else's process is not this round's call. Worth
knowing before the next smoke test picks that port, and worth noting that
`.smoke-chats` is not in `.gitignore` the way `.demo-chats/` is, so a run that
leaves the folder behind shows up as untracked repo content.

## E10. `start-demo.cmd` no longer offers Preload, and that is the fix working

The fake adapter is not one the supervisor can drive, so `canWarm` is false and
the demo's five Preload buttons are gone. Verified live: adapter `fake` on 4401
renders 5 model cards and 0 Preload buttons, and `POST /api/runtime/warm` there
answers 409. Before F9-C those buttons were live in the demo and loaded models
into a real Ollama. Flagged only because the README's demo paragraph does not
mention preload either way — nothing to correct, but the demo does look sparser
than it did.

## E11. `I2-D2` can never read a pass count, for the same reason as `I0b-F9g`

`test/acceptance/i2-architecture.test.js:183` shells out to
`node --test test/chat-store.test.js ...` and asserts on `/^# fail (\d+)$/m`.
Run standalone that command prints `# tests 79 / # fail 0`; run as a child of
the test runner it inherits `NODE_TEST_CONTEXT`, switches to the internal
serializer, and `execFileSync` returns nothing the regex can match — so the
assertion fails with `undefined !== '0'` no matter how green those suites are.
Confirmed by hand: same command, same cwd, outside a runner, 13,127 bytes of TAP
and `# fail 0`. It is an I2 file so it is failing for an unbuilt item anyway,
but it would keep failing after I2 is built. Same fix as E8 — pass
`env: { ...process.env, NODE_TEST_CONTEXT: undefined }`. Acceptance files are
not the builder's to edit; this is for the planner.

## E12. A blank line inside a list splits it, and that is deliberate

`render.js` treats a blank line as a hard boundary: everything before it can
never be re-parsed, which is what keeps a long stream from re-rendering itself
on every token. The cost is that a "loose" list —

    - first

    - second

— arrives as two `<ul>`s rather than one. Numbering survives (an `<ol>` carries
`start`, so a split step list still reads 4, 5, 6), and the margins make the
seam hard to see, but the DOM is two lists. Making it one would mean a boundary
that depends on text that has not arrived yet, and that is exactly the class of
guess that breaks the stream/reload equivalence. Flagged so the next person does
not "fix" it without knowing what it buys.

## E13. Indented code blocks are not supported, on purpose

Four-space indentation means a nested list item here, not a code block. The
reasoning models indent sub-bullets by four spaces constantly (the trace in the
I8 spec does it), so honouring the CommonMark indented-code rule would turn most
of a reasoning trace into code boxes. Fenced code is unaffected. Worth knowing
if a model ever writes indented code and it comes out as prose.

## E14. The reasoning panel had no rules for `pre` or `code`

Pre-existing, found while looking at a real trace: `.msg-text pre` was styled
and `.think-text pre` never was, so a code fence inside reasoning — which the
models write constantly — kept the UA default `white-space: pre` and pushed a
horizontal scrollbar across the whole trace. Measured before the fix on a real
Deckard run: `scrollWidth` 3443 against `clientWidth` 787. Fixed in this round
because it is the same panel I8 renders into; noted here because it was not an
I8 defect.

## E15. `test/render.test.js` is new and is not part of any gate

Added this round, outside `test/acceptance/`. It pins the one invariant the I8
suite only samples: streamed and reloaded DOM must match at every chunk size.
Both bugs it names were real and were found by its fuzz case, not by hand — a
paragraph that had gained a trailing newline swallowed it on the fast path, and
a line sitting under a table separator turned into a row on a single `|`
without the renderer noticing. It runs in 0.2s and is picked up by bare
`npm test` auto-discovery; it is not in `npm run test:core`, so the planner may
want it there.
