import { AsyncLocalStorage } from "node:async_hooks"
import { openSync } from "node:fs"
import { WriteStream } from "node:tty"
import { createCallLog, withCallLog, readCallLog, IncompleteReplay, type CallLog } from "viprobe"
import type { TerminalQueryOutcome, Utf8DecodingReading, RenderedWidthResult } from "@terminfo/probe-defs"
import {
  decrpmReplyPattern,
  decrpmStatus,
  readSentinelReply,
  sentinelAnswer,
  sentinelGraceMs,
} from "@terminfo/probe-defs"

/**
 * TTY utilities — raw mode, response reading, escape sequence I/O.
 *
 * The core primitive: write an escape sequence to the active TTY output, read a response
 * from stdin within a timeout.
 */

/**
 * Read a response matching a pattern from stdin within a timeout.
 * Must be called while stdin is in raw mode.
 */
const ttyOperations = new WeakMap<typeof process.stdin, Promise<void>>()
type TTYOperationLease = {
  active: boolean
  out: NodeJS.WriteStream
  verify?: () => Promise<void>
  startResponseTimer?: () => void
}
const operationContext = new AsyncLocalStorage<TTYOperationLease>()
const collectorOpenedControllingOutputs = new WeakSet<NodeJS.WriteStream>()

/** Open the controlling terminal for CLI runs whose stdout carries JSON. */
export function openControllingTTY(): WriteStream {
  if (!process.stdin.isTTY) throw new Error("JSON/file collection requires interactive TTY stdin for probe replies")
  const ttyPath = process.platform === "win32" ? "CONOUT$" : "/dev/tty"
  let fd: number
  try {
    fd = openSync(ttyPath, "w")
  } catch (error) {
    throw new Error(
      `Cannot open controlling ${ttyPath} before probing: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const out = new WriteStream(fd)
  collectorOpenedControllingOutputs.add(out)
  return out
}

/** Only the collector's own /dev/tty opener may use the Linux alias-device case. */
export function wasCollectorOpenedControllingTTY(out: NodeJS.WriteStream): boolean {
  return collectorOpenedControllingOutputs.has(out)
}
export interface TTYQueryTrace {
  sequence: string
  timeoutMs: number
  reason: QueryOutcome["reason"]
  raw: string
  rawBase64: string
  match: string[] | null
  /** The DA1 sentinel arrived before this query's reply, with the measured ordering facts. */
  sentinel?: { atMs: number; graceMs: number }
}
export type TTYTraceEvent = { kind: "write"; sequence: string } | ({ kind: "query" } & TTYQueryTrace)
type RecordedResponse = { response: QueryOutcome; eventAtPerformanceMs: number }
const nativeTTYHost = {
  write(sequence: string, _purpose: "command" | "query"): void {
    currentTTYOutput().write(sequence)
  },
  matchResponse: matchResponseNative,
}
const queryTraceContext = new AsyncLocalStorage<{ host: typeof nativeTTYHost }>()

/** Standalone helpers intentionally use native I/O outside a recording/replay scope. */
function ttyHost(): typeof nativeTTYHost {
  return queryTraceContext.getStore()?.host ?? nativeTTYHost
}

function traceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function projectedQuery(value: unknown): QueryOutcome {
  if (
    !traceRecord(value) ||
    !["reply", "timeout", "sentinel"].includes(String(value.reason)) ||
    typeof value.raw !== "string" ||
    typeof value.rawBase64 !== "string" ||
    !(value.match === null || (Array.isArray(value.match) && value.match.every((item) => typeof item === "string")))
  ) {
    throw new IncompleteReplay("TTY call log contains an invalid query outcome")
  }
  const sentinel = value.sentinel
  let measuredSentinel: QueryOutcome["sentinel"]
  if (sentinel !== undefined) {
    if (
      !traceRecord(sentinel) ||
      typeof sentinel.atMs !== "number" ||
      !Number.isFinite(sentinel.atMs) ||
      typeof sentinel.graceMs !== "number" ||
      !Number.isFinite(sentinel.graceMs)
    ) {
      throw new IncompleteReplay("TTY call log contains invalid sentinel timing")
    }
    measuredSentinel = { atMs: sentinel.atMs, graceMs: sentinel.graceMs }
  }
  return {
    reason: value.reason as QueryOutcome["reason"],
    raw: value.raw,
    rawBase64: value.rawBase64,
    match: value.match === null ? null : [...value.match],
    ...(measuredSentinel === undefined ? {} : { sentinel: measuredSentinel }),
  }
}

/** The generic reader owns decoding; this host only projects its own operation contract. */
function projectTTYLog(log: CallLog): { queries: TTYQueryTrace[]; events: TTYTraceEvent[] } {
  const rows: Array<{ at: number; index: number; event: TTYTraceEvent }> = []
  let index = 0
  readCallLog(JSON.parse(JSON.stringify(log)), {
    onOperation(operation) {
      const position = index++
      if (operation.path === "context.write") {
        const [sequence, purpose] = operation.args
        if (typeof sequence !== "string" || (purpose !== "command" && purpose !== "query")) {
          throw new IncompleteReplay("TTY call log contains invalid write arguments")
        }
        if (purpose === "command") {
          rows.push({
            at: operation.outcome.timing.startedPerformanceMs,
            index: position,
            event: { kind: "write", sequence },
          })
        }
      } else if (operation.path === "context.matchResponse" && "value" in operation.outcome) {
        const value = operation.outcome.value
        const sequence = operation.args[4]
        const timeoutMs = operation.args[1]
        if (
          typeof sequence !== "string" ||
          typeof timeoutMs !== "number" ||
          !traceRecord(value) ||
          typeof value.eventAtPerformanceMs !== "number" ||
          !Number.isFinite(value.eventAtPerformanceMs)
        ) {
          throw new IncompleteReplay("TTY call log contains invalid response ordering")
        }
        rows.push({
          at: value.eventAtPerformanceMs,
          index: position,
          event: { kind: "query", sequence, timeoutMs, ...projectedQuery(value.response) },
        })
      }
    },
  })
  rows.sort((left, right) => left.at - right.at || left.index - right.index)
  const events = rows.map((row) => row.event)
  const queries = events.flatMap((event) => {
    if (event.kind !== "query") return []
    const { kind: _kind, ...query } = event
    return [query]
  })
  return { events, queries }
}

/** Scope all direct and helper queries to the probe that initiated them. */
export async function withTTYQueryTrace<T>(
  queries: TTYQueryTrace[],
  events: TTYTraceEvent[],
  fn: () => Promise<T>,
  options?: { mode?: "record" | "replay"; log?: CallLog; onLog?: (log: CallLog) => void },
): Promise<T> {
  const mode = options?.mode ?? "record"
  if (mode === "replay" && !options?.log) throw new IncompleteReplay("TTY replay requires a validated call log")
  const log = options?.log ?? createCallLog()
  const session =
    mode === "record"
      ? withCallLog(nativeTTYHost, { mode, log })
      : withCallLog<typeof nativeTTYHost>(null, { mode, log })
  let scopeFailure: unknown
  let scopeFailed = false
  try {
    return await queryTraceContext.run({ host: session.context }, fn)
  } catch (error) {
    scopeFailed = true
    scopeFailure = error
    throw error
  } finally {
    try {
      session.finish()
    } catch (error) {
      if (scopeFailed && error instanceof IncompleteReplay) {
        error.cause = scopeFailure
        const reason = scopeFailure instanceof Error ? scopeFailure.message : String(scopeFailure)
        error.message = "TTY trace could not finish: " + error.message + "; scope failed: " + reason
      }
      throw error
    }
    const projected = projectTTYLog(log)
    queries.push(...projected.queries)
    events.push(...projected.events)
    if (!scopeFailed) options?.onLog?.(log)
  }
}

/** Serialize whole terminal operations; queries inside one operation run inline. */
export function withTTYOperation<T>(
  fn: () => Promise<T>,
  out?: NodeJS.WriteStream,
  verify?: () => Promise<void>,
): Promise<T> {
  const execute = (lease: TTYOperationLease) =>
    operationContext.run(lease, async () => {
      try {
        await lease.verify?.()
        lease.startResponseTimer?.()
        return await fn()
      } finally {
        lease.active = false
      }
    })
  const active = operationContext.getStore()
  if (active?.active) {
    if (out && out !== active.out) throw new Error("Nested TTY operation changed output stream")
    const check = verify ?? active.verify
    return check || active.startResponseTimer
      ? execute({ active: true, out: active.out, verify: check, startResponseTimer: active.startResponseTimer })
      : fn()
  }
  const previous = ttyOperations.get(process.stdin) ?? Promise.resolve()
  const current = previous
    .catch(() => {})
    .then(() => {
      return execute({ active: true, out: out ?? process.stdout, ...(verify && { verify }) })
    })
  ttyOperations.set(
    process.stdin,
    current.then(
      () => undefined,
      () => undefined,
    ),
  )
  return current
}

function currentTTYOutput(): NodeJS.WriteStream {
  const lease = operationContext.getStore()
  return lease?.active ? lease.out : process.stdout
}

export function writeTTY(sequence: string): void {
  ttyHost().write(sequence, "command")
}

async function matchResponse(
  pattern: RegExp,
  timeoutMs: number,
  write?: () => void,
  sentinel = false,
  sequence = "",
  graceMs: number = sentinelGraceMs(),
  deferTimer?: (start: () => void, cancel: () => void) => void,
): Promise<QueryOutcome> {
  return (await ttyHost().matchResponse(pattern, timeoutMs, write, sentinel, sequence, graceMs, deferTimer)).response
}

function matchResponseNative(
  pattern: RegExp,
  timeoutMs: number,
  write?: () => void,
  sentinel = false,
  sequence = "",
  graceMs: number = sentinelGraceMs(),
  deferTimer?: (start: () => void, cancel: () => void) => void,
): Promise<RecordedResponse> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let buf = ""
    let settled = false
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let writeAt = 0
    let sentinelFacts: { atMs: number; graceMs: number } | null = null
    let sentinelStart: number | undefined

    const cleanup = () => {
      clearTimeout(deadlineTimer)
      clearTimeout(graceTimer)
      process.stdin.off("data", onData)
    }

    const finish = (
      match: string[] | null,
      reason: QueryOutcome["reason"],
      facts: { atMs: number; graceMs: number } | null = null,
    ) => {
      if (settled) return
      settled = true
      cleanup()
      const outcome = {
        match,
        reason,
        raw: buf,
        rawBase64: Buffer.concat(chunks).toString("base64"),
        ...(facts ? { sentinel: facts } : {}),
      }
      // Observe arrival here, before an injection can write again in the same turn.
      resolve({ response: outcome, eventAtPerformanceMs: performance.now() })
    }

    const onData = (chunk: Buffer) => {
      if (settled) return
      chunks.push(Buffer.from(chunk))
      buf = Buffer.concat(chunks).toString()
      if (!sentinel) {
        const match = buf.match(pattern)
        if (match) finish([...match], "reply")
        return
      }
      // The headless collector reads its captures with this same rule (#30554).
      const read = readSentinelReply(buf, pattern)
      if (read.kind === "pending") return
      // A frame ahead of the sentinel's answer is final: a later DA1 answer only moves that answer later.
      if (read.kind === "reply") {
        finish(read.match, "reply")
        return
      }
      // DA1 answered and no reply preceded it. Keep reading for the grace window, then decide on the whole
      // read (#30559, @cto 86260f80): a later DA1-shaped answer makes everything before it the reply. A
      // reply inside the window still grades by the reply, carrying the ordering note; anything else,
      // bytes ahead of the answer included, is the sentinel outcome, which the grader records as "negative
      // by sentinel", citing these numbers, only when nothing preceded the answer. The facts time the
      // sentinel's own answer, so a later DA1-shaped answer re-stamps them (@cto a40ae9b7).
      const start = sentinelAnswer(buf)?.start
      if (sentinelFacts === null || start !== sentinelStart) {
        sentinelStart = start
        sentinelFacts = { atMs: Date.now() - writeAt, graceMs }
      }
      // Two timers (#30625, @cto a40ae9b7): the deadline set at the write is never extended, and each
      // chunk may only restart the grace window up to it. A read cut by the deadline is decided by the
      // same rule over the whole read, never as a timeout once DA1 has answered.
      clearTimeout(graceTimer)
      const untilDeadline = writeAt + timeoutMs - Date.now()
      graceTimer = setTimeout(
        () =>
          finish(
            read.match,
            read.match ? "reply" : "sentinel",
            // A window cut short proves nothing about the configured silence (@cto 30625 b050f6b9):
            // the facts carry only when the OBSERVED interval covers the full grace, decided by the
            // measurement, never by which timer happened to fire. A matched reply always keeps its
            // DA1-before-reply ordering facts, or late-reply grading breaks.
            read.match ? sentinelFacts : eligibleFacts(),
          ),
        Math.max(0, Math.min(graceMs, untilDeadline)),
      )
    }

    const eligibleFacts = () =>
      sentinelFacts !== null && Date.now() - (writeAt + sentinelFacts.atMs) >= sentinelFacts.graceMs
        ? sentinelFacts
        : null

    const decideAtDeadline = () => {
      if (settled) return
      if (!sentinel) {
        const match = buf.match(pattern)
        finish(match ? [...match] : null, match ? "reply" : "timeout")
        return
      }
      const read = readSentinelReply(buf, pattern)
      if (read.kind === "reply") {
        // A matched reply keeps its DA1-before-reply ordering facts even when the deadline ends the read;
        // only a sentinel outcome needs the full observed window (@cto 30625 b050f6b9).
        finish(read.match, "reply", sentinelFacts)
        return
      }
      const answered = sentinelAnswer(buf) !== null
      finish(
        read.match,
        read.match ? "reply" : answered ? "sentinel" : "timeout",
        read.match ? sentinelFacts : answered ? eligibleFacts() : null,
      )
    }

    const startTimer = () => {
      if (settled || deadlineTimer !== undefined) return
      deadlineTimer = setTimeout(decideAtDeadline, timeoutMs)
    }
    if (deferTimer) {
      deferTimer(startTimer, () => {
        settled = true
        cleanup()
      })
    } else startTimer()

    process.stdin.on("data", onData)
    writeAt = Date.now()
    try {
      write?.()
    } catch (error) {
      cleanup()
      throw error
    }
  })
}

export function readResponse(
  pattern: RegExp,
  timeoutMs: number,
  inject?: () => Promise<void>,
): Promise<string[] | null> {
  return withTTYOperation(async () => {
    let start!: () => void
    let cancel!: () => void
    const outcome = matchResponse(pattern, timeoutMs, undefined, false, "", undefined, (arm, release) => {
      start = arm
      cancel = release
    })
    // withTTYOperation enters its context before invoking this body.
    const lease = operationContext.getStore() as TTYOperationLease
    const previous = lease.startResponseTimer
    // The existing nested injection lease checks custody, then arms this already-listening reader.
    lease.startResponseTimer = start
    try {
      if (inject) await inject()
      start() // Direct inject callbacks and read-only waits have no nested lease.
      return (await outcome).match
    } catch (error) {
      cancel()
      throw error
    } finally {
      lease.startResponseTimer = previous
    }
  })
}

/**
 * Send an escape sequence and read the response.
 */
export async function query(sequence: string, responsePattern: RegExp, timeoutMs = 1000): Promise<string[] | null> {
  return (await queryOutcome(sequence, responsePattern, timeoutMs)).match
}

/**
 * DA1 response pattern — universally supported by all modern terminals.
 * Used as a sentinel: if DA1 arrives without the expected response, the
 * terminal has not answered before the end marker. This alone does not prove
 * that a feature is unsupported.
 */
export type QueryOutcome = TerminalQueryOutcome

/** Return the response disposition and exact received bytes for a plain query. */
export async function queryOutcome(sequence: string, responsePattern: RegExp, timeoutMs = 1000): Promise<QueryOutcome> {
  return withTTYOperation(() =>
    matchResponse(responsePattern, timeoutMs, () => ttyHost().write(sequence, "query"), false, sequence),
  )
}

/** Preserve the reason for a missing reply; DA1 is only an end marker. */
export async function queryWithSentinelOutcome(
  sequence: string,
  responsePattern: RegExp,
  timeoutMs = 2000,
  graceMs: number = sentinelGraceMs(),
): Promise<QueryOutcome> {
  // DA1 is the requested answer here; a second DA1 cannot distinguish it from a sentinel.
  if (sequence === "\x1b[c") {
    return queryOutcome(sequence, responsePattern, timeoutMs)
  }
  return withTTYOperation(() =>
    matchResponse(
      responsePattern,
      timeoutMs,
      () => ttyHost().write(sequence + "\x1b[c", "query"),
      true,
      sequence + "\x1b[c",
      graceMs,
    ),
  )
}

/**
 * Query with DA1 sentinel — faster than timeout-based detection.
 *
 * Sends the query sequence followed by DA1 (ESC [ c). Reads responses
 * looking for either the expected response OR the DA1 sentinel:
 * - If the query response arrives first → feature is supported, return match
 * - If DA1 arrives first (without query response) → no reply, return null
 * - If timeout expires → return null (fallback safety net)
 *
 * Inspired by terminal-colorsaurus. Turns 1000ms timeouts into near-instant
 * negative detection for unsupported features.
 */
export async function queryWithSentinel(
  sequence: string,
  responsePattern: RegExp,
  timeoutMs = 2000,
): Promise<string[] | null> {
  const outcome = await queryWithSentinelOutcome(sequence, responsePattern, timeoutMs)
  return outcome.match
}

/**
 * Query cursor position via DSR 6 (Device Status Report).
 * Returns [row, col] (1-based) or null if no response.
 */
export async function queryCursorPosition(): Promise<[number, number] | null> {
  const match = await query("\x1b[6n", /\x1b\[(\d+);(\d+)R/)
  if (!match?.[1] || !match[2]) return null
  return [parseInt(match[1], 10), parseInt(match[2], 10)]
}

/**
 * Measure from a verified 1;1 origin, rejecting a sample that wraps to another row.
 */
export async function measureRenderedWidth(text: string): Promise<RenderedWidthResult> {
  return withTTYOperation(async () => {
    writeTTY("\x1b7")
    try {
      writeTTY("\x1b[2;1H")
      const secondRow = await queryCursorPosition()
      if (!secondRow) return { kind: "no-reply", step: "origin" }
      if (secondRow[0] !== 2 || secondRow[1] !== 1) {
        return { kind: "control-mismatch", step: "origin", observed: { row: secondRow[0], col: secondRow[1] } }
      }

      writeTTY("\x1b[1;1HA")
      const ascii = await queryCursorPosition()
      if (!ascii) return { kind: "no-reply", step: "ascii" }
      if (ascii[0] !== 1 || ascii[1] !== 2) {
        return { kind: "control-mismatch", step: "ascii", observed: { row: ascii[0], col: ascii[1] } }
      }

      writeTTY("\x1b[1;1H" + text)
      const pos = await queryCursorPosition()
      if (!pos) return { kind: "no-reply", step: "sample" }
      if (pos[0] > 1) return { kind: "wrapped", observed: { row: pos[0], col: pos[1] } }
      if (pos[0] !== 1 || !Number.isSafeInteger(pos[1]) || pos[1] <= 1) {
        return { kind: "control-mismatch", step: "sample", observed: { row: pos[0], col: pos[1] } }
      }

      writeTTY("A")
      const next = await queryCursorPosition()
      if (!next) return { kind: "no-reply", step: "trailing" }
      if (next[0] > 1) return { kind: "wrapped", observed: { row: next[0], col: next[1] } }
      if (next[0] !== 1 || next[1] !== pos[1] + 1) {
        return { kind: "control-mismatch", step: "trailing", observed: { row: next[0], col: next[1] } }
      }
      return pos[1] - 1
    } finally {
      writeTTY("\x1b8")
    }
  })
}

/**
 * The sample the decode-context measurement writes: ë, LATIN SMALL LETTER E WITH DIAERESIS. It is
 * chosen so that NO legitimate width policy can forge either reading (#28752, @dev/review2), which
 * the earlier sample U+00E9 could not promise: é is East Asian Width A, and xterm's cjkWidth
 * legally advances an Ambiguous character two cells in genuine UTF-8, which read as a false 8-bit
 * context and made nine plain-written rows inconclusive under a wrong diagnosis. Each citation is
 * from EastAsianWidth-18.0.0.txt (unicode.org/Public/UCD/latest), with its line number:
 *   - U+00EB is Neutral — line 112: "00EB ; N" — so UTF-8 advances exactly one cell.
 *   - Its UTF-8 byte C3 is ISO-8859-1 U+00C3 'Ã', Neutral — line 99: "00C0..00C5 ; N".
 *   - Its UTF-8 byte AB is ISO-8859-1 U+00AB '«', Neutral — line 82: "00AB ; N".
 *   - The replaced U+00E9 is Ambiguous — line 111: "00E8..00EA ; A".
 * Thus an 8-bit context advances exactly two cells whether or not Ambiguous characters widen.
 * One cell is therefore UTF-8 and two cells is 8-bit BY DATA, not by assumption. Any other advance
 * is evidence outside BOTH hypotheses: a width policy can widen neither Neutral sample byte, so a
 * three-cell (or wildly larger) cursor move is an answered coordinate this measurement cannot read
 * and is recorded `unusable`, never a diagnosis (@dev/review2 2026-10-14 — a 3- or 998-cell advance
 * had been falsely read as 8-bit).
 */
export const UTF8_DECODE_SAMPLE = "\u00eb"

/**
 * Measure how this terminal decodes a plainly written two-byte UTF-8 character — the CONTEXT a
 * pixel oracle assumes when it compares a sequence with the same terminal's rendering of the
 * literal glyph (#28752). A UTF-8 context advances the cursor one cell per code point; a terminal
 * in an 8-bit (ISO-8859-1) locale advances one cell per BYTE, so an expected frame written plainly
 * paints a different string from the one the row claims. Measured, never assumed, through the same
 * DSR 6n round trip the width probe already uses. The two ways this run can fail to measure are
 * NAMED apart: `silent` for a cursor report that never arrived, `unusable` for one that arrived
 * where the measurement cannot read it — an answered-but-unreadable reply is never recorded as
 * silence (@dev/review2).
 */
export async function measureUtf8Decoding(): Promise<Utf8DecodingReading> {
  return withTTYOperation(async () => {
    writeTTY("\x1b7")
    let painted = false
    try {
      writeTTY("\x1b[2;1H")
      const origin = await queryCursorPosition()
      if (origin === null) return "silent"
      // Answered, but not at the cell this measurement paints: nothing can be read from it.
      if (origin[0] !== 2 || origin[1] !== 1) return "unusable"
      // Two UTF-8 bytes: one cell decoded as UTF-8, two cells decoded as ISO-8859-1 (see the
      // sample's own note for why neither reading can come from a width policy).
      // Default SGR first: an erase inherits the current background, so a glyph painted in a
      // caller's colours would leave a coloured blank behind instead of the screen it found.
      writeTTY(`\x1b[0m${UTF8_DECODE_SAMPLE}`)
      painted = true
      const position = await queryCursorPosition()
      if (position === null) return "silent"
      if (position[0] !== 2) return "unusable"
      // A sample that did not advance at all is an answered coordinate this cannot read, never a
      // decoding: neither hypothesis predicts a zero-cell advance.
      if (position[1] <= 1) return "unusable"
      // One cell is UTF-8; two cells is the byte-by-byte 8-bit decode BY DATA (the sample's own
      // note establishes both its UTF-8 form and its two split bytes are Neutral, so no width policy
      // can forge either). Any LARGER advance answers outside both hypotheses — evidence this
      // measurement cannot read — so it is `unusable`, never a diagnosis (@dev/review2 2026-10-14).
      if (position[1] === 2) return "utf8"
      if (position[1] === 3) return "8-bit"
      return "unusable"
    } finally {
      // This measurement writes into whatever screen the calling row inherited. The batch has no
      // between-row reset of its own: every compared region is preceded by the row's own clear (the
      // seed strings in charsets.ts, written as each step's first write in region-readback.ts). So
      // the measurement erases exactly the cells it painted -- ECH 2 covers the one UTF-8 cell and
      // the two ISO-8859-1 cells -- before restoring the cursor, and no later row can inherit a
      // stray glyph. (#28752, @cto)
      if (painted) writeTTY("\x1b[2;1H\x1b[2X")
      writeTTY("\x1b8")
    }
  })
}

/**
 * Query whether a DEC private mode is recognized via DECRPM.
 * Uses DA1 sentinel for fast negative detection.
 * Returns "set", "reset", "unknown", or null (no response).
 */
export async function queryMode(modeNumber: number): Promise<"set" | "reset" | "unknown" | null> {
  const match = await queryWithSentinel(`\x1b[?${modeNumber}$p`, decrpmReplyPattern(modeNumber))
  if (!match) return null
  return decrpmStatus(match[1])
}

/**
 * Drain all pending bytes from stdin (late-arriving escape sequence responses).
 * Waits up to `ms` milliseconds for bytes to stop arriving.
 */
export async function drainStdin(ms = 300): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdin.readable) {
      resolve()
      return
    }
    process.stdin.resume()
    let timer = setTimeout(done, ms)
    function onData() {
      while (process.stdin.read() !== null) {} // discard
      clearTimeout(timer)
      timer = setTimeout(done, ms) // reset timer on each new data
    }
    function done() {
      process.stdin.removeListener("readable", onData)
      resolve()
    }
    process.stdin.on("readable", onData)
  })
}

/**
 * Run a function with stdin in raw mode.
 * Restores original mode on exit.
 */
export async function withRawMode<T>(fn: () => Promise<T>, out?: NodeJS.WriteStream): Promise<T> {
  return withTTYOperation(async () => {
    const wasRaw = process.stdin.isRaw
    // isPaused() is false even for an untouched TTY; flowing records whether it
    // actually had an active reader before this lease resumed it.
    const wasFlowing = process.stdin.readableFlowing
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
    }
    try {
      return await fn()
    } finally {
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false)
      if (wasFlowing !== true) process.stdin.pause()
    }
  }, out)
}
