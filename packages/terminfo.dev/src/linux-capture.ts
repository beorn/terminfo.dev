import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ProbeCapture } from "./probes/unified.ts"

export interface LiveExecutable {
  path: string
  sha256: string
}

/** Bind a launched process to the same actual ELF bytes recorded by the launcher. */
export function assertLiveExecutable(pid: number, expected: LiveExecutable): void {
  if (
    !Number.isSafeInteger(pid) ||
    pid < 2 ||
    !expected.path.startsWith("/") ||
    !/^[0-9a-f]{64}$/.test(expected.sha256)
  ) {
    throw new Error("Invalid measured executable identity")
  }
  const path = realpathSync(`/proc/${pid}/exe`)
  if (path !== expected.path) throw new Error(`Live executable path mismatch for PID ${pid}: ${path}`)
  if (digest(readFileSync(`/proc/${pid}/exe`)) !== expected.sha256) {
    throw new Error(`Live executable digest mismatch for PID ${pid}`)
  }
}

function command(file: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let stdinError: Error | undefined
    const child = execFile(
      file,
      args,
      { encoding: "buffer", timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else if (stdinError) reject(stdinError)
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      },
    )
    if (!child.stdin) {
      if (input) reject(new Error(`Capture command ${file} has no stdin for ${input.length} input bytes`))
      return
    }
    child.stdin.on("error", (error: Error) => {
      stdinError = error
    })
    child.stdin.end(input)
  })
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
function kittyAncestor(executable: LiveExecutable): number {
  let pid = process.pid
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    const path = realpathSync(`/proc/${pid}/exe`)
    if (path === executable.path) {
      assertLiveExecutable(pid, executable)
      return pid
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const parent = Number(fields[1])
    if (!Number.isSafeInteger(parent) || parent < 1 || parent === pid) {
      throw new Error(`Cannot resolve terminal parent of collector PID ${pid}`)
    }
    pid = parent
  }
  throw new Error(`Collector PID ${process.pid} has no ancestor running ${executable.path}`)
}

/** Optional Linux adapter. Once configured, every ownership/capture failure is loud. */
export async function createLinuxCapture(directory: string, executable: LiveExecutable): Promise<ProbeCapture> {
  if (process.platform !== "linux" || !process.env.DISPLAY) {
    throw new Error("Linux capture requires Linux and the owned DISPLAY")
  }
  const kittyPid = kittyAncestor(executable)
  const windows = (await command("xdotool", ["search", "--onlyvisible", "--pid", String(kittyPid)]))
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const windowId = windows[0]
  if (windows.length !== 1 || !windowId || !/^\d+$/.test(windowId)) {
    throw new Error(`Collector's Kitty PID ${kittyPid} owns ${windows.length} visible windows; expected one`)
  }
  const ownedWindowId = windowId
  async function assertOwned() {
    if (kittyAncestor(executable) !== kittyPid) throw new Error("Collector terminal process changed during capture")
    const owner = (await command("xdotool", ["getwindowpid", ownedWindowId])).toString().trim()
    if (owner !== String(kittyPid)) throw new Error(`Capture window ${windowId} no longer belongs to Kitty ${kittyPid}`)
  }
  await assertOwned()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const converter = (await command("magick", ["-version"])).toString().trim()
  const geometry = (await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString()
  return async ({ featureId, role, label }) => {
    // Static-frame settling is recorded; callbacks own any temporal schedule.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150)
    })
    await assertOwned()
    const before = (await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString()
    if (before !== geometry) throw new Error(`Capture window ${windowId} geometry changed during ${featureId}`)
    const original = await command("xwd", ["-id", windowId, "-silent"])
    const capturedAt = Date.now()
    const png = await command("magick", ["xwd:-", "png:-"], original)
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Capture conversion did not produce PNG bytes for ${featureId}`)
    }
    await assertOwned()
    const after = (await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString()
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
