/**
 * @failure A WezTerm history read answers from another instance's pane, assumes a pane number, keeps a
 *   reading whose pane TTY is not the owned process's, or reports a count with no CLI version behind it.
 * @level l1
 * @consumer OwnedTerminal's WezTerm history arm on macOS and Linux (31741).
 * @testonly none
 */
import { beforeEach, expect, test, vi } from "vitest"

const child = vi.hoisted(() => ({ spawnSync: vi.fn() }))
const files = vi.hoisted(() => ({ readFileSync: vi.fn() }))
vi.mock("node:child_process", () => ({ spawnSync: child.spawnSync }))
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: files.readFileSync,
}))
import {
  ownedWezTermExecutableProof,
  ownedWezTermHistoryExecutable,
  readOwnedWezTermHistory,
} from "./wezterm-owned-history.ts"

const executable = "/Applications/WezTerm.app/Contents/MacOS/wezterm"
const socket = "/private/tmp/term-31741/wezterm.sock"
const pane = "17"

// The pane list is read with `encoding: "utf8"`, so its mock answers strings; get-text keeps Buffers.
const panes = (rows: unknown) => ({ status: 0, stdout: JSON.stringify(rows), stderr: "" })

beforeEach(() => {
  child.spawnSync.mockReset()
  files.readFileSync.mockReset()
})

test("only an owned pane on Linux or macOS has a history CLI", () => {
  expect(ownedWezTermHistoryExecutable({ platform: "darwin", ownsWezTermPane: false, environment: {} })).toBeUndefined()
  expect(ownedWezTermHistoryExecutable({ platform: "win32", ownsWezTermPane: true, environment: {} })).toBeUndefined()
  expect(ownedWezTermHistoryExecutable({ platform: "linux", ownsWezTermPane: true })).toBeUndefined()
  expect(
    ownedWezTermHistoryExecutable({
      platform: "linux",
      ownsWezTermPane: true,
      linuxExecutablePath: "/nix/store/owned-wezterm/bin/wezterm-gui",
    }),
  ).toBe("/nix/store/owned-wezterm/bin/wezterm")
})

test("macOS takes the child's absolute CLI, and never a relative or empty declaration", () => {
  expect(
    ownedWezTermHistoryExecutable({
      platform: "darwin",
      ownsWezTermPane: true,
      environment: { WEZTERM_EXECUTABLE: "/opt/wezterm/bin/wezterm" },
    }),
  ).toBe("/opt/wezterm/bin/wezterm")
  for (const declared of [undefined, "", "   ", "bin/wezterm"]) {
    expect(
      ownedWezTermHistoryExecutable({
        platform: "darwin",
        ownsWezTermPane: true,
        environment: declared === undefined ? {} : { WEZTERM_EXECUTABLE: declared },
      }),
    ).toBe("/Applications/WezTerm.app/Contents/MacOS/wezterm")
  }
})

test("the evidence pins the CLI's bytes and the version the app itself reports", () => {
  files.readFileSync.mockReturnValue(Buffer.from("owned wezterm cli"))
  child.spawnSync.mockReturnValue({ status: 0, stdout: "wezterm 20240203-110809-5046fc22\n", stderr: "" })
  const proof = ownedWezTermExecutableProof(executable)
  expect(proof).toEqual({
    status: "measured",
    proof: {
      path: executable,
      sha256: "5ab1a04f888a42aed016b60544dbe646f2d5b9166f30792c16aef72fa023bbc8",
      version: "wezterm 20240203-110809-5046fc22",
    },
  })
  expect(child.spawnSync.mock.calls[0]).toEqual([executable, ["--version"], { encoding: "utf8", timeout: 5000 }])
})

test("an unreadable or versionless CLI is a named refusal, never a silent omission", () => {
  files.readFileSync.mockImplementation(() => {
    throw new Error("ENOENT: no such file")
  })
  expect(ownedWezTermExecutableProof(executable)).toEqual({
    status: "unmeasured",
    reason: expect.stringContaining("ENOENT"),
  })
  files.readFileSync.mockReturnValue(Buffer.from("owned wezterm cli"))
  child.spawnSync.mockReturnValue({ status: 2, stdout: "", stderr: "unknown flag" })
  expect(ownedWezTermExecutableProof(executable)).toEqual({
    status: "unmeasured",
    reason: expect.stringContaining("reported no version"),
  })
})

test("a read without this run's socket or a numeric pane never spawns the CLI", () => {
  for (const options of [
    { executable, socket: undefined, pane, rows: 24 },
    { executable, socket: "  ", pane, rows: 24 },
    { executable, socket, pane: undefined, rows: 24 },
    { executable, socket, pane: "0", rows: 24 },
    { executable, socket, pane: "all", rows: 24 },
  ]) {
    expect(readOwnedWezTermHistory(options)).toEqual({
      status: "refused",
      reason: "WezTerm owned history requires this run's WEZTERM_UNIX_SOCKET and numeric WEZTERM_PANE",
    })
  }
  expect(child.spawnSync).not.toHaveBeenCalled()
})

test("a pane missing from this run's own socket list is refused by name", () => {
  child.spawnSync.mockReturnValue(panes([{ pane_id: 3, tty_name: "/dev/ttys003" }]))
  const read = readOwnedWezTermHistory({ executable, socket, pane, tty: "/dev/ttys004", rows: 24 })
  expect(read.status).toBe("refused")
  expect(read.status === "refused" && read.reason).toMatch(/pane 17 is not in this run's socket pane list \[3\]/)
  expect(child.spawnSync).toHaveBeenCalledTimes(1)
})

test("a listed list that is not a JSON pane array is refused, keeping the command's bytes", () => {
  child.spawnSync.mockReturnValue({
    status: 0,
    stdout: "pane_id tty_name\n17 /dev/ttys004\n",
    stderr: "",
  })
  const read = readOwnedWezTermHistory({ executable, socket, pane, rows: 24 })
  expect(read.status === "refused" && read.reason).toMatch(/pane list is not JSON/)
  expect(read.status === "refused" && read.reason).toContain("pane_id tty_name")
})

test("a pane whose TTY is not the owned process's is refused, not read", () => {
  child.spawnSync.mockReturnValue(panes([{ pane_id: 17, tty_name: "/dev/ttys009" }]))
  const read = readOwnedWezTermHistory({ executable, socket, pane, tty: "/dev/ttys004", rows: 24 })
  expect(read.status === "refused" ? read.reason : "").toMatch(
    /lists TTY "\/dev\/ttys009", not this run's measured "\/dev\/ttys004"/,
  )
  expect(child.spawnSync).toHaveBeenCalledTimes(1)
})

test("the owned pane reads its history through --pane-id on this run's socket", () => {
  child.spawnSync.mockImplementation(
    (file: string, args: readonly string[], options: { env: Record<string, string> }) => {
      expect(file).toBe(executable)
      expect(options.env.WEZTERM_UNIX_SOCKET).toBe(socket)
      expect(options.env.WEZTERM_PANE).toBe(pane)
      if (args.includes("list")) return panes([{ pane_id: 17, tty_name: "/dev/ttys004" }])
      return { status: 0, stdout: Buffer.from("old\n\n" + "row\n".repeat(24)), stderr: Buffer.alloc(0) }
    },
  )
  const read = readOwnedWezTermHistory({ executable, socket, pane, tty: "ttys004", rows: 24 })
  expect(read.status).toBe("read")
  expect(read.status === "read" && { totalLines: read.totalLines, screenLines: read.screenLines }).toEqual({
    totalLines: 26,
    screenLines: 24,
  })
  expect(child.spawnSync.mock.calls[0]!.slice(0, 2)).toEqual([
    executable,
    ["cli", "--no-auto-start", "list", "--format", "json"],
  ])
  expect(child.spawnSync.mock.calls[1]!.slice(0, 2)).toEqual([
    executable,
    ["cli", "--no-auto-start", "get-text", "--pane-id", "17", "--start-line", "-2147483648", "--end-line", "23"],
  ])
})

test("a failed get-text keeps the command's bytes in the refusal", () => {
  child.spawnSync.mockImplementation((_file: string, args: readonly string[]) =>
    args.includes("list")
      ? panes([{ pane_id: 17, tty_name: "/dev/ttys004" }])
      : { status: 2, stdout: Buffer.from("partial"), stderr: Buffer.from("owned WezTerm fixture refusal") },
  )
  const read = readOwnedWezTermHistory({ executable, socket, pane, tty: "/dev/ttys004", rows: 24 })
  expect(read.status === "refused" && read.reason).toMatch(/WezTerm owned get-text unavailable/)
  expect(read.status === "refused" && read.reason).toContain(Buffer.from("partial").toString("base64"))
})
