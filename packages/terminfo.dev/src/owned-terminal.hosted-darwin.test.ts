/**
 * @failure Hosted macOS geometry probes skip, a PTY bind attributes geometry to the wrong app,
 *   or a failed iTerm or Terminal.app qualification read loses its original diagnostic inputs.
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
  formatHostedDarwinAncestry,
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

// The app mapping/ancestry tests cannot see which read the real owner selects for a hosted app.
// Exercise the real owner; only OS reads are fixtures, not its adapter-selection decision.
test.each(["iterm2", "terminal-app"])("hosted %s selects its own text read", (app) => {
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
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
      spawn: (file) => {
        if (String(file).endsWith("pbpaste") || String(file).endsWith("pbcopy") || String(file).endsWith("osascript")) {
          const child = new EventEmitter()
          child.stdout = new EventEmitter()
          child.stderr = new EventEmitter()
          child.kill = () => true
          child.stdin = { end() { queueMicrotask(() => { child.stdout.emit("data", Buffer.from("\\n")); child.emit("close", 0) }) } }
          return child
        }
        throw new Error("geometry unavailable in this adapter-selection fixture")
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({
      ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64), appLaunch: { executablePath: executable } })
    }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" } })
    assert.equal(owner.hostedAppId, app)
    assert.equal(owner.appPid, 4242)
    assert.equal(typeof owner.readCells, "function")
    assert.equal(owner.textRecipe, app === "iterm2" ? "iterm2-api-text-cells-v1" : "macos-text-cells-v1")
    await owner.dispose()
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.status, result.stderr).toBe(0)
})

// The native API's contents are a supplied input here, not a claim about the missing hosted bytes.
// Exercise the real reader and retention owner: removing retention must fail without changing refusal.
test("retains native iTerm protocol frames with their checkpoint and unchanged refusal", () => {
  const directory = mkdtempSync(join(tmpdir(), "iterm-failed-inputs-"))
  directories.push(directory)
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    import { runInNewContext } from "node:vm"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    const directory = ${JSON.stringify(directory)}
    process.env.TERMINFO_CAPTURE_DIRECTORY = directory
    Object.defineProperty(process, "platform", { value: "darwin" })
    const device = { dev: 7n, rdev: 9n, ino: 11n }
    mock.module("node:fs", () => ({ ...fs, fstatSync: () => device, statSync: () => device,
      openSync: (path, ...args) => path === "/dev/fd/1" ? 900 : fs.openSync(path, ...args),
      closeSync: (fd) => fd === 900 ? undefined : fs.closeSync(fd) }))
    mock.module("node:tty", () => ({ ...tty, isatty: () => true }))
    const contents = "W".repeat(80) + "XY" + "\\n".repeat(24)
    const nativeReplies = []
    mock.module("./packages/terminfo.dev/src/iterm2-protocol.ts", () => ({
      readITermCells: async ({ tty, cols, rows, onReply }) => {
        assert.equal(tty, "/dev/ttys004"); assert.equal(cols, 80); assert.equal(rows, 25)
        const bytes = Buffer.from("native server frame " + nativeReplies.length)
        nativeReplies.push(bytes); onReply(bytes)
        return { status: "refused", reason: "interior uninitialized cell" }
      }
    }))
    mock.module("node:child_process", () => ({ ...cp,
      execFileSync: (command, args) => {
        assert.equal(command, "/bin/ps")
        const pid = Number(args[args.indexOf("-p") + 1])
        if (args.includes("tty=")) return "ttys004"
        if (!args.includes("pid=")) return "/sbin/launchd"
        return pid === process.pid ? process.pid + " 4242 /bin/zsh"
          : pid === 4242 ? "4242 1 /Applications/iTerm.app/Contents/MacOS/iTerm2" : "1 0 /sbin/launchd"
      },
      spawnSync: (command, args) => {
        throw new Error("The physical iTerm arm must not use logical JXA contents")
      },
      spawn: (file) => {
        if (String(file).endsWith("pbpaste") || String(file).endsWith("pbcopy") || String(file).endsWith("osascript")) {
          const child = new EventEmitter()
          child.stdout = new EventEmitter()
          child.stderr = new EventEmitter()
          child.kill = () => true
          child.stdin = { end() { queueMicrotask(() => { child.stdout.emit("data", Buffer.from("\\n")); child.emit("close", 0) }) } }
          return child
        }
        const child = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
        queueMicrotask(() => { child.stdout.emit("data", Buffer.from("25 80\\n")); child.emit("close", 0) })
        return child
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({ ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64),
        appLaunch: { executablePath: "/Applications/iTerm.app/Contents/MacOS/iTerm2" } }) }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const retained = []
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" }, onRetained: (artifact) => retained.push(artifact) })
    const labels = ["text qualification soft-wrap target", "text qualification prior-scrollback control"]
    try {
      for (const label of [...labels, "another checkpoint"]) {
        assert.deepEqual(await owner.readCells({ label, directory, onRetained: (artifact) => retained.push(artifact) }),
          { status: "refused", reason: "interior uninitialized cell" })
      }
      const envelopes = retained.filter(artifact => artifact.path.endsWith(".json"))
      const frames = retained.filter(artifact => artifact.path.endsWith(".bin"))
      assert.equal(envelopes.length, 3); assert.equal(frames.length, 3)
      for (const [index, artifact] of envelopes.entries()) {
        const bytes = fs.readFileSync(artifact.path)
        const envelope = JSON.parse(bytes.toString("utf8"))
        assert.equal(envelope.captureRunId, "a".repeat(32))
        assert.equal(envelope.checkpoint, [...labels, "another checkpoint"][index])
        assert.equal(envelope.tty, "/dev/ttys004")
        assert.deepEqual(envelope.grid, { rows: 25, cols: 80 })
        assert.equal(envelope.reply, "sha256:" + frames[index].sha256)
        assert.deepEqual(fs.readFileSync(frames[index].path), nativeReplies[index])
        assert.equal((await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"), artifact.sha256)
      }
    } finally { await owner.dispose() }
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.status, result.stderr).toBe(0)
})

// 33512: Terminal.app's refused read is retained the way iTerm's frames are: the osascript reply
// that carries the returned lines and their lengths, keyed to its checkpoint. Removing retention
// must fail without changing the refusal.
test("retains Terminal.app's refused text reply with its checkpoint and unchanged refusal", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-app-failed-inputs-"))
  directories.push(directory)
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    import { runInNewContext } from "node:vm"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    const directory = ${JSON.stringify(directory)}
    process.env.TERMINFO_CAPTURE_DIRECTORY = directory
    Object.defineProperty(process, "platform", { value: "darwin" })
    const device = { dev: 7n, rdev: 9n, ino: 11n }
    mock.module("node:fs", () => ({ ...fs, fstatSync: () => device, statSync: () => device,
      openSync: (path, ...args) => path === "/dev/fd/1" ? 900 : fs.openSync(path, ...args),
      closeSync: (fd) => fd === 900 ? undefined : fs.closeSync(fd) }))
    mock.module("node:tty", () => ({ ...tty, isatty: () => true }))
    // Terminal.app's contents are logical lines: one wrapped 82-character line plus 23 rows is 24 lines on 25 rows.
    const contents = "W".repeat(80) + "XY\\n" + "r\\n".repeat(23)
    const tab = { tty: () => "/dev/ttys004", contents: () => contents, numberOfRows: () => 25, numberOfColumns: () => 80 }
    const application = { running: () => true, frontmost: () => true, windows: [{ tabs: [tab] }] }
    const scriptReplies = []
    mock.module("node:child_process", () => ({ ...cp,
      execFileSync: (command, args) => {
        assert.equal(command, "/bin/ps")
        const pid = Number(args[args.indexOf("-p") + 1])
        if (args.includes("tty=")) return "ttys004"
        if (!args.includes("pid=")) return "/sbin/launchd"
        return pid === process.pid ? process.pid + " 4242 /bin/zsh"
          : pid === 4242 ? "4242 1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" : "1 0 /sbin/launchd"
      },
      spawnSync: (command, args) => {
        assert.equal(command, "/usr/bin/osascript")
        const stdout = String(runInNewContext(args[args.length - 1] + "\\nrun()", { Application: () => application })) + "\\n"
        scriptReplies.push(stdout)
        return { stdout, stderr: "", status: 0, signal: null }
      },
      spawn: (file) => {
        if (String(file).endsWith("pbpaste") || String(file).endsWith("pbcopy") || String(file).endsWith("osascript")) {
          const child = new EventEmitter()
          child.stdout = new EventEmitter()
          child.stderr = new EventEmitter()
          child.kill = () => true
          child.stdin = { end() { queueMicrotask(() => { child.stdout.emit("data", Buffer.from("\\n")); child.emit("close", 0) }) } }
          return child
        }
        const child = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
        queueMicrotask(() => { child.stdout.emit("data", Buffer.from("25 80\\n")); child.emit("close", 0) })
        return child
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({ ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64),
        appLaunch: { executablePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" } }) }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const retained = []
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" }, onRetained: (artifact) => retained.push(artifact) })
    const labels = ["text qualification soft-wrap target", "text qualification prior-scrollback control"]
    try {
      for (const label of [...labels, "another checkpoint"]) {
        // 30729 (4b48cfd7e): the refusal names the wrapped line and carries the split diagnostic.
        const refusal = await owner.readCells({ label, directory, onRetained: (artifact) => retained.push(artifact) })
        assert.deepEqual({ status: refusal.status, reason: refusal.reason },
          { status: "refused", reason: "Terminal.app returned 24 rows where the measured screen has 25, and line 1 is 82 cells over 80 columns, which is not a whole number of rows, so its row boundary is unknown" })
        assert.deepEqual(refusal.diagnostic.lineLengths, [82, ...Array(23).fill(1)])
      }
      const envelopes = retained.filter(artifact => artifact.path.endsWith(".json"))
      const frames = retained.filter(artifact => artifact.path.endsWith(".bin"))
      assert.equal(envelopes.length, 3); assert.equal(frames.length, 3)
      for (const [index, artifact] of envelopes.entries()) {
        const bytes = fs.readFileSync(artifact.path)
        const envelope = JSON.parse(bytes.toString("utf8"))
        assert.equal(envelope.captureRunId, "a".repeat(32))
        assert.equal(envelope.checkpoint, [...labels, "another checkpoint"][index])
        assert.equal(envelope.tty, "/dev/ttys004")
        assert.deepEqual(envelope.grid, { rows: 25, cols: 80 })
        assert.equal(envelope.reply, "sha256:" + frames[index].sha256)
        assert.equal(fs.readFileSync(frames[index].path, "utf8"), scriptReplies[index])
        const diagnostic = JSON.parse(scriptReplies[index]).diagnostic
        assert.equal(diagnostic.contents, contents)
        assert.deepEqual(diagnostic.lineLengths, [82, ...Array(23).fill(1)])
        assert.equal((await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"), artifact.sha256)
      }
    } finally { await owner.dispose() }
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
    titleRead: "system-events",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/iTerm.app/Contents/MacOS/iTerm2")).toEqual({
    id: "iterm2",
    comm: "iTerm2",
    titleRead: "none",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/Ghostty.app/Contents/MacOS/ghostty")).toEqual({
    id: "ghostty",
    comm: "ghostty",
    titleRead: "system-events",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/Alacritty.app/Contents/MacOS/alacritty")).toEqual({
    id: "alacritty",
    comm: "alacritty",
    titleRead: "system-events",
  })
  // WezTerm.app's CFBundleExecutable is wezterm-gui (run 39274899363); the CLI binary never appears here.
  expect(hostedDarwinAppFromExecutablePath("/Applications/WezTerm.app/Contents/MacOS/wezterm-gui")).toEqual({
    id: "wezterm",
    comm: "wezterm-gui",
    titleRead: "system-events",
  })
  // 30211: the receipt names the editor GUI, never its CLI or an Electron helper.
  expect(hostedDarwinAppFromExecutablePath("/Applications/Cursor.app/Contents/MacOS/Cursor")).toEqual({
    id: "cursor",
    comm: "Cursor",
    titleRead: "system-events",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/Visual Studio Code.app/Contents/MacOS/Code")).toEqual({
    id: "com.microsoft.VSCode",
    comm: "Code",
    titleRead: "system-events",
  })
  // 33056: Warp alone declares a chrome band; every other row's exact match proves the default is none.
  expect(hostedDarwinAppFromExecutablePath("/Applications/Warp.app/Contents/MacOS/stable")).toEqual({
    id: "warp",
    comm: "stable",
    titleRead: "system-events",
    captureChromeBand: { y: 0, height: 40, reason: "Warp title bar: Update Warp pill" },
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/cmux.app/Contents/MacOS/cmux")).toEqual({
    id: "cmux",
    comm: "cmux",
    titleRead: "system-events",
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

// #30392 Acceptance 4 cites the collector's tty= entry together with the chain to the app pid; the
// run already walked that chain, so the line must name every hop and never pass argv0 off as the path.
// Rows are in producer order, exactly as readProcessAncestry builds them: self first, then each parent
// up to launchd, so the arrows point the way the run walks.
test("formatHostedDarwinAncestry names every hop with its kernel path and a failed read by name", () => {
  const rows = [
    {
      pid: 3207,
      ppid: 2444,
      comm: "bun",
      kernelExecutableError: "proc_pidpath: returned 0, errno 1",
    },
    {
      pid: 2444,
      ppid: 1,
      comm: "stable",
      kernelExecutable: "/Applications/Warp.app/Contents/MacOS/stable",
      kernelExecutableReader: "proc_pidpath" as const,
    },
    {
      pid: 1,
      ppid: 0,
      comm: "/sbin/launchd",
      kernelExecutable: "/sbin/launchd",
      kernelExecutableReader: "proc_pidpath" as const,
    },
  ]
  expect(formatHostedDarwinAncestry(rows)).toBe(
    "3207:bun <kernel-error: proc_pidpath: returned 0, errno 1> <- 2444:stable </Applications/Warp.app/Contents/MacOS/stable> <- 1:/sbin/launchd </sbin/launchd>",
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
