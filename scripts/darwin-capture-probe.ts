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
//    queries, then paints a DIFFERENT frame (phase B) that a second capture must observe.
const marker = join(out, "marker.command")
writeFileSync(
  marker,
  `#!/bin/bash
set -u
OUT=${JSON.stringify(out)}
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
{
  paint A
  ask '\\033[14t'
  ask '\\033[16t'
  ask '\\033[18t'
  printf 'painted-phase-A %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "$OUT/terminal-replies.txt" 2>&1
cat "$OUT/terminal-replies.txt" > /dev/tty
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$OUT/phase-a"
sleep 12
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
await waitFor(join(out, "phase-b"), 120_000, "the terminal's phase-B paint")
report.phaseBAt = new Date().toISOString()
const second = await capture("b")
const first = report["capture-a"] as Record<string, unknown>
report.paintObserved = first.pixelsDigest !== undefined && first.pixelsDigest !== second.pixelsDigest
report.terminalReplies = existsSync(join(out, "terminal-replies.txt"))
  ? readFileSync(join(out, "terminal-replies.txt"), "utf8")
  : null
report.ghosttyLog = existsSync(launchLog) ? readFileSync(launchLog, "utf8").slice(0, 4000) : null
report.finishedAt = new Date().toISOString()
write()
console.log(JSON.stringify({ out, paintObserved: report.paintObserved, magick: report.magick }, null, 2))
