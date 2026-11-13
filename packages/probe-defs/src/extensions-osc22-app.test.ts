/**
 * @failure The App OSC22 arm substitutes CPR for selected-shape replies, decides without a
 *   same-path control, or loses the incoming shape during restoration.
 * @level l1
 * @consumer extensions.osc22-pointer App callback through the public asynchronous query source.
 * @testonly none
 */
import { expect, test } from "vitest"
import { isDeclaredUntestable } from "./helpers.ts"
import { extensionsProbes, OSC22_MUX_NO_RECORD, OSC22_SILENT_TERMINAL, osc22SilentMultiplexer } from "./extensions.ts"
import type { TerminalQueryOutcome, TermProbeSource } from "./types.ts"

type Fault =
  | "none"
  | "target-disabled"
  | "control-disabled"
  | "initial-silent"
  | "initial-sentinel"
  | "control-silent"
  | "target-malformed"
  | "target-other"
  | "restore-disabled"
  | "restore-silent"

function terminal(initial: string, fault: Fault = "none", terminator = "\x07") {
  let selected = initial
  let queryCount = 0
  const writes: string[] = []
  const replies: string[] = []
  const read = async (sequence: string, pattern: RegExp): Promise<TerminalQueryOutcome> => {
    if (sequence !== "\x1b]22;?__current__\x07") throw new Error(`Unexpected query ${JSON.stringify(sequence)}`)
    queryCount++
    let raw = `\x1b]22;${selected}${terminator}`
    let reason: TerminalQueryOutcome["reason"] = "reply"
    if (
      (queryCount === 1 && fault === "initial-silent") ||
      (queryCount === 2 && fault === "control-silent") ||
      (queryCount === 4 && fault === "restore-silent")
    ) {
      raw = ""
      reason = "timeout"
    }
    if (queryCount === 1 && fault === "initial-sentinel") {
      raw = "\x1b[?1;2c"
      reason = "sentinel"
    }
    if (queryCount === 3 && fault === "target-malformed") raw = "\x1b]22;pointer,wait\x07"
    replies.push(raw)
    return { match: pattern.exec(raw), reason, raw, rawBase64: Buffer.from(raw).toString("base64") }
  }
  const source: TermProbeSource = {
    kind: "live",
    cols: 80,
    rows: 24,
    write(sequence) {
      const shape = /^\x1b\]22;([a-z0-9_-]*)(?:\x07|\x1b\\)$/u.exec(sequence)?.[1]
      if (shape === undefined) return
      writes.push(sequence)
      if (fault === "target-disabled" && shape === "pointer") return
      if (fault === "control-disabled" && shape === "text") return
      if (fault === "restore-disabled" && shape === "") return
      if (fault === "target-other" && shape === "pointer") selected = "crosshair"
      else if (["", "text", "wait", "pointer"].includes(shape)) selected = shape === "" ? "0" : shape
    },
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }),
    query: async (sequence, pattern) => (await read(sequence, pattern)).match,
    queryWithSentinel: async (sequence, pattern) => (await read(sequence, pattern)).match,
    queryOutcome: read,
    queryWithSentinelOutcome: read,
    queryMode: async () => null,
  }
  return { source, writes, replies, selected: () => selected }
}

function definition() {
  const result = extensionsProbes.find((probe) => probe.id === "extensions.osc22-pointer")
  if (!result?.term) throw new Error("Missing OSC22 App callback")
  return result
}

// Existing native Library coverage cannot reach this asynchronous App source.
test.each([
  { initial: "0", terminator: "\x07" },
  { initial: "text", terminator: "\x1b\\" },
  { initial: "pointer", terminator: "\x07" },
  { initial: "wait", terminator: "\x1b\\" },
])("App pointer reports a controlled selected shape and restores $initial", async ({ initial, terminator }) => {
  const input = terminal(initial, "none", terminator)
  const result = await definition().term!(input.source)
  expect(result.observation?.outcome).toBe("supported")
  expect(result.observation?.assertionType).toBe("query_reply")
  expect(result.assertions?.[0]?.kind).toBe("positive")
  expect(result.note).toMatch(/selected shape.*visible pointer not read/iu)
  expect(input.selected()).toBe(initial)
  expect(input.replies).toContain(`\x1b]22;pointer${terminator}`)
})

test("a target-only no-op is Unsupported after a working control and restoration", async () => {
  const input = terminal("0", "target-disabled")
  const result = await definition().term!(input.source)
  expect(result.observation?.outcome).toBe("unsupported")
  expect(result.assertions?.[0]?.kind).toBe("negative")
  expect(result.observation?.assertionType).toBe("query_reply")
  expect(input.selected()).toBe("0")
})

test.each(["initial-silent", "initial-sentinel"] as const)(
  "no initial shape reply (%s) leaves the shape untouched and open",
  async (fault) => {
    const input = terminal("0", fault)
    const result = await definition().term!(input.source)
    expect(result.notTested?.reason).toBe("no-semantic-observable")
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(input.writes).toEqual([])
    expect(input.selected()).toBe("0")
  },
)

/**
 * @failure Alacritty, Ghostty, Screen and tmux all read open with one generic sentence that reads
 *   like a probe defect. @cto a7fb82cc (#33100): a terminal's silence on the query form is not
 *   Unsupported and the reason says so in the criterion's terms; a multiplexer is open by design
 *   because the pointer is the outer terminal's.
 * @level l1
 * @consumer extensions.osc22-pointer App callback on terminal and multiplexer subjects.
 * @testonly none
 */
test("a silent OSC 22 query says why it stays open, per subject kind", async () => {
  const term = await definition().term!(terminal("0", "initial-silent").source)
  expect(term.notTested?.noObservable).toBe(OSC22_SILENT_TERMINAL)
  expect(term.notTested?.noObservable).toContain("silence on the query form is not unsupported")
  for (const mux of ["screen", "tmux"] as const) {
    const input = terminal("0", "initial-silent")
    const result = await definition().term!({ ...input.source, mux })
    expect(result.notTested?.noObservable, mux).toBe(osc22SilentMultiplexer(mux))
    expect(result.notTested?.noObservable, mux).toBe(
      "Open by design only for a run with no command record from the outer terminal: without that record nothing shows what the multiplexer sent.",
    )
    expect(result.observation?.outcome, mux).toBeUndefined()
    // #32593: the multiplexer arm sends only the OSC 22 target after its forwarding control; no query.
    expect(input.writes, mux).toEqual(["\x1b]22;pointer\x1b\\"])
    expect(input.replies, mux).toEqual([])
  }
})

/**
 * @failure The multiplexer arm grades OSC 22 from anything but the outer terminal's command record, names
 *   a terminal or multiplexer in its grade, or drifts from @cpo/term's reasons (@cto 5c25b17f, 1818f9ec; #32593).
 * @level l1
 * @consumer extensions.osc22-pointer outerCommands.grade, fed fake outer reader results.
 * @testonly none
 */
test.each([
  {
    name: "control seen, target absent: Unsupported, measured",
    read: {
      status: "measured",
      target: "set_dynamic_color 22 pointer",
      targetSent: false,
      outer: { app: "kitty", version: "0.49.2" },
      detail: {},
    },
    status: "unsupported",
    reason:
      "The multiplexer did not send OSC 22 to the outer terminal; its forwarding control arrived, so the path was open.",
  },
  {
    name: "target seen: to do, naming the outer terminal and version",
    read: {
      status: "measured",
      target: "set_dynamic_color 22 pointer",
      targetSent: true,
      outer: { app: "kitty", version: "0.49.2" },
      detail: {},
    },
    status: "probe-todo",
    reason:
      "The multiplexer sent OSC 22 to the outer terminal (kitty 0.49.2); whether the outer terminal applied the shape was not read.",
  },
  {
    name: "control missing: invalid",
    read: {
      status: "unavailable",
      reason: "Outer command record has no forwarding control line: set_title tdv-title-x",
      detail: {},
    },
    status: "probe-invalid",
    reason: OSC22_MUX_NO_RECORD + " Outer command record has no forwarding control line: set_title tdv-title-x",
  },
  {
    name: "default config, no control possible: declared untestable",
    read: {
      status: "unavailable",
      reason: "Outer command record has no forwarding control line: set_title tdv-title-x",
      titlesForwarded: false,
      noForwardingControl: true,
      detail: {},
    },
    status: "untestable",
    reason:
      "No forwarding control reaches the outer record under the default config, so what the multiplexer sent for OSC 22 was not read.",
  },
  {
    name: "set-titles profile, control missing: invalid",
    read: {
      status: "unavailable",
      reason: "Outer command record has no forwarding control line: set_title tdv-title-x",
      titlesForwarded: true,
      noForwardingControl: true,
      detail: {},
    },
    status: "probe-invalid",
    reason: OSC22_MUX_NO_RECORD + " Outer command record has no forwarding control line: set_title tdv-title-x",
  },
  {
    name: "not attempted: invalid with the no-record reason and the reader's own",
    read: { status: "unavailable", reason: "Outer command read not attempted: no verified owned mux terminal" },
    status: "probe-invalid",
    reason: OSC22_MUX_NO_RECORD + " Outer command read not attempted: no verified owned mux terminal",
  },
  {
    // A default tmux config explains a missing control, never a refused plan order: the failure keeps its own reason.
    name: "default config, plan order refused: invalid with its own reason",
    read: {
      status: "unavailable",
      reason: "Outer OSC 22 trace has no target write before its forwarding control",
      titlesForwarded: false,
      detail: {},
    },
    status: "probe-invalid",
    reason: OSC22_MUX_NO_RECORD + " Outer OSC 22 trace has no target write before its forwarding control",
  },
] as const)("OSC 22 multiplexer grade: $name", ({ read, status, reason }) => {
  const outer = definition().outerCommands!
  expect(outer.branch).toBe("osc22-mux-outer-command")
  const result = outer.grade(read)
  if (status !== "untestable") expect(result.criterionBranch).toBe("osc22-mux-outer-command")
  if (status === "untestable") {
    // A row the default config cannot measure is declared untestable, the one form the finalizer admits.
    expect(result.criterionBranch).toBe("headless-observable-review")
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(result.tests).toEqual([{ id: "declared-untestable", status: "untestable", reason }])
    expect(result.observation).toBeUndefined()
  } else if (status === "unsupported") {
    // The decided negative asserts on the outer command record, the same `buffer_state` kind every outer-record
    // grade in this package uses; this arm issues no query, so a query_reply assertion would be a collector stop
    // (@cto 33920).
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state", note: reason })
    expect(result.assertions).toEqual([expect.objectContaining({ kind: "negative", assertionType: "buffer_state" })])
    expect(result.tests).toBeUndefined()
  } else {
    expect(result.observation).toBeUndefined()
    expect(result.tests).toEqual([{ id: "outer-command-record", status, reason }])
  }
  expect(JSON.parse(result.response!)).toEqual({ outerCommands: read })
})

test.each(["control-disabled", "control-silent", "target-malformed", "restore-disabled", "restore-silent"] as const)(
  "an unqualified %s reading stays open",
  async (fault) => {
    const input = terminal("0", fault)
    const result = await definition().term!(input.source)
    expect(result.notTested?.reason).toBe("no-semantic-observable")
    expect(result.observation?.outcome).not.toBe("supported")
    expect(result.observation?.outcome).not.toBe("unsupported")
    if (fault !== "restore-disabled") expect(input.selected()).toBe("0")
  },
)

test("an unexpected selected shape is inconclusive rather than a target negative", async () => {
  const input = terminal("0", "target-other")
  const result = await definition().term!(input.source)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.assertions).toBeUndefined()
  expect(result.note).toContain("unexpected target shape")
  expect(input.selected()).toBe("0")
})

// @failure Pointer images are graded without a baseline before OSC22, an off-window pointer control,
// an inert made-up name, or exact restoration. Logical-query fixtures cannot observe these effects.
// @level l1
// @consumer Generic OSC22 App image callback -> existing owned capture/input fixtures.
function pointerImages(fault = "none") {
  const faults = new Set(fault.split("+"))
  const { source } = terminal("0", "initial-silent")
  let shape = faults.has("nondefault") ? "override" : "baseline"
  let away = false
  const events: string[] = []
  const modes = new Map([9, 25, 1000, 1001, 1002, 1003].map((mode) => [mode, mode === 25]))
  const textWidth = 640
  const textHeight = 384
  source.captureKind = "pixels"
  source.captureGeometry = {
    source: "measured by complete raster calibration",
    geometry: { cellWidth: 8, cellHeight: 16, textWidth, textHeight },
  }
  source.queryMode = async (mode) => (modes.get(mode) ? "set" : "reset")
  source.write = (text) => {
    events.push(text)
    const mode = /^\x1b\[\?(\d+)([hl])$/.exec(text)
    if (mode) modes.set(Number(mode[1]), mode[2] === "h")
    if (text === "\x1b]22;crosshair\x07" && !faults.has("target-disabled")) shape = "crosshair"
    if (text === "\x1b]22;xterm\x07" && !faults.has("restore-disabled")) shape = "baseline"
    if (text === "\x1b]22;terminfo-unknown-shape\x07" && faults.has("unknown-changes")) shape = "unexpected"
  }
  // No raw key input: the off-window control depends on no terminal setting.
  source.input = {
    injectClick: async () => {
      throw new Error("No click belongs to the pointer-image recipe")
    },
    injectKey: async () => {
      throw new Error("No key belongs to the pointer-image recipe")
    },
    injectMove: async (x, y) => {
      events.push(`move:${x},${y}`)
      if (x >= textWidth || y >= textHeight) away = !faults.has("control-disabled")
      else if (!faults.has("motion-disabled")) away = false
    },
  }
  source.capture = async ({ role, label }) => {
    const pixels = away ? "away" : shape
    events.push(`image:${pixels}`)
    const ref = `sha256:${Buffer.from(pixels).toString("hex").padEnd(64, "0")}`
    return { kind: "pixels", role, label, capturedAt: events.length, ref, sourceRef: ref, pixelsDigest: ref }
  }
  return { source, events, modes }
}

// 32593: a qualified off-window control lets the crosshair decide both ways, pixel-compared with the baseline.
test.each([
  { fault: "none", outcome: "supported" },
  { fault: "target-disabled", outcome: "unsupported" },
])("OSC22 images decide $outcome only after the off-window control", async ({ fault, outcome }) => {
  const input = pointerImages(fault)
  const result = await definition().term!(input.source)
  expect(result.observation?.outcome).toBe(outcome)
  expect(result.observation?.assertionType).toBe("screenshot")
  expect(result.assertions?.[0]?.expected).toContain("off-window pointer move")
  expect(result.observation?.frames?.some((frame) => frame.role === "target")).toBe(true)
  expect(input.events.indexOf("image:baseline")).toBeLessThan(
    input.events.findIndex((event) => event.startsWith("\x1b]22;")),
  )
  expect(input.events).toContain("image:away")
  expect(input.events).toContain("\x1b]22;terminfo-unknown-shape\x07")
  expect(input.events).not.toContain("\x1b]22;?__current__\x07")
  expect(input.events.filter((event) => event.startsWith("image:")).at(-1)).toBe("image:baseline")
  expect(input.modes.get(25)).toBe(true)
  for (const mode of [9, 1000, 1001, 1002, 1003]) expect(input.modes.get(mode)).toBe(false)
})

// 32593: the control's move lands outside the measured text area, between the baseline and the control frame.
test("the OSC22 image control moves the pointer outside the owned text area", async () => {
  const input = pointerImages()
  await definition().term!(input.source)
  const awayMove = input.events.indexOf("move:1040,684")
  expect(awayMove).toBeGreaterThan(input.events.indexOf("image:baseline"))
  expect(input.events[awayMove + 1]).toBe("image:away")
  expect(input.events.filter((event) => event.startsWith("move:1040,"))).toHaveLength(1)
})

// 32593: no off-window change means the capture is unqualified, so the result is Open, never Unsupported,
// even when the crosshair frame also equals the baseline.
test.each(["control-disabled", "control-disabled+target-disabled"])(
  "an off-window frame equal to the baseline (%s) stays open",
  async (fault) => {
    const input = pointerImages(fault)
    const result = await definition().term!(input.source)
    expect(result.tests).toEqual([
      {
        id: "criterion",
        status: "probe-todo",
        reason: "extensions.osc22-pointer: moving the pointer off the window did not change the capture",
      },
    ])
    expect(result.observation?.outcome).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    expect(input.events).not.toContain("\x1b]22;crosshair\x07")
  },
)

test.each(["unknown-changes", "restore-disabled", "nondefault"])(
  "OSC22 image contradiction %s is invalid and never a grade",
  async (fault) => {
    const input = pointerImages(fault)
    const result = await definition().term!(input.source)
    expect(result.tests).toContainEqual(expect.objectContaining({ status: "probe-invalid" }))
    if (typeof result.response !== "string") throw new Error("Invalid pointer images must retain their response")
    const response = JSON.parse(result.response) as { frames: Array<{ label: string }> }
    expect(response.frames.at(-1)?.label).toContain("restored second")
    expect(result.observation?.outcome).not.toBe("supported")
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(input.modes.get(25)).toBe(true)
  },
)

// An unqualified control or a motion that fails to restore the pointer never grades, and restores state.
test.each(["control-disabled", "motion-disabled"])("OSC22 image control %s cannot decide a grade", async (fault) => {
  const input = pointerImages(fault)
  const result = await definition().term!(input.source)
  expect(input.events).toContain("move:1040,684")
  if (typeof result.response !== "string") throw new Error("Unqualified pointer images must retain their response")
  const response = JSON.parse(result.response) as { frames: Array<{ label: string }> }
  expect(response.frames.at(-1)?.label).toContain("restored second")
  expect(result.observation?.outcome).not.toBe("supported")
  expect(result.observation?.outcome).not.toBe("unsupported")
  expect(input.events).not.toContain("\x1b]22;crosshair\x07")
  expect(input.modes.get(25)).toBe(true)
})
