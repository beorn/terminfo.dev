import type { TermProbeSource } from "./types.ts"

/** The name a source with no clock throws, so a replay of a log recorded before the clock can name its cause. */
export const SOURCE_CLOCK_MISSING = "SourceClockMissing"

/**
 * #30932 S2: the one way a callback reads wall time. A live source's `now` is `Date.now()`, and the source
 * recorder keeps every value, so an offline replay asks for exactly the polls the live row asked for. A source
 * without a clock is refused loudly; nothing falls back to the global clock.
 */
export function sourceNow(ctx: Pick<TermProbeSource, "now">): number {
  if (!ctx.now) {
    const error = new Error("This probe source offers no clock (TermProbeSource.now), so its deadlines cannot be read")
    error.name = SOURCE_CLOCK_MISSING
    throw error
  }
  return ctx.now()
}
