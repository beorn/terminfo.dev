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
  for (const path of [
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper",
    "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
    "/Applications/Warp.app/Contents/Resources/bin/warp",
    "/Applications/Warp.app/Contents/Frameworks/stable Helper.app/Contents/MacOS/stable Helper",
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
