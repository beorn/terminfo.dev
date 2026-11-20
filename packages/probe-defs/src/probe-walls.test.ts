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
test.each(["sgr.underline.color", "sgr.underline-color-rgb"])("%s declares a 45 s wall", (id) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)
  expect(definition, id).toBeDefined()
  expect(definition?.wallMs).toBe(45_000)
})

// 34694 second fold, hosted run 44200861479 on the 2026-11-17 image: the two alt screen rows were cut at 45 s while
// still capturing (33 to 43 captures). Span is max(frame.capturedAt) - attempt.startedAt; a cut row persists no
// frames in its result row, so the count comes from rawReplies captures, not from the row's frame list (dev/11).
// altscreen-47 worst 44.8 s x 1.20 = 53.7 -> 60. altscreen-1047 is a 50-capture path wherever it completes (22 only
// where the row exits early unsupported), so at cmux's 1.00-1.25 s per capture today it needs 60 to 75 s and 80 is the
// round wall that survives one more load band (@dev/luna6, /hh/var/@dev-luna6/altscreen-sizing-1117/sizing.md).
test.each([
  ["modes.altscreen-47", 60_000],
  ["modes.altscreen-1047", 80_000],
] as const)("%s declares a %d ms capture-bound wall", (id, wallMs) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)
  expect(definition, id).toBeDefined()
  expect(definition?.wallMs).toBe(wallMs)
})

// 35128: both132-capture reset rows need306.7s at the recorded1936ms cadence with20% headroom.
// Existing XT walls remain from their independent capture spans: xtsave74.1s (and a90s cut),
// xtpopsgr75.9s/66captures, xtpushsgr's earlier measured105s budget.
test.each([
  ["reset.sgr", 315_000],
  ["sgr.reset", 315_000],
  ["modes.xtsave", 120_000],
  ["modes.xtpopsgr", 105_000],
  ["modes.xtpushsgr", 105_000],
] as const)("%s declares a %d ms wall", (id, wallMs) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)
  expect(definition, id).toBeDefined()
  expect(definition?.wallMs).toBe(wallMs)
})

// 34567: the hosted macOS image moved 20261102.0473.1 to 20261112.0504.1 and raised measured per-capture cost from
// 0.912 s to 1.158 s on cmux (Cursor 0.851 to 1.067) with frame counts unchanged, so 13 Cursor rows and 11 cmux
// rows crossed the 30 s default while still capturing (/hh/var/@dev-brain/collector-slow-1117.md). Each wall below is
// that row's need x 1.20 headroom, rounded up to the next 15 s, where the need is the greater of its capture count
// x 1.158 s and its old elapsed time scaled by its app per-frame rise: 22 to 32 captures need 45 s, except
// sgr.underline.double at 60 s (old cmux 30.0 s scales to 38.0 s, above its 37.1 s of captures); 66 need 105 s;
// 132 needed195s at that older cadence;35128 now sizes selective-reset.bold at315s.
// Other rows the measurement did not cut keep their walls and the30s default stays.
test.each([
  ["sgr.bold", 45_000],
  ["sgr.faint", 45_000],
  ["sgr.italic", 45_000],
  ["sgr.inverse", 45_000],
  ["sgr.strikethrough", 60_000],
  ["sgr.overline", 60_000],
  ["sgr.hidden", 60_000],
  ["sgr.underline.single", 45_000],
  ["sgr.underline.double", 60_000],
  ["sgr.underline.curly", 60_000],
  ["sgr.underline.dashed", 60_000],
  ["sgr.underline.dotted", 60_000],
  ["sgr.underline-color-indexed", 60_000],
  ["modes.alt-screen.exit", 45_000],
  ["modes.xtpushcolors", 120_000],
  ["modes.xtpopcolors", 105_000],
  ["sgr.selective-reset.bold", 315_000],
  ["modes.left-right-margin", 45_000],
  ["modes.reverse-video", 45_000],
] as const)("%s declares a %d ms capture-bound wall", (id, wallMs) => {
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

// 35128: actual VSCode/Cursor61100ae0 and WezTerm79448f37 cuts retained 15–119 captures
// at up to1936ms per capture. Existing complete reset paths need132 captures; ordinary region
// paths22. Require the complete work at that observed cadence plus20%, not the truncated span.
test.each([
  ["reset.sgr", 132],
  ["sgr.reset", 132],
  ["sgr.selective-reset.bold", 132],
  ["sgr.selective-reset.underline", 22],
  ["sgr.selective-reset.italic", 22],
  ["sgr.selective-reset.inverse", 22],
  ["sgr.underline-color-reset", 22],
  ["modes.alt-screen.enter", 22],
] as const)("%s has room for %d captures at the observed slow-host cadence (35128)", (id, captures) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)
  expect(definition, id).toBeDefined()
  expect(definition?.wallMs ?? 30_000).toBeGreaterThanOrEqual(captures * 1_936 * 1.2)
})
