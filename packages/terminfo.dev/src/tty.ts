import { AsyncLocalStorage } from "node:async_hooks"
import { openSync } from "node:fs"
import { WriteStream } from "node:tty"
import type { TerminalQueryOutcome } from "@terminfo/probe-defs"

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
const operationContext = new AsyncLocalStorage<{ active: boolean; out: NodeJS.WriteStream }>()
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
export function withTTYOperation<T>(fn: () => Promise<T>, out?: NodeJS.WriteStream): Promise<T> {
  const active = operationContext.getStore()
  if (active?.active) {
    if (out && out !== active.out) throw new Error("Nested TTY operation changed output stream")
    return fn()
  }
  const previous = ttyOperations.get(process.stdin) ?? Promise.resolve()
  const current = previous
    .catch(() => {})
    .then(() => {
      const lease = { active: true, out: out ?? process.stdout }
      return operationContext.run(lease, async () => {
        try {
          return await fn()
        } finally {
          lease.active = false
        }
      })
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

function matchResponse(
  pattern: RegExp,
  timeoutMs: number,
  write?: () => void,
  sentinel = false,
  sequence = "",
  graceMs: number = sentinelGraceMs(),
): Promise<QueryOutcome> {
  const trace = queryTraceContext.getStore()
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let buf = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout>
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
      const match = buf.match(pattern)
      if (!sentinel) {
        if (match) finish([...match], "reply")
        return
      }
      const end = buf.search(/\x1b\[\?[0-9;]+c/)
      if (end < 0) return
      if (match && (match.index ?? 0) < end) {
        finish([...match], "reply")
        return
      }
      // DA1 answered and no reply preceded it. Keep reading for the grace window: a reply inside it
      // still grades by the reply, carrying the ordering note; only silence through the window is the
      // measured negative the grader records as "negative by sentinel", citing these numbers. The
      // window bounds the wait, so the DA1 deadline replaces the outer one.
      sentinelFacts ??= { atMs: Date.now() - writeAt, graceMs }
      clearTimeout(timer)
      timer = setTimeout(() => finish(null, "sentinel", sentinelFacts), graceMs)
      if (match) finish([...match], "reply", sentinelFacts)
    }

    timer = setTimeout(() => {
      const match = buf.match(pattern)
      finish(match ? [...match] : null, match ? "reply" : "timeout")
    }, timeoutMs)

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

export function readResponse(pattern: RegExp, timeoutMs: number): Promise<string[] | null> {
  return withTTYOperation(async () => (await matchResponse(pattern, timeoutMs)).match)
}

/**
 * Send an escape sequence and read the response.
 */
export async function query(sequence: string, responsePattern: RegExp, timeoutMs = 1000): Promise<string[] | null> {
  return (await queryOutcome(sequence, responsePattern, timeoutMs)).match
}

/**
 * F1 (27832): how long the collector keeps reading after a DA1 sentinel before it calls a missing
 * reply a measured negative. Sized by measurement, once: re-run the sentinel-fired features on every
 * Release 1 terminal with a 1 s post-DA1 read and record any late reply and its delay, then
 * grace = max(250 ms, 2 x the largest observed delay). 250 ms is the floor until that measurement
 * lands; the issue names any terminal that answers late and the features it answers late for.
 */
export const SENTINEL_GRACE_MS = 250

/**
 * The window is a measured value, so the one-time sizing pass may widen it without a code change:
 * TERMINFO_SENTINEL_GRACE_MS sets the post-DA1 read for that pass only. An unset or empty value is
 * the floor; anything that is not a whole number of milliseconds is loud, never a silent default —
 * a typo here would silently publish sentinel-negatives inside a too-short window.
 */
export function sentinelGraceMs(raw: string | undefined = process.env.TERMINFO_SENTINEL_GRACE_MS): number {
  if (raw === undefined || raw === "") return SENTINEL_GRACE_MS
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `TERMINFO_SENTINEL_GRACE_MS must be a whole number of milliseconds; received ${JSON.stringify(raw)}`,
    )
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`TERMINFO_SENTINEL_GRACE_MS must be a positive whole number of milliseconds; received ${raw}`)
  }
  return value
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
    currentTTYOutput().write("\x1b7")
    try {
      currentTTYOutput().write("\x1b[2;1H")
      const secondRow = await queryCursorPosition()
      if (secondRow?.[0] !== 2 || secondRow[1] !== 1) return null

      currentTTYOutput().write("\x1b[1;1HA")
      const ascii = await queryCursorPosition()
      if (ascii?.[0] !== 1 || ascii[1] !== 2) return null

      currentTTYOutput().write("\x1b[1;1H" + text)
      const pos = await queryCursorPosition()
      if (pos?.[0] !== 1 || !Number.isSafeInteger(pos[1]) || pos[1] <= 1) return null

      currentTTYOutput().write("A")
      const next = await queryCursorPosition()
      return next?.[0] === 1 && next[1] === pos[1] + 1 ? pos[1] - 1 : null
    } finally {
      currentTTYOutput().write("\x1b8")
    }
  })
}

/**
 * Query whether a DEC private mode is recognized via DECRPM.
 * Uses DA1 sentinel for fast negative detection.
 * Returns "set", "reset", "unknown", or null (no response).
 */
export async function queryMode(modeNumber: number): Promise<"set" | "reset" | "unknown" | null> {
  const match = await queryWithSentinel(`\x1b[?${modeNumber}$p`, new RegExp(`\\x1b\\[\\?${modeNumber};([0-4])\\$y`))
  if (!match) return null
  const status = parseInt(match[1] ?? "", 10)
  switch (status) {
    case 1:
    case 3:
      return "set"
    case 2:
    case 4:
      return "reset"
    case 0:
      return "unknown"
    default:
      return null
  }
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
