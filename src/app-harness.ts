#!/usr/bin/env bun
/**
 * App census harness — runs INSIDE a real terminal app.
 *
 * This script is launched by app-runner.ts inside each macOS terminal app
 * (Ghostty, iTerm2, Terminal.app, kitty, Warp). It feeds escape sequences
 * to stdout and reads terminal responses from stdin, testing what the REAL
 * terminal actually supports.
 *
 * The harness uses Device Status Report (DSR / \x1b[6n) as its primary
 * verification mechanism: after sending a cursor-positioning sequence, it
 * queries cursor position and checks the terminal's response.
 *
 * For features that produce no queryable response (SGR attributes, etc.),
 * the harness tests that the sequence is parsed without breaking output.
 *
 * Output: JSON to a temp file (path from argv[2]) in PerBackendFile format.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"

// ── Raw mode stdin helpers ──

const stdin = process.stdin
const stdout = process.stdout

function enableRawMode(): void {
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding("utf8")
}

function disableRawMode(): void {
  stdin.setRawMode(false)
  stdin.pause()
}

/** Read from stdin with a timeout. Returns whatever arrives before the deadline. */
function readResponse(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = ""
    const timer = setTimeout(() => {
      stdin.removeListener("data", onData)
      resolve(buf)
    }, timeoutMs)

    function onData(chunk: string) {
      buf += chunk
      // Check if we got a complete CSI response (ends with a letter)
      // Common responses: \x1b[R (cursor position), \x1b[?...c (DA1), \x1b[>...c (DA2)
      if (/\x1b\[[\x20-\x3f]*[\x40-\x7e]/.test(buf)) {
        clearTimeout(timer)
        stdin.removeListener("data", onData)
        resolve(buf)
      }
    }

    stdin.on("data", onData)
  })
}

/** Drain any pending input from stdin. */
function drainStdin(): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>

    function resetTimer() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stdin.removeListener("data", onDrain)
        resolve()
      }, 50)
    }

    function onDrain() {
      // Data arrived — consume it and reset the drain timer.
      // We resolve once no data has arrived for 50ms.
      resetTimer()
    }

    resetTimer()
    stdin.on("data", onDrain)
  })
}

/**
 * Query cursor position via DSR. Returns { row, col } (1-based) or null on timeout.
 */
async function queryCursorPosition(): Promise<{ row: number; col: number } | null> {
  await drainStdin()
  stdout.write("\x1b[6n")
  const resp = await readResponse(500)
  const match = resp.match(/\x1b\[(\d+);(\d+)R/)
  if (!match) return null
  return { row: parseInt(match[1]!, 10), col: parseInt(match[2]!, 10) }
}

/**
 * Send a DA1 query and check if we get a response.
 */
async function queryDA1(): Promise<string | null> {
  await drainStdin()
  stdout.write("\x1b[c")
  const resp = await readResponse(500)
  const match = resp.match(/\x1b\[[?]?[\d;]*c/)
  return match ? match[0] : null
}

/**
 * Send a DA2 (secondary device attributes) query.
 */
async function queryDA2(): Promise<string | null> {
  await drainStdin()
  stdout.write("\x1b[>c")
  const resp = await readResponse(500)
  const match = resp.match(/\x1b\[>[\d;]*c/)
  return match ? match[0] : null
}

/**
 * Query kitty keyboard protocol support.
 * Send CSI ? u — if the terminal supports it, it responds with CSI ? <flags> u.
 */
async function queryKittyKeyboard(): Promise<string | null> {
  await drainStdin()
  stdout.write("\x1b[?u")
  const resp = await readResponse(300)
  const match = resp.match(/\x1b\[\?(\d+)u/)
  return match ? match[0] : null
}

// ── Clear screen helper ──

function clear(): void {
  stdout.write("\x1b[2J\x1b[H")
}

// ── Probe infrastructure ──

const results: Record<string, boolean> = {}
const notes: Record<string, string> = {}

async function probe(id: string, test: () => Promise<boolean | string>): Promise<void> {
  try {
    clear()
    await drainStdin()
    const result = await test()
    if (typeof result === "string") {
      results[id] = false
      notes[id] = result
    } else {
      results[id] = result
    }
  } catch (e: any) {
    results[id] = false
    notes[id] = e.message ?? String(e)
  }
}

// ── Probes ──
// These mirror the library census probes where possible, but use DSR-based
// verification instead of reading cell state from a backend API.

async function runProbes(): Promise<void> {
  // ── Text ──

  await probe("text.basic", async () => {
    clear()
    stdout.write("Hello")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    // After writing "Hello" (5 chars), cursor should be at col 6
    return pos.col === 6
  })

  await probe("text.newline", async () => {
    clear()
    stdout.write("A\r\nB")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    // Cursor should be on row 2, col 2
    return pos.row === 2 && pos.col === 2
  })

  await probe("text.wrap", async () => {
    clear()
    const cols = stdout.columns || 80
    stdout.write("X".repeat(cols + 5))
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    // Should have wrapped to row 2
    return pos.row === 2
  })

  await probe("text.tab", async () => {
    clear()
    stdout.write("\tX")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    // Tab should advance to col 9, then X at col 10
    return pos.col === 10
  })

  await probe("text.cr", async () => {
    clear()
    stdout.write("AB\rC")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    // CR moves to col 1, then C at col 2
    return pos.col === 2
  })

  // ── Cursor movement ──

  await probe("cursor.move.absolute", async () => {
    clear()
    stdout.write("\x1b[5;10H")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.row === 5 && pos.col === 10
  })

  await probe("cursor.move.home", async () => {
    clear()
    stdout.write("ABC\x1b[H")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.row === 1 && pos.col === 1
  })

  await probe("cursor.move.forward", async () => {
    clear()
    stdout.write("\x1b[5C")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 6
  })

  await probe("cursor.move.back", async () => {
    clear()
    stdout.write("ABC\x1b[2D")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 2
  })

  await probe("cursor.move.down", async () => {
    clear()
    stdout.write("\x1b[3B")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.row === 4
  })

  await probe("cursor.move.up", async () => {
    clear()
    stdout.write("\x1b[5B\x1b[2A")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.row === 4
  })

  await probe("cursor.save-restore", async () => {
    clear()
    stdout.write("AB\x1b7\x1b[5;5H\x1b8")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.row === 1 && pos.col === 3
  })

  // ── Erase ──

  await probe("erase.line.right", async () => {
    clear()
    stdout.write("XXXXX\x1b[1G\x1b[K")
    // Cursor should still be at col 1 (erase doesn't move cursor)
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 1
  })

  await probe("erase.screen.all", async () => {
    clear()
    stdout.write("AAAA\r\nBBBB\r\nCCCC")
    stdout.write("\x1b[2J\x1b[H")
    // After clear, write a marker and verify position
    stdout.write("Z")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.row === 1 && pos.col === 2
  })

  // ── SGR (attribute parsing — verify sequences don't break output) ──

  await probe("sgr.bold", async () => {
    clear()
    stdout.write("\x1b[1mBOLD\x1b[0m_NORMAL")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    // "BOLD_NORMAL" = 11 chars, cursor at col 12
    return pos.col === 12
  })

  await probe("sgr.italic", async () => {
    clear()
    stdout.write("\x1b[3mITALIC\x1b[0m")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 7
  })

  await probe("sgr.underline.single", async () => {
    clear()
    stdout.write("\x1b[4mUNDER\x1b[0m")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 6
  })

  await probe("sgr.underline.curly", async () => {
    clear()
    stdout.write("\x1b[4:3mCURLY\x1b[0m")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    // If the terminal doesn't understand 4:3, it might output garbage
    return pos.col === 6
  })

  await probe("sgr.strikethrough", async () => {
    clear()
    stdout.write("\x1b[9mSTRIKE\x1b[0m")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 7
  })

  await probe("sgr.fg.truecolor", async () => {
    clear()
    stdout.write("\x1b[38;2;255;128;0mCOLOR\x1b[0m")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 6
  })

  await probe("sgr.bg.truecolor", async () => {
    clear()
    stdout.write("\x1b[48;2;0;255;128mBG\x1b[0m")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 3
  })

  await probe("sgr.reset", async () => {
    clear()
    stdout.write("\x1b[1;3;4mXYZ\x1b[0mABC")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 7
  })

  // ── Modes ──

  await probe("modes.alt-screen.enter", async () => {
    clear()
    stdout.write("NORMAL")
    stdout.write("\x1b[?1049h") // Enter alt screen
    // On alt screen, cursor resets to 1,1
    const pos = await queryCursorPosition()
    stdout.write("\x1b[?1049l") // Exit alt screen
    if (!pos) return "no DSR response"
    return pos.row === 1 && pos.col === 1
  })

  await probe("modes.alt-screen.exit", async () => {
    clear()
    stdout.write("AB")
    const posBefore = await queryCursorPosition()
    stdout.write("\x1b[?1049h") // Enter alt screen
    stdout.write("XY")
    stdout.write("\x1b[?1049l") // Exit alt screen
    const posAfter = await queryCursorPosition()
    if (!posBefore || !posAfter) return "no DSR response"
    // After exiting alt screen, cursor should be restored
    return posAfter.col === posBefore.col
  })

  await probe("modes.auto-wrap", async () => {
    clear()
    const cols = stdout.columns || 80
    stdout.write("X".repeat(cols) + "Y")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.row === 2
  })

  // ── Scrollback ──

  await probe("scrollback.scroll-up", async () => {
    clear()
    const rows = stdout.rows || 24
    // Fill screen + overflow to push content into scrollback
    for (let i = 0; i < rows + 5; i++) {
      stdout.write(`line ${i}\r\n`)
    }
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    // Cursor should be within the visible area (scrolling happened)
    return pos.row <= rows
  })

  await probe("scrollback.reverse-index", async () => {
    clear()
    stdout.write("A\r\nB\r\nC")
    // Move to top, then reverse index (should scroll down, inserting blank line)
    stdout.write("\x1b[H\x1bM")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.row === 1
  })

  // ── Extensions ──

  await probe("extensions.da1", async () => {
    const resp = await queryDA1()
    if (!resp) return "no DA1 response"
    return true
  })

  await probe("extensions.da2", async () => {
    const resp = await queryDA2()
    if (!resp) return "no DA2 response"
    return true
  })

  await probe("extensions.kitty-keyboard", async () => {
    const resp = await queryKittyKeyboard()
    if (!resp) return "no response to CSI ? u"
    return true
  })

  await probe("extensions.osc2-title", async () => {
    clear()
    stdout.write("\x1b]2;Census Test Title\x07")
    // We can't read the title back, but we can verify the sequence
    // didn't break output by writing text after it
    stdout.write("OK")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 3
  })

  await probe("extensions.bracketed-paste", async () => {
    clear()
    // Enable bracketed paste mode, then verify we can still write
    stdout.write("\x1b[?2004h")
    stdout.write("OK")
    stdout.write("\x1b[?2004l")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 3
  })

  // ── Reset ──

  await probe("reset.sgr", async () => {
    clear()
    stdout.write("\x1b[1;3;7mXYZ\x1b[0mABC")
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.col === 7
  })

  await probe("reset.ris", async () => {
    // RIS (\x1bc) is a full terminal reset
    stdout.write("\x1bc")
    // Small delay for terminal to process reset
    await new Promise((r) => setTimeout(r, 100))
    const pos = await queryCursorPosition()
    if (!pos) return "no DSR response"
    return pos.row === 1 && pos.col === 1
  })
}

// ── Main ──

async function main(): Promise<void> {
  const outputPath = process.argv[2]
  if (!outputPath) {
    console.error("Usage: app-harness.ts <output-path>")
    process.exit(1)
  }

  // Compute probe hash (hash of this file)
  const selfPath = new URL(import.meta.url).pathname
  const selfContent = readFileSync(selfPath)
  const probeHash = createHash("md5").update(selfContent).digest("hex").slice(0, 12)

  enableRawMode()

  try {
    // Warm up — some terminals need a moment after raw mode
    await new Promise((r) => setTimeout(r, 200))
    await drainStdin()

    await runProbes()
  } finally {
    disableRawMode()
  }

  // Build result in PerBackendFile format
  // The backend name and version will be filled in by app-runner.ts
  const output = {
    backend: "__APP__",
    version: "__VERSION__",
    generated: new Date().toISOString(),
    probeHash,
    results,
    ...(Object.keys(notes).length > 0 ? { notes } : {}),
  }

  writeFileSync(outputPath, JSON.stringify(output, null, 2))

  // Write a done marker so the runner knows we finished
  writeFileSync(outputPath + ".done", "")
}

await main()
