/**
 * The ffi half of the hosted Windows console read (29558, option A). Windows-only, and reachable
 * ONLY through a dynamic import: `node:tty` cannot build a stream on this console (Node 24
 * ERR_TTY_INIT_FAILED, uv_tty_init EBADF) and Bun's `process.stdout` reports no window size at all
 * (isTTY false, columns/rows null, on fd 1 and on an explicitly opened CONOUT$ alike) — measured
 * 2026-10-15 on the hosted runner, runs 38814184347 and 38814967131. So the arm reads the console
 * itself, from the collector's own CONOUT$ handle.
 *
 * The mapping is the one measured there: on this ConPTY buffer == window, and the classics compare
 * visible-cell positions, so the WINDOW rect is the quantity — rows = bottom - top + 1,
 * cols = right - left + 1 — never the buffer height, which is scrollback-inclusive.
 *
 * The byte offsets are the CONSOLE_SCREEN_BUFFER_INFO layout: dwSize at 0, dwCursorPosition at 4,
 * wAttributes at 8, then the SMALL_RECT srWindow at 10 (left, top, right, bottom; four int16s).
 */
import { INVALID_HANDLE_VALUE, loadKernel32, type Kernel32 } from "./windows-kernel32.ts"
import type { ConsoleGeometry } from "./windows-console-geometry.ts"

/** The console screen buffer info, as the two windows the collector needs. */
export const CSBI_BYTES = 32
const SR_WINDOW_LEFT = 10
const SR_WINDOW_TOP = 12
const SR_WINDOW_RIGHT = 14
const SR_WINDOW_BOTTOM = 16

const GENERIC_READ_WRITE = 0xc0000000
const FILE_SHARE_READ_WRITE = 3
const OPEN_EXISTING = 3

/** The visible window's edges, in the console buffer's own 0-based coordinates — what
 * ReadConsoleOutputW takes as its read region. */
export interface ConsoleWindowRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** Decode a CSBI read into its window rectangle. Both window reads start here, so the offsets are
 * stated once. */
export function decodeConsoleWindowRect(bytes: Uint8Array): ConsoleWindowRect {
  if (bytes.byteLength < SR_WINDOW_BOTTOM + 2) {
    throw new Error(`CONSOLE_SCREEN_BUFFER_INFO read is ${String(bytes.byteLength)} bytes, short of the 22 it needs`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const left = view.getInt16(SR_WINDOW_LEFT, true)
  const top = view.getInt16(SR_WINDOW_TOP, true)
  const right = view.getInt16(SR_WINDOW_RIGHT, true)
  const bottom = view.getInt16(SR_WINDOW_BOTTOM, true)
  if (right - left + 1 < 1 || bottom - top + 1 < 1) {
    throw new Error(
      `console window rect is not a size: left ${String(left)}, top ${String(top)}, right ${String(right)}, bottom ${String(bottom)}`,
    )
  }
  return { left, top, right, bottom }
}

/** Decode a CSBI read into the console's visible window. Pure, so the mapping is testable where
 * the console is not: the two geometries measured on the hosted runner are its fixtures. */
export function decodeConsoleScreenBufferInfo(bytes: Uint8Array): ConsoleGeometry {
  const { left, top, right, bottom } = decodeConsoleWindowRect(bytes)
  return { cols: right - left + 1, rows: bottom - top + 1 }
}

/** This process's own console window handle — the identity a re-read is checked against. It is
 * stable inside one console and different for a different console (measured: 327766 twice, then
 * 328074 in the previous run), which is what makes a per-read change check meaningful. */
export function readWindowsConsoleIdentity(kernel?: Kernel32): string {
  const { symbols } = kernel ?? loadKernel32()
  // GetConsoleWindow returns HWND, a handle, so it arrives as a BigInt (u64) and String() renders
  // all 64 bits as plain decimal - the same shape the measured identities were recorded in.
  return String(symbols.GetConsoleWindow())
}

/** The least right that answers "which executable is this pid running":
 * PROCESS_QUERY_LIMITED_INFORMATION, which a hosted runner grants without elevation. */
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
/** One long-path buffer, in UTF-16 code units: MAX_PATH is not the ceiling on Windows, and a
 * truncated path would name a file this run never hashed. */
export const EXECUTABLE_PATH_CHARS = 32_768
/** One FILETIME: two little-endian DWORDs of 100-ns ticks since 1601. */
const FILETIME_BYTES = 8

/**
 * The executable a pid is running and the incarnation that runs it, or the named reason either
 * could not be read. `createdAt` is GetProcessTimes' creation FILETIME in 100-ns ticks since 1601:
 * a reused PID has a new one, so it separates two processes that share a pid and an image path
 * (30042, CTO ruling 910846c7).
 */
export type ExecutablePathLookup =
  | { readonly status: "named"; readonly path: string; readonly createdAt: string }
  | { readonly status: "refused"; readonly reason: string }

/**
 * Resolve a process's image path with QueryFullProcessImageNameW and its creation time with
 * GetProcessTimes, on ONE handle: PROCESS_QUERY_LIMITED_INFORMATION serves both calls, so the
 * identity is read from a single incarnation and no second open can see a different process. Every
 * failure reads GetLastError FIRST and becomes a named refusal: the caller attributes a buffer to
 * this program, so an empty or guessed path would be worse than no read at all (30042).
 */
export function readProcessImagePath(pid: number, kernel?: Kernel32): ExecutablePathLookup {
  const { symbols, ptr } = kernel ?? loadKernel32()
  const handle = symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION as never, 0 as never, pid as never)
  // OpenProcess returns NULL on failure. INVALID_HANDLE_VALUE is CreateFileW's sentinel, not this
  // call's, so the test is zero rather than the shared constant.
  if (handle === 0n) {
    const code = symbols.GetLastError()
    return { status: "refused", reason: `cannot open console host pid ${String(pid)}: error ${String(code)}` }
  }
  try {
    const name = Buffer.alloc(EXECUTABLE_PATH_CHARS * 2)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(EXECUTABLE_PATH_CHARS, 0)
    if (symbols.QueryFullProcessImageNameW(handle as never, 0 as never, ptr(name) as never, ptr(size) as never) === 0) {
      const code = symbols.GetLastError()
      return {
        status: "refused",
        reason: `cannot read the executable path of console host pid ${String(pid)}: error ${String(code)}`,
      }
    }
    // lpdwSize returns the number of UTF-16 code units written, NOT bytes: decoding by bytes would
    // append half the following unit and name a file this run never opened.
    const characters = size.readUInt32LE(0)
    if (characters === 0 || characters > EXECUTABLE_PATH_CHARS) {
      return {
        status: "refused",
        reason: `console host pid ${String(pid)} reported ${String(characters)} executable-path characters`,
      }
    }
    // GetProcessTimes refuses a NULL pointer for any of its four FILETIMEs, so one 32-byte block
    // carries all four and only the first is read.
    const times = Buffer.alloc(FILETIME_BYTES * 4)
    const at = (index: number) => ptr(times.subarray(index * FILETIME_BYTES, (index + 1) * FILETIME_BYTES)) as never
    if (symbols.GetProcessTimes(handle as never, at(0), at(1), at(2), at(3)) === 0) {
      const code = symbols.GetLastError()
      return {
        status: "refused",
        reason: `cannot read the creation time of console host pid ${String(pid)}: error ${String(code)}`,
      }
    }
    // FILETIME is two little-endian DWORDs; combining them in one BigInt keeps every tick the
    // kernel reported, where a Number would round the low bits away.
    const ticks = (BigInt(times.readUInt32LE(FILETIME_BYTES)) << 32n) | BigInt(times.readUInt32LE(0))
    return { status: "named", path: name.toString("utf16le", 0, characters * 2), createdAt: String(ticks) }
  } finally {
    symbols.CloseHandle(handle as never)
  }
}

/** Open this process's CONOUT$ for the duration of one read. Every console read on this arm goes
 * through here, so the handle dance (and the GetLastError-before-anything-else rule) exists once. */
export async function withConsoleOutputHandle<T>(
  read: (handle: bigint, kernel: Kernel32) => Promise<T> | T,
  /** The binding to use; production loads kernel32.dll. Tests inject a fake so the handle dance,
   * the argument packing and the decode are all asserted where no console exists. */
  kernel?: Kernel32,
): Promise<T> {
  const binding = kernel ?? loadKernel32()
  const { symbols, ptr } = binding
  const handle = symbols.CreateFileW(
    ptr(Buffer.from("CONOUT$\u0000", "utf16le")) as never,
    GENERIC_READ_WRITE as never,
    FILE_SHARE_READ_WRITE as never,
    null as never,
    OPEN_EXISTING as never,
    0 as never,
    // hTemplateFile is a HANDLE position, so it is declared u64 and passed as one: NULL for the
    // u64, never a pointer-shaped null.
    0n as never,
  )
  // A failed handle-returning call yields INVALID_HANDLE_VALUE, which is neither NULL nor zero, and
  // its Win32 code is read FIRST: any other native call in between clobbers the last-error slot.
  if (handle === INVALID_HANDLE_VALUE) {
    const code = symbols.GetLastError()
    throw new Error(`CreateFileW CONOUT$ failed with error ${String(code)}`)
  }
  try {
    return await read(handle, binding)
  } finally {
    symbols.CloseHandle(handle as never)
  }
}

/** Open this process's CONOUT$ and read the visible window off it. */
export async function readWindowsConsoleGeometry(kernel?: Kernel32): Promise<ConsoleGeometry> {
  return withConsoleOutputHandle((handle, { symbols, ptr }) => {
    const info = Buffer.alloc(CSBI_BYTES)
    if (symbols.GetConsoleScreenBufferInfo(handle as never, ptr(info) as never) === 0) {
      const code = symbols.GetLastError()
      throw new Error(`GetConsoleScreenBufferInfo failed with error ${String(code)}`)
    }
    return decodeConsoleScreenBufferInfo(info)
  }, kernel)
}
