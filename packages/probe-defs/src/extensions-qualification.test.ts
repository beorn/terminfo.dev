/**
 * @failure OSC prefix echoes, capability flags, and later cursor replies were accepted as extension support.
 * @level l0
 * @consumer App and headless extension observations used by the unified selector.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import type { TermContext, TermlessContext } from "./types.ts"

function callback(id: string) {
  const definition = extensionsProbes.find((item) => item.id === id)
  if (!definition?.termless || !definition.term) throw new Error(`missing extension callback ${id}`)
  return definition
}

test("OSC 10 needs a complete matching foreground-color reply in both collectors", async () => {
  const definition = callback("extensions.osc10-fg-color")
  const frame = "\x1b]10;rgb:ffff/0000/0000\x07"
  const headless = (raw: string) => definition.termless!({ feedCapture: () => raw } as unknown as TermlessContext)
  const app = (raw: string) =>
    definition.term!({
      queryWithSentinelOutcome: async (_query: string, pattern: RegExp) => ({
        match: pattern.exec(raw),
        reason: pattern.test(raw) ? "reply" : "sentinel",
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
      }),
    } as unknown as TermContext)
  for (const result of [headless(frame), await app(frame)]) {
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(result.response).toBe(frame)
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: frame }])
  }
  for (const result of [headless("\x1b]10;"), await app("\x1b]10;")]) {
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.assertions).toBeUndefined()
  }
})

test("a truecolor declaration without two calibrated RGB cell samples is inconclusive", () => {
  const definition = callback("extensions.truecolor")
  const result = definition.termless!({
    capabilities: { truecolor: true },
    feed: () => undefined,
    getCell: () => ({ char: "X", fg: null, bg: null }),
  } as unknown as TermlessContext)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "parser-state" })
  expect(result.assertions).toBeUndefined()
})

test("a later DA1 reply does not establish an OSC 104 palette reset", () => {
  const definition = callback("extensions.osc104-reset-palette")
  const result = definition.termless!({
    feed: () => undefined,
    feedCapture: () => "\x1b[?1;2c",
  } as unknown as TermlessContext)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.assertions).toBeUndefined()
})

const directReplies = [
  ["extensions.osc10-fg-color", "\x1b]10;rgb:ffff/0000/0000\x07"],
  ["extensions.osc11-bg-color", "\x1b]11;rgb:0000/ffff/0000\x07"],
  ["extensions.osc12-cursor-color", "\x1b]12;rgb:0000/0000/ffff\x07"],
  ["extensions.osc17-highlight-bg", "\x1b]17;rgb:ffff/ffff/0000\x07"],
  ["extensions.osc19-highlight-fg", "\x1b]19;rgb:ffff/0000/ffff\x07"],
  ["extensions.osc4-palette", "\x1b]4;0;rgb:ffff/0000/0000\x07"],
  ["extensions.osc5-special-color", "\x1b]5;0;rgb:ffff/0000/0000\x07"],
  ["extensions.osc1337-cellsize", "\x1b]1337;ReportCellSize=12;8\x07"],
  // 27915: iTerm2's newer height;width;scale form, as WezTerm 0-unstable-2026-09-17 sends it.
  ["extensions.osc1337-cellsize", "\x1b]1337;ReportCellSize=16.5;7.5;1.3\x1b\\"],
  ["extensions.osc1337-capabilities", "\x1b]1337;Capabilities=alpha\x07"],
  ["extensions.osc7770-font-size", "\x1b]7770;14\x07"],
  ["extensions.osc7777-font-window-size", "\x1b]7777;14\x07"],
  ["extensions.osc701-locale", "\x1b]701;en_US.UTF-8\x07"],
  ["extensions.osc702-version", "\x1b]702;rxvt-1\x07"],
  ["extensions.osc776-cell-size", "\x1b]776;8;16;2\x07"],
  ["extensions.sixel-da1", "\x1b[?1;4c"],
] as const

test.each(directReplies)("%s only qualifies its complete, bound query frame", async (id, frame) => {
  const definition = callback(id)
  const run = async (raw: string) => {
    const headless = definition.termless!({ feedCapture: () => raw } as unknown as TermlessContext)
    const query = async (_sequence: string, pattern: RegExp) => ({
      match: pattern.exec(raw),
      reason: pattern.test(raw) ? ("reply" as const) : ("sentinel" as const),
      raw,
      rawBase64: Buffer.from(raw).toString("base64"),
    })
    const app = await definition.term!({
      queryWithSentinelOutcome: query,
      queryOutcome: query,
    } as unknown as TermContext)
    return [headless, app]
  }
  for (const result of await run(frame)) {
    expect(result.observation, id).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(result.response, id).toBe(frame)
    expect(result.assertions, id).toMatchObject([{ kind: "positive", observed: frame }])
  }
  for (const result of await run(frame.slice(0, -1))) {
    expect(result.observation?.outcome, id).toBe("inconclusive")
    expect(result.assertions, id).toBeUndefined()
  }
  if (id === "extensions.sixel-da1") {
    // Kitty 0.49.1 replies with a trailing empty DA1 parameter.
    for (const [raw, outcome] of [
      ["\x1b[?62;52;c", "unsupported"],
      ["\x1b[?62;4;52;c", "supported"],
    ] as const) {
      for (const result of await run(raw)) {
        expect(result.observation).toMatchObject({ outcome, evidence: "query" })
        expect(result.response).toBe(raw)
        expect(result.assertions).toMatchObject([
          { kind: outcome === "supported" ? "positive" : "negative", observed: raw },
        ])
      }
      for (const result of await run(raw.slice(0, -1))) {
        expect(result.observation?.outcome).toBe("inconclusive")
        expect(result.assertions).toBeUndefined()
      }
    }
  }
  if (frame.includes("rgb:")) {
    for (const payload of ["?", "red", "rgb:zz/00/00", "rgb:fffff/00/00"]) {
      for (const result of await run(frame.replace(/rgb:[^\x07]+/, payload))) {
        expect(result.observation?.outcome, `${id}: ${payload}`).toBe("inconclusive")
        expect(result.assertions, id).toBeUndefined()
      }
    }
  }
})

test.each([
  ["extensions.osc104-reset-palette", "4;0"],
  ["extensions.osc110-reset-fg", "10"],
  ["extensions.osc111-reset-bg", "11"],
  ["extensions.osc112-reset-cursor", "12"],
  ["extensions.osc113-reset-pointer-fg", "13"],
  ["extensions.osc114-reset-pointer-bg", "14"],
] as const)("%s requires a changed color before a restored color can qualify", (id, code) => {
  const definition = callback(id)
  const color = (value: string) => `\x1b]${code};rgb:${value}\x07`
  const run = (replies: string[]) => {
    const feed: string[] = []
    const result = definition.termless!({
      feed: (sequence: string) => {
        feed.push(sequence)
      },
      feedCapture: () => replies.shift() ?? "",
    } as unknown as TermlessContext)
    return { result, feed }
  }
  const original = color("00/00/00")
  const changed = color("aa/bb/cc")
  const restored = run([original, changed, original])
  expect(restored.result.observation, id).toMatchObject({ outcome: "supported", evidence: "behavior" })
  expect(restored.result.assertions, id).toMatchObject([{ kind: "positive" }])
  expect(restored.feed.length, id).toBe(2)
  const notRestored = run([original, changed, color("12/34/56")])
  expect(notRestored.result.observation, id).toMatchObject({ outcome: "unsupported", evidence: "behavior" })
  expect(notRestored.result.assertions, id).toMatchObject([{ kind: "negative" }])
  const noControl = run([original, "", original])
  expect(noControl.result.observation?.outcome, id).toBe("inconclusive")
  expect(noControl.result.assertions, id).toBeUndefined()
})

test.each(["extensions.osc710-font-normal", "extensions.osc2-title", "extensions.osc9-progress"] as const)(
  "app %s leaves state untouched when no effect readback exists",
  async (id) => {
    const definition = extensionsProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`missing app extension callback ${id}`)
    const writes: string[] = []
    const result = await definition.term({
      write: (bytes: string) => {
        writes.push(bytes)
      },
      queryCursorPosition: async () => {
        throw new Error("unmeasured CPR must not run")
      },
    } as unknown as TermContext)
    expect(writes, id).toEqual([])
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(result.assertions, id).toBeUndefined()
  },
)

// 27832: the reset features mutate and read back. The collector runs this exchange only with a
// verified disposable-ownership receipt; the callback itself grades the measured four legs.
const appResetProbes = [
  ["extensions.osc104-reset-palette", 4, 104, 0],
  ["extensions.osc110-reset-fg", 10, 110, undefined],
  ["extensions.osc111-reset-bg", 11, 111, undefined],
  ["extensions.osc112-reset-cursor", 12, 112, undefined],
  ["extensions.osc113-reset-pointer-fg", 13, 113, undefined],
  ["extensions.osc114-reset-pointer-bg", 14, 114, undefined],
] as const

test.each(appResetProbes)(
  "app %s reads the colour, sets it, reads the change, resets, and reads the restoration",
  async (id, setCode, resetCode, index) => {
    const definition = callback(id)
    // The collector's gate is the disposable receipt; the declaration is what makes it apply.
    expect(definition.termNeedsDisposable, id).toBe(true)
    const indexPart = index === undefined ? "" : `${index};`
    const rgb = (hex: string) => `\x1b]${setCode};${indexPart}rgb:${hex}\x07`
    const run = async (replies: string[]) => {
      const writes: string[] = []
      const queue = [...replies]
      const exchange = async (_sequence: string, pattern: RegExp) => {
        const raw = queue.shift() ?? ""
        return {
          match: pattern.exec(raw),
          reason: pattern.test(raw) ? ("reply" as const) : ("sentinel" as const),
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
        }
      }
      const result = await definition.term!({
        write: (bytes: string) => {
          writes.push(bytes)
        },
        queryWithSentinelOutcome: exchange,
      } as unknown as TermContext)
      return { result, writes }
    }
    const reset = `\x1b]${resetCode}${index === undefined ? "" : `;${index}`}\x07`
    const restored = await run([rgb("0000/0000/0000"), rgb("aa/bb/cc"), rgb("0000/0000/0000")])
    expect(restored.result.observation, id).toMatchObject({ outcome: "supported", evidence: "behavior" })
    expect(restored.result.assertions, id).toMatchObject([{ kind: "positive" }])
    expect(restored.writes, id).toEqual([`\x1b]${setCode};${indexPart}rgb:aa/bb/cc\x07`, reset])
    const notRestored = await run([rgb("0000/0000/0000"), rgb("aa/bb/cc"), rgb("12/34/56")])
    expect(notRestored.result.observation, id).toMatchObject({ outcome: "unsupported", evidence: "behavior" })
    expect(notRestored.result.assertions, id).toMatchObject([{ kind: "negative" }])
    const noControl = await run([rgb("0000/0000/0000"), ""])
    expect(noControl.result.observation?.outcome, id).toBe("inconclusive")
    expect(noControl.result.assertions, id).toBeUndefined()
    const noReply = await run([])
    expect(noReply.writes, id).toEqual([])
    expect(noReply.result.observation, id).toMatchObject({ evidence: "query" })
    expect(noReply.result.observation?.outcome, id).toBe("inconclusive")
  },
)

const appOnlyEffects = [
  "extensions.osc22-pointer",
  "extensions.osc777-notify",
  "extensions.osc666-termprop",
  "extensions.osc3008-context",
  "extensions.osc176-app-id",
  "extensions.osc555-flash",
  "extensions.osc440-audio",
] as const

test.each(appOnlyEffects)("%s cursor replies do not prove the advertised effect", async (id) => {
  const definition = extensionsProbes.find((item) => item.id === id)
  if (!definition?.term) throw new Error(`missing app-only extension callback ${id}`)

  const position = { row: 3, col: 1 }
  const run = (cursor: typeof position | null) =>
    definition.term!({
      write: () => undefined,
      queryCursorPosition: async () => cursor,
    } as unknown as TermContext)

  const answered = await run(position)
  expect(answered.pass, id).toBe(false)
  expect(answered.response, id).toBe("3;1")
  expect(answered.observation, id).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  expect(answered.assertions, id).toBeUndefined()

  const silent = await run(null)
  expect(silent.pass, id).toBe(false)
  expect(silent.response, id).toBeUndefined()
  expect(silent.observation, id).toMatchObject({
    outcome: "inconclusive",
    reason: "no-response",
    evidence: "query",
  })
  expect(silent.assertions, id).toBeUndefined()
})

test("a DA1 sentinel with no OSC reply is a measured negative; a late reply grades by the reply", async () => {
  const definition = callback("extensions.osc10-fg-color")
  const da1 = "\x1b[?1;2c"
  const frame = "\x1b]10;rgb:ffff/0000/0000\x07"
  const app = (raw: string, sentinel?: { atMs: number; graceMs: number }) =>
    definition.term!({
      queryWithSentinelOutcome: async (_query: string, pattern: RegExp) => ({
        match: pattern.exec(raw),
        reason: pattern.test(raw) ? "reply" : "sentinel",
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
        ...(sentinel && { sentinel }),
      }),
    } as unknown as TermContext)

  const silent = await app(da1, { atMs: 7, graceMs: 250 })
  expect(silent.observation).toMatchObject({
    outcome: "unsupported",
    evidence: "query",
    note: "negative by sentinel",
  })
  expect(silent.assertions).toMatchObject([
    { kind: "negative", observed: "DA1 answered at +7ms; no reply through the 250 ms window" },
  ])

  const late = await app(da1 + frame, { atMs: 7, graceMs: 250 })
  expect(late.observation).toMatchObject({
    outcome: "supported",
    evidence: "query",
    note: "reply after sentinel",
  })
  expect(late.assertions).toMatchObject([{ kind: "positive", observed: frame }])

  // Without the measured ordering an engine or simulated capture carries, silence stays unknown; the
  // ordering note is the only thing the measurement adds to a reply the site already matched.
  const unmeasured = await app(da1)
  expect(unmeasured.observation?.outcome).toBe("inconclusive")
  expect(unmeasured.assertions).toBeUndefined()
  const unmeasuredLate = await app(da1 + frame)
  expect(unmeasuredLate.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(unmeasuredLate.observation?.note).toBeUndefined()

  // A partial frame after DA1 is the terminal answering badly, not a silent terminal.
  const partial = await app(da1 + "\x1b]10;", { atMs: 7, graceMs: 250 })
  expect(partial.observation?.outcome).toBe("inconclusive")
  expect(partial.assertions).toBeUndefined()
})

test("the unanswered-query choke point grades a measured sentinel and never a timeout", async () => {
  const definition = callback("extensions.osc21-kitty-color")
  const context = (reply: Record<string, unknown>) =>
    definition.term!({ queryWithSentinelOutcome: async () => reply } as unknown as TermContext)

  const silent = await context({
    match: null,
    reason: "sentinel",
    raw: "\x1b[?1;2c",
    rawBase64: Buffer.from("\x1b[?1;2c").toString("base64"),
    sentinel: { atMs: 5, graceMs: 250 },
  })
  expect(silent.observation).toMatchObject({
    outcome: "unsupported",
    evidence: "query",
    note: "negative by sentinel",
  })
  expect(silent.assertions).toMatchObject([
    { kind: "negative", observed: "DA1 answered at +5ms; no reply through the 250 ms window" },
  ])

  // A timeout never answered DA1 at all, so it cannot be a sentinel negative.
  const timedOut = await context({ match: null, reason: "timeout", raw: "", rawBase64: "" })
  expect(timedOut.observation).toMatchObject({ outcome: "inconclusive", reason: "timeout" })
  expect(timedOut.assertions).toBeUndefined()
})

// 27914: xterm answers the item-2 read with CSI ? 2 ; 3 S — the documented failure
// reply, which omits the value (ctlseqs: "XTSMGRAPHICS ... return failure status if
// the terminal is not configured to support the corresponding ... SIXEL feature").
// Demanding a third parameter graded that failure as a malformed geometry.
test("XTSMGRAPHICS failure is a documented status, not a malformed geometry", async () => {
  const definition = callback("extensions.sixel-geometry-report")
  const headless = (raw: string) => definition.termless!({ feedCapture: () => raw } as unknown as TermlessContext)
  const app = (raw: string) =>
    definition.term!({
      queryWithSentinelOutcome: async (_query: string, pattern: RegExp) => ({
        match: pattern.exec(raw),
        reason: pattern.test(raw) ? "reply" : "sentinel",
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
      }),
    } as unknown as TermContext)
  const failure = "\x1b[?2;3S"
  for (const result of [headless(failure), await app(failure)]) {
    expect(result.response).toBe(failure)
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      note: "Sixel geometry query reported protocol status 3 (failure; no graphics geometry is configured)",
    })
    expect(result.assertions).toBeUndefined()
  }
  const success = "\x1b[?2;0;800;528S"
  for (const result of [headless(success), await app(success)]) {
    expect(result.observation).toMatchObject({
      outcome: "supported",
      note: "Current Sixel geometry reported as 800×528 pixels",
    })
  }
  const malformed = headless("\x1b[?2;S")
  expect(malformed.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply" })
/**
 * 27915: kitty graphics control data is an unordered comma-separated key=value list. WezTerm answers an allocation
 * with `I=<number>,i=<id>` where kitty writes `i=<id>,I=<number>`; both are the same reply.
 */
function kittyTransfer(id: string, allocation: (imageNumber: number) => string) {
  const definition = callback(id)
  const answer = (sequence: string): string => {
    const imageNumber = /I=(\d+)/.exec(sequence)?.[1]
    if (imageNumber !== undefined) return allocation(Number(imageNumber))
    return /a=p,i=2,/.test(sequence) ? "\x1b_Gi=2;OK\x1b\\" : ""
  }
  const headless = () =>
    definition.termless!({ feed: () => undefined, feedCapture: answer } as unknown as TermlessContext)
  const app = () =>
    definition.term!({
      queryWithSentinelOutcome: async (sequence: string, pattern: RegExp) => {
        const raw = `${answer(sequence)}\x1b[?65;4;6;18;22;52c`
        return {
          match: pattern.exec(raw),
          reason: pattern.test(raw) ? ("reply" as const) : ("sentinel" as const),
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
        }
      },
      write: () => undefined,
    } as unknown as TermContext)
  return { app, headless }
}

test.each([
  ["kitty's order", (imageNumber: number) => `\x1b_Gi=2,I=${imageNumber};OK\x1b\\`],
  ["WezTerm's order", (imageNumber: number) => `\x1b_GI=${imageNumber},i=2;OK\x1b\\`],
] as const)(
  "kitty transmit and display accept the allocation reply in %s, in both collectors",
  async (_order, reply) => {
    for (const id of ["extensions.kitty-graphics.transmit", "extensions.kitty-graphics.display"]) {
      const { app, headless } = kittyTransfer(id, reply)
      for (const result of [headless(), await app()]) {
        expect(result.observation, id).toMatchObject({ outcome: "supported", evidence: "query" })
        expect(result.assertions, id).toMatchObject([{ kind: "positive" }])
      }
    }
  },
)

test("a kitty allocation reply that echoes another image number does not qualify", async () => {
  for (const id of ["extensions.kitty-graphics.transmit", "extensions.kitty-graphics.display"]) {
    const { app, headless } = kittyTransfer(id, (imageNumber) => `\x1b_GI=${imageNumber + 1},i=2;OK\x1b\\`)
    for (const result of [headless(), await app()]) {
      expect(result.observation?.outcome, id).not.toBe("supported")
      expect(result.assertions, id).toBeUndefined()
    }
  }
})

test("the kitty graphics query still qualifies its i=31;OK reply (27915 kept the single-key frame)", () => {
  const definition = callback("extensions.kitty-graphics")
  const result = definition.termless!({ feedCapture: () => "\x1b_Gi=31;OK\x1b\\" } as unknown as TermlessContext)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
})
