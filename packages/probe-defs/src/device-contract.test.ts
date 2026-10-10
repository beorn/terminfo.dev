/**
 * @failure A Device capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so a group step reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28450 slice B Device group (19 definitions); 28453 harness. Outside Candidate-2 denominator 125.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/device-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/device-observations.test.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { deviceProbes } from "./device.ts"
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

/** The 19 Device capabilities of 28450 slice B; ids drawn from device.ts, claims are the contract. */
const DEVICE_CONTRACT: GroupContract = [
  { id: "device.primary-da", expected: "decided", claim: "DA1 CSI c returns complete CSI ? numeric attributes c" },
  { id: "device.status-report", expected: "decided", claim: "DSR 5 returns status 0 (ready) or 3 (malfunction)" },
  { id: "device.secondary-da", expected: "decided", claim: "DA2 CSI >c returns three numeric fields c" },
  {
    id: "device.tertiary-da",
    expected: "decided",
    claim: "DECRPTUI DCS !| returns four hexadecimal pairs and ST",
  },
  { id: "device.decrqss", expected: "decided", claim: "DECRQSS SGR returns status 1 parameters ending m and ST" },
  {
    id: "device.xtgettcap",
    expected: "decided",
    claim: "XTGETTCAP status 1 for TN returns an even-length hex value and ST",
  },
  { id: "device.decrpm", expected: "decided", claim: "DECRPM for DECAWM mode 7 returns recognized state 1–4" },
  { id: "device.xtversion", expected: "decided", claim: "XTVERSION DCS >| returns a printable name/version and ST" },
  {
    id: "device.term-features",
    expected: "inconclusive",
    claim: "TERM_FEATURES is inherited process environment and does not authenticate the current terminal",
  },
  {
    id: "device.dsr-996-color-scheme",
    expected: "decided",
    claim: "DSR ?996 yields complete DSR ?997;1n or ?997;2n",
  },
  {
    id: "device.xtwinops-14",
    expected: "decided",
    claim: "CSI 14 t returns a complete CSI 4;positive-height;positive-width t frame",
  },
  {
    id: "device.xtwinops-16",
    expected: "decided",
    claim: "CSI 16 t returns a complete CSI 6;positive-height;positive-width t frame",
  },
  {
    id: "device.xtwinops-18",
    expected: "decided",
    claim: "CSI 18 t returns a complete CSI 8;positive-rows;positive-columns t frame",
  },
  {
    id: "device.xtwinops-20",
    expected: "decided",
    claim: "OSC 1 + CSI 20 t round trip returns the exact icon label",
  },
  {
    id: "device.xtwinops-21",
    expected: "decided",
    claim: "CSI 21 t returns the exact window title set by OSC 2",
  },
  {
    id: "device.xtwinops-22",
    expected: "decided",
    claim: "XTWINOPS 22 preserves the old title on its stack after a different title is set",
  },
  {
    id: "device.xtwinops-23",
    expected: "decided",
    claim: "XTWINOPS 23 restores the title saved before a different title was set",
  },
  { id: "device.xtreportcolors", expected: "decided", claim: "CSI # R returns a complete CSI Pm # Q frame" },
  {
    id: "device.xtgetxres",
    expected: "decided",
    claim: "XTGETXRES returns a complete status-1 termName resource value",
  },
]

const DEVICE_CONTRACT_SPEC: GroupContractSpec = {
  group: "device",
  rows: DEVICE_CONTRACT,
  tests: ["packages/probe-defs/src/device-contract.test.ts", "packages/probe-defs/src/device-observations.test.ts"],
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

/** Query → a complete valid frame. Satisfaction binding, not a claim a real terminal emits it. */
const DEVICE_REPLIES: Readonly<Record<string, string>> = {
  "\x1b[c": "\x1b[?62;52;c",
  "\x1b[5n": "\x1b[0n",
  "\x1b[>c": "\x1b[>0;49;1c",
  "\x1b[=c": "\x1bP!|1234ABCD\x1b\\",
  "\x1bP$qm\x1b\\": "\x1bP1$r0m\x1b\\",
  "\x1bP+q544e\x1b\\": "\x1bP1+r544e=787465726d\x1b\\",
  "\x1b[?7$p": "\x1b[?7;1$y",
  "\x1b[>0q": "\x1bP>|kitty(0.49.1)\x1b\\",
  "\x1b[?996n": "\x1b[?997;1n",
  "\x1b[14t": "\x1b[4;720;1280t",
  "\x1b[16t": "\x1b[6;16;8t",
  "\x1b[18t": "\x1b[8;24;80t",
  "\x1b[20t": "\x1b]Ltest-icon\x07",
  "\x1b[21t": "\x1b]ltest-title\x07",
  "\x1b[#R": "\x1b[0;1#Q",
  "\x1bP+Q7465726d4e616d65\x1b\\": "\x1bP1+R7465726d4e616d65=787465726d\x1b\\",
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
 * One headless device that answers each query with its contract frame and tracks the title stack
 * XTWINOPS 22/23 measure. This is the satisfaction binding, not a claim a real terminal emits it.
 */
function echoingDevice(cols = 80): HeadlessModel {
  let title = ""
  const stack: string[] = []
  return {
    cols,
    feed: (text) => {
      if (text.startsWith("\x1b]2;")) {
        title = text
          .slice("\x1b]2;".length)
          .replace(/\x07$/u, "")
          .replace(/\x1b\\$/u, "")
        return
      }
      if (text === "\x1b[22;0t") {
        stack.push(title)
        return
      }
      if (text === "\x1b[23;0t") {
        const restored = stack.pop()
        if (restored !== undefined) title = restored
      }
    },
    getCell: () => ({ ...INERT_CELL }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    getTitle: () => title,
    feedCapture: (text) => DEVICE_REPLIES[text] ?? "",
  }
}

function deviceContexts(model: HeadlessModel) {
  return { headless: headlessContext(model), term: replayContext(new Map()) }
}

test("the Device contract covers every Device capability and names none unknown", () => {
  const gaps = contractGaps(deviceProbes, DEVICE_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(deviceProbes).toHaveLength(19)
  expect(DEVICE_CONTRACT).toHaveLength(19)
})

test("the Device contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(DEVICE_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(DEVICE_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of DEVICE_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

test("the harness replays every Device capability deterministically through the echoing fixture", async () => {
  for (const row of DEVICE_CONTRACT) {
    const probe = deviceProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing Device probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.termless !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, deviceContexts(echoingDevice()))
    const second = await regradeRow(probe, row, deviceContexts(echoingDevice()))
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

test("every Device contract row is satisfied by the echoing fixture its claim requires", async () => {
  for (const row of DEVICE_CONTRACT) {
    const probe = deviceProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing Device probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, deviceContexts(echoingDevice()))
    expect(graded.satisfies, `${row.id} satisfies its contract row (after=${graded.after})`).toBe(true)
  }
})

test("a decided Device row is unsatisfied when the query reply is silent", async () => {
  const row = DEVICE_CONTRACT.find((entry) => entry.id === "device.primary-da")
  const probe = deviceProbes.find((entry) => entry.id === "device.primary-da")
  expect(row, "the Device contract names device.primary-da").toBeDefined()
  expect(probe, "the Device contract names a real device.primary-da probe").toBeDefined()
  if (!row || !probe) return
  const silent = await regradeRow(probe, row, deviceContexts(inertModel()))
  expect(silent.after).toBe("inconclusive")
  expect(silent.satisfies).toBe(false)
})
