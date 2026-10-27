<!-- Suggested title: perf(tui): stop the tab pulse from pinning the renderer -->
<!--
gh pr create \
  --repo anomalyco/opencode \
  --base dev \
  --head Rani-Wehbe:tab-idle-cpu \
  --draft \
  --title "perf(tui): stop the tab pulse from pinning the renderer" \
  --body-file documentation/pr-draft-tab-idle-cpu.md
-->

Fixes #57462.

## Summary

`TabPulse` no longer sets `live`. While animating it requests each frame from a timer at the tab-spinner cadence (80ms), exactly like `SpinnerRenderable`, so the renderer idles between frames and stops entirely once the envelopes settle. No API change — props, `onLevel`, and all animation math are untouched.

## Why

A `live` renderable is not cosmetic: the live count reaches the root, calls `requestLive()`, and sets the renderer's `_isRunning`, which re-arms `scheduleFrame(targetFrameTime)` at the end of every frame — a **permanent ~30fps full-screen re-composite plus terminal damage writes**, and `renderer.idle()` (which mini and the CLI await) never resolves. Dropping the last live node stops the loop.

`TabPulse` synced its node's `live` flag to its pulse state, and `PulseState.live` includes `active` — i.e. for the entire run of a busy session. Each tab mounts up to **4 `TabPulse` instances** (above/below edge, main row, detail row; plus the rail), so one busy session anywhere in the strip pinned the whole renderer even when the visible tab was idle. That is exactly #57462's symptom: 69–78% of a core in whole-frame compositing (`render`/`addToHitGrid`/`bufferDrawBox`), removed by `tabs.mode: "off"` — and an idle selected tab penalized while another session works.

The codebase already documents the correct pattern in `SpinnerRenderable`: *"Not live: a live node keeps the renderer running, so renderer.idle(), which mini and the CLI await, never resolves. A timer requests each frame instead."*

## Changes

- `packages/tui/src/component/tab-pulse.tsx`
  - Removed the `live:` constructor option and the three `this.live = this.inner.live || this.outer.live` sync points.
  - `onUpdate` advances the same time-based envelopes and, while either `PulseState` is live, arms a single `clock.setTimeout(…, 80)` whose callback calls `requestRender()`. When both states settle, `stop()` clears the timer in the same frame that paints the settled state — no extra frame.
  - `destroySelf()` clears the timer on unmount; the constructor narrows `ctx instanceof CliRenderer` for the clock, like the spinner.
- `packages/tui/test/component/tab-pulse.test.tsx` — rewritten to the new contract with `ManualClock`: `liveCount === 0` throughout a glow ignition, exactly one pending timer per 80ms tick while a sweep is busy, the chain stops when the session finishes (release + edge flash) and when the node unmounts.

## Behavior

- Envelope advancement is frame-driven and time-based, so sparse timer frames produce **identical animation progress** — sampled at 12.5fps instead of 30fps, matching the tab spinner's own cadence.
- All state changes still render: every setter already calls `requestRender()`, whose frame runs `onUpdate` and arms the timer, so the chain always starts from a state change and self-sustains until settle (including the release → completion-pulse handoff, which keeps `PulseState.live` true across the transition).
- Hidden and culled tabs stop the chain exactly like the spinner (core skips `onUpdate` for them); re-showing re-arms from the visible frame.
- `onLevel` consumers are unaffected (already quantized to 1/32; only tints the tab number color).
- `renderer.idle()` now resolves between frames, improving the CLI/mini flows that await it.
- Other `live` users were audited and deliberately left alone — `retry-provider` (~200ms transient), `shimmer-text` (only the update dialog), `title-shimmer` (renames only), `fade-in-text` (drops `live` after 200ms), `go-upsell-art` (dialog only). `TabPulse` was the only steady-state renderer pin during normal operation.

## Testing

| Suite | Result |
|---|---|
| `test/component/tab-pulse.test.tsx` | 10 pass, 0 fail |
| same, `--rerun-each 10` | 100 pass, 0 fail |
| `session-tabs-{marquee,mouse,rail,status}` | 11 pass, 0 fail |
| full `packages/tui` (186 files) | 1548 pass, 2 skip, 1 fail |

The single full-suite failure (`go-upsell-art.test.tsx`, "the art stops every frame…") reproduces **standalone on the base commit** (`ed74ec8`, dev) with identical 0 pass / 1 fail — pre-existing and unrelated; the full suite on base shows the same single failure.

`bun run typecheck:tsc` clean.

### Visual

The busy tab's pulse now steps in 80ms ticks (same rhythm as the spinner dots) instead of driving a permanent 30fps loop; the renderer idles between ticks and fully sleeps when all tabs are quiet.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="72" viewBox="0 0 240 72" fill="currentColor">
  <style>
    .sweep { animation: sweep 2.8s steps(35, end) infinite; }
    .tick { animation: tick .16s steps(1, end) infinite; }
    @keyframes sweep { from { transform: translateX(-18px); } to { transform: translateX(150px); } }
    @keyframes tick { 0%, 49% { opacity: .9; } 50%, 100% { opacity: .2; } }
    @media (prefers-reduced-motion: reduce) { .sweep, .tick { animation: none; } }
  </style>
  <g font-family="monospace" font-size="8" opacity=".45">
    <text x="8" y="12">1 session busy</text>
    <text x="232" y="12" text-anchor="end">renderer idles between ticks</text>
  </g>
  <rect x="8" y="18" width="64" height="14" rx="3" fill="none" stroke="currentColor" opacity=".3"/>
  <rect x="76" y="18" width="88" height="14" rx="3" fill="none" stroke="currentColor" opacity=".9"/>
  <rect x="168" y="18" width="64" height="14" rx="3" fill="none" stroke="currentColor" opacity=".3"/>
  <rect x="82" y="23.5" width="3" height="3" rx="1.5" fill="currentColor" opacity=".9"/>
  <rect x="8" y="40" width="224" height="2" rx="1" fill="currentColor" opacity=".12"/>
  <g class="sweep"><rect x="84" y="40" width="16" height="2" rx="1" fill="currentColor" opacity=".9"/></g>
  <g font-family="monospace" font-size="8">
    <text x="8" y="60" opacity=".45">idle tab</text>
    <g class="tick"><text x="120" y="60" text-anchor="middle">busy tab: pulse ticks at 80ms</text></g>
    <text x="232" y="60" text-anchor="end" opacity=".45">idle tab</text>
  </g>
</svg>
```
