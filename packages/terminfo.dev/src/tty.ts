import { AsyncLocalStorage } from "node:async_hooks"

/**
 * TTY utilities — raw mode, response reading, escape sequence I/O.
 *
 * The core primitive: write an escape sequence to stdout, read a response
 * from stdin within a timeout.
 */

/**
 * Read a response matching a pattern from stdin within a timeout.
 * Must be called while stdin is in raw mode.
 */
const ttyOperations = new WeakMap<typeof process.stdin, Promise<void>>()
const operationContext = new AsyncLocalStorage<boolean>()

/** Serialize whole terminal operations; queries inside one operation run inline. */
export function withTTYOperation<T>(fn: () => Promise<T>): Promise<T> {
  if (operationContext.getStore()) return fn()
  const previous = ttyOperations.get(process.stdin) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => operationContext.run(true, fn))
  ttyOperations.set(
    process.stdin,
    current.then(
      () => {},
      () => {},
    ),
  )
  return current
}

function matchResponse(
  pattern: RegExp,
  timeoutMs: number,
  write?: () => void,
  sentinel = false,
): Promise<{ match: string[] | null; reason: "reply" | "sentinel" | "timeout" }> {
  return new Promise((resolve) => {
    let buf = ""

    const cleanup = () => {
      clearTimeout(timer)
      process.stdin.off("data", onData)
    }

    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const match = buf.match(pattern)
      const end = sentinel ? buf.search(/\x1b\[\?[0-9;]+c/) : -1
      if (end >= 0) {
        cleanup()
        resolve(
          match && (match.index ?? 0) < end
            ? { match: [...match], reason: "reply" }
            : { match: null, reason: "sentinel" },
        )
      } else if (match && !sentinel) {
        cleanup()
        resolve({ match: [...match], reason: "reply" })
      }
    }

    const timer = setTimeout(() => {
      cleanup()
      const match = buf.match(pattern)
      resolve(match ? { match: [...match], reason: "reply" } : { match: null, reason: "timeout" })
    }, timeoutMs)

    process.stdin.on("data", onData)
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
  return withTTYOperation(
    async () => (await matchResponse(responsePattern, timeoutMs, () => process.stdout.write(sequence))).match,
  )
}

/**
 * DA1 response pattern — universally supported by all modern terminals.
 * Used as a sentinel: if DA1 arrives without the expected response, the
 * terminal has not answered before the end marker. This alone does not prove
 * that a feature is unsupported.
 */
export type QueryOutcome = { kind: "reply"; match: string[] } | { kind: "sentinel" | "timeout" }

/** Preserve the reason for a missing reply; DA1 is only an end marker. */
export async function queryWithSentinelOutcome(
  sequence: string,
  responsePattern: RegExp,
  timeoutMs = 2000,
): Promise<QueryOutcome> {
  // DA1 is the requested answer here; a second DA1 cannot distinguish it from a sentinel.
  if (sequence === "\x1b[c") {
    const match = await query(sequence, responsePattern, timeoutMs)
    return match ? { kind: "reply", match } : { kind: "timeout" }
  }
  return withTTYOperation(async () => {
    const result = await matchResponse(
      responsePattern,
      timeoutMs,
      () => process.stdout.write(sequence + "\x1b[c"),
      true,
    )
    if (result.match) return { kind: "reply", match: result.match }
    return { kind: result.reason === "sentinel" ? "sentinel" : "timeout" }
  })
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
  return outcome.kind === "reply" ? outcome.match : null
}

/**
 * Query cursor position via DSR 6 (Device Status Report).
 * Returns [row, col] (1-based) or null if no response.
 */
export async function queryCursorPosition(): Promise<[number, number] | null> {
  const match = await query("\x1b[6n", /\x1b\[(\d+);(\d+)R/)
  if (!match) return null
  return [parseInt(match[1]!, 10), parseInt(match[2]!, 10)]
}

/**
 * Write text, then query cursor position to determine rendered width.
 */
export async function measureRenderedWidth(text: string): Promise<number | null> {
  return withTTYOperation(async () => {
    process.stdout.write("\x1b7\x1b[1G" + text)
    try {
      const pos = await queryCursorPosition()
      return pos ? pos[1] - 1 : null
    } finally {
      process.stdout.write("\x1b8")
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
  const status = parseInt(match[1]!, 10)
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
export async function withRawMode<T>(fn: () => Promise<T>): Promise<T> {
  return withTTYOperation(async () => {
    const wasRaw = process.stdin.isRaw
    const wasPaused = process.stdin.isPaused()
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
    }
    try {
      return await fn()
    } finally {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw ?? false)
        if (wasPaused) process.stdin.pause()
      }
    }
  })
}
