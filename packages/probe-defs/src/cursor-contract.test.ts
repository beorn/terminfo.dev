/**
 * @failure A group feature is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so a group step reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 Cursor group (child 28020); second adopter of the 28453 harness.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/cursor-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/cursor-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/semantic-surface.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { cursorProbes } from "./cursor.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import {
  contractGaps,
  inertLibProbeSource,
  libProbeSource,
  missingContractTests,
  regradeCommand,
  regradeRow,
  replayTermProbeSource,
  satisfiesContract,
  type GroupContract,
  type GroupContractSpec,
  type HeadlessModel,
  type StoredQuery,
} from "./testing/group-harness.ts"

/** The 22 Cursor features of 28018's Cursor row; ids drawn from cursor.ts, claims are the contract. */
const CURSOR_CONTRACT: GroupContract = [
  { id: "cursor.move.absolute", expected: "decided", claim: "CUP CSI 5;10H selects row 4 col 9 (0-based)" },
  { id: "cursor.move.home", expected: "decided", claim: "CUP with no args homes the cursor" },
  { id: "cursor.move.forward", expected: "decided", claim: "CUF CSI 5C advances five columns" },
  { id: "cursor.move.back", expected: "decided", claim: "CUB CSI 2D moves back two columns" },
  { id: "cursor.move.down", expected: "decided", claim: "CUD CSI 3B moves down three rows" },
  { id: "cursor.move.up", expected: "decided", claim: "CUU CSI 2A moves up two rows" },
  {
    id: "cursor.hide",
    expected: "decided",
    claim:
      "DECTCEM hides the cursor: mode 25 reports set then reset, and a measured raster shows the cursor cell pixels change and restore",
  },
  { id: "cursor.shape", expected: "decided", claim: "DECSCUSR CSI 6 SP q reports a beam cursor" },
  { id: "cursor.horizontal-absolute", expected: "decided", claim: "CHA CSI 15G selects column 14" },
  { id: "cursor.next-line", expected: "decided", claim: "CNL CSI E moves to the next line column 0" },
  {
    id: "cursor.position-report",
    expected: "decided",
    claim: "DSR 6 reports the independently measured CUP 3;5 position",
  },
  { id: "cursor.ansi-save", expected: "decided", claim: "CSI s / CSI u restores the saved cursor" },
  {
    id: "cursor.ansi-restore",
    expected: "decided",
    claim: "CSI s / CSI u restores the saved cursor at a second fixture",
  },
  { id: "cursor.save-restore", expected: "decided", claim: "DECSC/DECRC ESC 7 / ESC 8 restores the saved cursor" },
  { id: "cursor.reverse-wrap", expected: "decided", claim: "DECSET 45 + backspace reverses a measured wrap" },
  { id: "cursor.cup-boundaries", expected: "decided", claim: "CUP 999;999 clamps to the measured edge" },
  { id: "cursor.cuu-past-top", expected: "decided", claim: "CUU 999 from row 4 stops at row 0" },
  { id: "cursor.cud-past-bottom", expected: "decided", claim: "CUD past the last initialized row clamps there" },
  { id: "cursor.vpa", expected: "decided", claim: "VPA CSI 10d selects row 9" },
  { id: "cursor.cpl", expected: "decided", claim: "CPL CSI 2F moves two preceding lines to column 0" },
  { id: "cursor.hpa", expected: "decided", claim: "HPA CSI 15` selects column 14" },
  {
    id: "cursor.cup-scroll-region",
    expected: "decided",
    claim: "DECSTBM 5;15 + DECOM CUP 1;1 lands at physical row 4",
  },
]

/** The named set 28454 reviews: Cursor's rows plus the focused test files that bind them (no glob). */
const CURSOR_CONTRACT_SPEC: GroupContractSpec = {
  group: "cursor",
  rows: CURSOR_CONTRACT,
  tests: ["packages/probe-defs/src/cursor-contract.test.ts", "packages/probe-defs/src/cursor-observations.test.ts"],
}

type InertCell = ReturnType<HeadlessModel["getCell"]>

const INERT_CELL: InertCell = {
  char: " ",
  bold: false,
  dim: false,
  italic: false,
  underline: null,
  underlineColor: null,
  strikethrough: false,
  inverse: false,
  hidden: false,
  blink: false,
  overline: false,
  fg: null,
  bg: null,
  wide: false,
}

test("the Cursor contract covers every Cursor feature and names none unknown", () => {
  const gaps = contractGaps(cursorProbes, CURSOR_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(cursorProbes).toHaveLength(22)
  expect(CURSOR_CONTRACT).toHaveLength(22)
})

test("the Cursor contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(CURSOR_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(CURSOR_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of CURSOR_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

test("the harness replays every Cursor feature deterministically (satisfaction is bound by the semantic surface test below)", async () => {
  for (const row of CURSOR_CONTRACT) {
    const probe = cursorProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing Cursor probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.lib !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    const second = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

test("every Cursor contract row is satisfied by the headless cursor state its claim requires", async () => {
  for (const row of CURSOR_CONTRACT) {
    const probe = cursorProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing Cursor probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(graded.after, `${row.id} reads supported from its claim's cursor state`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
})

const CURSOR_SEMANTIC_SURFACE_CONTROLS: readonly (readonly [id: string, mutation: string])[] = [
  ["cursor.move.absolute", "cup-noop"],
  ["cursor.move.home", "cup-home-noop"],
  ["cursor.move.forward", "cuf-noop"],
  ["cursor.move.back", "cub-noop"],
  ["cursor.move.down", "cud-noop"],
  ["cursor.move.up", "cuu-noop"],
  ["cursor.hide", "dectcem-noop"],
  ["cursor.shape", "decscusr-noop"],
  ["cursor.horizontal-absolute", "cha-noop"],
  ["cursor.next-line", "cnl-noop"],
  ["cursor.position-report", "dsr-cpr-noop"],
  ["cursor.ansi-save", "ansi-save-noop"],
  ["cursor.ansi-restore", "ansi-restore-noop"],
  ["cursor.save-restore", "decsc-noop"],
  ["cursor.reverse-wrap", "reverse-wrap-noop"],
  ["cursor.cup-boundaries", "cup-clamp-noop"],
  ["cursor.cuu-past-top", "cuu-clamp-noop"],
  ["cursor.cud-past-bottom", "cud-clamp-noop"],
  ["cursor.vpa", "vpa-noop"],
  ["cursor.cpl", "cpl-noop"],
  ["cursor.hpa", "hpa-noop"],
  ["cursor.cup-scroll-region", "decom-noop"],
]

test("CURSOR_SEMANTIC_SURFACE_CONTROLS covers all 22 Cursor contract rows with distinct mutations", () => {
  expect(CURSOR_SEMANTIC_SURFACE_CONTROLS).toHaveLength(22)
  expect(CURSOR_SEMANTIC_SURFACE_CONTROLS.map(([id]) => id).sort()).toEqual(CURSOR_CONTRACT.map((row) => row.id).sort())
  expect(new Set(CURSOR_SEMANTIC_SURFACE_CONTROLS.map(([, mutation]) => mutation)).size).toBe(22)
})

test.each(CURSOR_SEMANTIC_SURFACE_CONTROLS)(
  "%s never reads supported on inertLibProbeSource, reads supported on createSemanticSurface, and reads unsupported when %s is active",
  async (id, mutation) => {
    const row = CURSOR_CONTRACT.find((entry) => entry.id === id)
    const probe = cursorProbes.find((entry) => entry.id === id)
    expect(row, `the Cursor contract names ${id}`).toBeDefined()
    expect(probe, `the Cursor contract names a real ${id} probe`).toBeDefined()
    if (!row || !probe || !probe.lib) return

    const inertResult = probe.lib(inertLibProbeSource())
    expect(inertResult.pass).toBe(false)
    expect(inertResult.observation?.outcome).not.toBe("supported")

    const positiveResult = probe.lib(libProbeSource(createSemanticSurface()))
    expect(positiveResult.pass).toBe(true)
    expect(positiveResult.observation?.outcome).toBe("supported")
    expect(positiveResult.assertions ?? []).toContainEqual(expect.objectContaining({ kind: "positive" }))
    const positiveGraded = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(positiveGraded.after).toBe("supported")
    expect(positiveGraded.satisfies).toBe(true)

    const negativeResult = probe.lib(libProbeSource(createSemanticSurface({ mutations: [mutation] })))
    expect(negativeResult.pass).toBe(false)
    expect(negativeResult.observation?.outcome).toBe("unsupported")
    expect(negativeResult.assertions ?? []).toContainEqual(expect.objectContaining({ kind: "negative" }))
    const negativeGraded = await regradeRow(probe, row, {
      headless: libProbeSource(createSemanticSurface({ mutations: [mutation] })),
    })
    expect(negativeGraded.after).toBe("unsupported")
    expect(negativeGraded.satisfies).toBe(true)
  },
)

test("cursor.shape is inconclusive when style readback is omitted, bound when present", async () => {
  const row = CURSOR_CONTRACT.find((entry) => entry.id === "cursor.shape")
  const probe = cursorProbes.find((entry) => entry.id === "cursor.shape")
  expect(row, "the Cursor contract names cursor.shape").toBeDefined()
  expect(probe, "the Cursor contract names a real cursor.shape probe").toBeDefined()
  if (!row || !probe) return
  const present = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
  expect(present.after).toBe("supported")
  expect(present.satisfies).toBe(true)
  const omitted = await regradeRow(probe, row, { headless: inertLibProbeSource() })
  expect(omitted.after).toBe("inconclusive")
  expect(omitted.satisfies).toBe(false)
  const result = probe.lib?.(inertLibProbeSource())
  expect(result?.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "buffer_state",
  })
})

test("cursor.shape's app arm decides from the terminal's DECRQSS cursor-style report", async () => {
  const row = CURSOR_CONTRACT.find((entry) => entry.id === "cursor.shape")
  const probe = cursorProbes.find((entry) => entry.id === "cursor.shape")
  expect(row, "the Cursor contract names cursor.shape").toBeDefined()
  expect(probe, "the Cursor contract names a real cursor.shape probe").toBeDefined()
  if (!row || !probe) return
  const styleQuery = "\x1bP$q q\x1b\\"
  const withReply = (raw: string) =>
    replayTermProbeSource(
      new Map<string, StoredQuery>([[styleQuery, { sequence: styleQuery, match: null, reason: "reply", raw }]]),
    )
  const beam = await regradeRow(probe, row, { term: withReply("\x1bP1$r6 q\x1b\\") })
  expect(beam.after, "a DECRQSS report of style 6 decides cursor.shape").toBe("supported")
  expect(beam.satisfies).toBe(true)
  const block = await regradeRow(probe, row, { term: withReply("\x1bP1$r2 q\x1b\\") })
  expect(block.after, "a DECRQSS report of a non-beam style is a decided unsupported").toBe("unsupported")
  expect(block.satisfies).toBe(true)
  const silent = await probe.term!(replayTermProbeSource(new Map()))
  expect(silent.observation).toBeUndefined()
  expect(silent.tests).toMatchObject([expect.objectContaining({ status: "probe-invalid", reason: expect.any(String) })])
})

test("a decided Cursor row is unsatisfied when the origin control does not hold", async () => {
  const row = CURSOR_CONTRACT.find((entry) => entry.id === "cursor.move.absolute")
  const probe = cursorProbes.find((entry) => entry.id === "cursor.move.absolute")
  expect(row, "the Cursor contract names cursor.move.absolute").toBeDefined()
  expect(probe, "the Cursor contract names a real cursor.move.absolute probe").toBeDefined()
  if (!row || !probe) return
  const displaced: HeadlessModel = {
    cols: 80,
    feed: () => {},
    getCell: () => ({ ...INERT_CELL }),
    getCursor: () => ({ x: 1, y: 1, visible: true, style: null }),
  }
  const inert = await regradeRow(probe, row, { headless: libProbeSource(displaced) })
  expect(inert.after).toBe("inconclusive")
  expect(inert.satisfies).toBe(false)
})
