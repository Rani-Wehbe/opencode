# Opencode efficiency research — findings and plan

> Context for the `core-step-efficiency` and `tab-idle-cpu` branches. Research only; no code in this
> document's section was written for findings that were deferred.

## Goal

Make opencode lighter on a fanless machine: lower RAM, lower idle CPU, faster session step paths.
The user runs several sessions across multiple UIs and reported warmth and CPU spikes at rest.

## Constraints from the user

- **Do not reduce how often history is requested** — requesting history more often is fine; just remove
  reads that were never needed and make the needed ones cheaper.
- Keep concurrent sessions isolated/efficient.
- Focus on the CLI/TUI and the local service (used both locally and against a remote server).
- Ship as one or two PRs. Reports/docs stay out of the source tree (this `documentation/` directory on
  the `reports` branch).

## Ranked findings (from codebase hot-path analysis + user-reported issues)

### Tier 1 — per-step LLM loop

| # | Finding | Where | Disposition |
|---|---|---|---|
| 1 | Full transcript reload + sequential decode every step | `session/history.ts` | Partially addressed (stale-tool read removed); per-step decode cache deferred |
| 2 | `settleStaleToolCalls` full load per drain | `runner/llm.ts:385-408` | **Fixed in PR 1** |
| 3 | Transcript assembled twice per step (estimate + request) | `compaction.ts:1084` (TODO at :1088), `model-request.ts` | Deferred (API refactor) |
| 4 | `JSON.parse(JSON.stringify(inputSchema))` per tool per request | `model-request.ts:243-248` | **Fixed in PR 1** |
| 5 | `Selection` rebuilt per step; read-only snapshots re-captured | `context.ts`, `runner/step.ts` | Deferred |

### Tier 2 — write amplification

- Assistant-row full rewrite per projected event (`projector.ts:260-276, 741-784`).
- Duplicate context load at idle completion (`compaction.precompute` reload).
- Per-aggregate lock + `events.persist` in `bus.ts:343-373` (feature-flag dependent).

### Tier 3 — startup, UI, idle

- Eager 5.9MB `models-dev/snapshot.txt` import (`models-dev.ts:16`) — one-time ~6MB resident string;
  lazy-loading candidate, not a meaningful share of ~600MB total, low priority.
- `session-ui` timeline has no virtualization (`session-timeline.tsx:52-63`).
- Plugin path watch polls at 500ms when a plugin directory is **missing** (`plugin/watch.ts:100`) —
  no-op when nothing is missing; not an idle-CPU cause.
- **TUI tab-strip animation keeps the renderer alive** — see below. **PR 2 target.**

## The idle-CPU mechanism (issue #57462) — basis of PR 2

Issue [#57462](https://github.com/anomalyco/opencode/issues/57462) (labeled `reproduced`, assigned):

- Intel HD 520 laptop: TUI CLI at **69–78% of one core** with animations on while a session works;
  terminal/compositor burn too (Ghostty 72–79% CPU). `animations: false` or `tabs.mode: "off"`
  removes most of the penalty. Profile dominated by `render`, `addToHitGrid`, `bufferDrawBox`,
  `bufferDrawTextBufferView`, `bufferFillRect`.
- An **idle selected tab is penalized while another session is working** with the strip visible.

Code path traced so far (packages/tui):

1. `TabPulse` (`component/tab-pulse.tsx`) sets `live` while `active`/animating
   (`PulseState.live`, :283-292; `changed()` :541-544; constructor option :454). `onUpdate` (:632-637)
   advances envelopes **per rendered frame**.
2. A `live` node keeps the renderer loop running — documented by `SpinnerRenderable`
   (`spinner-renderable.ts:34-35`): *"Not live: a live node keeps the renderer running, so
   renderer.idle(), which mini and the CLI await, never resolves."* The spinner instead drives frames
   with its own timer (`onUpdate` schedules `clock.setTimeout` → `requestRender`, :113-126), stopping
   when hidden/culled.
3. Renderer runs at `targetFps: 30, maxFps: 60` (`mini/runtime.lifecycle.ts:163-164`).
4. Consequence: while any session is busy, its tab's `TabPulse` is `live` → the renderer never idles →
   ~30fps full-screen re-composite + terminal damage writes, even when the visible tab is idle and
   nearly nothing changed. That matches the issue's profile functions (hit-grid/buffer work over the
   whole frame) and its `tabs.mode: "off"` mitigation.

Other animated elements checked and why they're not the primary cause:

- `SpinnerRenderable`: timer-driven, not live; self-limits to its interval (80–120ms) and stops when
  culled. Design comment explicitly avoids keeping the renderer alive.
- `GatedEnvelope.animating` is `false` during `sustain`/`idle` phases (`tab-pulse.tsx:210-226`), so a
  steady glow does not churn the envelope — the cost is the frame loop being kept alive + the running
  sweep animation.
- Background-shell output poll (`routes/session/index.tsx:3076`, 1s) runs only while a background shell
  runs; retry countdown (`:2548`, 1s) self-clears. Idle-safe.
- Marquee (`session-tabs.tsx:292`) runs only while a long title overflows and is active.

### Open design question for PR 2

How to let `TabPulse` animate without pinning the renderer:

- Option A: mirror `SpinnerRenderable` — drive pulse frames from a timer at the animation's own cadence
  instead of `live`, letting `renderer.idle()` resolve between frames. Consistent with the codebase's
  own documented pattern; trade-off: sweep smoothness capped at timer rate.
- Option B: throttle only the non-selected/busy-background tabs (visible-but-not-current), keeping the
  selected tab's animation smooth. More surgical, slightly more state.

To investigate next: how `onUpdate` is gated for non-live nodes (does core skip `onUpdate` on non-live
renderables? the spinner comment implies it runs on frames it requests itself), and whether
`requestRender` from a timer is sufficient for envelope advancement without `live`.

**Resolved:** `onUpdate` runs on every rendered frame for visible, non-culled nodes regardless of
`live`; a `clock.setTimeout` → `requestRender` chain (the spinner's pattern) is sufficient to drive
the envelopes without pinning the frame loop. Option A was implemented — see `tab-idle-cpu.md` in
this directory.
