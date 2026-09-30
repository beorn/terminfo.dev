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

test.each([
  "extensions.osc104-reset-palette",
  "extensions.osc110-reset-fg",
  "extensions.osc111-reset-bg",
  "extensions.osc112-reset-cursor",
  "extensions.osc710-font-normal",
  "extensions.osc2-title",
  "extensions.osc9-progress",
] as const)("app %s leaves state untouched when no effect readback exists", async (id) => {
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
})

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
