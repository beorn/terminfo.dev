/**
 * @failure The App OSC22 arm substitutes CPR for selected-shape replies, decides without a
 *   same-path control, or loses the incoming shape during restoration.
 * @level l1
 * @consumer extensions.osc22-pointer App callback through the public asynchronous query source.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes, OSC22_SILENT_TERMINAL, osc22SilentMultiplexer } from "./extensions.ts"
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
    expect(result.notTested?.noObservable, mux).toContain(`belongs to the outer terminal, not ${mux}`)
    expect(result.observation?.outcome, mux).toBeUndefined()
    expect(input.writes, mux).toEqual([])
  }
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

// @failure Pointer images are graded without a baseline before OSC22, independent hide/show,
// an inert made-up name, or exact restoration. Logical-query fixtures cannot observe these effects.
// @level l1
// @consumer Generic OSC22 App image callback -> existing owned capture/input fixtures.
function pointerImages(fault = "none") {
  const { source } = terminal("0", "initial-silent")
  let shape = fault === "nondefault" ? "override" : "baseline"
  let hidden = false
  const events: string[] = []
  const modes = new Map([9, 25, 1000, 1001, 1002, 1003].map((mode) => [mode, mode === 25]))
  source.captureKind = "pixels"
  source.captureGeometry = {
    source: "measured by complete raster calibration",
    geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
  }
  source.queryMode = async (mode) => (modes.get(mode) ? "set" : "reset")
  source.write = (text) => {
    events.push(text)
    const mode = /^\x1b\[\?(\d+)([hl])$/.exec(text)
    if (mode) modes.set(Number(mode[1]), mode[2] === "h")
    if (text === "\x1b]22;crosshair\x07" && fault !== "target-disabled") shape = "crosshair"
    if (text === "\x1b]22;xterm\x07" && fault !== "restore-disabled") shape = "baseline"
    if (text === "\x1b]22;terminfo-unknown-shape\x07" && fault === "unknown-changes") shape = "unexpected"
  }
  source.input = {
    injectClick: async () => {
      throw new Error("No click belongs to the pointer-image recipe")
    },
    injectKey: async (key) => {
      expect(key).toBe("a")
      events.push("key:a")
      hidden = fault !== "control-disabled"
    },
    injectMove: async (x, y) => {
      events.push(`move:${x},${y}`)
      if (fault !== "motion-disabled") hidden = false
    },
  }
  source.readInput = async (_pattern, _timeout, inject) => {
    await inject?.()
    return ["a"]
  }
  source.capture = async ({ role, label }) => {
    const pixels = hidden ? "hidden" : shape
    events.push(`image:${pixels}`)
    const ref = `sha256:${Buffer.from(pixels).toString("hex").padEnd(64, "0")}`
    return { kind: "pixels", role, label, capturedAt: events.length, ref, sourceRef: ref, pixelsDigest: ref }
  }
  return { source, events, modes }
}

test.each([
  { fault: "none", outcome: "supported" },
  { fault: "target-disabled", outcome: "unsupported" },
])("OSC22 images decide $outcome only after independent controls", async ({ fault, outcome }) => {
  const input = pointerImages(fault)
  const result = await definition().term!(input.source)
  expect(result.observation?.outcome).toBe(outcome)
  expect(result.observation?.assertionType).toBe("screenshot")
  expect(result.observation?.frames?.some((frame) => frame.role === "target")).toBe(true)
  expect(input.events.indexOf("image:baseline")).toBeLessThan(
    input.events.findIndex((event) => event.startsWith("\x1b]22;")),
  )
  expect(input.events).toContain("image:hidden")
  expect(input.events).toContain("\x1b]22;terminfo-unknown-shape\x07")
  expect(input.events).not.toContain("\x1b]22;?__current__\x07")
  expect(input.events.filter((event) => event.startsWith("image:")).at(-1)).toBe("image:baseline")
  expect(input.modes.get(25)).toBe(true)
  for (const mode of [9, 1000, 1001, 1002, 1003]) expect(input.modes.get(mode)).toBe(false)
})

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

test.each(["control-disabled", "motion-disabled"])("OSC22 image control %s cannot decide a grade", async (fault) => {
  const input = pointerImages(fault)
  const result = await definition().term!(input.source)
  expect(input.events).toContain("key:a")
  if (typeof result.response !== "string") throw new Error("Unqualified pointer images must retain their response")
  const response = JSON.parse(result.response) as { frames: Array<{ label: string }> }
  expect(response.frames.at(-1)?.label).toContain("restored second")
  expect(result.observation?.outcome).not.toBe("supported")
  expect(result.observation?.outcome).not.toBe("unsupported")
  expect(input.events).not.toContain("\x1b]22;crosshair\x07")
  expect(input.modes.get(25)).toBe(true)
})
