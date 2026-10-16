/**
 * One kernel32 binding for every Windows read the hosted arm makes (29558, option A).
 *
 * Windows-only, behind a dynamic import: the route runs Bun, and `bun:ffi` is the only way to reach
 * the console and the process table from it (measured 2026-10-15, runs 38814184347 and 38829827).
 * The launcher's node fallback keeps running because nothing imports this statically.
 */
/** A kernel32 entry point as `bun:ffi` hands it back: untyped and variadic, so every call site casts
 * each argument to the FFI type the dlopen below declared for that symbol. */
export type Kernel32Symbol = (...args: never[]) => number

/** Exactly the symbols requested below. Named one by one rather than left as an index signature so
 * that `symbols.CreateFileW` is a call, not `((...) => number) | undefined`: a symbol this module
 * asks for and does not get is a `dlopen` failure, which is loud, never a missing member to test. */
export interface Kernel32Symbols {
  CreateFileW: Kernel32Symbol
  GetConsoleScreenBufferInfo: Kernel32Symbol
  GetConsoleWindow: Kernel32Symbol
  CreateToolhelp32Snapshot: Kernel32Symbol
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

export async function loadKernel32(): Promise<Kernel32> {
  let ffi: FfiModule
  try {
    ffi = (await import("bun:ffi")) as unknown as FfiModule
  } catch (error) {
    throw new Error(
      `bun:ffi is not available in this runtime: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const binding = ffi.dlopen("kernel32.dll", {
    CreateFileW: {
      args: [ffi.FFIType.ptr, ffi.FFIType.u32, ffi.FFIType.u32, ffi.FFIType.ptr, ffi.FFIType.u32, ffi.FFIType.u32, ffi.FFIType.ptr],
      returns: ffi.FFIType.ptr,
    },
    GetConsoleScreenBufferInfo: { args: [ffi.FFIType.ptr, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    GetConsoleWindow: { args: [], returns: ffi.FFIType.ptr },
    CreateToolhelp32Snapshot: { args: [ffi.FFIType.u32, ffi.FFIType.u32], returns: ffi.FFIType.ptr },
    Process32FirstW: { args: [ffi.FFIType.ptr, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    Process32NextW: { args: [ffi.FFIType.ptr, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    GetLastError: { args: [], returns: ffi.FFIType.u32 },
    CloseHandle: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
  })
  return { symbols: binding.symbols, ptr: (data) => ffi.ptr(data) }
}
