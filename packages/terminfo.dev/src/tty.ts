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
export function readResponse(pattern: RegExp, timeoutMs: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    let buf = ""

    const cleanup = () => {
      clearTimeout(timer)
      process.stdin.off("data", onData)
    }

    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const match = buf.match(pattern)
      if (match) {
        cleanup()
        resolve([...match])
      }
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)

    process.stdin.on("data", onData)
  })
}

/**
 * Send an escape sequence and read the response.
 */
export async function query(sequence: string, responsePattern: RegExp, timeoutMs = 1000): Promise<string[] | null> {
  process.stdout.write(sequence)
  return readResponse(responsePattern, timeoutMs)
}

/**
 * DA1 response pattern — universally supported by all modern terminals.
 * Used as a sentinel: if DA1 arrives without the expected response, the
 * terminal doesn't support the queried feature.
 */
const DA1_PATTERN = /\x1b\[\?[0-9;]+c/

/**
 * Query with DA1 sentinel — faster than timeout-based detection.
 *
 * Sends the query sequence followed by DA1 (ESC [ c). Reads responses
 * looking for either the expected response OR the DA1 sentinel:
 * - If the query response arrives first → feature is supported, return match
 * - If DA1 arrives first (without query response) → not supported, return null
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
  // Send query + DA1 sentinel back-to-back
  process.stdout.write(sequence + "\x1b[c")

  let buf = ""
  let queryMatch: string[] | null = null

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(queryMatch)
    }, timeoutMs)

    function onData(chunk: Buffer) {
      buf += chunk.toString()

      // Always check for the query response (accumulates across chunks)
      if (!queryMatch) {
        const match = buf.match(responsePattern)
        if (match) queryMatch = [...match]
      }

      // DA1 is the termination signal in all cases.
      // - If query matched: DA1 confirms we've consumed the sentinel, safe to return
      // - If query didn't match: DA1 means the terminal doesn't support the feature
      if (DA1_PATTERN.test(buf)) {
        cleanup()
        resolve(queryMatch)
      }
    }

    function cleanup() {
      clearTimeout(timer)
      process.stdin.off("data", onData)
    }

    process.stdin.on("data", onData)
  })
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
  // Save cursor, move to col 1, write text, query position
  process.stdout.write("\x1b7\x1b[1G" + text)
  const pos = await queryCursorPosition()
  // Restore cursor
  process.stdout.write("\x1b8")
  if (!pos) return null
  return pos[1] - 1 // col is 1-based, width is 0-based
}

/**
 * Query whether a DEC private mode is recognized via DECRPM.
 * Uses DA1 sentinel for fast negative detection.
 * Returns "set", "reset", "unknown", or null (no response).
 */
export async function queryMode(modeNumber: number): Promise<"set" | "reset" | "unknown" | null> {
  const match = await queryWithSentinel(`\x1b[?${modeNumber}$p`, /\x1b\[\?(\d+);(\d+)\$y/)
  if (!match) return null
  const status = parseInt(match[2]!, 10)
  switch (status) {
    case 1:
      return "set"
    case 2:
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
  const wasRaw = process.stdin.isRaw
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
  }
  try {
    return await fn()
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw ?? false)
      process.stdin.pause()
    }
  }
}
