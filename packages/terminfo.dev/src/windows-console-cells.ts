/**
 * Cell-content readback for the hosted Windows arm.
 *
 * ReadConsoleOutputW on this process's CONOUT$ returns the console HOST's screen buffer — the
 * program that owns the console the probes write to, NOT the terminal that draws it. The host is
 * the terminal's OTHER child, a sibling of the shell: Windows Terminal starts OpenConsole.exe (or
 * conhost.exe) and the shell as two children of itself, so an ancestry walk from this process sees
 * the terminal and the shell and never the host. Selection is therefore a table lookup, below.
 *
 * Under ConPTY that buffer is the text the terminal renders, so a read yields exact cells and
 * legacy attributes and never pixels. A sequence the console host does not interpret is invisible
 * here whatever the terminal does with it, which is why every result names its buffer owner and why
 * a row whose claim the host cannot show stays named rather than decided.
 *
 * The read is the WINDOW rectangle, never the buffer height: the buffer is scrollback-inclusive,
 * the window is what the classics compare (windows-console-ffi.ts).
 *
 * Three laws this module keeps:
 *  - Empty text is a cell VALUE, never a refusal. A refused read is its own state with a reason.
 *  - A cell the host never wrote is refused by name: a blank is U+0020 with the fill attribute, so
 *    a NUL with no attribute is a clipped or stale read, not an empty cell.
 *  - Nothing here guesses: a buffer that is the wrong size, a coord that cannot be packed, a read
 *    region the host changed and a native call that fails are all named before any cell is reported.
 */
import { CSBI_BYTES, decodeConsoleWindowRect, withConsoleOutputHandle } from "./windows-console-ffi.ts"
import { loadKernel32, type Kernel32 } from "./windows-kernel32.ts"
import { windowsCommBase, type WindowsProcessRow } from "./windows-process-ancestry.ts"

/** A CHAR_INFO: `WCHAR UnicodeChar` then `WORD Attributes`, both little-endian u16. */
export const CHAR_INFO_BYTES = 4
/** A SMALL_RECT: four `SHORT`s — left, top, right, bottom — in the buffer's 0-based coordinates. */
export const SMALL_RECT_BYTES = 8
/** COORD is a pair of SHORTs, so each axis ends here; a larger number cannot be passed by value. */
const COORD_MAX = 0x7fff
/** COMMON_LVB_LEADING_BYTE / COMMON_LVB_TRAILING_BYTE: the two halves of one wide glyph. */
const LEADING_BYTE = 0x0100
const TRAILING_BYTE = 0x0200
/** U+FFFD is what the host writes for a glyph that is longer than one UTF-16 unit. */
const WIDE_GLYPH_UNKNOWN = 0xfffd

/** The visible window as cells. `text` holds one string per row with one UTF-16 code unit per
 * cell, so a wide glyph is the character in BOTH of its cells — that is what the host wrote, and
 * it keeps every cell index equal to every string index. `attributes` is the legacy WORD per cell,
 * the value the host computes from the cell's stored colour at read time, so these attributes
 * cannot decide a colour beyond sixteen (a 24-bit or 256-colour request lands on one of those
 * sixteen inside the host, not here), and includes the leading/trailing flags. */
export interface ConsoleCellGrid {
  readonly cols: number
  readonly rows: number
  readonly text: readonly string[]
  readonly attributes: readonly (readonly number[])[]
}

/** One cell-content read: exact cells, or the named reason there are none. */
export type ConsoleCellRead =
  | {
      readonly status: "read"
      readonly grid: ConsoleCellGrid
      /** The program whose buffer this is, named so the evidence says how it was seen. */
      readonly bufferOwner: ConsoleHostIdentity
    }
  | { readonly status: "refused"; readonly reason: string }

/** The program whose console buffer a read returns. Windows Terminal draws the window; the buffer
 * belongs to the console host it starts under ConPTY, and only these two images are hosts. */
export const CONSOLE_HOST_IMAGES = ["OpenConsole.exe", "conhost.exe"] as const
export type ConsoleHostImage = (typeof CONSOLE_HOST_IMAGES)[number]

/** A console host as the process table names it. The pid is the host's own and the ppid is the
 * terminal that started it, because a buffer attributed to the wrong program decides nothing. */
export interface ConsoleHostIdentity {
  readonly image: ConsoleHostImage
  readonly pid: number
  readonly ppid: number
}

/** Selecting the buffer owner, or the named reason it cannot be selected. */
export type ConsoleHostLookup =
  | { readonly status: "named"; readonly host: ConsoleHostIdentity }
  | { readonly status: "refused"; readonly reason: string }

const consoleHostImage = (comm: string): ConsoleHostImage | undefined => {
  const base = windowsCommBase(comm)
  return CONSOLE_HOST_IMAGES.find((image) => windowsCommBase(image) === base)
}

/**
 * Select the console host that belongs to `terminalPid`, from the process TABLE — never from the
 * ancestry chain, which cannot contain a sibling. Exactly one child of the terminal may be a
 * console host; none or several refuses by name rather than picking one.
 */
export function consoleHostFromTable(
  terminalPid: number | undefined,
  rows: readonly WindowsProcessRow[],
): ConsoleHostLookup {
  if (terminalPid === undefined) {
    return {
      status: "refused",
      reason: "the collector's ancestry named no terminal process, so no console host can be selected",
    }
  }
  const children = rows.filter((row) => row.ppid === terminalPid && consoleHostImage(row.comm) !== undefined)
  const only = children[0]
  const image = only === undefined ? undefined : consoleHostImage(only.comm)
  if (only === undefined || image === undefined) {
    return {
      status: "refused",
      reason: `terminal process ${String(terminalPid)} has no ${CONSOLE_HOST_IMAGES.join(" or ")} child in the process table`,
    }
  }
  if (children.length > 1) {
    const found = children.map((row) => `${row.comm} (pid ${String(row.pid)})`).join(", ")
    return {
      status: "refused",
      reason: `terminal process ${String(terminalPid)} has ${String(children.length)} console hosts in the process table: ${found}`,
    }
  }
  return { status: "named", host: { image, pid: only.pid, ppid: only.ppid } }
}

/** The buffer owner a cell read may use, or the named reason there is none. A read on an unnamed
 * buffer cannot be cited as evidence, so an unnamed lookup becomes a refusal here; the read
 * refuses a missing owner as well. The undefined arm is this function's domain — readCells never
 * passes one, because it requires the owner it was given. */
export function consoleBufferOwner(lookup: ConsoleHostLookup | undefined): ConsoleHostLookup {
  // A refusal from the table already names what was looked for, so it passes through as it is.
  return lookup ?? { status: "refused", reason: "this arm selected no console host" }
}

/** The console a read saw must be the console this run bound to: a read on another console is not
 * this run's frame. Returns the reason, or undefined when the two are the same console. The unbound
 * arm is this function's domain — a read runs against the console its owner bound. */
export function consoleIdentityMismatch(read: string, bound: string | undefined): string | undefined {
  return read === bound
    ? undefined
    : `Owned cell read saw console ${read}, not the console ${bound ?? "unbound"} this run bound to`
}

/** Pack a COORD for a BY-VALUE argument: X in the low 16 bits, Y in the high 16 bits. */
export function packCoord(x: number, y: number): number {
  for (const [axis, value] of [
    ["x", x],
    ["y", y],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > COORD_MAX) {
      throw new Error(`COORD ${axis} is not a SHORT: ${String(value)}`)
    }
  }
  return (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0
}

/** A decode, or the named reason these bytes are not a grid of cells. */
export type ConsoleCellDecode =
  | { readonly status: "decoded"; readonly grid: ConsoleCellGrid }
  | { readonly status: "refused"; readonly reason: string }

/**
 * Decode a PCHAR_INFO buffer filled for `cols` x `rows`. Pure, so the layout and the host's own
 * wide-glyph encoding are testable where no console exists. A buffer of any other size is a bug in
 * the caller, not a partial read; content the host cannot have written is refused, not decoded.
 */
export function decodeCharInfo(bytes: Uint8Array, cols: number, rows: number): ConsoleCellDecode {
  const expected = cols * rows * CHAR_INFO_BYTES
  if (bytes.byteLength !== expected) {
    throw new Error(
      `CHAR_INFO buffer is ${String(bytes.byteLength)} bytes, but ${String(cols)}x${String(rows)} cells need ${String(expected)}`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = (row: number, col: number) => (row * cols + col) * CHAR_INFO_BYTES
  const text: string[] = []
  const attributes: number[][] = []
  for (let row = 0; row < rows; row += 1) {
    const units: number[] = []
    const rowAttributes: number[] = []
    for (let col = 0; col < cols; col += 1) {
      const cell = at(row, col)
      const unit = view.getUint16(cell, true)
      const attribute = view.getUint16(cell + 2, true)
      const where = `row ${String(row + 1)}, column ${String(col + 1)}`
      if (unit === 0 && attribute === 0) {
        return {
          status: "refused",
          reason: `${where} decodes as NUL with no attribute; the console writes a blank cell as U+0020 with the fill attribute, so this cell was never written`,
        }
      }
      if (unit === WIDE_GLYPH_UNKNOWN) {
        return {
          status: "refused",
          reason: `${where} holds U+FFFD, the host's stand-in for a glyph longer than one UTF-16 unit, so this region cannot be read as characters`,
        }
      }
      // One UTF-16 unit per cell: a surrogate is half a character, which the host never writes,
      // so it is refused rather than decoded into a string that is not text.
      if (unit >= 0xd800 && unit <= 0xdfff) {
        return {
          status: "refused",
          reason: `${where} holds the lone surrogate U+${unit.toString(16).toUpperCase()}, which the host never writes into a cell`,
        }
      }
      const leading = (attribute & LEADING_BYTE) !== 0
      const trailing = (attribute & TRAILING_BYTE) !== 0
      if (leading && trailing) {
        return { status: "refused", reason: `${where} is marked both leading and trailing in one cell` }
      }
      if (leading) {
        if (col + 1 >= cols) {
          return {
            status: "refused",
            reason: `${where} is a wide glyph's leading cell in the last column, so its trailing half is outside the read`,
          }
        }
        const next = at(row, col + 1)
        const nextUnit = view.getUint16(next, true)
        const nextAttribute = view.getUint16(next + 2, true)
        if ((nextAttribute & TRAILING_BYTE) === 0 || nextUnit !== unit) {
          return {
            status: "refused",
            reason: `${where} is a wide glyph's leading cell, but the next cell is not its trailing half`,
          }
        }
      }
      if (trailing && (col === 0 || (view.getUint16(at(row, col - 1) + 2, true) & LEADING_BYTE) === 0)) {
        return {
          status: "refused",
          reason: `${where} is a wide glyph's trailing cell with no leading half before it`,
        }
      }
      units.push(unit)
      rowAttributes.push(attribute)
    }
    // One cell is one code unit, so a wide glyph occupies the two cells the console gave it and
    // nothing here re-lays-out the grid.
    text.push(units.map((unit) => String.fromCharCode(unit)).join(""))
    attributes.push(rowAttributes)
  }
  return { status: "decoded", grid: { cols, rows, text, attributes } }
}

export interface ConsoleCellReadOptions {
  /** The console host whose buffer this read returns. Required: an unnamed buffer cannot be cited
   * as evidence, and the image is one of the two hosts, never the terminal that draws the window. */
  readonly bufferOwner: ConsoleHostIdentity | undefined
  /** Injection seam for tests; production passes the binding the arm already loaded. */
  readonly kernel?: Kernel32
}

/** Read the visible window's cells over this process's own CONOUT$. */
export async function readWindowsConsoleCells(options: ConsoleCellReadOptions): Promise<ConsoleCellRead> {
  const owner = options.bufferOwner
  if (owner === undefined) {
    return {
      status: "refused",
      reason: "no console buffer owner was named, so a cell read cannot say which program's buffer it saw",
    }
  }
  const kernel = options.kernel ?? loadKernel32()
  return withConsoleOutputHandle((handle, { symbols, ptr }) => {
    const info = Buffer.alloc(CSBI_BYTES)
    if (symbols.GetConsoleScreenBufferInfo(handle as never, ptr(info) as never) === 0) {
      throw new Error(`GetConsoleScreenBufferInfo failed with error ${String(symbols.GetLastError())}`)
    }
    const rect = decodeConsoleWindowRect(info)
    const cols = rect.right - rect.left + 1
    const rows = rect.bottom - rect.top + 1
    // Validate both COORDs before anything is allocated: an axis outside SHORT cannot be passed.
    const size = packCoord(cols, rows)
    const origin = packCoord(0, 0)
    const cells = Buffer.alloc(CHAR_INFO_BYTES * cols * rows)
    const region = Buffer.alloc(SMALL_RECT_BYTES)
    const regionView = new DataView(region.buffer, region.byteOffset, region.byteLength)
    regionView.setInt16(0, rect.left, true)
    regionView.setInt16(2, rect.top, true)
    regionView.setInt16(4, rect.right, true)
    regionView.setInt16(6, rect.bottom, true)
    const read = symbols.ReadConsoleOutputW(
      handle as never,
      ptr(cells) as never,
      size as never,
      origin as never,
      ptr(region) as never,
    )
    // Read immediately: any other native call in between clobbers the last-error slot.
    if (read === 0) {
      throw new Error(`ReadConsoleOutputW failed with error ${String(symbols.GetLastError())}`)
    }
    // lpReadRegion is in/out: the host CLIPS the request to its buffer, reports success, and writes
    // back the rectangle it actually used. Cells outside it stay zero, so a clipped read must be
    // refused rather than decoded into cells the host never wrote.
    const used = {
      left: regionView.getInt16(0, true),
      top: regionView.getInt16(2, true),
      right: regionView.getInt16(4, true),
      bottom: regionView.getInt16(6, true),
    }
    const same =
      used.left === rect.left && used.top === rect.top && used.right === rect.right && used.bottom === rect.bottom
    if (!same) {
      return {
        status: "refused",
        reason: `the console host read ${formatRect(used)} instead of the requested ${formatRect(rect)}; a region that changed under the read is not a frame`,
      } satisfies ConsoleCellRead
    }
    // Clipping is only one way the console can change under the read; the window itself can move
    // between the two native calls. Re-read it and refuse rather than label a moving console as a
    // frame, because the decode below would place cells from one window on another window's grid.
    const after = Buffer.alloc(CSBI_BYTES)
    if (symbols.GetConsoleScreenBufferInfo(handle as never, ptr(after) as never) === 0) {
      throw new Error(
        `GetConsoleScreenBufferInfo after the cell read failed with error ${String(symbols.GetLastError())}`,
      )
    }
    const now = decodeConsoleWindowRect(after)
    if (now.left !== rect.left || now.top !== rect.top || now.right !== rect.right || now.bottom !== rect.bottom) {
      return {
        status: "refused",
        reason: `the console window moved from ${formatRect(rect)} to ${formatRect(now)} during the cell read, so these cells are not one screen`,
      } satisfies ConsoleCellRead
    }
    const decoded = decodeCharInfo(cells, cols, rows)
    if (decoded.status === "refused") return decoded
    return { status: "read", grid: decoded.grid, bufferOwner: owner } satisfies ConsoleCellRead
  }, kernel)
}

const formatRect = (rect: { left: number; top: number; right: number; bottom: number }): string =>
  `[${String(rect.left)},${String(rect.top)}]-[${String(rect.right)},${String(rect.bottom)}]`
