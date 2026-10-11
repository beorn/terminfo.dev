/**
 * @failure The site build grows past its declared resident-memory ceiling and keeps building, so a swap-floor host pays for it silently (28662 AC3).
 * @level l2
 * @consumer The terminfo-site resident's `bun run build`, and the 28662 per-stage peak measurement.
 * @testonly none
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_PEAK_CEILING_BYTES,
  PEAK_CEILING_ENV,
  peakBreachMessage,
  peakCeilingBytes,
  installRenderPhaseHook,
  startPeakGuard,
} from "./build-peak-guard.ts"

afterEach(() => {
  vi.useRealTimers()
})

describe("peakCeilingBytes", () => {
  it("defaults to the declared 13 GiB ceiling", () => {
    expect(DEFAULT_PEAK_CEILING_BYTES).toBe(13 * 1024 ** 3)
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
