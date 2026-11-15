/**
 * Put the pre-paint reading on a returned capture's own diagnostic trace, beside the buckets it
 * explains, or leave the capture untouched when this route never took such a frame.
 */
export function withPrePaintReading<T extends { trace: Record<string, unknown> }>(
  result: T,
  reading: { calls: number; elapsedMs: number } | undefined,
): T {
  return reading === undefined ? result : { ...result, trace: { ...result.trace, prePaint: reading } }
}

/**
 * The cumulative cost of the pre-paint frames ONE served capture takes (34261 pre-paint ruling).
 * `run` times a complete callback - raw acquisition, raw decode/finalization and its existing record
 * callback - and `reading` answers the call count plus the summed duration, or undefined when this
 * route never took such a frame. One meter belongs to one served capture: a second capture builds a
 * second meter, so cost cannot carry across rows, and a retried read adds to the same total instead
 * of replacing the earlier attempt. A callback that throws records nothing, so a failed pre-paint can
 * never present as a successful timing result.
 */
export function createPrePaintMeter(now: () => number = () => performance.now()) {
  let elapsedMs = 0
  let calls = 0
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      const startedAt = now()
      const value = await work()
      elapsedMs += now() - startedAt
      calls += 1
      return value
    },
    reading(): { calls: number; elapsedMs: number } | undefined {
      // Observed zero survives when the callback really ran inside the rounding resolution.
      return calls === 0 ? undefined : { calls, elapsedMs: Math.round(elapsedMs) }
    },
  }
}
