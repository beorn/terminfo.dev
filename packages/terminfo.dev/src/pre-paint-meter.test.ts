/**
 * @failure The pre-paint frame a sentinel read takes before painting its pair is invisible in the
 *   caller's diagnostic trace, so the part of a served capture it consumes is either unnamed or
 *   silently charged to a bucket that did not measure it (34261 pre-paint ruling).
 * @level l2
 * @consumer Serve's per-capture pre-paint reading and the caller's interval attribution.
 * @testonly none
 * @reach none
 */
import { expect, test } from "vitest"
import { createPrePaintMeter, withPrePaintReading } from "./pre-paint-meter.ts"

/** A clock the test moves by hand, so no claim here depends on how fast the host is. */
function fakeClock(...ticks: number[]) {
  const queue = [...ticks]
  return () => {
    const next = queue.shift()
    if (next === undefined) throw new Error("the fixture clock ran out of ticks")
    return next
  }
}

test("one pre-paint costs exactly its own duration, recorded once", async () => {
  const meter = createPrePaintMeter(fakeClock(1_000, 1_250))
  expect(meter.reading()).toBeUndefined()
  const frame = await meter.run(async () => ({ label: "pre-paint" }))
  expect(frame).toEqual({ label: "pre-paint" })
  expect(meter.reading()).toEqual({ calls: 1, elapsedMs: 250 })
})

test("a retried read adds to the same total instead of replacing the earlier attempt", async () => {
  const meter = createPrePaintMeter(fakeClock(0, 100, 10_000, 10_120))
  await meter.run(async () => "first")
  await meter.run(async () => "second")
  expect(meter.reading()).toEqual({ calls: 2, elapsedMs: 220 })
})

test("a second served capture starts from nothing, so no cost carries across rows", async () => {
  const first = createPrePaintMeter(fakeClock(0, 90))
  await first.run(async () => "row one")
  const second = createPrePaintMeter(fakeClock(0, 4))
  expect(second.reading()).toBeUndefined()
  await second.run(async () => "row two")
  expect(first.reading()).toEqual({ calls: 1, elapsedMs: 90 })
  expect(second.reading()).toEqual({ calls: 1, elapsedMs: 4 })
})

test("a pre-paint that throws records nothing and still refuses", async () => {
  const meter = createPrePaintMeter(fakeClock(0))
  await expect(
    meter.run(async () => {
      throw new Error("raw capture refused")
    }),
  ).rejects.toThrow("raw capture refused")
  // The failure must not present as a timing result, and the meter is left unread rather than zeroed.
  expect(meter.reading()).toBeUndefined()
})

test("an executed pre-paint inside the rounding resolution keeps an observed zero", async () => {
  const meter = createPrePaintMeter(fakeClock(0, 0.4))
  await meter.run(async () => "sub-millisecond")
  expect(meter.reading()).toEqual({ calls: 1, elapsedMs: 0 })
})

test("the reading rides the capture's own trace beside the buckets it explains", () => {
  const capture = { frame: { label: "target" }, trace: { acquisition: { totalMs: 235 }, finish: { totalMs: 32 } } }
  expect(withPrePaintReading(capture, { calls: 1, elapsedMs: 269 })).toEqual({
    frame: { label: "target" },
    trace: { acquisition: { totalMs: 235 }, finish: { totalMs: 32 }, prePaint: { calls: 1, elapsedMs: 269 } },
  })
  // A route that never took the frame is untouched: absence means unobserved, never zero.
  expect(withPrePaintReading(capture, undefined)).toBe(capture)
})
