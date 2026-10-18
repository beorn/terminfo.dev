/**
 * The site build's resident-memory ceiling and the guard that enforces it (28662 AC3).
 *
 * `bun run build` peaks between 8 GB and 13 GB resident on this host (six runs measured 2026-10-11: the vite/rollup
 * bundle build is stable at 7.1-7.7 GB, and the SSR render's high-water is what varies). On a host whose stalls are
 * reclaim over a spent swap floor (28503), a build that keeps growing is a build that swaps the host. So the build
 * measures its own resident set and FAILS LOUD the moment it passes the ceiling, naming the peak it measured and the
 * phase it was in: `landed-serve` already refuses to serve the output of a failed build, so the preview answers
 * `starting` instead of serving a half-built corpus.
 *
 * The default is 16 GiB, raised from the 13 GiB this guard first declared (28679). 13 GiB sat INSIDE the build's own
 * 8-13 GB range, so a build behaving exactly as it always had failed by chance and paged its owner (measured: 13.17
 * and 13.24 GB at 06:37 and 06:39 PDT 2026-10-11, both over the line; 7.91 and 10.67 GB under it). 16 GiB leaves
 * 2.76 GB above the worst build ever observed, stops firing on a normal build, and is still far below this host's
 * 121 GB and the 28503 stall regime, so a genuinely runaway build trips it long before the host is at risk.
 *
 * The 8-13 GB footprint itself is NOT fixed by this: the spread lives in the SSR render's allocation high-water, and
 * bounding that render (batch, stream, or limit its concurrency) is its own item on the host-resources epic 27335,
 * cross-linked from 28679. The ceiling is a policy value protecting the HOST, not a measurement of the build.
 *
 * The ceiling is a declared value with an environment override, so a test can drive it below the ceiling's real
 * magnitude; an override that is not a positive byte count is refused loudly rather than ignored.
 */
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

export const DEFAULT_PEAK_CEILING_BYTES = 16 * 1024 ** 3
export const PEAK_CEILING_ENV = "TERMINFO_SITE_PEAK_CEILING_BYTES"
export const DEFAULT_SAMPLE_MS = 500

/**
 * The declared ceiling, or the environment's override. An unset or blank override means the declared default; a
 * malformed one is refused, never ignored.
 */
export function peakCeilingBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PEAK_CEILING_ENV]?.trim()
  if (raw === undefined || raw === "") return DEFAULT_PEAK_CEILING_BYTES
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${PEAK_CEILING_ENV} must be a positive integer count of bytes, got ${JSON.stringify(raw)}`)
  }
  const bytes = Number(raw)
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(`${PEAK_CEILING_ENV} ${JSON.stringify(raw)} is not a safe integer count of bytes`)
  }
  return bytes
}

export interface PeakBreach {
  /** The resident set measured at the breaching sample. */
  bytes: number
  /** The largest resident set measured since the guard started, including this sample. */
  peakBytes: number
  /** The phase the caller last named. */
  phase: string
  elapsedMs: number
}

export interface PeakGuardOptions {
  ceilingBytes: number
  /** Injectable resident-set reader; defaults to this process's own resident set. */
  rss?: () => number
  sampleMs?: number
  onBreach: (breach: PeakBreach) => void
}

export interface PeakGuard {
  /**
   * Name the phase the build is in, so a breach names where the memory went. Leaving a phase takes one sample
   * first, attributed to the phase being left: a phase shorter than the sample interval has no tick of its own, and
   * this is the only moment its resident set is observed.
   */
  phase(label: string): void
  /** The largest resident set measured, in bytes. */
  peakBytes(): number
  /** The phase whose own high-water was the largest, so a passing build still says where its memory went. */
  peakPhase(): { label: string; bytes: number } | undefined
  /**
   * Every phase's own high-water, in the order the phases were first named. A passing build reports the whole
   * band, so the next measurement knows which phase to bound rather than only which one happened to top out.
   * A named phase that was never sampled carries `null`, never an invented zero: the caller must say it was not
   * measured rather than report a build that spent no memory there.
   */
  phasePeaks(): PhasePeak[]
  /** Take a final sample and stop sampling. */
  stop(): void
}

export interface PhasePeak {
  label: string
  /** The phase's own high-water in bytes, or `null` when no sample landed while the phase was current. */
  bytes: number | null
}

const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(2)

/** The one band line, whatever the build's outcome: every named phase, and any phase no sample could reach. */
export function phasePeaksMessage(peaks: readonly PhasePeak[]): string {
  return `site-build: phase peaks — ${peaks
    .map(({ label, bytes }) => `${label} ${bytes === null ? "not sampled" : `${gib(bytes)} GB`}`)
    .join("; ")}`
}

/** The one line a breach prints: the measured resident set, the ceiling, the phase, and when it happened. */
export function peakBreachMessage(breach: PeakBreach & { ceilingBytes: number }): string {
  return (
    `site-build: FAILING — resident set ${gib(breach.bytes)} GB (peak ${gib(breach.peakBytes)} GB) exceeds the ` +
    `${gib(breach.ceilingBytes)} GB ceiling during ${breach.phase} at ${(breach.elapsedMs / 1000).toFixed(1)} s; ` +
    `refusing to finish the build`
  )
}

export function startPeakGuard(options: PeakGuardOptions): PeakGuard {
  if (!Number.isFinite(options.ceilingBytes) || options.ceilingBytes <= 0) {
    throw new Error(`peak ceiling must be a positive byte count, got ${options.ceilingBytes}`)
  }
  const read = options.rss ?? ((): number => process.memoryUsage.rss())
  const sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS
  const started = Date.now()
  let phase = "startup"
  let peak = 0
  const named = new Set<string>(["startup"])
  const phasePeak = new Map<string, number>()
  let stopped = false

  const measure = (): number => {
    const now = read()
    if (!Number.isFinite(now) || now < 0) {
      // A resident set that cannot be read is a broken instrument, not a small build.
      throw new Error(`the resident set measured ${now}; refusing to guard the build with an unmeasurable instrument`)
    }
    if (now > peak) peak = now
    if (now > (phasePeak.get(phase) ?? 0)) phasePeak.set(phase, now)
    return now
  }

  const tick = (): void => {
    if (stopped) return
    const now = measure()
    if (now > options.ceilingBytes) {
      // Stop first: a breach is reported once, and the peak stays the peak that breached.
      stopped = true
      clearInterval(timer)
      options.onBreach({ bytes: now, peakBytes: peak, phase, elapsedMs: Date.now() - started })
    }
  }

  // Sample once up front: a broken instrument must fail at start, not silently at the first tick.
  measure()
  const timer = setInterval(tick, sampleMs)
  // The guard observes the build; it never keeps the process alive on its own.
  timer.unref?.()

  return {
    phase(label: string): void {
      // Sample before leaving the current phase: a phase can begin and end between two timer ticks, and this
      // boundary sample is then its only measurement. Repeating the same label (the render hook runs per page)
      // is not a transition and takes no sample.
      if (label !== phase && !stopped) tick()
      phase = label
      named.add(label)
    },
    peakBytes(): number {
      return peak
    },
    peakPhase(): { label: string; bytes: number } | undefined {
      let top: { label: string; bytes: number } | undefined
      for (const [label, bytes] of phasePeak) {
        if (top === undefined || bytes > top.bytes) top = { label, bytes }
      }
      return top
    },
    phasePeaks(): PhasePeak[] {
      return [...named].map((label) => {
        const bytes = phasePeak.get(label)
        return { label, bytes: bytes === undefined ? null : bytes }
      })
    },
    stop(): void {
      if (stopped) return
      clearInterval(timer)
      const now = measure()
      stopped = true
      // The resident set barely falls during a build, so the FINAL sample is usually the peak of the whole run. A
      // ceiling checked only on the interval would let that sample pass: the build would print `done` and exit 0 while
      // over its ceiling. Check it here too, so no caller can forget.
      if (now > options.ceilingBytes) {
        options.onBreach({ bytes: now, peakBytes: peak, phase, elapsedMs: Date.now() - started })
      }
    },
  }
}

/**
 * Name the render phase on the site config the build resolved (VitePress exposes no render-phase hook of its own, and
 * the peak usually lands in the SSR render; `transformHtml` runs once per page, and vitepress writes the page's own
 * html when the hook returns nothing).
 *
 * A site config that already owns `transformHtml` keeps it: this script does not silently replace the site's own
 * hook. The guard's phase then stays `bundles` for the render, and the warning says so.
 */
export function installRenderPhaseHook(
  siteConfig: { transformHtml?: unknown },
  guard: Pick<PeakGuard, "phase">,
  warn: (message: string) => void = (message) => console.warn(message),
): void {
  if (siteConfig.transformHtml === undefined) {
    siteConfig.transformHtml = () => {
      guard.phase("rendering pages")
    }
    return
  }
  warn("site-build: the site config defines transformHtml; the peak guard's phase stays `bundles` for the render")
}

/**
 * Remove the served build stamps, so no later start can serve the output of a build that breached the ceiling.
 *
 * `landed-serve` calls a dist current when its own `/build.json` names this checkout's revision, and the stamp is
 * written by the build's `buildEnd` — near the END of the build. A breach after that point would otherwise leave a
 * complete, stamped dist that the next start (a restart-at-promotion, or the restart after the readiness failure)
 * happily serves: the very silent swap this guard exists to prevent. Removing the stamp makes that start rebuild.
 *
 * Absent stamps are not an error: a breach before `buildEnd` has nothing to remove, and the dist carries no proof of
 * freshness either way. Returns the stamps it removed, for the failure line.
 */
export function invalidateBuildStamp(distDir: string): string[] {
  const removed: string[] = []
  for (const relative of ["build.json", join("api", "v1", "build.json")]) {
    const path = join(distDir, relative)
    if (existsSync(path)) {
      rmSync(path, { force: true })
      removed.push(relative)
    }
  }
  return removed
}
