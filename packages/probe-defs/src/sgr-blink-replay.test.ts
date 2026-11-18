/**
 * @failure sgr.blink decides on the interval it requested instead of the samples it achieved, so a
 *   slow capture aliases a real blink into a one-way change (Terminal.app 3053c5ec) and a short
 *   flat series decides Unsupported on evidence that could not have seen a blink (alacritty
 *   6fa9cc2b, ghostty 97f0b21b) (#33117).
 * @level l1
 * @consumer app sgr.blink results projected into terminal support cells
 * @testonly blinkSeriesDecision: replaying a stored frame series cannot re-run the live capture
 *   schedule, so the series decision is exported for these replay cases alone
 */
import { expect, test } from "vitest"
import { blinkSeriesDecision } from "./sgr.ts"

/**
 * The six stored series, distilled from content/probes-apps records: styled regionDigest slices
 * (digest[7:15], distinctness preserved), capturedAt as ms from the first styled frame, and the
 * plain-line digests in capture order. Expected verdicts and witness numbers are the reference
 * replay's (blink-rule-proof, @dev/luna6, #33117).
 */
const SERIES = [
  {
    record: "terminal-app-2.15-macos-1991f8e4251a87f27fdc6dc085b2ab62",
    stored: "supported",
    styled: [
      "8223f6ed",
      "8223f6ed",
      "1ca66197",
      "8223f6ed",
      "1ca66197",
      "1ca66197",
      "8223f6ed",
      "1ca66197",
      "8223f6ed",
    ],
    capturedAt: [0, 622, 1211, 1827, 2364, 2942, 3721, 4337, 4925],
    plain: Array.from({ length: 10 }, () => "8223f6ed"),
    halfPeriodMs: 602,
  },
  {
    record: "kitty-0.49.2-linux-b09e6e5cab7a3a07c0754538b2d949d6",
    stored: "supported",
    styled: [
      "27975cbb",
      "05691908",
      "27975cbb",
      "05691908",
      "27975cbb",
      "05691908",
      "27975cbb",
      "05691908",
      "27975cbb",
    ],
    capturedAt: [0, 468, 933, 1414, 1890, 2355, 2830, 3301, 3781],
    plain: Array.from({ length: 10 }, () => "27975cbb"),
    halfPeriodMs: 473,
  },
  {
    record: "xterm-411-linux-524cbe6f4f80add55354810f35fd57c7",
    stored: "supported",
    styled: [
      "07d025f0",
      "b1dee2d8",
      "07d025f0",
      "b1dee2d8",
      "07d025f0",
      "b1dee2d8",
      "07d025f0",
      "07d025f0",
      "b1dee2d8",
    ],
    capturedAt: [0, 595, 1210, 1787, 2342, 2903, 3512, 4070, 4650],
    plain: Array.from({ length: 10 }, () => "07d025f0"),
    halfPeriodMs: 591,
  },
  {
    record: "terminal-app-2.15-macos-3053c5ec940f5c18d6a4043a210e2c94",
    stored: "probe-todo",
    styled: [
      "8223f6ed",
      "1ca66197",
      "1ca66197",
      "1ca66197",
      "1ca66197",
      "1ca66197",
      "1ca66197",
      "1ca66197",
      "1ca66197",
    ],
    capturedAt: [0, 1105, 2095, 3168, 4156, 5130, 6246, 7129, 7885],
    plain: Array.from({ length: 10 }, () => "8223f6ed"),
    witness: { frames: 9, spanMs: 7885, gapMinMs: 756, gapMedianMs: 989, gapMaxMs: 1116 },
  },
  {
    record: "alacritty-0.17.0-linux-6fa9cc2b3098dd1d90dc89d2c60ad7a4",
    stored: "unsupported",
    styled: Array.from({ length: 9 }, () => "dc94e8db"),
    capturedAt: [0, 532, 1047, 1581, 2115, 2649, 3178, 3710, 4249],
    plain: Array.from({ length: 10 }, () => "dc94e8db"),
    witness: { frames: 9, spanMs: 4249, gapMinMs: 515, gapMedianMs: 533, gapMaxMs: 539 },
  },
  {
    record: "ghostty-1.4.0-linux-97f0b21b46a75ea76f81c85ff1611483",
    stored: "unsupported",
    styled: Array.from({ length: 9 }, () => "fec1dd01"),
    capturedAt: [0, 547, 1099, 1643, 2187, 2741, 3278, 3815, 4357],
    plain: Array.from({ length: 10 }, () => "fec1dd01"),
    witness: { frames: 9, spanMs: 4357, gapMinMs: 537, gapMedianMs: 544, gapMaxMs: 554 },
  },
] as const

test.each(SERIES.filter((entry) => "halfPeriodMs" in entry))(
  "stored supported series $record replays supported with its measured half-period",
  ({ styled, capturedAt, plain, halfPeriodMs }) => {
    const verdict = blinkSeriesDecision({ styled, plain, capturedAt, focusQualified: false })
    expect(verdict.kind).toBe("supported")
    expect(verdict.witness).toMatchObject({ frames: styled.length, halfPeriodMs })
    expect(verdict.witness.gapMinMs).toBeTypeOf("number")
    expect(verdict.witness.gapMedianMs).toBeTypeOf("number")
    expect(verdict.witness.gapMaxMs).toBeTypeOf("number")
  },
)

test.each(SERIES.filter((entry) => "witness" in entry))(
  "stored series $record (stored $stored) replays open: capture too slow to decide blink",
  ({ styled, capturedAt, plain, witness }) => {
    const verdict = blinkSeriesDecision({ styled, plain, capturedAt, focusQualified: false })
    expect(verdict).toMatchObject({ kind: "open", reason: "capture-too-slow" })
    expect(verdict.witness).toMatchObject(witness)
  },
)

const GATE_TIMES = Array.from({ length: 16 }, (_, index) => index * 500)
const STEADY = Array.from({ length: 17 }, () => "p")

test("a flat series inside the gate is negative-decidable", () => {
  const verdict = blinkSeriesDecision({
    styled: Array.from({ length: 16 }, () => "a"),
    plain: STEADY,
    capturedAt: GATE_TIMES,
    focusQualified: false,
  })
  expect(verdict.kind).toBe("negative-decidable")
  expect(verdict.witness).toMatchObject({ frames: 16, spanMs: 7500, transitions: 0 })
})

test("one change then stillness inside the gate is negative-decidable, never a paint-settle refusal", () => {
  const verdict = blinkSeriesDecision({
    styled: [...Array.from({ length: 8 }, () => "a"), ...Array.from({ length: 8 }, () => "b")],
    plain: STEADY,
    capturedAt: GATE_TIMES,
    focusQualified: false,
  })
  expect(verdict.kind).toBe("negative-decidable")
  expect(verdict.witness.transitions).toBe(1)
})

test("several changes without a return inside the gate stay open", () => {
  const verdict = blinkSeriesDecision({
    styled: [
      ...Array.from({ length: 6 }, () => "a"),
      ...Array.from({ length: 5 }, () => "b"),
      ...Array.from({ length: 5 }, () => "c"),
    ],
    plain: STEADY,
    capturedAt: GATE_TIMES,
    focusQualified: false,
  })
  expect(verdict).toMatchObject({ kind: "open", reason: "changed-without-return" })
})

test("a moved plain line vetoes every other reading", () => {
  const verdict = blinkSeriesDecision({
    styled: Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? "a" : "b")),
    plain: STEADY.map((value, index) => (index === 3 ? "q" : value)),
    capturedAt: GATE_TIMES,
    focusQualified: false,
  })
  expect(verdict).toMatchObject({ kind: "open", reason: "control-moved" })
})

// #34549 (@cto coverage criterion ruling): a bounded gap does not establish phase coverage. Both series
// clear 12 frames and 6000 ms with no gap above 510 ms, yet a 50%-duty blink inside the declared class reads
// "on" at every sample: period 1000 ms at phase 0, and period 5002/5 ms at phase 1/10 ms
// ((10t + 1) mod 10004 < 5002 for every t). Neither may decide a negative.
const PHASE_LOCKED = [
  {
    name: "1000 ms alias",
    capturedAt: [0, 490, 1000, 1490, 2000, 2490, 3000, 3490, 4000, 4490, 5000, 5490, 6000, 6490, 7000, 7490],
    blind: [998.4, 1001.6],
  },
  {
    name: "1000.4 ms fractional alias",
    capturedAt: [1, 500, 1001, 1500, 2001, 2500, 3002, 3501, 4002, 4501, 5003, 5502, 6003, 6502, 7003, 7502],
    blind: [1000.28, 1000.47],
  },
] as const

test.each(PHASE_LOCKED)("a flat series phase-locked to a class period stays open: $name", ({ capturedAt, blind }) => {
  const verdict = blinkSeriesDecision({
    styled: capturedAt.map(() => "a"),
    plain: STEADY,
    capturedAt,
    focusQualified: true,
  })
  expect(verdict).toMatchObject({ kind: "open", reason: "phase-uncovered" })
  // The witness names a period inside the measured uncovered interval (an independent 0.001 ms scan).
  expect(verdict.witness.uncoveredPeriodMs).toBeGreaterThan(blind[0])
  expect(verdict.witness.uncoveredPeriodMs).toBeLessThan(blind[1])
})

test("the coverage check reads epoch capture times like their offsets", () => {
  // Live capturedAt is Date.now(); the check must not lose precision on it (scaled by a rational
  // period's denominator, raw epoch values pass 2^53).
  const epoch = 1_795_030_000_000
  for (const { capturedAt } of PHASE_LOCKED) {
    const shifted = capturedAt.map((t) => t + epoch)
    const [atOffset, atEpoch] = [capturedAt, shifted].map(
      (times) => blinkSeriesDecision({ styled: times.map(() => "a"), plain: STEADY, capturedAt: times, focusQualified: true }).witness.uncoveredPeriodMs,
    )
    expect(atEpoch).toBe(atOffset)
  }
  const covered = timesOf(RETAINED_GAPS[0].gaps).map((t) => t + epoch)
  expect(blinkSeriesDecision({ styled: covered.map(() => "a"), plain: STEADY, capturedAt: covered, focusQualified: true }).kind).toBe("negative-decidable")
})

test("a return still decides Supported at phase-locked capture times", () => {
  const capturedAt = PHASE_LOCKED[0].capturedAt
  const verdict = blinkSeriesDecision({
    styled: capturedAt.map((_, index) => (index % 4 < 2 ? "a" : "b")),
    plain: STEADY,
    capturedAt,
    focusQualified: false,
  })
  expect(verdict.kind).toBe("supported")
})

// Achieved capture times of the seven retained Linux runs (draft records named in
// /hh/var/@cto/do-20261114T1623/blink34549-independent-2123.json and 34549-bound-retained-proof-1108.json),
// as gaps. Every one covers the declared class, so every one decides, whatever its largest gap; under the
// former 545 ms ceiling only the run whose largest gap is 545 ms did, and the rest stayed capture too slow.
const RETAINED_GAPS = [
  {
    run: "alacritty 2026-11-17T12-06",
    gaps: [523, 522, 542, 537, 525, 508, 514, 543, 537, 536, 540, 536, 548, 556, 571],
  },
  {
    run: "alacritty 2026-11-17T19-21",
    gaps: [543, 506, 474, 491, 466, 481, 481, 480, 486, 512, 531, 518, 529, 611, 546],
  },
  {
    run: "alacritty 2026-11-18T00-06",
    gaps: [519, 479, 502, 499, 516, 522, 522, 503, 524, 528, 574, 509, 497, 505, 535],
  },
  {
    run: "alacritty 2026-11-18T12-06",
    gaps: [499, 507, 476, 493, 556, 526, 549, 520, 549, 523, 539, 518, 504, 499, 500],
  },
  {
    run: "ghostty 2026-11-17T10-36",
    gaps: [626, 608, 628, 646, 772, 668, 784, 537, 552, 566, 585, 556, 544, 538, 559],
  },
  {
    run: "ghostty 2026-11-17T17-51",
    gaps: [543, 472, 474, 475, 465, 503, 493, 515, 486, 500, 493, 545, 486, 518, 492],
  },
  {
    run: "ghostty 2026-11-17T22-36",
    gaps: [476, 482, 470, 510, 473, 510, 486, 507, 502, 502, 546, 506, 637, 595, 470],
  },
] as const
const timesOf = (gaps: readonly number[]) =>
  gaps.reduce<number[]>((times, gap) => [...times, (times.at(-1) ?? 0) + gap], [0])

test.each(RETAINED_GAPS)("retained flat run $run covers the declared class", ({ gaps }) => {
  const capturedAt = timesOf(gaps)
  const verdict = blinkSeriesDecision({
    styled: capturedAt.map(() => "a"),
    plain: STEADY,
    capturedAt,
    focusQualified: true,
  })
  expect(verdict.witness.uncoveredPeriodMs).toBeUndefined()
  expect(verdict.kind).toBe("negative-decidable")
})
