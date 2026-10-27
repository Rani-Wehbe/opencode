# PR 1: Core step-path efficiency — `core-step-efficiency`

> Branch: `core-step-efficiency` · commit `650a3c2` · targets `dev` · pushed to `fork`.
> Draft PR body: `documentation/pr-draft-core-step-efficiency.md` (ready for `gh pr create`).

## Why

Research into opencode's efficiency (see `research-efficiency.md` in this directory) ranked the per-step
LLM loop as the hottest path. Every drain of a session was doing more work than it needed to:

1. **Stale-tool settlement loaded the whole transcript.** `SessionRunner.settleStaleToolCalls` runs at
   the start of every drain (every prompt, steer, and resume). It called `store.context(sessionID)` —
   i.e. `SessionHistory.load(db, sessionID, "latest")` — which selects **every row since the last
   compaction**, blob-hydrates it, and schema-decodes each row. All of that existed only to look for
   tool parts stuck in `streaming`/`running`. On the overwhelming majority of drains there is no stale
   tool at all, so the entire load was pure waste. This is the mechanism behind issue #50063 ("slow
   resume after ~50 rounds"): the cost grows linearly with transcript length on every resume.

2. **Tool schemas were re-serialized on every request.** `SessionModelRequest.prepare` deep-copied each
   tool's `inputSchema` with `JSON.parse(JSON.stringify(...))` for every request (primary, compaction,
   title, retry). Tool definitions are shared across steps and sessions — the schema objects never
   change — so the same `JSON.stringify` walk repeated on every single LLM call.

## What changed

### 1. Targeted stale-tool query — `packages/core/src/session/history.ts` (+30 lines)

New `SessionHistory.staleTools(db, sessionID)`:

```sql
SELECT * FROM session_message
WHERE session_id = ? AND type = 'assistant'
  AND seq >= <latest completed compaction seq>
  AND EXISTS (
    SELECT 1 FROM json_each(session_message.data, '$.content') AS part
    WHERE json_extract(part.value, '$.type') = 'tool'
      AND json_extract(part.value, '$.state.status') IN ('streaming', 'running')
  )
ORDER BY seq
```

- Uses the existing `(session_id, type, seq)` index (`session_message_session_type_seq_idx`), so the
  filter and ordering are both covered.
- The `json_each` pattern matches the existing idiom in `stats.ts:194-204`.
- Matching rows are decoded with `decodeMessageRow` **without blob hydration** (matching
  `settleStaleCompactions` directly above it, which already uses that exact idiom).

### 2. Runner wiring — `packages/core/src/session/runner/llm.ts` (+4/-2)

`settleStaleToolCalls` now iterates `SessionHistory.staleTools(db, sessionID)` instead of
`store.context(sessionID)`. The event-publishing loop is otherwise untouched.

### 3. Schema JSON cache — `packages/core/src/session/model-request.ts` (+12/-1)

Module-level `schemaCache = new WeakMap<object, string>()` + `schemaJSON(schema)`:

- First request for a given schema object: `JSON.stringify` once, store the immutable string.
- Every request: `JSON.parse(cachedString)` — a **fresh object each time**, so hooks that edit their
  copy in place stay isolated. Only the stringify half (the expensive walk) is eliminated.

## Correctness reasoning (why this is behavior-preserving)

### Result-set equivalence for `staleTools`

The original iterated `load(db, sessionID, "latest")` → `messageEntries` with `boundary === "latest"`:

- `replayable(message, "latest")` always returns `true` (it short-circuits on `boundary === "latest"`),
  so no rows were dropped by replayability.
- The only other row filter drops `type === "system"` rows before a native compaction — irrelevant for
  `type = 'assistant'` rows.
- `withRecentText` only enriches the compaction message's `recent` text — it does not affect tool
  states.
- The compaction boundary (`seq >= latestCompaction.seq`) **is** preserved: `staleTools` calls the same
  `latestCompaction(db, sessionID, "latest")` helper and applies `gte(seq, compaction.seq)`.

Conclusion: for the assistant rows the loop actually inspects, the result set and ordering (`asc(seq)`)
are identical to the old code.

### Why blob hydration can be skipped

- `blob.ts:82` (`rewriteMessage`) only rewrites tool parts in `completed`/`error` state —
  `streaming`/`running` parts are never touched by hydration.
- A row containing a mix (one running tool + one completed tool with `media:` refs) decodes fine
  without hydration: `Tool.FileContent.uri` is plain `Schema.String`, and `decodeMessageRow` already
  runs on non-hydrated rows in production (`history.ts:219`, `withRecentText`).
- The settlement loop only reads `tool.id`, `tool.name`, `tool.state.status`, `tool.state.metadata`,
  `tool.executed` — never blob bytes.

### Why the schema cache can't go stale

- `inputSchema` is `JsonSchema` = `interface { [x: string]: unknown }` (effect source,
  `JsonSchema.ts:31`) — an object, so it's a valid `WeakMap` key and `JSON.stringify` always returns a
  string.
- Grepped the whole repo: nothing assigns to a definition's `.inputSchema` in place (only local test
  variables and a function named `inputSchema` in codemode).
- Hooks only ever receive the **copy** (`d.input`), never the original definition object
  (`given` maps copies to definitions; `hooked` reconstructs from the copies).
- Existing test `session-model-request-hooks.test.ts:132` — *"keeps hook edits to a tool schema out of
  later requests"* — asserts the original stays `required: ["id"]` while each request's copy receives
  the hook's pushed value. That test is the guard for this change and it passes.

### SQL validated against real SQLite before wiring

A standalone script exercised the exact `EXISTS (json_each ...)` predicate: it matched rows with
`running` and `streaming` tools, excluded `completed` tools, user rows, and other sessions' rows.

## Results

### Typecheck

```
$ cd packages/core && bun run typecheck:tsc
$ tsc -b tsconfig.json tsconfig.tests.json
(clean — no errors)
```

Note: the package's `bun typecheck` script (`bun check --no-script ...`) errors with
`Script not found "check"` in this environment (Bun 1.4.2 treats `check` as a script name); per
`AGENTS.md`, `tsc` is the source of truth anyway.

### Tests

New test file `packages/core/test/session-history-stale-tools.test.ts`:

- Seeds assistant rows with `streaming`, `running`, `completed`, `error` tool states in one session
  plus a `running` tool in another session.
- Asserts only this session's live-tool messages return, in seq order, preserving running-tool
  metadata (needed for the child-session id in the failure message).
- Asserts a message drops out of the result once its tool finishes.

Results:

| Suite | Result |
|---|---|
| `session-history-stale-tools.test.ts` + `session-model-request-hooks.test.ts` | **6 pass, 0 fail** |
| `session-history-stale-tools.test.ts --rerun-each 10` (stability) | **20 pass, 0 fail** |
| `session-runner.test.ts` + `session-runner-tool-events.test.ts` + `session-runner-message.test.ts` | **289 pass, 0 fail** |
| Full `packages/core` suite (284 files) | **6855 pass, 43 skip, 7 fail** |

### The 7 full-suite failures are pre-existing, not caused by this change

All 7 are bash-parsing tests in `test/tool-shell.test.ts` (conditional process substitution, compound
`case` syntax approval). Verified by checking out the **base commit `ed74ec8` (dev)** in this worktree
and running the same file — identical failures:

```
(fail) ShellTool conditional process substitution > legacy: conditional substitutions respect once
(fail) ShellTool conditional process substitution > legacy: conditional substitutions respect always
(fail) ShellTool conditional process substitution > native: conditional substitutions respect once
(fail) ShellTool conditional process substitution > native: conditional substitutions respect always
(fail) ShellTool compound syntax approval compatibility > bash legacy equivalent: printf %s ...
(fail) ShellTool compound syntax approval compatibility > bash native: printf %s ...
84 pass / 6 fail   (same file, base commit ed74ec8)
```

(One extra intermittent failure — `real-shell compound syntax > bash` — appeared in one run only; same
family, same environmental cause: local bash/process-substitution behavior on macOS.)

They're environmental (local bash version), unrelated to session history, and reproduce on `dev`
without this change.

## Scope deliberately left out

- **Decode `concurrency: 1` → parallel**: schema decode is synchronous CPU work in a single-threaded
  runtime; raising Effect concurrency would not parallelize it. No-op win, skipped.
- **`estimatePrompt` transcript double-assembly** (the `TODO` at `compaction.ts:1088`): real win but
  touches compaction's token-accounting API across many call sites — candidate for a follow-up PR.
- **Incremental history decode cache** for the per-step `context.load`: kept per the stated preference
  to not reduce history request frequency — make needed reads cheaper (done here) rather than fewer.

## Commits

```
650a3c2 perf(core): settle stale tools and copy tool schemas cheaper
```
