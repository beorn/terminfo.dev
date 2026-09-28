import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ProbeCapture } from "./probes/unified.ts"

function command(file: string, args: string[], input?: Buffer): Buffer {
  return execFileSync(file, args, { input, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 })
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function retain(directory: string, bytes: Buffer, extension: string): string {
  const hash = digest(bytes)
  const path = join(directory, `${hash}.${extension}`)
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!readFileSync(path).equals(bytes)) throw new Error(`Capture artifact digest collision at ${path}`)
  }
  return `sha256:${hash}`
}

/** Resolve the actual terminal ancestor, never a class label or newest window. */
function kittyAncestor(executable: string): number {
  let pid = process.pid
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    const path = realpathSync(`/proc/${pid}/exe`)
    if (path === executable) return pid
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const parent = Number(fields[1])
    if (!Number.isSafeInteger(parent) || parent < 1 || parent === pid) {
      throw new Error(`Cannot resolve terminal parent of collector PID ${pid}`)
    }
    pid = parent
  }
  throw new Error(`Collector PID ${process.pid} has no ancestor running ${executable}`)
}

/** Optional Linux adapter. Once configured, every ownership/capture failure is loud. */
export function createLinuxCapture(directory: string, kittyBinary: string): ProbeCapture {
  if (process.platform !== "linux" || !process.env.DISPLAY) {
    throw new Error("Linux capture requires Linux and the owned DISPLAY")
  }
  const executable = realpathSync(kittyBinary)
  const kittyPid = kittyAncestor(executable)
  const windows = command("xdotool", ["search", "--onlyvisible", "--pid", String(kittyPid)])
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const windowId = windows[0]
  if (windows.length !== 1 || !windowId || !/^\d+$/.test(windowId)) {
    throw new Error(`Collector's Kitty PID ${kittyPid} owns ${windows.length} visible windows; expected one`)
  }
  const ownedWindowId = windowId
  function assertOwned() {
    if (kittyAncestor(executable) !== kittyPid) throw new Error("Collector terminal process changed during capture")
    const owner = command("xdotool", ["getwindowpid", ownedWindowId]).toString().trim()
    if (owner !== String(kittyPid)) throw new Error(`Capture window ${windowId} no longer belongs to Kitty ${kittyPid}`)
  }
  assertOwned()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const converter = command("magick", ["-version"]).toString().trim()
  const geometry = command("xdotool", ["getwindowgeometry", "--shell", windowId]).toString()
  return async ({ featureId, role, label }) => {
    // Static-frame settling is recorded; callbacks own any temporal schedule.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150)
    })
    assertOwned()
    const before = command("xdotool", ["getwindowgeometry", "--shell", windowId]).toString()
    if (before !== geometry) throw new Error(`Capture window ${windowId} geometry changed during ${featureId}`)
    const original = command("xwd", ["-id", windowId, "-silent"])
    const capturedAt = Date.now()
    const png = command("magick", ["xwd:-", "png:-"], original)
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Capture conversion did not produce PNG bytes for ${featureId}`)
    }
    assertOwned()
    const after = command("xdotool", ["getwindowgeometry", "--shell", windowId]).toString()
    if (after !== geometry) throw new Error(`Capture window ${windowId} geometry changed during ${featureId}`)
    const sourceRef = retain(directory, original, "xwd")
    const ref = retain(directory, png, "png")
    return {
      frame: { role, label, capturedAt, ref, sourceRef },
      trace: {
        featureId,
        collectorPid: process.pid,
        kittyPid,
        executable,
        windowId,
        geometry,
        converter,
        settleMs: 150,
      },
    }
  }
}
