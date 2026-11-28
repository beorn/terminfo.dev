/**
 * The user32 binding behind the hosted Windows input route (#30723), and the one production
 * `Win32InputOs` built on it.
 *
 * Loaded on demand through `process.getBuiltinModule("bun:ffi")`, the way windows-kernel32.ts is:
 * importing this module makes no native call, so nothing that does not call `loadWin32InputOs()`
 * changes. Every HANDLE (HWND, HDESK, DPI_AWARENESS_CONTEXT) is a `u64` and comes back as a BigInt;
 * every real pointer stays `ptr` (the same rule and reason as kernel32Declaration).
 *
 * The struct layouts are the x64 ones, written out here and pinned by windows-input.test.ts's user32 block, because
 * the hosted Windows runner is x64 and nothing can assert them on Windows until a hosted run happens.
 */
import type { OwnedFrame } from "./input-fixture.ts"
import type { Win32InputEvent, Win32InputOs } from "./windows-input.ts"

export type User32Symbol = (...args: never[]) => number
export type User32HandleSymbol = (...args: never[]) => bigint

export interface User32Symbols {
  GetForegroundWindow: User32HandleSymbol
  GetWindowThreadProcessId: User32Symbol
  GetGUIThreadInfo: User32Symbol
  GetAncestor: User32HandleSymbol
  SetForegroundWindow: User32Symbol
  AttachThreadInput: User32Symbol
  GetClientRect: User32Symbol
  GetWindowRect: User32Symbol
  ClientToScreen: User32Symbol
  GetCursorPos: User32Symbol
  GetSystemMetrics: User32Symbol
  SendInput: User32Symbol
  VkKeyScanW: User32Symbol
  MapVirtualKeyW: User32Symbol
  SetProcessDpiAwarenessContext: User32Symbol
  GetThreadDpiAwarenessContext: User32HandleSymbol
  AreDpiAwarenessContextsEqual: User32Symbol
  OpenInputDesktop: User32HandleSymbol
  GetThreadDesktop: User32HandleSymbol
  GetUserObjectInformationW: User32Symbol
  CloseDesktop: User32Symbol
}

interface ThreadSymbols {
  GetCurrentThreadId: User32Symbol
  GetLastError: User32Symbol
  OpenProcess: User32HandleSymbol
  CloseHandle: User32Symbol
}

interface TokenSymbols {
  OpenProcessToken: User32Symbol
  GetTokenInformation: User32Symbol
}

interface FfiModule {
  dlopen(
    path: string,
    symbols: Record<string, { args: readonly unknown[]; returns: unknown }>,
  ): { symbols: Record<string, (...args: never[]) => number | bigint> }
  FFIType: Record<string, unknown>
  ptr(data: Uint8Array): unknown
}

/** `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`, `(HANDLE)-4`. */
export const DPI_PER_MONITOR_AWARE_V2 = 0xfffffffffffffffcn

/** `sizeof(INPUT)` on x64: a DWORD type, padding to 8, then the 32-byte union (MOUSEINPUT is the widest). */
export const INPUT_SIZE = 40
/** `sizeof(GUITHREADINFO)` on x64: two DWORDs, six HWNDs, one RECT. */
export const GUITHREADINFO_SIZE = 72
/** Offset of `hwndFocus` in GUITHREADINFO: cbSize, flags, hwndActive, then hwndFocus. */
export const GUITHREADINFO_FOCUS_OFFSET = 16

const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79
const GA_ROOT = 2
const UOI_NAME = 2
const DESKTOP_READOBJECTS = 0x0001
const ERROR_ACCESS_DENIED = 5
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const TOKEN_INTEGRITY_LEVEL = 25

export function user32Declaration(types: {
  ptr: unknown
  u16: unknown
  i16: unknown
  u32: unknown
  u64: unknown
  i32: unknown
}): Record<string, { args: readonly unknown[]; returns: unknown }> {
  return {
    GetForegroundWindow: { args: [], returns: types.u64 },
    // hWnd HWND, lpdwProcessId LPDWORD -> the owning thread id (DWORD).
    GetWindowThreadProcessId: { args: [types.u64, types.ptr], returns: types.u32 },
    // idThread DWORD, pgui PGUITHREADINFO -> BOOL.
    GetGUIThreadInfo: { args: [types.u32, types.ptr], returns: types.i32 },
    // hwnd HWND, gaFlags UINT -> HWND.
    GetAncestor: { args: [types.u64, types.u32], returns: types.u64 },
    SetForegroundWindow: { args: [types.u64], returns: types.i32 },
    // idAttach DWORD, idAttachTo DWORD, fAttach BOOL -> BOOL.
    AttachThreadInput: { args: [types.u32, types.u32, types.i32], returns: types.i32 },
    GetClientRect: { args: [types.u64, types.ptr], returns: types.i32 },
    GetWindowRect: { args: [types.u64, types.ptr], returns: types.i32 },
    ClientToScreen: { args: [types.u64, types.ptr], returns: types.i32 },
    GetCursorPos: { args: [types.ptr], returns: types.i32 },
    GetSystemMetrics: { args: [types.i32], returns: types.i32 },
    // cInputs UINT, pInputs LPINPUT, cbSize int -> the count inserted (UINT).
    SendInput: { args: [types.u32, types.ptr, types.i32], returns: types.u32 },
    // ch WCHAR -> SHORT (i16: the upper half of a 32-bit return is undefined for a SHORT): the low byte
    // is the virtual key, the high byte the shift state, -1 for none.
    VkKeyScanW: { args: [types.u16], returns: types.i16 },
    MapVirtualKeyW: { args: [types.u32, types.u32], returns: types.u32 },
    SetProcessDpiAwarenessContext: { args: [types.u64], returns: types.i32 },
    GetThreadDpiAwarenessContext: { args: [], returns: types.u64 },
    AreDpiAwarenessContextsEqual: { args: [types.u64, types.u64], returns: types.i32 },
    // dwFlags DWORD, fInherit BOOL, dwDesiredAccess ACCESS_MASK -> HDESK.
    OpenInputDesktop: { args: [types.u32, types.i32, types.u32], returns: types.u64 },
    GetThreadDesktop: { args: [types.u32], returns: types.u64 },
    // hObj HANDLE, nIndex int, pvInfo PVOID, nLength DWORD, lpnLengthNeeded LPDWORD -> BOOL.
    GetUserObjectInformationW: { args: [types.u64, types.i32, types.ptr, types.u32, types.ptr], returns: types.i32 },
    CloseDesktop: { args: [types.u64], returns: types.i32 },
  }
}

/** One INPUT record per event, at x64 offsets (MOUSEINPUT dx@8 dy@12 mouseData@16 dwFlags@20;
 * KEYBDINPUT wVk@8 wScan@10 dwFlags@12). time and dwExtraInfo stay zero. */
export function encodeInputs(events: readonly Win32InputEvent[]): Uint8Array {
  const bytes = new Uint8Array(events.length * INPUT_SIZE)
  const view = new DataView(bytes.buffer)
  events.forEach((event, index) => {
    const at = index * INPUT_SIZE
    if (event.kind === "mouse") {
      view.setUint32(at, INPUT_MOUSE, true)
      view.setInt32(at + 8, event.dx, true)
      view.setInt32(at + 12, event.dy, true)
      view.setInt32(at + 16, event.mouseData, true)
      view.setUint32(at + 20, event.flags, true)
    } else {
      view.setUint32(at, INPUT_KEYBOARD, true)
      view.setUint16(at + 8, event.vk, true)
      view.setUint16(at + 10, event.scan, true)
      view.setUint32(at + 12, event.flags, true)
    }
  })
  return bytes
}

/**
 * The mandatory-label RID out of a TOKEN_MANDATORY_LABEL buffer: the first field is a pointer to the
 * label SID, which GetTokenInformation places inside the same buffer, so the SID is read at that
 * pointer's offset from the buffer's own address. SID layout: revision, sub-authority count, a 6-byte
 * authority, then the sub-authorities; the integrity level is the last one (0x2000 medium, 0x3000 high).
 * Returns null when the pointer does not land inside the buffer.
 */
export function integrityFromLabel(label: Uint8Array, address: bigint): number | null {
  const view = new DataView(label.buffer, label.byteOffset, label.byteLength)
  const offset = Number(view.getBigUint64(0, true) - address)
  if (!Number.isSafeInteger(offset) || offset < 16 || offset + 8 > label.byteLength) return null
  const count = view.getUint8(offset + 1)
  const last = offset + 8 + (count - 1) * 4
  if (count < 1 || last + 4 > label.byteLength) return null
  return view.getUint32(last, true)
}

function resolveBunFfi(): FfiModule {
  const mod =
    typeof process.getBuiltinModule === "function"
      ? (process.getBuiltinModule("bun:ffi") as Partial<FfiModule> | undefined)
      : undefined
  if (!mod || typeof mod.dlopen !== "function" || typeof mod.ptr !== "function" || !mod.FFIType) {
    throw new Error("Windows input: bun:ffi is not available in this runtime")
  }
  return mod as FfiModule
}

function readRect(bytes: Uint8Array): { left: number; top: number; right: number; bottom: number } {
  const view = new DataView(bytes.buffer)
  return {
    left: view.getInt32(0, true),
    top: view.getInt32(4, true),
    right: view.getInt32(8, true),
    bottom: view.getInt32(12, true),
  }
}

/**
 * The production OS layer. Declares per-monitor-v2 DPI awareness first, before any window read, so
 * every rect, cursor position and virtual-screen metric below is in physical pixels; a process
 * already set to another awareness refuses by name rather than reading scaled coordinates.
 */
export function loadWin32InputOs(): Win32InputOs {
  const ffi = resolveBunFfi()
  const t = ffi.FFIType
  const user32 = ffi.dlopen(
    "user32.dll",
    user32Declaration({ ptr: t.ptr, u16: t.u16, i16: t.i16, u32: t.u32, u64: t.u64, i32: t.i32 }),
  ).symbols as unknown as User32Symbols
  const kernel32 = ffi.dlopen("kernel32.dll", {
    GetCurrentThreadId: { args: [], returns: t.u32 },
    GetLastError: { args: [], returns: t.u32 },
    OpenProcess: { args: [t.u32, t.i32, t.u32], returns: t.u64 },
    CloseHandle: { args: [t.u64], returns: t.i32 },
  }).symbols as unknown as ThreadSymbols
  const advapi32 = ffi.dlopen("advapi32.dll", {
    // ProcessHandle HANDLE, DesiredAccess DWORD, TokenHandle PHANDLE -> BOOL.
    OpenProcessToken: { args: [t.u64, t.u32, t.ptr], returns: t.i32 },
    // TokenHandle HANDLE, TokenInformationClass, TokenInformation, Length, ReturnLength -> BOOL.
    GetTokenInformation: { args: [t.u64, t.u32, t.ptr, t.u32, t.ptr], returns: t.i32 },
  }).symbols as unknown as TokenSymbols
  const ptr = (data: Uint8Array) => ffi.ptr(data) as never
  const handle = (value: bigint) => value as never
  const num = (value: number) => value as never

  if (user32.SetProcessDpiAwarenessContext(handle(DPI_PER_MONITOR_AWARE_V2)) === 0) {
    const error = kernel32.GetLastError()
    const already =
      error === ERROR_ACCESS_DENIED &&
      user32.AreDpiAwarenessContextsEqual(
        handle(user32.GetThreadDpiAwarenessContext()),
        handle(DPI_PER_MONITOR_AWARE_V2),
      ) !== 0
    if (!already) {
      throw new Error(
        `Windows input: SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) failed (GetLastError ${String(error)}) ` +
          "and the thread is not already per-monitor-v2; coordinates would be scaled, so no input is posted",
      )
    }
  }

  const desktopName = (desktop: bigint): string | null => {
    if (desktop === 0n) return null
    const buffer = new Uint8Array(512)
    const needed = new Uint8Array(4)
    if (
      user32.GetUserObjectInformationW(handle(desktop), num(UOI_NAME), ptr(buffer), num(buffer.length), ptr(needed)) ===
      0
    ) {
      return null
    }
    const text = new TextDecoder("utf-16le").decode(buffer)
    return text.slice(0, Math.max(0, text.indexOf("\u0000")))
  }

  const ownerOf = (hwnd: bigint): { pid: number; tid: number } => {
    const pid = new Uint8Array(4)
    const tid = user32.GetWindowThreadProcessId(handle(hwnd), ptr(pid))
    return { pid: new DataView(pid.buffer).getUint32(0, true), tid }
  }

  const frameOf = (bytes: Uint8Array): OwnedFrame => {
    const { left, top, right, bottom } = readRect(bytes)
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  return {
    integrityLevel(pid) {
      const process = kernel32.OpenProcess(num(PROCESS_QUERY_LIMITED_INFORMATION), num(0), num(pid))
      if (process === 0n) return null
      try {
        const tokenOut = new Uint8Array(8)
        if (advapi32.OpenProcessToken(handle(process), num(TOKEN_QUERY), ptr(tokenOut)) === 0) return null
        const token = new DataView(tokenOut.buffer).getBigUint64(0, true)
        try {
          const label = new Uint8Array(256)
          const length = new Uint8Array(4)
          if (
            advapi32.GetTokenInformation(
              handle(token),
              num(TOKEN_INTEGRITY_LEVEL),
              ptr(label),
              num(label.length),
              ptr(length),
            ) === 0
          ) {
            return null
          }
          return integrityFromLabel(label, BigInt(ffi.ptr(label) as number))
        } finally {
          kernel32.CloseHandle(handle(token))
        }
      } finally {
        kernel32.CloseHandle(handle(process))
      }
    },
    windowFrame(hwnd) {
      const rect = new Uint8Array(16)
      return user32.GetWindowRect(handle(hwnd), ptr(rect)) === 0 ? null : frameOf(rect)
    },
    currentThreadId: () => kernel32.GetCurrentThreadId(),
    lastError: () => kernel32.GetLastError(),
    desktops() {
      const input = user32.OpenInputDesktop(num(0), num(0), num(DESKTOP_READOBJECTS))
      try {
        return {
          input: desktopName(input),
          thread: desktopName(user32.GetThreadDesktop(num(kernel32.GetCurrentThreadId()))),
        }
      } finally {
        if (input !== 0n) user32.CloseDesktop(handle(input))
      }
    },
    foreground() {
      const hwnd = user32.GetForegroundWindow()
      return { hwnd, ...ownerOf(hwnd) }
    },
    focusedWindow(tid) {
      const info = new Uint8Array(GUITHREADINFO_SIZE)
      new DataView(info.buffer).setUint32(0, GUITHREADINFO_SIZE, true)
      if (user32.GetGUIThreadInfo(num(tid), ptr(info)) === 0) return null
      const hwnd = new DataView(info.buffer).getBigUint64(GUITHREADINFO_FOCUS_OFFSET, true)
      return hwnd === 0n ? null : { hwnd, pid: ownerOf(hwnd).pid }
    },
    rootOf: (hwnd) => user32.GetAncestor(handle(hwnd), num(GA_ROOT)),
    setForeground: (hwnd) => user32.SetForegroundWindow(handle(hwnd)) !== 0,
    attachThreadInput: (from, to, attach) => user32.AttachThreadInput(num(from), num(to), num(attach ? 1 : 0)) !== 0,
    clientFrame(hwnd): OwnedFrame | null {
      const rect = new Uint8Array(16)
      if (user32.GetClientRect(handle(hwnd), ptr(rect)) === 0) return null
      const origin = new Uint8Array(8)
      if (user32.ClientToScreen(handle(hwnd), ptr(origin)) === 0) return null
      const { right, bottom } = readRect(rect)
      const view = new DataView(origin.buffer)
      return { x: view.getInt32(0, true), y: view.getInt32(4, true), width: right, height: bottom }
    },
    cursor() {
      const point = new Uint8Array(8)
      if (user32.GetCursorPos(ptr(point)) === 0) return null
      const view = new DataView(point.buffer)
      return { x: view.getInt32(0, true), y: view.getInt32(4, true) }
    },
    virtualScreen: () => ({
      x: user32.GetSystemMetrics(num(SM_XVIRTUALSCREEN)),
      y: user32.GetSystemMetrics(num(SM_YVIRTUALSCREEN)),
      width: user32.GetSystemMetrics(num(SM_CXVIRTUALSCREEN)),
      height: user32.GetSystemMetrics(num(SM_CYVIRTUALSCREEN)),
    }),
    keyScan(char) {
      const scan = user32.VkKeyScanW(num(char.charCodeAt(0)))
      const short = scan & 0xffff
      return short === 0xffff ? null : { vk: short & 0xff, shiftState: (short >> 8) & 0xff }
    },
    scanCode: (vk) => user32.MapVirtualKeyW(num(vk), num(0)),
    sendInput(events) {
      const bytes = encodeInputs(events)
      return user32.SendInput(num(events.length), ptr(bytes), num(INPUT_SIZE))
    },
  }
}
