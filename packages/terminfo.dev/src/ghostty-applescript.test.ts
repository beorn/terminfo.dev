/**
 * @failure The Ghostty AppleScript reader puts producer text into script source, reads a terminal other than the
 *   owned TTY's, hides an osascript failure, or reads `working directory` before the phase's writes reached it.
 * @level l1
 * @consumer owned-terminal's Darwin Ghostty cwd reader for extensions.osc7-cwd and extensions.osc633-p (34601).
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { ghosttyOwnedCwd, readGhosttyTerminal } from "./ghostty-applescript.ts"

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: spawn,
}))

afterEach(() => {
  vi.restoreAllMocks()
  spawn.mockReset()
})

const tty = "/dev/ttys004"
const ok = (stdout: string) => ({ status: 0, signal: null, stdout, stderr: "" })

test("the owned TTY travels as an osascript argument and the script is constant", () => {
  spawn.mockReturnValue(ok("/terminfo-control-1a2b3c4d\n"))
  expect(readGhosttyTerminal(tty, "working directory")).toBe("/terminfo-control-1a2b3c4d")
  const [file, args] = spawn.mock.calls[0]!
  expect(file).toBe("/usr/bin/osascript")
  expect(args).toHaveLength(3)
  expect(args[0]).toBe("-e")
  expect(args[2]).toBe(tty)
  const script = args[1] as string
  expect(script).toContain('tell application id "com.mitchellh.ghostty"')
  expect(script).toContain("every terminal whose tty is ttyPath")
  expect(script).toContain("return working directory of item 1 of matches")
  expect(script).not.toContain(tty)
})

test("only one trailing newline is osascript's; the rest of the value is kept", () => {
  spawn.mockReturnValue(ok("/path with trailing newline\n\n"))
  expect(readGhosttyTerminal(tty, "working directory")).toBe("/path with trailing newline\n")
  spawn.mockReturnValue(ok("\n"))
  expect(readGhosttyTerminal(tty, "working directory")).toBe("")
})

test.each([
  {
    result: {
      status: 1,
      signal: null,
      stdout: "",
      stderr: "execution error: owned TTY /dev/ttys004 matches 2 Ghostty terminals (-2700)\n",
    },
    message: /Ghostty AppleScript working directory read failed: .*matches 2 Ghostty terminals/,
  },
  { result: { status: null, signal: "SIGKILL", stdout: "", stderr: "" }, message: /read failed: .*SIGKILL/ },
  {
    result: { status: 0, signal: null, stdout: "no newline", stderr: "" },
    message: /did not end its reply with a newline/,
  },
])("an osascript failure is thrown, never read as a value: $message", ({ result, message }) => {
  spawn.mockReturnValue(result)
  expect(() => readGhosttyTerminal(tty, "working directory")).toThrow(message)
})

test("a TTY that is not a device path is refused before osascript runs", () => {
  expect(() => readGhosttyTerminal('/dev/ttys004" & quit', "name")).toThrow(/not an owned TTY device path/)
  expect(spawn).not.toHaveBeenCalled()
})

test("a checkpoint read waits for its title fence before reading the cwd", async () => {
  const writes: string[] = []
  let title = "before"
  let cwd = "/terminfo-control-1a2b3c4d"
  let nameReads = 0
  spawn.mockImplementation((_file: string, args: string[]) => {
    const script = args[1]!
    if (script.includes("return name of")) {
      nameReads += 1
      // Ghostty applies a title change after a short timer; the first poll still sees the old title.
      return ok(`${nameReads === 1 ? "before" : title}\n`)
    }
    return ok(`${cwd}\n`)
  })
  let checks = 0
  const read = ghosttyOwnedCwd({
    tty,
    write(text) {
      writes.push(text)
      const fence = /^\x1b\]2;([^\x07]*)\x07$/.exec(text)?.[1]
      if (fence !== undefined) title = fence
    },
    check() {
      checks += 1
    },
  })
  expect(await read()).toEqual({ path: cwd, detail: { tty, reads: [{ property: "working directory", value: cwd }] } })
  expect(writes).toEqual([])
  cwd = "/terminfo-target-1a2b3c4d"
  const reading = await read({ row: 3, marker: "Q-1a2b3c4d-2" })
  expect(writes).toEqual(["\x1b]2;Q-1a2b3c4d-2\x07"])
  expect(nameReads).toBe(2)
  expect(reading).toEqual({
    path: "/terminfo-target-1a2b3c4d",
    detail: {
      tty,
      reads: [
        { property: "name", value: "before" },
        { property: "name", value: "Q-1a2b3c4d-2" },
        { property: "working directory", value: "/terminfo-target-1a2b3c4d" },
      ],
    },
  })
  expect(checks).toBe(4)
})

test("a title fence that never lands fails the read instead of reading a stale cwd", async () => {
  spawn.mockImplementation((_file: string, args: string[]) =>
    ok(args[1]!.includes("return name of") ? "stale\n" : "/terminfo-control-1a2b3c4d\n"),
  )
  let time = 0
  vi.spyOn(Date, "now").mockImplementation(() => (time += 2000))
  const read = ghosttyOwnedCwd({ tty, write() {}, check: () => {} })
  await expect(read({ row: 1, marker: "Q-1a2b3c4d-0" })).rejects.toThrow(/did not observe Ghostty title fence/)
  expect(spawn.mock.calls.some(([, args]) => !(args[1] as string).includes("return name of"))).toBe(false)
})
