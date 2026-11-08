/**
 * The pinned Linux Kitty's own scrollback size and visible rows, through the sibling `kitten` CLI.
 *
 * Kitty exposes no viewport position to remote control: `kitten @ get-text --extent` offers screen, all and
 * the alternate-screen variants and nothing about where the viewport sits, and `kitten @ ls` reports `lines`
 * and `columns` but not `scrolled_by` (kitty/window.py keeps it on the internal screen only). So this reader
 * reports two counts and never an offset: `totalLines - screenLines` equals the offset only while the viewport
 * is at the bottom, which is the very condition a scroll observation changes. A caller that needs an offset
 * must leave it unknown rather than assume the bottom.
 */
import { spawnSync } from "node:child_process"

interface KittyScrollbackOptions {
  /** This run's `kitten`, resolved beside the owned kitty binary. */
  readonly kitten: string
  /** The run's capture-directory socket, exactly as KITTY_LISTEN_ON declares it. */
  readonly socket: string
  /** The run's own KITTY_WINDOW_ID. */
  readonly window: string
}

export type KittyScrollbackRead =
  | { readonly status: "read"; readonly totalLines: number; readonly screenLines: number; readonly receipt: string }
  | { readonly status: "refused"; readonly reason: string }

interface ExtentRead {
  readonly lines: readonly string[]
  readonly receipt: object
}

function readExtent(
  options: KittyScrollbackOptions,
  extent: "all" | "screen",
): { readonly status: "read"; readonly read: ExtentRead } | { readonly status: "refused"; readonly reason: string } {
  const result = spawnSync(
    options.kitten,
    [
      "@",
      "--to",
      options.socket,
      "get-text",
      "--extent",
      extent,
      "--add-wrap-markers",
      "--match",
      `id:${options.window}`,
    ],
    { encoding: "buffer", timeout: 5000, maxBuffer: 1024 * 1024 },
  )
  const receipt = {
    kitten: options.kitten,
    socket: options.socket,
    window: options.window,
    extent,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdoutBase64: result.stdout == null ? null : result.stdout.toString("base64"),
    stderrBase64: result.stderr == null ? null : result.stderr.toString("base64"),
  }
  if (result.error || result.signal || result.status !== 0 || result.stdout == null || result.stderr == null) {
    return { status: "refused", reason: `Kitty ${extent} get-text unavailable: ${JSON.stringify(receipt)}` }
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
  } catch {
    return { status: "refused", reason: `Kitty ${extent} get-text did not return UTF-8: ${JSON.stringify(receipt)}` }
  }
  // With --add-wrap-markers this Kitty ends every physical row with a carriage return and emits a newline
  // only where the previous row was not soft-wrapped (line.c as_text_generic). A hard row end therefore
  // arrives as "\r\n" and a wrap edge as a lone "\r"; counting newlines alone would merge wrapped pairs.
  // Never trim blank rows or invent missing ones.
  const terminator = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\r") ? "\r" : null
  if (terminator == null) {
    return {
      status: "refused",
      reason: `Kitty ${extent} get-text returned no complete row terminator: ${JSON.stringify(receipt)}`,
    }
  }
  return { status: "read", read: { lines: text.slice(0, -terminator.length).split(/\r\n?|\n/u), receipt } }
}

/** Read this run's own Kitty window: its whole scrollback size and its visible row count. */
export function readLinuxKittyScrollback(options: KittyScrollbackOptions): KittyScrollbackRead {
  if (!options.socket.startsWith("unix:/") || !/^[1-9]\d*$/u.test(options.window)) {
    return { status: "refused", reason: "Kitty scrollback read requires this run's unix socket and numeric window ID" }
  }
  const all = readExtent(options, "all")
  if (all.status === "refused") return all
  const screen = readExtent(options, "screen")
  if (screen.status === "refused") return screen
  const totalLines = all.read.lines.length
  const screenLines = screen.read.lines.length
  if (totalLines < screenLines) {
    return {
      status: "refused",
      reason: `Kitty reported ${totalLines} total lines but ${screenLines} visible: ${JSON.stringify({ all: all.read.receipt, screen: screen.read.receipt })}`,
    }
  }
  return {
    status: "read",
    totalLines,
    screenLines,
    receipt: JSON.stringify({ all: all.read.receipt, screen: screen.read.receipt }),
  }
}
