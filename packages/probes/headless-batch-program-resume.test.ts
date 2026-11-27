/**
 * @failure An inherited, unbound or malformed OSC7577_TOKEN decides the program-resume row, the multiplexer sentinel
 *   grades R7577-059/R7577-060 wrong, the secret leaks, or the silent row misses a leaked byte or reply before DA1.
 * @level l1
 * @consumer The terminal-child environment reader, extensions.osc7577-token, extensions.osc7577-silent, and glossary linking (#38699, #38754, spec rev 0.5).
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import { readTerminalChildEnvironment } from "../terminfo.dev/src/terminal-child-environment.ts"
import { extensionsProbes } from "../probe-defs/src/extensions.ts"
import {
  OSC7577_2048_BYTE_64_ARGV_REPORT,
  OSC7577_CUT_SHORT_REPORT,
  OSC7577_MUX_SENTINEL_TOKEN,
  OSC7577_OVER_8KIB_REPORT,
  OSC7577_REPORTS,
  OSC7577_RESERVED_QUERY_REPORT,
} from "../probe-defs/src/program-resume.ts"
import { recordExecutedProbe } from "../probe-defs/src/helpers.ts"
import { validateCurrentAssertions } from "../run-parser/src/observations.ts"
import { linkifyContent } from "../../docs/data/linkify-content.ts"
import type {
  LibProbeSource,
  ProbeCallbackResult,
  ProgramResumeTokenReading,
  TermProbeSource,
} from "@terminfo/probe-defs"

const RUN = "a".repeat(32)
const TTY = "tty_nr=34816;fd=1;rdev=34816"
const bound = { TERMINFO_RUN_ID: RUN, TERMINFO_TERM_FEATURES_LAUNCH: RUN }
const WELL_FORMED = "Q2xhdWRlLXRlc3QtdG9rZW4tMDEyMzQ1Njc4OQ"
const DA1 = "\x1b[?62;22c"

afterEach(() => vi.restoreAllMocks())

function definition() {
  const found = extensionsProbes.find((item) => item.id === "extensions.osc7577-token")
  if (!found?.term || !found.lib) throw new Error("missing extensions.osc7577-token arms")
  return found as typeof found & { term: NonNullable<typeof found.term>; lib: NonNullable<typeof found.lib> }
}

async function grade(reading: ProgramResumeTokenReading) {
  return definition().term({ readProgramResumeToken: async () => reading } as unknown as TermProbeSource)
}

function recorded(result: ProbeCallbackResult, featureId = "extensions.osc7577-token") {
  return recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: "2026-11-26T01:00:00.000Z" },
    assertions: (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId })),
    tests: result.tests,
    ...(result.observation && { observation: { ...result.observation, featureId } }),
    ...(result.notTested && { coverage: { ...result.notTested, featureId, rawReplyRef: `${featureId}.response` } }),
  })
}

function status(result: ProbeCallbackResult, featureId = "extensions.osc7577-token") {
  return recorded(result, featureId).status
}

test("one reader binds both variables to the same run; TERM_FEATURES readings are unchanged", () => {
  const env = { ...bound, TERM_FEATURES: "T3", OSC7577_TOKEN: WELL_FORMED }
  const both = readTerminalChildEnvironment(env, RUN, 42, TTY)
  expect(both.termFeatures).toMatchObject({
    status: "measured",
    present: true,
    value: "T3",
    runId: RUN,
    pid: 42,
    tty: TTY,
  })
  expect(both.programResumeToken).toEqual({
    status: "measured",
    present: true,
    length: WELL_FORMED.length,
    runId: RUN,
    launchMarker: RUN,
    pid: 42,
    tty: TTY,
  })
  for (const delta of [{ TERMINFO_RUN_ID: "e".repeat(32) }, { TERMINFO_TERM_FEATURES_LAUNCH: undefined }]) {
    const unbound = readTerminalChildEnvironment({ ...env, ...delta }, RUN, 42, TTY)
    expect(unbound.programResumeToken.status).toBe("unavailable")
    expect(unbound.termFeatures.status).toBe("unavailable")
  }
  expect(readTerminalChildEnvironment(env, RUN, 0, TTY).programResumeToken.status).toBe("invalid")
})

// @cto ee6b7fd9: the token is a secret. A malformed one is named by the rule it broke, and its bytes appear nowhere:
// not in the reading, the graded result, the refusal text or any log line.
test.each([
  { token: "LEAKMARKER", rule: "length" },
  { token: "LEAKMARKER-" + "x".repeat(60), rule: "length" },
  { token: "LEAKMARKER.has.a.dot.in.it.000", rule: "charset" },
  { token: "LEAKMARKER\nnot printable 0000", rule: "charset" },
])("a malformed token ($rule) is named by its rule and never recorded", async ({ token, rule }) => {
  const logged: unknown[] = []
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args))
  }
  const reading = readTerminalChildEnvironment({ ...bound, OSC7577_TOKEN: token }, RUN, 42, TTY).programResumeToken
  expect(reading).toMatchObject({ status: "measured", present: true, malformed: rule })
  const result = await grade(reading)
  expect(status(result)).toBe("unsupported")
  expect(result.note).toContain(rule === "length" ? "22-64 characters" : "[A-Za-z0-9_-]")
  for (const carrier of [reading, result, logged]) expect(JSON.stringify(carrier)).not.toContain("LEAKMARKER")
})

// #38754: boundary lengths 21, 22, 64 and 65 characters (R7577-055). 21 and 65 are named "length" and Unsupported;
// 22 and 64 are accepted as well formed and Supported; no token bytes appear in any carrier.
test.each([
  { length: 21, expectedRule: "length" as const, expectedStatus: "unsupported" as const },
  { length: 22, expectedRule: undefined, expectedStatus: "supported" as const },
  { length: 64, expectedRule: undefined, expectedStatus: "supported" as const },
  { length: 65, expectedRule: "length" as const, expectedStatus: "unsupported" as const },
])(
  "token boundary length $length characters -> malformed=$expectedRule, status=$expectedStatus",
  async ({ length, expectedRule, expectedStatus }) => {
    const token = `BOUNDARY_${"k".repeat(length - 9)}`
    expect(token).toHaveLength(length)
    const reading = readTerminalChildEnvironment({ ...bound, OSC7577_TOKEN: token }, RUN, 42, TTY).programResumeToken
    expect(reading).toEqual({
      status: "measured",
      present: true,
      length,
      ...(expectedRule !== undefined && { malformed: expectedRule }),
      runId: RUN,
      launchMarker: RUN,
      pid: 42,
      tty: TTY,
    })
    const result = await grade(reading)
    expect(status(result)).toBe(expectedStatus)
    expect(JSON.stringify({ reading, result })).not.toContain(token)
  },
)

test("a well-formed token reads Supported with no bytes retained; absence under this run's marker is Unsupported", async () => {
  const present = readTerminalChildEnvironment({ ...bound, OSC7577_TOKEN: WELL_FORMED }, RUN, 42, TTY)
  const supported = await grade(present.programResumeToken)
  expect(status(supported)).toBe("supported")
  expect(supported.observation).toMatchObject({ outcome: "supported", assertionType: "process_environment" })
  expect(JSON.stringify(supported)).not.toContain(WELL_FORMED)
  const absent = await grade(readTerminalChildEnvironment(bound, RUN, 42, TTY).programResumeToken)
  expect(status(absent)).toBe("unsupported")
  expect(absent.assertions).toMatchObject([{ kind: "negative", observed: "absent" }])
})

test("inside a mux without a planted sentinel a present token stays PROBE TODO; absence there is Unsupported", async () => {
  const base = { status: "measured", runId: RUN, launchMarker: RUN, pid: 42, tty: TTY, mux: "tmux" } as const
  const present = await grade({ ...base, present: true, length: 38 })
  expect(present.observation).toBeUndefined()
  expect(present.notTested?.noObservable).toContain("inside tmux")
  expect(status(await grade({ ...base, present: false, length: 0 }))).toBe("unsupported")
})

// #38754 (@cto 953d6a6c): inside a mux with a planted 22-char sentinel token, R7577-059 (don't pass the outer token on)
// and R7577-060 (mint your own well-formed token) are graded separately across all three sentinel states, and no token
// value (neither the sentinel nor the pane's token) appears in the reading, the result, the logs or a refusal reason.
test.each([
  {
    name: "equal (mux passed the outer sentinel on)",
    paneToken: OSC7577_MUX_SENTINEL_TOKEN,
    expectedSentinel: "equal" as const,
    expected059: "unsupported" as const,
    expected060: "unsupported" as const,
    expectedOverall: "unsupported" as const,
  },
  {
    name: "different and well-formed (mux minted its own token)",
    paneToken: "MUX_MINTED_SECRET_TOKEN_0123456789",
    expectedSentinel: "different" as const,
    expected059: "supported" as const,
    expected060: "supported" as const,
    expectedOverall: "supported" as const,
  },
  {
    name: "absent (mux stripped the outer token and minted none)",
    paneToken: undefined,
    expectedSentinel: "absent" as const,
    expected059: "supported" as const,
    expected060: "unsupported" as const,
    expectedOverall: "unsupported" as const,
  },
  {
    name: "different but malformed (mux replaced the sentinel with a short token)",
    paneToken: "MUX_SHORT_SECRET",
    expectedSentinel: "different" as const,
    expected059: "supported" as const,
    expected060: "unsupported" as const,
    expectedOverall: "unsupported" as const,
  },
])(
  "mux sentinel arm ($name): R7577-059=$expected059, R7577-060=$expected060, overall=$expectedOverall, zero token bytes leaked",
  async ({ paneToken, expectedSentinel, expected059, expected060, expectedOverall }) => {
    expect(OSC7577_MUX_SENTINEL_TOKEN).toHaveLength(22)
    const logged: unknown[] = []
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args))
    }
    const env = paneToken === undefined ? { ...bound } : { ...bound, OSC7577_TOKEN: paneToken }
    const childReading = readTerminalChildEnvironment(env, RUN, 42, TTY, OSC7577_MUX_SENTINEL_TOKEN).programResumeToken
    if (childReading.status !== "measured") throw new Error("expected measured reading")
    const muxReading: ProgramResumeTokenReading = { ...childReading, mux: "tmux" }
    expect(muxReading.sentinel).toBe(expectedSentinel)
    const result = await grade(muxReading)
    const probeResult = recorded(result)
    expect(probeResult.status).toBe(expectedOverall)
    expect(probeResult.tests.map((row) => ({ id: row.id, status: row.status }))).toEqual([
      { id: "R7577-059", status: expected059 },
      { id: "R7577-060", status: expected060 },
    ])
    for (const carrier of [muxReading, result, probeResult, logged]) {
      const serialized = JSON.stringify(carrier)
      expect(serialized).not.toContain(OSC7577_MUX_SENTINEL_TOKEN)
      if (paneToken !== undefined) expect(serialized).not.toContain(paneToken)
    }
  },
)

test("no reader, an unbound child or a library context never decides the row", async () => {
  expect((await definition().term({} as TermProbeSource)).observation).toBeUndefined()
  const unbound = await grade({ status: "unavailable", reason: "no marker" })
  expect(unbound.observation).toBeUndefined()
  const invalid = await grade({ status: "invalid", reason: "bad binding" })
  expect(invalid.tests?.[0]?.status).toBe("probe-invalid")
  const lib = definition().lib({} as LibProbeSource)
  expect(lib.observation).toBeUndefined()
  expect(JSON.stringify(lib)).toContain("spawns no application child")
})

// Row 2 (#38699, #38754): a report, valid or invalid, must leave the screen as it was and produce no reply before DA1.
type Mode = "consume" | "leak" | "dead"
const OSC = /\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g

function headlessScreen(
  mode: Mode,
  options?: { shouldLeak?: (reportBytes: string) => string; replyBeforeDa1?: string },
): LibProbeSource {
  let text = ""
  return {
    backendName: "fixture",
    kind: "lib",
    feed(bytes: string) {
      if (bytes.startsWith("\x1b[2J\x1b[H")) text = ""
      const shown = bytes
        .replace("\x1b[2J\x1b[H", "")
        .replace(OSC, (match, code, body) =>
          options?.shouldLeak ? options.shouldLeak(match) : mode === "leak" ? `${code};${body}` : "",
        )
      if (mode !== "dead") text += shown
    },
    feedCapture(bytes: string) {
      if (bytes.endsWith("\x1b[c")) return `${options?.replyBeforeDa1 ?? ""}${DA1}`
      return ""
    },
    getText: () => text,
    getCursor: () => ({ x: text.length, y: 0, visible: true, style: null }),
  } as unknown as LibProbeSource
}

function appScreen(
  mode: Mode,
  options?: { shouldLeak?: (reportBytes: string) => string; replyBeforeDa1?: string },
): TermProbeSource {
  let col = 1
  return {
    write(bytes: string) {
      if (bytes === "\x1b[1;1H\x1b[2K") col = 1
      else if (mode !== "dead") {
        col += bytes.replace(OSC, (match, code, body) =>
          options?.shouldLeak ? options.shouldLeak(match) : mode === "leak" ? `${code};${body}` : "",
        ).length
      }
    },
    queryCursorPosition: async () => (mode === "dead" ? null : { row: 1, col }),
    queryOutcome: async (sequence: string, pattern: RegExp) => {
      if (mode === "dead") return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
      const raw = sequence === "\x1b[c" ? `${options?.replyBeforeDa1 ?? ""}${DA1}` : ""
      return {
        match: pattern.exec(raw),
        reason: "reply" as const,
        raw,
        rawBase64: Buffer.from(raw, "utf8").toString("base64"),
      }
    },
  } as unknown as TermProbeSource
}

function silent(id: string) {
  const found = extensionsProbes.find((item) => item.id === id)
  if (!found?.term || !found.lib) throw new Error(`missing ${id} arms`)
  return found as typeof found & { term: NonNullable<typeof found.term>; lib: NonNullable<typeof found.lib> }
}

test.each(["extensions.osc7577-silent", "extensions.osc88-silent"])(
  "%s: swallowed reports read Supported, printed ones Unsupported, a blind reader no result",
  async (id) => {
    const row = silent(id)
    for (const [arm, run] of [
      ["lib", async (mode: Mode) => row.lib(headlessScreen(mode))],
      ["term", async (mode: Mode) => row.term(appScreen(mode))],
    ] as const) {
      const consumed = await run("consume")
      expect(consumed.observation, `${arm} consume`).toMatchObject({ outcome: "supported" })
      const leaked = await run("leak")
      expect(leaked.observation, `${arm} leak`).toMatchObject({ outcome: "unsupported" })
      expect(leaked.note).toContain("visible")
      const blind = await run("dead")
      expect(blind.observation, `${arm} dead`).toBeUndefined()
      // The run parser admits both outcomes: a JSON state snapshot that is the retained response.
      for (const result of [consumed, leaked]) {
        const assertions = (result.assertions ?? []).map((assertion) => ({
          ...assertion,
          featureId: id,
          rawReplyRef: id,
        }))
        expect(() =>
          validateCurrentAssertions(assertions, { [id]: result.response! }, [], arm, `${arm} ${id}`),
        ).not.toThrow()
      }
    }
    expect(JSON.stringify(definitionText(id))).toContain(id.includes("7577") ? "revision 0.5" : "osc-88")
  },
)

test("extensions.osc7577-silent: sends all six reports (including ?, 2048-byte 64-argv, >8 KiB, and cut-short) and fails if any one prints or if 1 byte of the 2048-byte report reaches the screen", async () => {
  expect(OSC7577_REPORTS).toHaveLength(6)
  expect(OSC7577_RESERVED_QUERY_REPORT).toBe("\x1b]7577;?\x1b\\")
  expect(Buffer.byteLength(OSC7577_2048_BYTE_64_ARGV_REPORT, "utf8")).toBe(2048)
  const argvField = /:argv=([^:]+):/.exec(OSC7577_2048_BYTE_64_ARGV_REPORT)?.[1]
  expect(argvField?.split(",")).toHaveLength(64)
  expect(Buffer.byteLength(OSC7577_OVER_8KIB_REPORT, "utf8")).toBeGreaterThan(8192)
  expect(OSC7577_CUT_SHORT_REPORT).toBe("\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:mac=35cb9098\x1b\\")

  const row = silent("extensions.osc7577-silent")

  // Each of the 6 reports printing individually -> reads Unsupported on both arms.
  for (const report of OSC7577_REPORTS) {
    const shouldLeak = (match: string) => (match === report.bytes ? match.slice(2, -2) : "")
    for (const [arm, result] of [
      ["lib", row.lib(headlessScreen("consume", { shouldLeak }))],
      ["term", await row.term(appScreen("consume", { shouldLeak }))],
    ] as const) {
      expect(status(result, "extensions.osc7577-silent"), `${arm} ${report.label}`).toBe("unsupported")
      expect(result.note).toContain(report.label)
    }
  }

  // 1 byte of the 2048-byte report reaching the screen fails the row on both arms.
  const oneByteLeak = (match: string) => (match === OSC7577_2048_BYTE_64_ARGV_REPORT ? "x" : "")
  for (const [arm, result] of [
    ["lib", row.lib(headlessScreen("consume", { shouldLeak: oneByteLeak }))],
    ["term", await row.term(appScreen("consume", { shouldLeak: oneByteLeak }))],
  ] as const) {
    expect(result.pass, `${arm} 1-byte leak`).toBe(false)
    expect(status(result, "extensions.osc7577-silent"), `${arm} 1-byte leak`).toBe("unsupported")
    expect(result.note).toContain("2048-byte report with 64 argv elements")
  }
})

test("extensions.osc7577-silent: a fake terminal that writes anything before the DA1 reply fails the silent row", async () => {
  const row = silent("extensions.osc7577-silent")
  for (const replyBeforeDa1 of ["\x1b]7577;?\x1b\\", "\x1b]7577;ok\x07", "unexpected"]) {
    for (const [arm, result] of [
      ["lib", row.lib(headlessScreen("consume", { replyBeforeDa1 }))],
      ["term", await row.term(appScreen("consume", { replyBeforeDa1 }))],
    ] as const) {
      expect(result.pass, `${arm} ${JSON.stringify(replyBeforeDa1)}`).toBe(false)
      expect(status(result, "extensions.osc7577-silent"), `${arm} ${JSON.stringify(replyBeforeDa1)}`).toBe(
        "unsupported",
      )
      expect(result.note).toContain("before the DA1 reply")
      const assertions = (result.assertions ?? []).map((assertion) => ({
        ...assertion,
        featureId: "extensions.osc7577-silent",
        rawReplyRef: "extensions.osc7577-silent",
      }))
      expect(() =>
        validateCurrentAssertions(
          assertions,
          { "extensions.osc7577-silent": result.response! },
          [],
          arm,
          `${arm} extensions.osc7577-silent`,
        ),
      ).not.toThrow()
    }
  }
})

test("glossary and linkifyContent: bare OSC 7577 and OSC 88 in any page body link to their glossary targets", () => {
  const glossary = JSON.parse(readFileSync(new URL("../../content/glossary.json", import.meta.url), "utf8")) as Record<
    string,
    { link?: string }
  >
  expect(glossary["OSC 7577"]?.link).toBe("/extensions/osc-7577-program-resume-token")
  expect(glossary["OSC 88"]?.link).toBe("/extensions/osc-88-terminal-resume-silent")
  const linked = linkifyContent("Programs can register a restart command with OSC 7577 or the earlier OSC 88 protocol.")
  expect(linked).toContain('href="/extensions/osc-7577-program-resume-token"')
  expect(linked).toContain(">OSC 7577</a>")
  expect(linked).toContain('href="/extensions/osc-88-terminal-resume-silent"')
  expect(linked).toContain(">OSC 88</a>")
})

function definitionText(id: string) {
  return (
    JSON.parse(readFileSync(new URL("../../content/features.json", import.meta.url), "utf8")) as Record<string, unknown>
  )[id]
}
