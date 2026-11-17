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
