/**
 * @failure An input capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so input protocol steps reinvent their own fixture and silently drift.
 * @level l2
 * @consumer 28449 probe definitions slice A: input protocols.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/input-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/input-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/input-xtest-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/probe-automation.test.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { inputProbes } from "./input.ts"
import type { TermContext, TermlessContext } from "./types.ts"
import {
  contractGaps,
  headlessContext,
  missingContractTests,
  regradeCommand,
  regradeRow,
  replayContext,
  satisfiesContract,
  type GroupContract,
  type GroupContractSpec,
  type HeadlessModel,
} from "./testing/group-harness.ts"

/**
 * The 11 input protocol capabilities (10 defined in input.ts + 1 catalog-only in features.json).
 * input.modify-other-keys grades through OS XTEST after CSI >4;2m (ctrl+i vs Tab);
 * input.modify-other-keys-3 grades unmodified i after CSI >4;3m with delivery control before enable;
 * input.csi-u negotiates Kitty keyboard protocol flag 1;
 * remaining catalog mouse event probes stay inconclusive pending their regrade;
 * input.xtest-key, input.xtest-click, and input.xtest-wheel execute OS-level injection with same-run delivery control.
 */
const INPUT_CONTRACT: GroupContract = [
  {
    id: "input.modify-other-keys",
    expected: "decided",
    claim:
      "modifyOtherKeys: CSI >4;2m then ctrl+i reports CSI 27;5;105~ or 105;5u after plain-a delivery control; Tab is unsupported",
  },
  { id: "input.csi-u", expected: "decided", claim: "CSI u: Kitty keyboard protocol flag 1 enables disambiguate mode" },
  {
    id: "input.pixel-mouse",
    expected: "inconclusive",
    claim: "pixel-mouse: SGR pixel mouse mode 1016 requires generated mouse events",
  },
  {
    id: "input.urxvt-mouse",
    expected: "inconclusive",
    claim: "urxvt-mouse: rxvt mouse mode 1015 requires generated mouse events",
  },
  {
    id: "input.x10-mouse",
    expected: "inconclusive",
    claim: "x10-mouse: X10 mouse mode 9 requires generated mouse events",
  },
  {
    id: "input.modify-other-keys-3",
    expected: "decided",
    claim:
      "modifyOtherKeys-3: CSI >4;3m then unmodified i reports CSI 27;1;105~ or 105;1u after plain-a delivery control before enable; bare i is unsupported",
  },
  {
    id: "input.button-event-mouse",
    expected: "inconclusive",
    claim: "button-event-mouse: mode 1002 requires generated mouse events",
  },
  {
    id: "input.xtest-key",
    expected: "decided",
    claim: "xtest-key: OS XTEST ctrl+a report after plain-a delivery control",
  },
  {
    id: "input.xtest-click",
    expected: "decided",
    claim: "xtest-click: OS XTEST button-1 report under 1000+1006 after same-run control click",
  },
  {
    id: "input.xtest-wheel",
    expected: "decided",
    claim: "xtest-wheel: OS XTEST wheel-4 report under 1000+1006 after same-run control click",
  },
  {
    id: "input.kitty-click-events",
    expected: "not-tested",
    claim: "kitty-click-events: catalog-only capability with no probe definition in suite",
  },
]

/** The named set 28454 reviews: Input's rows plus the focused test files that bind them. */
const INPUT_CONTRACT_SPEC: GroupContractSpec = {
  group: "input",
  rows: INPUT_CONTRACT,
  tests: [
    "packages/probe-defs/src/input-contract.test.ts",
    "packages/probe-defs/src/input-observations.test.ts",
    "packages/probe-defs/src/input-xtest-observations.test.ts",
    "packages/probe-defs/src/probe-automation.test.ts",
  ],
  namedUnavailable: [
    {
      id: "input.kitty-click-events",
      reason: "no-semantic-observable",
      noObservable: "catalog capability has no probe definition in frozen suite",
    },
  ],
}

function inputModel(csiUAnswered = false): HeadlessModel {
  return {
    cols: 80,
    feed: () => {},
    feedCapture: () => (csiUAnswered ? "\x1b[?1u\x1b[?1;0c\x1b[?1u" : ""),
    getCell: () => ({
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
    }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
  }
}

function inputSatisfactionContext(id: string): { readonly headless?: TermlessContext; readonly term?: TermContext } {
  if (id === "input.modify-other-keys") {
    return {
      term: replayContext(new Map(), {
        input: { injectKey: async () => {}, injectClick: async () => {} },
        readInput: async (pattern) => {
          if (pattern.test("a")) return ["a"]
          if (pattern.test("\x1b[27;5;105~")) return ["\x1b[27;5;105~"]
          return null
        },
      }),
    }
  }
  if (id === "input.modify-other-keys-3") {
    return {
      term: replayContext(new Map(), {
        input: { injectKey: async () => {}, injectClick: async () => {} },
        readInput: async (pattern) => {
          if (pattern.test("a")) return ["a"]
          if (pattern.test("\x1b[27;1;105~")) return ["\x1b[27;1;105~"]
          return null
        },
      }),
    }
  }
  if (id === "input.xtest-key") {
    return {
      term: replayContext(new Map(), {
        input: { injectKey: async () => {}, injectClick: async () => {} },
        readInput: async (pattern) => {
          if (pattern.test("a")) return ["a"]
          if (pattern.test("\x01")) return ["\x01"]
          return null
        },
      }),
    }
  }
  if (id === "input.xtest-click") {
    return {
      term: replayContext(new Map(), {
        input: { injectKey: async () => {}, injectClick: async () => {} },
        readInput: async (pattern) => {
          if (pattern.test("\x1b[<0;1;1M")) return ["\x1b[<0;1;1M"]
          return null
        },
      }),
    }
  }
  if (id === "input.xtest-wheel") {
    let callCount = 0
    return {
      term: replayContext(new Map(), {
        input: { injectKey: async () => {}, injectClick: async () => {} },
        readInput: async (pattern) => {
          callCount++
          if (callCount === 1) return ["\x1b[<0;10;10M"]
          return ["\x1b[<64;10;10M"]
        },
      }),
    }
  }
  return { headless: headlessContext(inputModel(true)) }
}

test("the input contract covers every input capability and names none unknown", () => {
  const gaps = contractGaps(inputProbes, INPUT_CONTRACT, INPUT_CONTRACT_SPEC.namedUnavailable)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(inputProbes).toHaveLength(10)
  expect(INPUT_CONTRACT).toHaveLength(11)
})

test("the input contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(INPUT_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(INPUT_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of INPUT_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

test("the harness replays every input capability deterministically", async () => {
  for (const row of INPUT_CONTRACT) {
    if (row.id === "input.kitty-click-events") continue
    const probe = inputProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing input probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.termless !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const context = inputSatisfactionContext(row.id)
    const first = await regradeRow(probe, row, context)
    const second = await regradeRow(probe, row, context)
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

test("every defined input contract row is satisfied by the harness context its claim requires", async () => {
  for (const row of INPUT_CONTRACT) {
    if (row.id === "input.kitty-click-events") continue
    const probe = inputProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing input probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const context = inputSatisfactionContext(row.id)
    const graded = await regradeRow(probe, row, context)
    expect(graded.satisfies, `${row.id} satisfies its contract row (after=${graded.after})`).toBe(true)
  }
})

test("input.csi-u reads unsatisfied when protocol query is unacknowledged", async () => {
  const row = INPUT_CONTRACT.find((entry) => entry.id === "input.csi-u")
  const probe = inputProbes.find((entry) => entry.id === "input.csi-u")
  expect(row).toBeDefined()
  expect(probe).toBeDefined()
  if (!row || !probe) return
  const silent = await regradeRow(probe, row, { headless: headlessContext(inputModel(false)) })
  expect(silent.after).toBe("inconclusive")
  expect(silent.satisfies).toBe(false)
})

test("input.xtest-key reads unsatisfied when delivery control fails", async () => {
  const row = INPUT_CONTRACT.find((entry) => entry.id === "input.xtest-key")
  const probe = inputProbes.find((entry) => entry.id === "input.xtest-key")
  expect(row).toBeDefined()
  expect(probe).toBeDefined()
  if (!row || !probe) return
  const failingContext = {
    term: replayContext(new Map(), {
      input: { injectKey: async () => {}, injectClick: async () => {} },
      readInput: async () => null,
    }),
  }
  await expect(regradeRow(probe, row, failingContext)).rejects.toThrow(/delivery control/i)
})

test("input.modify-other-keys reads unsatisfied when delivery control fails", async () => {
  const row = INPUT_CONTRACT.find((entry) => entry.id === "input.modify-other-keys")
  const probe = inputProbes.find((entry) => entry.id === "input.modify-other-keys")
  expect(row).toBeDefined()
  expect(probe).toBeDefined()
  if (!row || !probe) return
  const failingContext = {
    term: replayContext(new Map(), {
      input: { injectKey: async () => {}, injectClick: async () => {} },
      readInput: async () => null,
    }),
  }
  await expect(regradeRow(probe, row, failingContext)).rejects.toThrow(/delivery control|plain a/i)
})

test("input.modify-other-keys-3 reads unsatisfied when delivery control fails", async () => {
  const row = INPUT_CONTRACT.find((entry) => entry.id === "input.modify-other-keys-3")
  const probe = inputProbes.find((entry) => entry.id === "input.modify-other-keys-3")
  expect(row).toBeDefined()
  expect(probe).toBeDefined()
  if (!row || !probe) return
  const failingContext = {
    term: replayContext(new Map(), {
      input: { injectKey: async () => {}, injectClick: async () => {} },
      readInput: async () => null,
    }),
  }
  await expect(regradeRow(probe, row, failingContext)).rejects.toThrow(/delivery control|plain a/i)
})
