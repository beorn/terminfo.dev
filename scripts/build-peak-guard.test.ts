/**
 * @failure The site build grows past its declared resident-memory ceiling and keeps building, so a swap-floor host pays for it silently (28662 AC3).
 * @level l2
 * @consumer The terminfo-site resident's `bun run build`, and the 28662 per-stage peak measurement.
 * @testonly none
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_PEAK_CEILING_BYTES,
  PEAK_CEILING_ENV,
  invalidateBuildStamp,
  peakBreachMessage,
  peakCeilingBytes,
  phasePeaksMessage,
  installRenderPhaseHook,
  startPeakGuard,
} from "./build-peak-guard.ts"

afterEach(() => {
  vi.useRealTimers()
})

describe("peakCeilingBytes", () => {
  it("defaults to the declared 16 GiB ceiling", () => {
    expect(DEFAULT_PEAK_CEILING_BYTES).toBe(16 * 1024 ** 3)
    expect(peakCeilingBytes({})).toBe(DEFAULT_PEAK_CEILING_BYTES)
  })

  it("takes a positive integer byte count from the environment", () => {
    expect(peakCeilingBytes({ [PEAK_CEILING_ENV]: "1024" })).toBe(1024)
  })

  it("treats an unset or blank value as the default, and refuses a malformed one loudly", () => {
    for (const blank of ["", "   "]) {
      expect(peakCeilingBytes({ [PEAK_CEILING_ENV]: blank })).toBe(DEFAULT_PEAK_CEILING_BYTES)
    }
    for (const bad of ["0", "-1", "1.5", "1GiB", "abc"]) {
      expect(() => peakCeilingBytes({ [PEAK_CEILING_ENV]: bad })).toThrow(/positive integer/)
    }
  })
})

describe("startPeakGuard", () => {
  it("reports the peak it measured and never breaches under the ceiling", async () => {
    vi.useFakeTimers()
    const samples = [100, 200, 150]
    const onBreach = vi.fn()
    const guard = startPeakGuard({ ceilingBytes: 1000, rss: () => samples.shift() ?? 150, onBreach })
    await vi.advanceTimersByTimeAsync(1000)
    guard.stop()
    expect(onBreach).not.toHaveBeenCalled()
    expect(guard.peakBytes()).toBe(200)
  })

  it("breaches once, naming the measured bytes, the peak and the phase the build was in", async () => {
    vi.useFakeTimers()
    const onBreach = vi.fn()
    let rss = 900
    const guard = startPeakGuard({ ceilingBytes: 1000, rss: () => rss, onBreach })
    expect(guard.peakBytes()).toBe(900)
    guard.phase("rendering pages")
    rss = 5000
    await vi.advanceTimersByTimeAsync(2000)
    expect(onBreach).toHaveBeenCalledTimes(1)
    expect(onBreach.mock.calls[0]?.[0]).toMatchObject({ bytes: 5000, peakBytes: 5000, phase: "rendering pages" })
    // A breach stops the guard: a later, larger sample neither reports again nor moves the peak.
    rss = 9000
    await vi.advanceTimersByTimeAsync(2000)
    expect(onBreach).toHaveBeenCalledTimes(1)
    expect(guard.peakBytes()).toBe(5000)
    guard.stop()
  })

  it("reports every phase's own high-water, not only the largest", async () => {
    vi.useFakeTimers()
    let rss = 100
    const guard = startPeakGuard({ ceilingBytes: 10_000, rss: () => rss, onBreach: vi.fn() })
    guard.phase("bundles")
    rss = 800
    await vi.advanceTimersByTimeAsync(600)
    guard.phase("rendering pages")
    rss = 500
    await vi.advanceTimersByTimeAsync(600)
    rss = 900
    await vi.advanceTimersByTimeAsync(600)
    guard.phase("emit")
    rss = 700
    await vi.advanceTimersByTimeAsync(600)
    guard.stop()
    expect(guard.phasePeaks()).toEqual([
      { label: "startup", bytes: 100 },
      { label: "bundles", bytes: 800 },
      { label: "rendering pages", bytes: 900 },
      { label: "emit", bytes: 700 },
    ])
  })

  it("measures a phase that begins and ends between two sample ticks, at the boundary", () => {
    // The 500 ms interval never fires here: a fast build can run four phases without yielding to a tick, and the
    // boundary sample is then each phase's only measurement.
    let rss = 100
    const guard = startPeakGuard({ ceilingBytes: 1_000_000, rss: () => rss, onBreach: vi.fn() })
    rss = 400
    guard.phase("bundles")
    rss = 800
    guard.phase("rendering pages")
    rss = 900
    guard.phase("emit")
    rss = 700
    guard.stop()
    expect(guard.phasePeaks()).toEqual([
      // Each value is the resident set measured as that phase was left, so every phase has a real measurement.
      { label: "startup", bytes: 400 },
      { label: "bundles", bytes: 800 },
      { label: "rendering pages", bytes: 900 },
      { label: "emit", bytes: 700 },
    ])
  })

  it("enforces the ceiling on a phase-boundary sample before a later low reading", () => {
    vi.useFakeTimers()
    let rss = 900
    const onBreach = vi.fn()
    const guard = startPeakGuard({ ceilingBytes: 1000, rss: () => rss, onBreach })
    guard.phase("bundles")
    rss = 1300
    guard.phase("rendering pages")
    const breachesAtBoundary = onBreach.mock.calls.length
    rss = 900
    guard.stop()
    expect(breachesAtBoundary).toBe(1)
    expect(onBreach).toHaveBeenCalledTimes(1)
    expect(onBreach.mock.calls[0]?.[0]).toMatchObject({ bytes: 1300, peakBytes: 1300, phase: "bundles" })
    expect(guard.peakBytes()).toBe(1300)
  })

  it("names a phase it never sampled instead of dropping it or inventing a zero", () => {
    const guard = startPeakGuard({ ceilingBytes: 10_000, rss: () => 100, onBreach: vi.fn() })
    guard.stop()
    guard.phase("late")
    expect(guard.phasePeaks().at(-1)).toEqual({ label: "late", bytes: null })
  })

  it("takes a final sample at stop, so a peak between ticks is not lost", async () => {
    vi.useFakeTimers()
    const onBreach = vi.fn()
    let rss = 400
    const guard = startPeakGuard({ ceilingBytes: 10_000, rss: () => rss, onBreach })
    rss = 7000
    guard.stop()
    expect(guard.peakBytes()).toBe(7000)
    expect(onBreach).not.toHaveBeenCalled()
  })

  it("breaches on the final sample, so a build whose last sample is over the ceiling still fails", async () => {
    vi.useFakeTimers()
    const onBreach = vi.fn()
    let rss = 900
    const guard = startPeakGuard({ ceilingBytes: 1000, rss: () => rss, onBreach })
    await vi.advanceTimersByTimeAsync(1000)
    // No tick ever saw a breach; the stop sample does, and the resident set barely falls during a build, so this is
    // the usual place a real breach shows up.
    expect(onBreach).not.toHaveBeenCalled()
    rss = 1300
    guard.stop()
    expect(onBreach).toHaveBeenCalledTimes(1)
    expect(onBreach.mock.calls[0]?.[0]).toMatchObject({ bytes: 1300, peakBytes: 1300, phase: "startup" })
    expect(guard.peakBytes()).toBe(1300)
    guard.stop()
    expect(onBreach).toHaveBeenCalledTimes(1)
  })

  it("reports which phase held the largest high-water", async () => {
    vi.useFakeTimers()
    let rss = 100
    const guard = startPeakGuard({ ceilingBytes: 1_000_000, rss: () => rss, onBreach: vi.fn() })
    guard.phase("bundles")
    rss = 900
    await vi.advanceTimersByTimeAsync(700)
    guard.phase("rendering pages")
    rss = 5000
    await vi.advanceTimersByTimeAsync(700)
    guard.phase("emit")
    rss = 4000
    await vi.advanceTimersByTimeAsync(700)
    guard.stop()
    expect(guard.peakPhase()).toEqual({ label: "rendering pages", bytes: 5000 })
  })

  it("refuses an unmeasurable resident set instead of guarding with a broken instrument", () => {
    const onBreach = vi.fn()
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => startPeakGuard({ ceilingBytes: 1000, rss: () => bad, onBreach })).toThrow(/unmeasurable/)
    }
  })

  it("refuses a ceiling that is not a positive byte count", () => {
    expect(() => startPeakGuard({ ceilingBytes: 0, onBreach: vi.fn() })).toThrow(/positive byte count/)
  })
})

describe("peakBreachMessage", () => {
  it("names the measured resident set, the ceiling and the phase, in GB", () => {
    const message = peakBreachMessage({
      bytes: 13.5 * 1024 ** 3,
      peakBytes: 13.5 * 1024 ** 3,
      ceilingBytes: 13 * 1024 ** 3,
      phase: "rendering pages",
      elapsedMs: 61_500,
    })
    expect(message).toMatch(/13\.50 GB/)
    expect(message).toMatch(/13\.00 GB/)
    expect(message).toMatch(/rendering pages/)
    expect(message).toMatch(/61\.5 s/)
  })
})

describe("phasePeaksMessage", () => {
  it("prints every named phase, and says a phase was not sampled rather than printing an invented zero", () => {
    const message = phasePeaksMessage([
      { label: "startup", bytes: 1.5 * 1024 ** 3 },
      { label: "rendering pages", bytes: null },
    ])
    expect(message).toBe("site-build: phase peaks — startup 1.50 GB; rendering pages not sampled")
  })
})

describe("installRenderPhaseHook", () => {
  it("names the render phase on a config that has no transformHtml of its own, without changing page html", () => {
    const phases: string[] = []
    const config: { transformHtml?: unknown } = {}
    installRenderPhaseHook(config, { phase: (label) => phases.push(label) })
    expect(typeof config.transformHtml).toBe("function")
    // vitepress writes the page's own html when the hook returns nothing, so this must return nothing.
    expect((config.transformHtml as () => unknown)()).toBeUndefined()
    expect(phases).toEqual(["rendering pages"])
  })

  it("keeps a site config's own transformHtml and says so, instead of silently replacing it", () => {
    const own = (): string => "site html"
    const config: { transformHtml?: unknown } = { transformHtml: own }
    const warnings: string[] = []
    installRenderPhaseHook(config, { phase: () => {} }, (message) => warnings.push(message))
    expect(config.transformHtml).toBe(own)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/stays `bundles`/)
  })
})

describe("invalidateBuildStamp", () => {
  it("removes the served root stamp, so a breached output cannot be served by a later start", () => {
    const dist = mkdtempSync(join(tmpdir(), "peak-guard-dist-"))
    try {
      writeFileSync(join(dist, "build.json"), "{}\n")
      expect(invalidateBuildStamp(dist)).toEqual(["build.json"])
      expect(existsSync(join(dist, "build.json"))).toBe(false)
      // A breach before the build wrote any stamp removes nothing, and does not throw.
      expect(invalidateBuildStamp(dist)).toEqual([])
    } finally {
      // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is
      // unavailable; `dist` is this test's own mkdtemp scratch root
      rmSync(dist, { recursive: true, force: true })
    }
  })
})
