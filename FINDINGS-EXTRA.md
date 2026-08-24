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
## E14. `I3-A10` does not test what its name and comment say (locked file)

`test/acceptance/i3-mcp.test.js:277-286` is named "malformed JSON on stdin does
not kill the server" and carries the comment `// Deliberately not valid JSON-RPC.`
— but the harness exposes only `call()` and `notify()`, both of which write valid
JSON, and the test's only write between initialize and the final `tools/list` is a
well-formed `notifications/initialized`. So the test proves the server survives a
*notification*, not junk. The parse-error path it means to cover is never entered.

Not fixable from here: acceptance files are locked and are not the builder's to
edit. The behaviour it intended to pin does work — verified by hand instead, by
piping a literal `not json at all {{{` line into a live server between two real
calls. The server answered
`{"jsonrpc":"2.0","id":null,"error":{"code":-32700,...}}`, kept the session up and
completed the calls on either side of it. Someone with the planner's authority
should give the harness a `raw(text)` method and have A10 use it.

## E15. `ChatStore.search()` re-reads and re-parses every chat file per query

`readAll()` in `src/core/chat-store.js` reads and `JSON.parse`s the whole store on
every `search()`. At 9 chats that is nothing. It is worth knowing that
`search_chats` is now reachable from an MCP client, where an agent may call it in
a loop, so the cost is no longer bounded by how fast a human can type into the
Ctrl+K box. Not a problem yet, and not worth a cache until the store is large;
recorded so the next person does not discover it as a surprise.
## E16. `I2-D2` can never read a pass count, for the same reason as `I0b-F9g`

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

## E17. A blank line inside a list splits it, and that is deliberate

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

## E18. Indented code blocks are not supported, on purpose

Four-space indentation means a nested list item here, not a code block. The
reasoning models indent sub-bullets by four spaces constantly (the trace in the
I8 spec does it), so honouring the CommonMark indented-code rule would turn most
of a reasoning trace into code boxes. Fenced code is unaffected. Worth knowing
if a model ever writes indented code and it comes out as prose.

## E19. The reasoning panel had no rules for `pre` or `code`

Pre-existing, found while looking at a real trace: `.msg-text pre` was styled
and `.think-text pre` never was, so a code fence inside reasoning — which the
models write constantly — kept the UA default `white-space: pre` and pushed a
horizontal scrollbar across the whole trace. Measured before the fix on a real
Deckard run: `scrollWidth` 3443 against `clientWidth` 787. Fixed in this round
because it is the same panel I8 renders into; noted here because it was not an
I8 defect.

## E20. `test/render.test.js` is new and is not part of any gate

Added this round, outside `test/acceptance/`. It pins the one invariant the I8
suite only samples: streamed and reloaded DOM must match at every chunk size.
Both bugs it names were real and were found by its fuzz case, not by hand — a
paragraph that had gained a trailing newline swallowed it on the fast path, and
a line sitting under a table separator turned into a row on a single `|`
without the renderer noticing. It runs in 0.2s and is picked up by bare
`npm test` auto-discovery; it is not in `npm run test:core`, so the planner may
want it there.

## E21. `openChat` and `deleteChat` are the two fetches with no rejection path

Every other network call in `public/app.js` handles a rejected fetch: `startNewChat`
wraps `newChat()` and calls `notify()`, `warmModel` and `startRuntime` both catch and
put the reason on screen, `refreshRuntime` swallows a failed poll on purpose, and
`selectModel`'s PATCH carries `.catch(() => {})`. `openChat` and `deleteChat` do not.
Both are `async function` bodies whose `await fetch(...)` is unguarded, and both are
invoked from a click listener that discards the promise — so if the server is gone,
clicking a chat row or its × produces an unhandled rejection and nothing at all
happens on screen. `openChat` already has an `if (!res.ok) return;`, which shows the
failure mode was thought about for an answering server and not for an absent one.

Found while writing `test/ui.test.js`: an in-flight `openChat` outliving the test's
server teardown surfaced as a bare `TypeError: fetch failed`. The test was tightened
so it no longer races the teardown, which means the test no longer sees this — the
app behaviour is unchanged and still there. Out of scope for I7, which is about
tests rather than app behaviour; a two-line `try/catch` + `notify()` in each, matching
`startNewChat`, is the whole fix.

## E16. There is no migration back from encrypted to plain files

`src/core/store-migrate.js` exports `migrateToEncrypted` and nothing else, so
turning encryption on is a one-way door. `npm run backup` does not help: it
archives the folder byte for byte, so a backup of an encrypted folder restores as
encrypted. The only way out today is to copy conversations out of the running app
by hand.

Left alone deliberately — I4 specified one direction and the acceptance suite
pins one direction. The reverse is close to free given what is already there: the
same encrypt/verify/delete skeleton with `open()` and `seal()` swapped, writing
`<id>.json` and removing `<id>.enc`. The README says plainly that there is no way
back rather than leaving it to be discovered. Worth its own small item.

## E17. Encryption hides the contents of a chat, not the shape of the folder

The envelope covers title, messages and reasoning. It cannot cover what the
filesystem itself records, and the README lists this but it is worth stating once
in the engineering notes too: the file name is the chat id, so **how many**
conversations exist is visible, and each file's size and mtime say roughly how
long a conversation is and when it was last touched. `logs\app.log` separately
records request paths, which include those chat ids.

None of that is a defect in the scheme — it is what file-per-record storage
means, and hiding it needs a single-container store or padding, both of which
cost more than they are worth at this scale. Recorded so nobody later reads "the
chats are encrypted" as "the folder tells you nothing".

## E18. Quarantined `.corrupt` files keep plaintext indefinitely

`createFileStore`'s `quarantine()` renames an unreadable chat to
`<id>.json.corrupt` and leaves it there forever. Nothing ever revisits those
files, so a folder that has been running a while accumulates plaintext that
survives `encrypt-chats` — which reports them under `leftBehind` and refuses to
touch them, on the grounds that a file that already went wrong once is not one to
delete on a script's judgement.

The gap is that there is no second step. Something should eventually offer to
show, re-import or remove them; today the only instruction is a warning line
telling the user to deal with it by hand.

## E19. `window.prompt` is not available in every browser this app will meet

Not a repo finding so much as one worth writing down: the first cut of the token
ask used `window.prompt`, and the browser it was tested in answered
`prompt() is not supported`. Chrome refuses it in several embeddings and
suppresses it after the first dialog in others — and because the ask fires on the
app's very first request, the failure mode is the entire UI coming up empty with
nothing said about why.

It is now built out of DOM nodes in the existing notice bar. `alert` and
`confirm` do not appear anywhere in `public/`, and should not start.
