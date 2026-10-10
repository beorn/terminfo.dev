/**
 * @failure A Modes capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so a group step reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28450 slice B Modes group (29 definitions); 28453 harness. Outside Candidate-2 denominator 125.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/modes-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/modes-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/modes-geometry.test.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { modesProbes } from "./modes.ts"
import {
  contractGaps,
  missingContractTests,
  regradeCommand,
  regradeRow,
  replayContext,
  satisfiesContract,
  type GroupContract,
  type GroupContractSpec,
} from "./testing/group-harness.ts"

/** The 29 Modes capabilities of 28450 slice B; ids drawn from modes.ts, claims are the contract. */
const MODES_CONTRACT: GroupContract = [
  { id: "modes.alt-screen.enter", expected: "decided", claim: "DECRPM 1049 recognizes alt-screen enter" },
  {
    id: "modes.alt-screen.exit",
    expected: "inconclusive",
    claim: "Alt-screen exit buffer restore needs pixel review; CPR after exit does not measure the buffer",
  },
  { id: "modes.bracketed-paste", expected: "decided", claim: "DECRPM 2004 recognizes bracketed paste" },
  { id: "modes.application-cursor", expected: "decided", claim: "DECRPM 1 recognizes application cursor keys" },
  { id: "modes.auto-wrap", expected: "decided", claim: "DECRPM 7 recognizes auto-wrap" },
  { id: "modes.mouse-tracking", expected: "decided", claim: "DECRPM 1000 recognizes mouse tracking" },
  { id: "modes.focus-tracking", expected: "decided", claim: "DECRPM 1004 recognizes focus tracking" },
  { id: "modes.reverse-video", expected: "decided", claim: "DECRPM 5 recognizes reverse video" },
  { id: "modes.synchronized-output", expected: "decided", claim: "DECRPM 2026 recognizes synchronized output" },
  { id: "modes.origin", expected: "decided", claim: "DECRPM 6 recognizes origin mode" },
  {
    id: "modes.insert-replace",
    expected: "inconclusive",
    claim: "Insert/replace mode needs a measured cell-shift fixture, not DECRPM alone",
  },
  { id: "modes.mouse-sgr", expected: "decided", claim: "DECRPM 1006 recognizes SGR mouse" },
  { id: "modes.mouse-all", expected: "decided", claim: "DECRPM 1003 recognizes all-motion mouse" },
  {
    id: "modes.application-keypad",
    expected: "decided",
    claim: "Application keypad: ESC = then KP_5 reports SS3 u after plain-a delivery control; bare 5 is unsupported",
  },
  {
    id: "modes.left-right-margin",
    expected: "inconclusive",
    claim: "Left/right margin mode needs a measured geometry fixture",
  },
  {
    id: "modes.altscreen-47",
    expected: "inconclusive",
    claim: "Alt-screen 47 buffer restore needs pixel review",
  },
  {
    id: "modes.altscreen-1047",
    expected: "inconclusive",
    claim: "Alt-screen 1047 buffer restore needs pixel review",
  },
  {
    id: "modes.altscreen-1048",
    expected: "inconclusive",
    claim: "Alt-screen 1048 cursor save/restore needs pixel review",
  },
  {
    id: "modes.alt-scroll-1007",
    expected: "decided",
    claim:
      "Alt-scroll 1007: wheel-4 reports CSI A after 1000+1006 click delivery control on alt-screen; remaining SGR is unsupported",
  },
  { id: "modes.utf8-mouse-1005", expected: "decided", claim: "DECRPM 1005 recognizes UTF-8 mouse" },
  { id: "modes.deccolm", expected: "decided", claim: "DECRPM 3 recognizes 132-column mode" },
  { id: "modes.decsclm", expected: "decided", claim: "DECRPM 4 recognizes smooth-scroll mode" },
  { id: "modes.color-scheme-reporting", expected: "decided", claim: "DECRPM 2031 recognizes color-scheme reporting" },
  {
    id: "modes.xtpushsgr",
    expected: "inconclusive",
    claim: "XTPUSHSGR stack roundtrip needs independent pixel review of both attributes",
  },
  {
    id: "modes.xtpopsgr",
    expected: "inconclusive",
    claim: "XTPOPSGR stack roundtrip needs independent pixel review of both attributes",
  },
  {
    id: "modes.xtsave",
    expected: "inconclusive",
    claim: "XTSAVE wrap restore needs a measured overflow fixture",
  },
  {
    id: "modes.xtrestore",
    expected: "inconclusive",
    claim: "XTRESTORE wrap restore needs a measured overflow fixture",
  },
  {
    id: "modes.xtpushcolors",
    expected: "inconclusive",
    claim: "XTPUSHCOLORS roundtrip needs independent pixel review",
  },
  {
    id: "modes.xtpopcolors",
    expected: "inconclusive",
    claim: "XTPOPCOLORS roundtrip needs independent pixel review",
  },
]

const MODES_CONTRACT_SPEC: GroupContractSpec = {
  group: "modes",
  rows: MODES_CONTRACT,
  tests: [
    "packages/probe-defs/src/modes-contract.test.ts",
    "packages/probe-defs/src/modes-observations.test.ts",
    "packages/probe-defs/src/modes-geometry.test.ts",
    "packages/probe-defs/src/input-xtest-observations.test.ts",
  ],
}

function modeQueryContext(state: "set" | "reset" | "unknown" | null) {
  return replayContext(new Map(), { queryMode: async () => state })
}

function modesTermContext(id: string) {
  if (id === "modes.application-keypad") {
    return replayContext(new Map(), {
      input: { injectKey: async () => {}, injectClick: async () => {} },
      readInput: async (pattern: RegExp) => {
        if (pattern.test("a")) return ["a"]
        if (pattern.test("\x1bOu")) return ["\x1bOu"]
        return null
      },
    })
  }
  if (id === "modes.alt-scroll-1007") {
    let callCount = 0
    return replayContext(new Map(), {
      input: { injectKey: async () => {}, injectClick: async () => {} },
      readInput: async (pattern: RegExp) => {
        callCount += 1
        const report = callCount % 2 === 1 ? "\x1b[<0;10;5M" : "\x1b[A"
        if (pattern.test(report)) return [report]
        return null
      },
    })
  }
  return modeQueryContext("set")
}

test("the Modes contract covers every Modes capability and names none unknown", () => {
  const gaps = contractGaps(modesProbes, MODES_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(modesProbes).toHaveLength(29)
  expect(MODES_CONTRACT).toHaveLength(29)
})

test("the Modes contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(MODES_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(MODES_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of MODES_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

test("the harness replays every Modes capability deterministically through DECRPM replay", async () => {
  for (const row of MODES_CONTRACT) {
    const term = modesTermContext(row.id)
    const probe = modesProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing Modes probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.termless !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { term })
    const second = await regradeRow(probe, row, { term })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

test("every Modes contract row is satisfied by the DECRPM replay its claim requires", async () => {
  for (const row of MODES_CONTRACT) {
    const term = modesTermContext(row.id)
    const probe = modesProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing Modes probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { term })
    expect(graded.satisfies, `${row.id} satisfies its contract row (after=${graded.after})`).toBe(true)
  }
})

test("a decided Modes row is unsatisfied when DECRPM is silent", async () => {
  const row = MODES_CONTRACT.find((entry) => entry.id === "modes.auto-wrap")
  const probe = modesProbes.find((entry) => entry.id === "modes.auto-wrap")
  expect(row, "the Modes contract names modes.auto-wrap").toBeDefined()
  expect(probe, "the Modes contract names a real modes.auto-wrap probe").toBeDefined()
  if (!row || !probe) return
  const silent = await regradeRow(probe, row, { term: modeQueryContext(null) })
  expect(silent.after).toBe("inconclusive")
  expect(silent.satisfies).toBe(false)
})
