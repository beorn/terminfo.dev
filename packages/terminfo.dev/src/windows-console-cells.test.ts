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
  resolveConsoleHostIdentity,
  type ConsoleHostIdentity,
} from "./windows-console-cells.ts"
import { INVALID_HANDLE_VALUE, type Kernel32 } from "./windows-kernel32.ts"
import { readProcessImagePath } from "./windows-console-ffi.ts"
import type { WindowsProcessRow } from "./windows-process-ancestry.ts"
import { textCellsFrame } from "./serve.ts"

const LEADING = 0x0100
const TRAILING = 0x0200
const CONSOLE_HOST: ConsoleHostIdentity = {
  image: "OpenConsole.exe",
  pid: 4242,
  ppid: 100,
  executablePath: "C:\\Windows\\System32\\OpenConsole.exe",
  executableSha256: `sha256:${"a".repeat(64)}`,
}

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

  it("reports U+FFFD as the host's stand-in, by row and column, instead of refusing the read", () => {
    // The host wrote this cell: U+FFFD is its stand-in for a glyph longer than one UTF-16 unit, so
    // the cell is named rather than decoded into a guess — and not refused as if it were unwritten.
    // Scoping the stand-in to the cells a row compares belongs to the frame, which knows them.
    const result = decodeCharInfo(
      cellBytes([
        [0x0041, 0x0007],
        [0xfffd, 0x0007],
      ]),
      2,
      1,
    )
    if (result.status !== "decoded") throw new Error(`expected a decoded grid, got a refusal: ${result.reason}`)
    expect(result.grid.text).toEqual(["A\ufffd"])
    expect(result.standIns).toEqual([{ row: 1, column: 2, standIn: "U+FFFD" }])
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
      // Every read names its stand-ins, so an arm that saw none says so rather than omitting the
      // field: absence would be indistinguishable from a reader that forgot to look.
      standIns: [],
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

  it("hands a U+FFFD cell to textCellsFrame, which refuses it only inside the compared cells", async () => {
    // A read that reported no stand-ins would still pass every frame-level test, and a stand-in
    // inside the compared cells would be digested silently. This row follows the read all the way
    // to the refusal, so dropping the report anywhere on that path fails here.
    const { kernel } = fakeKernel({
      csbiBytes: csbi([4, 2], [1, 1, 4, 2]),
      filled: cellBytes([
        [0xfffd, 0x0007],
        [0x41, 0x0007],
        [0x42, 0x0007],
        [0x43, 0x0007],
        [0x44, 0x0007],
        [0x45, 0x0007],
        [0x46, 0x0007],
        [0x47, 0x0007],
      ]),
    })
    const read = await readWindowsConsoleCells({ bufferOwner: CONSOLE_HOST, kernel })
    if (read.status !== "read") throw new Error(`expected a read, got a refusal: ${read.reason}`)
    expect(read.standIns).toEqual([{ row: 1, column: 1, standIn: "U+FFFD" }])
    expect(() =>
      textCellsFrame({ role: "target", label: "inside", cells: { top: 1, left: 1, bottom: 1, right: 2 } }, read, 1),
    ).toThrow(/row 1, column 1 holds U\+FFFD, the host's stand-in/u)
    const outside = textCellsFrame(
      { role: "target", label: "outside", cells: { top: 2, left: 1, bottom: 2, right: 4 } },
      read,
      1,
    )
    expect(outside.trace.standIns).toEqual([{ row: 1, column: 1, standIn: "U+FFFD" }])
  })
})

describe("resolveConsoleHostIdentity — the executable is a path plus a hash (30042)", () => {
  type Seen = { opened: Array<[number, number, number]>; closed: number }
  const host = { image: "OpenConsole.exe" as const, pid: 4242, ppid: 100 }
  const executable = "C:\\Windows\\System32\\OpenConsole.exe"

  const fakeKernel = (
    seen: Seen,
    options: {
      handle?: bigint
      path?: string
      query?: number
      error?: number
      /** The creation FILETIME this process reports. A different value is a different incarnation
       * at the same pid and path (30042, CTO ruling 910846c7). */
      createdAt?: bigint
      /** GetProcessTimes returning 0, so the identity read must refuse by name. */
      timesFails?: boolean
    } = {},
  ): Kernel32 =>
    ({
      ptr: (data: Uint8Array) => data,
      symbols: {
        OpenProcess: (access: never, inherit: never, pid: never) => {
          seen.opened.push([access as unknown as number, inherit as unknown as number, pid as unknown as number])
          return options.handle ?? 9n
        },
        QueryFullProcessImageNameW: (_handle: never, _flags: never, name: never, size: never) => {
          if (options.query === 0) return 0
          const text = options.path ?? executable
          ;(name as unknown as Buffer).write(text, 0, "utf16le")
          ;(size as unknown as Buffer).writeUInt32LE(text.length, 0)
          return 1
        },
        GetProcessTimes: (_handle: never, created: never, _exited: never, _kernel: never, _user: never) => {
          if (options.timesFails === true) return 0
          ;(created as unknown as Buffer).writeBigUInt64LE(options.createdAt ?? 132_000_000_000_000_000n, 0)
          return 1
        },
        GetLastError: () => options.error ?? 0,
        CloseHandle: () => {
          seen.closed += 1
          return 1
        },
      },
    }) as unknown as Kernel32

  it("opens the host with the limited-query right, decodes by the returned characters and closes the handle", () => {
    const seen: Seen = { opened: [], closed: 0 }
    const hashed: string[] = []
    const resolved = resolveConsoleHostIdentity(host, {
      kernel: fakeKernel(seen, { path: "C:\\Windows\\System32\\conhost.exe" }),
      cache: new Map(),
      hash: (path) => {
        hashed.push(path)
        return `sha256:${"b".repeat(64)}`
      },
    })
    expect(resolved).toEqual({
      status: "named",
      host: {
        ...host,
        executablePath: "C:\\Windows\\System32\\conhost.exe",
        executableSha256: `sha256:${"b".repeat(64)}`,
      },
    })
    expect(seen.opened).toEqual([[0x1000, 0, 4242]])
    expect(seen.closed).toBe(1)
    expect(hashed).toEqual(["C:\\Windows\\System32\\conhost.exe"])
  })

  it("refuses a host it cannot open by name, and never closes a handle it did not get", () => {
    const seen: Seen = { opened: [], closed: 0 }
    const resolved = resolveConsoleHostIdentity(host, {
      kernel: fakeKernel(seen, { handle: 0n, error: 5 }),
      cache: new Map(),
      hash: () => `sha256:${"c".repeat(64)}`,
    })
    expect(resolved).toEqual({ status: "refused", reason: "cannot open console host pid 4242: error 5" })
    expect(seen.closed).toBe(0)
  })

  it("refuses a failed path query by name and still closes the handle", () => {
    const seen: Seen = { opened: [], closed: 0 }
    const resolved = resolveConsoleHostIdentity(host, {
      kernel: fakeKernel(seen, { query: 0, error: 6 }),
      cache: new Map(),
      hash: () => `sha256:${"c".repeat(64)}`,
    })
    expect(resolved).toEqual({
      status: "refused",
      reason: "cannot read the executable path of console host pid 4242: error 6",
    })
    expect(seen.closed).toBe(1)
  })

  it("hashes one executable once per incarnation, and hashes a different pid again", () => {
    const cache = new Map<string, string>()
    const hashed: string[] = []
    const hash = (path: string) => {
      hashed.push(path)
      return `sha256:${String(hashed.length).repeat(64)}`
    }
    const seen: Seen = { opened: [], closed: 0 }
    const kernel = fakeKernel(seen)
    expect(resolveConsoleHostIdentity(host, { kernel, cache, hash }).status).toBe("named")
    expect(resolveConsoleHostIdentity(host, { kernel, cache, hash }).status).toBe("named")
    expect(hashed, "one hash for two reads of one incarnation").toHaveLength(1)
    expect(resolveConsoleHostIdentity({ ...host, pid: 4243 }, { kernel, cache, hash }).status).toBe("named")
    expect(hashed, "a different pid hashes again").toHaveLength(2)
  })

  it("hashes the same pid and path again when the creation time names a new incarnation", () => {
    // A reused PID at the same path publishes the former process's digest unless the key carries
    // the incarnation. The two creation values differ ONLY above bit 31, so a decode that reads the
    // wrong high DWORD — or drops it — makes them one key and fails here.
    const cache = new Map<string, string>()
    const hashed: string[] = []
    const hash = (path: string) => {
      hashed.push(path)
      return `sha256:${String(hashed.length).repeat(64)}`
    }
    const seen: Seen = { opened: [], closed: 0 }
    const first = fakeKernel(seen, { createdAt: 132_000_000_000_000_000n })
    const second = fakeKernel(seen, { createdAt: 132_000_000_000_000_000n + 2n ** 32n })
    expect(resolveConsoleHostIdentity(host, { kernel: first, cache, hash }).status).toBe("named")
    expect(hashed).toHaveLength(1)
    const reused = resolveConsoleHostIdentity(host, { kernel: second, cache, hash })
    expect(reused.status).toBe("named")
    expect(hashed, "a new incarnation at the same pid and path hashes again").toHaveLength(2)
  })

  it("decodes the creation FILETIME from its own 8 bytes, high DWORD included", () => {
    // The creation time is the FIRST FILETIME; byte 8 belongs to the exit time. A high word read at
    // byte 8 mixes a different FILETIME into the key, which is invisible while that word is zero.
    const seen: Seen = { opened: [], closed: 0 }
    const ticks = 0x0123_4567_89ab_cdefn
    const resolved = readProcessImagePath(4242, fakeKernel(seen, { createdAt: ticks }))
    expect(resolved).toEqual({ status: "named", path: executable, createdAt: String(ticks) })
  })

  it("refuses by name when the creation time cannot be read, and never hashes on a pid alone", () => {
    const cache = new Map<string, string>()
    const hashed: string[] = []
    const seen: Seen = { opened: [], closed: 0 }
    const resolved = resolveConsoleHostIdentity(host, {
      kernel: fakeKernel(seen, { timesFails: true, error: 87 }),
      cache,
      hash: (path) => {
        hashed.push(path)
        return `sha256:${"e".repeat(64)}`
      },
    })
    expect(resolved).toEqual({
      status: "refused",
      reason: "cannot read the creation time of console host pid 4242: error 87",
    })
    expect(hashed, "no digest is published without an incarnation").toEqual([])
    expect(cache.size).toBe(0)
    expect(seen.closed, "the handle is closed on the refusal too").toBe(1)
  })

  it("refuses a hash failure for that read without caching the rejection", () => {
    const cache = new Map<string, string>()
    const seen: Seen = { opened: [], closed: 0 }
    const kernel = fakeKernel(seen)
    const failed = resolveConsoleHostIdentity(host, {
      kernel,
      cache,
      hash: () => {
        throw new Error("EACCES")
      },
    })
    expect(failed).toEqual({
      status: "refused",
      reason: `cannot hash the executable of console host pid 4242 at ${executable}: EACCES`,
    })
    expect(cache.size).toBe(0)
    const recovered = resolveConsoleHostIdentity(host, {
      kernel,
      cache,
      hash: () => `sha256:${"d".repeat(64)}`,
    })
    expect(recovered.status).toBe("named")
    expect(cache.size).toBe(1)
  })
})
