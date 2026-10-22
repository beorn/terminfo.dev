/**
 * The kernel's executed path for one Darwin pid (#30518 Screen arm, @cto e29901ef with A3).
 *
 * `comm` is argv0 and stays argv0: Screen's frontend forks a backend and the backend renames itself
 * to `SCREEN`, so the name a process shows is not the binary the kernel executed. This module reads
 * the path the kernel itself recorded — `proc_pidpath` from libSystem.B.dylib first, then the exec
 * path at the head of KERN_PROCARGS2 — and records EVERY attempt: which reader answered, the errno a
 * reader that did not answer returned, and a library-load failure apart from a per-pid failure. A pid
 * neither reader answers is a recorded fact for the caller to refuse by name; it is never nulled into
 * a plausible path.
 *
 * Loaded synchronously on demand through `process.getBuiltinModule("bun:ffi")`, exactly like
 * windows-kernel32.ts: importing this module makes no native call, so a Node invocation still starts
 * and every platform that is not Darwin gets a named "no kernel path read" instead of a throw.
 */

export type KernelExecReader = "proc_pidpath" | "KERN_PROCARGS2"

/** One reader's outcome for one pid. `result` is the bytes written, the path length, or null for a
 * reader that never ran; `error` carries the errno or the reason in words. */
export interface KernelExecAttempt {
  reader: string
  result: number | string | null
  error: string | null
}

export interface KernelExecRead {
  /** The executed path, or null when neither reader answered. */
  path: string | null
  /** The reader that answered, or null when none did. */
  reader: KernelExecReader | null
  /** Every attempt joined, so a refusal can name what each reader said. Null only on success. */
  error: string | null
  attempts: KernelExecAttempt[]
}

interface FfiModule {
  dlopen(path: string, symbols: Record<string, { args: readonly unknown[]; returns: unknown }>): { symbols: unknown }
  FFIType: Record<string, unknown>
  ptr(data: Uint8Array | Int32Array): unknown
  read: { i32(pointer: unknown): number }
}

function resolveBunFfi(): FfiModule | null {
  if (typeof process.getBuiltinModule !== "function") return null
  const mod = process.getBuiltinModule("bun:ffi") as Partial<FfiModule> | undefined
  if (!mod || typeof mod.dlopen !== "function" || typeof mod.ptr !== "function" || !mod.read) return null
  return mod as FfiModule
}

const LIB_SYSTEM = "libSystem.B.dylib"

/** `proc_pidpath` asks the kernel for the path it executed, which is what survives the SCREEN rename.
 * It is exported by libSystem.B.dylib itself; a separate libproc.dylib need not exist (@cto A3). */
function readProcPidpath(ffi: FfiModule, pid: number, attempts: KernelExecAttempt[]): string | null {
  try {
    const lib = ffi.dlopen(LIB_SYSTEM, {
      proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
      __error: { args: [], returns: "ptr" },
    } as const).symbols as {
      /** (pid, buffer, buffersize) -> path length, or 0 with errno set. */
      proc_pidpath: (pid: number, buffer: unknown, size: number) => number
      /** Darwin's errno accessor: `int *__error(void)`. */
      __error: () => unknown
    }
    const buffer = new Uint8Array(4096)
    const written = lib.proc_pidpath(pid, ffi.ptr(buffer), buffer.length)
    if (written > 0) {
      const path = new TextDecoder().decode(buffer.subarray(0, written)).replace(/\0+$/, "")
      if (path) {
        attempts.push({ reader: "proc_pidpath", result: written, error: null })
        return path
      }
      attempts.push({ reader: "proc_pidpath", result: written, error: "wrote zero bytes" })
      // silent-fallback-allow: the attempt is recorded above and the caller refuses the row by name.
      return null
    }
    let errno: number | null = null
    try {
      errno = ffi.read.i32(lib.__error())
    } catch (error) {
      attempts.push({ reader: "__error", result: null, error: message(error) })
    }
    attempts.push({
      reader: "proc_pidpath",
      result: written,
      error: `returned ${written}${errno === null ? "" : `, errno ${errno}`}`,
    })
    // silent-fallback-allow: the errno is recorded on the attempt above; the caller refuses by name.
    return null
  } catch (error) {
    // A library-load or call failure is recorded apart from a per-pid refusal (@cto A3).
    attempts.push({ reader: "proc_pidpath", result: null, error: `library load or call: ${message(error)}` })
    // silent-fallback-allow: the load failure is recorded on the attempt above; the caller refuses by name.
    return null
  }
}

/** The exec path at the head of KERN_PROCARGS2: an `int argc`, then the NUL-terminated executed path. */
function readKernProcargs2(ffi: FfiModule, pid: number, attempts: KernelExecAttempt[]): string | null {
  try {
    const path = kernProcargs2ExecPath(ffi, pid)
    if (path) {
      attempts.push({ reader: "KERN_PROCARGS2", result: path.length, error: null })
      return path
    }
    attempts.push({ reader: "KERN_PROCARGS2", result: 0, error: "head holds no exec path" })
    // silent-fallback-allow: the attempt is recorded above and the caller refuses the row by name.
    return null
  } catch (error) {
    attempts.push({ reader: "KERN_PROCARGS2", result: null, error: message(error) })
    // silent-fallback-allow: the reader's failure is recorded on the attempt above; the caller refuses by name.
    return null
  }
}

function kernProcargs2ExecPath(ffi: FfiModule, pid: number): string | null {
  const KERN_PROCARGS2 = 49
  const { sysctl } = ffi.dlopen(LIB_SYSTEM, {
    sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
  } as const).symbols as {
    /** (mib, namelen, oldp, oldlenp, newp, newlen) -> 0 on success. */
    sysctl: (mib: unknown, namelen: number, oldp: unknown, oldlenp: unknown, newp: unknown, newlen: number) => number
  }
  const mib = new Int32Array([1, KERN_PROCARGS2, pid])
  const size = new Uint8Array(8)
  const setSize = (value: number) => new DataView(size.buffer).setBigUint64(0, BigInt(value), true)
  const readSize = () => Number(new DataView(size.buffer).getBigUint64(0, true))
  setSize(size.length)
  if (
    sysctl(ffi.ptr(mib) as never, 3 as never, null as never, ffi.ptr(size) as never, null as never, 0 as never) !== 0
  ) {
    throw new Error(`sysctl size read failed for pid ${pid}`)
  }
  const length = readSize()
  if (!(length > 4 && length <= 1 << 20)) throw new Error(`sysctl reported ${length} bytes for pid ${pid}`)
  const buffer = new Uint8Array(length)
  setSize(length)
  if (
    sysctl(
      ffi.ptr(mib) as never,
      3 as never,
      ffi.ptr(buffer) as never,
      ffi.ptr(size) as never,
      null as never,
      0 as never,
    ) !== 0
  ) {
    throw new Error(`sysctl value read failed for pid ${pid}`)
  }
  const end = buffer.indexOf(0, 4)
  if (end <= 4) return null
  return new TextDecoder().decode(buffer.subarray(4, end))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The kernel executed path for `pid`, with every attempt recorded. `proc_pidpath` runs first; the
 * KERN_PROCARGS2 fallback runs for EVERY pid where it failed, not only a uid-0 row (@cto A3), because
 * a refusal that only tried one reader for one role cannot tell a permissions limit from a bad path.
 * Off Darwin the read is named, never silently treated as "no path".
 */
export function kernelExecPath(pid: number): KernelExecRead {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return { path: null, reader: null, error: `pid ${String(pid)} is not a live pid`, attempts: [] }
  }
  if (process.platform !== "darwin") {
    return { path: null, reader: null, error: "not darwin; no kernel path read", attempts: [] }
  }
  const ffi = resolveBunFfi()
  if (!ffi) {
    return { path: null, reader: null, error: "bun:ffi is not available in this runtime", attempts: [] }
  }
  const attempts: KernelExecAttempt[] = []
  const direct = readProcPidpath(ffi, pid, attempts)
  if (direct) return { path: direct, reader: "proc_pidpath", error: null, attempts }
  const fallback = readKernProcargs2(ffi, pid, attempts)
  if (fallback) return { path: fallback, reader: "KERN_PROCARGS2", error: null, attempts }
  return {
    path: null,
    reader: null,
    error: attempts.map((attempt) => `${attempt.reader}: ${attempt.error ?? "ok"}`).join("; "),
    attempts,
  }
}
