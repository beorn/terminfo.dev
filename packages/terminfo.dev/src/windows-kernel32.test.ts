/**
 * @failure A HANDLE position is declared as `ptr`, so Bun marshals a Windows handle as a virtual
 *   address and every console/process read on the hosted Windows route is built on a value the
 *   runtime does not preserve — ownership and geometry then rest on an ABI nobody validated (#29558).
 * @level l1
 * @consumer loadKernel32, the one binding the Windows geometry and ancestry reads share.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { INVALID_HANDLE_VALUE, kernel32Declaration } from "./windows-kernel32.ts"

/** Sentinel types, not `bun:ffi`'s: the declaration is pure data, so the ABI is assertable off
 * Windows — which is the only place it can be asserted until a hosted run happens. */
const TYPES = { ptr: "ptr", u32: "u32", u64: "u64", i32: "i32" } as const

const declaration = kernel32Declaration(TYPES)

describe("kernel32Declaration", () => {
  it("declares every HANDLE position as u64 — Bun: a HANDLE is not a virtual address", () => {
    // Handle RETURNS.
    expect(declaration.CreateFileW?.returns).toBe("u64")
    expect(declaration.CreateToolhelp32Snapshot?.returns).toBe("u64")
    expect(declaration.GetConsoleWindow?.returns).toBe("u64")
    // Handle ARGUMENTS.
    expect(declaration.Process32FirstW?.args).toEqual(["u64", "ptr"])
    expect(declaration.Process32NextW?.args).toEqual(["u64", "ptr"])
    expect(declaration.GetConsoleScreenBufferInfo?.args).toEqual(["u64", "ptr"])
    expect(declaration.CloseHandle?.args).toEqual(["u64"])
    // hTemplateFile is the seventh argument of CreateFileW and is a HANDLE too.
    expect(declaration.CreateFileW?.args).toEqual(["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"])
  })

  it("keeps the real pointer positions as ptr", () => {
    expect(declaration.CreateFileW?.args[0]).toBe("ptr") // lpFileName
    expect(declaration.CreateFileW?.args[3]).toBe("ptr") // lpSecurityAttributes
    expect(declaration.GetConsoleScreenBufferInfo?.args[1]).toBe("ptr") // the CSBI buffer
  })

  it("keeps the BOOL and error-code returns as the integer types they are", () => {
    expect(declaration.Process32FirstW?.returns).toBe("i32")
    expect(declaration.Process32NextW?.returns).toBe("i32")
    expect(declaration.GetConsoleScreenBufferInfo?.returns).toBe("i32")
    expect(declaration.CloseHandle?.returns).toBe("i32")
    expect(declaration.GetLastError?.returns).toBe("u32")
  })

  it("names a failure sentinel that neither a NULL check nor a JavaScript number can carry", () => {
    // The whole reason a handle is a BigInt: (HANDLE)-1 is all-ones, so `!handle` misses it and
    // Number() cannot hold it — a handle read correctly must be compared, not coerced.
    expect(INVALID_HANDLE_VALUE).toBe(0xffffffffffffffffn)
    expect(INVALID_HANDLE_VALUE).not.toBe(0n)
    expect(Number(INVALID_HANDLE_VALUE) > Number.MAX_SAFE_INTEGER).toBe(true)
  })
})
