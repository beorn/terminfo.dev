/**
 * @failure Hosted macOS geometry probes skip, or a PTY bind attributes geometry to the wrong app.
 * @level l1
 * @consumer createOwnedTerminal darwinHosted arm used by collectProbeRun on hosted Mac.
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { afterEach, expect, test } from "vitest"
import {
  createOwnedTerminal,
  hostedDarwinAppFromExecutablePath,
  requireHostedDarwinAppAncestor,
} from "./owned-terminal.ts"

const digest = (seed: string) => createHash("sha256").update(seed).digest("hex")
const directories: string[] = []
afterEach(() => {
  // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; each path is this test's own mkdtemp scratch root
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const ids = {
  captureRunId: "a".repeat(32),
  expectedLaunchRunId: "b".repeat(32),
}

// The app mapping/ancestry tests cannot detect advertising lossy exported text as exact cells.
// Exercise the real owner; only OS reads are fixtures, not its adapter-selection decision.
test.each(["iterm2", "terminal-app"])("hosted %s selects its truthful observation adapter", (app) => {
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const app = ${JSON.stringify(app)}
    const executable = app === "iterm2" ? "/Applications/iTerm.app/Contents/MacOS/iTerm2"
      : "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
    Object.defineProperty(process, "platform", { value: "darwin" })
    const device = { dev: 7n, rdev: 9n, ino: 11n }
    mock.module("node:fs", () => ({ ...fs, fstatSync: () => device, statSync: () => device }))
    mock.module("node:tty", () => ({ ...tty, isatty: () => true }))
    mock.module("node:child_process", () => ({ ...cp,
      execFileSync: (command, args) => {
        assert.equal(command, "/bin/ps")
        const pid = Number(args[args.indexOf("-p") + 1])
        if (args.includes("tty=")) return "ttys004"
        if (!args.includes("pid=")) return "/sbin/launchd"
        return pid === process.pid ? process.pid + " 4242 /bin/zsh"
          : pid === 4242 ? "4242 1 " + executable : "1 0 /sbin/launchd"
      },
      spawn: () => { throw new Error("geometry unavailable in this adapter-selection fixture") }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64), appLaunch: { executablePath: executable } })
    }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" } })
    assert.equal(owner.hostedAppId, app)
    assert.equal(owner.hostedAppPid, 4242)
    assert.equal(typeof owner.readCells, app === "iterm2" ? "undefined" : "function")
    await owner.dispose()
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.status, result.stderr).toBe(0)
})

test("hostedDarwinAppFromExecutablePath maps the hosted apps from the receipt executable", () => {
  expect(
    hostedDarwinAppFromExecutablePath("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
  ).toEqual({
    id: "terminal-app",
    comm: "Terminal",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/iTerm.app/Contents/MacOS/iTerm2")).toEqual({
    id: "iterm2",
    comm: "iTerm2",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/Ghostty.app/Contents/MacOS/ghostty")).toEqual({
    id: "ghostty",
    comm: "ghostty",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/Alacritty.app/Contents/MacOS/alacritty")).toEqual({
    id: "alacritty",
    comm: "alacritty",
  })
  // WezTerm.app's CFBundleExecutable is wezterm-gui (run 39274899363); the CLI binary never appears here.
  expect(hostedDarwinAppFromExecutablePath("/Applications/WezTerm.app/Contents/MacOS/wezterm-gui")).toEqual({
    id: "wezterm",
    comm: "wezterm-gui",
  })
  // 30211: the receipt names the editor GUI, never its CLI or an Electron helper.
  expect(hostedDarwinAppFromExecutablePath("/Applications/Cursor.app/Contents/MacOS/Cursor")).toEqual({
    id: "cursor",
    comm: "Cursor",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/Visual Studio Code.app/Contents/MacOS/Code")).toEqual({
    id: "com.microsoft.VSCode",
    comm: "Code",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/Warp.app/Contents/MacOS/stable")).toEqual({
    id: "warp",
    comm: "stable",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/cmux.app/Contents/MacOS/cmux")).toEqual({
    id: "cmux",
    comm: "cmux",
  })
  for (const path of [
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper",
    "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
    "/Applications/Warp.app/Contents/Resources/bin/warp",
    "/Applications/Warp.app/Contents/Frameworks/stable Helper.app/Contents/MacOS/stable Helper",
    "/Applications/cmux.app/Contents/Resources/bin/cmux",
    "/usr/local/bin/cmux",
    "/Applications/Other.app/Contents/MacOS/cmux",
  ] as const) {
    expect(() => hostedDarwinAppFromExecutablePath(path)).toThrow(/Hosted Darwin receipt executable/)
  }
  expect(() => hostedDarwinAppFromExecutablePath("/usr/bin/script")).toThrow(
    /Hosted Darwin receipt executable is not one of Terminal, iTerm2, ghostty, alacritty, wezterm/,
  )
})

test("requireHostedDarwinAppAncestor accepts the named app and refuses a wrong app or none, by name", () => {
  const named = [
    { pid: 80, ppid: 1, comm: "launchd" },
    { pid: 90, ppid: 80, comm: "iTerm2" },
    { pid: 100, ppid: 90, comm: "zsh" },
    { pid: 110, ppid: 100, comm: "bun" },
  ]
  const measuredOwner = requireHostedDarwinAppAncestor("iTerm2", named)
  expect(measuredOwner).toEqual({ pid: 90, ppid: 80, comm: "iTerm2" })
  expect(measuredOwner.pid).toBe(90)

  const wrong = [
    { pid: 80, ppid: 1, comm: "launchd" },
    { pid: 90, ppid: 80, comm: "ghostty" },
    { pid: 100, ppid: 90, comm: "zsh" },
  ]
  expect(() => requireHostedDarwinAppAncestor("iTerm2", wrong)).toThrow(
    /Hosted Darwin ancestry reached ghostty \(pid 90\) while the receipt names iTerm2/,
  )

  const none = [
    { pid: 80, ppid: 1, comm: "launchd" },
    { pid: 90, ppid: 80, comm: "sshd" },
    { pid: 100, ppid: 90, comm: "zsh" },
  ]
  expect(() => requireHostedDarwinAppAncestor("iTerm2", none)).toThrow(
    /Hosted Darwin ancestry never reached iTerm2; found zsh \(pid 100\), sshd \(pid 90\), launchd \(pid 80\)/,
  )
})

test("requireHostedDarwinAppAncestor binds macOS-style full-path comms and keeps the raw path in refusals", () => {
  const macos = [
    { pid: 1, ppid: 0, comm: "/sbin/launchd" },
    { pid: 80, ppid: 1, comm: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
    { pid: 100, ppid: 80, comm: "/bin/zsh" },
  ]
  expect(requireHostedDarwinAppAncestor("Terminal", macos)).toEqual(macos[1])

  const wrong = [
    { pid: 1, ppid: 0, comm: "/sbin/launchd" },
    { pid: 90, ppid: 1, comm: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
    { pid: 100, ppid: 90, comm: "/bin/zsh" },
  ]
  expect(() => requireHostedDarwinAppAncestor("iTerm2", wrong)).toThrow(
    /Hosted Darwin ancestry reached \/Applications\/Ghostty\.app\/Contents\/MacOS\/ghostty \(pid 90\) while the receipt names iTerm2/,
  )

  const weztermInstead = [
    { pid: 1, ppid: 0, comm: "/sbin/launchd" },
    { pid: 90, ppid: 1, comm: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui" },
    { pid: 100, ppid: 90, comm: "/bin/zsh" },
  ]
  expect(() => requireHostedDarwinAppAncestor("iTerm2", weztermInstead)).toThrow(
    /Hosted Darwin ancestry reached \/Applications\/WezTerm\.app\/Contents\/MacOS\/wezterm-gui \(pid 90\) while the receipt names iTerm2/,
  )

  for (const [comm, path, otherPath] of [
    ["stable", "/Applications/Warp.app/Contents/MacOS/stable", "/Applications/Ghostty.app/Contents/MacOS/ghostty"],
    ["ghostty", "/Applications/Ghostty.app/Contents/MacOS/ghostty", "/Applications/Warp.app/Contents/MacOS/stable"],
    [
      "Cursor",
      "/Applications/Cursor.app/Contents/MacOS/Cursor",
      "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    ],
    [
      "Code",
      "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
      "/Applications/Cursor.app/Contents/MacOS/Cursor",
    ],
  ] as const) {
    const editor = [
      { pid: 1, ppid: 0, comm: "/sbin/launchd" },
      { pid: 90, ppid: 1, comm: path },
      { pid: 100, ppid: 90, comm: "/bin/zsh" },
    ]
    expect(requireHostedDarwinAppAncestor(comm, editor)).toEqual(editor[1])
    expect(() => requireHostedDarwinAppAncestor(comm, [...editor, { pid: 110, ppid: 100, comm: otherPath }])).toThrow(
      `Hosted Darwin ancestry reached ${otherPath} (pid 110) while the receipt names ${comm}`,
    )
    expect(() => requireHostedDarwinAppAncestor(comm, [{ pid: 90, ppid: 1, comm: `${comm} Helper` }])).toThrow(
      `Hosted Darwin ancestry never reached ${comm}`,
    )
  }
})

test("hosted ancestry selects the outer app in the measured inner-to-outer chain without changing it", () => {
  // The retained Warp run had this same-executable pair; the inner PID owned no CG window.
  const rows = [
    { pid: 13352, ppid: 13338, comm: "/Applications/Warp.app/Contents/MacOS/stable" },
    { pid: 13338, ppid: 1, comm: "/Applications/Warp.app/Contents/MacOS/stable" },
    { pid: 1, ppid: 0, comm: "/sbin/launchd" },
  ]
  const before = rows.map((row) => ({ ...row }))
  Object.freeze(rows)
  expect(requireHostedDarwinAppAncestor("stable", rows)).toBe(rows[1])
  expect(rows).toEqual(before)
})

test("cmux ancestry binds the receipt GUI path despite a same-basename CLI", () => {
  const executable = "/Applications/cmux.app/Contents/MacOS/cmux"
  const gui = { pid: 90, ppid: 1, comm: executable }
  const cli = { pid: 100, ppid: 90, comm: "/Applications/cmux.app/Contents/Resources/bin/cmux" }
  expect(requireHostedDarwinAppAncestor("cmux", [cli, gui], executable)).toEqual(gui)
  const paddedGui = { ...gui, comm: `  ${executable}  ` }
  expect(requireHostedDarwinAppAncestor("cmux", [cli, paddedGui], executable)).toEqual(paddedGui)

  for (const rows of [
    [cli],
    [{ ...gui, comm: "cmux" }],
    [{ ...gui, comm: "/usr/local/bin/cmux" }],
    [{ ...gui, comm: "/Applications/Other.app/Contents/MacOS/cmux" }],
  ]) {
    expect(() => requireHostedDarwinAppAncestor("cmux", rows, executable)).toThrow(/Hosted Darwin/)
  }
  expect(() => requireHostedDarwinAppAncestor("cmux", [gui, cli])).toThrow(/Hosted Darwin/)
  const standalone = { ...gui, comm: "/usr/local/bin/cmux" }
  expect(() => requireHostedDarwinAppAncestor("cmux", [standalone], standalone.comm)).toThrow(/Hosted Darwin/)
  const iterm = { pid: 80, ppid: 1, comm: "iTerm2" }
  expect(requireHostedDarwinAppAncestor("iTerm2", [cli, iterm])).toEqual(iterm)
  expect(() =>
    requireHostedDarwinAppAncestor(
      "cmux",
      [gui, { pid: 110, ppid: 100, comm: "/Applications/Ghostty.app/Contents/MacOS/ghostty" }],
      executable,
    ),
  ).toThrow(/Hosted Darwin ancestry reached.*ghostty/)
})

test("darwinHosted is a third XOR arm: linux plus darwinHosted is refused", async () => {
  await expect(
    createOwnedTerminal({
      ...ids,
      out: process.stdout,
      linux: { receiptPath: "/tmp/missing-linux.json", executable: { path: process.execPath, sha256: digest("x") } },
      darwinHosted: { receiptPath: "/tmp/missing-darwin.json" },
    }),
  ).rejects.toThrow(/Owned terminal requires exactly one platform receipt/)
})

test("darwinHosted alone on Linux refuses by platform, not as a missing arm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-hosted-darwin-"))
  directories.push(dir)
  const receiptPath = join(dir, "host-measured.json")
  writeFileSync(receiptPath, "{}")
  await expect(
    createOwnedTerminal({
      ...ids,
      out: process.stdout,
      darwinHosted: { receiptPath },
    }),
  ).rejects.toThrow(/Owned Darwin hosted terminal requires Darwin/)
})
