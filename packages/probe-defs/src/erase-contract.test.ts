/**
 * @failure An Erase capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so the Erase group reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 Erase group (child 28023); the 28453 harness's second adopter.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/erase-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/erase-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/group-harness.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { eraseProbes } from "./erase.ts"
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

/** The 11 Erase capabilities of 28018's Erase row; ids drawn from erase.ts, claims are the contract. */
const ERASE_CONTRACT: GroupContract = [
  { id: "erase.line.right", expected: "decided", claim: "EL0 erases from the cursor to the end of the line" },
  { id: "erase.line.left", expected: "decided", claim: "EL1 erases from the line start through the cursor" },
  { id: "erase.line.all", expected: "decided", claim: "EL2 erases the whole line and preserves the adjacent row" },
  { id: "erase.screen.below", expected: "decided", claim: "ED0 erases from the cursor to the end of the screen" },
  { id: "erase.screen.above", expected: "decided", claim: "ED1 erases from the screen start through the cursor" },
  { id: "erase.screen.all", expected: "decided", claim: "ED2 erases the whole screen" },
  {
    id: "erase.screen.scrollback",
    expected: "decided",
    claim: "ED3 removes measured scrollback and keeps screen geometry",
  },
  { id: "erase.character", expected: "decided", claim: "ECH erases the requested cells from the cursor" },
  {
    id: "erase.selective",
    expected: "decided",
    claim: "Selective erase clears unprotected cells and keeps the DECSCA-protected cell",
  },
  {
    id: "erase.el-with-attrs",
    expected: "decided",
    claim: "EL keeps the erased cells' measured non-default background",
  },
  {
    id: "erase.ed-scroll-region",
    expected: "decided",
    claim: "ED0 erases below the cursor and preserves the preceding row, inside a scroll region",
  },
]

/** The named set 28454 reviews: Erase's rows plus the focused test files that bind them (no glob). */
const ERASE_CONTRACT_SPEC: GroupContractSpec = {
  group: "erase",
  rows: ERASE_CONTRACT,
  tests: ["packages/probe-defs/src/erase-contract.test.ts", "packages/probe-defs/src/erase-observations.test.ts"],
}

type Rgb = { readonly r: number; readonly g: number; readonly b: number }

/** The standard SGR 40-47 background table, enough for SGR 42 (green) and SGR 0 (reset). */
const STANDARD_BG: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 170, g: 0, b: 0 },
  { r: 0, g: 170, b: 0 },
  { r: 170, g: 85, b: 0 },
  { r: 0, g: 0, b: 170 },
  { r: 170, g: 0, b: 170 },
  { r: 0, g: 170, b: 170 },
  { r: 170, g: 170, b: 170 },
]

interface SurfaceCell {
  char: string
  bg: Rgb | null
  decscaProtected: boolean
}

function blankCell(bg: Rgb | null): SurfaceCell {
  return { char: " ", bg, decscaProtected: false }
}

/**
 * A semantic headless surface: the erase operations these probes exercise, implemented for real, so a
 * probe reads "supported" only when its own expectation agrees with a terminal that actually erases.
 * This is the Erase analogue of the SGR group's cell table (@dev/10 2026-10-09: a decided row bound to
 * a state its claim does not require is a false positive, so each row is driven by its own fixture).
 *
 * `mutations` injects one named fault so the negative control can prove the binding is not a rubber
 * stamp: "el-noop" makes EL inert, which must make the EL rows read "unsupported".
 */
function eraseSurface(options: { cols?: number; rows?: number; mutations?: readonly string[] } = {}): HeadlessModel {
  const cols = options.cols ?? 80
  const rows = options.rows ?? 24
  const mutations = new Set(options.mutations ?? [])
  let grid: SurfaceCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => blankCell(null)))
  let x = 0
  let y = 0
  let regionTop = 0
  let regionBottom = rows - 1
  let scrolled = 0
  let bg: Rgb | null = null
  let protecting = false

  const cellAt = (row: number, col: number): SurfaceCell => grid[row]?.[col] ?? blankCell(null)
  const clampCol = (col: number): number => (col < 0 ? 0 : col > cols - 1 ? cols - 1 : col)

  const put = (cell: SurfaceCell): void => {
    if (x >= cols) {
      x = 0
      lineFeed()
    }
    const target = grid[y]
    if (target) target[x] = cell
    x += 1
  }

  const lineFeed = (): void => {
    if (mutations.has("lf-noop")) return
    if (y >= regionBottom) {
      grid.splice(regionTop, 1)
      grid.splice(
        regionBottom,
        0,
        Array.from({ length: cols }, () => blankCell(null)),
      )
      scrolled += 1
      return
    }
    y += 1
  }

  const eraseLine = (mode: number): void => {
    const row = grid[y]
    if (!row) return
    const from = mode === 1 ? 0 : mode === 2 ? 0 : x
    const to = mode === 1 ? x : cols - 1
    for (let col = from; col <= to && col < cols; col++) {
      const existing = row[col] ?? blankCell(null)
      row[col] = {
        char: " ",
        bg,
        decscaProtected: existing.decscaProtected && mode === 2 ? false : existing.decscaProtected,
      }
    }
  }

  const eraseDisplay = (mode: number): void => {
    if (mode === 3) {
      scrolled = 0
      return
    }
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const inside =
          mode === 0 ? row > y || (row === y && col >= x) : mode === 1 ? row < y || (row === y && col <= x) : true
        if (inside) grid[row]![col] = blankCell(bg)
      }
    }
  }

  /** Selective erase (DECSED/DECSEL) skips every DECSCA-protected cell. */
  const selectiveErase = (): void => {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = cellAt(row, col)
        if (!cell.decscaProtected) grid[row]![col] = blankCell(bg)
      }
    }
  }

  const eraseChars = (count: number): void => {
    const row = grid[y]
    if (!row) return
    for (let i = 0; i < count && x + i < cols; i++) row[x + i] = blankCell(bg)
  }

  const applySgr = (params: readonly number[]): void => {
    const codes = params.length === 0 ? [0] : params
    for (const code of codes) {
      if (code === 0) {
        bg = null
        continue
      }
      if (code >= 40 && code <= 47) {
        bg = STANDARD_BG[code - 40] ?? null
        continue
      }
    }
  }

  const csi = (prefix: string, paramsRaw: string, intermediate: string, final: string): void => {
    const params = paramsRaw === "" ? [] : paramsRaw.split(";").map((raw) => (raw === "" ? 0 : Number(raw)))
    const first = params[0] ?? 0
    if (intermediate === '"' && final === "q") {
      protecting = first !== 0
      return
    }
    if (prefix === "?") {
      if (final === "J") selectiveErase()
      return
    }
    switch (final) {
      case "H":
      case "f":
        y = clampCol((params[0] ?? 1) - 1)
        x = clampCol((params[1] ?? 1) - 1)
        return
      case "G":
        x = clampCol((params[0] ?? 1) - 1)
        return
      case "K":
        if (!mutations.has("el-noop")) eraseLine(first)
        return
      case "J":
        eraseDisplay(first)
        return
      case "X":
        eraseChars(params[0] ?? 1)
        return
      case "r":
        regionTop = clampCol((params[0] ?? 1) - 1)
        regionBottom = clampCol((params[1] ?? rows) - 1)
        return
      case "m":
        applySgr(params)
        return
      default:
        return
    }
  }

  return {
    cols,
    feed(text: string): void {
      let i = 0
      while (i < text.length) {
        const ch = text[i]
        if (ch === "\x1b") {
          const match = /^\x1b\[([?]?)([0-9;]*)("?)([A-Za-z])/u.exec(text.slice(i))
          if (match) {
            csi(match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? "")
            i += match[0].length
            continue
          }
          i += 1
          continue
        }
        if (ch === "\r") {
          x = 0
          i += 1
          continue
        }
        if (ch === "\n") {
          lineFeed()
          i += 1
          continue
        }
        put({ char: ch ?? " ", bg, decscaProtected: protecting })
        i += 1
      }
    },
    getCell(row: number, col: number) {
      const cell = cellAt(row, col)
      return {
        char: cell.char,
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
        bg: cell.bg,
        wide: false,
      }
    },
    getCursor() {
      return { x, y, visible: true, style: null }
    },
    getScrollback() {
      return { viewportOffset: 0, totalLines: rows + scrolled, screenLines: rows }
    },
  }
}

test("the Erase contract covers every erase capability and names none unknown", () => {
  const gaps = contractGaps(eraseProbes, ERASE_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(eraseProbes).toHaveLength(11)
  expect(ERASE_CONTRACT).toHaveLength(11)
})

test("the Erase contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(ERASE_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(ERASE_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of ERASE_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only: the surface is fed the same fixture twice, so this proves the harness replays
// without movement, NOT that a decided row is satisfied. The satisfaction binding is the table below.
test("the harness replays every erase capability deterministically", async () => {
  for (const row of ERASE_CONTRACT) {
    const probe = eraseProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing erase probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.termless !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { headless: headlessContext(eraseSurface()) })
    const second = await regradeRow(probe, row, { headless: headlessContext(eraseSurface()) })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

// The bound satisfaction proof: each decided row reads "supported" against a surface that really
// implements the operation its claim names. Every row is driven by the probe's own fixture, so a probe
// whose expectation table disagrees with the terminal cannot pass this test.
test("every erase contract row reads supported against a surface that implements its claim", async () => {
  for (const row of ERASE_CONTRACT) {
    const probe = eraseProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing erase probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { headless: headlessContext(eraseSurface()) })
    expect(graded.after, `${row.id} reads supported from a surface implementing its claim`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
})

// One negative control: the surface stops erasing the line, so the EL rows must read "unsupported".
// A decided row cannot show this through `satisfies` (a decided row accepts either pass or fail), so
// the observation itself is asserted. This is what makes the table above a measurement, not a stamp.
test("an EL that does not erase reads unsupported", async () => {
  const elRows = ["erase.line.right", "erase.line.left", "erase.line.all", "erase.el-with-attrs"]
  for (const id of elRows) {
    const row = ERASE_CONTRACT.find((entry) => entry.id === id)
    const probe = eraseProbes.find((entry) => entry.id === id)
    expect(row, `the Erase contract names ${id}`).toBeDefined()
    expect(probe, `the Erase contract names a real ${id} probe`).toBeDefined()
    if (!row || !probe) continue
    const graded = await regradeRow(probe, row, { headless: headlessContext(eraseSurface({ mutations: ["el-noop"] })) })
    expect(graded.after, `${id} detects an inert EL`).toBe("unsupported")
  }
})
