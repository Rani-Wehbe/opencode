<!-- Suggested title: perf(core): settle stale tools and copy tool schemas cheaper -->
<!--
gh pr create \
  --repo anomalyco/opencode \
  --base dev \
  --head Rani-Wehbe:core-step-efficiency \
  --draft \
  --title "perf(core): settle stale tools and copy tool schemas cheaper" \
  --body-file documentation/pr-draft-core-step-efficiency.md
-->

## Summary

- Replace the full-transcript load in stale-tool settlement with one indexed query that returns only assistant rows containing a `streaming`/`running` tool part — usually zero rows.
- Cache tool-schema JSON per schema object so every LLM request stops re-stringifying the same shared tool definitions.

## Why

Every drain — prompt, steer, and resume alike — starts in `SessionRunner.settleStaleToolCalls`, which called `store.context(sessionID)`: that selects **every message row since the last compaction**, blob-hydrates it, and schema-decodes each row, solely to look for tool parts stuck mid-execution. On the overwhelming majority of drains there is none, so the entire load was pure waste, and its cost grows linearly with transcript length — the mechanism behind the "slow resume after ~50 rounds" reports (#50063).

Separately, `SessionModelRequest.prepare` deep-copied each tool's `inputSchema` with `JSON.parse(JSON.stringify(...))` for every request (primary, compaction, title, retry). Tool definitions are shared across steps and sessions and never change, so the same stringify walk repeated on every single LLM call.

History **request frequency is unchanged** — this only removes a read that was never needed and makes the per-request copy cheaper.

## Changes

- `packages/core/src/session/history.ts` — new `SessionHistory.staleTools`: `seq >= latest compaction` plus `EXISTS (SELECT 1 FROM json_each(...))` matching tool parts in `streaming`/`running`, over the existing `(session_id, type, seq)` index; matching rows are decoded **without blob hydration**, matching the `settleStaleCompactions` idiom directly above it.
- `packages/core/src/session/runner/llm.ts` — `settleStaleToolCalls` iterates `SessionHistory.staleTools` instead of `store.context(sessionID)`; the settlement loop is otherwise untouched.
- `packages/core/src/session/model-request.ts` — module-level `WeakMap<object, string>` schema cache; the first request stringifies, every request `JSON.parse`s a **fresh** copy so hooks that edit their copy stay isolated.
- `packages/core/test/session-history-stale-tools.test.ts` — new: seeded `streaming`/`running`/`completed`/`error` tool states across two sessions; asserts only this session's live-tool rows return in seq order with metadata intact, and that a row drops out once its tool finishes.

## Correctness

- **Result-set equivalence.** The old load used `boundary: "latest"`, which never drops rows by replayability; the only other row filter (system rows before a native compaction) cannot touch assistant rows. The compaction boundary (`seq >= latestCompaction.seq`) and `asc(seq)` ordering are preserved by calling the same `latestCompaction` helper. For the assistant rows the loop actually inspects, the result set is identical.
- **Blob hydration is safe to skip.** `rewriteMessage` only rewrites tool parts in `completed`/`error` state — `streaming`/`running` parts are never touched by hydration — and the settlement loop only reads `tool.id`, `tool.name`, `tool.state.status`, `tool.state.metadata`, `tool.executed`. Mixed rows (one running tool + one completed tool with `media:` refs) still decode without hydration; `decodeMessageRow` already runs on non-hydrated rows in production.
- **The schema cache can't go stale.** Nothing in the repo assigns to a definition's `inputSchema` in place; hooks only ever receive the copy, never the original definition object; and the existing guard test *"keeps hook edits to a tool schema out of later requests"* (`session-model-request-hooks.test.ts`) passes unchanged.
- The `EXISTS (json_each ...)` predicate was validated against real SQLite before wiring (matches `running`/`streaming`, excludes `completed` tools, user rows, and other sessions' rows).

## Testing

| Suite | Result |
|---|---|
| `session-history-stale-tools.test.ts` + `session-model-request-hooks.test.ts` | 6 pass, 0 fail |
| new test, `--rerun-each 10` | 20 pass, 0 fail |
| runner suites (`session-runner*.test.ts`) | 289 pass, 0 fail |
| full `packages/core` (284 files) | 6855 pass, 43 skip, 7 fail |

The 7 full-suite failures are all bash-parsing tests in `tool-shell.test.ts`; they reproduce identically on the base commit (`ed74ec8`, dev) and are environmental, unrelated to session history.

`bun run typecheck:tsc` clean.

### Visual

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="72" viewBox="0 0 240 72" fill="currentColor">
  <style>
    .scan-all { animation: scanAll 1.6s linear infinite; }
    .probe { animation: probe 1.6s ease-in-out infinite; }
    @keyframes scanAll { from { transform: translateY(0); } to { transform: translateY(56px); } }
    @keyframes probe { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
    @media (prefers-reduced-motion: reduce) { .scan-all, .probe { animation: none; } }
  </style>
  <g font-family="monospace" font-size="8" opacity=".45">
    <text x="8" y="12">before: hydrate whole transcript</text>
    <text x="232" y="12" text-anchor="end">after: one indexed probe</text>
  </g>
  <g opacity=".3">
    <rect x="10" y="18" width="84" height="5" rx="1"/>
    <rect x="10" y="27" width="70" height="5" rx="1"/>
    <rect x="10" y="36" width="80" height="5" rx="1"/>
    <rect x="10" y="45" width="64" height="5" rx="1"/>
    <rect x="10" y="54" width="76" height="5" rx="1"/>
  </g>
  <g class="scan-all"><rect x="8" y="17" width="88" height="1.5" fill="currentColor" opacity=".8"/></g>
  <rect x="146" y="34" width="58" height="6" rx="1" fill="currentColor" opacity=".25"/>
  <g class="probe"><rect x="138" y="33.5" width="4" height="7" rx="1" fill="currentColor"/></g>
  <text x="210" y="40" font-family="monospace" font-size="8" opacity=".8">row</text>
</svg>
```
