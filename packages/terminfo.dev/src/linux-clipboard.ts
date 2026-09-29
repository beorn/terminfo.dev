import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, sep } from "node:path"
import type { ClipboardFixture, ProbeResult, TermContext } from "@terminfo/probe-defs"

interface ClipboardReceipt {
  schemaVersion: 1
  runId: string
  profile: "default" | "allow" | "deny-read"
  display: { name: string; number: number; displayFdPath: string; xvfbPid: number }
  terminal: { pid: number; collectorPid: number; windowId: string; windowPid: number }
  selection: {
    helperPid: number
    helperExecutable: { path: string; sha256: string }
    baselinePath: string
    baselineSha256: string
    initialReadSha256: string
  }
  config: string
  permissions: string
}

export interface ClipboardTraceEvent {
  kind: "clipboard-read" | "clipboard-write" | "clipboard-restore" | "clipboard-verify"
  at: string
  sha256?: string
  length?: number
  status?: "error"
  helperPid?: number
}

export interface LinuxClipboardAdapter {
  readonly profile: ClipboardReceipt["profile"]
  readonly config: string
  readonly permissions: string
  readonly summary: string
  withClipboardFixture(
    work: Parameters<NonNullable<TermContext["withClipboardFixture"]>>[0],
    trace: (event: ClipboardTraceEvent) => void,
  ): Promise<ProbeResult>
  dispose(): Promise<void>
}

type Trace = (event: ClipboardTraceEvent) => void

/** Single flight includes the finally restoration; failure there overrides the callback. */
export function createClipboardTransaction(
  baseline: string,
  io: {
    assertOwned(): Promise<void>
    readText(trace: Trace, kind?: ClipboardTraceEvent["kind"]): Promise<string>
    writeText(text: string, trace: Trace, kind?: ClipboardTraceEvent["kind"]): Promise<void>
  },
): LinuxClipboardAdapter["withClipboardFixture"] {
  let busy = false
  return async (work, trace) => {
    if (busy) throw new Error("Owned clipboard transaction cannot nest or overlap")
    busy = true
    let result: ProbeResult | undefined
    let failure: unknown
    try {
      await io.assertOwned()
      if ((await io.readText(trace)) !== baseline) throw new Error("Owned clipboard baseline changed before callback")
      const fixture: ClipboardFixture = {
        readText: () => io.readText(trace),
        writeText: (text) => io.writeText(text, trace),
      }
      result = await work(fixture)
    } catch (error) {
      failure = error
    } finally {
      try {
        await io.writeText(baseline, trace, "clipboard-restore")
        if ((await io.readText(trace, "clipboard-verify")) !== baseline) {
          throw new Error("Owned clipboard restoration verification failed")
        }
      } catch (error) {
        failure = new Error(
          `Owned clipboard restoration failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      busy = false
    }
    if (failure) throw failure
    if (!result) throw new Error("Owned clipboard callback returned no result")
    return result
  }
}

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

function ownedFile(path: string): string {
  const home = realpathSync(homedir())
  const real = realpathSync(path)
  if (!real.startsWith(`${home}${sep}`)) throw new Error(`Clipboard fixture path is outside private HOME: ${path}`)
  const stat = statSync(real)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error(`Clipboard fixture is not a private owned file: ${path}`)
  }
  return real
}

function ownedReceipt(path: string): string {
  const capture = process.env.TERMINFO_CAPTURE_DIRECTORY
  if (!capture || dirname(realpathSync(path)) !== realpathSync(dirname(capture))) {
    throw new Error("Clipboard receipt is outside the controlled capture directory")
  }
  const stat = statSync(path)
  if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error("Clipboard receipt is not an owned non-writable-by-others file")
  }
  return path
}

function processExecutable(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error(`Invalid owned clipboard PID ${pid}`)
  const status = readFileSync(`/proc/${pid}/status`, "utf8")
  const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1])
  if (uid !== process.getuid?.()) throw new Error(`Clipboard process ${pid} has another owner`)
  return realpathSync(`/proc/${pid}/exe`)
}

function ancestorOfCollector(pid: number): boolean {
  let current = process.pid
  for (let depth = 0; depth < 64 && current > 1; depth++) {
    if (current === pid) return true
    const stat = readFileSync(`/proc/${current}/stat`, "utf8")
    current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
  }
  return false
}

function command(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024, env }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function assertShape(value: unknown): ClipboardReceipt {
  if (!value || typeof value !== "object") throw new Error("Invalid owned clipboard receipt")
  const r = value as Partial<ClipboardReceipt>
  if (
    r.schemaVersion !== 1 ||
    !/^[0-9a-f]{32}$/.test(r.runId ?? "") ||
    !["default", "allow", "deny-read"].includes(r.profile ?? "") ||
    !r.display ||
    !r.terminal ||
    !r.selection ||
    typeof r.config !== "string" ||
    typeof r.permissions !== "string"
  ) {
    throw new Error("Invalid owned clipboard receipt shape")
  }
  for (const pid of [
    r.display.xvfbPid,
    r.terminal.pid,
    r.terminal.collectorPid,
    r.terminal.windowPid,
    r.selection.helperPid,
  ]) {
    if (!Number.isSafeInteger(pid) || (pid ?? 0) < 2) throw new Error("Owned clipboard receipt has invalid PID")
  }
  if (
    !Number.isSafeInteger(r.display.number) ||
    r.display.name !== `:${r.display.number}` ||
    typeof r.display.displayFdPath !== "string" ||
    !r.display.displayFdPath.startsWith("/") ||
    typeof r.terminal.windowId !== "string" ||
    !/^\d+$/.test(r.terminal.windowId) ||
    typeof r.selection.helperExecutable?.path !== "string" ||
    !r.selection.helperExecutable.path.startsWith("/") ||
    typeof r.selection.baselinePath !== "string" ||
    !r.selection.baselinePath.startsWith("/") ||
    !/^[0-9a-f]{64}$/.test(r.selection.helperExecutable?.sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(r.selection.baselineSha256 ?? "") ||
    r.selection.initialReadSha256 !== r.selection.baselineSha256
  ) {
    throw new Error("Owned clipboard receipt has invalid display, window, or digest")
  }
  return r as ClipboardReceipt
}

/** Compare the actual Kitty argv, not a shell-escaped display string in the receipt. */
function assertKittyClipboardProfile(profile: ClipboardReceipt["profile"], argv: string[]): void {
  const commandIndex = argv.findIndex((part) => part === "bun")
  const options = commandIndex < 0 ? argv : argv.slice(0, commandIndex)
  const controls = options.filter((part, index) => options[index - 1] === "-o" && part.startsWith("clipboard_control="))
  const expected = {
    default: [],
    allow: ["clipboard_control=write-clipboard read-clipboard"],
    "deny-read": ["clipboard_control=write-clipboard"],
  }[profile]
  if (JSON.stringify(controls) !== JSON.stringify(expected)) {
    throw new Error(`Owned Kitty argv clipboard control differs from ${profile} receipt`)
  }
}

/** A receipt is authority only after the live private display, process tree and selection agree. */
export async function createLinuxClipboardAdapter(
  receiptPath: string,
  expectedRunId: string,
): Promise<LinuxClipboardAdapter> {
  if (process.platform !== "linux") throw new Error("Owned clipboard fixture requires Linux")
  const receiptBytes = readFileSync(ownedReceipt(receiptPath))
  const receipt = assertShape(JSON.parse(receiptBytes.toString("utf8")) as unknown)
  if (
    receipt.runId !== expectedRunId ||
    process.env.DISPLAY !== receipt.display.name ||
    process.env.TERMINFO_CLIPBOARD_PROFILE !== receipt.profile ||
    receipt.terminal.collectorPid !== process.pid ||
    receipt.terminal.windowPid !== receipt.terminal.pid
  ) {
    throw new Error("Owned clipboard receipt does not match this collector run, display, or terminal")
  }
  const expectedPermissions = {
    default: "clipboard: read=ask,write=allow; OSC52=not-run",
    allow: "clipboard: read=allow,write=allow",
    "deny-read": "clipboard: read=deny,write=allow",
  }[receipt.profile]
  if (receipt.permissions !== expectedPermissions) {
    throw new Error("Owned clipboard profile and Kitty configuration disagree")
  }
  const displayNumber = readFileSync(ownedFile(receipt.display.displayFdPath), "utf8").trim()
  if (displayNumber !== String(receipt.display.number)) throw new Error("Owned Xvfb displayfd differs from receipt")
  const baseline = readFileSync(ownedFile(receipt.selection.baselinePath), "utf8")
  if (
    baseline !== `terminfo-owned-clipboard-${receipt.runId}` ||
    digest(baseline) !== receipt.selection.baselineSha256
  ) {
    throw new Error("Owned clipboard baseline is not this collector's generated nonce")
  }
  const helperExe = realpathSync(receipt.selection.helperExecutable.path)
  if (digest(readFileSync(helperExe)) !== receipt.selection.helperExecutable.sha256) {
    throw new Error("Owned xclip executable digest mismatch")
  }
  const env = { ...process.env, DISPLAY: receipt.display.name }
  async function assertOwned(): Promise<void> {
    if (
      basename(processExecutable(receipt.display.xvfbPid)) !== "Xvfb" ||
      !readFileSync(`/proc/${receipt.display.xvfbPid}/cmdline`, "utf8").includes("-displayfd") ||
      basename(processExecutable(receipt.terminal.pid)) !== "kitty" ||
      !ancestorOfCollector(receipt.terminal.pid)
    ) {
      throw new Error("Owned clipboard Xvfb or Kitty process no longer owns this collector")
    }
    assertKittyClipboardProfile(
      receipt.profile,
      readFileSync(`/proc/${receipt.terminal.pid}/cmdline`, "utf8").split("\0").filter(Boolean),
    )
    const owner = (await command("xdotool", ["getwindowpid", receipt.terminal.windowId], env)).trim()
    if (owner !== String(receipt.terminal.pid)) throw new Error("Clipboard window owner differs from receipt")
  }
  await assertOwned()
  if (processExecutable(receipt.selection.helperPid) !== helperExe) {
    throw new Error("Owned clipboard selection helper executable differs from receipt")
  }
  const children = new Set<ChildProcess>()
  const log = (trace: Trace, kind: ClipboardTraceEvent["kind"], text: string, helperPid?: number) =>
    trace({
      kind,
      at: new Date().toISOString(),
      sha256: digest(text),
      length: Buffer.byteLength(text),
      ...(helperPid && { helperPid }),
    })
  async function readText(trace: Trace, kind: ClipboardTraceEvent["kind"] = "clipboard-read"): Promise<string> {
    const at = new Date().toISOString()
    try {
      await assertOwned()
      const text = await command(helperExe, ["-quiet", "-selection", "clipboard", "-o"], env)
      trace({ kind, at, sha256: digest(text), length: Buffer.byteLength(text) })
      return text
    } catch (error) {
      trace({ kind, at, status: "error" })
      throw error
    }
  }
  async function writeText(
    text: string,
    trace: Trace,
    kind: ClipboardTraceEvent["kind"] = "clipboard-write",
  ): Promise<void> {
    const at = new Date().toISOString()
    try {
      await assertOwned()
    } catch (error) {
      trace({ kind, at, status: "error" })
      throw error
    }
    const child = spawn(helperExe, ["-quiet", "-selection", "clipboard", "-i"], {
      env,
      stdio: ["pipe", "ignore", "ignore"],
    })
    let childError: Error | undefined
    child.once("error", (error) => {
      childError = error
    })
    child.stdin.once("error", (error) => {
      childError = error
    })
    children.add(child)
    child.once("exit", () => children.delete(child))
    if (!child.pid) {
      trace({ kind, at, status: "error" })
      throw new Error("Owned xclip writer failed to start")
    }
    child.stdin.end(text)
    log(trace, kind, text, child.pid)
    for (let attempt = 0; attempt < 30; attempt++) {
      if (childError) throw childError
      try {
        if ((await readText(trace)) === text) return
      } catch (error) {
        if (attempt === 29) throw error
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20)
      })
    }
    throw new Error("Owned xclip writer did not acquire the clipboard selection")
  }
  if ((await readText(() => {})) !== baseline) {
    throw new Error("Initial owned clipboard readback differs from generated baseline")
  }
  const withClipboardFixture = createClipboardTransaction(baseline, { assertOwned, readText, writeText })
  const adapter: LinuxClipboardAdapter = {
    profile: receipt.profile,
    config: receipt.config,
    permissions: receipt.permissions,
    summary: JSON.stringify({
      receiptSha256: digest(receiptBytes),
      runId: receipt.runId,
      profile: receipt.profile,
      config: receipt.config,
      permissions: receipt.permissions,
      display: { name: receipt.display.name, xvfbPid: receipt.display.xvfbPid },
      terminal: receipt.terminal,
      selection: {
        helperPid: receipt.selection.helperPid,
        helperExecutableSha256: receipt.selection.helperExecutable.sha256,
        baselineSha256: receipt.selection.baselineSha256,
        initialReadSha256: receipt.selection.initialReadSha256,
      },
    }),
    withClipboardFixture,
    async dispose() {
      await Promise.all(
        [...children].map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve()
                return
              }
              const timer = setTimeout(() => reject(new Error(`Owned xclip PID ${child.pid} did not exit`)), 3000)
              child.once("exit", () => {
                clearTimeout(timer)
                resolve()
              })
              child.kill("SIGTERM")
            }),
        ),
      )
    },
  }
  return adapter
}
