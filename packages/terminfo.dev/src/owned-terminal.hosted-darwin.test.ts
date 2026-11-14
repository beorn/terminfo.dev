/**
 * @failure Hosted macOS geometry probes skip, a PTY bind attributes geometry to the wrong app,
 *   or a failed iTerm or Terminal.app qualification read loses its original diagnostic inputs.
 * @level l1
 * @consumer createOwnedTerminal darwinHosted arm used by collectProbeRun on hosted Mac.
 * @reach fs-walk <fixture-only: assertion diagnostics read this test's generated capture directory>
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
test.each(["iterm2", "terminal-app", "cursor", "com.microsoft.VSCode"])(
  "hosted %s selects its own native read",
  (app) => {
    const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    const app = ${JSON.stringify(app)}
    const executable = {
      iterm2: "/Applications/iTerm.app/Contents/MacOS/iTerm2",
      "terminal-app": "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      cursor: "/Applications/Cursor.app/Contents/MacOS/Cursor",
      "com.microsoft.VSCode": "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    }[app]
    const editor = app === "cursor" || app === "com.microsoft.VSCode"
    let appPid = 4242
    const nativeReads = [], captures = []
    const semantic = await import("./packages/terminfo.dev/src/app-semantic-state.ts")
    mock.module("./packages/terminfo.dev/src/app-semantic-state.ts", () => ({ ...semantic,
      readAppSemanticState: async (input) => {
        nativeReads.push(input)
        await input.editor.assertProcess(process.pid)
        await input.editor.capture(input.featureId, "target")
        return { status: "unavailable", reason: "Native API boundary fixture" }
      },
    }))
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
        return pid === process.pid ? process.pid + " 5488 /collector/bun"
          : pid === 5488 ? "5488 " + appPid + " /bin/bash"
          : pid === 7777 ? "7777 " + appPid + " /bin/bash"
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
    process.env.TERMINFO_TARGET_ID = "foreign-launcher-value"
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" },
      appSemanticCapture: async (featureId, phase) => { captures.push({ featureId, phase }); return { retained: true } } })
    assert.equal(owner.hostedAppId, app)
    assert.equal(owner.appPid, 4242)
    if (editor) {
      assert.equal(typeof owner.readAppSemanticState, "function", "editor owner must install its native API reader")
      const result = await owner.readAppSemanticState("extensions.osc633-p", () => {})
      assert.equal(result.reason, "Native API boundary fixture")
      assert.equal(nativeReads.length, 1)
      assert.equal(nativeReads[0].editor.appId, app, "receipt, not launcher environment, selects the native reader")
      assert.deepEqual(captures, [{ featureId: "extensions.osc633-p", phase: "target" }])
      await assert.rejects(async () => nativeReads[0].editor.assertProcess(999999), /ancestor|owned|pid/i)
      await nativeReads[0].editor.assertProcess(5488, true)
      await nativeReads[0].editor.assertProcess(7777)
      await assert.rejects(async () => nativeReads[0].editor.assertProcess(7777, true), /collector.*ancestor|ancestor.*collector/i)
      appPid = 5555
      await assert.rejects(owner.readAppSemanticState("extensions.osc633-p", () => {}), /5555|4242/)
      assert.equal(nativeReads.length, 1, "a changed App must refuse before native API evaluation")
    } else {
      assert.equal(typeof owner.readCells, "function")
      assert.equal(owner.textRecipe, app === "iterm2" ? "iterm2-api-text-cells-v1" : "macos-text-cells-v1")
    }
    await owner.dispose()
  `
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: join(import.meta.dirname, "../../.."),
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(result.status, result.stderr).toBe(0)
  },
)

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
    const kernelPids = []
    mock.module("./packages/terminfo.dev/src/darwin-kernel-exec.ts", () => ({
      kernelExecPath: (pid) => {
        kernelPids.push(pid)
        return { path: pid === appPid ? executable : pid === 1 ? "/sbin/launchd" : "/bin/zsh",
          reader: "fixture", error: null, attempts: [] }
      }
    }))
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
    // Hosted evidence names the measured kernel path; argv0 alone is not that path (#30392).
    assert.equal(JSON.parse(owner.summary).darwinHosted.ancestor.kernelExecutable, executable)
    assert.equal(typeof owner.getScrollback, "function")
    const atGrant = wezTermCalls.length
    appPid = 5555
    const error = await owner.getScrollback().then(() => undefined, (reason) => reason)
    assert.equal(error?.message, "Hosted WezTerm ancestor is now pid 5555, not pid 4242 measured at grant")
    assert.ok(kernelPids.includes(5555), "the read-time ancestry recheck also measures the new hop's kernel path")
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
test.each([
  "steady",
  "lost-owner",
  "unreviewed-version",
  "foreign-version",
  "foreign-run",
  "mux-environment",
  "missing-cwd",
  "duplicate-pane",
  "unsafe-uri",
  "wrong-pane",
  "malformed-json",
  "semantic-fallbacks",
])("hosted WezTerm CWD uses its owned private port; mode=%s", (mode) => {
  const loseOwner = mode === "lost-owner"
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
    process.env.TERMINFO_RUN_ID = ${JSON.stringify((mode === "foreign-run" ? "c" : "b").repeat(32))}
    process.env.TERMINFO_TARGET_VERSION = ${JSON.stringify(mode === "foreign-version" ? "unreviewed-version" : "20240203-110809-5046fc22")}
    process.env.TERMINFO_MUX_KIND = ${JSON.stringify(mode === "mux-environment" ? "tmux" : "")}
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
        if (args[0] === "--version") return { status: 0, stdout: ${JSON.stringify(mode === "unreviewed-version" ? "wezterm unreviewed-version" : "wezterm 20240203-110809-5046fc22")}, stderr: "" }
        reads++
        if (args.includes("list")) {
          const row = { pane_id: ${mode === "wrong-pane" ? 9 : 0}, tty_name: "/dev/ttys004",
            cwd: ${mode === "missing-cwd" ? "undefined" : mode === "unsafe-uri" ? '"file:///unsafe\\x07directory"' : "cwd"} }
          return { status: 0, stdout: ${mode === "malformed-json" ? '"not JSON"' : `JSON.stringify([row${mode === "duplicate-pane" ? ", row" : ""}])`}, stderr: "" }
        }
        assert.ok(args.includes("get-text"))
        return { status: 0, stdout: Buffer.from(text + "\\n".repeat(24)), stderr: Buffer.alloc(0) }
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({ ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64), appLaunch: { executablePath: executable } })
    }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const realWrite = process.stdout.write
    const retained = []
    process.stdout.write = (chunk) => {
      text = String(chunk); writes++
      const command = /\\x1b\\]7;([^\\x07]*)\\x07/.exec(text)
      if (command) cwd = command[1]
      if (${loseOwner}) appPid = 5555
      return true
    }
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" }, onRetained: artifact => retained.push(artifact) })
    assert.equal(typeof owner.readAppSemanticState, "function", "hosted owner must install the CWD reader")
    if (${mode === "semantic-fallbacks"}) {
      const { ALL_PROBES } = await import("./packages/probe-defs/src/index.ts")
      const { withAppSemanticObservation } = await import("./packages/probe-defs/src/app-semantic-state.ts")
      const { runProbeBatch } = await import("./packages/terminfo.dev/src/probes/unified.ts")
      const { ownedTerminalVerifiedFor } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      assert.equal(ownedTerminalVerifiedFor(owner, "a".repeat(32), process.stdout), true)
      const features = ["extensions.osc1-icon", "extensions.osc133-a", "extensions.osc8", "extensions.osc176-app-id"]
      const called = []
      for (const id of features) {
        const definition = ALL_PROBES.find(probe => probe.id === id)
        assert.ok(definition, id)
        definition.termNeedsGeometry = false
        definition.term = withAppSemanticObservation({ id, lib: null, term: async () => {
          called.push(id)
          return { pass: false, note: "original term " + id,
            tests: [{ id: "criterion", status: "probe-todo", reason: "original term " + id }] }
        } }).term
      }
      const batch = await runProbeBatch({ ids: features, ownedTerminal: owner, captureRunId: "a".repeat(32),
        subject: { kind: "term", id: "wezterm", os: "macos", version: "20240203-110809-5046fc22" } })
      for (const id of features) {
        assert.ok(called.includes(id), "original term did not run: " + id + " " + JSON.stringify(batch.results.find(row => row.featureId === id)))
        assert.equal(batch.results.find(row => row.featureId === id)?.reason, "original term " + id,
          "wrapper replaced the original term result: " + id)
      }
      await owner.dispose()
      process.stdout.write = realWrite
    } else {
    const result = await owner.readAppSemanticState("extensions.osc7-cwd", () => { throw new Error("public writer leaked restoration") })
      .then((value) => value, (error) => ({ status: "run-error", reason: error.message }))
    if (${mode !== "steady" && mode !== "lost-owner"}) {
      assert.equal(result.status, "invalid", JSON.stringify(result))
      assert.equal(writes, 0, "an unqualified reader must not mutate the pane")
      assert.equal(reads, ${["unreviewed-version", "foreign-version", "foreign-run", "mux-environment"].includes(mode) ? 0 : 1})
    } else if (${loseOwner}) {
      assert.notEqual(result.status, "measured")
      assert.match(result.reason, /ownership|restoration|ancestor/i)
      assert.equal(reads, 1, "no CLI command follows ownership loss")
    } else {
      assert.equal(result.status, "measured", JSON.stringify(result) + " " + fs.readdirSync(process.env.TERMINFO_CAPTURE_DIRECTORY)
        .map((file) => fs.readFileSync(process.env.TERMINFO_CAPTURE_DIRECTORY + "/" + file, "utf8")).join(" "))
      assert.equal(cwd, initial)
      assert.equal(writes, 4)
      assert.equal(JSON.stringify(result).includes("private-person"), false)
      assert.equal(typeof result.detail.ownershipReceipt, "string", "CWD must retain the owned pane identity")
      assert.deepEqual(JSON.parse(result.detail.ownershipReceipt), {
        surface: "wezterm", pane: "0", listedTty: "ttys004", measuredTty: "ttys004",
        ttyMatch: true, socketPresent: true, executable: "wezterm",
      })
      assert.equal(/[\\\\/]/u.test(result.detail.ownershipReceipt), false)
      const nativeReads = retained.map(artifact => JSON.parse(fs.readFileSync(artifact.path, "utf8")))
      assert.ok(nativeReads.some(read => read.args?.includes("list") && typeof read.stdout === "string" && read.stdout.includes(initial)), "private pane-list argv/stdout must survive")
      assert.ok(nativeReads.some(read => read.args?.includes("get-text") && typeof read.stdoutBase64 === "string"), "private get-text argv/stdout must survive")
      assert.ok(nativeReads.some(read => read.initial === initial && read.restored === initial && Array.isArray(read.phases)
        && read.phases.some(phase => typeof phase.feed === "string")), "private CWD phase/feed record must reach the collector manifest")
      assert.ok(retained.some(artifact => artifact.path.endsWith("/" + result.detail.privateEvidence)), "published private reference must name a manifest artifact")
    }
    await owner.dispose()
    process.stdout.write = realWrite
    }
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
    process.env.TERMINFO_CAPTURE_DIRECTORY = directory + "/artifacts"
    fs.writeFileSync(directory + "/terminal-launch.json", JSON.stringify({ appId: "terminal-app", terminalWindow: { provider: "terminal-app", windowId: 34 } }))
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
    captureWindowSelection: "largest",
  })
  expect(hostedDarwinAppFromExecutablePath("/Applications/iTerm.app/Contents/MacOS/iTerm2")).toEqual({
    id: "iterm2",
    comm: "iTerm2",
    titleRead: "none",
    captureWindowSelection: "largest",
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
  // 34087: each sentence names its calibration run first and says the counted runs read nothing, so no
  // app-own-title row can be read as a live measurement of a run that attempted none; the calibration
  // pid is gone because it is not a fact about the row.
  for (const [path, calibrationRun] of [
    ["/Applications/Cursor.app/Contents/MacOS/Cursor", "43325922491"],
    ["/Applications/Visual Studio Code.app/Contents/MacOS/Code", "43325922491"],
    ["/Applications/cmux.app/Contents/MacOS/cmux", "43327254711"],
  ] as const) {
    const sentence = hostedDarwinAppFromExecutablePath(path).titleUnavailable ?? ""
    expect(sentence).toContain(`on 33821 calibration run ${calibrationRun}`)
    expect(sentence).toContain("counted runs attempted no title-row read")
    expect(sentence).not.toMatch(/\bpid \d+/)
  }
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
  const directory = mkdtempSync(join(tmpdir(), "cmux-private-evidence-"))
  directories.push(directory)
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    const executable = "/Applications/cmux.app/Contents/MacOS/cmux"
    const directory = ${JSON.stringify(directory)}
    process.env.TERMINFO_CAPTURE_DIRECTORY = directory
    const retained = []
    Object.defineProperty(process, "platform", { value: "darwin" })
    let appPid = 4242
    const cmuxCalls = []
    const device = { dev: 7n, rdev: 9n, ino: 11n }
    const realReadFileSync = fs.readFileSync, realStatSync = fs.statSync
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
              // One non-sentinel line names a path, so the record can be proved not to carry the transcript.
              return { status: 0, stdout: "$ /Users/x\\n\\nCMUX-" + "a".repeat(32) + "-BEGIN\\n$ /Users/x", stderr: "" }
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
      out: process.stdout, darwinHosted: { receiptPath: "fixture" }, onRetained: (artifact) => retained.push(artifact) })
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
    assert.equal("rawScreen" in grant, false, "raw screen bytes stay out of the receipt")
    assert.equal(grant.ownership, "nonce")
    assert.equal(grant.surface, "surface-uuid-1")
    assert.equal(owner.cmuxHistory.surface, "surface-uuid-1")
    // The persisted record is built through serve.ts's own constructor, on the real owner and the real
    // transcript: a grant-only run must publish the read's facts and nothing the CLI printed (@cto REVISE).
    const { cmuxHistoryEvidence } = await import("./packages/terminfo.dev/src/cmux-history-record.ts")
    const grantRecord = JSON.parse(cmuxHistoryEvidence(owner.cmuxHistory)["collector.cmuxHistory"])
    assert.equal(grantRecord.lastRead.kind, "grant", "with no later read, the grant read is what the record shows")
    assert.equal(grantRecord.lastRead.extras, 3, "extras is a count of the lines, never the lines")
    assert.equal(JSON.stringify(grantRecord).includes("/Users/x"), false, "the pane transcript never reaches the record")
    assert.equal(JSON.stringify(grantRecord).includes("/"), false, "no path separator reaches the record")
    assert.equal(grantRecord.grantRefusal, undefined, "a proved grant records no refusal")
    assert.match(grantRecord.lastRead.transcript, /^sha256:[a-f0-9]{64}$/)
    assert.equal(retained.length, 1, "the grant retains its native bytes before publishing a reference")
    assert.equal(grantRecord.lastRead.transcript, "sha256:" + retained[0].sha256)
    assert.equal(realReadFileSync(retained[0].path, "utf8"), "$ /Users/x\\n\\nCMUX-" + "a".repeat(32) + "-BEGIN\\n$ /Users/x")
    assert.equal(Number(realStatSync(retained[0].path).mode) & 0o777, 0o600, "raw transcript is private")
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
    const readFacts = owner.cmuxHistory.lastRead
    assert.equal(readFacts.kind, "read")
    assert.equal(readFacts.ownership, "surface")
    assert.equal(readFacts.screenLines, 24)
    assert.equal(typeof readFacts.receiptSha256, "string")
    assert.equal(readFacts.receiptSha256.length, 64, "the receipt is recorded by hash, never by text")
    const readRecord = JSON.parse(cmuxHistoryEvidence(owner.cmuxHistory)["collector.cmuxHistory"])
    assert.equal(readRecord.pane, "surface-uuid-1", "the record still names the surface the run acquired")
    assert.equal(JSON.stringify(readRecord).includes("/"), false, "no path separator reaches the record")
    assert.equal(retained.length, 3, "the grant and both native reads are observed by the artifact writer")
    assert.equal(readRecord.lastRead.transcript, "sha256:" + retained[2].sha256)
    await assert.rejects(createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32),
      out: process.stdout, darwinHosted: { receiptPath: "fixture" } }), /private capture directory and its artifact observer/)
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

// The state-domain getter fixture cannot prove which bundle/socket/pane the real owner reads.
// @failure A Mac cwd observation comes from a different GUI, pane or bundle despite a valid output binding.
test.each(["owned", "wrong socket", "wrong pane", "wrong bundle"])(
  "hosted WezTerm cwd reader binds custody: %s",
  (fault) => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "owned-wezterm-cwd-"))
    directories.push(captureDirectory)
    const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    import { EventEmitter } from "node:events"
    import { createHash } from "node:crypto"
    const fs = await import("node:fs"), cp = await import("node:child_process"), tty = await import("node:tty")
    const receipt = await import("./packages/terminfo.dev/src/disposable-receipt.ts")
    const fault = ${JSON.stringify(fault)}
    const executable = "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui", cli = "/Applications/WezTerm.app/Contents/MacOS/wezterm"
    const version = "20240203-110809-5046fc22"
    Object.defineProperty(process, "platform", { value: "darwin" })
    Object.assign(process.env, { TERMINFO_RUN_ID: "b".repeat(32), TERMINFO_MUX_KIND: "", TERMINFO_TARGET_ID: "wezterm",
      TERMINFO_TARGET_VERSION: version, TERMINFO_CAPTURE_DIRECTORY: ${JSON.stringify(captureDirectory)}, WEZTERM_PANE: "1", WEZTERM_UNIX_SOCKET: "/owned/gui.sock" })
    const device = { dev: 7n, rdev: 9n, ino: 11n, isSocket: () => true }
    const realReadFileSync = fs.readFileSync
    mock.module("node:fs", () => ({ ...fs, fstatSync: () => device, statSync: () => device,
      openSync: () => 7, closeSync: () => {},
      readFileSync: (path, ...args) => path === executable ? Buffer.from("gui") : path === cli ? Buffer.from("cli") : realReadFileSync(path, ...args),
      realpathSync: path => fault === "wrong bundle" && path === cli ? "/outside/wezterm" : path }))
    mock.module("node:tty", () => ({ ...tty, isatty: () => true }))
    let uri = "file://localhost/original", cliCalls = 0, pasteboard = ""
    const rows = Array(24).fill("")
    mock.module("node:child_process", () => ({ ...cp,
      execFileSync: (command, args, options) => {
        if (command === "/bin/ps") {
          const pid = Number(args[args.indexOf("-p") + 1])
          if (args.includes("tty=")) return "ttys004"
          if (!args.includes("pid=")) return "/sbin/launchd"
          return pid === process.pid ? process.pid + " 4242 /bin/zsh" : pid === 4242 ? "4242 1 " + executable : "1 0 /sbin/launchd"
        }
        assert.equal(command, cli); cliCalls++
        if (args[0] === "--version") return "wezterm " + version
        assert.equal(options.env.WEZTERM_UNIX_SOCKET, "/owned/gui.sock"); assert.equal(options.env.WEZTERM_PANE, "1")
        assert.deepEqual(args.slice(0, 2), ["cli", "--no-auto-start"])
        if (args[2] === "list-clients") return JSON.stringify([{ pid: fault === "wrong socket" ? 4343 : 4242 }])
        assert.equal(args[2], "list")
        return JSON.stringify([{ pane_id: fault === "wrong pane" ? 2 : 1, tty_name: "/dev/ttys004", cwd: uri }])
      },
      spawnSync: (command, args, options) => {
        if (command === "/usr/sbin/lsof") {
          assert.deepEqual(args, ["-a", "-U", "-p", "4242", "-Fn"])
          return { status: 0, signal: null, stdout: "n" + (fault === "wrong socket" ? "/foreign/gui.sock" : "/owned/gui.sock") + "\\n", stderr: "" }
        }
        if (args[0] === "--version") {
          assert.equal(command, cli)
          return { status: 0, signal: null, stdout: "wezterm " + version, stderr: "" }
        }
        assert.equal(command, cli); assert.equal(options.env.WEZTERM_UNIX_SOCKET, "/owned/gui.sock")
        cliCalls++
        if (args[2] === "list") return { status: 0, signal: null, stdout: JSON.stringify([{ pane_id: fault === "wrong pane" ? 2 : 1, tty_name: "/dev/ttys004", cwd: uri }]), stderr: "" }
        assert.equal(args[2], "get-text")
        return { status: 0, signal: null, stdout: Buffer.from(rows.join("\\n") + "\\n"), stderr: Buffer.alloc(0) }
      },
      spawn: file => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
        const tool = String(file)
        child.kill = () => true
        child.stdin = { end(text) {
          if (tool.endsWith("pbcopy")) pasteboard = String(text ?? "")
          const reply = tool.endsWith("pbcopy") ? "" : tool.endsWith("pbpaste") ? pasteboard + "\\n" : tool.endsWith("stty") ? "24 80\\n" : "\\n"
          queueMicrotask(() => { child.stdout.emit("data", Buffer.from(reply)); child.emit("close", 0) })
        } }
        if (tool.endsWith("stty")) queueMicrotask(() => { child.stdout.emit("data", Buffer.from("24 80\\n")); child.emit("close", 0) })
        return child
      }
    }))
    mock.module("./packages/terminfo.dev/src/disposable-receipt.ts", () => ({ ...receipt,
      readDisposableReceipt: () => ({ kind: "github-hosted-runner", sha256: "a".repeat(64), appLaunch: {
        executablePath: executable, executableSha256: createHash("sha256").update("gui").digest("hex") } }) }))
    const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const owner = await createOwnedTerminal({ captureRunId: "a".repeat(32), expectedLaunchRunId: "b".repeat(32), out: process.stdout, darwinHosted: { receiptPath: "fixture" }, onRetained() {} })
    try {
      assert.equal(typeof owner.readAppSemanticState, "function")
      const reading = await owner.readAppSemanticState("extensions.osc633-p", text => {
        const position = /^\\x1b\\[(\\d+);1H([\\s\\S]*)$/.exec(text)
        if (position) rows[Number(position[1]) - 1] = position[2]
        const control = /\\x1b\\]7;([^\\x07]*)\\x07/.exec(text)?.[1], target = /\\x1b\\]633;P;Cwd=([^\\x07]*)\\x07/.exec(text)?.[1]
        if (control !== undefined) uri = control
        if (target !== undefined) uri = "file://localhost" + target
      })
      if (fault === "owned") { assert.equal(reading.status, "measured", JSON.stringify(reading)); assert.equal(reading.target.after, reading.target.expected) }
      else {
        assert.equal(reading.status, "invalid", JSON.stringify(reading))
        if (fault === "wrong bundle") {
          assert.match(reading.reason, /bundle/)
          assert.equal(cliCalls, 0)
        } else {
          assert.equal(reading.reason, "Owned cwd observation failed; see private evidence")
          const privateEvidence = fs.readFileSync(${JSON.stringify(captureDirectory)} + "/" + reading.detail.privateEvidence, "utf8")
          assert.match(privateEvidence, fault === "wrong socket" ? /socket/ : /pane/)
        }
      }
    } finally { await owner.dispose() }
  `
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: join(import.meta.dirname, "../../.."),
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(result.status, result.stderr).toBe(0)
  },
)
