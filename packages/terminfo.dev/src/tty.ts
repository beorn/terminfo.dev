import { AsyncLocalStorage } from "node:async_hooks"
import { openSync } from "node:fs"
import { WriteStream } from "node:tty"
import type { TerminalQueryOutcome, Utf8DecodingReading } from "@terminfo/probe-defs"
import { decrpmReplyPattern, decrpmStatus, readSentinelReply, sentinelGraceMs } from "@terminfo/probe-defs"

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
  reason: QueryOutcome["reason"]
  raw: string
  rawBase64: string
  match: string[] | null
  /** The DA1 sentinel arrived before this query's reply, with the measured ordering facts. */
  sentinel?: { atMs: number; graceMs: number }
}
export type TTYTraceEvent = { kind: "write"; sequence: string } | ({ kind: "query" } & TTYQueryTrace)
const queryTraceContext = new AsyncLocalStorage<{ queries: TTYQueryTrace[]; events: TTYTraceEvent[] }>()

/** Scope all direct and helper queries to the probe that initiated them. */
export function withTTYQueryTrace<T>(
  queries: TTYQueryTrace[],
  events: TTYTraceEvent[],
  fn: () => Promise<T>,
): Promise<T> {
  return queryTraceContext.run({ queries, events }, fn)
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

function writeTTY(sequence: string): void {
  queryTraceContext.getStore()?.events.push({ kind: "write", sequence })
  currentTTYOutput().write(sequence)
}

function matchResponse(
  pattern: RegExp,
  timeoutMs: number,
  write?: () => void,
  sentinel = false,
  sequence = "",
  graceMs: number = sentinelGraceMs(),
  deferTimer?: (start: () => void, cancel: () => void) => void,
): Promise<QueryOutcome> {
  const trace = queryTraceContext.getStore()
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let buf = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let writeAt = 0
    let sentinelFacts: { atMs: number; graceMs: number } | null = null

    const cleanup = () => {
      clearTimeout(timer)
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
      trace?.queries.push({ sequence, ...outcome })
      trace?.events.push({ kind: "query", sequence, ...outcome })
      resolve(outcome)
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
      // by sentinel", citing these numbers, only when nothing preceded the answer. The window bounds the
      // wait, so the DA1 deadline replaces the outer one, and each chunk restarts it.
      sentinelFacts ??= { atMs: Date.now() - writeAt, graceMs }
      clearTimeout(timer)
      timer = setTimeout(() => finish(read.match, read.match ? "reply" : "sentinel", sentinelFacts), graceMs)
    }

    const startTimer = () => {
      if (settled || timer !== undefined) return
      timer = setTimeout(() => {
        const match = buf.match(pattern)
        finish(match ? [...match] : null, match ? "reply" : "timeout")
      }, timeoutMs)
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
    matchResponse(responsePattern, timeoutMs, () => currentTTYOutput().write(sequence), false, sequence),
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
      () => currentTTYOutput().write(sequence + "\x1b[c"),
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
export async function measureRenderedWidth(text: string): Promise<number | null> {
  return withTTYOperation(async () => {
    writeTTY("\x1b7")
    try {
      writeTTY("\x1b[2;1H")
      const secondRow = await queryCursorPosition()
      if (secondRow?.[0] !== 2 || secondRow[1] !== 1) return null

      writeTTY("\x1b[1;1HA")
      const ascii = await queryCursorPosition()
      if (ascii?.[0] !== 1 || ascii[1] !== 2) return null

      writeTTY("\x1b[1;1H" + text)
      const pos = await queryCursorPosition()
      if (pos?.[0] !== 1 || !Number.isSafeInteger(pos[1]) || pos[1] <= 1) return null

      writeTTY("A")
      const next = await queryCursorPosition()
      return next?.[0] === 1 && next[1] === pos[1] + 1 ? pos[1] - 1 : null
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
