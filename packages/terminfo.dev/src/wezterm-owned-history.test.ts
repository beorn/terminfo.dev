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
  hostedWezTermOwnerProof,
  hostedWezTermPrerequisites,
  ownedWezTermExecutableProof,
  ownedWezTermHistoryExecutable,
  readOwnedWezTermHistory,
  socketHeldByPid,
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

// @dev/18 peer read: WEZTERM_EXECUTABLE is the GUI binary on macOS, and wezterm-gui has no `cli`
// subcommand, so a read through it would refuse on every pane. The CLI sits beside it.
test("macOS resolves the sibling CLI when the declaration names the GUI binary", () => {
  expect(
    ownedWezTermHistoryExecutable({
      platform: "darwin",
      ownsWezTermPane: true,
      environment: { WEZTERM_EXECUTABLE: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui" },
    }),
  ).toBe("/Applications/WezTerm.app/Contents/MacOS/wezterm")
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
    { executable, socket, pane: "all", rows: 24 },
  ]) {
    expect(readOwnedWezTermHistory(options)).toEqual({
      status: "refused",
      reason: "WezTerm owned history requires this run's WEZTERM_UNIX_SOCKET and numeric WEZTERM_PANE",
    })
  }
  expect(child.spawnSync).not.toHaveBeenCalled()
})

// WezTerm numbers panes from 0 and 0 is the single-window case (measured on codimac 2026-11-12: the read
// of `--pane-id 0` returned the run's own marker block). The old refusal of 0 refused the ordinary run.
test("pane 0 is a pane like any other and reads through --pane-id 0", () => {
  child.spawnSync.mockImplementation((_file: string, args: readonly string[]) => {
    if (args.includes("list")) return panes([{ pane_id: 0, tty_name: "/dev/ttys002" }])
    return { status: 0, stdout: Buffer.from("a\n\n" + "row\n".repeat(24)), stderr: Buffer.alloc(0) }
  })
  const read = readOwnedWezTermHistory({ executable, socket, pane: "0", tty: "ttys002", rows: 24 })
  expect(read.status).toBe("read")
  expect(child.spawnSync.mock.calls[1]!.slice(0, 2)).toEqual([
    executable,
    ["cli", "--no-auto-start", "get-text", "--pane-id", "0", "--start-line", "-2147483648", "--end-line", "23"],
  ])
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
  // A listed pane that is not this run's tty is no reading on this host, said in those words (@cto 41fcd747).
  expect(read.status === "refused" ? read.reason : "").toContain("the owned read method is unavailable here")
  expect(child.spawnSync).toHaveBeenCalledTimes(1)
})

/**
 * @failure The receipt that reaches a published artifact carries the run's socket path, the host executable
 *   path, or the pane's own transcript, so a corpus record leaks what the operator objected to (@cto 41fcd747).
 * @level l1
 * @consumer Every erase and scrollback reading taken through this owned reader.
 * @testonly none
 */
test("the recorded receipt names the pane, both ttys and the socket's presence, and carries no path", () => {
  child.spawnSync.mockImplementation((_file: string, args: readonly string[]) =>
    args.includes("list")
      ? panes([{ pane_id: 17, tty_name: "/dev/ttys004" }])
      : { status: 0, stdout: Buffer.from("old\n\n" + "row\n".repeat(24)), stderr: Buffer.alloc(0) },
  )
  const read = readOwnedWezTermHistory({ executable, socket, pane, tty: "/dev/ttys004", rows: 24 })
  if (read.status !== "read") throw new Error(read.reason)
  expect(JSON.parse(read.receipt)).toEqual({
    surface: "wezterm",
    pane: "17",
    listedTty: "ttys004",
    measuredTty: "ttys004",
    ttyMatch: true,
    socketPresent: true,
    executable: "wezterm",
  })
  expect(read.receipt).not.toMatch(/[\\/]/u)
  // The get-text transcript is a refusal diagnostic, never part of the identity record.
  expect(read.receipt).not.toContain(Buffer.from("row").toString("base64"))
  expect(read.receipt).not.toContain(Buffer.from("old").toString("base64"))

  // A host that measured no tty cannot claim a match; the listed tty is still named.
  child.spawnSync.mockReset()
  child.spawnSync.mockImplementation((_file: string, args: readonly string[]) =>
    args.includes("list")
      ? panes([{ pane_id: 17, tty_name: "/dev/ttys004" }])
      : { status: 0, stdout: Buffer.from("old\n\n" + "row\n".repeat(24)), stderr: Buffer.alloc(0) },
  )
  const unmeasured = readOwnedWezTermHistory({ executable, socket, pane, rows: 24 })
  if (unmeasured.status !== "read") throw new Error(unmeasured.reason)
  expect(JSON.parse(unmeasured.receipt)).toMatchObject({ listedTty: "ttys004", measuredTty: null, ttyMatch: null })
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

// 8c084f05: the hosted Darwin arm may only attempt an owned read when the pane published a socket, a pane id,
// and a measured tty. Each absence is named, so the history row says which one is missing instead of falling
// back to the screenshot path — and none of the three is a declaration about the app.
test.each([
  [
    { socketPresent: false, paneIdPresent: true, measuredTty: "/dev/ttys004" },
    "hosted WezTerm pane published no socket",
  ],
  [
    { socketPresent: true, paneIdPresent: false, measuredTty: "/dev/ttys004" },
    "hosted WezTerm pane published no pane id",
  ],
  [
    { socketPresent: true, paneIdPresent: true, measuredTty: undefined },
    "hosted WezTerm pane has no measured tty to match",
  ],
  [{ socketPresent: true, paneIdPresent: true, measuredTty: "  " }, "hosted WezTerm pane has no measured tty to match"],
  [{ socketPresent: true, paneIdPresent: true, measuredTty: "/dev/ttys004" }, undefined],
])("hosted WezTerm prerequisites: %j names %s", (input, expected) => {
  expect(hostedWezTermPrerequisites(input)).toBe(expected)
})

// Condition 2, re-checked before every read: the socket must be one the measured app process itself holds.
test("a socket the measured app process holds passes", () => {
  child.spawnSync.mockReturnValue({
    status: 0,
    stdout: `p2623\nf12\nn/private/tmp/term/other.sock\nn${socket}\n`,
    stderr: "",
  })
  const held = socketHeldByPid({ socketPath: socket, pid: 2623, executable: "/usr/sbin/lsof" })
  expect(held).toEqual({ status: "held" })
  expect(child.spawnSync.mock.calls.at(-1)!.slice(0, 2)).toEqual(["/usr/sbin/lsof", ["-a", "-U", "-p", "2623", "-Fn"]])
})

// The reason is published with the row, so it stays value-free and stable: no socket path, no pid
// (@cto, a1473808 REVISE 1).
test("a socket another process holds refuses by name, without publishing any path", () => {
  child.spawnSync.mockReturnValue({ status: 0, stdout: "p900\nn/private/tmp/term/other.sock\n", stderr: "" })
  const held = socketHeldByPid({ socketPath: socket, pid: 2623 })
  expect(held).toEqual({
    status: "refused",
    reason: "WezTerm socket is not held by the measured app process (1 unix sockets held)",
  })
  expect(held.status === "refused" && held.reason).not.toContain("/private/tmp")
})

test("a pid that holds no unix socket refuses rather than passing on an empty list", () => {
  child.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" })
  const held = socketHeldByPid({ socketPath: socket, pid: 2623 })
  expect(held).toEqual({
    status: "refused",
    reason: "WezTerm socket is not held by the measured app process (0 unix sockets held)",
  })
})

test("an unreadable lsof refuses value-free and puts the command's own evidence on stderr", () => {
  child.spawnSync.mockReturnValue({ status: 2, stdout: null, stderr: "lsof: permission denied" })
  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "))
  }
  let held: ReturnType<typeof socketHeldByPid>
  try {
    held = socketHeldByPid({ socketPath: socket, pid: 2623 })
  } finally {
    console.error = originalError
  }
  expect(held).toEqual({ status: "refused", reason: "WezTerm socket ownership could not be read (exit 2)" })
  expect(held.status === "refused" && held.reason).not.toContain("permission denied")
  expect(errors.join("\n")).toContain("lsof: permission denied")
})

// Condition 1, re-read at call time: an ancestor that is present but a different process is refused by
// pid, before the socket or tty proof and so before any read (@cto, a1473808 REVISE 2).
test("an ancestor that is a different pid than measured at grant refuses by name, and no proof runs after it", () => {
  const heldCalls: string[] = []
  const proof = hostedWezTermOwnerProof({
    readAncestorPid: () => 5555,
    measuredPid: 2623,
    socket,
    heldSockets: (socketPath, pid) => {
      heldCalls.push(`${socketPath} ${pid}`)
      return { status: "held" }
    },
    measuredTty: "ttys004",
  })
  expect(proof).toEqual({
    status: "refused",
    reason: "Hosted WezTerm ancestor is now pid 5555, not pid 2623 measured at grant",
  })
  expect(heldCalls).toEqual([])
})

test("a grant that measured no ancestor pid refuses by name instead of matching any live app", () => {
  expect(
    hostedWezTermOwnerProof({
      readAncestorPid: () => 5555,
      measuredPid: undefined,
      socket,
      heldSockets: () => ({ status: "held" }),
      measuredTty: "ttys004",
    }),
  ).toEqual({
    status: "refused",
    reason: "Hosted WezTerm ancestor is now pid 5555, not pid none measured at grant",
  })
})

test("the three proofs pass only with the same pid, a socket that pid holds, and a measured tty", () => {
  const input = {
    readAncestorPid: () => 2623,
    measuredPid: 2623,
    socket,
    measuredTty: "ttys004",
  }
  expect(hostedWezTermOwnerProof({ ...input, heldSockets: () => ({ status: "held" }) })).toEqual({ status: "proved" })
  expect(hostedWezTermOwnerProof({ ...input, socket: "  ", heldSockets: () => ({ status: "held" }) })).toEqual({
    status: "refused",
    reason: "hosted WezTerm pane published no socket",
  })
  expect(
    hostedWezTermOwnerProof({
      ...input,
      heldSockets: () => ({
        status: "refused",
        reason: "WezTerm socket is not held by the measured app process (0 unix sockets held)",
      }),
    }),
  ).toEqual({
    status: "refused",
    reason: "WezTerm socket is not held by the measured app process (0 unix sockets held)",
  })
  expect(
    hostedWezTermOwnerProof({ ...input, measuredTty: undefined, heldSockets: () => ({ status: "held" }) }),
  ).toEqual({
    status: "refused",
    reason: "hosted WezTerm pane has no measured tty to match",
  })
})
