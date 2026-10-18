/**
 * @failure The hosted Windows arm accepts an ancestry it never read, walks the wrong offsets of a
 *   PROCESSENTRY32W, or anchors its walk on a process table entry that is not a process — so
 *   ownership is granted to a console the receipt's WindowsTerminal.exe never owned (#29558).
 * @level l1
 * @consumer createOwnedTerminal's windows arm in the terminfo collector
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import {
  collectProcessTable,
  decodeProcessEntry32W,
  detectHostedWindowsAncestor,
  hostedWindowsAppFromExecutablePath,
  pointerBytesForArch,
  processEntry32WLayout,
  queryWindowsProcessExecutablePath,
  requireHostedWindowsAppAncestor,
  windowsCommBase,
  windowsProcessAncestry,
  type WindowsProcessRow,
} from "./windows-process-ancestry.ts"
import type { Kernel32Symbols } from "./windows-kernel32.ts"

/** The chain measured on the hosted runner 2026-10-15 (run 38815827412), tail first. */
const MEASURED_CHAIN: WindowsProcessRow[] = [
  { pid: 8848, ppid: 5796, comm: "powershell.exe" },
  { pid: 5796, ppid: 5492, comm: "WindowsTerminal.exe" },
  { pid: 5492, ppid: 2196, comm: "bash.exe" },
  { pid: 2196, ppid: 4328, comm: "bash.exe" },
  { pid: 4328, ppid: 1508, comm: "bash.exe" },
  { pid: 1508, ppid: 4872, comm: "Runner.Worker.exe" },
  { pid: 4872, ppid: 7156, comm: "Runner.Listener.exe" },
]

/** The Alacritty ConPTY chain measured on windows-latest 2026-10-18 (run 39114986301). */
const MEASURED_ALACRITTY_CHAIN: WindowsProcessRow[] = [
  { pid: 8972, ppid: 4960, comm: "bun.exe" },
  { pid: 4960, ppid: 4684, comm: "powershell.exe" },
  { pid: 4684, ppid: 9644, comm: "alacritty.exe" },
  { pid: 9644, ppid: 6948, comm: "bash.exe" },
  { pid: 6948, ppid: 5920, comm: "bash.exe" },
  { pid: 5920, ppid: 6348, comm: "bash.exe" },
  { pid: 6348, ppid: 7948, comm: "Runner.Worker.exe" },
  { pid: 7948, ppid: 5672, comm: "Runner.Listener.exe" },
]

/** A PROCESSENTRY32W record at the LITERAL offsets from tlhelp32.h, written independently of
 * `processEntry32WLayout` so a wrong offset can never be masked by a matching encoder. */
function recordAtDocumentedOffsets(row: { pid: number; ppid: number; comm: string }, pointerBytes: 4 | 8): Buffer {
  const size = pointerBytes === 8 ? 568 : 556
  const ppidOffset = pointerBytes === 8 ? 32 : 24
  const exeFileOffset = pointerBytes === 8 ? 44 : 36
  const bytes = Buffer.alloc(size)
  bytes.writeUInt32LE(size, 0)
  bytes.writeUInt32LE(row.pid, 8)
  bytes.writeUInt32LE(row.ppid, ppidOffset)
  bytes.write(row.comm, exeFileOffset, "utf16le")
  return bytes
}

describe("processEntry32WLayout", () => {
  it("pins the documented PROCESSENTRY32W offsets for both pointer widths", () => {
    expect(processEntry32WLayout(8)).toEqual({
      size: 568,
      pidOffset: 8,
      ppidOffset: 32,
      exeFileOffset: 44,
      exeFileChars: 260,
    })
    expect(processEntry32WLayout(4)).toEqual({
      size: 556,
      pidOffset: 8,
      ppidOffset: 24,
      exeFileOffset: 36,
      exeFileChars: 260,
    })
  })

  it("refuses a pointer width it has no layout for", () => {
    expect(() => processEntry32WLayout(2)).toThrow(/no layout for a 2-byte pointer/)
  })

  it("maps the running binary's architecture to a pointer width, loudly for the rest", () => {
    expect(pointerBytesForArch("x64")).toBe(8)
    expect(pointerBytesForArch("arm64")).toBe(8)
    expect(pointerBytesForArch("ia32")).toBe(4)
    expect(() => pointerBytesForArch("wasm32")).toThrow(/no PROCESSENTRY32W pointer width for arch "wasm32"/)
  })
})

describe("decodeProcessEntry32W", () => {
  for (const pointerBytes of [8, 4] as const) {
    it(`reads pid, parent and image name at the ${String(pointerBytes)}-byte layout`, () => {
      const layout = processEntry32WLayout(pointerBytes)
      const bytes = recordAtDocumentedOffsets({ pid: 5796, ppid: 5492, comm: "WindowsTerminal.exe" }, pointerBytes)
      expect(decodeProcessEntry32W(bytes, layout)).toEqual({ pid: 5796, ppid: 5492, comm: "WindowsTerminal.exe" })
    })
  }

  it("refuses a record that does not declare the layout's own size", () => {
    const bytes = recordAtDocumentedOffsets({ pid: 1, ppid: 0, comm: "a.exe" }, 8)
    bytes.writeUInt32LE(556, 0)
    expect(() => decodeProcessEntry32W(bytes, processEntry32WLayout(8))).toThrow(
      /does not declare itself a PROCESSENTRY32W: dwSize 556, expected 568/,
    )
  })

  it("refuses a buffer shorter than one record", () => {
    expect(() => decodeProcessEntry32W(new Uint8Array(40), processEntry32WLayout(8))).toThrow(
      /short of the 568 this layout needs/,
    )
  })

  it("decodes the System Idle row - pid 0 is a process every system-wide table carries", () => {
    // @dev/7 r1 finding 1: the enumeration ends on a FALSE from Process32NextW, never on a pid, so
    // refusing pid 0 HERE aborted a whole good table before the ancestry filter ever ran.
    const bytes = recordAtDocumentedOffsets({ pid: 0, ppid: 0, comm: "[System Process]" }, 8)
    expect(decodeProcessEntry32W(bytes, processEntry32WLayout(8))).toEqual({
      pid: 0,
      ppid: 0,
      comm: "[System Process]",
    })
  })
})

describe("windowsProcessAncestry", () => {
  it("walks the measured chain from the console process to the runner", () => {
    expect(windowsProcessAncestry(MEASURED_CHAIN, 8848).map((row) => row.pid)).toEqual([
      8848, 5796, 5492, 2196, 4328, 1508, 4872,
    ])
  })

  it("finds the receipt's WindowsTerminal.exe on that chain", () => {
    const chain = windowsProcessAncestry(MEASURED_CHAIN, 8848)
    expect(requireHostedWindowsAppAncestor("WindowsTerminal.exe", chain)).toEqual({
      pid: 5796,
      ppid: 5492,
      comm: "WindowsTerminal.exe",
    })
  })

  it("finds the receipt's alacritty.exe on the measured ConPTY chain", () => {
    const chain = windowsProcessAncestry(MEASURED_ALACRITTY_CHAIN, 8972)
    expect(requireHostedWindowsAppAncestor("alacritty.exe", chain)).toEqual({
      pid: 4684,
      ppid: 9644,
      comm: "alacritty.exe",
    })
  })

  it("walks and still finds the receipt's app when the table carries the System Idle row", () => {
    const rows: WindowsProcessRow[] = [{ pid: 0, ppid: 0, comm: "[System Process]" }, ...MEASURED_CHAIN]
    const chain = windowsProcessAncestry(rows, 8848)
    expect(chain.map((row) => row.pid)).toEqual([8848, 5796, 5492, 2196, 4328, 1508, 4872])
    expect(requireHostedWindowsAppAncestor("WindowsTerminal.exe", chain).pid).toBe(5796)
  })

  it("refuses a snapshot that cannot see its own reader", () => {
    expect(() => windowsProcessAncestry(MEASURED_CHAIN, 4242)).toThrow(/does not contain this collector \(pid 4242\)/)
  })

  it("ends the chain, rather than throwing, when an ancestor has exited", () => {
    const rows = MEASURED_CHAIN.filter((row) => row.pid !== 4328)
    expect(windowsProcessAncestry(rows, 8848).map((row) => row.pid)).toEqual([8848, 5796, 5492, 2196])
  })

  it("ends a cycle instead of looping forever", () => {
    const rows = [...MEASURED_CHAIN, { pid: 7156, ppid: 8848, comm: "Runner.Listener.exe" }]
    expect(windowsProcessAncestry(rows, 8848).map((row) => row.pid)).toEqual([
      8848, 5796, 5492, 2196, 4328, 1508, 4872, 7156,
    ])
  })

  it("stops at a pid-1-style root whose parent link is itself or zero", () => {
    const rows = [...MEASURED_CHAIN, { pid: 7156, ppid: 0, comm: "hosted-compute-agent.exe" }]
    expect(windowsProcessAncestry(rows, 8848).at(-1)).toEqual({ pid: 7156, ppid: 0, comm: "hosted-compute-agent.exe" })
  })
})

describe("hostedWindowsAppFromExecutablePath", () => {
  it("maps only WindowsTerminal.exe and alacritty.exe and refuses wezterm-gui.exe or unknown binaries", () => {
    expect(
      hostedWindowsAppFromExecutablePath(
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\windows-terminal\\WindowsTerminal.exe",
      ),
    ).toEqual({
      id: "windows-terminal",
      comm: "WindowsTerminal.exe",
    })
    expect(hostedWindowsAppFromExecutablePath("D:\\a\\_temp\\alacritty\\alacritty.exe")).toEqual({
      id: "alacritty",
      comm: "alacritty.exe",
    })
    expect(() => hostedWindowsAppFromExecutablePath("C:\\Program Files\\WezTerm\\wezterm-gui.exe")).toThrow(
      /Hosted Windows receipt executable is not one of WindowsTerminal\.exe, alacritty\.exe/,
    )
    expect(() => hostedWindowsAppFromExecutablePath("C:\\Windows\\System32\\cmd.exe")).toThrow(
      /Hosted Windows receipt executable is not one of WindowsTerminal\.exe, alacritty\.exe/,
    )
  })
})

describe("requireHostedWindowsAppAncestor", () => {
  it("matches the base name of a full executable path without case", () => {
    const chain = windowsProcessAncestry(MEASURED_CHAIN, 8848)
    expect(
      requireHostedWindowsAppAncestor(
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\windows-terminal\\WindowsTerminal.exe",
        chain,
      ).pid,
    ).toBe(5796)
    expect(requireHostedWindowsAppAncestor("windowsterminal.EXE", chain).pid).toBe(5796)
  })

  it("refuses with the chain it actually found when the receipt's app is absent", () => {
    const rows = MEASURED_CHAIN.map((row) => (row.pid === 5796 ? { ...row, comm: "explorer.exe" } : row))
    const chain = windowsProcessAncestry(rows, 8848)
    expect(() => requireHostedWindowsAppAncestor("WindowsTerminal.exe", chain)).toThrow(
      /Hosted Windows ancestry never reached windowsterminal\.exe; found Runner\.Listener\.exe \(pid 4872\), Runner\.Worker\.exe \(pid 1508\), bash\.exe \(pid 4328\), bash\.exe \(pid 2196\), bash\.exe \(pid 5492\), explorer\.exe \(pid 5796\), powershell\.exe \(pid 8848\)/,
    )
  })

  it("refuses a competing hosted Windows terminal on the chain when expecting alacritty.exe", () => {
    const chain = windowsProcessAncestry(MEASURED_CHAIN, 8848)
    expect(() => requireHostedWindowsAppAncestor("alacritty.exe", chain)).toThrow(
      /Hosted Windows ancestry reached WindowsTerminal\.exe \(pid 5796\) while the receipt names alacritty\.exe/,
    )
  })

  it("refuses two terminals on the chain, naming both, rather than picking one", () => {
    // The chain is this process's ancestry: a second terminal has to be ON it, so the bash step's
    // parent becomes a second WindowsTerminal.exe above the first.
    const rows: WindowsProcessRow[] = [
      ...MEASURED_CHAIN.map((row) => (row.pid === 5492 ? { ...row, ppid: 6100 } : row)),
      { pid: 6100, ppid: 2196, comm: "WindowsTerminal.exe" },
    ]
    const chain = windowsProcessAncestry(rows, 8848)
    expect(() => requireHostedWindowsAppAncestor("WindowsTerminal.exe", chain)).toThrow(
      /Hosted Windows ancestry holds 2 WindowsTerminal\.exe processes: pid 5796, pid 6100/u,
    )
  })
})

describe("collectProcessTable", () => {
  /** A scripted toolhelp enumeration: each successful call fills the record at the LITERAL documented
   *  offsets, and the run ends on `endError` - the same shape the real symbols have. */
  const scripted = (rows: readonly WindowsProcessRow[], endError: number) => {
    let nextIndex = 0
    const fill = (record: Buffer, row: WindowsProcessRow) => {
      record.set(recordAtDocumentedOffsets(row, 8))
      return true
    }
    return {
      first: (record: Buffer) => {
        if (rows.length === 0) return false
        nextIndex = 1
        return fill(record, rows[0]!)
      },
      next: (record: Buffer) => {
        if (nextIndex >= rows.length) return false
        const row = rows[nextIndex]!
        nextIndex += 1
        return fill(record, row)
      },
      lastError: () => endError,
    }
  }

  it("collects every row, Idle included, and ends only on ERROR_NO_MORE_FILES", () => {
    const rows = collectProcessTable({
      layout: processEntry32WLayout(8),
      ...scripted([{ pid: 0, ppid: 0, comm: "[System Process]" }, ...MEASURED_CHAIN], 18),
    })

    expect(rows.map((row) => row.pid)).toEqual([0, 8848, 5796, 5492, 2196, 4328, 1508, 4872])
  })

  it("throws by name when the enumeration ends on any other error, never passing a partial table", () => {
    // ERROR_INVALID_HANDLE (6) part-way through: the rows read so far must NOT become a table, or the
    // walk could grant ownership off whatever happened to arrive before the failure (@dev/7 r1 #2).
    expect(() =>
      collectProcessTable({
        layout: processEntry32WLayout(8),
        ...scripted(MEASURED_CHAIN.slice(0, 2), 6),
      }),
    ).toThrow(/ended the table read with error 6, not ERROR_NO_MORE_FILES; the table is partial/)
  })

  it("throws when the first read yields no process at all, naming the Win32 code", () => {
    expect(() =>
      collectProcessTable({
        layout: processEntry32WLayout(8),
        ...scripted([], 87),
      }),
    ).toThrow(/Process32FirstW read no process from the table: error 87/)
  })
})

describe("queryWindowsProcessExecutablePath and detectHostedWindowsAncestor", () => {
  function fakeKernel(
    rows: readonly WindowsProcessRow[],
    pathsByPid: Record<number, string>,
    closedHandles: Array<number | bigint> = [],
  ): { symbols: Kernel32Symbols; ptr: (view: ArrayBufferView) => number } {
    let index = 0
    const handleToPid = new Map<number, number>()
    const ptrToBuffer = new Map<number, ArrayBufferView>()
    let nextHandle = 100
    let nextPtr = 1000
    const ptr = (view: ArrayBufferView): number => {
      const id = nextPtr++
      ptrToBuffer.set(id, view)
      return id
    }
    const viewAt = (address: unknown): Buffer => {
      const view = ptrToBuffer.get(Number(address))
      if (!view) throw new Error(`Unknown pointer ${String(address)}`)
      return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
    }
    const fill = (address: unknown, row: WindowsProcessRow): number => {
      viewAt(address).set(recordAtDocumentedOffsets(row, 8))
      return 1
    }
    return {
      ptr,
      symbols: {
        GetConsoleWindow: () => 0n,
        GetConsoleScreenBufferInfo: () => 0,
        // The ancestry path reads an image path, never an incarnation. Loud rather than a quiet
        // zero, so a future call here fails the test instead of reporting a creation time of zero.
        GetProcessTimes: () => {
          throw new Error("GetProcessTimes is not read on the process-ancestry path")
        },
        CreateToolhelp32Snapshot: () => 77n,
        Process32FirstW: (_snapshot, entry) => {
          if (rows.length === 0) return 0
          index = 1
          return fill(entry, rows[0]!)
        },
        Process32NextW: (_snapshot, entry) => {
          if (index >= rows.length) return 0
          const row = rows[index]!
          index += 1
          return fill(entry, row)
        },
        OpenProcess: (_access, _inherit, pid) => {
          if (!(Number(pid) in pathsByPid)) return 0n
          const handle = nextHandle++
          handleToPid.set(handle, Number(pid))
          return BigInt(handle)
        },
        QueryFullProcessImageNameW: (handle, _flags, exePath, sizeInChars) => {
          const pid = handleToPid.get(Number(handle))
          const path = pid !== undefined ? pathsByPid[pid] : undefined
          if (!path) return 0
          const written = Buffer.from(path, "utf16le")
          written.copy(viewAt(exePath), 0)
          viewAt(sizeInChars).writeUInt32LE(path.length, 0)
          return 1
        },
        CloseHandle: (handle) => {
          closedHandles.push(Number(handle))
          return 1
        },
        GetLastError: () => 18,
        CreateFileW: () => -1n,
        ReadConsoleOutputW: () => 0,
      },
    }
  }

  it("queries the UTF-16LE process image path, throws with Win32 error codes on failure, and always closes the process handle", () => {
    const closed: Array<number | bigint> = []
    const kernel = fakeKernel(
      MEASURED_ALACRITTY_CHAIN,
      {
        4684: "D:\\a\\_temp\\alacritty\\alacritty.exe",
        4960: "",
      },
      closed,
    )
    expect(queryWindowsProcessExecutablePath(4684, kernel)).toBe("D:\\a\\_temp\\alacritty\\alacritty.exe")
    expect(closed).toEqual([100])
    expect(() => queryWindowsProcessExecutablePath(9999, kernel)).toThrow(
      /OpenProcess\(PROCESS_QUERY_LIMITED_INFORMATION, pid 9999\) failed: error 18/,
    )
    expect(() => queryWindowsProcessExecutablePath(4960, kernel)).toThrow(
      /QueryFullProcessImageNameW\(pid 4960\) read no executable path: error 18/,
    )
    expect(closed).toEqual([100, 101])
  })

  it("detects alacritty.exe synchronously from the process table and returns its executablePath", () => {
    const closed: Array<number | bigint> = []
    const kernel = fakeKernel(MEASURED_ALACRITTY_CHAIN, { 4684: "D:\\a\\_temp\\alacritty\\alacritty.exe" }, closed)
    expect(detectHostedWindowsAncestor(8972, { arch: "x64" }, kernel)).toEqual({
      app: { id: "alacritty", comm: "alacritty.exe" },
      row: { pid: 4684, ppid: 9644, comm: "alacritty.exe" },
      executablePath: "D:\\a\\_temp\\alacritty\\alacritty.exe",
    })
    // Closes both the snapshot handle (77) and the process handle (100).
    expect(closed).toEqual([77, 100])
  })

  it("returns null when two competing hosted Windows terminals appear on the chain", () => {
    const competing: WindowsProcessRow[] = [
      ...MEASURED_ALACRITTY_CHAIN.map((row) => (row.pid === 9644 ? { ...row, ppid: 5796 } : row)),
      { pid: 5796, ppid: 6948, comm: "WindowsTerminal.exe" },
    ]
    const kernel = fakeKernel(competing, { 4684: "D:\\a\\_temp\\alacritty\\alacritty.exe" })
    expect(detectHostedWindowsAncestor(8972, { arch: "x64" }, kernel)).toBeNull()
  })
})

describe("windowsCommBase", () => {
  it("takes the base name of an image, path from either separator, without case", () => {
    expect(windowsCommBase("C:\\Windows\\System32\\cmd.exe")).toBe("cmd.exe")
    expect(windowsCommBase("C:/Program Files/WindowsApps/WindowsTerminal.exe")).toBe("windowsterminal.exe")
    expect(windowsCommBase("  PowerShell.EXE  ")).toBe("powershell.exe")
  })
})
