import type { TermProbeSource } from "./types.ts"

/** The name a source with no clock throws, so a replay of a log recorded before the clock can name its cause. */
export const SOURCE_CLOCK_MISSING = "SourceClockMissing"

/** The name a source with no randomUUID throws, so a replay of a log recorded before it can name its cause. */
export const SOURCE_RANDOM_MISSING = "SourceRandomMissing"

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

/**
 * #30932 AC1: the one way a term callback draws a fresh identifier. A live source's `randomUUID` is
 * `crypto.randomUUID()`, and the source recorder keeps every draw, so an offline replay hands back the exact
 * values the live run wrote. A source without `randomUUID` refuses loudly; nothing draws from global crypto.
 */
export function sourceRandomUUID(ctx: Pick<TermProbeSource, "randomUUID">): string {
  if (!ctx.randomUUID) {
    const error = new Error(
      "This probe source offers no randomUUID (TermProbeSource.randomUUID), so its nonces cannot be drawn",
    )
    error.name = SOURCE_RANDOM_MISSING
    throw error
  }
  return ctx.randomUUID()
}
