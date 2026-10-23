/**
 * Windows Terminal's own text, read through UI Automation (#30720).
 *
 * On Windows every other cell read is the console host's buffer (windows-console-cells.ts), which
 * sits between the collector and the terminal and is never the terminal's verdict. Windows Terminal
 * keeps its own buffer and exposes it as one `TermControl` element with a TextPattern, so this read
 * asks the terminal itself, the way the macOS arm asks Terminal.app and iTerm2.
 *
 * Everything here was measured on the hosted runner first (spike run 39776473575,
 * /hh/var/@dev10/30720/spike-findings.md): managed UI Automation (UIA2) reaches the control; the one
 * visible range is the active screen; each Line unit is exactly `cols` characters with its trailing
 * blanks and no terminator; and a Move past the last row reports a move yet returns that row again,
 * so the script takes exactly `rows` units and never trusts Move's count. A DECDWL or DECDHL row comes
 * back as its plain characters with nothing marking the rendition, so a screen that may hold one is
 * refused by name (`createLineRenditionTracker`), never mapped at half its width.
 *
 * Settling: the console host re-renders to the terminal asynchronously, so the host's own barrier
 * proves only that the host has drawn. The script reads, waits SETTLE_GAP_MS, and reads again; it
 * returns only two reads that agree, and refuses by name after SETTLE_PAIRS pairs that all differ.
 */
import { spawnSync } from "node:child_process"
import {
  mapSnapshotToCells,
  osascriptReply,
  type OsascriptReply,
  type TerminalTextRead,
} from "./darwin-terminal-text.ts"

/** About ten times the measured host-barrier-to-UIA maximum (5.3 ms over 40 hosted trials). */
export const SETTLE_GAP_MS = 50
/** One pair, then up to three more, before the read refuses as unsettled. */
export const SETTLE_PAIRS = 4

/** A child's result, in the reply shape the macOS reader already classifies. */
export type PowerShellReply = OsascriptReply

export type WindowsTerminalRows =
  | {
      readonly status: "read"
      readonly rows: readonly string[]
      /** The visible range stopped at WT's document end, so every screen row past `rows` is blank. */
      readonly documentEnded: boolean
    }
  | { readonly status: "refused"; readonly reason: string }

/**
 * The Windows PowerShell 5.1 script that reads the TermControl of `pid`. Rows go back as UTF-16 code
 * units, so the JSON is ASCII and no code page can change a character on the way out; the writer is
 * the raw stdout stream, so the shared console's own code page is never touched.
 */
export function windowsTerminalTextScript(pid: number, rows: number): string {
  for (const [name, value] of [
    ["pid", pid],
    ["rows", rows],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Windows Terminal text read: ${name} is not a count: ${String(value)}`)
    }
  }
  return `$ErrorActionPreference = 'Stop'
$ownerPid = ${String(pid)}
$rows = ${String(rows)}
$gapMs = ${String(SETTLE_GAP_MS)}
$pairs = ${String(SETTLE_PAIRS)}
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
function Send([string]$json) { $stdout.Write($json); $stdout.Flush() }
function Refuse([string]$reason) { Send ('{"status":"refused","reason":' + (ConvertTo-Json -InputObject $reason -Compress) + '}') }
function Same($left, $right) {
  if ($left.Length -ne $right.Length) { return $false }
  for ($i = 0; $i -lt $left.Length; $i++) { if (-not ($left[$i] -ceq $right[$i])) { return $false } }
  return $true
}
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $element = [System.Windows.Automation.AutomationElement]
  $scope = [System.Windows.Automation.TreeScope]
  $byPid = New-Object System.Windows.Automation.PropertyCondition($element::ProcessIdProperty, $ownerPid)
  $byClass = New-Object System.Windows.Automation.PropertyCondition($element::ClassNameProperty, 'TermControl')
  $controls = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
  foreach ($window in $element::RootElement.FindAll($scope::Children, $byPid)) {
    foreach ($control in $window.FindAll($scope::Descendants, $byClass)) { $controls.Add($control) }
  }
  if ($controls.Count -ne 1) {
    Refuse ('Windows Terminal (pid ' + $ownerPid + ') exposes ' + $controls.Count + ' TermControl elements; exactly one is required')
    exit 0
  }
  $pattern = $controls[0].GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
  $start = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start
  $end = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End
  $line = [System.Windows.Automation.Text.TextUnit]::Line
  $document = $pattern.DocumentRange
  function Read-Screen {
    $ranges = $pattern.GetVisibleRanges()
    if ($ranges.Length -ne 1) { throw ('the TermControl reports ' + $ranges.Length + ' visible ranges; exactly one is required') }
    $visible = $ranges[0]
    $cursor = $visible.Clone()
    $cursor.MoveEndpointByRange($end, $cursor, $start)
    $read = New-Object System.Collections.Generic.List[string]
    while ($read.Count -lt $rows) {
      $unit = $cursor.Clone()
      $unit.ExpandToEnclosingUnit($line)
      if ($unit.CompareEndpoints($start, $visible, $end) -ge 0) { break }
      $read.Add($unit.GetText(-1))
      if ($cursor.Move($line, 1) -eq 0) { break }
    }
    # WT ends its document below the later of the last non-space character and the cursor, and clamps
    # the visible range there: every row below that end holds no character (UiaTextRangeBase 1.21).
    $ended = $visible.CompareEndpoints($end, $document, $end) -ge 0
    return @{ rows = $read.ToArray(); ended = $ended }
  }
  for ($pair = 0; $pair -lt $pairs; $pair++) {
    $first = Read-Screen
    Start-Sleep -Milliseconds $gapMs
    $second = Read-Screen
    if ($first.ended -eq $second.ended -and (Same $first.rows $second.rows)) {
      $encoded = foreach ($text in $second.rows) { '[' + (@($text.ToCharArray() | ForEach-Object { [int]$_ }) -join ',') + ']' }
      $ended = if ($second.ended) { 'true' } else { 'false' }
      Send ('{"status":"read","documentEnded":' + $ended + ',"rows":[' + (@($encoded) -join ',') + ']}')
      exit 0
    }
  }
  Refuse ('the screen did not hold still: ' + $pairs + ' pairs of reads ' + $gapMs + ' ms apart all differed')
} catch {
  Refuse ('UI Automation read failed: ' + $_.Exception.Message)
}
`
}

const defaultRun = (script: string, timeoutMs: number): PowerShellReply =>
  osascriptReply(
    spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      // windowsHide gives the child its own hidden console, so the owned console's modes, code page
      // and screen are never the reader's to change.
      { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true },
    ),
  )

export interface WindowsTerminalTextOptions {
  /** The WindowsTerminal.exe process the hosted receipt and this run's ancestry both name. */
  readonly pid: number
  readonly rows: number
  readonly timeoutMs?: number
  /** Injection seam for tests; production runs powershell.exe. */
  readonly run?: (script: string) => PowerShellReply
}

const unitRows = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) &&
  value.every(
    (row) =>
      Array.isArray(row) &&
      row.every((unit) => typeof unit === "number" && Number.isInteger(unit) && unit >= 0 && unit <= 0xffff),
  )
    ? (value as number[][]).map((row) => String.fromCharCode(...row))
    : undefined

/** The visible rows exactly as UI Automation returned them, before any cell mapping. */
export function readWindowsTerminalRows(options: WindowsTerminalTextOptions): WindowsTerminalRows {
  const run = options.run ?? ((script: string) => defaultRun(script, options.timeoutMs ?? 15_000))
  const reply = run(windowsTerminalTextScript(options.pid, options.rows))
  if (reply.error !== undefined && reply.error.code !== "ETIMEDOUT") {
    return {
      status: "refused",
      reason: `Windows Terminal could not be read: ${reply.error.code ?? "powershell.exe could not start"}: ${reply.error.message}`,
    }
  }
  if (reply.timedOut) {
    const how = reply.signal === null ? "before its timeout" : `(killed by ${reply.signal})`
    return { status: "refused", reason: `Windows Terminal did not answer the UI Automation read ${how}` }
  }
  if (reply.status !== 0) {
    const detail = reply.stderr.trim() || reply.stdout.trim() || "no output"
    return { status: "refused", reason: `powershell.exe exited ${String(reply.status)}: ${detail.slice(0, 300)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.stdout)
  } catch {
    return {
      status: "refused",
      reason: `Windows Terminal did not return a snapshot: ${reply.stdout.trim().slice(0, 200) || "empty output"}`,
    }
  }
  if (typeof parsed !== "object" || parsed === null || !("status" in parsed)) {
    return { status: "refused", reason: "Windows Terminal returned no status in its snapshot" }
  }
  if (parsed.status === "refused") {
    const reason = "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : "no reason given"
    return { status: "refused", reason }
  }
  const rows = parsed.status === "read" && "rows" in parsed ? unitRows(parsed.rows) : undefined
  const documentEnded = "documentEnded" in parsed ? parsed.documentEnded : undefined
  if (rows === undefined || typeof documentEnded !== "boolean") {
    return { status: "refused", reason: "Windows Terminal returned an unrecognised snapshot" }
  }
  // Fewer rows is a complete screen only when the visible range stopped at the document's end (AC2 run
  // 39782783915: 2 rows of 30 on a cleared screen); anywhere else it ended early, and the read refuses.
  if (rows.length > options.rows || (rows.length < options.rows && !documentEnded)) {
    return {
      status: "refused",
      reason: `UI Automation returned ${String(rows.length)} rows where the measured screen has ${String(options.rows)}`,
    }
  }
  return { status: "read", rows, documentEnded }
}

/** Read Windows Terminal's screen and map it onto cells with the macOS snapshot's own mapping. */
export function readWindowsTerminalText(
  options: WindowsTerminalTextOptions & { readonly cols: number },
): TerminalTextRead {
  const read = readWindowsTerminalRows(options)
  if (read.status === "refused") return read
  // Nothing above the screen is read, so nothing is dropped. WT keeps a row's trailing blanks, but the
  // rows below its document's end are not in the document: each is blank, and the mapping pads and
  // records it as a padded row.
  const below = Array.from({ length: options.rows - read.rows.length }, () => "")
  const cells = mapSnapshotToCells([...read.rows, ...below], options.cols, options.rows, 0)
  if (typeof cells === "string") return { status: "refused", reason: cells }
  return { status: "read", app: "windows-terminal", cells }
}

/** ESC#3 and ESC#4 (DECDHL) and ESC#6 (DECDWL) against the two writes that reset every row's
 * rendition: an erase of the whole display and a full reset. */
const RENDITION_OR_CLEAR = /\x1b(?:#[346]|\[2J|c)/g

/**
 * Whether a double-width or double-height line may be on screen. UI Automation returns such a row as
 * its plain characters, which would map as a confident wrong grid, so the read refuses while one was
 * written after the last whole-screen clear. A sequence split across two writes is still seen.
 */
export function createLineRenditionTracker(): { observe(text: string): void; refusal(): string | undefined } {
  let pending: string | undefined
  let tail = ""
  return {
    observe(text) {
      const scanned = tail + text
      for (const match of scanned.matchAll(RENDITION_OR_CLEAR)) {
        pending = match[0].startsWith("\x1b#") ? `ESC${match[0].slice(1)}` : undefined
      }
      tail = scanned.slice(-3)
    },
    refusal() {
      return pending === undefined
        ? undefined
        : `${pending} set a double-width or double-height line since the last clear, and UI Automation does not report line rendition`
    },
  }
}
