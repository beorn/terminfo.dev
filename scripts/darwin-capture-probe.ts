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
 * The runner does not put a partial repaint on screen at once: a capture ~0.5 s after a one-cell
 * paint was pixel-identical to the frame before it, while a capture ~0.8 s after a full repaint did
 * see the change (2026-10-12T16:00:02Z). Every capture here therefore POLLS to a settled frame and
 * records how many captures that took — an early capture is indistinguishable from a paint that
 * never landed, and that is the trap this measurement exists to remove.
 *
 * Every failure is loud and recorded; nothing is guessed and nothing defaults silently.
 */
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { cellRectangle, command, drawnSurface, textAreaOrigin } from "../packages/terminfo.dev/src/linux-capture.ts"

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
# The calibration window paints the cell and NOTHING else: a timestamp line printed to the tty here
# would change pixels of its own, and the diff would then be the union of a cell and a text line
# instead of one cell. The time of the calibration lives in "$OUT/phase-a2", which is a file.
calibrate
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
 * What two frames are to each other: identical, not comparable, or differing by this bounding box.
 * `identical` is a comparison result and never a refusal — the settle polling below needs to tell a
 * frame that has not changed yet from a comparison that cannot be made at all.
 */
type FrameComparison =
  | { kind: "identical" }
  | { kind: "refused"; reason: string }
  | { kind: "diff"; rectangle: ChangedRectangle }

/**
 * Compare two frames: their bounding box of changed pixels, plus whether that box is one solid
 * rectangle. A box that is not solid is reported with the rows that break it, never rounded up to a
 * rectangle: the calibration's whole claim is that exactly one cell changed.
 */
function compareFrames(a: DecodedFrame, b: DecodedFrame): FrameComparison {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      kind: "refused",
      reason: `capture extents disagree: ${a.width}x${a.height} against ${b.width}x${b.height}`,
    }
  }
  if (a.rgba.length !== b.rgba.length || a.rgba.length !== a.width * a.height * 4) {
    return { kind: "refused", reason: "decoded frames are not both a full rgba image of the same extent" }
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
  if (maxX < 0) return { kind: "identical" }
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
    kind: "diff",
    rectangle: {
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
    },
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
/**
 * The hosted runner does NOT put a partial repaint on screen at once. Measured 2026-10-12T16:00:02Z:
 * a frame captured ~0.5 s after the marker painted one cell was pixel-identical to the frame taken
 * before it, while a capture ~0.8 s after the next full repaint did see its change. A fixed sleep is
 * therefore a coin flip, and worse: a capture that ran early is indistinguishable from a paint that
 * never landed, which is exactly the bug this measurement exists to remove.
 *
 * So every capture here POLLS. `captureSettled` keeps capturing until two frames in a row agree, and
 * `captureUntilChanged` keeps capturing until one differs from a baseline and a further capture
 * confirms the new frame stopped changing. Every attempt is recorded, so an adapter that places a
 * pixel rectangle can bound its own wait on a measured number instead of a guess.
 */
const SETTLE_ATTEMPTS = 10
const SETTLE_GAP_MS = 400
const settleDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface SettleAttempt {
  attempt: number
  label: string
  /** sha256 of the decoded frame, or the value the capture recorded when it could not be decoded. */
  digest: unknown
  /** Whether this frame matched the frame captured before it; null when it was not decodable. */
  sameAsPrevious: boolean | null
}

interface SettledFrame {
  label: string
  frame: DecodedFrame
}

/**
 * One settle outcome, in a shape the report can hold: the frame itself stays in memory (a frame is
 * megabytes), and `settledLabel` names the capture row the frame's measurement was recorded under.
 */
interface SettleResult {
  settled: SettledFrame | null
  /** Why no settled frame exists, when none does. Never a silent empty result. */
  refused: string | null
  /** Every capture this poll made, in order, so a late paint is visible rather than inferred. */
  attempts: SettleAttempt[]
  /** The changed-pixel rectangle, for a poll that was looking for a change. */
  rectangle: ChangedRectangle | null
  /** The capture that confirmed the changed frame had stopped changing. */
  confirmation: SettleAttempt | null
}

/** The poll outcome flattened for the report: the frame itself is dropped, its label kept. */
function settleReport(result: SettleResult): Record<string, unknown> {
  return {
    settledLabel: result.settled?.label ?? null,
    refused: result.refused,
    attempts: result.attempts,
    rectangle: result.rectangle,
    confirmation: result.confirmation,
  }
}

/**
 * Capture until two frames in a row are pixel-identical, and hand back that settled frame. This is
 * the baseline a later comparison needs: comparing against a frame the window server had not finished
 * painting would make a one-cell paint look like it changed the whole screen.
 */
async function captureSettled(phase: string, attempts = SETTLE_ATTEMPTS): Promise<SettleResult> {
  const log: SettleAttempt[] = []
  let previous: SettledFrame | null = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const label = `${phase}-settle${attempt}`
    const row = await capture(label)
    const frame = frames.get(label)
    if (!frame) {
      log.push({ attempt, label, digest: row.pixelsDigest, sameAsPrevious: null })
      await settleDelay(SETTLE_GAP_MS)
      continue
    }
    const same = previous !== null && compareFrames(previous.frame, frame).kind === "identical"
    log.push({ attempt, label, digest: row.pixelsDigest, sameAsPrevious: same })
    if (same && previous !== null) {
      return { settled: previous, refused: null, attempts: log, rectangle: null, confirmation: null }
    }
    previous = { label, frame }
    await settleDelay(SETTLE_GAP_MS)
  }
  return {
    settled: null,
    refused: `no two consecutive captures agreed in ${attempts} captures, so the frame was never seen at rest`,
    attempts: log,
    rectangle: null,
    confirmation: null,
  }
}

/**
 * Capture until the frame differs from the baseline, then confirm the new frame stopped changing (one
 * more capture must be identical to it). The confirmation is what separates "the paint has landed"
 * from "the paint is landing right now", and it is also what makes a mid-paint snapshot impossible to
 * measure by accident.
 */
async function captureUntilChanged(
  baseline: SettledFrame,
  phase: string,
  attempts = SETTLE_ATTEMPTS,
): Promise<SettleResult> {
  const log: SettleAttempt[] = []
  let lastRefusal: string | null = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const label = `${phase}-change${attempt}`
    const row = await capture(label)
    const frame = frames.get(label)
    if (!frame) {
      log.push({ attempt, label, digest: row.pixelsDigest, sameAsPrevious: null })
      lastRefusal = `the capture ${label} could not be decoded`
      await settleDelay(SETTLE_GAP_MS)
      continue
    }
    const comparison = compareFrames(baseline.frame, frame)
    if (comparison.kind === "refused") {
      log.push({ attempt, label, digest: row.pixelsDigest, sameAsPrevious: null })
      return {
        settled: null,
        refused: `the frame could not be compared with the baseline ${baseline.label}: ${comparison.reason}`,
        attempts: log,
        rectangle: null,
        confirmation: null,
      }
    }
    if (comparison.kind === "identical") {
      log.push({ attempt, label, digest: row.pixelsDigest, sameAsPrevious: true })
      lastRefusal = `the frame was still identical to ${baseline.label} after ${attempt} captures`
      await settleDelay(SETTLE_GAP_MS)
      continue
    }
    const confirmLabel = `${label}-confirm`
    const confirmRow = await capture(confirmLabel)
    const confirmFrame = frames.get(confirmLabel)
    const confirmation: SettleAttempt = {
      attempt,
      label: confirmLabel,
      digest: confirmRow.pixelsDigest,
      sameAsPrevious: confirmFrame ? compareFrames(frame, confirmFrame).kind === "identical" : null,
    }
    log.push({ attempt, label, digest: row.pixelsDigest, sameAsPrevious: false })
    if (confirmation.sameAsPrevious === true) {
      return {
        settled: { label, frame },
        refused: null,
        attempts: log,
        rectangle: comparison.rectangle,
        confirmation,
      }
    }
    // Still painting: this frame is a mid-paint snapshot, so keep polling rather than measuring it.
    lastRefusal = `the frame captured as ${label} was still changing when ${confirmLabel} was taken`
    await settleDelay(SETTLE_GAP_MS)
  }
  return {
    settled: null,
    refused: `${lastRefusal ?? "the frame never changed"}; the poll stopped after ${attempts} attempts, each captured and then confirmed`,
    attempts: log,
    rectangle: null,
    confirmation: null,
  }
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
  const row: Record<string, unknown> = { phase, at: new Date().toISOString() }
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

// The phase-A content has to be settled before anything is measured against it: comparing a later
// frame against one the window server had not finished painting would turn a one-cell change into a
// whole-screen one.
const baseline = await captureSettled("a")
report.baseline = settleReport(baseline)
if (!baseline.settled) throw new Error(`The phase-A frame never settled: ${baseline.refused}`)
// The marker paints the calibration cell only after this ack, so the baseline is provably the frame
// before the calibration, and the frame the poll settles on is provably the one after it.
writeFileSync(join(out, "ack-a"), `${new Date().toISOString()}\n`)
await waitFor(join(out, "phase-a2"), 180_000, "the terminal's B2 calibration paint")
report.phaseA2At = new Date().toISOString()
const calibrated = await captureUntilChanged(baseline.settled, "a2")
report.calibrationCapture = settleReport(calibrated)
writeFileSync(join(out, "ack-a2"), `${new Date().toISOString()}\n`)
await waitFor(join(out, "phase-b"), 120_000, "the terminal's phase-B paint")
report.phaseBAt = new Date().toISOString()
const banner = await captureUntilChanged(baseline.settled, "b")
report.bannerCapture = settleReport(banner)
// The paint witness, from the settled frames only: the banner reads PHASE A before the phase-B paint
// and PHASE B after it, and a frame the poll never saw at rest is not a witness of anything.
report.paintObserved = banner.settled !== null

/**
 * B2 — the calibration measurement (@cto round 2, plan §3e, bead 28785). Between the settled phase-A
 * capture and the settled post-calibration capture the marker changed exactly ONE interior cell's
 * background to a truecolor magenta and touched nothing else, so the pixels that differ between the
 * two frames are the cell-sized axis-aligned rectangle the calibration source promises. That
 * rectangle's top-left, minus the cell's own offset inside the text area, IS the text-area origin — a
 * named, non-colour source. Every other outcome is recorded as a refusal by name; nothing is inferred
 * from the geometry answers and nothing is defaulted.
 */
const first = report[`capture-${baseline.settled.label}`] as Record<string, unknown>
const replies = first.terminalRepliesParsed as {
  cellSize: { cellHeight: number; cellWidth: number } | null
  textArea: { textHeight: number; textWidth: number } | null
  grid: { rows: number; cols: number } | null
}
const cellSize = replies?.cellSize ?? null
const before = baseline.settled.frame
const after = calibrated.settled?.frame ?? null
const third = banner.settled?.frame ?? null
if (!after) {
  report.calibration = {
    refused: calibrated.refused ?? "the calibration capture never settled",
    cellSizeFromTerminal: cellSize,
  }
} else if (!cellSize) {
  report.calibration = {
    refused: "the terminal painted no CSI 16 t cell-size answer, so the diff has nothing to check against",
    cellSizeFromTerminal: null,
  }
} else {
  const comparison = compareFrames(before, after)
  if (comparison.kind !== "diff") {
    report.calibration = {
      refused:
        comparison.kind === "identical"
          ? "the settled calibration capture is pixel-identical to the settled frame before it: nothing was painted"
          : comparison.reason,
      cellSizeFromTerminal: cellSize,
    }
  } else {
    const diff = comparison.rectangle
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
    // Round 2 asks for one known row PLACED with the derived origin, with its region digest moving
    // around a provable paint. Row 1 is the banner line, which reads "PHASE A" before the phase-B
    // paint and "PHASE B" after it, so a rectangle placed one row below the derived origin must
    // change around that paint — and must NOT change around the calibration, which touched row 3.
    const knownRowCells = { top: 1, left: 1, bottom: 1, right: 10 }
    let knownRow: Record<string, unknown>
    if (!replies?.textArea || !replies.grid || !third) {
      knownRow = {
        skipped: `a known row needs a 14 t text area, an 18 t grid and a settled banner frame; got textArea=${JSON.stringify(replies?.textArea ?? null)} grid=${JSON.stringify(replies?.grid ?? null)} bannerFrame=${third ? "settled" : "absent"}`,
      }
    } else {
      try {
        const rectangle = cellRectangle({
          cells: knownRowCells,
          pixelGeometry: { cellWidth: cellSize.cellWidth, cellHeight: cellSize.cellHeight, ...replies.textArea },
          textOrigin: derivedOrigin,
          windowWidth: before.width,
          windowHeight: before.height,
        })
        const phaseA = regionDigest(before, rectangle)
        const phaseA2 = regionDigest(after, rectangle)
        const phaseB = regionDigest(third, rectangle)
        knownRow = {
          cells: knownRowCells,
          rectangle,
          digestPhaseA: phaseA,
          digestPhaseA2: phaseA2,
          digestPhaseB: phaseB,
          changedAroundTheCalibration: phaseA !== phaseA2,
          changedAroundTheBannerPaint: phaseA2 !== phaseB,
        }
      } catch (error) {
        // A derived origin that cannot place a known row inside the window is a refusal by name, not
        // a thrown script: the calibration result is the measurement, and losing it would be worse.
        knownRow = { refused: String(error) }
      }
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
      knownRowPlacedWithDerivedOrigin: knownRow,
    }
  }
}
write()
report.terminalReplies = existsSync(join(out, "terminal-replies.txt"))
  ? readFileSync(join(out, "terminal-replies.txt"), "utf8")
  : null
report.markerRefusal = existsSync(join(out, "marker-refusal"))
  ? readFileSync(join(out, "marker-refusal"), "utf8")
  : null
report.ghosttyLog = existsSync(launchLog) ? readFileSync(launchLog, "utf8").slice(0, 4000) : null
report.finishedAt = new Date().toISOString()
write()
console.log(
  JSON.stringify(
    {
      out,
      paintObserved: report.paintObserved,
      magick: report.magick,
      baseline: report.baseline,
      calibrationCapture: report.calibrationCapture,
      bannerCapture: report.bannerCapture,
      calibration: report.calibration,
    },
    null,
    2,
  ),
)
// A calibration that could not be measured is a named failure with its artifacts retained above it; a
// calibration that measured and disagreed with the reported cell size is a RESULT, recorded in full
// and reported, never rounded into a refusal.
const calibration = report.calibration as { refused?: string } | undefined
if (!calibration || calibration.refused) {
  console.error(`B2 calibration refused: ${calibration?.refused ?? "no calibration block was produced"}`)
  process.exitCode = 1
}
