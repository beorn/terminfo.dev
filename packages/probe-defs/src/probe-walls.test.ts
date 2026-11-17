/**
 * @failure A probe measured as slow (still capturing within ~1 s of the wall, nothing unanswered) is cut by the
 *   runner's 30 s default and reads "Probe exceeded 30000ms" instead of a grade (34554).
 * @level l1
 * @consumer The app runner's per-probe wall (unified.ts), which uses wallMs when a definition declares it.
 * @reach Reads the declared wall of each named definition in ALL_PROBES.
 * @testonly none
 */
import { expect, test } from "vitest"
import { ALL_PROBES } from "./index.ts"

// 34554: measured under fleet load at 32-33 s on their last case (wezterm/linux altscreen, xterm/linux underline
// colour); 45 s holds that cadence with room. /hh/var/@dev11/34544/MEASUREMENT.md.
test.each(["modes.altscreen-47", "modes.altscreen-1047", "sgr.underline.color", "sgr.underline-color-rgb"])(
  "%s declares a 45 s wall",
  (id) => {
    const definition = ALL_PROBES.find((entry) => entry.id === id)
    expect(definition, id).toBeDefined()
    expect(definition?.wallMs).toBe(45_000)
  },
)

// 34641: on Linux WezTerm these ran at 79-99 percent of their walls (capture spans from frame.capturedAt, runs
// 2026-11-17T12-44Z and 13-06Z; worst median capture gap 921 ms), so they flipped between graded and cut run to run.
// Each wall is sized from that measured span with at least 20 percent headroom: 132 captures need 150 s, 66 need 90 s.
test.each([
  ["reset.sgr", 150_000],
  ["sgr.reset", 150_000],
  ["sgr.selective-reset.bold", 150_000],
  ["modes.xtsave", 90_000],
  ["modes.xtpushsgr", 90_000],
  ["modes.xtpopsgr", 90_000],
] as const)("%s declares a %d ms wall", (id, wallMs) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)
  expect(definition, id).toBeDefined()
  expect(definition?.wallMs).toBe(wallMs)
})

// 34645: the held-viewport arm of these rows takes about 18 raw frames (two empty-history brackets, two endpoint
// brackets, their observed references) plus 10 key posts, at up to ~1 s a frame; 90 s holds that with headroom
// until the hosted macOS run measures it.
test.each(["scrollback.total-lines", "erase.screen.scrollback"])("%s declares a 90 s wall", (id) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)
  expect(definition, id).toBeDefined()
  expect(definition?.wallMs).toBe(90_000)
})
