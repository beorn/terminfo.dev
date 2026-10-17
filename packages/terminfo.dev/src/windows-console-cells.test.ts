/**
 * @failure The hosted Windows arm decides rows on a buffer nobody read: a console host selected
 *   from the wrong process, a read region the host clipped and decoded anyway, or the host's
 *   wide-glyph encoding read as plain text would each grade characters never on screen.
 * @level l1
 * @consumer readWindowsConsoleCells, the Windows half of the hosted-arm cell readback.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import {
  CHAR_INFO_BYTES,
  consoleBufferOwner,
  consoleHostFromTable,
  consoleIdentityMismatch,
  decodeCharInfo,
  packCoord,
  readWindowsConsoleCells,
  type ConsoleHostIdentity,
} from "./windows-console-cells.ts"
import { INVALID_HANDLE_VALUE, type Kernel32 } from "./windows-kernel32.ts"
import type { WindowsProcessRow } from "./windows-process-ancestry.ts"

const LEADING = 0x0100
const TRAILING = 0x0200
const CONSOLE_HOST: ConsoleHostIdentity = { image: "OpenConsole.exe", pid: 4242, ppid: 100 }

/** A CONSOLE_SCREEN_BUFFER_INFO: dwSize is the whole buffer (scrollback included), srWindow the
 * visible window, four SHORTs at offsets 10, 12, 14 and 16. */
function csbi(buffer: readonly [number, number], window: readonly [number, number, number, number]): Buffer {
  const bytes = Buffer.alloc(32)
  const view = new DataView(bytes.buffer)
  view.setInt16(0, buffer[0], true)
  view.setInt16(2, buffer[1], true)
  view.setInt16(10, window[0], true)
  view.setInt16(12, window[1], true)
  view.setInt16(14, window[2], true)
  view.setInt16(16, window[3], true)
  return bytes
}

function cellBytes(cells: readonly (readonly [number, number])[]): Buffer {
  const bytes = Buffer.alloc(cells.length * CHAR_INFO_BYTES)
  const view = new DataView(bytes.buffer)
  cells.forEach(([unit, attribute], index) => {
    view.setUint16(index * CHAR_INFO_BYTES, unit, true)
    view.setUint16(index * CHAR_INFO_BYTES + 2, attribute, true)
  })
  return bytes
}

const decode = (bytes: Buffer, cols: number, rows: number) => {
  const result = decodeCharInfo(bytes, cols, rows)
  if (result.status !== "decoded") throw new Error(`expected a decoded grid, got a refusal: ${result.reason}`)
  return result.grid
}

const refuse = (bytes: Buffer, cols: number, rows: number) => {
  expect(() => decodeCharInfo(bytes, cols, rows), "a bad cell read must refuse by name, not throw").not.toThrow()
  const result = decodeCharInfo(bytes, cols, rows)
  if (result.status !== "refused") {
    throw new Error(`expected a refusal, got a decoded grid: ${JSON.stringify(result.grid.text)}`)
  }
  return result.reason
}

describe("packCoord — a COORD is a pair of SHORTs", () => {
  it("puts X in the low half and Y in the high half, as the by-value COORD does", () => {
    expect(packCoord(0, 0)).toBe(0)
    expect(packCoord(80, 25)).toBe((25 << 16) | 80)
    expect(packCoord(0x7fff, 0x7fff)).toBe(0x7fff7fff)
  })

  it("refuses an axis a SHORT cannot hold instead of truncating it", () => {
    expect(() => packCoord(-1, 0)).toThrow(/SHORT/u)
    expect(() => packCoord(0, 0x8000)).toThrow(/SHORT/u)
    expect(() => packCoord(1.5, 0)).toThrow(/SHORT/u)
    expect(() => packCoord(65535, 0)).toThrow(/SHORT/u)
  })
})

describe("consoleHostFromTable — the host is the terminal's other child", () => {
  const terminal = 100
  const chain: WindowsProcessRow[] = [
    { pid: 100, ppid: 1, comm: "WindowsTerminal.exe" },
    { pid: 200, ppid: 100, comm: "powershell.exe" },
    { pid: 300, ppid: 200, comm: "bun.exe" },
  ]

  it("selects the one console-host child of the terminal and carries its pid and parent", () => {
    const lookup = consoleHostFromTable(terminal, [...chain, { pid: 4242, ppid: 100, comm: "OpenConsole.exe" }])
    expect(lookup).toEqual({ status: "named", host: { image: "OpenConsole.exe", pid: 4242, ppid: 100 } })
  })

  it("recognises conhost.exe whatever its case, and names the canonical image", () => {
    const lookup = consoleHostFromTable(terminal, [...chain, { pid: 4243, ppid: 100, comm: "CONHOST.EXE" }])
    expect(lookup).toEqual({ status: "named", host: { image: "conhost.exe", pid: 4243, ppid: 100 } })
  })

  it("refuses the measured chain, where the host is not an ancestor and so never appears", () => {
    expect(() => consoleHostFromTable(terminal, chain), "a missing host must refuse by name, not throw").not.toThrow()
    const lookup = consoleHostFromTable(terminal, chain)
    expect(lookup.status).toBe("refused")
    expect(lookup.status === "refused" ? lookup.reason : "").toMatch(/no OpenConsole\.exe or conhost\.exe child/u)
  })

  it("refuses a host that is an ancestor rather than a child of the terminal", () => {
    const rows: WindowsProcessRow[] = [
      { pid: 100, ppid: 9, comm: "WindowsTerminal.exe" },
      { pid: 9, ppid: 1, comm: "conhost.exe" },
      { pid: 300, ppid: 100, comm: "bun.exe" },
    ]
    expect(() => consoleHostFromTable(terminal, rows), "a missing host must refuse by name, not throw").not.toThrow()
    const lookup = consoleHostFromTable(terminal, rows)
    expect(lookup.status).toBe("refused")
    expect(lookup.status === "refused" ? lookup.reason : "").toMatch(/no OpenConsole\.exe or conhost\.exe child/u)
  })

  it("refuses two console hosts rather than picking one, and names both", () => {
    const lookup = consoleHostFromTable(terminal, [
      ...chain,
      { pid: 4242, ppid: 100, comm: "OpenConsole.exe" },
      { pid: 4243, ppid: 100, comm: "conhost.exe" },
    ])
    expect(lookup).toEqual({
      status: "refused",
      reason: expect.stringMatching(
        /2 console hosts in the process table: OpenConsole\.exe \(pid 4242\), conhost\.exe \(pid 4243\)/u,
      ),
    })
  })

  it("refuses when the ancestry named no terminal at all", () => {
    const lookup = consoleHostFromTable(undefined, chain)
    expect(lookup.status).toBe("refused")
    expect(lookup.status === "refused" ? lookup.reason : "").toMatch(/named no terminal process/u)
  })
})

describe("consoleBufferOwner — the arm's own guard, as a pure function", () => {
  it("passes a named host through unchanged", () => {
    const named = { status: "named" as const, host: CONSOLE_HOST }
    expect(consoleBufferOwner(named)).toBe(named)
  })

  it("keeps the table's own refusal, because it names what was looked for", () => {
    const refused = { status: "refused" as const, reason: "terminal process 100 has no conhost.exe child" }
    expect(consoleBufferOwner(refused)).toBe(refused)
  })

  it("refuses by name when the arm selected nothing at all", () => {
    expect(consoleBufferOwner(undefined)).toEqual({
      status: "refused",
      reason: "this arm selected no console host",
    })
  })
})

describe("consoleIdentityMismatch — a read on another console is not this run's frame", () => {
  it("says nothing when the console is the one the run bound to", () => {
    expect(consoleIdentityMismatch("327766", "327766")).toBeUndefined()
  })

  it("names both handles when it changed", () => {
    const reason = consoleIdentityMismatch("328074", "327766")
    expect(reason, "a read on another console must name the mismatch").toBeTypeOf("string")
    expect(reason).toMatch(/saw console 328074, not the console 327766/u)
  })

  it("names an unbound console as unbound rather than as a mismatch with nothing", () => {
    const reason = consoleIdentityMismatch("328074", undefined)
    expect(reason, "an unbound console must still be named").toBeTypeOf("string")
    expect(reason).toMatch(/not the console unbound/u)
  })
})

describe("decodeCharInfo — exact cells in the host's own encoding", () => {
  it("decodes a character and its legacy attribute per cell", () => {
    const grid = decode(
      cellBytes([
        [0x41, 0x0007],
        [0x20, 0x0007],
        [0x42, 0x001f],
      ]),
      3,
      1,
    )
    expect(grid.text).toEqual(["A B"])
    expect(grid.attributes).toEqual([[0x0007, 0x0007, 0x001f]])
  })

  it("keeps the wide character in BOTH cells the console gave it", () => {
    // U+FF11 FULLWIDTH DIGIT ONE: the host writes the character into the leading and the trailing
    // cell and marks them with COMMON_LVB_LEADING_BYTE then COMMON_LVB_TRAILING_BYTE.
    const grid = decode(
      cellBytes([
        [0xff11, 0x0007 | LEADING],
        [0xff11, 0x0007 | TRAILING],
        [0x20, 0x0007],
      ]),
      3,
      1,
    )
    expect(grid.text).toEqual(["\uff11\uff11 "])
    expect(grid.text[0]).toHaveLength(3)
    expect(grid.attributes).toEqual([[0x0107, 0x0207, 0x0007]])
  })

  it("refuses a trailing cell with no leading half before it", () => {
    expect(refuse(cellBytes([[0xff11, 0x0007 | TRAILING]]), 1, 1)).toMatch(
      /row 1, column 1 is a wide glyph's trailing cell with no leading half/u,
    )
  })

  it("refuses a trailing cell after a column 1 that is not its leading half", () => {
    // The column-0 clause cannot see this one: only the previous cell's leading flag refuses it, so
    // deleting that clause must not stay green.
    expect(
      refuse(
        cellBytes([
          [0x0041, 0x0007],
          [0xff11, 0x0007 | TRAILING],
        ]),
        2,
        1,
      ),
    ).toMatch(/row 1, column 2 is a wide glyph's trailing cell with no leading half/u)
  })

  it("refuses one cell marked both leading and trailing", () => {
    expect(refuse(cellBytes([[0xff11, 0x0007 | LEADING | TRAILING]]), 1, 1)).toMatch(
      /row 1, column 1 is marked both leading and trailing/u,
    )
  })

  it("refuses a leading cell in the last column, whose other half is outside the read", () => {
    expect(refuse(cellBytes([[0xff11, 0x0007 | LEADING]]), 1, 1)).toMatch(
      /row 1, column 1 is a wide glyph's leading cell in the last column/u,
    )
  })

  it("refuses a leading cell whose next cell is not its trailing half", () => {
    expect(
      refuse(
        cellBytes([
          [0xff11, 0x0007 | LEADING],
          [0x20, 0x0007],
        ]),
        2,
        1,
      ),
    ).toMatch(/the next cell is not its trailing half/u)
  })

  it("refuses a trailing half that belongs to a different glyph than the leading cell", () => {
    // Same geometry and flags, different character: the nextUnit clause is the only thing that
    // separates this from a real pair, so deleting that clause must not stay green.
    expect(
      refuse(
        cellBytes([
          [0xff11, 0x0007 | LEADING],
          [0xff12, 0x0007 | TRAILING],
        ]),
        2,
        1,
      ),
    ).toMatch(/the next cell is not its trailing half/u)
  })

  it("refuses a leading cell whose next cell holds the same character but no trailing flag", () => {
    // The character comparison cannot see this one, so only the attribute clause refuses it.
    expect(
      refuse(
        cellBytes([
          [0xff11, 0x0007 | LEADING],
          [0xff11, 0x0007],
        ]),
        2,
        1,
      ),
    ).toMatch(/the next cell is not its trailing half/u)
  })

  it("refuses U+FFFD, the host's stand-in for a glyph longer than one UTF-16 unit", () => {
    expect(refuse(cellBytes([[0xfffd, 0x0007]]), 1, 1)).toMatch(/holds U\+FFFD/u)
  })

  it("refuses a lone surrogate by name, with its row and column", () => {
    const reason = refuse(
      cellBytes([
        [0x0041, 0x0007],
        [0xd800, 0x0007],
      ]),
      2,
      1,
    )
    expect(reason).toMatch(/row 1, column 2/u)
    expect(reason).toMatch(/lone surrogate U\+D800/u)
  })

  it("refuses a NUL with no attribute: the host writes a blank as U+0020 with the fill attribute", () => {
    expect(refuse(cellBytes([[0x0000, 0x0000]]), 1, 1)).toMatch(/NUL with no attribute/u)
  })

  it("keeps a NUL that carries an attribute, because only the never-written cell has none", () => {
    // The refusal is the pair, not the NUL: a NUL the host wrote carries the fill attribute, and
    // deleting the attribute clause would refuse a cell the host did write.
    expect(decode(cellBytes([[0x0000, 0x0007]]), 1, 1).text).toEqual(["\u0000"])
  })

  it("refuses a buffer that is not exactly cols x rows cells rather than reporting a partial grid", () => {
    expect(() => decodeCharInfo(cellBytes([[0x41, 7]]), 2, 1)).toThrow(/CHAR_INFO buffer/u)
  })
})

describe("readWindowsConsoleCells — the window rect, read back and checked", () => {
  type Seen = { sizes: number[]; origins: number[]; regions: number[]; closed: number; windows: string[] }

  const fakeKernel = (
    options: {
      csbiBytes?: Buffer
      filled?: Buffer
      /** What the host writes back into lpReadRegion; the request by default. */
      usedRegion?: readonly [number, number, number, number]
      /** The window the SECOND info read reports, for a console that moves under the cell read. */
      movedTo?: readonly [number, number, number, number]
      /** Fail this numbered GetConsoleScreenBufferInfo read (1 = the first, 2 = the re-read). */
      failOnInfoRead?: number
      getLastError?: number
    } = {},
  ): { kernel: Kernel32; seen: Seen } => {
    const seen: Seen = { sizes: [], origins: [], regions: [], closed: 0, windows: [] }
    let infoReads = 0
    const kernel = {
      ptr: (data: Uint8Array) => data,
      symbols: {
        CreateFileW: () => 7n,
        GetConsoleScreenBufferInfo: (_handle: never, buffer: never) => {
          infoReads += 1
          if (infoReads === options.failOnInfoRead) return 0
          const bytes =
            infoReads > 1 && options.movedTo !== undefined
              ? csbi([40, 200], options.movedTo)
              : (options.csbiBytes ?? csbi([40, 200], [0, 0, 2, 0]))
          bytes.copy(buffer as unknown as Buffer)
          return 1
        },
        ReadConsoleOutputW: (_handle: never, buffer: never, size: never, origin: never, region: never) => {
          seen.sizes.push(size as unknown as number)
          seen.origins.push(origin as unknown as number)
          const typed = region as unknown as Uint8Array
          const view = new DataView(typed.buffer, typed.byteOffset, typed.byteLength)
          seen.regions.push(
            view.getInt16(0, true),
            view.getInt16(2, true),
            view.getInt16(4, true),
            view.getInt16(6, true),
          )
          if (options.usedRegion !== undefined) {
            view.setInt16(0, options.usedRegion[0], true)
            view.setInt16(2, options.usedRegion[1], true)
            view.setInt16(4, options.usedRegion[2], true)
            view.setInt16(6, options.usedRegion[3], true)
          }
          options.filled?.copy(buffer as unknown as Buffer)
          return 1
        },
        GetConsoleWindow: () => 7n,
        CreateToolhelp32Snapshot: () => 7n,
        Process32FirstW: () => 1,
        Process32NextW: () => 0,
        GetLastError: () => options.getLastError ?? 0,
        CloseHandle: () => {
          seen.closed += 1
          return 1
        },
      },
    } as unknown as Kernel32
    return { kernel, seen }
  }

  it("asks for the visible window — not the buffer height — and names the host it read", async () => {
    const { kernel, seen } = fakeKernel({
      // Buffer 40x200, window [4,7]-[6,8]: 3 cols x 2 rows starting where the window starts.
      csbiBytes: csbi([40, 200], [4, 7, 6, 8]),
      filled: cellBytes([0x41, 0x42, 0x43, 0x44, 0x45, 0x46].map((unit) => [unit, 0x0007] as const)),
    })
    const read = await readWindowsConsoleCells({ bufferOwner: CONSOLE_HOST, kernel })
    expect(seen.sizes).toEqual([packCoord(3, 2)])
    expect(seen.origins).toEqual([0])
    expect(seen.regions).toEqual([4, 7, 6, 8])
    expect(read).toEqual({
      status: "read",
      bufferOwner: CONSOLE_HOST,
      grid: {
        cols: 3,
        rows: 2,
        text: ["ABC", "DEF"],
        attributes: [
          [0x0007, 0x0007, 0x0007],
          [0x0007, 0x0007, 0x0007],
        ],
      },
    })
    expect(seen.closed).toBe(1)
  })

  it("refuses a read the host clipped, naming both rectangles", async () => {
    const { kernel } = fakeKernel({
      csbiBytes: csbi([40, 200], [4, 7, 6, 8]),
      filled: cellBytes([0x41, 0x42, 0x43, 0x44, 0x45, 0x46].map((unit) => [unit, 0x0007] as const)),
      usedRegion: [4, 7, 5, 7],
    })
    expect(await readWindowsConsoleCells({ bufferOwner: CONSOLE_HOST, kernel })).toEqual({
      status: "refused",
      reason: expect.stringMatching(/read \[4,7\]-\[5,7\] instead of the requested \[4,7\]-\[6,8\]/u),
    })
  })

  it("refuses a window that moved between the cell read and the re-read", async () => {
    const { kernel } = fakeKernel({
      csbiBytes: csbi([40, 200], [4, 7, 6, 8]),
      filled: cellBytes([0x41, 0x42, 0x43, 0x44, 0x45, 0x46].map((unit) => [unit, 0x0007] as const)),
      movedTo: [4, 8, 6, 9],
    })
    expect(await readWindowsConsoleCells({ bufferOwner: CONSOLE_HOST, kernel })).toEqual({
      status: "refused",
      reason: expect.stringMatching(/window moved from \[4,7\]-\[6,8\] to \[4,8\]-\[6,9\] during the cell read/u),
    })
  })

  it("a first screen-buffer read that fails throws with its Win32 code, and still closes the handle", async () => {
    const { kernel, seen } = fakeKernel({ failOnInfoRead: 1, getLastError: 6 })
    await expect(readWindowsConsoleCells({ bufferOwner: CONSOLE_HOST, kernel })).rejects.toThrow(
      /^GetConsoleScreenBufferInfo failed with error 6$/u,
    )
    expect(seen.closed).toBe(1)
  })

  it("a re-read that fails throws with its Win32 code, and still closes the handle", async () => {
    const { kernel, seen } = fakeKernel({
      csbiBytes: csbi([40, 200], [4, 7, 6, 8]),
      filled: cellBytes([0x41, 0x42, 0x43, 0x44, 0x45, 0x46].map((unit) => [unit, 0x0007] as const)),
      failOnInfoRead: 2,
      getLastError: 6,
    })
    await expect(readWindowsConsoleCells({ bufferOwner: CONSOLE_HOST, kernel })).rejects.toThrow(
      /^GetConsoleScreenBufferInfo after the cell read failed with error 6$/u,
    )
    expect(seen.closed).toBe(1)
  })

  it("throws by name when CreateFileW yields INVALID_HANDLE_VALUE, and closes nothing it never opened", async () => {
    const { kernel, seen } = fakeKernel({ getLastError: 5 })
    kernel.symbols.CreateFileW = (() => INVALID_HANDLE_VALUE) as never
    await expect(readWindowsConsoleCells({ bufferOwner: CONSOLE_HOST, kernel })).rejects.toThrow(
      /^CreateFileW CONOUT\$ failed with error 5$/u,
    )
    expect(seen.closed).toBe(0)
  })

  it("refuses when no buffer owner is named, and never touches the console to do it", async () => {
    const read = await readWindowsConsoleCells({ bufferOwner: undefined })
    expect(read).toEqual({
      status: "refused",
      reason: "no console buffer owner was named, so a cell read cannot say which program's buffer it saw",
    })
  })

  it("a native refusal throws with its Win32 code, and still closes the handle", async () => {
    const { kernel, seen } = fakeKernel({ getLastError: 6 })
    kernel.symbols.ReadConsoleOutputW = (() => 0) as never
    await expect(readWindowsConsoleCells({ bufferOwner: CONSOLE_HOST, kernel })).rejects.toThrow(/error 6/u)
    expect(seen.closed).toBe(1)
  })

  it("refuses before allocating when a window axis is past what a COORD can hold", async () => {
    // 65536 x 65536 cells: if anything allocated before packCoord, this would die on a 17 GB
    // allocation instead of naming the SHORT, so the assertion below is what proves the order.
    const { kernel } = fakeKernel({ csbiBytes: csbi([40, 200], [-32768, -32768, 32767, 32767]) })
    await expect(readWindowsConsoleCells({ bufferOwner: CONSOLE_HOST, kernel })).rejects.toThrow(/SHORT/u)
  })
})
