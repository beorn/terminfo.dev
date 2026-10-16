/**
 * One kernel32 binding for every Windows read the hosted arm makes (29558, option A).
 *
 * Windows-only, behind a dynamic import: the route runs Bun, and `bun:ffi` is the only way to reach
 * the console and the process table from it (measured 2026-10-15, runs 38814184347 and 38829827).
 *
 * What the dynamic import buys, and what it does NOT (@dev/7 r2): nothing imports this statically, so
 * the launcher still STARTS under node and every path that is not this one is unaffected. It is not
 * end-to-end node support for the hosted Windows route. The `mode con` geometry fallback is
 * node-compatible on its own, but ownership there still needs the ffi ancestry and identity reads, so
 * a node process on Windows refuses LOUDLY at loadKernel32 ("bun:ffi is not available in this
 * runtime") instead of grading a console it could not verify. Say "node starts" only ever beside it.
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
  GetConsoleWindow: Kernel32HandleSymbol
  CreateToolhelp32Snapshot: Kernel32HandleSymbol
  Process32FirstW: Kernel32Symbol
  Process32NextW: Kernel32Symbol
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
    GetConsoleWindow: { args: [], returns: types.u64 },
    CreateToolhelp32Snapshot: { args: [types.u32, types.u32], returns: types.u64 },
    Process32FirstW: { args: [types.u64, types.ptr], returns: types.i32 },
    Process32NextW: { args: [types.u64, types.ptr], returns: types.i32 },
    GetLastError: { args: [], returns: types.u32 },
    CloseHandle: { args: [types.u64], returns: types.i32 },
  }
}

export async function loadKernel32(): Promise<Kernel32> {
  let ffi: FfiModule
  try {
    ffi = (await import("bun:ffi")) as unknown as FfiModule
  } catch (error) {
    throw new Error(
      `bun:ffi is not available in this runtime: ${error instanceof Error ? error.message : String(error)}`,
    )
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
