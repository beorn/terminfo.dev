import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * Who owns an X selection at one instant (33693, @cto 379b191a). The pre-flight's baseline helper exits 0 when
 * another client claims the selection; this names that client instead of inferring it from receipts.
 *
 * The X calls run in a short child process with a time limit, never inside the collector: a bad pointer in
 * foreign code kills the child, which costs one taker read and never the run.
 */
export type SelectionTakerRead =
  | {
      readonly read: true
      readonly at: string
      /** XGetSelectionOwner, as 0x-hex. */
      readonly window: string
      /** Every top-level window of the owner's X client (same resource base under the server's resource mask). */
      readonly clientWindows: readonly string[]
      /** WM_CLASS and _NET_WM_PID of the first of those windows that carries a WM_CLASS; absent when none does. */
      readonly takerClass?: string
      readonly takerPid?: number
    }
  | { readonly read: false; readonly at: string; readonly reason: string }

/** The child's whole program: open the display, read the owner, the resource mask and the root's children. */
export const SELECTION_OWNER_SCRIPT = `
const { dlopen, read, ptr } = require("bun:ffi")
const [lib, name] = process.argv.slice(-2)
const x = dlopen(lib, {
  XOpenDisplay: { args: ["ptr"], returns: "ptr" },
  XInternAtom: { args: ["ptr", "ptr", "i32"], returns: "u64" },
  XGetSelectionOwner: { args: ["ptr", "u64"], returns: "u64" },
  XDefaultRootWindow: { args: ["ptr"], returns: "u64" },
  XQueryTree: { args: ["ptr", "u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  XFree: { args: ["ptr"], returns: "i32" },
  XCloseDisplay: { args: ["ptr"], returns: "i32" },
}).symbols
const d = x.XOpenDisplay(null)
if (!d) {
  process.stderr.write("XOpenDisplay failed for DISPLAY=" + (process.env.DISPLAY ?? "unset"))
  process.exit(3)
}
const owner = x.XGetSelectionOwner(d, x.XInternAtom(d, ptr(Buffer.from(name + "\\0")), 0))
// Xlib's public _XPrivDisplay ABI: private4 at offset 48 is the connection's resource_mask.
const mask = read.u64(d, 48)
const rootOut = new BigUint64Array(1), parentOut = new BigUint64Array(1), listOut = new BigUint64Array(1)
const countOut = new Uint32Array(1)
const children = []
if (x.XQueryTree(d, x.XDefaultRootWindow(d), ptr(rootOut), ptr(parentOut), ptr(listOut), ptr(countOut))) {
  const list = Number(listOut[0])
  for (let i = 0; i < countOut[0]; i++) children.push(read.u64(list, i * 8).toString())
  if (list) x.XFree(list)
}
process.stdout.write(JSON.stringify({ owner: owner.toString(), mask: mask.toString(), children }))
x.XCloseDisplay(d)
`

/** The libX11 a live helper has mapped: the same library the image's xclip links, read from /proc, not guessed. */
export function mappedLibX11(
  pid: number,
  readMaps: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string {
  const line = readMaps(`/proc/${pid}/maps`)
    .split("\n")
    .find((row) => /\/libX11\.so\.6(\.\d+)*$/.test(row.trim()))
  const path = line?.trim().split(/\s+/).at(-1)
  if (!path) throw new Error(`helper ${pid} has no libX11.so.6 mapped, so the selection taker cannot be read`)
  return path
}

export interface SelectionOwnerIo {
  /** Run the child; resolves its exit code and output, never rejects on a nonzero exit. */
  child(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>
  /** `xprop -id <window> WM_CLASS _NET_WM_PID` output. */
  xprop(window: string): Promise<string>
}

const hex = (id: bigint) => `0x${id.toString(16)}`

/** The child's JSON as X ids, or null when a field is missing or not a decimal integer. */
function xIds(parsed: unknown): { owner: bigint; mask: bigint; children: bigint[] } | null {
  const decimal = (value: unknown) => (typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null)
  if (typeof parsed !== "object" || parsed === null) return null
  const { owner, mask, children } = parsed as Record<string, unknown>
  const ownerId = decimal(owner)
  const maskBits = decimal(mask)
  if (ownerId === null || maskBits === null || !Array.isArray(children)) return null
  const childIds = children.map(decimal)
  if (childIds.some((id) => id === null)) return null
  return { owner: ownerId, mask: maskBits, children: childIds as bigint[] }
}

/** Read the selection's owner and name its client. Every failure is a named `read: false`, never a throw. */
export async function readSelectionTaker(
  selection: "clipboard" | "primary",
  libX11: string,
  io: SelectionOwnerIo,
  timeoutMs = 2000,
): Promise<SelectionTakerRead> {
  const at = new Date().toISOString()
  const ran = await io.child([libX11, selection.toUpperCase()], timeoutMs).catch((error: unknown) => ({
    code: null,
    signal: null,
    stdout: "",
    stderr: `child did not start: ${error instanceof Error ? error.message : String(error)}`,
  }))
  if (ran.code !== 0) {
    const how = ran.signal ? `signal ${ran.signal}` : `exited ${ran.code ?? "without a code"}`
    return { read: false, at, reason: `taker child ${how}${ran.stderr.trim() ? `: ${ran.stderr.trim()}` : ""}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(ran.stdout)
  } catch {
    return { read: false, at, reason: `taker child printed no JSON: ${JSON.stringify(ran.stdout.slice(0, 120))}` }
  }
  const fields = xIds(parsed)
  if (fields === null) {
    return {
      read: false,
      at,
      reason: `taker child printed JSON without a numeric owner, mask and children list: ${JSON.stringify(ran.stdout.slice(0, 120))}`,
    }
  }
  const { owner, mask, children } = fields
  if (owner === 0n) return { read: false, at, reason: `${selection} has no owner` }
  const base = owner & ~mask
  const clientWindows = children.filter((id) => (id & ~mask) === base)
  for (const id of clientWindows) {
    const props = await io.xprop(hex(id)).catch(() => "")
    const wmClass = /^WM_CLASS\(STRING\) = (.+)$/m.exec(props)?.[1]
    if (!wmClass) continue
    const pid = /^_NET_WM_PID\(CARDINAL\) = (\d+)$/m.exec(props)?.[1]
    return {
      read: true,
      at,
      window: hex(owner),
      clientWindows: clientWindows.map(hex),
      takerClass: wmClass,
      ...(pid && { takerPid: Number(pid) }),
    }
  }
  return { read: true, at, window: hex(owner), clientWindows: clientWindows.map(hex) }
}

/** The real child: this Bun runs the script with DISPLAY from `env`, killed at the time limit. */
export function selectionOwnerIo(
  env: NodeJS.ProcessEnv,
  run: (file: string, args: string[]) => Promise<string>,
): SelectionOwnerIo {
  return {
    child: (args, timeoutMs) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", SELECTION_OWNER_SCRIPT, ...args], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: timeoutMs,
          killSignal: "SIGKILL",
        })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        child.once("error", reject)
        child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
      }),
    xprop: (window) => run("xprop", ["-id", window, "WM_CLASS", "_NET_WM_PID"]),
  }
}
