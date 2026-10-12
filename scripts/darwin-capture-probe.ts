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
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
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

/** Every external command is recorded with its exact argv, exit and stderr — no silent step. */
function record(label: string, argv: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" })
  const row = {
    argv,
    code: result.exitCode,
    stdout: String(result.stdout ?? "").slice(0, 4000),
    stderr: String(result.stderr ?? "").slice(0, 4000),
  }
  report[label] = row
  write()
  return row
}

// 1. Decoder availability: the plan uses magick at depth 8 on both platforms.
try {
  const version = await command("magick", ["-version"])
  report.magick = { present: true, version: version.toString("utf8").split("\n")[0] }
} catch (error) {
  report.magick = { present: false, error: String(error) }
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
  printf '%s' "$1" > /dev/tty
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
date -u '+%Y-%m-%dT%H:%M:%S.%NZ' > "$OUT/phase-a"
sleep 12
paint B
printf 'painted-phase-B %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > /dev/tty
date -u '+%Y-%m-%dT%H:%M:%S.%NZ' > "$OUT/phase-b"
sleep 60
`,
  { mode: 0o755 },
)

// 3. Launch ghostty exactly as the measurement workflow does: a config command, then the binary.
mkdirSync(join(homedir(), ".config", "ghostty"), { recursive: true })
writeFileSync(join(homedir(), ".config", "ghostty", "config"), `command = /bin/bash ${marker}\n`)
const launchLog = join(out, "ghostty.log")
const child = spawn(GHOSTTY, { detached: true, stdio: ["ignore", "pipe", "pipe"] })
let launchOutput = ""
child.stdout?.on("data", (chunk: Buffer) => (launchOutput += chunk.toString("utf8")))
child.stderr?.on("data", (chunk: Buffer) => (launchOutput += chunk.toString("utf8")))
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

// 4. The CoreGraphics census: window number, owner PID, layer and bounds IN POINTS.
const censusScript = `ObjC.import("CoreGraphics"); ObjC.import("Foundation");
function value(dict, key) { var ref = dict.objectForKey(key); return ref ? ref.js : null; }
function bounds(dict) {
  var b = dict.objectForKey("kCGWindowBounds");
  if (!b) return null;
  function n(k) { var v = b.objectForKey(k); return v ? Number(v.js) : null; }
  return { X: n("X"), Y: n("Y"), Width: n("Width"), Height: n("Height") };
}
var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
if (!raw) throw new Error("CGWindowListCopyWindowInfo returned null");
var rows = [], count = $.CFArrayGetCount(raw);
for (var i = 0; i < count; i++) {
  var w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(raw, i));
  rows.push({ number: value(w, "kCGWindowNumber"), owner: value(w, "kCGWindowOwnerName"), pid: value(w, "kCGWindowOwnerPID"), layer: value(w, "kCGWindowLayer"), bounds: bounds(w) });
}
JSON.stringify({ windows: rows });`

async function capture(phase: string): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = { phase }
  const censusRaw = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", censusScript], {
    encoding: "utf8",
    timeout: 20_000,
  }).trim()
  writeFileSync(join(out, `census-${phase}.json`), censusRaw)
  const census = JSON.parse(censusRaw) as {
    windows: {
      number: number
      owner: string | null
      pid: number | null
      layer: number
      bounds: Record<string, number> | null
    }[]
  }
  const owned = census.windows.filter((w) => w.owner === "ghostty")
  row.ghosttyWindows = owned
  row.censusTotal = census.windows.length
  const target = owned.find((w) => w.layer === 0)
  if (!target) throw new Error(`No layer-0 ghostty window in the ${census.windows.length}-window census`)
  row.ownerPidMatchesApp = target.pid === child.pid
  row.windowNumber = target.number
  row.windowBoundsPoints = target.bounds

  const png = join(out, `capture-${phase}.png`)
  const shot = record(`screencapture-${phase}`, [
    "/usr/sbin/screencapture",
    "-l",
    String(target.number),
    "-o",
    "-x",
    png,
  ])
  row.captureExit = shot.code
  row.captureCreated = existsSync(png)
  if (existsSync(png)) {
    row.pngBytes = execFileSync("/usr/bin/stat", ["-f", "%z", png], { encoding: "utf8" }).trim()
    const size = record(`sips-${phase}`, ["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", png])
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
        ? execFileSync("/bin/cat", [join(out, "terminal-replies.txt")], { encoding: "utf8" })
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
  ? execFileSync("/bin/cat", [join(out, "terminal-replies.txt")], { encoding: "utf8" })
  : null
report.ghosttyLog = launchOutput.slice(0, 4000)
report.finishedAt = new Date().toISOString()
write()
console.log(JSON.stringify({ out, paintObserved: report.paintObserved, magick: report.magick }, null, 2))
