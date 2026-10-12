/**
 * DIAGNOSTIC ONLY — bead 28754 option B, branch-only, never merged and never admitted.
 *
 * Measures, on a real hosted macOS runner, exactly what a darwin capture adapter would need and
 * what the plan's §3 contract depends on:
 *   - whether a hosted runner yields REAL window pixels, or the TCC wallpaper-only image that
 *     exits 0 (actions/runner-images#8782 — the silent-wrong-pixels trap);
 *   - the capture pixel extent, the window kCGWindowBounds in points, and their ratio;
 *   - that run's own CSI 14 t / 16 t / 18 t answers, painted by the terminal itself;
 *   - the drawn-surface placement basis on a real macOS frame, from the repo's own functions;
 *   - two decoded-pixel digests around a PROVABLE paint, i.e. whether a paint witness is
 *     observable through screenshots at all;
 *   - the B2 calibration (@cto round 2, plan 28785 §3e): one interior cell repainted between two
 *     captures, and the changed-pixel rectangle it must produce — a named, non-colour text-area
 *     origin, with the repo's own geometry-centred placement reported beside it for the delta;
 *   - window owner PID against the app PID, and whether magick is present.
 *
 * Every failure is loud and recorded; nothing is guessed and nothing defaults silently.
 */
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { command, drawnSurface, textAreaOrigin } from "../packages/terminfo.dev/src/linux-capture.ts"

const GHOSTTY = "/Applications/Ghostty.app/Contents/MacOS/ghostty"
// The one interior cell the B2 calibration repaints, in the terminal's own 1-based coordinates.
// Far enough from every edge that a cell rectangle derived from the diff cannot be clipped.
const calRow = 3
const calCol = 3
const out = process.argv[2]
if (!out) throw new Error("usage: bun scripts/darwin-capture-probe.ts <output-directory>")
mkdirSync(out, { recursive: true })

const report: Record<string, unknown> = {
  platform: process.platform,
  node: process.version,
  bun: Bun.version,
  startedAt: new Date().toISOString(),
}
const write = () => writeFileSync(join(out, "capture-probe.json"), JSON.stringify(report, null, 2))
write()

if (process.platform !== "darwin") throw new Error("The darwin capture probe requires Darwin")
if (!existsSync(GHOSTTY)) throw new Error(`Ghostty binary missing at ${GHOSTTY}`)

/**
 * Every external command is recorded with its exact argv, exit, stdout, stderr and whether it had to
 * be KILLED by the wall-clock bound — no silent step, and no step that can hang the job. The bound
 * is load-bearing: this repo's own iTerm failure-evidence step already kills screencapture after
 * 10 s, so an unbounded capture call is a known way to stall a runner.
 */
async function record(
  label: string,
  argv: string[],
  wallMs = 15_000,
): Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  const child = spawn(argv[0] as string, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, wallMs)
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
  clearTimeout(timer)
  const row = { argv, code, timedOut, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) }
  report[label] = row
  write()
  return row
}

// 1. Decoder availability: the plan uses magick at depth 8 on both platforms, and the runner image
//    is not assumed to ship it. Both the ImageMagick 7 name and the version 6 name are recorded,
//    because a missing decoder is a named refusal in the adapter, never a silent default.
for (const decoder of ["magick", "convert"]) {
  try {
    const version = await command(decoder, ["-version"])
    report[decoder] = { present: true, version: version.toString("utf8").split("\n")[0] }
  } catch (error) {
    report[decoder] = { present: false, error: String(error) }
  }
}
write()

// 2. The marker command the terminal itself runs: paints phase A, answers its own geometry
//    queries, changes EXACTLY ONE interior cell's background (the B2 calibration), then paints a
//    DIFFERENT frame (phase B) that a further capture must observe.
const marker = join(out, "marker.command")
writeFileSync(
  marker,
  `#!/bin/bash
set -u
OUT=${JSON.stringify(out)}
CAL_ROW=${calRow}
CAL_COL=${calCol}
# read one CSI reply: every reply this probe asks for ends with "t".
ask() {
  local reply=""
  printf '%b' "$1" > /dev/tty
  IFS= read -rs -t 2 -d t reply < /dev/tty || true
  printf '%s -> %s\\n' "$1" "$reply"
}
paint() {
  printf '\\033[2J\\033[H'
  printf 'TERMINFO CAPTURE PROBE  PHASE %s\\n' "$1"
  for i in 1 2 3 4 5 6; do printf 'PHASE%s ROW%s ########## PHASE%s ROW%s\\n' "$1" "$i" "$1" "$i"; done
  printf '\\033[8;1H'
}
# B2 — the calibration paint. It changes exactly ONE interior cell: a truecolor magenta BACKGROUND
# on a blank cell, glyph and cursor untouched, so the pixels that differ between the phase-A and
# phase-A2 captures must be one cell-sized axis-aligned rectangle and nothing else. This is the
# named, non-colour source for the text-area origin (@cto round 2, plan §3e).
calibrate() {
  printf '\\033[%s;%sH\\033[48;2;255;0;255m \\033[0m' "$CAL_ROW" "$CAL_COL" > /dev/tty
  printf '\\033[6;1H' > /dev/tty
}
# The cursor is hidden for the WHOLE run: a blinking cursor is a pixel that changes without a
# paint, and it would land inside the calibration diff.
printf '\\033[?25l' > /dev/tty
# The driver confirms each capture by writing a file, and the marker advances only on that file, so
# the calibration can never be captured after the next paint has already happened: a timed sleep
# would make a late capture a garbage diff instead of a named refusal.
wait_for_ack() {
  local file=$1 tries=0
  while [ ! -f "$OUT/$file" ]; do
    tries=$((tries + 1))
    if [ "$tries" -ge 900 ]; then
      printf 'no %s after 180 s of waiting; the calibration window closed without a confirming capture\\n' "$file" > "$OUT/marker-refusal"
      exit 1
    fi
    sleep 0.2
  done
  sleep 1
}
{
  paint A
  ask '\\033[14t'
  ask '\\033[16t'
  ask '\\033[18t'
  printf 'painted-phase-A %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "$OUT/terminal-replies.txt" 2>&1
cat "$OUT/terminal-replies.txt" > /dev/tty
tty > "$OUT/tty"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$OUT/phase-a"
wait_for_ack ack-a
calibrate
printf 'painted-phase-A2 %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > /dev/tty
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$OUT/phase-a2"
wait_for_ack ack-a2
paint B
printf 'painted-phase-B %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > /dev/tty
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$OUT/phase-b"
sleep 20
`,
  { mode: 0o755 },
)

// 3. Launch ghostty exactly as the measurement workflow does: a config command, then the binary.
mkdirSync(join(homedir(), ".config", "ghostty"), { recursive: true })
writeFileSync(join(homedir(), ".config", "ghostty", "config"), `command = /bin/bash ${marker}\n`)
// The app's own stdout and stderr go to a FILE, never a pipe: a detached terminal that inherits a
// step's pipe keeps the step alive until it exits, which is a second way to stall a runner.
const launchLog = join(out, "ghostty.log")
const launchFd = openSync(launchLog, "w")
const child = spawn(GHOSTTY, { detached: true, stdio: ["ignore", launchFd, launchFd] })
child.unref()
report.ghosttyPid = child.pid ?? null
write()

async function waitFor(path: string, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`${label} never appeared within ${ms} ms: ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * The decoded pixels of one capture, kept only in memory: the calibration needs two frames compared
 * byte by byte, which a digest cannot answer. They are never written into the report — a frame is
 * megabytes, and the report is the measurement, not the image.
 */
interface DecodedFrame {
  width: number
  height: number
  rgba: Buffer
}
const frames = new Map<string, DecodedFrame>()

/** True when both images hold the same RGB at this byte offset; alpha is not compared. */
function samePixel(a: Buffer, b: Buffer, offset: number): boolean {
  return a[offset] === b[offset] && a[offset + 1] === b[offset + 1] && a[offset + 2] === b[offset + 2]
}

interface ChangedRectangle {
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** maxX-minX+1 by maxY-minY+1: the bounding box, which is what a rectangle check measures. */
  width: number
  height: number
  /** Pixels that differ anywhere in the frame. */
  changedPixels: number
  /** width*height, the pixels the bounding box holds. */
  boundingArea: number
  /** One solid axis-aligned rectangle: every row in the box is changed across the full box width. */
  solid: boolean
  /** Rows inside the box that are not changed across exactly the full box width, by changed span. */
  raggedRows: { y: number; minX: number; maxX: number; changed: number }[]
}

/**
 * The bounding box of the pixels two frames disagree on, plus whether that box is one solid
 * rectangle. A box that is not solid is reported with the rows that break it, never rounded up to a
 * rectangle: the calibration's whole claim is that exactly one cell changed.
 */
function changedRectangle(a: DecodedFrame, b: DecodedFrame): ChangedRectangle | { refused: string } {
  if (a.width !== b.width || a.height !== b.height) {
    return { refused: `capture extents disagree: ${a.width}x${a.height} against ${b.width}x${b.height}` }
  }
  if (a.rgba.length !== b.rgba.length || a.rgba.length !== a.width * a.height * 4) {
    return { refused: "decoded frames are not both a full rgba image of the same extent" }
  }
  let minX = a.width
  let minY = a.height
  let maxX = -1
  let maxY = -1
  let changedPixels = 0
  const rowSpans: { minX: number; maxX: number; changed: number }[] = Array.from({ length: a.height }, () => ({
    minX: a.width,
    maxX: -1,
    changed: 0,
  }))
  for (let y = 0; y < a.height; y++) {
    const span = rowSpans[y] as { minX: number; maxX: number; changed: number }
    for (let x = 0; x < a.width; x++) {
      const offset = (y * a.width + x) * 4
      if (samePixel(a.rgba, b.rgba, offset)) continue
      changedPixels++
      span.changed++
      if (x < span.minX) span.minX = x
      if (x > span.maxX) span.maxX = x
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return { refused: "the two captures are pixel-identical: nothing changed" }
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  const raggedRows: { y: number; minX: number; maxX: number; changed: number }[] = []
  for (let y = minY; y <= maxY; y++) {
    const span = rowSpans[y] as { minX: number; maxX: number; changed: number }
    if (span.changed !== width || span.minX !== minX || span.maxX !== maxX) {
      raggedRows.push({ y, minX: span.minX, maxX: span.maxX, changed: span.changed })
    }
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    changedPixels,
    boundingArea: width * height,
    solid: raggedRows.length === 0,
    raggedRows,
  }
}

/** A rectangle of one frame, hashed, for a region-level before/after comparison. */
function regionDigest(frame: DecodedFrame, rectangle: { x: number; y: number; width: number; height: number }) {
  const { x, y, width, height } = rectangle
  if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > frame.width || y + height > frame.height) {
    return `refused: ${JSON.stringify(rectangle)} leaves the ${frame.width}x${frame.height} frame`
  }
  const hash = createHash("sha256")
  for (let row = y; row < y + height; row++) {
    hash.update(frame.rgba.subarray(row * frame.width * 4 + x * 4, row * frame.width * 4 + (x + width) * 4))
  }
  return `sha256:${hash.digest("hex")}`
}
await waitFor(join(out, "phase-a"), 60_000, "the terminal's phase-A marker")
report.phaseAAt = new Date().toISOString()
write()

// A window launched from a background step may never be ordered on screen, so the app is asked to
// come to the front before the census. Both the request and its outcome are recorded.
await record("activate", ["/usr/bin/open", "-a", "/Applications/Ghostty.app"])
await new Promise((resolve) => setTimeout(resolve, 2000))

// 4. The CoreGraphics census: window number, owner PID, layer and bounds IN POINTS.
// OptionAll, not OnScreenOnly: the first probe found five windows (Control Center, Window Server,
// Dock) and no terminal at all, so the diagnostic must see off-screen windows too and say which is
// which rather than conclude "no window exists".
const censusScript = `ObjC.import("CoreGraphics"); ObjC.import("Foundation");
function value(dict, key) { var ref = dict.objectForKey(key); return ref ? ref.js : null; }
function bounds(dict) {
  var b = dict.objectForKey("kCGWindowBounds");
  if (!b) return null;
  function n(k) { var v = b.objectForKey(k); return v ? Number(v.js) : null; }
  return { X: n("X"), Y: n("Y"), Width: n("Width"), Height: n("Height") };
}
var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
if (!raw) throw new Error("CGWindowListCopyWindowInfo returned null");
var rows = [], count = $.CFArrayGetCount(raw);
for (var i = 0; i < count; i++) {
  var w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(raw, i));
  rows.push({ number: value(w, "kCGWindowNumber"), owner: value(w, "kCGWindowOwnerName"), pid: value(w, "kCGWindowOwnerPID"), layer: value(w, "kCGWindowLayer"), onscreen: value(w, "kCGWindowIsOnscreen"), alpha: value(w, "kCGWindowAlpha"), name: value(w, "kCGWindowName"), bounds: bounds(w) });
}
JSON.stringify({ windows: rows });`

async function capture(phase: string): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = { phase }
  const censusRun = await record(
    `osascript-census-${phase}`,
    ["/usr/bin/osascript", "-l", "JavaScript", "-e", censusScript],
    20_000,
  )
  if (censusRun.code !== 0 || !censusRun.stdout.trim()) {
    throw new Error(
      `The CoreGraphics census failed for phase ${phase}: exit ${String(censusRun.code)}, ${censusRun.stderr}`,
    )
  }
  const censusRaw = censusRun.stdout.trim()
  writeFileSync(join(out, `census-${phase}.json`), censusRaw)
  const census = JSON.parse(censusRaw) as {
    windows: {
      number: number
      owner: string | null
      pid: number | null
      layer: number
      onscreen: boolean | null
      alpha: number | null
      name: string | null
      bounds: Record<string, number> | null
    }[]
  }
  const owned = census.windows.filter((w) => (w.owner ?? "").trim().toLowerCase() === "ghostty")
  row.ghosttyWindows = owned
  row.censusTotal = census.windows.length
  // Prefer an on-screen layer-0 window, then any layer-0 one, and record which rule matched so a
  // future reader can tell a real capture from a lucky one.
  const target =
    owned.find((w) => w.layer === 0 && w.onscreen === true) ??
    owned.find((w) => w.layer === 0) ??
    owned.find((w) => w.onscreen === true)
  if (!target) {
    const summary = census.windows.map((w) => `${w.owner ?? "?"}/${w.layer}/${String(w.onscreen)}`).join(", ")
    throw new Error(`No ghostty window in the ${census.windows.length}-window census: ${summary}`)
  }
  row.targetRule =
    target.layer === 0 && target.onscreen === true
      ? "layer 0 and on screen"
      : target.layer === 0
        ? "layer 0, NOT on screen"
        : "on screen, layer " + String(target.layer)
  row.ownerPidMatchesApp = target.pid === child.pid
  row.windowNumber = target.number
  row.windowBoundsPoints = target.bounds

  const png = join(out, `capture-${phase}.png`)
  // The bound matters: this repo's own failure-evidence step kills screencapture after 10 s, so a
  // capture that never returns is a recorded outcome here, never a stalled job.
  const shot = await record(
    `screencapture-${phase}`,
    ["/usr/sbin/screencapture", "-l", String(target.number), "-o", "-x", png],
    10_000,
  )
  row.captureExit = shot.code
  row.captureTimedOut = shot.timedOut
  row.captureCreated = existsSync(png)
  if (existsSync(png)) {
    row.pngBytes = (await record(`stat-${phase}`, ["/usr/bin/stat", "-f", "%z", png])).stdout.trim()
    const size = await record(`sips-${phase}`, ["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", png])
    const width = Number(/pixelWidth: (\d+)/.exec(size.stdout)?.[1])
    const height = Number(/pixelHeight: (\d+)/.exec(size.stdout)?.[1])
    row.capturePixels = { width, height }
    const bounds = target.bounds
    row.scale = {
      x: bounds?.Width ? width / bounds.Width : null,
      y: bounds?.Height ? height / bounds.Height : null,
    }
    if (report.magick && (report.magick as { present: boolean }).present) {
      const rgba = await command("magick", [`${png}`, "-depth", "8", "rgba:-"])
      frames.set(phase, { width, height, rgba })
      row.decodedBytes = rgba.length
      row.decodedMatchesExtent = rgba.length === width * height * 4
      row.pixelsDigest = `sha256:${createHash("sha256").update(rgba).digest("hex")}`
      const frame = { width, height, rgba }
      const surface = drawnSurface(frame)
      row.drawnSurface = surface
      const replies = existsSync(join(out, "terminal-replies.txt"))
        ? readFileSync(join(out, "terminal-replies.txt"), "utf8")
        : ""
      // The terminal's own answers, parsed from the bytes it painted: cell size (16 t), text area
      // (14 t) and grid (18 t). Each `read -d t` above consumes the terminating "t", so it is optional.
      const cell = /\[6;(\d+);(\d+)t?/.exec(replies)
      const text = /\[4;(\d+);(\d+)t?/.exec(replies)
      const grid = /\[8;(\d+);(\d+)t?/.exec(replies)
      row.terminalRepliesParsed = {
        cellSize: cell ? { cellHeight: Number(cell[1]), cellWidth: Number(cell[2]) } : null,
        textArea: text ? { textHeight: Number(text[1]), textWidth: Number(text[2]) } : null,
        grid: grid ? { rows: Number(grid[1]), cols: Number(grid[2]) } : null,
      }
      const geometry = text ? { textHeight: Number(text[1]), textWidth: Number(text[2]) } : null
      row.textAreaPlacement =
        geometry && surface.surface
          ? textAreaOrigin({ frame, pixelGeometry: geometry })
          : { skipped: "no parsed 14 t reply or no measurable surface" }
    }
  }
  report[`capture-${phase}`] = row
  write()
  return row
}

await capture("a")
// The marker paints the calibration cell only after this ack, so the phase-A frame is provably the
// frame before the calibration and the phase-A2 frame provably the one after it.
writeFileSync(join(out, "ack-a"), `${new Date().toISOString()}\n`)
await waitFor(join(out, "phase-a2"), 180_000, "the terminal's B2 calibration paint")
report.phaseA2At = new Date().toISOString()
await capture("a2")
writeFileSync(join(out, "ack-a2"), `${new Date().toISOString()}\n`)
await waitFor(join(out, "phase-b"), 120_000, "the terminal's phase-B paint")
report.phaseBAt = new Date().toISOString()
const second = await capture("b")
const first = report["capture-a"] as Record<string, unknown>
report.paintObserved = first.pixelsDigest !== undefined && first.pixelsDigest !== second.pixelsDigest

/**
 * B2 — the calibration measurement (@cto round 2, plan §3e, bead 28785). Between the phase-A and
 * phase-A2 captures the marker changed exactly ONE interior cell's background to a truecolor
 * magenta and touched nothing else, so the pixels that differ between the two frames are the
 * cell-sized axis-aligned rectangle the calibration source promises. The rectangle's top-left, minus
 * the cell's own offset inside the text area, IS the text-area origin — a named, non-colour source.
 * Every other outcome is recorded as a refusal by name; nothing is inferred from the geometry
 * answers and nothing is defaulted.
 */
const cellSize = (first.terminalRepliesParsed as { cellSize: { cellHeight: number; cellWidth: number } | null })
  ?.cellSize
const before = frames.get("a")
const after = frames.get("a2")
if (!before || !after) {
  report.calibration = {
    refused:
      "the phase-A and phase-A2 frames were not both decoded in memory (a magick decode failed or a capture produced no png); the calibration compares pixels, and a digest cannot answer it",
  }
} else if (!cellSize) {
  report.calibration = {
    refused: "the terminal painted no CSI 16 t cell-size answer, so the diff has nothing to check against",
  }
} else {
  const diff = changedRectangle(before, after)
  if ("refused" in diff) {
    report.calibration = { refused: diff.refused, cellSize }
  } else {
    const derivedOrigin = {
      x: diff.minX - (calCol - 1) * cellSize.cellWidth,
      y: diff.minY - (calRow - 1) * cellSize.cellHeight,
    }
    const repoPlacement = first.textAreaPlacement as { origin?: { x: number; y: number } } | undefined
    const repoOrigin = repoPlacement?.origin ?? null
    // The cell the calibration painted, in the frame's own pixels and derived from the diff alone.
    // Its digest must change between the two captures that contain it; a rectangle that does not
    // change the pixels it was derived from would be a contradiction, not a measurement.
    const calibratedCell = {
      x: derivedOrigin.x + (calCol - 1) * cellSize.cellWidth,
      y: derivedOrigin.y + (calRow - 1) * cellSize.cellHeight,
      width: cellSize.cellWidth,
      height: cellSize.cellHeight,
    }
    report.calibration = {
      cell: { row: calRow, col: calCol },
      cellSizeFromTerminal: cellSize,
      rectangle: diff,
      matchesReportedCell: diff.width === cellSize.cellWidth && diff.height === cellSize.cellHeight,
      derivedOrigin,
      repoTextAreaOrigin: repoOrigin,
      originDeltaFromRepoTextAreaOrigin: repoOrigin
        ? { x: derivedOrigin.x - repoOrigin.x, y: derivedOrigin.y - repoOrigin.y }
        : null,
      calibratedCell,
      calibratedCellDigest: { a: regionDigest(before, calibratedCell), a2: regionDigest(after, calibratedCell) },
    }
  }
}
write()
report.terminalReplies = existsSync(join(out, "terminal-replies.txt"))
  ? readFileSync(join(out, "terminal-replies.txt"), "utf8")
  : null
report.ghosttyLog = existsSync(launchLog) ? readFileSync(launchLog, "utf8").slice(0, 4000) : null
report.finishedAt = new Date().toISOString()
write()
console.log(
  JSON.stringify(
    { out, paintObserved: report.paintObserved, magick: report.magick, calibration: report.calibration },
    null,
    2,
  ),
)
// A calibration that could not be measured at all is a named failure with artifacts retained above
// it; a calibration that measured and disagreed with the reported cell size is a RESULT, recorded
// in full and reported, never a fabricated refusal.
const calibration = report.calibration as { refused?: string } | undefined
if (!calibration || calibration.refused) {
  console.error(`B2 calibration refused: ${calibration?.refused ?? "no calibration block was produced"}`)
  process.exitCode = 1
}
