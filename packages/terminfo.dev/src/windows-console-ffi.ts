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
