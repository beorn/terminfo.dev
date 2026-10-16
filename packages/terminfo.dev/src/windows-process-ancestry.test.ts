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
  decodeProcessEntry32W,
  pointerBytesForArch,
  processEntry32WLayout,
  requireHostedWindowsAppAncestor,
  windowsCommBase,
  windowsProcessAncestry,
  type WindowsProcessRow,
} from "./windows-process-ancestry.ts"

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

/** A PROCESSENTRY32W record at the LITERAL offsets from tlhelp32.h, written independently of
 * `processEntry32WLayout` so a wrong offset can never be masked by a matching encoder. */
function recordAtDocumentedOffsets(
  row: { pid: number; ppid: number; comm: string },
  pointerBytes: 4 | 8,
): Buffer {
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

  it("refuses a record with no process id instead of anchoring a walk on it", () => {
    const bytes = recordAtDocumentedOffsets({ pid: 0, ppid: 0, comm: "[System Process]" }, 8)
    expect(() => decodeProcessEntry32W(bytes, processEntry32WLayout(8))).toThrow(/has no process id/)
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

describe("requireHostedWindowsAppAncestor", () => {
  it("matches the base name of a full executable path without case", () => {
    const chain = windowsProcessAncestry(MEASURED_CHAIN, 8848)
    expect(
      requireHostedWindowsAppAncestor("C:\\Users\\runneradmin\\AppData\\Local\\Temp\\windows-terminal\\WindowsTerminal.exe", chain)
        .pid,
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
})

describe("windowsCommBase", () => {
  it("takes the base name of an image, path from either separator, without case", () => {
    expect(windowsCommBase("C:\\Windows\\System32\\cmd.exe")).toBe("cmd.exe")
    expect(windowsCommBase("C:/Program Files/WindowsApps/WindowsTerminal.exe")).toBe("windowsterminal.exe")
    expect(windowsCommBase("  PowerShell.EXE  ")).toBe("powershell.exe")
  })
})
