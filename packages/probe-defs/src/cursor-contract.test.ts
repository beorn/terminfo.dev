/**
 * @failure A group capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so a group step reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 Cursor group (child 28020); second adopter of the 28453 harness.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/cursor-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/cursor-observations.test.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { cursorProbes } from "./cursor.ts"
import {
  contractGaps,
  headlessContext,
  missingContractTests,
  regradeCommand,
  regradeRow,
  satisfiesContract,
  type GroupContract,
  type GroupContractSpec,
  type HeadlessModel,
} from "./testing/group-harness.ts"

/** The 22 Cursor capabilities of 28018's Cursor row; ids drawn from cursor.ts, claims are the contract. */
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
    claim: "DECTCEM hides the cursor and restores the measured initial visibility",
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
  fg: null,
  bg: null,
  wide: false,
}

function inertModel(cols = 80): HeadlessModel {
  return {
    cols,
    feed: () => {},
    getCell: () => ({ ...INERT_CELL }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
  }
}

/**
 * One headless cursor that interprets the sequences the 22 probes feed. This is the satisfaction
 * binding (the contract predicate and probe agree), not a claim that a real terminal emits it.
 * A fresh model per re-grade, so leftover position cannot satisfy a later row.
 */
function interpretingCursor(cols = 80, rows = 24): HeadlessModel {
  let x = 0
  let y = 0
  let visible: boolean | null = true
  let style: string | null = null
  let saved = { x: 0, y: 0 }
  let autoWrap = false
  let reverseWrap = false
  let originMode = false
  let scrollTop = 0
  let scrollBottom = rows - 1
  let pendingWrap = false

  const clamp = () => {
    const top = originMode ? scrollTop : 0
    const bottom = originMode ? scrollBottom : rows - 1
    if (y < top) y = top
    if (y > bottom) y = bottom
    if (x < 0) x = 0
    if (x >= cols) x = cols - 1
  }

  const param = (raw: string, fallback = 1): number => {
    if (raw === "") return fallback
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 ? value : fallback
  }

  const applyCsi = (priv: string, params: string, inter: string, final: string) => {
    const parts = params.split(";")
    if (priv === "?") {
      const mode = param(parts[0] ?? "", 0)
      const set = final === "h"
      if (mode === 25) visible = set
      else if (mode === 7) autoWrap = set
      else if (mode === 45) reverseWrap = set
      else if (mode === 6) originMode = set
      return
    }
    if (final === "H" || final === "f") {
      const row = param(parts[0] ?? "", 1)
      const col = param(parts[1] ?? "", 1)
      y = (originMode ? scrollTop : 0) + row - 1
      x = col - 1
      pendingWrap = false
      clamp()
      return
    }
    if (final === "A") {
      y -= param(parts[0] ?? "")
      pendingWrap = false
      clamp()
      return
    }
    if (final === "B") {
      y += param(parts[0] ?? "")
      pendingWrap = false
      clamp()
      return
    }
    if (final === "C") {
      x += param(parts[0] ?? "")
      pendingWrap = false
      clamp()
      return
    }
    if (final === "D") {
      x -= param(parts[0] ?? "")
      pendingWrap = false
      clamp()
      return
    }
    if (final === "E") {
      y += param(parts[0] ?? "")
      x = 0
      pendingWrap = false
      clamp()
      return
    }
    if (final === "F") {
      y -= param(parts[0] ?? "")
      x = 0
      pendingWrap = false
      clamp()
      return
    }
    if (final === "G") {
      x = param(parts[0] ?? "") - 1
      pendingWrap = false
      clamp()
      return
    }
    if (final === "d") {
      y = (originMode ? scrollTop : 0) + param(parts[0] ?? "") - 1
      pendingWrap = false
      clamp()
      return
    }
    if (final === "`") {
      x = param(parts[0] ?? "") - 1
      pendingWrap = false
      clamp()
      return
    }
    if (final === "r") {
      const top = param(parts[0] ?? "", 1)
      const bottom = parts[1] === undefined || parts[1] === "" ? rows : param(parts[1], rows)
      scrollTop = top - 1
      scrollBottom = bottom - 1
      return
    }
    if (final === "s") {
      saved = { x, y }
      return
    }
    if (final === "u") {
      x = saved.x
      y = saved.y
      pendingWrap = false
      return
    }
    if (final === "q" && inter === " ") {
      style = param(parts[0] ?? "", 0) === 6 ? "beam" : "block"
    }
  }

  const feed = (text: string) => {
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch === "\x1b") {
        const next = text[i + 1]
        if (next === "[") {
          i += 2
          let priv = ""
          if (text[i] === "?") {
            priv = "?"
            i += 1
          }
          const start = i
          while (i < text.length && /[0-9;]/u.test(text[i] ?? "")) i += 1
          const params = text.slice(start, i)
          let inter = ""
          while (i < text.length && (text[i] ?? "") >= " " && (text[i] ?? "") <= "/") {
            inter += text[i]
            i += 1
          }
          const final = text[i] ?? ""
          if (final !== "") i += 1
          applyCsi(priv, params, inter, final)
          continue
        }
        if (next === "7") {
          saved = { x, y }
          i += 2
          continue
        }
        if (next === "8") {
          x = saved.x
          y = saved.y
          pendingWrap = false
          i += 2
          continue
        }
        i += 1
        continue
      }
      if (ch === "\x08") {
        if (x > 0) x -= 1
        else if (reverseWrap && y > 0) {
          y -= 1
          x = cols - 1
        }
        pendingWrap = false
        i += 1
        continue
      }
      if (ch !== undefined && ch >= " ") {
        if (pendingWrap && autoWrap) {
          y += 1
          x = 0
          pendingWrap = false
          clamp()
        }
        if (x === cols - 1) pendingWrap = true
        else x += 1
        i += 1
        continue
      }
      i += 1
    }
  }

  return {
    cols,
    feed,
    getCell: () => ({ ...INERT_CELL }),
    getCursor: () => ({ x, y, visible, style }),
    getMode: (mode) => (mode === "autoWrap" ? autoWrap : false),
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feedCapture: (text) => {
      if (text === "\x1b[6n") return `\x1b[${y + 1};${x + 1}R`
      feed(text)
      return ""
    },
  }
}

test("the Cursor contract covers every Cursor capability and names none unknown", () => {
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

test("the harness replays every Cursor capability deterministically (satisfaction is bound by the interpreter test below)", async () => {
  for (const row of CURSOR_CONTRACT) {
    const probe = cursorProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing Cursor probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.termless !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { headless: headlessContext(interpretingCursor()) })
    const second = await regradeRow(probe, row, { headless: headlessContext(interpretingCursor()) })
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
    const graded = await regradeRow(probe, row, { headless: headlessContext(interpretingCursor()) })
    expect(graded.after, `${row.id} reads supported from its claim's cursor state`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
})

test("cursor.shape is inconclusive when style readback is omitted, bound when present", async () => {
  const row = CURSOR_CONTRACT.find((entry) => entry.id === "cursor.shape")
  const probe = cursorProbes.find((entry) => entry.id === "cursor.shape")
  expect(row, "the Cursor contract names cursor.shape").toBeDefined()
  expect(probe, "the Cursor contract names a real cursor.shape probe").toBeDefined()
  if (!row || !probe) return
  const present = await regradeRow(probe, row, { headless: headlessContext(interpretingCursor()) })
  expect(present.after).toBe("supported")
  expect(present.satisfies).toBe(true)
  const omitted = await regradeRow(probe, row, { headless: headlessContext(inertModel()) })
  expect(omitted.after).toBe("inconclusive")
  expect(omitted.satisfies).toBe(false)
  const result = probe.termless?.(headlessContext(inertModel()))
  expect(result?.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "parser-state",
  })
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
  const inert = await regradeRow(probe, row, { headless: headlessContext(displaced) })
  expect(inert.after).toBe("inconclusive")
  expect(inert.satisfies).toBe(false)
})
