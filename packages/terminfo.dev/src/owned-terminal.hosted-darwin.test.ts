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
  resolveOwnedAppId,
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
    let pasteboard = ""
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
        const tool = String(file)
        if (tool.endsWith("pbpaste") || tool.endsWith("pbcopy") || tool.endsWith("osascript")) {
          const child = new EventEmitter()
          child.stdout = new EventEmitter()
          child.stderr = new EventEmitter()
          child.kill = () => true
          child.stdin = {
            end(text) {
              if (tool.endsWith("pbcopy")) pasteboard = String(text ?? "")
              const reply = tool.endsWith("pbcopy") ? "" : tool.endsWith("pbpaste") ? pasteboard + "\\n" : "\\n"
              queueMicrotask(() => {
                child.stdout.emit("data", Buffer.from(reply))
                child.emit("close", 0)
              })
            },
          }
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

// An app that publishes no surface id leaves nothing to name, so the grant must refuse rather than let a
// later read fall back to "whatever surface is current" (@dev/1 peer read 2026-11-13).
test("a hosted cmux arm with no published surface id refuses at grant and writes nothing", () => {
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    const executable = "/Applications/cmux.app/Contents/MacOS/cmux"
    Object.defineProperty(process, "platform", { value: "darwin" })
    delete process.env.CMUX_SURFACE_ID
    const cmuxCalls = []
    const device = { dev: 7n, rdev: 9n, ino: 11n }
    const realReadFileSync = fs.readFileSync
    mock.module("node:fs", () => ({
      ...fs,
      fstatSync: () => device,
      statSync: () => device,
      openSync: () => 7,
      closeSync: () => {},
      readFileSync: (path) => (String(path) === executable ? Buffer.from("cmux-binary") : realReadFileSync(path)),
    }))
    mock.module("node:tty", () => ({ ...tty, isatty: () => true }))
    mock.module("node:child_process", () => ({ ...cp,
      spawn: (file) => {
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => true
        child.stdin = { end() { queueMicrotask(() => { child.stdout.emit("data", Buffer.from("\\n")); child.emit("close", 0) }) } }
        if (String(file) === "/bin/stty") {
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from("24 80\\n"))
            child.emit("close", 0)
          })
        }
        return child
      },
      execFileSync: (command, args) => {
        const pid = Number(args[args.indexOf("-p") + 1])
        if (args.includes("tty=")) return "ttys004"
        if (!args.includes("pid=")) return "/sbin/launchd"
        return pid === process.pid ? process.pid + " 4242 /bin/zsh"
          : pid === 4242 ? "4242 1 " + executable : "1 0 /sbin/launchd"
      },
      spawnSync: (file, args) => {
        if (String(file).includes("cmux")) {
          cmuxCalls.push(String(file) + " " + args.join(" "))
          return { status: 0, stdout: "$ prompt\\nCMUX-" + "a".repeat(32) + "-BEGIN", stderr: "" }
        }
        return { status: 0, stdout: "cmux 0.65.2", stderr: "" }
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({
      ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64), appLaunch: { executablePath: executable } })
    }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const writes = []
    const realWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true }
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" } })
    process.stdout.write = realWrite
    assert.equal(writes.length, 0, "a grant that cannot name a surface must not write into one")
    assert.equal(owner.cmuxHistory?.surface ?? null, null)
    assert.match(owner.cmuxHistory.grantProof, /published no CMUX_SURFACE_ID/u)
    const error = await owner.getScrollback().then(() => undefined, (reason) => reason)
    assert.match(error?.message ?? "", /published no CMUX_SURFACE_ID/u)
    assert.equal(cmuxCalls.filter((call) => call.includes("read-screen")).length, 0, "no read may run without an acquired id")
    await owner.dispose()
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.status, result.stderr).toBe(0)
})

// Condition 1 of @cto 8c084f05, through the real owner: a hosted WezTerm whose ancestor is a different
// process at read time must refuse by pid before any WezTerm CLI read, not merely match the app's name.
test("a hosted WezTerm ancestor that changed pid refuses the read by name and reads nothing", () => {
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    const executable = "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"
    Object.defineProperty(process, "platform", { value: "darwin" })
    process.env.WEZTERM_PANE = "0"
    process.env.WEZTERM_UNIX_SOCKET = "/private/tmp/term-31741/wezterm.sock"
    let appPid = 4242
    const wezTermCalls = []
    const device = { dev: 7n, rdev: 9n, ino: 11n }
    mock.module("node:fs", () => ({ ...fs, fstatSync: () => device, statSync: () => device }))
    mock.module("node:tty", () => ({ ...tty, isatty: () => true }))
    mock.module("node:child_process", () => ({ ...cp,
      execFileSync: (command, args) => {
        assert.equal(command, "/bin/ps")
        const pid = Number(args[args.indexOf("-p") + 1])
        if (args.includes("tty=")) return "ttys004"
        if (!args.includes("pid=")) return "/sbin/launchd"
        return pid === process.pid ? process.pid + " " + appPid + " /bin/zsh"
          : pid === appPid ? appPid + " 1 " + executable : "1 0 /sbin/launchd"
      },
      spawn: (file) => {
        const tool = String(file)
        if (tool.endsWith("pbpaste") || tool.endsWith("pbcopy") || tool.endsWith("osascript")) {
          const child = new EventEmitter()
          child.stdout = new EventEmitter()
          child.stderr = new EventEmitter()
          child.kill = () => true
          child.stdin = {
            end() {
              queueMicrotask(() => {
                child.stdout.emit("data", Buffer.from("\\n"))
                child.emit("close", 0)
              })
            },
          }
          return child
        }
        wezTermCalls.push(tool)
        throw new Error("geometry unavailable in this fixture")
      },
      spawnSync: (file, args) => {
        if (String(file).includes("wezterm")) wezTermCalls.push(String(file) + " " + args.join(" "))
        return { status: 0, stdout: "", stderr: "" }
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({
      ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64), appLaunch: { executablePath: executable } })
    }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" } })
    assert.equal(owner.hostedAppId, "wezterm")
    assert.equal(owner.appPid, 4242)
    assert.equal(typeof owner.getScrollback, "function")
    const atGrant = wezTermCalls.length
    appPid = 5555
    const error = await owner.getScrollback().then(() => undefined, (reason) => reason)
    assert.equal(error?.message, "Hosted WezTerm ancestor is now pid 5555, not pid 4242 measured at grant")
    assert.equal(wezTermCalls.length, atGrant, "no WezTerm CLI read may follow the refusal")
    await owner.dispose()
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.status, result.stderr).toBe(0)
})

// The pure CWD fixture cannot prove the hosted owner installs the port, brackets CLI calls, or keeps
// restoration off the publishable writer. Exercise the actual owner with only OS actions supplied.
test.each([false, true])("hosted WezTerm CWD uses its owned private port; owner loss=%s", (loseOwner) => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-owned-cwd-"))
  directories.push(directory)
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    Object.defineProperty(process, "platform", { value: "darwin" })
    const executable = "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"
    const cli = "/Applications/WezTerm.app/Contents/MacOS/wezterm"
    const socket = "/private/owned/wezterm.sock"
    process.env.WEZTERM_PANE = "0"
    process.env.WEZTERM_UNIX_SOCKET = socket
    process.env.TERMINFO_CAPTURE_DIRECTORY = ${JSON.stringify(directory)}
    let appPid = 4242, cwd = "file:///Users/private-person/secret-project", text = "", writes = 0, reads = 0
    const initial = cwd
    const originalReadFileSync = fs.readFileSync
    const device = { dev: 7n, rdev: 9n, ino: 11n }
    mock.module("node:fs", () => ({ ...fs, fstatSync: () => device, openSync: () => 7, closeSync: () => {},
      statSync: (path, ...args) => {
        if (String(path).startsWith("/terminfo-")) throw Object.assign(new Error("absent"), { code: "ENOENT" })
        return device
      },
      readFileSync: (path, ...args) => String(path) === cli ? Buffer.from("owned-cli") : originalReadFileSync(path, ...args)
    }))
    mock.module("node:tty", () => ({ ...tty, isatty: () => true }))
    mock.module("node:child_process", () => ({ ...cp,
      execFileSync: (command, args) => {
        assert.equal(command, "/bin/ps")
        const pid = Number(args[args.indexOf("-p") + 1])
        if (args.includes("tty=")) return "ttys004"
        if (!args.includes("pid=")) return "/sbin/launchd"
        return pid === process.pid ? process.pid + " " + appPid + " /bin/zsh"
          : pid === appPid ? appPid + " 1 " + executable : "1 0 /sbin/launchd"
      },
      spawn: (file) => {
        const child = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
        child.stdin = { end() { queueMicrotask(() => { child.stdout.emit("data", Buffer.from("\\n")); child.emit("close", 0) }) } }
        if (String(file) === "/bin/stty") {
          queueMicrotask(() => { child.stdout.emit("data", Buffer.from("24 80\\n")); child.emit("close", 0) })
        } else assert.ok(/pbcopy|pbpaste|osascript/.test(String(file)))
        return child
      },
      spawnSync: (file, args) => {
        if (String(file).endsWith("lsof")) return { status: 0, stdout: "n" + socket + "\\n", stderr: "" }
        assert.equal(String(file), cli)
        if (args[0] === "--version") return { status: 0, stdout: "wezterm 20240203-110809-5046fc22", stderr: "" }
        reads++
        if (args.includes("list")) return { status: 0, stdout: JSON.stringify([{ pane_id: 0, tty_name: "/dev/ttys004", cwd }]), stderr: "" }
        assert.ok(args.includes("get-text"))
        return { status: 0, stdout: Buffer.from(text + "\\n".repeat(24)), stderr: Buffer.alloc(0) }
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({ ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64), appLaunch: { executablePath: executable } })
    }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const realWrite = process.stdout.write
    process.stdout.write = (chunk) => {
      text = String(chunk); writes++
      const command = /\\x1b\\]7;([^\\x07]*)\\x07/.exec(text)
      if (command) cwd = command[1]
      if (${loseOwner}) appPid = 5555
      return true
    }
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" } })
    assert.equal(typeof owner.readAppSemanticState, "function", "hosted owner must install the CWD reader")
    const result = await owner.readAppSemanticState("extensions.osc7-cwd", () => { throw new Error("public writer leaked restoration") })
      .then((value) => value, (error) => ({ status: "run-error", reason: error.message }))
    if (${loseOwner}) {
      assert.notEqual(result.status, "measured")
      assert.match(result.reason, /ownership|restoration|ancestor/i)
      assert.equal(reads, 1, "no CLI command follows ownership loss")
    } else {
      assert.equal(result.status, "measured", JSON.stringify(result) + " " + fs.readdirSync(process.env.TERMINFO_CAPTURE_DIRECTORY)
        .map((file) => fs.readFileSync(process.env.TERMINFO_CAPTURE_DIRECTORY + "/" + file, "utf8")).join(" "))
      assert.equal(cwd, initial)
      assert.equal(writes, 4)
      assert.equal(JSON.stringify(result).includes("private-person"), false)
    }
    await owner.dispose()
    process.stdout.write = realWrite
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
    let pasteboard = ""
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
        const tool = String(file)
        if (tool.endsWith("pbpaste") || tool.endsWith("pbcopy") || tool.endsWith("osascript")) {
          const child = new EventEmitter()
          child.stdout = new EventEmitter()
          child.stderr = new EventEmitter()
          child.kill = () => true
          child.stdin = {
            end(text) {
              if (tool.endsWith("pbcopy")) pasteboard = String(text ?? "")
              const reply = tool.endsWith("pbcopy") ? "" : tool.endsWith("pbpaste") ? pasteboard + "\\n" : "\\n"
              queueMicrotask(() => {
                child.stdout.emit("data", Buffer.from(reply))
                child.emit("close", 0)
              })
            },
          }
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
    let pasteboard = ""
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
        const tool = String(file)
        if (tool.endsWith("pbpaste") || tool.endsWith("pbcopy") || tool.endsWith("osascript")) {
          const child = new EventEmitter()
          child.stdout = new EventEmitter()
          child.stderr = new EventEmitter()
          child.kill = () => true
          child.stdin = {
            end(text) {
              if (tool.endsWith("pbcopy")) pasteboard = String(text ?? "")
              const reply = tool.endsWith("pbcopy") ? "" : tool.endsWith("pbpaste") ? pasteboard + "\\n" : "\\n"
              queueMicrotask(() => {
                child.stdout.emit("data", Buffer.from(reply))
                child.emit("close", 0)
              })
            },
          }
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
    scrollbackUnavailable: "no pane read on this app",
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
    titleRead: "none",
    scrollbackUnavailable: "no pane read on this app",
    titleUnavailable: expect.stringContaining('"[Extension Development Host] Cursor"'),
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/Visual Studio Code.app/Contents/MacOS/Code")).toEqual({
    id: "com.microsoft.VSCode",
    comm: "Code",
    titleRead: "none",
    scrollbackUnavailable: "no pane read on this app",
    titleUnavailable: expect.stringContaining('"[Extension Development Host] Visual Studio Code"'),
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
    titleRead: "none",
    titleUnavailable: expect.stringContaining('"Terminal"'),
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

// @dev/8 R2 on 30724: the three hosted fixtures prove the sentinel path works WHEN SELECTED, not
// that the hosted arm selects it. This test asserts the violation directly: the hosted arm passes
// the disposable fact and no shared-machine claim, and the Terminal.app arm the reverse. Removing
// `disposableHost` from owned-terminal.ts fails here and nowhere else.
test("the hosted arm passes the disposable fact and the Terminal.app arm the shared-machine one", () => {
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    const executable = "/Applications/iTerm.app/Contents/MacOS/iTerm2"
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
        if (String(file).endsWith("pbpaste") || String(file).endsWith("pbcopy")) {
          const child = new EventEmitter()
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
          child.stdin = { end() { queueMicrotask(() => { child.stdout.emit("data", Buffer.from("\\n")); child.emit("close", 0) }) } }
          return child
        }
        throw new Error("geometry unavailable in this dispatch fixture")
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({
      ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64), appLaunch: { executablePath: executable } })
    }))
    const inputs = []
    mock.module("./packages/terminfo.dev/src/darwin-clipboard.ts", () => ({
      runDarwinCommand: async () => "",
      createDarwinClipboardAdapter: async (input) => {
        inputs.push({ ownedHost: input.ownedHost, disposableHost: input.disposableHost, appId: input.appId })
        return { profile: "default", pasteboard: "darwin", pasteboardApp: input.appId, config: null,
          permissions: "clipboard: read=allow,write=allow", summary: "dispatch fixture",
          assertOwned: async () => {}, readTitle: async () => "", dispose: async () => {},
          withClipboardFixture: async (work) => work({ baseline: "sentinel", readText: async () => "sentinel", writeText: async () => {} }) }
      }
    }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const ids = { captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32) }
    process.env.TERMINFO_RUN_ID = ids.expectedLaunchRunId
    const hosted = await createOwnedTerminal({ ...ids, out: process.stdout, darwinHosted: { receiptPath: "fixture" } })
    assert.deepEqual(inputs.at(-1), { ownedHost: undefined, disposableHost: { receiptKind: "github-hosted-runner" }, appId: "iterm2" })
    await hosted.dispose()
    const owned = await createOwnedTerminal({ ...ids, out: process.stdout,
      terminalApp: { asserter: "terminfo-admin", launchRunId: ids.expectedLaunchRunId, workerPid: process.pid, windowId: 4242, tabTty: "/dev/ttys004", intendedVersion: "3.4.5" } })
    assert.equal(inputs.at(-1).ownedHost, true)
    assert.equal(inputs.at(-1).disposableHost, undefined)
    await owned.dispose()
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.status, result.stderr).toBe(0)
})

/**
 * #31741 / @cto 20b9ffed: the declaration names Alacritty, VS Code and Cursor and nobody else, with the
 * reason text verbatim. An app that HAS a pane read must not be declared, or the row would lose a
 * measurement the run can still make; an app whose read is not yet implemented (Ghostty's scrollback
 * file, cmux's read-screen) also stays undeclared, because a missing arm is work, not an absence.
 */
test("only Alacritty, VS Code and Cursor declare no pane read, with @cto's exact reason", () => {
  const reason = "no pane read on this app"
  const declared = [
    "/Applications/Alacritty.app/Contents/MacOS/alacritty",
    "/Applications/Cursor.app/Contents/MacOS/Cursor",
    "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  ]
  for (const path of declared) {
    expect(hostedDarwinAppFromExecutablePath(path).scrollbackUnavailable, path).toBe(reason)
  }
  const measured = [
    "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "/Applications/iTerm.app/Contents/MacOS/iTerm2",
    "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
    "/Applications/cmux.app/Contents/MacOS/cmux",
    "/Applications/Warp.app/Contents/MacOS/stable",
  ]
  for (const path of measured) {
    expect(hostedDarwinAppFromExecutablePath(path).scrollbackUnavailable, path).toBeUndefined()
  }
})

// 8c084f05: the hosted arm's app id comes from the receipt, never from a launcher-typed variable that could
// disagree with it; the Linux arm keeps the launcher's value because it has no receipt to prove one.
test.each([
  [{ platform: "darwin", hostedAppId: "wezterm", launcherAppId: undefined }, "wezterm"],
  [{ platform: "darwin", hostedAppId: "wezterm", launcherAppId: "kitty" }, "wezterm"],
  [{ platform: "darwin", hostedAppId: undefined, launcherAppId: "wezterm" }, "wezterm"],
  [{ platform: "linux", hostedAppId: undefined, launcherAppId: "wezterm" }, "wezterm"],
  [{ platform: "linux", hostedAppId: "wezterm", launcherAppId: "kitty" }, "kitty"],
  [{ platform: "darwin", hostedAppId: undefined, launcherAppId: undefined }, undefined],
])("owned app id resolves in one place: %j", (input, expected) => {
  expect(resolveOwnedAppId(input)).toBe(expected)
})

// The cmux arm through the real owner: the receipt names the app, the collector runs inside its surface, and
// a changed ancestor must refuse by pid before any cmux read (@cto plan GO af8608c3, nonce arm ba9e117fd).
test("a hosted cmux arm reads its own surface, and a changed ancestor refuses by name first", () => {
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    const executable = "/Applications/cmux.app/Contents/MacOS/cmux"
    Object.defineProperty(process, "platform", { value: "darwin" })
    let appPid = 4242
    const cmuxCalls = []
    const device = { dev: 7n, rdev: 9n, ino: 11n }
    const realReadFileSync = fs.readFileSync
    mock.module("node:fs", () => ({
      ...fs,
      fstatSync: () => device,
      statSync: () => device,
      // The grid read reopens the selected fd; a test runner's stdout is a pipe, so the reopen is faked.
      openSync: () => 7,
      closeSync: () => {},
      readFileSync: (path) => (String(path) === executable ? Buffer.from("cmux-binary") : realReadFileSync(path)),
    }))
    mock.module("node:tty", () => ({ ...tty, isatty: () => true }))
    mock.module("node:child_process", () => ({ ...cp,
      execFileSync: (command, args) => {
        assert.equal(command, "/bin/ps")
        const pid = Number(args[args.indexOf("-p") + 1])
        if (args.includes("tty=")) return "ttys004"
        if (!args.includes("pid=")) return "/sbin/launchd"
        return pid === process.pid ? process.pid + " " + appPid + " /bin/zsh"
          : pid === appPid ? appPid + " 1 " + executable : "1 0 /sbin/launchd"
      },
      spawn: (file) => {
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => true
        child.stdin = { end() { queueMicrotask(() => { child.stdout.emit("data", Buffer.from("\\n")); child.emit("close", 0) }) } }
        // The owning arm reads its grid from stty on the bound pty; a successful read needs a real size.
        if (String(file) === "/bin/stty") {
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from("24 80\\n"))
            child.emit("close", 0)
          })
        }
        return child
      },
      spawnSync: (file, args) => {
        if (String(file).includes("cmux")) {
          cmuxCalls.push(String(file) + " " + args.join(" "))
          if (args.includes("read-screen")) {
            // Each surface answers with its own history, and an unnamed read answers as the focused
            // surface. Focus moves to surface-uuid-2 after the grant, so a read that fell back to "current"
            // would return the rival's three lines instead of our four (@dev/1 peer verdict, F3).
            const named = args[args.indexOf("--surface") + 1]
            if (named === "surface-uuid-1") {
              return { status: 0, stdout: "$ prompt\\n\\nCMUX-" + "a".repeat(32) + "-BEGIN\\n$ prompt", stderr: "" }
            }
            return { status: 0, stdout: "rival-a\\nrival-b\\nrival-c", stderr: "" }
          }
        }
        return { status: 0, stdout: "cmux 0.65.2", stderr: "" }
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({
      ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64), appLaunch: { executablePath: executable } })
    }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    process.env.CMUX_SURFACE_ID = "surface-uuid-1"
    const writes = []
    // selectedFd accepts only the daemon's real stdout (or a real tty WriteStream), so the spy lives on
    // process.stdout. The only write this owner may make is the single grant nonce line (@cto REVISE F1).
    const realWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true }
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" } })
    assert.equal(owner.hostedAppId, "cmux")
    assert.equal(owner.appPid, 4242)
    assert.equal(typeof owner.getScrollback, "function")
    assert.equal(owner.historyReadsThroughCli, true)
    assert.equal(owner.historyExecutable?.path, executable)
    assert.equal(owner.historyExecutable?.version, "cmux 0.65.2")
    // The grant proof wrote the nonce once; no later read may write anything (@cto REVISE F1).
    assert.equal(writes.length, 1)
    assert.match(writes[0], /CMUX-a{32}-BEGIN/)
    const grant = JSON.parse(owner.cmuxHistory.grantProof)
    assert.equal(grant.ownership, "nonce")
    assert.equal(grant.surface, "surface-uuid-1")
    assert.equal(owner.cmuxHistory.surface, "surface-uuid-1")
    const atGrant = cmuxCalls.length
    appPid = 5555
    const error = await owner.getScrollback().then(() => undefined, (reason) => reason)
    assert.equal(error?.message, "Hosted cmux ancestor is now pid 5555, not pid 4242 measured at launch")
    assert.equal(cmuxCalls.length, atGrant, "no cmux read may follow the refusal")
    // A refusal alone would let a broken success path pass, so restore the owner and read twice for real
    // (@dev/1 peer read 2026-11-13).
    appPid = 4242
    // Focus moves to a second surface after grant; every later read must still name the acquired one
    // (@dev/1 peer verdict, F3).
    process.env.CMUX_SURFACE_ID = "surface-uuid-2"
    const first = await owner.getScrollback()
    const second = await owner.getScrollback()
    assert.deepEqual(second, first, "two reads of an unchanged surface report the same history")
    assert.equal(first.totalLines, 4, "reads report the acquired surface's history, not the focused surface's")
    assert.equal(cmuxCalls.length, atGrant + 2, "each later read runs its own CLI read")
    for (const call of cmuxCalls.slice(atGrant)) {
      assert.match(call, /read-screen --surface surface-uuid-1 --scrollback/)
    }
    assert.equal(writes.length, 1, "no read may write to the surface")
    const readReceipt = JSON.parse(owner.cmuxHistory.lastRead)
    assert.equal(readReceipt.ownership, "surface")
    assert.equal(readReceipt.surface, "surface-uuid-1")
    assert.equal(readReceipt.screenLines, 24)
    process.stdout.write = realWrite
    await owner.dispose()
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.status, result.stderr).toBe(0)
})
