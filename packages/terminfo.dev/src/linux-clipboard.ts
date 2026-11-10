import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import type {
  AppSemanticReading,
  ClipboardFixture,
  LinuxMuxAttachmentProof,
  ProbeCallbackResult,
  TermProbeSource,
} from "@terminfo/probe-defs"
import { assertLiveExecutable, type LiveExecutable } from "./linux-capture.ts"
import { readScreenScrollback, resetScreenScrollback } from "./linux-screen-text.ts"

type MuxReceiptTarget = Pick<
  LinuxMuxAttachmentProof,
  | "mux"
  | "bootId"
  | "preflightCollector"
  | "outerShell"
  | "outerTerminal"
  | "executable"
  | "config"
  | "socketPath"
  | "session"
> & { kind: "mux"; collector: Pick<LinuxMuxAttachmentProof["collector"], "pid" | "startTicks"> }

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
  target?: { kind: "app" } | MuxReceiptTarget
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
  readonly getScrollback?: TermProbeSource["getScrollback"]
  readonly resetScrollback?: TermProbeSource["resetScrollback"]
  readonly profile: ClipboardReceipt["profile"]
  readonly config: string
  readonly permissions: string
  readonly summary: string
  readonly muxAttachmentProof?: LinuxMuxAttachmentProof
  assertOwned(): Promise<void>
  /** The same receipt owns the App window or the mux's own title, never the outer window for a mux. */
  readTitle(): Promise<string>
  withIconNameFixture?(
    write: (text: string) => void,
    work: (read: () => Promise<string | null>) => Promise<AppSemanticReading>,
    verify?: () => Promise<void>,
  ): Promise<AppSemanticReading>
  withClipboardFixture(
    work: Parameters<NonNullable<TermProbeSource["withClipboardFixture"]>>[0],
    trace: (event: ClipboardTraceEvent) => void,
    verify: () => Promise<void>,
  ): Promise<ProbeCallbackResult>
  dispose(): Promise<void>
}

type Trace = (event: ClipboardTraceEvent) => void

/** Single flight includes the finally restoration; failure there overrides the callback. */
export function createClipboardTransaction(
  baseline: string,
  io: {
    readText(trace: Trace, kind: ClipboardTraceEvent["kind"], verify: () => Promise<void>): Promise<string>
    writeText(text: string, trace: Trace, kind: ClipboardTraceEvent["kind"], verify: () => Promise<void>): Promise<void>
  },
  options?: {
    readonly writeDeadlineMs?: number
    readonly writePollMs?: number
    readonly muxState?: {
      snapshot(): Promise<{ readonly tmuxSetClipboard?: string; readonly buffers: readonly string[] }>
      restore(before: readonly string[]): Promise<void>
    }
  },
): LinuxClipboardAdapter["withClipboardFixture"] {
  let busy = false
  return async (work, trace, verify) => {
    if (busy) throw new Error("Owned clipboard transaction cannot nest or overlap")
    busy = true
    let result: ProbeCallbackResult | undefined
    let failure: unknown
    let muxSnapshot: { readonly tmuxSetClipboard?: string; readonly buffers: readonly string[] } | undefined
    try {
      await verify()
      if ((await io.readText(trace, "clipboard-read", verify)) !== baseline) {
        throw new Error("Owned clipboard baseline changed before callback")
      }
      if (options?.muxState) {
        muxSnapshot = await options.muxState.snapshot()
      }
      const fixture: ClipboardFixture = {
        baseline,
        ...(muxSnapshot?.tmuxSetClipboard !== undefined && { tmuxSetClipboard: muxSnapshot.tmuxSetClipboard }),
        ...(options?.writeDeadlineMs !== undefined && { writeDeadlineMs: options.writeDeadlineMs }),
        ...(options?.writePollMs !== undefined && { writePollMs: options.writePollMs }),
        readText: () => io.readText(trace, "clipboard-read", verify),
        writeText: (text) => io.writeText(text, trace, "clipboard-write", verify),
      }
      result = await work(fixture)
    } catch (error) {
      failure = error
    } finally {
      try {
        await io.writeText(baseline, trace, "clipboard-restore", verify)
        if ((await io.readText(trace, "clipboard-verify", verify)) !== baseline) {
          throw new Error("Owned clipboard restoration verification failed")
        }
        if (muxSnapshot && options?.muxState) {
          await options.muxState.restore(muxSnapshot.buffers)
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
  let status: string
  try {
    status = readFileSync(`/proc/${pid}/status`, "utf8")
  } catch (cause) {
    throw new Error(`Clipboard process status /proc/${pid}/status cannot be read`, { cause })
  }
  const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1])
  if (uid !== process.getuid?.()) throw new Error(`Clipboard process ${pid} has another owner`)
  try {
    return realpathSync(`/proc/${pid}/exe`)
  } catch (cause) {
    throw new Error(`Clipboard process executable /proc/${pid}/exe cannot be resolved`, { cause })
  }
}

type ProcessIdentity = LinuxMuxAttachmentProof["chain"][number] & { ppid: number }

function processIdentity(pid: number): ProcessIdentity {
  const executablePath = processExecutable(pid)
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)
  const ppid = Number(fields[1])
  const tty = Number(fields[4])
  const startTicks = fields[19]
  if (
    !Number.isSafeInteger(ppid) ||
    ppid < 0 ||
    !Number.isSafeInteger(tty) ||
    typeof startTicks !== "string" ||
    !/^\d+$/.test(startTicks)
  ) {
    throw new Error(`Owned clipboard process ${pid} has invalid parent, tty or start ticks`)
  }
  return { pid, ppid, startTicks, executablePath, ttyRdev: tty >>> 0 }
}

function ancestorOfCollector(pid: number): ProcessIdentity[] {
  const chain: ProcessIdentity[] = []
  let current = process.pid
  for (let depth = 0; depth < 64 && current > 1; depth++) {
    const identity = processIdentity(current)
    chain.push(identity)
    if (current === pid) return chain
    current = identity.ppid
  }
  throw new Error("Owned clipboard Kitty process no longer owns this collector ancestry")
}

function command(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024, env }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

export function parseLinuxClipboardReceipt(value: unknown): ClipboardReceipt {
  if (!value || typeof value !== "object") throw new Error("Invalid owned clipboard receipt")
  const r = value as Partial<ClipboardReceipt>
  if (
    r.schemaVersion !== 1 ||
    typeof r.runId !== "string" ||
    !/^[0-9a-f]{32}$/.test(r.runId) ||
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
  // Absent target is the existing direct-app receipt. A supplied discriminant is exhaustive.
  if (r.target !== undefined) {
    if (!r.target || typeof r.target !== "object") throw new Error("Owned clipboard receipt has invalid target")
    switch (r.target.kind) {
      case "app":
        break
      case "mux": {
        const target = r.target
        if (
          !["tmux", "screen"].includes(target.mux) ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(target.bootId ?? "") ||
          typeof target.socketPath !== "string" ||
          !target.socketPath.startsWith("/") ||
          typeof target.session !== "string" ||
          !/^[a-zA-Z0-9_-]+$/.test(target.session) ||
          !target.socketPath.includes(r.runId) ||
          !target.session.includes(r.runId)
        ) {
          throw new Error("Owned mux receipt has invalid kind, boot ID or run-scoped socket/session")
        }
        for (const identity of [target.preflightCollector, target.outerShell, target.outerTerminal, target.collector]) {
          if (
            !identity ||
            !Number.isSafeInteger(identity.pid) ||
            identity.pid < 2 ||
            typeof identity.startTicks !== "string" ||
            !/^\d+$/.test(identity.startTicks)
          ) {
            throw new Error("Owned mux receipt has invalid process identity")
          }
        }
        if (
          !Number.isSafeInteger(target.outerShell.ttyRdev) ||
          target.outerShell.ttyRdev <= 0 ||
          target.outerTerminal.pid !== r.terminal.pid ||
          target.collector.pid !== r.terminal.collectorPid ||
          target.preflightCollector.pid === target.collector.pid
        ) {
          throw new Error("Owned mux receipt has inconsistent shell, terminal or collector identity")
        }
        for (const file of [target.executable, target.config]) {
          if (
            !file ||
            typeof file.path !== "string" ||
            !file.path.startsWith("/") ||
            !/^[0-9a-f]{64}$/.test(file.sha256 ?? "")
          ) {
            throw new Error("Owned mux receipt has invalid executable or config digest")
          }
        }
        if (typeof target.executable.version !== "string" || !target.executable.version.trim()) {
          throw new Error("Owned mux receipt has no measured executable version")
        }
        break
      }
      default:
        throw new Error("Owned clipboard receipt has unknown target kind")
    }
  }
  return r as ClipboardReceipt
}

function assertProcessIdentity(
  actual: ProcessIdentity,
  expected: { pid: number; startTicks: string },
  label: string,
): void {
  if (actual.pid !== expected.pid || actual.startTicks !== expected.startTicks) {
    throw new Error(`Owned mux ${label} PID/start ticks differ from receipt`)
  }
}

function isPtyDevice(rdev: number): boolean {
  // Linux Unix98 PTY slave majors are 136..143; masters (/dev/ptmx) never count as displays.
  const major = ((rdev >>> 8) & 0xfff) | ((rdev >>> 20) & 0xfffff000)
  return major >= 136 && major <= 143
}

async function assertMuxAttachment(target: MuxReceiptTarget, chain: ProcessIdentity[]): Promise<ProcessIdentity> {
  if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== target.bootId) {
    throw new Error("Owned mux boot ID differs from receipt")
  }
  const collector = chain[0]
  const terminal = chain.at(-1)
  const shell = chain.at(-2)
  if (!collector || !terminal || !shell) throw new Error("Owned mux outer shell is absent from ancestry")
  assertProcessIdentity(collector, target.collector, "collector")
  assertProcessIdentity(terminal, target.outerTerminal, "outer terminal")
  assertProcessIdentity(shell, target.outerShell, "outer shell")
  if (shell.ttyRdev !== target.outerShell.ttyRdev || !isPtyDevice(shell.ttyRdev)) {
    throw new Error("Owned mux outer shell tty differs from receipt")
  }
  if (!isPtyDevice(collector.ttyRdev) || collector.ttyRdev === shell.ttyRdev) {
    throw new Error("Owned mux collector tty must be a distinct inner PTY")
  }
  const intermediates = chain.slice(1, -2)
  if (intermediates.length === 0 || intermediates.some((p) => p.executablePath !== target.executable.path)) {
    throw new Error("Owned mux ancestry contains an undeclared executable or no mux")
  }
  for (const p of intermediates) assertLiveExecutable(p.pid, target.executable)
  let configBytes: Buffer
  try {
    configBytes = readFileSync(target.config.path)
  } catch (cause) {
    throw new Error(`Owned mux config ${target.config.path} cannot be read`, { cause })
  }
  if (digest(configBytes) !== target.config.sha256) {
    throw new Error("Owned mux config digest differs from receipt")
  }
  const socket = (() => {
    try {
      return statSync(target.socketPath)
    } catch (cause) {
      throw new Error(`Owned mux socket ${target.socketPath} cannot be inspected`, { cause })
    }
  })()
  if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0) {
    throw new Error("Owned mux socket is not private and owned")
  }
  let client: ProcessIdentity
  switch (target.mux) {
    case "tmux": {
      const output = await command(target.executable.path, [
        "-S",
        target.socketPath,
        "list-clients",
        "-t",
        target.session,
        "-F",
        "#{pid}\t#{client_pid}\t#{client_tty}\t#{session_name}\t#{socket_path}",
      ])
      const rows = output.trim().split("\n").filter(Boolean)
      const row = rows[0]
      if (rows.length !== 1 || !row) {
        throw new Error(`Owned mux requires exactly one attached client; found ${rows.length}`)
      }
      const fields = row.split("\t")
      const [serverPid, pid, ttyPath, session, socketPath] = fields
      if (
        fields.length !== 5 ||
        typeof serverPid !== "string" ||
        !/^\d+$/.test(serverPid) ||
        session !== target.session ||
        socketPath !== target.socketPath ||
        typeof pid !== "string" ||
        !/^\d+$/.test(pid) ||
        typeof ttyPath !== "string" ||
        !/^\/dev\/pts\/\d+$/.test(ttyPath)
      ) {
        throw new Error("Owned mux client reports a foreign socket, session or tty")
      }
      if (intermediates[0]?.pid !== Number(serverPid)) {
        throw new Error("Owned mux tmux socket server differs from the collector's nearest tmux ancestor")
      }
      client = processIdentity(Number(pid))
      const tty = statSync(ttyPath)
      if (!tty.isCharacterDevice() || tty.rdev !== client.ttyRdev || client.ppid !== shell.pid) {
        throw new Error("Owned mux attached client tty or shell parent differs")
      }
      break
    }
    case "screen": {
      const [server, attachedClient] = intermediates
      if (
        intermediates.length !== 2 ||
        !server ||
        !attachedClient ||
        server.ppid !== attachedClient.pid ||
        attachedClient.ppid !== shell.pid ||
        basename(target.socketPath) !== `${server.pid}.${target.session}`
      ) {
        throw new Error("Owned mux Screen socket/server/client ancestry differs")
      }
      client = attachedClient
      // Screen has no queryable displays command. Its live server owns the socket inode
      // and one slave fd per display (measured on Screen 5.0.2, including a second client).
      const sockets = readFileSync("/proc/net/unix", "utf8")
        .trim()
        .split("\n")
        .map((row) => row.trim().split(/\s+/))
        .filter((row) => row[7] === target.socketPath)
      const inode = sockets[0]?.[6]
      if (sockets.length !== 1 || typeof inode !== "string" || !/^\d+$/.test(inode)) {
        throw new Error("Owned mux Screen socket is absent or ambiguous in kernel table")
      }
      const socketLink = `socket:[${inode}]`
      let ownsSocket = false
      const displays: number[] = []
      const directory = `/proc/${server.pid}/fd`
      let descriptors: string[]
      try {
        descriptors = readdirSync(directory)
      } catch (cause) {
        throw new Error(`Owned mux Screen server fd directory ${directory} cannot be read`, { cause })
      }
      for (const fd of descriptors) {
        const path = `${directory}/${fd}`
        let link: string
        try {
          link = readlinkSync(path)
        } catch (cause) {
          throw new Error(`Owned mux Screen server fd link ${path} cannot be read`, { cause })
        }
        if (link === socketLink) ownsSocket = true
        if (/^\/dev\/pts\/\d+$/.test(link)) displays.push(statSync(path).rdev)
      }
      if (!ownsSocket) throw new Error("Owned mux Screen server does not own the declared socket")
      if (displays.length !== 1 || displays[0] !== shell.ttyRdev) {
        throw new Error("Owned mux Screen requires exactly one attached display on the outer tty")
      }
      break
    }
  }
  if (client.executablePath !== target.executable.path || client.ttyRdev !== shell.ttyRdev) {
    throw new Error("Owned mux attached client executable or tty differs from outer shell")
  }
  assertLiveExecutable(client.pid, target.executable)
  assertProcessIdentity(processIdentity(client.pid), client, "attached client")
  return client
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
  expectedLaunchRunId: string,
  executable: LiveExecutable,
  captureRunId?: string,
  rows?: number | (() => Promise<number | undefined>),
): Promise<LinuxClipboardAdapter> {
  if (process.platform !== "linux") throw new Error("Owned clipboard fixture requires Linux")
  const receiptBytes = readFileSync(ownedReceipt(receiptPath))
  const receipt = parseLinuxClipboardReceipt(JSON.parse(receiptBytes.toString("utf8")) as unknown)
  const captureDirectory = process.env.TERMINFO_CAPTURE_DIRECTORY
  if (
    !captureDirectory ||
    receipt.runId !== expectedLaunchRunId ||
    process.env.DISPLAY !== receipt.display.name ||
    process.env.TERMINFO_CLIPBOARD_PROFILE !== receipt.profile ||
    receipt.terminal.collectorPid !== process.pid ||
    receipt.terminal.windowPid !== receipt.terminal.pid
  ) {
    throw new Error("Owned clipboard receipt does not match this collector run, display, or terminal")
  }
  const expectedPermissions = {
    default: "clipboard: read=ask,write=allow; OSC52: write=run,read=not-run",
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
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  let grantChain: ProcessIdentity[] | undefined
  let muxAttachmentProof: LinuxMuxAttachmentProof | undefined
  async function assertOwned(): Promise<void> {
    const chain = ancestorOfCollector(receipt.terminal.pid)
    if (
      basename(processExecutable(receipt.display.xvfbPid)) !== "Xvfb" ||
      !readFileSync(`/proc/${receipt.display.xvfbPid}/cmdline`, "utf8").includes("-displayfd")
    ) {
      throw new Error("Owned clipboard Xvfb or Kitty process no longer owns this collector")
    }
    processExecutable(receipt.terminal.pid)
    assertLiveExecutable(receipt.terminal.pid, executable)
    assertKittyClipboardProfile(
      receipt.profile,
      readFileSync(`/proc/${receipt.terminal.pid}/cmdline`, "utf8").split("\0").filter(Boolean),
    )
    const owner = (await command("xdotool", ["getwindowpid", receipt.terminal.windowId], env)).trim()
    if (owner !== String(receipt.terminal.pid)) throw new Error("Clipboard window owner differs from receipt")
    if (
      bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ||
      (grantChain && JSON.stringify(chain) !== JSON.stringify(grantChain))
    ) {
      throw new Error("Owned clipboard process chain changed since grant")
    }
    const target = receipt.target
    switch (target?.kind) {
      case undefined:
      case "app":
        break
      case "mux": {
        if (typeof captureRunId !== "string" || !/^[0-9a-f]{32}$/.test(captureRunId)) {
          throw new Error("Owned mux capture run ID is missing")
        }
        const attachedClient = await assertMuxAttachment(target, chain)
        const collector = chain[0]
        if (!collector) throw new Error("Owned mux collector is absent from ancestry")
        if (muxAttachmentProof) {
          assertProcessIdentity(attachedClient, muxAttachmentProof.attachedClient, "attached client")
        }
        muxAttachmentProof = {
          platform: "linux",
          mux: target.mux,
          bootId: target.bootId,
          receiptSha256: digest(receiptBytes),
          launchRunId: receipt.runId,
          captureRunId,
          preflightCollector: target.preflightCollector,
          outerShell: target.outerShell,
          outerTerminal: target.outerTerminal,
          collector: { pid: collector.pid, startTicks: collector.startTicks, ttyRdev: collector.ttyRdev },
          attachedClient: {
            pid: attachedClient.pid,
            startTicks: attachedClient.startTicks,
            ttyRdev: attachedClient.ttyRdev,
          },
          chain: chain.map(({ ppid: _ppid, ...identity }) => identity),
          executable: target.executable,
          config: target.config,
          socketPath: target.socketPath,
          session: target.session,
        }
        break
      }
      default:
        throw new Error(`Unknown owned clipboard target: ${JSON.stringify(target satisfies never)}`)
    }
    if (JSON.stringify(ancestorOfCollector(receipt.terminal.pid)) !== JSON.stringify(chain)) {
      throw new Error("Owned clipboard process chain changed during verification")
    }
    grantChain ??= chain
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
  async function readText(
    trace: Trace,
    kind: ClipboardTraceEvent["kind"],
    verify: () => Promise<void>,
  ): Promise<string> {
    const at = new Date().toISOString()
    try {
      await verify()
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
    kind: ClipboardTraceEvent["kind"],
    verify: () => Promise<void>,
  ): Promise<void> {
    const at = new Date().toISOString()
    try {
      await verify()
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
        if ((await readText(trace, "clipboard-read", verify)) === text) return
      } catch (error) {
        if (attempt === 29) throw error
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20)
      })
    }
    throw new Error("Owned xclip writer did not acquire the clipboard selection")
  }
  if ((await readText(() => {}, "clipboard-read", assertOwned)) !== baseline) {
    throw new Error("Initial owned clipboard readback differs from generated baseline")
  }
  const tmuxTarget = receipt.target?.kind === "mux" && receipt.target.mux === "tmux" ? receipt.target : undefined
  const listTmuxBuffers = async (target: MuxReceiptTarget): Promise<string[]> => {
    await assertOwned()
    const raw = await command(
      target.executable.path,
      ["-S", target.socketPath, "list-buffers", "-F", "#{buffer_name}"],
      env,
    )
    await assertOwned()
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }
  const withClipboardFixture = createClipboardTransaction(
    baseline,
    { readText, writeText },
    tmuxTarget
      ? {
          muxState: {
            async snapshot() {
              await assertOwned()
              const rawOption = await command(
                tmuxTarget.executable.path,
                ["-S", tmuxTarget.socketPath, "show-options", "-s", "-v", "set-clipboard"],
                env,
              )
              await assertOwned()
              const tmuxSetClipboard = rawOption.trim()
              if (!tmuxSetClipboard) throw new Error("Owned tmux set-clipboard option readback was empty")
              const buffers = await listTmuxBuffers(tmuxTarget)
              return { tmuxSetClipboard, buffers }
            },
            async restore(before) {
              const keep = new Set(before)
              const current = await listTmuxBuffers(tmuxTarget)
              for (const name of current) {
                if (!keep.has(name)) {
                  await assertOwned()
                  await command(
                    tmuxTarget.executable.path,
                    ["-S", tmuxTarget.socketPath, "delete-buffer", "-b", name],
                    env,
                  )
                  await assertOwned()
                }
              }
              const restored = await listTmuxBuffers(tmuxTarget)
              if (JSON.stringify(restored) !== JSON.stringify(before)) {
                throw new Error("Owned tmux paste buffer restoration verification failed")
              }
            },
          },
        }
      : undefined,
  )
  const screenTarget = receipt.target?.kind === "mux" && receipt.target.mux === "screen" ? receipt.target : undefined
  let screenRead = 0
  const adapter: LinuxClipboardAdapter = {
    profile: receipt.profile,
    config: receipt.config,
    permissions: receipt.permissions,
    assertOwned,
    async withIconNameFixture(write, work, verify = () => adapter.assertOwned()) {
      if (receipt.target?.kind === "mux") {
        return { status: "unavailable", reason: "A mux cannot read its outer App icon" }
      }
      const samples: object[] = []
      const read = async () => {
        const properties = []
        for (const name of ["WM_ICON_NAME", "_NET_WM_ICON_NAME"]) {
          await verify()
          // Explicit 8c preserves every byte, including empty, without quoted-string unescaping.
          const stdout = await command("xprop", ["-id", receipt.terminal.windowId, "-f", name, "8c", name], env)
          await verify()
          if (stdout.trim() === `${name}:  not found.` || stdout.trim() === `${name}:  no such atom on any window.`) {
            properties.push({ name, present: false, type: null, format: null, bytes: [], stdout })
            continue
          }
          const match = new RegExp(`^${name}\\(([A-Z0-9_]+)\\) = ?([0-9, ]*)\\n?$`).exec(stdout)
          const values = match?.[2]
          const type = match?.[1]
          if (!type || values === undefined || (values !== "" && !/^\d+(?:, \d+)*$/.test(values))) {
            throw new Error(`Malformed owned icon property ${name}: ${JSON.stringify(stdout)}`)
          }
          const bytes = values === "" ? [] : values.split(", ").map(Number)
          if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
            throw new Error(`Malformed owned icon property byte in ${name}: ${JSON.stringify(stdout)}`)
          }
          properties.push({ name, present: true, type, format: 8, bytes, stdout })
        }
        const snapshot = { properties }
        samples.push(snapshot)
        const [legacy, modern] = properties
        if (!modern || !legacy) throw new Error("Owned icon property pair incomplete")
        if (!modern.present && !legacy.present) return { value: null, snapshot, legacy: false }
        const property = modern.present ? modern : legacy
        if (!property.present || (modern.present ? property.type !== "UTF8_STRING" : property.type !== "STRING")) {
          throw new Error(
            "Owned icon property unavailable: expected UTF8_STRING _NET_WM_ICON_NAME or STRING WM_ICON_NAME",
          )
        }
        const value = modern.present
          ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(property.bytes))
          : Buffer.from(property.bytes).toString("latin1")
        if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Owned icon label cannot be restored through OSC")
        return { value, snapshot, legacy: !modern.present }
      }
      const title = async () => {
        await verify()
        const value = await adapter.readTitle()
        await verify()
        return value
      }
      let before: Awaited<ReturnType<typeof read>>
      let originalTitle: string
      try {
        before = await read()
        originalTitle = await title()
        if (/[\x00-\x1f\x7f]/.test(originalTitle)) throw new Error("Owned title cannot be restored through OSC")
      } catch (error) {
        return {
          status: "unavailable",
          reason: `Owned icon fixture setup: ${error instanceof Error ? error.message : String(error)}`,
          detail: { samples },
        }
      }
      let result: AppSemanticReading | undefined
      const cleanup: { title?: string; icon?: string; propertiesExact?: boolean; note?: string } = {}
      try {
        result = await work(async () => (await read()).value)
      } catch (error) {
        result = {
          status: "invalid",
          reason: `Owned icon read failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      } finally {
        try {
          await verify()
          const readSettledTitle = async () => {
            const deadline = Date.now() + 2000
            let seen = await title()
            while (seen !== originalTitle && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 25))
              seen = await title()
            }
            return seen
          }
          const restoreTitle = async () => {
            write(`\x1b]2;${originalTitle}\x07`)
            await verify()
            if ((await readSettledTitle()) === originalTitle) return "osc2" as const
            // WezTerm keeps the window title on the OSC 1 payload and ignores a later OSC 2.
            // OSC 0 clears that pin (#32998).
            write(`\x1b]0;${originalTitle}\x07`)
            await verify()
            await readSettledTitle()
            return "osc0" as const
          }
          if (before.value !== null) {
            write(`\x1b]1;${before.value}\x07`)
            await verify()
          }
          let restoredBy = await restoreTitle()
          cleanup.title = await title()
          if (cleanup.title !== originalTitle) {
            restoredBy = await restoreTitle()
            cleanup.title = await title()
          }
          const restored = await read()
          cleanup.icon = restored.value ?? undefined
          cleanup.propertiesExact =
            JSON.stringify(before.snapshot.properties) === JSON.stringify(restored.snapshot.properties)
          if (!cleanup.propertiesExact) {
            cleanup.note =
              "OSC-only cleanup cannot reproduce original property presence/type/bytes; exact before/after snapshots retained"
          }
          if (cleanup.title !== originalTitle) {
            throw new Error("Owned icon/title restoration readback differs from baseline")
          }
          if (restoredBy === "osc0" && cleanup.note === undefined) {
            cleanup.note = "OSC 1 held the icon name as the window title; OSC 0 cleared it"
          }
          if (before.value === null) {
            cleanup.note = "Baseline icon property was absent; OSC cleanup does not delete a property the probe created"
          } else if (!before.legacy && cleanup.icon !== before.value) {
            if (restoredBy === "osc0") {
              cleanup.note = "OSC 0 restored the title after OSC 2 did not; the icon property was not restored exactly"
            } else {
              throw new Error("Owned icon/title restoration readback differs from baseline")
            }
          } else if (before.legacy && cleanup.icon !== before.value) {
            cleanup.note = "OSC-only cleanup cannot reproduce original legacy icon value/type; snapshots retained"
          }
        } catch (error) {
          result = {
            status: "invalid",
            reason: `Owned icon cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }
      if (!result) throw new Error("Owned icon callback returned no result")
      return {
        ...result,
        detail: { ...result.detail, iconFixture: { before: before.snapshot, originalTitle, samples, cleanup } },
      }
    },
    async readTitle() {
      await assertOwned()
      const target = receipt.target
      const title =
        target?.kind !== "mux"
          ? await command("xdotool", ["getwindowname", receipt.terminal.windowId], env)
          : target.mux === "tmux"
            ? await command(
                target.executable.path,
                ["-S", target.socketPath, "display-message", "-p", "-t", target.session, "#{pane_title}"],
                env,
              )
            : await command(target.executable.path, ["-S", target.session, "-Q", "title"], {
                ...env,
                SCREENDIR: dirname(target.socketPath),
              })
      await assertOwned()
      // Preserve title whitespace, stripping only the command's one output line terminator.
      return title.replace(/\n$/u, "")
    },
    ...(screenTarget && {
      async getScrollback() {
        await assertOwned()
        const screenRows = typeof rows === "function" ? await rows() : rows
        await assertOwned()
        const read = readScreenScrollback({
          executable: screenTarget.executable.path,
          session: screenTarget.session,
          socketDirectory: dirname(screenTarget.socketPath),
          hardcopyPath: join(captureDirectory, `${screenTarget.session}-history-${++screenRead}.txt`),
          rows: screenRows,
          configPath: screenTarget.config.path,
        })
        await assertOwned()
        if (read.status === "refused") throw new Error(read.reason)
        return { totalLines: read.totalLines, screenLines: read.screenLines, capacity: read.capacity }
      },
      async resetScrollback() {
        await assertOwned()
        const reset = resetScreenScrollback({
          executable: screenTarget.executable.path,
          session: screenTarget.session,
          socketDirectory: dirname(screenTarget.socketPath),
          configPath: screenTarget.config.path,
        })
        await assertOwned()
        if (reset.status === "refused") throw new Error(reset.reason)
        return { status: "reset" as const, capacity: reset.capacity }
      },
    }),
    ...(receipt.target?.kind === "mux" &&
      receipt.target.mux === "tmux" && {
        async getScrollback() {
          await assertOwned()
          const target = receipt.target
          if (target?.kind !== "mux" || target.mux !== "tmux") throw new Error("Owned tmux history target lost")
          const raw = await command(
            target.executable.path,
            [
              "-S",
              target.socketPath,
              "display-message",
              "-p",
              "-t",
              target.session,
              "#{history_size} #{pane_height} #{scroll_position} #{pane_in_mode}",
            ],
            env,
          )
          await assertOwned()
          const fields = /^(\d+) (\d+) (\d*) ([01])\n?$/u.exec(raw)
          if (!fields) throw new Error(`Owned tmux scrollback reading malformed: ${JSON.stringify(raw)}`)
          const history = Number(fields[1]),
            rows = Number(fields[2])
          if (fields[4] === "1" && fields[3] === "") throw new Error("Owned tmux copy mode reports no scroll position")
          const fromBottom = fields[4] === "0" ? 0 : Number(fields[3])
          if (
            ![history, rows, fromBottom, history + rows].every(Number.isSafeInteger) ||
            rows < 1 ||
            fromBottom > history
          ) {
            throw new Error(`Owned tmux scrollback counts invalid: ${JSON.stringify(raw)}`)
          }
          return { totalLines: history + rows, screenLines: rows, viewportOffset: history - fromBottom }
        },
      }),
    get muxAttachmentProof() {
      return muxAttachmentProof ? globalThis.structuredClone(muxAttachmentProof) : undefined
    },
    summary: JSON.stringify({
      receiptSha256: digest(receiptBytes),
      receiptSource: receiptBytes.toString("utf8"),
      ...(muxAttachmentProof && { muxAttachmentProof }),
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
