/**
 * The hosted Windows process-ancestry read for the owned terminal (29558, option A).
 *
 * Why this exists: the ownership binding of the Darwin arm is a grant-time ancestry check — the
 * receipt names the launched app, and the collector shows that app's process is one of ITS OWN
 * ancestors (owned-terminal.ts `requireHostedDarwinAppAncestor`). The Windows route needs the same
 * claim, and the receipt there names the launched `WindowsTerminal.exe`. Under ConPTY the chain has
 * no `conhost.exe` and no `OpenConsole.exe` (measured 2026-10-15, run 38815827412: 8848:powershell.exe
 * <- 5796:WindowsTerminal.exe <- 5492:bash.exe <- ... <- Runner.Worker.exe), so the Darwin-shaped
 * check ports directly.
 *
 * The read is a toolhelp32 snapshot through the same ./windows-kernel32.ts binding the geometry read
 * uses: `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` then `Process32FirstW`/`Process32NextW` over
 * PROCESSENTRY32W records. Windows-only and lazily imported (nothing imports ./windows-kernel32.ts
 * statically), so the launcher still starts under node - but this read is ffi-only, so the hosted
 * Windows ownership path does NOT work end-to-end under node: it refuses at loadKernel32 by name
 * rather than walking a table it cannot read (@dev/7 r2).
 *
 * NO SILENT DEFAULT: a snapshot that cannot be taken, or a record that does not declare itself a
 * PROCESSENTRY32W, throws by name; the walk is PURE over decoded rows, so the chain logic is
 * testable where Windows is not, and the matching check refuses with the chain it actually found.
 */

import { INVALID_HANDLE_VALUE, loadKernel32, type Kernel32 } from "./windows-kernel32.ts"

/** The rows of the walk, structurally the `AncestryRow` the Darwin arm already speaks. */
export interface WindowsProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly comm: string
}

/** PROCESSENTRY32W (tlhelp32.h): where each field sits inside one record. */
export interface ProcessEntry32WLayout {
  /** sizeof(PROCESSENTRY32W) for this pointer width — the value `dwSize` must carry. */
  readonly size: number
  readonly pidOffset: number
  readonly ppidOffset: number
  readonly exeFileOffset: number
  readonly exeFileChars: number
}

const MAX_PATH = 260

/**
 * PROCESSENTRY32W, field by field: DWORD dwSize, DWORD cntUsage, DWORD th32ProcessID, ULONG_PTR
 * th32DefaultHeapID, DWORD th32ModuleID, DWORD cntThreads, DWORD th32ParentProcessID, LONG
 * pcPriClassBase, DWORD dwFlags, WCHAR szExeFile[260].
 *
 * th32DefaultHeapID is POINTER-SIZED, so a 64-bit build forces a 4-byte gap after th32ProcessID and
 * the name array starts at 44; a 32-bit build has no gap and it starts at 36. The record sizes are
 * the documented sizeof per pointer width (568 and 556) — NOT 44+520 and 36+520, because the struct
 * is padded up to its 8-byte alignment on 64-bit.
 */
export function processEntry32WLayout(pointerBytes: number): ProcessEntry32WLayout {
  if (pointerBytes === 8) {
    return { size: 568, pidOffset: 8, ppidOffset: 32, exeFileOffset: 44, exeFileChars: MAX_PATH }
  }
  if (pointerBytes === 4) {
    return { size: 556, pidOffset: 8, ppidOffset: 24, exeFileOffset: 36, exeFileChars: MAX_PATH }
  }
  throw new Error(`PROCESSENTRY32W has no layout for a ${String(pointerBytes)}-byte pointer`)
}

/**
 * Pointer width from the architecture of the RUNNING binary — the ABI the snapshot records are
 * laid out in, never the architecture of the machine. Unknown architectures refuse by name rather
 * than guess a layout, because a wrong `dwSize` is refused by the API and a wrong offset is not.
 */
export function pointerBytesForArch(arch: string): number {
  if (arch === "x64" || arch === "arm64" || arch === "ppc64" || arch === "s390x") return 8
  if (arch === "ia32" || arch === "arm") return 4
  throw new Error(`no PROCESSENTRY32W pointer width for arch ${JSON.stringify(arch)}`)
}

function decodeUtf16Z(bytes: Uint8Array, offset: number, chars: number): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const limit = offset + chars * 2
  let end = offset
  while (end + 2 <= limit && view.getUint16(end, true) !== 0) end += 2
  return new TextDecoder("utf-16le").decode(bytes.subarray(offset, end))
}

/**
 * One filled PROCESSENTRY32W record. Pure, so the field positions are pinned where the kernel32
 * DLL is not — and the record's OWN `dwSize` is checked against the layout, so a record that is not
 * a PROCESSENTRY32W is refused by name instead of being read at the wrong offsets.
 */
export function decodeProcessEntry32W(bytes: Uint8Array, layout: ProcessEntry32WLayout): WindowsProcessRow {
  if (bytes.byteLength < layout.size) {
    throw new Error(
      `PROCESSENTRY32W record is ${String(bytes.byteLength)} bytes, short of the ${String(layout.size)} this layout needs`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const declared = view.getUint32(0, true)
  if (declared !== layout.size) {
    throw new Error(
      `record does not declare itself a PROCESSENTRY32W: dwSize ${String(declared)}, expected ${String(layout.size)}`,
    )
  }
  const pid = view.getUint32(layout.pidOffset, true)
  const ppid = view.getUint32(layout.ppidOffset, true)
  const comm = decodeUtf16Z(bytes, layout.exeFileOffset, layout.exeFileChars)
  // PID 0 is the System Idle Process - a LITERAL row a system-wide table always carries, and not the
  // enumeration's end marker. The only terminator is a FALSE return from Process32NextW, checked at
  // collection, so refusing pid 0 HERE aborted a perfectly good table before the ancestry filter ran
  // (@dev/7 r1 finding 1). The walk's own `pid <= 0` stop is what keeps it from anchoring on Idle.
  return { pid, ppid, comm }
}

/** TH32CS_SNAPPROCESS: the snapshot's process table. */
const TH32CS_SNAPPROCESS = 0x00000002

/** ERROR_NO_MORE_FILES: the ONLY legitimate end of a Process32NextW enumeration. */
const ERROR_NO_MORE_FILES = 18

/**
 * The whole process table, one decoded record at a time. `runtime.arch` is injectable so the layout
 * choice is testable; the default is the running process's own architecture.
 */
export async function readWindowsProcessTable(
  runtime: { arch?: string } = process,
  kernel?: Kernel32,
): Promise<WindowsProcessRow[]> {
  const layout = processEntry32WLayout(pointerBytesForArch(runtime.arch ?? process.arch))
  const { symbols, ptr } = kernel ?? (await loadKernel32())
  const snapshot = symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS as never, 0 as never)
  // A refused snapshot is INVALID_HANDLE_VALUE, never NULL and never zero, and it must be refused
  // HERE: its own Win32 code is read first, and there is nothing to close on a failed handle.
  if (snapshot === INVALID_HANDLE_VALUE) {
    const code = symbols.GetLastError()
    throw new Error(`CreateToolhelp32Snapshot read no process table: error ${String(code)}`)
  }
  try {
    return collectProcessTable({
      layout,
      first: (record) => symbols.Process32FirstW(snapshot as never, ptr(record) as never) !== 0,
      next: (record) => symbols.Process32NextW(snapshot as never, ptr(record) as never) !== 0,
      // Read straight after the failing call: any later FFI call may clobber the last-error slot.
      lastError: () => symbols.GetLastError(),
    })
  } finally {
    symbols.CloseHandle(snapshot as never)
  }
}

/**
 * The enumeration loop, split from the snapshot so the `ERROR_NO_MORE_FILES` rule is provable without
 * Windows. Before @dev/7's r1 finding 2, ANY FALSE from Process32NextW ended the read silently, so a
 * real failure part-way through became an apparently complete table - and ownership could be granted
 * off the rows that had happened to arrive first. `next` FALSE now ends the read for
 * ERROR_NO_MORE_FILES alone; every other code throws by name, because a partial table must never
 * pass as a whole one.
 */
export function collectProcessTable(options: {
  layout: ProcessEntry32WLayout
  first: (record: Buffer) => boolean
  next: (record: Buffer) => boolean
  lastError: () => number
}): WindowsProcessRow[] {
  const { layout, first, next, lastError } = options
  const record = Buffer.alloc(layout.size)
  const rows: WindowsProcessRow[] = []
  record.writeUInt32LE(layout.size, 0)
  if (!first(record)) {
    throw new Error(
      `CreateToolhelp32Snapshot/Process32FirstW read no process from the table: error ${String(lastError())}`,
    )
  }
  for (;;) {
    rows.push(decodeProcessEntry32W(record, layout))
    record.fill(0)
    record.writeUInt32LE(layout.size, 0)
    if (!next(record)) {
      const code = lastError()
      if (code !== ERROR_NO_MORE_FILES) {
        throw new Error(
          `Process32NextW ended the table read with error ${String(code)}, not ERROR_NO_MORE_FILES; the table is partial`,
        )
      }
      break
    }
  }
  return rows
}

/**
 * Walk from `startPid` up the parent links over an already-decoded table. The start process MUST be
 * in the table (a snapshot that cannot see its own reader is a broken snapshot, not a short chain).
 * A MISSING ANCESTOR ends the chain rather than throwing: a parent may exit mid-walk, and the
 * ownership check downstream is the place that refuses a chain that does not reach the receipt's app.
 * A cycle ends the walk too, so a corrupt table cannot loop forever.
 */
export function windowsProcessAncestry(rows: readonly WindowsProcessRow[], startPid: number): WindowsProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const chain: WindowsProcessRow[] = []
  const seen = new Set<number>()
  let pid = startPid
  for (;;) {
    if (pid <= 0 || seen.has(pid)) break
    seen.add(pid)
    const row = byPid.get(pid)
    if (!row) {
      if (chain.length === 0) {
        throw new Error(`the process table does not contain this collector (pid ${String(startPid)})`)
      }
      break
    }
    chain.push(row)
    if (row.ppid === 0 || row.ppid === row.pid) break
    pid = row.ppid
  }
  return chain
}

/** The whole read: this process's own ancestry, from a fresh snapshot. */
export async function readWindowsProcessAncestry(
  startPid: number,
  runtime: { arch?: string } = process,
  kernel?: Kernel32,
): Promise<WindowsProcessRow[]> {
  return windowsProcessAncestry(await readWindowsProcessTable(runtime, kernel), startPid)
}

/** A Windows image name: the receipt's executablePath is a full path, the table's name is a base
 * name, and Windows compares image names without case. */
export function windowsCommBase(comm: string): string {
  const trimmed = comm.trim()
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return (slash === -1 ? trimmed : trimmed.slice(slash + 1)).toLowerCase()
}

/**
 * Grant-time process identity on the hosted Windows route: the receipt's app (WindowsTerminal.exe)
 * must be one of this collector's ancestors. The same shape as the Darwin check, with Windows'
 * case-insensitive base-name matching; there is only one hosted Windows terminal app, so unlike the
 * Darwin arm there is no competing-app set to refuse against.
 */
export function requireHostedWindowsAppAncestor(
  expectedComm: string,
  rows: readonly WindowsProcessRow[],
): WindowsProcessRow {
  const want = windowsCommBase(expectedComm)
  const named = rows.find((row) => windowsCommBase(row.comm) === want)
  if (!named) {
    const found = [...rows]
      .reverse()
      .map((row) => `${row.comm} (pid ${String(row.pid)})`)
      .join(", ")
    throw new Error(`Hosted Windows ancestry never reached ${want}; found ${found}`)
  }
  return named
}
