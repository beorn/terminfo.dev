/**
 * OSC 7501 Program Status Protocol, spec revision 0.4 (2026-10-10), #38743.
 *
 * Row 1 (`extensions.osc7501-query`): first send a status report carrying a nonce in `id`, `title` and `msg`, then send
 * `OSC 7501 ; ? ST` followed by `CSI c` (DA1). Supported requires a reply starting `OSC 7501 ; ?` before the DA1 reply
 * that does not contain the nonce (`R7501-016`, `R7501-017`, `R7501-023`). No reply before DA1, or a reply after DA1,
 * is Unsupported. A reply containing the nonce fails the row. The parser records optional `states` and `kinds` lists
 * (`R7501-018`–`020`), skips malformed pairs (`R7501-011`), ignores unknown keys (`R7501-012`, `R7501-021`), and lets
 * the last value win when a key repeats (`R7501-013`).
 *
 * Row 2 (`extensions.osc7501-silent`): four reports — ST-terminated, BEL-terminated, largest-legal (~3300 bytes with
 * `id`, `app`, `title` and `msg` at their spec limits), and over the 4096-byte whole-sequence cap — must print nothing
 * and leave the cursor where it was after a printed control (`AB`) proves the screen reader works (`R7501-002`,
 * `R7501-005`, `R7501-024`, `R7501-060`–`067`).
 */
import type {
  AssertionType,
  LibProbeSource,
  ProbeCallbackResult,
  ProbeDefinition,
  TerminalQueryOutcome,
  TermProbeSource,
} from "./types.ts"
import { notTestedResult, probe, readSentinelReply, replyFailure, sentinelNegativeResult } from "./helpers.ts"

export const PROGRAM_STATUS_SPEC = "OSC 7501 spec revision 0.4 (2026-10-10)"

export const OSC7501_ECHO_NONCE = "terminfo-osc7501-nonce"
export const OSC7501_ECHO_NONCE_B64 = Buffer.from(OSC7501_ECHO_NONCE, "utf8").toString("base64")
export const OSC7501_ECHO_REPORT = `\x1b]7501;state=working:id=${OSC7501_ECHO_NONCE}:title=${OSC7501_ECHO_NONCE_B64}:msg=${OSC7501_ECHO_NONCE_B64}\x1b\\`
export const OSC7501_QUERY = "\x1b]7501;?\x1b\\"
export const OSC7501_REPLY_PATTERN = /\x1b\]7501;\?(?::([^\x07\x1b]*))?(?:\x07|\x1b\\)/

export const OSC7501_ALL_STATES = ["idle", "working", "done", "blocked", "error"] as const
export const OSC7501_ALL_KINDS = ["permission", "question", "auth"] as const

const OSC7501_EXPECTED = "OSC 7501 detection reply (ESC ] 7501 ; ? … ST) before DA1 without echoing any status report"

export interface ParsedOsc7501DetectionReply {
  /** Comma-separated state tokens when `states` was present; `null` when absent (all five states). */
  readonly states: string[] | null
  /** Comma-separated kind tokens when `kinds` was present; `null` when absent (all three kinds). */
  readonly kinds: string[] | null
}

/**
 * Parse a complete OSC 7501 `?` detection reply frame according to spec revision 0.4 Syntax and Feature Detection:
 * - Whitespace around keys and values is removed (`R7501-010`).
 * - A malformed `key=value` pair (no `=`, key not `[a-z]+`, or value byte outside `[A-Za-z0-9_.,+/=-]*`) is skipped (`R7501-009`, `R7501-011`).
 * - Unknown keys are ignored (`R7501-012`, `R7501-021`).
 * - If a key repeats, the last value wins (`R7501-013`).
 */
export function parseOsc7501DetectionReply(frame: string): ParsedOsc7501DetectionReply | null {
  const match = /^\x1b\]7501;\?(?::([^\x07\x1b]*))?(?:\x07|\x1b\\)$/.exec(frame)
  if (!match) return null
  const pairs = new Map<string, string>()
  const tail = match[1]
  if (tail !== undefined) {
    for (const segment of tail.split(":")) {
      const eq = segment.indexOf("=")
      if (eq <= 0) continue
      const key = segment.slice(0, eq).trim()
      const value = segment.slice(eq + 1).trim()
      if (!/^[a-z]+$/.test(key) || !/^[A-Za-z0-9_.,+/= \t-]*$/.test(value)) continue
      pairs.set(key, value)
    }
  }
  const listOf = (key: string): string[] | null => {
    const raw = pairs.get(key)
    if (raw === undefined) return null
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  return {
    states: listOf("states"),
    kinds: listOf("kinds"),
  }
}

export function osc7501QueryResult(raw: string, sentinel?: { atMs: number; graceMs: number }): ProbeCallbackResult {
  if (raw.includes(OSC7501_ECHO_NONCE) || raw.includes(OSC7501_ECHO_NONCE_B64)) {
    const note = `OSC 7501 reply stream echoed the probe's status report nonce (${PROGRAM_STATUS_SPEC})`
    return {
      pass: false,
      response: raw,
      note,
      observation: { outcome: "unsupported", assertionType: "query_reply", note },
      assertions: [
        {
          assertionType: "query_reply",
          kind: "negative",
          expected: OSC7501_EXPECTED,
          observed: raw,
        },
      ],
    }
  }

  const read = readSentinelReply(raw, OSC7501_REPLY_PATTERN)
  const beforeDa1 =
    (read.kind === "reply" || (read.kind === "pending" && read.match !== null)) && sentinel === undefined
  if (beforeDa1 && read.match?.[0]) {
    const frame = read.match[0]
    const parsed = parseOsc7501DetectionReply(frame)
    if (parsed !== null) {
      const statesLabel = parsed.states === null ? "all five states" : `states=${parsed.states.join(",")}`
      const kindsLabel = parsed.kinds === null ? "all three kinds" : `kinds=${parsed.kinds.join(",")}`
      const note = `OSC 7501 detection reply before DA1: ${statesLabel}, ${kindsLabel} (${PROGRAM_STATUS_SPEC})`
      return {
        pass: true,
        response: JSON.stringify({
          reply: frame,
          states: parsed.states,
          kinds: parsed.kinds,
        }),
        note,
        observation: { outcome: "supported", assertionType: "query_reply", note },
        assertions: [
          {
            assertionType: "query_reply",
            kind: "positive",
            expected: OSC7501_EXPECTED,
            observed: frame,
          },
        ],
      }
    }
  }

  if ((read.kind === "answered" && read.match !== null) || (sentinel !== undefined && read.match !== null)) {
    const note = `OSC 7501 detection reply arrived after the DA1 reply (${PROGRAM_STATUS_SPEC})`
    return {
      pass: false,
      response: raw,
      note,
      observation: { outcome: "unsupported", assertionType: "query_reply", note },
      assertions: [
        {
          assertionType: "query_reply",
          kind: "negative",
          expected: OSC7501_EXPECTED,
          observed: raw,
        },
      ],
    }
  }

  const silent = sentinelNegativeResult(
    raw,
    read.kind === "answered" && read.match === null ? (sentinel ?? { atMs: 0, graceMs: 0 }) : sentinel,
    OSC7501_EXPECTED,
  )
  if (silent) return silent
  if (raw.length === 0) {
    return { ...replyFailure("no-response"), response: raw }
  }
  const note = `Malformed OSC 7501 reply: ${JSON.stringify(raw)}`
  return {
    pass: false,
    response: raw,
    observation: {
      outcome: "inconclusive",
      reason: "invalid-reply",
      assertionType: "query_reply",
      note,
    },
    tests: [{ id: "criterion", status: "probe-invalid", reason: note }],
  }
}

function osc7501OutcomeResult(outcome: TerminalQueryOutcome, echoedBeforeQuery = ""): ProbeCallbackResult {
  return osc7501QueryResult(echoedBeforeQuery + outcome.raw, outcome.sentinel)
}

export interface Osc7501Report {
  readonly label: string
  readonly bytes: string
}

/**
 * Largest-legal field values under spec revision 0.4 Size Limits (`R7501-060`–`065`):
 * - `id`: 128 bytes total, each `/`-separated segment 1–32 bytes from `[A-Za-z0-9_.+-]`, up to 8 levels deep.
 * - `app`: 32 bytes from `[A-Za-z0-9_.+-]`.
 * - `title`: 256 bytes base64-encoded (192 bytes UTF-8 decoded).
 * - `msg`: 2732 bytes base64-encoded (2048 bytes UTF-8 decoded).
 * Whole sequence is 3218 bytes (~3300 bytes), below the 4096-byte whole-sequence cap.
 */
const MAX_LEGAL_ID = `${"a".repeat(31)}/${"b".repeat(31)}/${"c".repeat(32)}/${"d".repeat(31)}`
const MAX_LEGAL_APP = "a".repeat(32)
const MAX_LEGAL_TITLE_B64 = Buffer.alloc(192, 0x74).toString("base64")
const MAX_LEGAL_MSG_B64 = Buffer.alloc(2048, 0x6d).toString("base64")

export const OSC7501_LARGE_LEGAL_REPORT = `\x1b]7501;state=blocked:kind=permission:progress=100:id=${MAX_LEGAL_ID}:app=${MAX_LEGAL_APP}:title=${MAX_LEGAL_TITLE_B64}:msg=${MAX_LEGAL_MSG_B64}\x1b\\`

/** Whole sequence over the 4096-byte cap (`R7501-060`, `R7501-067`): 4169 bytes total. */
const OVER_CAP_MSG_B64 = Buffer.alloc(3096, 0x78).toString("base64")
export const OSC7501_OVER_CAP_REPORT = `\x1b]7501;state=working:app=terminfo:msg=${OVER_CAP_MSG_B64}\x1b\\`

export const OSC7501_REPORTS: readonly Osc7501Report[] = [
  {
    label: "working report (ST)",
    bytes: "\x1b]7501;state=working:app=terminfo:progress=50\x1b\\",
  },
  {
    label: "blocked report (BEL)",
    bytes: "\x1b]7501;state=blocked:kind=permission:app=terminfo\x07",
  },
  {
    label: "largest-legal report (~3300 bytes, ST)",
    bytes: OSC7501_LARGE_LEGAL_REPORT,
  },
  {
    label: "over-cap report (>4096 bytes, ST)",
    bytes: OSC7501_OVER_CAP_REPORT,
  },
]

function silentResult(
  name: string,
  assertionType: AssertionType,
  readings: readonly { label: string; shown: string }[],
  expected: string,
  control: string,
): ProbeCallbackResult {
  const visible = readings.filter((reading) => reading.shown !== expected)
  const supported = visible.length === 0
  const note = supported
    ? `${name}: every report left the screen unchanged after a printed control moved it`
    : `${name}: visible output after ${visible.map((reading) => reading.label).join(" and ")}`
  const response = JSON.stringify({ control, readings })
  return {
    pass: supported,
    note,
    response,
    observation: { outcome: supported ? "supported" : "unsupported", assertionType, note },
    assertions: [
      {
        assertionType,
        kind: supported ? "positive" : "negative",
        expected: `every report leaves ${expected}`,
        observed: response,
      },
    ],
  }
}

function silentLib(name: string, reports: readonly Osc7501Report[]) {
  return (ctx: LibProbeSource): ProbeCallbackResult => {
    const read = (payload: string) => {
      ctx.feed("\x1b[2J\x1b[H" + payload)
      const cursor = ctx.getCursor()
      return `text ${JSON.stringify(ctx.getText().trim())}, cursor row ${cursor.y} col ${cursor.x}`
    }
    const control = read("AB")
    if (control !== 'text "AB", cursor row 0 col 2') {
      return notTestedResult(`${name}: the screen reader did not show a printed control (${control})`, { control })
    }
    const readings = reports.map((report) => ({ label: report.label, shown: read(report.bytes + "X") }))
    read("")
    return silentResult(name, "buffer_state", readings, 'text "X", cursor row 0 col 1', control)
  }
}

function silentApp(name: string, reports: readonly Osc7501Report[]) {
  return async (ctx: TermProbeSource): Promise<ProbeCallbackResult> => {
    const read = async (payload: string) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write(payload)
      const position = await ctx.queryCursorPosition()
      return position && `cursor row ${position.row} col ${position.col}`
    }
    const control = await read("AB")
    if (control === null) return replyFailure(`${name}: no cursor position reply after a printed control`)
    if (control !== "cursor row 1 col 3") {
      ctx.write("\x1b[1;1H\x1b[2K")
      return notTestedResult(`${name}: the cursor did not follow a printed control (${control})`, { control })
    }
    const readings: { label: string; shown: string }[] = []
    for (const report of reports) {
      const shown = await read(report.bytes)
      if (shown === null) return replyFailure(`${name}: no cursor position reply after the ${report.label}`)
      readings.push({ label: report.label, shown })
    }
    ctx.write("\x1b[1;1H\x1b[2K")
    return silentResult(name, "buffer_state", readings, "cursor row 1 col 1", control)
  }
}

export const programStatusProbes: ProbeDefinition[] = [
  {
    ...probe(
      "extensions.osc7501-query",
      (ctx) => {
        ctx.feed(OSC7501_ECHO_REPORT)
        if (ctx.queryWithSentinelOutcome) {
          return osc7501OutcomeResult(ctx.queryWithSentinelOutcome(OSC7501_QUERY, OSC7501_REPLY_PATTERN))
        }
        const raw = ctx.feedCapture(OSC7501_QUERY)
        return osc7501QueryResult(raw)
      },
      async (ctx) => {
        ctx.write(OSC7501_ECHO_REPORT)
        return osc7501OutcomeResult(await ctx.queryWithSentinelOutcome(OSC7501_QUERY, OSC7501_REPLY_PATTERN))
      },
      "query_reply",
    ),
    libAssertionType: "query_reply",
  },
  {
    ...probe(
      "extensions.osc7501-silent",
      silentLib("OSC 7501", OSC7501_REPORTS),
      silentApp("OSC 7501", OSC7501_REPORTS),
      "buffer_state",
    ),
    libAssertionType: "buffer_state",
  },
]
