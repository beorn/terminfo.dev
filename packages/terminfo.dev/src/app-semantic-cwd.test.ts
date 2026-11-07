/**
 * @failure The owned tmux reader loses an empty field, changes a URI body, or
 *   returns a measurement without restoring the public pane_path value.
 * @level l2
 * @consumer readAppSemanticState's approved OSC633 and OSC7 CWD observations.
 * @testonly none
 */
import { closeSync, mkdtempSync, openSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { readAppSemanticState } from "./app-semantic-state.ts"

const { command } = vi.hoisted(() => ({ command: vi.fn() }))
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: command,
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  command.mockReset()
})

async function readCwd(
  initial: string,
  malformed?: string,
  escapeRestore = false,
  osc7?: "working" | "made-up" | "control" | "target" | "unexpected" | "initial-target",
) {
  const runId = "a".repeat(32)
  const directory = mkdtempSync(join(tmpdir(), "terminfo-cwd-"))
  const directoryFd = openSync(directory, "r")
  // The fd alias keeps the Unix socket name below sockaddr_un's path limit.
  const socket = `/proc/self/fd/${directoryFd}/terminfo-${runId}.sock`
  const server = createServer()
  const writes: string[] = []
  const lines = ["", "", ""]
  let cwd = initial
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socket, resolve)
    })
    writeFileSync(join(directory, "mux-socket.txt"), socket)
    vi.stubEnv("TERMINFO_RUN_ID", runId)
    vi.stubEnv("TERMINFO_MUX_KIND", "tmux")
    vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", join(directory, "capture"))
    vi.stubEnv("TMUX_PANE", "%1")
    vi.stubEnv("TMUX", `${socket},41,0`)
    command.mockImplementation((file: string, args: string[]) => {
      expect(file).toBe("tmux")
      expect(args.slice(0, 2)).toEqual(["-S", socket])
      const action = args.slice(2)
      if (action[0] === "display-message") {
        if (action.at(-1)?.startsWith("#{version}")) {
          return `3.8\t41\t%1\t${process.pid}\t${readlinkSync("/proc/self/fd/0")}\t${socket}\n`
        }
        expect(action.at(-1)).toBe("#{pane_command_status}\t#{pane_path}")
        return malformed ?? `0\t${cwd}\n`
      }
      expect(action[0]).toBe("capture-pane")
      return action.includes("-R") ? lines.map((_, i) => `L ${i} (${i}) flags=NONE[0]`).join("\n") : lines.join("\n")
    })
    if (escapeRestore) {
      let time = 0
      vi.spyOn(Date, "now").mockImplementation(() => (time += 2000))
    }
    const reading = await readAppSemanticState({
      featureId: osc7 ? "extensions.osc7-cwd" : "extensions.osc633-p",
      mux: "tmux",
      runId,
      executable: { path: "/unused", sha256: "b".repeat(64) },
      write(text) {
        writes.push(text)
        const position = /^\x1b\[(\d+);1H([\s\S]*)$/.exec(text)
        if (position) lines[Number(position[1]) - 1] = position[2] ?? ""
        if (osc7 === "initial-target") {
          const nonce = /^Q-([0-9a-f]{8})-0$/.exec(position?.[2] ?? "")?.[1]
          if (nonce) cwd = `file://localhost/terminfo-target-${nonce}`
        }
        const madeUp = /\x1b\]77;([^\x07]*)\x07/.exec(text)?.[1]
        if (osc7 === "made-up" && madeUp !== undefined) cwd = madeUp
        const path = /\x1b\]7;([^\x07]*)\x07/.exec(text)?.[1]
        if (path !== undefined) {
          if (osc7 === "control" && path.includes("/terminfo-control-")) return
          if (osc7 === "target" && path.includes("/terminfo-target-")) return
          cwd =
            osc7 === "unexpected" && path.includes("/terminfo-target-")
              ? "file://localhost/unexpected"
              : escapeRestore
                ? path.replaceAll("\\", "\\\\")
                : path
        }
      },
    })
    return { reading, writes }
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    closeSync(directoryFd)
    rmSync(directory, { recursive: true, force: true })
  }
}

test.runIf(process.platform === "linux").each(["", "file://localhost/original"])(
  "preserves the exact public CWD field and restores %j",
  async (initial) => {
    const { reading, writes } = await readCwd(initial)
    expect(reading.status).toBe("measured")
    if (reading.status !== "measured" || reading.reader !== "state") throw new Error("Missing CWD reading")
    expect(reading.handled.before).toBe(initial)
    expect(reading.handled.after).toMatch(/^file:\/\/localhost\/terminfo-control-/)
    expect(reading.handled.expected).toBe(reading.handled.after)
    expect(reading.target.before).toBe(reading.handled.after)
    expect(reading.target.after).toBe(reading.handled.after)
    expect(writes.at(-1)).toBe(`\x1b]7;${initial}\x07`)
    if (!initial) {
      expect(JSON.stringify(reading.detail)).toContain("tmux's pane_path cannot tell an unset path from an empty one")
    }
  },
)

test.runIf(process.platform === "linux").each(["0\n", "0\tpath\textra\n"])(
  "rejects a malformed public state record %j before changing CWD",
  async (malformed) => {
    const { reading, writes } = await readCwd("", malformed)
    expect(reading).toMatchObject({ status: "invalid", reason: expect.stringContaining("tmux state field count") })
    expect(writes.some((text) => text.includes("\x1b]7;"))).toBe(false)
  },
)

test.runIf(process.platform === "linux").each([undefined, "working"] as const)(
  "rejects a public CWD restoration mismatch (%s)",
  async (osc7) => {
    const { reading } = await readCwd("file://localhost/escaped\\path", undefined, true, osc7)
    expect(reading).toMatchObject({ status: "invalid", reason: expect.stringContaining("pane_path restoration") })
  },
)

test.runIf(process.platform === "linux").each(["", "file://localhost/original%2Fkeep%20case"])(
  "OSC7 retains raw URI controls and restores %j exactly",
  async (initial) => {
    const { reading, writes } = await readCwd(initial, undefined, false, "working")
    expect(reading.status).toBe("measured")
    if (reading.status !== "measured" || reading.reader !== "state") throw new Error("Missing OSC7 CWD reading")
    const commands = writes.flatMap((text) => [...text.matchAll(/\x1b\](\d+);([^\x07]*)\x07/g)])
    expect(commands.map((command) => command[1])).toEqual(["77", "7", "7", "7"])
    const [madeUp, control, target, restored] = commands.map((command) => command[2])
    expect(control).toMatch(/^file:\/\/localhost\/terminfo-control-[0-9a-f]{8}$/)
    expect(target).toMatch(/^file:\/\/localhost\/terminfo-target-[0-9a-f]{8}$/)
    expect(madeUp).toBe(target)
    expect(target).not.toBe(control)
    expect(target).not.toBe(initial)
    expect(restored).toBe(initial)
    expect(reading.unknown).toEqual({ before: initial, after: initial })
    expect(reading.handled).toEqual({ before: initial, after: control, expected: control })
    expect(reading.target).toEqual({ before: control, after: target, expected: target })
  },
)

test.runIf(process.platform === "linux").each(["made-up", "control", "target", "unexpected"] as const)(
  "OSC7 retains failed or unexpected %s evidence and restores the initial path",
  async (mode) => {
    const initial = "file://localhost/original"
    const { reading, writes } = await readCwd(initial, undefined, false, mode)
    expect(writes.at(-1)).toBe(`\x1b]7;${initial}\x07`)
    if (mode === "target") {
      expect(reading).toMatchObject({ status: "invalid", reason: expect.stringContaining("OSC7") })
      return
    }
    expect(reading.status).toBe("measured")
    if (reading.status !== "measured" || reading.reader !== "state") throw new Error("Missing OSC7 CWD evidence")
    if (mode === "made-up") expect(reading.unknown.after).not.toBe(reading.unknown.before)
    if (mode === "control") expect(reading.handled.after).not.toBe(reading.handled.expected)
    if (mode === "unexpected") {
      expect(reading.target.after).not.toBe(reading.target.expected)
      expect(reading.target.after).not.toBe(reading.target.before)
    }
  },
)

test.runIf(process.platform === "linux")(
  "OSC7 rejects a target URI already present in the initial reading",
  async () => {
    const { reading } = await readCwd("", undefined, false, "initial-target")
    expect(reading).toMatchObject({ status: "invalid", reason: expect.stringContaining("fresh") })
  },
)
