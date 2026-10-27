# PR 2: TUI idle CPU — `tab-idle-cpu`

> Branch: `tab-idle-cpu` · commit `51a2004` · targets `dev` · independent of PR 1.
> Draft PR body: `documentation/pr-draft-tab-idle-cpu.md` (ready for `gh pr create`).

## Why

Issue [#57462](https://github.com/anomalyco/opencode/issues/57462) (labeled `reproduced`): with the
tab strip visible, the TUI CLI burns 69–78% of a core while any session is busy — and an **idle
selected tab is penalized while another session works**. `tabs.mode: "off"` or `animations: false`
removes most of the penalty; the profile is dominated by `render`, `addToHitGrid`, `bufferDrawBox`,
`bufferDrawTextBufferView`, `bufferFillRect` — whole-frame compositing work, every frame.

### Root cause, verified against the renderer's own source

The `live` flag on a renderable is not cosmetic — it pins the renderer's frame loop. Traced through
the bundled `@opentui/core` 0.6.8 (`node_modules/.bun/@opentui+core@0.6.8…/chunk-bun-*.js`):

1. `Renderable.live = true` → `propagateLiveCount(+1)` walks to the root
   (`onLiveCountChanged(0 → 1)` → `ctx.requestLive()` → `liveRequestCounter++` → `internalStart()`).
2. `_isRunning = true` keeps `scheduleFrame(targetFrameTime)` looping at the end of every frame
   (loop body around chunk line 24346) — a permanent **~30fps full-screen re-composite plus
   terminal damage writes** (`targetFps: 30` in `mini/runtime.lifecycle.ts`).
3. `dropLive()` when the count returns to 0 → `_isRunning = false` → `clearFrameTimer()` — the loop
   stops and `renderer.idle()` (which mini and the CLI await) can resolve.

`TabPulse` (`packages/tui/src/component/tab-pulse.tsx`) synced its node's `live` flag to its pulse
state, and `PulseState.live` is true while `active` — i.e. **for the entire run of a busy session**.
Each tab renders up to **4 `TabPulse` instances** (above-edge, below-edge, main row, detail row;
`session-tabs.tsx:973, 1000, 1027, 1112`, plus `:1682` for the rail), so one busy session anywhere
in the strip pins the whole renderer at 30fps even when the visible tab is idle. That is exactly the
issue's symptom profile.

The codebase already documents the correct pattern. `SpinnerRenderable`
(`spinner-renderable.ts:34-35`): *"Not live: a live node keeps the renderer running, so
renderer.idle(), which mini and the CLI await, never resolves. A timer requests each frame
instead."*

## What changed

`packages/tui/src/component/tab-pulse.tsx` (+44/−9) and its test file (+99/−5). **No API change** —
props, `onLevel`, and all rendering math are untouched.

1. **The node never goes live.** Removed the `live:` constructor option and the three
   `this.live = this.inner.live || this.outer.live` sync points (`enabled` setter, `changed()`,
   `edge` setter).
2. **A timer requests each animating frame** (`onUpdate`), mirroring `SpinnerRenderable`:
   - `onUpdate` advances the time-based envelopes (unchanged math), then, while either `PulseState`
     is live, arms a single `clock.setTimeout(…, 80)` that calls `requestRender()`. `PULSE_INTERVAL
     = 80` matches the tab spinner cadence (`TAB_SPINNERS` 80/120ms, `spinner.tsx` `interval={80}`),
     so the strip's animations stay in rhythm; the sweep advances ~1 cell per tick (cycle 2800ms).
   - When both states settle, `stop()` clears the pending timer — the chain ends in the same frame
     that paints the settled state, so there is no extra frame.
   - `destroySelf()` clears the timer on unmount.
3. **Tests rewritten to the new contract** (`tab-pulse.test.tsx`), using `ManualClock` per the
   tui-tests skill:
   - the glow test now asserts `liveCount === 0` throughout the 600ms ignition, that exactly one
     timer is pending per 80ms tick (proving `onUpdate` keeps re-arming), and that the chain stops
     when the glow rests;
   - a new busy-session test: `active` holds the chain alive tick after tick (the sweep keeps
     animating) without ever incrementing `liveCount`, and finishing (release 500ms + edge flash
     800ms) stops it;
   - a new unmount test: destroying a running pulse releases its pending timer.

## Correctness reasoning

- **Envelope advancement is frame-driven, not loop-driven.** `PulseState.advance(deltaTime)` is
  time-based, so sparse timer frames produce identical animation progress to the old 30fps loop.
  The renderer passes real inter-frame deltas, and between timer ticks the gaps *are* the elapsed
  time, so nothing drifts.
- **Every state change still renders.** All setters already called `requestRender()`; that first
  frame runs `onUpdate`, which arms the timer — so the chain always starts from a state change and
  self-sustains until settle. The completion-pending handoff inside `advance` (release → completion
  pulse) keeps `PulseState.live` true across the transition, so the chain does not stop between the
  two stages.
- **Hidden/culled nodes behave like the spinner.** Core skips `onUpdate` for hidden and culled
  nodes, so a pending timer fires at most one last `requestRender` and the chain ends — the same
  documented semantics as `SpinnerRenderable`. Re-showing re-arms from the visible frame.
- **`onLevel` consumers are safe.** The level signal was already quantized to 1/32; it now updates
  at the 80ms cadence instead of 30fps and only tints the tab number color
  (`session-tabs.tsx:790-792, 1640`).
- **`renderer.idle()` now resolves between frames**, which improves the CLI/mini shutdown and
  splash flows the spinner comment describes.
- Constructor now narrows `ctx instanceof CliRenderer` for the clock, exactly like
  `SpinnerRenderable` (which throws the same way).

### Other `live` users checked and deliberately left alone

| Component | Why not in this PR |
|---|---|
| `SpinnerRenderable` | Already timer-driven (the reference pattern). |
| `retry-provider.tsx` | `requestLive()` only for a ~200ms provider-name transition, `dropLive()` on settle — transient by design. |
| `shimmer-text.tsx` (`live = true` permanently) | Only reachable via `<Spinner shimmer>` → `dialog-update.tsx` — transient dialogs, never the steady state. |
| `title-shimmer.tsx` | Live only while a rename is pending / arriving / blending — transient. |
| `fade-in-text.tsx` | Drops `live` itself after its 200ms fade (`renderSelf` clears it at `DURATION`). |
| `go-upsell-art.ts` | Upsell art, only while that dialog is open. |

`TabPulse` was the only **steady-state** renderer pin during normal operation, matching the issue's
`tabs.mode: "off"` mitigation and its all-tabs-checked gap (the busy tab is what pins, not the
visible one).

## Results

### Typecheck

```
$ cd packages/tui && bun run typecheck:tsc
$ tsc -b
(clean)
```

### Tests

| Suite | Result |
|---|---|
| `test/component/tab-pulse.test.tsx` | **10 pass, 0 fail** (192 expect calls) |
| same, `--rerun-each 10` | **100 pass, 0 fail** |
| `session-tabs-{marquee,mouse,rail,status}` (mount `TabPulse`) | **11 pass, 0 fail** |
| Full `packages/tui` suite (186 files) | **1548 pass, 2 skip, 1 fail** |

### The single full-suite failure is pre-existing, not from this change

`(fail) the art stops every frame when hidden, closed, or still, and leaves nothing live after
repeated opens` — `test/component/go-upsell-art.test.tsx`. It fails **standalone on the base commit
`ed74ec8` (dev)** with the same 0 pass / 1 fail, and the full suite on base shows the identical
single failure (base: 1546 pass / 2 skip / 1 fail vs this branch: 1548 pass / 2 skip / 1 fail —
+2 from the new tests). Unrelated component, same on `dev` without this change.

(An earlier full-suite run also surfaced a `ClientError: Transport: unexpected request:
/api/session/session-active` — an order-dependent cross-file leftover in the shared fixture;
`data.test.tsx` passes standalone on both base and this branch, and the go-upsell-art failure above
is the one consistent failure in both full runs.)

## Expected impact

- While any session is busy: frames drop from a **continuous 30fps full-screen loop** to timer
  ticks at 12.5fps (plus whatever event-driven renders streaming already triggers) — and the
  renderer **fully idles between ticks**, letting the OS schedule the CPU elsewhere. This is the
  difference between a permanent render loop and occasional 1-frame work bursts on a fanless machine.
- When all sessions are idle: the pulse chain is not running at all, and `renderer.idle()` resolves
  (previously a lingering busy-tab `live` could keep the loop alive indefinitely).
- Animation appearance: the running sweep, glow ignition, flash and completion envelopes now step at
  the 80ms cadence (matching the tab spinner) instead of 30fps. All math is unchanged; only the
  sampling rate differs.

## Commits

```
51a2004 perf(tui): stop the tab pulse from pinning the renderer
```
