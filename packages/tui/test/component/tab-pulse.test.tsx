import { expect, test } from "bun:test"
/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import {
  TabPulse,
  blendTabPulseColor,
  completionPulseOpacity,
  glowIgnitionLevel,
  tabFlashIntensity,
  unreadGlowIntensity,
} from "../../src/component/tab-pulse"
import { tint } from "../../src/theme/color"

test("a disabled pulse stays idle when it becomes active", async () => {
  const background = RGBA.fromHex("#101010")
  const [active, setActive] = createSignal(false)
  const app = await testRender(
    () => <TabPulse enabled={false} active={active()} color={background} backgroundColor={background} />,
    { width: 8, height: 1 },
  )

  try {
    await app.renderOnce()
    expect(app.renderer.root.liveCount).toBe(0)

    setActive(true)
    await app.renderOnce()
    expect(app.renderer.root.liveCount).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("an attention glow never pins the renderer and settles on its own timer", async () => {
  const clock = new ManualClock()
  const background = RGBA.fromHex("#101010")
  const app = await testRender(
    () => <TabPulse active={false} glow color={RGBA.fromHex("#ffcc00")} backgroundColor={background} />,
    { width: 8, height: 1, clock },
  )

  try {
    await app.renderOnce()
    expect(app.renderer.root.liveCount).toBe(0)
    // The ignition runs for 600ms; each armed timer tick renders one step, then the chain stops.
    for (let elapsed = 0; elapsed < 600; elapsed += 80) {
      expect(clock.pendingTimerCount).toBe(1)
      clock.advance(80)
      await app.renderOnce()
    }
    expect(app.renderer.root.liveCount).toBe(0)
    expect(clock.pendingTimerCount).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("a running sweep requests frames while busy and stops once the session finishes", async () => {
  const clock = new ManualClock()
  const background = RGBA.fromHex("#101010")
  const [active, setActive] = createSignal(true)
  const app = await testRender(
    () => <TabPulse active={active()} color={background} backgroundColor={background} />,
    { width: 8, height: 1, clock },
  )

  try {
    await app.renderOnce()
    expect(app.renderer.root.liveCount).toBe(0)
    // The sweep holds sustain while the session runs, so every tick re-arms the next frame.
    for (let elapsed = 0; elapsed < 560; elapsed += 80) {
      expect(clock.pendingTimerCount).toBe(1)
      clock.advance(80)
      await app.renderOnce()
    }
    // Finishing releases the sweep and flashes the edge; the chain stops when both settle.
    setActive(false)
    await app.renderOnce()
    expect(clock.pendingTimerCount).toBe(1)
    for (let elapsed = 0; elapsed < 800; elapsed += 80) {
      clock.advance(80)
      await app.renderOnce()
    }
    expect(clock.pendingTimerCount).toBe(0)
    expect(app.renderer.root.liveCount).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("unmounting a running pulse releases its pending frame", async () => {
  const clock = new ManualClock()
  const background = RGBA.fromHex("#101010")
  const [shown, setShown] = createSignal(true)
  const app = await testRender(
    () => (
      <Show when={shown()}>
        <TabPulse active color={background} backgroundColor={background} />
      </Show>
    ),
    { width: 8, height: 1, clock },
  )

  try {
    await app.renderOnce()
    expect(clock.pendingTimerCount).toBe(1)
    setShown(false)
    await app.renderOnce()
    expect(clock.pendingTimerCount).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("completion pulse rises quickly and fades over the remaining duration", () => {
  expect(completionPulseOpacity(0)).toBe(0)
  expect(completionPulseOpacity(0.06)).toBeCloseTo(0.5)
  expect(completionPulseOpacity(0.12)).toBe(1)
  expect(completionPulseOpacity(0.56)).toBeCloseTo(0.5)
  expect(completionPulseOpacity(1)).toBe(0)
})

test("glow ignition overshoots the resting level and settles back to it", () => {
  expect(glowIgnitionLevel(0)).toBe(0)
  expect(glowIgnitionLevel(0.3)).toBeCloseTo(1.5)
  expect(glowIgnitionLevel(0.6)).toBeGreaterThan(1)
  expect(glowIgnitionLevel(1)).toBe(1)
})

test("unread glow peaks behind the tab number and fades to the normal background", () => {
  const intensities = Array.from({ length: 22 }, (_, index) => unreadGlowIntensity(index, 22))

  expect(intensities[0]).toBe(1)
  expect(intensities[1]).toBe(1)
  expect(intensities[2]).toBeLessThan(1)
  expect(intensities.slice(1)).toEqual(intensities.slice(1).sort((a, b) => b - a))
  expect(intensities[13]).toBe(0)
  expect(intensities.at(-1)).toBe(0)
})

test("unread glow reaches the normal background on compact tabs", () => {
  expect(unreadGlowIntensity(0, 8)).toBe(1)
  expect(unreadGlowIntensity(7, 8)).toBe(0)
})

test("tab flash holds behind the shortcut then feathers to the background", () => {
  const intensities = Array.from({ length: 10 }, (_, index) => tabFlashIntensity(index, 8))

  expect(intensities[0]).toBe(1)
  expect(intensities[1]).toBe(1)
  expect(intensities[2]).toBeLessThan(1)
  expect(intensities.slice(1)).toEqual(intensities.slice(1).sort((a, b) => b - a))
  expect(intensities.at(-1)).toBe(0)
})

test("reuses a color while preserving the original glow and pulse blend stages", () => {
  const output = RGBA.fromInts(0, 0, 0)
  const background = RGBA.fromHex("#1a1b26")
  const glowColor = RGBA.fromHex("#82aaff")
  const runningColor = RGBA.fromHex("#c8d3f5")
  const flashColor = RGBA.fromHex("#e2e8fb")
  const completionColor = RGBA.fromHex("#ff9e64")

  for (const glow of [0, 0.08, 0.16]) {
    for (const running of [0, 0.01, 0.07, 0.14]) {
      for (const flash of [0, 0.05, 0.1]) {
        for (const completion of [0, 0.03, 0.09, 0.18]) {
          blendTabPulseColor(
            output,
            background,
            glowColor,
            runningColor,
            flashColor,
            completionColor,
            glow,
            running,
            flash,
            completion,
          )
          expect(output.buffer).toEqual(
            tint(
              tint(tint(tint(background, glowColor, glow), runningColor, running), flashColor, flash),
              completionColor,
              completion,
            ).buffer,
          )
        }
      }
    }
  }
})
