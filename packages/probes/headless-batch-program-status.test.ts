/**
 * @failure OSC 7501 program-status detection accepts an echoed report, a reply after DA1, or silence, or the silent row
 *   misses a leaked byte from any of the four status reports (including the ~3300-byte largest-legal report).
 * @level l1
 * @consumer extensions.osc7501-query, extensions.osc7501-silent, and linkifyContent glossary linking (#38743, spec rev 0.4).
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { extensionsProbes } from "../probe-defs/src/extensions.ts"
import {
  OSC7501_ECHO_NONCE,
  OSC7501_ECHO_NONCE_B64,
  OSC7501_ECHO_REPORT,
  OSC7501_LARGE_LEGAL_REPORT,
  OSC7501_OVER_CAP_REPORT,
  OSC7501_QUERY,
  OSC7501_REPORTS,
  parseOsc7501DetectionReply,
} from "../probe-defs/src/program-status.ts"
import { recordExecutedProbe } from "../probe-defs/src/helpers.ts"
import { replayTermProbeSource, type StoredQuery } from "../probe-defs/src/testing/group-harness.ts"
import { validateCurrentAssertions } from "../run-parser/src/observations.ts"
import { linkifyContent } from "../../docs/data/linkify-content.ts"
import type { LibProbeSource, ProbeCallbackResult, TermProbeSource } from "@terminfo/probe-defs"

const DA1 = "\x1b[?62;22c"

function armOf(id: string) {
  const found = extensionsProbes.find((item) => item.id === id)
  if (!found?.term || !found.lib) throw new Error(`missing ${id} arms`)
  return found as typeof found & { term: NonNullable<typeof found.term>; lib: NonNullable<typeof found.lib> }
}

function gradedStatus(featureId: string, result: ProbeCallbackResult) {
  return recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: "2026-11-26T06:00:00.000Z" },
    assertions: (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId })),
    tests: result.tests,
    ...(result.observation && { observation: { ...result.observation, featureId } }),
    ...(result.notTested && { coverage: { ...result.notTested, featureId, rawReplyRef: `${featureId}.response` } }),
  }).status
}

function querySources(raw: string, reason: StoredQuery["reason"] = "reply", sentinel?: StoredQuery["sentinel"]) {
  const fed: string[] = []
  const written: string[] = []
  const lib: LibProbeSource = {
    backendName: "fixture",
    kind: "lib",
    feed(bytes: string) {
      fed.push(bytes)
    },
    feedCapture(bytes: string) {
      fed.push(bytes)
      return raw
    },
    queryWithSentinelOutcome(sequence: string, pattern: RegExp) {
      fed.push(sequence)
      return {
        match: reason === "reply" ? pattern.exec(raw) : null,
        reason,
        raw,
        rawBase64: Buffer.from(raw, "utf8").toString("base64"),
        ...(sentinel !== undefined && { sentinel }),
      }
    },
  } as unknown as LibProbeSource

  const term = replayTermProbeSource(
    new Map<string, StoredQuery>([
      [
        OSC7501_QUERY,
        {
          sequence: OSC7501_QUERY,
          match: reason === "reply" ? [raw] : null,
          reason,
          raw,
          ...(sentinel !== undefined && { sentinel }),
        },
      ],
    ]),
    {
      write(bytes: string) {
        written.push(bytes)
      },
    },
  )

  return { lib, term, fed, written }
}

test("extensions.osc7501-query: a reply before DA1 reads Supported, records states and kinds when present or null when absent, and ignores unknown keys", async () => {
  const queryRow = armOf("extensions.osc7501-query")

  // Bare detection reply: states and kinds omitted -> both recorded as null (all five states, all three kinds).
  for (const reply of ["\x1b]7501;?\x1b\\", "\x1b]7501;?\x07", "\x1b]7501;?:future=1:malformed\x1b\\"]) {
    const raw = `${reply}${DA1}`
    const { lib, term, fed, written } = querySources(raw, "reply")
    const libResult = queryRow.lib(lib)
    const termResult = await queryRow.term(term)
    expect(fed).toEqual([OSC7501_ECHO_REPORT, OSC7501_QUERY])
    expect(written).toEqual([OSC7501_ECHO_REPORT])
    for (const [arm, result] of [
      ["lib", libResult],
      ["term", termResult],
    ] as const) {
      expect(gradedStatus("extensions.osc7501-query", result), `${arm} ${JSON.stringify(reply)}`).toBe("supported")
      expect(JSON.parse(result.response!), `${arm} response`).toEqual({
        reply,
        states: null,
        kinds: null,
      })
      expect(result.note).toContain("all five states")
      expect(result.note).toContain("all three kinds")
    }
  }

  // Subsets of states and kinds, unknown keys ignored, whitespace trimmed, duplicate keys last-wins.
  const subsetReply =
    "\x1b]7501;?:states=idle,working:states = working, done, error :kinds = permission, question :vendor=rex:BAD_KEY=1:noequals\x1b\\"
  const parsed = parseOsc7501DetectionReply(subsetReply)
  expect(parsed).toEqual({
    states: ["working", "done", "error"],
    kinds: ["permission", "question"],
  })
  const { lib, term } = querySources(`${subsetReply}${DA1}`, "reply")
  for (const result of [queryRow.lib(lib), await queryRow.term(term)]) {
    expect(gradedStatus("extensions.osc7501-query", result)).toBe("supported")
    expect(JSON.parse(result.response!)).toEqual({
      reply: subsetReply,
      states: ["working", "done", "error"],
      kinds: ["permission", "question"],
    })
  }
})

test("extensions.osc7501-query: a fake terminal that replies after DA1, or not at all, reads Unsupported", async () => {
  const queryRow = armOf("extensions.osc7501-query")

  // Reply after DA1 (R7501-016, R7501-023): DA1 arrives first, then OSC 7501 ; ? ST.
  const lateRaw = `${DA1}\x1b]7501;?\x1b\\`
  const late = querySources(lateRaw, "reply", { atMs: 4, graceMs: 250 })
  for (const [arm, result] of [
    ["lib", queryRow.lib(late.lib)],
    ["term", await queryRow.term(late.term)],
  ] as const) {
    expect(gradedStatus("extensions.osc7501-query", result), `${arm} late reply`).toBe("unsupported")
    expect(result.observation?.outcome, `${arm} late observation`).toBe("unsupported")
    expect(result.note).toContain("after the DA1 reply")
  }

  // No reply at all before DA1 (only DA1 answers the sentinel fence).
  const silent = querySources(DA1, "sentinel", { atMs: 3, graceMs: 250 })
  for (const [arm, result] of [
    ["lib", queryRow.lib(silent.lib)],
    ["term", await queryRow.term(silent.term)],
  ] as const) {
    expect(gradedStatus("extensions.osc7501-query", result), `${arm} silent`).toBe("unsupported")
  }
})

test("extensions.osc7501-query: a fake terminal that echoes the probe's report back into the reply stream fails the query row", async () => {
  const queryRow = armOf("extensions.osc7501-query")
  const echoedPayloads = [
    // Terminal echoes the full report before answering the detection query and DA1
    `${OSC7501_ECHO_REPORT}\x1b]7501;?\x1b\\${DA1}`,
    // Terminal echoes the plain id nonce inside the detection reply
    `\x1b]7501;?:states=working:id=${OSC7501_ECHO_NONCE}\x1b\\${DA1}`,
    // Terminal echoes the base64 title/msg nonce in the reply stream
    `${OSC7501_ECHO_NONCE_B64}\x1b]7501;?\x1b\\${DA1}`,
  ]

  for (const raw of echoedPayloads) {
    const { lib, term } = querySources(raw, "reply")
    for (const [arm, result] of [
      ["lib", queryRow.lib(lib)],
      ["term", await queryRow.term(term)],
    ] as const) {
      expect(result.pass, `${arm} pass on echoed report`).toBe(false)
      expect(gradedStatus("extensions.osc7501-query", result), `${arm} status on echoed report`).toBe("unsupported")
      expect(result.observation?.outcome, `${arm} observation on echoed report`).toBe("unsupported")
      expect(result.note).toContain("echoed")
    }
  }
})

const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

function fakeSilentSources(shouldLeak: (reportBytes: string) => string) {
  let text = ""
  let col = 1
  const lib: LibProbeSource = {
    backendName: "fixture",
    kind: "lib",
    feed(bytes: string) {
      if (bytes.startsWith("\x1b[2J\x1b[H")) text = ""
      const body = bytes.replace("\x1b[2J\x1b[H", "")
      text += body.replace(OSC_PATTERN, (match) => shouldLeak(match))
    },
    getText: () => text,
    getCursor: () => ({ x: text.length, y: 0, visible: true, style: null }),
  } as unknown as LibProbeSource

  const term: TermProbeSource = {
    write(bytes: string) {
      if (bytes === "\x1b[1;1H\x1b[2K") {
        col = 1
        return
      }
      col += bytes.replace(OSC_PATTERN, (match) => shouldLeak(match)).length
    },
    queryCursorPosition: async () => ({ row: 1, col }),
  } as unknown as TermProbeSource

  return { lib, term }
}

test("extensions.osc7501-silent: swallows all four reports for Supported; fails if any of the four reports prints", async () => {
  expect(OSC7501_REPORTS).toHaveLength(4)
  expect(OSC7501_LARGE_LEGAL_REPORT.length).toBeGreaterThanOrEqual(3200)
  expect(OSC7501_LARGE_LEGAL_REPORT.length).toBeLessThanOrEqual(4096)
  expect(OSC7501_OVER_CAP_REPORT.length).toBeGreaterThan(4096)

  const silentRow = armOf("extensions.osc7501-silent")

  // All 4 swallowed -> Supported on both arms.
  const swallowed = fakeSilentSources(() => "")
  for (const [arm, result] of [
    ["lib", silentRow.lib(swallowed.lib)],
    ["term", await silentRow.term(swallowed.term)],
  ] as const) {
    expect(gradedStatus("extensions.osc7501-silent", result), `${arm} swallowed`).toBe("supported")
    expect(result.observation?.outcome).toBe("supported")
    const assertions = (result.assertions ?? []).map((assertion) => ({
      ...assertion,
      featureId: "extensions.osc7501-silent",
      rawReplyRef: "extensions.osc7501-silent",
    }))
    expect(() =>
      validateCurrentAssertions(
        assertions,
        { "extensions.osc7501-silent": result.response! },
        [],
        arm,
        `${arm} extensions.osc7501-silent`,
      ),
    ).not.toThrow()
  }

  // Each of the 4 reports individually printing -> fails the silent row on both arms.
  for (const report of OSC7501_REPORTS) {
    const leakedOne = fakeSilentSources((match) => (match === report.bytes ? match.slice(2, -2) : ""))
    for (const [arm, result] of [
      ["lib", silentRow.lib(leakedOne.lib)],
      ["term", await silentRow.term(leakedOne.term)],
    ] as const) {
      expect(result.pass, `${arm} ${report.label}`).toBe(false)
      expect(gradedStatus("extensions.osc7501-silent", result), `${arm} ${report.label}`).toBe("unsupported")
      expect(result.note).toContain(report.label)
    }
  }
})

test("extensions.osc7501-silent: the ~3300-byte largest-legal report fails the row when one byte of it reaches the screen", async () => {
  const silentRow = armOf("extensions.osc7501-silent")
  // Fake terminal whose OSC buffer overflows by 1 byte on the ~3300-byte report and prints a single byte to the screen.
  const oneByteLeak = fakeSilentSources((match) => (match === OSC7501_LARGE_LEGAL_REPORT ? "m" : ""))
  for (const [arm, result] of [
    ["lib", silentRow.lib(oneByteLeak.lib)],
    ["term", await silentRow.term(oneByteLeak.term)],
  ] as const) {
    expect(result.pass, `${arm} 1-byte leak`).toBe(false)
    expect(gradedStatus("extensions.osc7501-silent", result), `${arm} 1-byte leak`).toBe("unsupported")
    expect(result.observation?.outcome).toBe("unsupported")
    expect(result.note).toContain("largest-legal report (~3300 bytes, ST)")
  }
})

test("glossary and linkifyContent: bare OSC 7501 in feature prose links to /extensions/osc-7501-program-status-query", () => {
  const glossary = JSON.parse(readFileSync(new URL("../../content/glossary.json", import.meta.url), "utf8")) as Record<
    string,
    { link?: string }
  >
  expect(glossary["OSC 7501"]?.link).toBe("/extensions/osc-7501-program-status-query")
  const linked = linkifyContent("Programs can report task progress with OSC 7501 in supporting terminals.")
  expect(linked).toContain('href="/extensions/osc-7501-program-status-query"')
  expect(linked).toContain(">OSC 7501</a>")
})
