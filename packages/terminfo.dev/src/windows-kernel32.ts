/**
 * One kernel32 binding for every Windows read the hosted arm makes (29558, option A).
 *
 * Loaded synchronously on demand through `process.getBuiltinModule("bun:ffi")`: importing this
 * module makes no native call, so the CLI still starts under Node and every path that does not
 * call `loadKernel32()` is unaffected.
 *
 * `hasWindowsKernel32Ffi()` is the one runtime availability check. `detectTerminal()` checks it
 * before probing Windows process ancestry so a Node invocation on Windows skips the FFI probe and
 * falls back to `$TERM` without throwing or catching, while `loadKernel32()` on the hosted Windows
 * ownership route refuses loudly ("bun:ffi is not available in this runtime") when `bun:ffi` is
 * absent instead of grading a console it could not verify.
 */

/** A kernel32 entry point as `bun:ffi` hands it back: untyped and variadic, so every call site casts
 * each argument to the FFI type the dlopen below declared for that symbol. */
export type Kernel32Symbol = (...args: never[]) => number

/** A handle-returning entry point. Bun hands a `u64` back as a BigInt - measured on 1.4.3, a u64
 * return is `5n` and is NOT `5` - which is exactly what a Windows HANDLE needs: INVALID_HANDLE_VALUE
 * is 0xFFFFFFFFFFFFFFFF, and no JavaScript number can hold it. A HANDLE carried as a number would
 * silently lose the high bits that make the failure sentinel what it is. */
export type Kernel32HandleSymbol = (...args: never[]) => bigint

/** The Windows sentinel for a call that produced no usable handle: `(HANDLE)-1`, NOT NULL and not
 * zero, so `!handle` is not the test. Valid for any handle-returning call here. */
export const INVALID_HANDLE_VALUE = 0xffffffffffffffffn

/** Exactly the symbols requested below. Named one by one rather than left as an index signature so
 * that `symbols.CreateFileW` is a call, not `((...) => number) | undefined`: a symbol this module
 * asks for and does not get is a `dlopen` failure, which is loud, never a missing member to test. */
export interface Kernel32Symbols {
  CreateFileW: Kernel32HandleSymbol
  GetConsoleScreenBufferInfo: Kernel32Symbol
  ReadConsoleOutputW: Kernel32Symbol
  GetConsoleMode: Kernel32Symbol
  SetConsoleMode: Kernel32Symbol
  WriteConsoleW: Kernel32Symbol
  GetConsoleWindow: Kernel32HandleSymbol
  CreateToolhelp32Snapshot: Kernel32HandleSymbol
  Process32FirstW: Kernel32Symbol
  Process32NextW: Kernel32Symbol
  OpenProcess: Kernel32HandleSymbol
  QueryFullProcessImageNameW: Kernel32Symbol
  GetProcessTimes: Kernel32Symbol
  GetLastError: Kernel32Symbol
  CloseHandle: Kernel32Symbol
}

export interface Kernel32 {
  readonly symbols: Kernel32Symbols
  ptr(data: Uint8Array): unknown
}

interface FfiModule {
  dlopen(
    path: string,
    symbols: Record<string, { args: readonly unknown[]; returns: unknown }>,
  ): { symbols: Kernel32Symbols }
  FFIType: Record<string, unknown>
  ptr(data: Uint8Array): unknown
}

function resolveBunFfi(): FfiModule | null {
  if (typeof process.getBuiltinModule !== "function") return null
  const mod = process.getBuiltinModule("bun:ffi") as Partial<FfiModule> | undefined
  if (!mod || typeof mod.dlopen !== "function" || typeof mod.ptr !== "function" || !mod.FFIType) {
    return null
  }
  return mod as FfiModule
}

/** One availability check for `bun:ffi`: a check, never a catch. */
export function hasWindowsKernel32Ffi(): boolean {
  return resolveBunFfi() !== null
}

/**
 * The dlopen declaration, with `FFIType` injected so the ABI is assertable OFF Windows - which is the
 * only place it can be asserted until a run happens. Every HANDLE position is `u64` and every real
 * pointer stays `ptr`: Bun's pointer note says the Windows HANDLE "does not represent a virtual
 * address, and using ptr for it does not work as expected" (@dev/7 r2 finding 1, cited there). The
 * test pins each position so a later edit cannot quietly widen a handle back to a pointer.
 */
export function kernel32Declaration(types: {
  ptr: unknown
  u32: unknown
  u64: unknown
  i32: unknown
}): Record<string, { args: readonly unknown[]; returns: unknown }> {
  return {
    CreateFileW: {
      // lpFileName ptr, dwDesiredAccess u32, dwShareMode u32, lpSecurityAttributes ptr,
      // dwCreationDisposition u32, dwFlagsAndAttributes u32, hTemplateFile HANDLE.
      args: [types.ptr, types.u32, types.u32, types.ptr, types.u32, types.u32, types.u64],
      returns: types.u64,
    },
    GetConsoleScreenBufferInfo: { args: [types.u64, types.ptr], returns: types.i32 },
    // HANDLE, PCHAR_INFO, COORD dwBufferSize, COORD dwBufferCoord, PSMALL_RECT lpReadRegion.
    // The two COORDs are passed BY VALUE, so they are u32 with X in the low half and Y in the high
    // half (packCoord in windows-console-cells.ts); a pointer here would read the wrong argument.
    ReadConsoleOutputW: { args: [types.u64, types.ptr, types.u32, types.u32, types.ptr], returns: types.i32 },
    // hConsoleHandle HANDLE, lpMode LPDWORD -> BOOL; SetConsoleMode takes the mode BY VALUE.
    GetConsoleMode: { args: [types.u64, types.ptr], returns: types.i32 },
    SetConsoleMode: { args: [types.u64, types.u32], returns: types.i32 },
    // hConsoleOutput HANDLE, lpBuffer, nNumberOfCharsToWrite u32, lpNumberOfCharsWritten LPDWORD,
    // lpReserved (NULL) -> BOOL. The ownership witness's one write (#30720).
    WriteConsoleW: { args: [types.u64, types.ptr, types.u32, types.ptr, types.ptr], returns: types.i32 },
    GetConsoleWindow: { args: [], returns: types.u64 },
    CreateToolhelp32Snapshot: { args: [types.u32, types.u32], returns: types.u64 },
    Process32FirstW: { args: [types.u64, types.ptr], returns: types.i32 },
    Process32NextW: { args: [types.u64, types.ptr], returns: types.i32 },
    // dwDesiredAccess u32, bInheritHandle BOOL (i32), dwProcessId u32 -> HANDLE (u64).
    OpenProcess: { args: [types.u32, types.i32, types.u32], returns: types.u64 },
    // hProcess HANDLE (u64), dwFlags u32, lpExeName ptr, lpdwSize ptr -> BOOL (i32).
    QueryFullProcessImageNameW: { args: [types.u64, types.u32, types.ptr, types.ptr], returns: types.i32 },
    // hProcess HANDLE (u64) and four FILETIME pointers (creation, exit, kernel, user) -> BOOL
    // (i32). GetProcessTimes refuses a NULL pointer for any of them, so all four are allocated
    // even though only the creation time is read (30042).
    GetProcessTimes: {
      args: [types.u64, types.ptr, types.ptr, types.ptr, types.ptr],
      returns: types.i32,
    },
    GetLastError: { args: [], returns: types.u32 },
    CloseHandle: { args: [types.u64], returns: types.i32 },
  }
}

export function loadKernel32(): Kernel32 {
  const ffi = resolveBunFfi()
  if (!ffi) {
    throw new Error("bun:ffi is not available in this runtime")
  }
  const binding = ffi.dlopen(
    "kernel32.dll",
    kernel32Declaration({
      ptr: ffi.FFIType.ptr,
      u32: ffi.FFIType.u32,
      u64: ffi.FFIType.u64,
      i32: ffi.FFIType.i32,
    }),
  )
  return { symbols: binding.symbols, ptr: (data) => ffi.ptr(data) }
}
