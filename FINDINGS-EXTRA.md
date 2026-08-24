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

## E11. I6-D1 passed before any guard existed, off a comment

`I6-D1` walks `src/` and greps every `.js` for `unhandledRejection|uncaughtException`.
`src/server.js` already carried the word in a prose comment explaining why
`pipeline` replaced `.pipe()` — so the test reported green on the round it was
written, with no handler anywhere in the process. It was the one of the ten that
passed at the start of this item. A real guard is now installed in the entry
block, so the assertion is true for the right reason, but the check cannot tell
the difference between a handler and a sentence. Something like spawning
`src/server.js`, planting a rejection and asserting the process is still
answering would be real. Acceptance files are not the builder's to edit; this is
for the planner.

## E12. On Windows a SIGTERM from another process skips the shutdown handler

The entry point logs `shutting down` on SIGINT/SIGTERM and flushes the log before
exiting. Verified working under a real Ctrl+C path only: Node on Windows maps
`child.kill('SIGTERM')` onto TerminateProcess, so a server killed by another
process dies without running the handler and the line never appears. Pre-existing
platform behaviour, not something this item changed — noted so nobody reads a
missing `shutting down` line as a bug in the logger.

## E13. `config.json` still pins `storage.chatsDir` to an absolute path

`"chatsDir": "N:/landslide-local/chats"` resolves identically to the relative
`"./chats"` for the real install, because `ROOT` *is* `N:\landslide-local`. The
absolute form is what makes every git worktree of this repo read and write the
one live chats folder — which is why the smoke tests in this round all used
`LANDSLIDE_CHATS_DIR` to point somewhere else. Left alone deliberately: changing
where chats live is not I6's call, and another builder is running against that
folder right now. `storage.logFile` was added as `./logs/app.log` so at least the
new path does not repeat it.
