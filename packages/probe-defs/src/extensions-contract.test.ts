/**
 * @failure An extension capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so extension probe steps reinvent their own fixture and silently drift.
 * @level l2
 * @consumer 28449 probe definitions slice A: extension protocols.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/extensions-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/probe-automation.test.ts vendor/terminfo.dev/packages/probe-defs/src/not-tested-coverage.test.ts vendor/terminfo.dev/packages/probe-defs/src/clipboard-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/extensions-capture-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/extensions-geometry.test.ts vendor/terminfo.dev/packages/probe-defs/src/extensions-qualification.test.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { extensionsProbes } from "./extensions.ts"
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
 * The 79 extension capabilities (78 defined in extensions.ts + 1 catalog-only in features.json).
 * 41 protocol queries are decided in real terminal runs; 37 unasserted/state probes evaluate to
 * inconclusive pending external apparatus or capture; 1 catalog capability lacks a probe definition.
 */
const EXTENSIONS_CONTRACT: GroupContract = [
  { id: "extensions.truecolor", expected: "inconclusive", claim: "24-bit truecolor: ESC [ 38;2;R;G;B m" },
  { id: "extensions.kitty-keyboard", expected: "decided", claim: "Kitty keyboard protocol: ESC [ > flags u" },
  { id: "extensions.kitty-keyboard.disambiguate", expected: "decided", claim: "Kitty keyboard: DISAMBIGUATE (flag 1)" },
  {
    id: "extensions.kitty-keyboard.report-events",
    expected: "decided",
    claim: "Kitty keyboard: REPORT_EVENTS (flag 2)",
  },
  {
    id: "extensions.kitty-keyboard.report-alternate",
    expected: "decided",
    claim: "Kitty keyboard: REPORT_ALTERNATE (flag 4)",
  },
  {
    id: "extensions.kitty-keyboard.report-all-keys",
    expected: "decided",
    claim: "Kitty keyboard: REPORT_ALL_KEYS (flag 8)",
  },
  { id: "extensions.kitty-keyboard.report-text", expected: "decided", claim: "Kitty keyboard: REPORT_TEXT (flag 16)" },
  { id: "extensions.kitty-graphics", expected: "decided", claim: "Kitty graphics protocol" },
  { id: "extensions.kitty-graphics.transmit", expected: "decided", claim: "Kitty graphics: transmit" },
  { id: "extensions.kitty-graphics.display", expected: "decided", claim: "Kitty graphics: display" },
  { id: "extensions.kitty-graphics.animation", expected: "inconclusive", claim: "Kitty graphics: animation" },
  {
    id: "extensions.kitty-graphics.unicode-placeholders",
    expected: "inconclusive",
    claim: "Kitty graphics: Unicode placeholders",
  },
  { id: "extensions.sixel", expected: "inconclusive", claim: "Sixel graphics" },
  { id: "extensions.osc8", expected: "inconclusive", claim: "Hyperlinks (OSC 8): ESC ] 8 ; params ; uri BEL" },
  {
    id: "extensions.reflow",
    expected: "inconclusive",
    claim: "Text reflow on resize: (behavioral — resize the terminal)",
  },
  {
    id: "extensions.semantic-prompts",
    expected: "inconclusive",
    claim: "Semantic prompts (OSC 133): ESC ] 133 ; A BEL",
  },
  { id: "extensions.osc2-title", expected: "inconclusive", claim: "Window title (OSC 2): ESC ] 2 ; title BEL" },
  { id: "extensions.osc0-icon-title", expected: "inconclusive", claim: "Icon and title (OSC 0): ESC ] 0 ; title BEL" },
  {
    id: "extensions.osc52-clipboard",
    expected: "decided",
    claim: "Clipboard access (OSC 52): ESC ] 52 ; c ; base64 BEL",
  },
  { id: "extensions.osc52-write", expected: "decided", claim: "OSC 52 clipboard write" },
  { id: "extensions.osc52-read", expected: "decided", claim: "OSC 52 clipboard read" },
  { id: "extensions.osc10-fg-color", expected: "decided", claim: "Foreground color query (OSC 10): ESC ] 10 ; ? BEL" },
  { id: "extensions.osc11-bg-color", expected: "decided", claim: "Background color query (OSC 11): ESC ] 11 ; ? BEL" },
  {
    id: "extensions.osc7-cwd",
    expected: "inconclusive",
    claim: "Current directory (OSC 7): ESC ] 7 ; file://host/path BEL",
  },
  {
    id: "extensions.osc-633-vscode",
    expected: "inconclusive",
    claim: "VS Code Shell Integration (OSC 633): ESC ] 633 ; A BEL",
  },
  {
    id: "extensions.osc133-a",
    expected: "inconclusive",
    claim: "OSC 133;A prompt start (FTCS_PROMPT): ESC ] 133 ; A BEL",
  },
  {
    id: "extensions.osc133-b",
    expected: "inconclusive",
    claim: "OSC 133;B command start (FTCS_COMMAND_START): ESC ] 133 ; B BEL",
  },
  {
    id: "extensions.osc133-c",
    expected: "inconclusive",
    claim: "OSC 133;C command executed (FTCS_COMMAND_EXECUTED): ESC ] 133 ; C BEL",
  },
  {
    id: "extensions.osc133-d",
    expected: "inconclusive",
    claim: "OSC 133;D command finished (FTCS_COMMAND_FINISHED): ESC ] 133 ; D ; exitcode BEL",
  },
  { id: "extensions.osc133-p", expected: "inconclusive", claim: "OSC 133;P properties: ESC ] 133 ; P ; key=value BEL" },
  { id: "extensions.osc633-a", expected: "inconclusive", claim: "OSC 633;A prompt start: ESC ] 633 ; A BEL" },
  { id: "extensions.osc633-b", expected: "inconclusive", claim: "OSC 633;B prompt end: ESC ] 633 ; B BEL" },
  { id: "extensions.osc633-c", expected: "inconclusive", claim: "OSC 633;C pre-execution: ESC ] 633 ; C BEL" },
  {
    id: "extensions.osc633-d",
    expected: "inconclusive",
    claim: "OSC 633;D command finished: ESC ] 633 ; D ; exitcode BEL",
  },
  {
    id: "extensions.osc633-e",
    expected: "inconclusive",
    claim: "OSC 633;E set commandline: ESC ] 633 ; E ; commandline ; nonce BEL",
  },
  { id: "extensions.osc633-p", expected: "inconclusive", claim: "OSC 633;P properties: ESC ] 633 ; P ; key=value BEL" },
  { id: "extensions.notifications", expected: "inconclusive", claim: "Desktop Notifications (OSC 9/777)" },
  { id: "extensions.iterm2-images", expected: "inconclusive", claim: "iTerm2 Inline Images (OSC 1337)" },
  { id: "extensions.osc1337-cellsize", expected: "decided", claim: "iTerm2 Cell Size Reporting (OSC 1337)" },
  { id: "extensions.osc1337-capabilities", expected: "decided", claim: "iTerm2 Capability Reporting (OSC 1337)" },
  { id: "extensions.osc9-progress", expected: "inconclusive", claim: "OSC 9;4 progress bar" },
  { id: "extensions.osc66-text-sizing", expected: "decided", claim: "OSC 66 text sizing" },
  { id: "extensions.osc5522-clipboard", expected: "decided", claim: "OSC 5522 advanced clipboard" },
  { id: "extensions.osc1-icon", expected: "inconclusive", claim: "Icon name (OSC 1): ESC ] 1 ; Pt BEL" },
  { id: "extensions.osc4-palette", expected: "decided", claim: "Color palette (OSC 4): ESC ] 4 ; c ; spec BEL" },
  { id: "extensions.osc5-special-color", expected: "decided", claim: "Special color (OSC 5): ESC ] 5 ; c ; spec BEL" },
  { id: "extensions.osc12-cursor-color", expected: "decided", claim: "Cursor color (OSC 12): ESC ] 12 ; color BEL" },
  {
    id: "extensions.osc104-reset-palette",
    expected: "decided",
    claim: "Reset color palette (OSC 104): ESC ] 104 ; c BEL",
  },
  { id: "extensions.osc110-reset-fg", expected: "decided", claim: "Reset foreground color (OSC 110): ESC ] 110 BEL" },
  { id: "extensions.osc111-reset-bg", expected: "decided", claim: "Reset background color (OSC 111): ESC ] 111 BEL" },
  { id: "extensions.osc112-reset-cursor", expected: "decided", claim: "Reset cursor color (OSC 112): ESC ] 112 BEL" },
  {
    id: "extensions.osc117-reset-highlight-bg",
    expected: "inconclusive",
    claim: "Reset highlight background (OSC 117): ESC ] 117 BEL",
  },
  {
    id: "extensions.osc119-reset-highlight-fg",
    expected: "inconclusive",
    claim: "Reset highlight foreground (OSC 119): ESC ] 119 BEL",
  },
  {
    id: "extensions.osc17-highlight-bg",
    expected: "decided",
    claim: "Highlight background (OSC 17): ESC ] 17 ; spec BEL",
  },
  {
    id: "extensions.osc19-highlight-fg",
    expected: "decided",
    claim: "Highlight foreground (OSC 19): ESC ] 19 ; spec BEL",
  },
  { id: "extensions.osc22-pointer", expected: "inconclusive", claim: "Pointer shape (OSC 22): ESC ] 22 ; shape BEL" },
  {
    id: "extensions.osc99-kitty-notify",
    expected: "decided",
    claim: "Desktop notifications (OSC 99): ESC ] 99 ; params BEL",
  },
  {
    id: "extensions.osc777-notify",
    expected: "inconclusive",
    claim: "Notifications (OSC 777): ESC ] 777 ; notify ; title ; body BEL",
  },
  {
    id: "extensions.osc666-termprop",
    expected: "inconclusive",
    claim: "VTE termprop (OSC 666): ESC ] 666 ; key=value BEL",
  },
  {
    id: "extensions.osc3008-context",
    expected: "inconclusive",
    claim: "Systemd context (OSC 3008): ESC ] 3008 ; params BEL",
  },
  {
    id: "extensions.osc113-reset-pointer-fg",
    expected: "decided",
    claim: "Reset pointer fg color (OSC 113): ESC ] 113 BEL",
  },
  {
    id: "extensions.osc114-reset-pointer-bg",
    expected: "decided",
    claim: "Reset pointer bg color (OSC 114): ESC ] 114 BEL",
  },
  {
    id: "extensions.osc21-kitty-color",
    expected: "decided",
    claim: "Kitty color protocol (OSC 21): ESC ] 21 ; key=value BEL",
  },
  {
    id: "extensions.osc30001-color-stack-push",
    expected: "decided",
    claim: "Kitty color stack push (OSC 30001): ESC ] 30001 BEL",
  },
  {
    id: "extensions.osc30101-color-stack-pop",
    expected: "decided",
    claim: "Kitty color stack pop (OSC 30101): ESC ] 30101 BEL",
  },
  {
    id: "extensions.osc176-app-id",
    expected: "inconclusive",
    claim: "Set Wayland app-id (OSC 176): ESC ] 176 ; app-id BEL",
  },
  { id: "extensions.osc555-flash", expected: "inconclusive", claim: "Screen flash (OSC 555): ESC ] 555 BEL" },
  { id: "extensions.osc440-audio", expected: "inconclusive", claim: "Audio sound (OSC 440): ESC ] 440 ; wavfile BEL" },
  {
    id: "extensions.osc7770-font-size",
    expected: "decided",
    claim: "Font size query/set (OSC 7770): ESC ] 7770 ; size BEL",
  },
  {
    id: "extensions.osc7777-font-window-size",
    expected: "decided",
    claim: "Font + window size (OSC 7777): ESC ] 7777 ; font ; size BEL",
  },
  { id: "extensions.osc701-locale", expected: "decided", claim: "Locale query/set (OSC 701): ESC ] 701 ; locale BEL" },
  { id: "extensions.osc702-version", expected: "decided", claim: "Version query (OSC 702): ESC ] 702 BEL" },
  {
    id: "extensions.osc710-font-normal",
    expected: "inconclusive",
    claim: "Set normal font (OSC 710): ESC ] 710 ; font BEL",
  },
  { id: "extensions.osc720-scroll-up", expected: "inconclusive", claim: "Scroll view up (OSC 720): ESC ] 720 BEL" },
  { id: "extensions.osc776-cell-size", expected: "decided", claim: "Cell size report (OSC 776): ESC ] 776 BEL" },
  { id: "extensions.sixel-da1", expected: "decided", claim: "Sixel support in DA1" },
  {
    id: "extensions.sixel-geometry-report",
    expected: "decided",
    claim: "Sixel geometry report (CSI ? Pi;Pa;Pv S): CSI ? Pi ; Pa ; Pv S",
  },
  {
    id: "extensions.clipboard-paste",
    expected: "decided",
    claim:
      "clipboard-paste: owned clipboard nonce then shift+Insert reports CSI 200~nonce201~ after plain-a delivery control and 2004; raw nonce is unsupported",
  },
  {
    id: "extensions.font-ligatures",
    expected: "not-tested",
    claim: "Font ligatures: catalog-only capability with no probe definition in suite",
  },
]

/** The named set 28454 reviews: Extensions rows plus the focused test files that bind them. */
const EXTENSIONS_CONTRACT_SPEC: GroupContractSpec = {
  group: "extensions",
  rows: EXTENSIONS_CONTRACT,
  tests: [
    "packages/probe-defs/src/extensions-contract.test.ts",
    "packages/probe-defs/src/probe-automation.test.ts",
    "packages/probe-defs/src/not-tested-coverage.test.ts",
    "packages/probe-defs/src/clipboard-observations.test.ts",
    "packages/probe-defs/src/extensions-capture-observations.test.ts",
    "packages/probe-defs/src/extensions-geometry.test.ts",
    "packages/probe-defs/src/extensions-qualification.test.ts",
  ],
  namedUnavailable: [
    {
      id: "extensions.font-ligatures",
      reason: "no-semantic-observable",
      noObservable: "catalog capability has no probe definition in frozen suite",
    },
  ],
}

function inertModel(): HeadlessModel {
  return {
    cols: 80,
    feed: () => {},
    feedCapture: () => "",
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

const DIRECT_QUERY_REPLIES: Record<string, string> = {
  "extensions.osc10-fg-color": "\x1b]10;rgb:ffff/0000/0000\x07",
  "extensions.osc11-bg-color": "\x1b]11;rgb:0000/ffff/0000\x07",
  "extensions.osc12-cursor-color": "\x1b]12;rgb:0000/0000/ffff\x07",
  "extensions.osc17-highlight-bg": "\x1b]17;rgb:ffff/ffff/0000\x07",
  "extensions.osc19-highlight-fg": "\x1b]19;rgb:ffff/0000/ffff\x07",
  "extensions.osc4-palette": "\x1b]4;0;rgb:ffff/0000/0000\x07",
  "extensions.osc5-special-color": "\x1b]5;0;rgb:ffff/0000/0000\x07",
  "extensions.osc1337-cellsize": "\x1b]1337;ReportCellSize=12;8\x07",
  "extensions.osc1337-capabilities": "\x1b]1337;Capabilities=alpha\x07",
  "extensions.osc7770-font-size": "\x1b]7770;14\x07",
  "extensions.osc7777-font-window-size": "\x1b]7777;14\x07",
  "extensions.osc701-locale": "\x1b]701;en_US.UTF-8\x07",
  "extensions.osc702-version": "\x1b]702;rxvt-1\x07",
  "extensions.osc776-cell-size": "\x1b]776;8;16;2\x07",
  "extensions.sixel-da1": "\x1b[?1;4c",
  "extensions.sixel-geometry-report": "\x1b[?2;0;800;528S",
}

const COLOR_RESET_CODES: Record<string, string> = {
  "extensions.osc104-reset-palette": "4;0",
  "extensions.osc110-reset-fg": "10",
  "extensions.osc111-reset-bg": "11",
  "extensions.osc112-reset-cursor": "12",
  "extensions.osc113-reset-pointer-fg": "13",
  "extensions.osc114-reset-pointer-bg": "14",
}

function decidedSatisfactionContext(id: string) {
  if (DIRECT_QUERY_REPLIES[id]) {
    return {
      headless: headlessContext({
        ...inertModel(),
        feedCapture: () => DIRECT_QUERY_REPLIES[id] ?? "",
      }),
    }
  }
  if (id.startsWith("extensions.kitty-keyboard")) {
    return {
      headless: headlessContext({
        ...inertModel(),
        feedCapture: () => "\x1b[?31u\x1b[?1;0c",
      }),
    }
  }
  if (id === "extensions.kitty-graphics") {
    return {
      headless: headlessContext({
        ...inertModel(),
        feedCapture: () => "\x1b_Gi=31;OK\x1b\\",
      }),
    }
  }
  if (id === "extensions.kitty-graphics.transmit" || id === "extensions.kitty-graphics.display") {
    return {
      headless: headlessContext({
        ...inertModel(),
        feedCapture: (seq) => {
          const num = /I=(\d+)/.exec(seq)?.[1] || "1"
          if (/a=p,i=2,/.test(seq)) return "\x1b_Gi=2;OK\x1b\\"
          return `\x1b_Gi=1,I=${num};OK\x1b\\`
        },
      }),
    }
  }
  if (id.startsWith("extensions.osc52-")) {
    let last = ""
    return {
      headless: headlessContext({
        ...inertModel(),
        feed: (text) => {
          last = text
        },
        feedCapture: () => last,
      }),
    }
  }
  if (id === "extensions.osc5522-clipboard") {
    return {
      headless: headlessContext({
        ...inertModel(),
        feedCapture: () => "\x1b[?5522;1$y",
      }),
    }
  }
  if (id === "extensions.osc21-kitty-color") {
    return {
      headless: headlessContext({
        ...inertModel(),
        feedCapture: () => "\x1b]21;foreground=rgb:ffff/ffff/ffff\x1b\\",
      }),
    }
  }
  if (COLOR_RESET_CODES[id]) {
    const code = COLOR_RESET_CODES[id]
    const color = (val: string) => `\x1b]${code};rgb:${val}\x07`
    const queue = [color("00/00/00"), color("aa/bb/cc"), color("00/00/00")]
    return {
      headless: headlessContext({
        ...inertModel(),
        feedCapture: () => queue.shift() ?? "",
      }),
    }
  }
  if (id === "extensions.osc30001-color-stack-push" || id === "extensions.osc30101-color-stack-pop") {
    let current = "rgb:1010/2020/3030"
    const stack: string[] = []
    return {
      headless: headlessContext({
        ...inertModel(),
        feed: (seq) => {
          if (seq.includes("]30001")) stack.push(current)
          else if (seq.includes("]30101")) current = stack.pop() ?? current
          else {
            const m = /\x1b\]10;(rgb:[a-f\d/]+)/i.exec(seq)
            if (m) current = m[1] ?? current
          }
        },
        feedCapture: () => `\x1b]10;${current}\x1b\\`,
      }),
    }
  }
  if (id === "extensions.osc66-text-sizing") {
    let step = 0
    return {
      headless: headlessContext({
        ...inertModel(),
        feed: () => {
          step++
        },
        getCursor: () => {
          if (step <= 1) return { x: 0, y: 0, visible: true, style: null }
          if (step === 2) return { x: 2, y: 0, visible: true, style: null }
          return { x: 4, y: 0, visible: true, style: null }
        },
      }),
    }
  }
  if (id === "extensions.osc99-kitty-notify") {
    return {
      term: replayContext(new Map(), {
        queryWithSentinelOutcome: async (query: string, pattern: RegExp) => {
          const nonce = /i=([^:]+):/.exec(query)?.[1]
          const raw = `\x1b]99;i=${nonce}:p=?;p=title\x1b\\`
          return {
            match: pattern.exec(raw),
            reason: "reply",
            raw,
            rawBase64: Buffer.from(raw).toString("base64"),
          }
        },
      }),
    }
  }
  if (id === "extensions.clipboard-paste") {
    let nonce = ""
    let callCount = 0
    return {
      term: replayContext(new Map(), {
        input: { injectKey: async () => {}, injectClick: async () => {} },
        withClipboardFixture: async (work) =>
          work({
            readText: async () => nonce,
            writeText: async (text) => {
              nonce = text
            },
          }),
        readInput: async (pattern: RegExp) => {
          callCount += 1
          const report = callCount % 2 === 1 ? "a" : `\x1b[200~${nonce}\x1b[201~`
          if (pattern.test(report)) return [report]
          return null
        },
      }),
    }
  }
  throw new Error(`No satisfaction context configured for decided row ${id}`)
}

test("the extensions contract covers every extension capability and names none unknown", () => {
  const gaps = contractGaps(extensionsProbes, EXTENSIONS_CONTRACT, EXTENSIONS_CONTRACT_SPEC.namedUnavailable)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(extensionsProbes).toHaveLength(78)
  expect(EXTENSIONS_CONTRACT).toHaveLength(79)
})

test("the extensions contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(EXTENSIONS_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(EXTENSIONS_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of EXTENSIONS_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

test("the harness replays every extension capability deterministically", async () => {
  const headless = headlessContext(inertModel())
  const term = replayContext(new Map(), {
    queryCursorPosition: async () => ({ row: 0, col: 0 }),
  })

  for (const row of EXTENSIONS_CONTRACT) {
    if (row.expected === "not-tested") continue
    const probe = extensionsProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing extension probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.termless !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { headless, term })
    const second = await regradeRow(probe, row, { headless, term })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

test("every decided extension contract row is satisfied by its required protocol response", async () => {
  const decidedRows = EXTENSIONS_CONTRACT.filter((row) => row.expected === "decided")
  expect(decidedRows).toHaveLength(41)

  for (const row of decidedRows) {
    const probe = extensionsProbes.find((p) => p.id === row.id)
    expect(probe, `missing probe for ${row.id}`).toBeDefined()
    if (!probe) continue
    const context = decidedSatisfactionContext(row.id)
    const graded = await regradeRow(probe, row, context)
    expect(graded.after, `${row.id} outcome must be supported when simulated reply arrives`).toBe("supported")
    expect(graded.satisfies, `${row.id} must satisfy contract`).toBe(true)
  }
})

test("every inconclusive extension contract row evaluates to inconclusive under unasserted harness context", async () => {
  const inconclusiveRows = EXTENSIONS_CONTRACT.filter((row) => row.expected === "inconclusive")
  expect(inconclusiveRows).toHaveLength(37)

  const term = replayContext(new Map(), {
    queryCursorPosition: async () => ({ row: 0, col: 0 }),
    write: () => {},
    capture: async () => ({ role: "control", label: "test", capturedAt: 1, ref: "sha256:0" }),
  })
  const headless = headlessContext(inertModel())

  for (const row of inconclusiveRows) {
    const probe = extensionsProbes.find((p) => p.id === row.id)
    expect(probe, `missing probe for ${row.id}`).toBeDefined()
    if (!probe) continue
    const context = probe.term ? { term } : { headless }
    const graded = await regradeRow(probe, row, context)
    expect(graded.after, `${row.id} outcome must be inconclusive`).toBe("inconclusive")
    expect(graded.satisfies, `${row.id} must satisfy inconclusive contract expectation`).toBe(true)
  }
})

test("a decided extension row reads unsatisfied when silent or unacknowledged", async () => {
  const probe = extensionsProbes.find((p) => p.id === "extensions.osc10-fg-color")
  const row = EXTENSIONS_CONTRACT.find((r) => r.id === "extensions.osc10-fg-color")
  expect(probe).toBeDefined()
  expect(row).toBeDefined()
  if (!probe || !row) return

  const silentContext = headlessContext(inertModel())
  const silent = await regradeRow(probe, row, { headless: silentContext })
  expect(silent.after).toBe("inconclusive")
  expect(silent.satisfies).toBe(false)
})

test("semantic observables omitted in headless mode return notTested without failing determinism", async () => {
  const omittedProbes = [
    "extensions.osc0-icon-title",
    "extensions.osc1-icon",
    "extensions.osc117-reset-highlight-bg",
    "extensions.osc119-reset-highlight-fg",
  ]
  const headless = headlessContext(inertModel())
  for (const id of omittedProbes) {
    const probe = extensionsProbes.find((p) => p.id === id)
    expect(probe).toBeDefined()
    if (!probe?.termless) continue
    const result = probe.termless(headless)
    expect(result.notTested).toBeDefined()
    expect(result.notTested?.reason).toBe("no-semantic-observable")
  }
})
