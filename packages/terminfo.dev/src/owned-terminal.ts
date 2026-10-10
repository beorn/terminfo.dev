import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync, type BigIntStats } from "node:fs"
import { isatty, WriteStream } from "node:tty"
import { readDisposableReceipt } from "./disposable-receipt.ts"
import type { LiveExecutable } from "./linux-capture.ts"
import { createLinuxClipboardAdapter, type LinuxClipboardAdapter } from "./linux-clipboard.ts"
import { wasCollectorOpenedControllingTTY } from "./tty.ts"

export type GeometrySource =
  | "stty size on a /proc/self/fd reopen of the verified output device"
  | "stty size on a /dev/fd reopen of the verified output device"
  | "unavailable: no verified output device"

export type GeometryMeasurement =
  | {
      status: "measured"
      at: string
      source: GeometrySource
      rows: number
      cols: number
      stdout: string
      stderr: string
    }
  | { status: "unavailable"; at: string; source: GeometrySource; diagnostic: string; stdout: string; stderr: string }

export interface TerminalAppOwnerAssertion {
  asserter: "terminfo-admin"
  launchRunId: string
  workerPid: number
  windowId: number
  tabTty: string
  intendedVersion: string
}

/** The request is an admin assertion; the worker independently verifies every observable field. */
export function parseTerminalAppOwner(value: unknown): TerminalAppOwnerAssertion {
  const invalid = () => new Error("Invalid Terminal.app owner assertion")
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const object = value as Record<string, unknown>
  const keys = ["asserter", "launchRunId", "workerPid", "windowId", "tabTty", "intendedVersion"]
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) throw invalid()
  if (
    object.asserter !== "terminfo-admin" ||
    typeof object.launchRunId !== "string" ||
    !/^[0-9a-f]{32}$/.test(object.launchRunId) ||
    typeof object.workerPid !== "number" ||
    !Number.isSafeInteger(object.workerPid) ||
    object.workerPid < 1 ||
    typeof object.windowId !== "number" ||
    !Number.isSafeInteger(object.windowId) ||
    object.windowId < 1 ||
    typeof object.tabTty !== "string" ||
    !/^\/dev\/tty[a-zA-Z0-9._-]+$/.test(object.tabTty) ||
    typeof object.intendedVersion !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,79}$/.test(object.intendedVersion)
  ) {
    throw invalid()
  }
  return {
    asserter: object.asserter,
    launchRunId: object.launchRunId,
    workerPid: object.workerPid,
    windowId: object.windowId,
    tabTty: object.tabTty,
    intendedVersion: object.intendedVersion,
  }
}

export interface OwnedTerminal {
  readonly geometryAtGrant: GeometryMeasurement
  readonly geometrySource: Exclude<GeometrySource, "unavailable: no verified output device">
  readonly summary: string
  readonly clipboard?: LinuxClipboardAdapter
  readGeometry(): Promise<GeometryMeasurement>
  dispose(): Promise<void>
}

type Device = { dev: string; rdev: string; ino: string }
const device = (stat: BigIntStats): Device => ({
  dev: stat.dev.toString(),
  rdev: stat.rdev.toString(),
  ino: stat.ino.toString(),
})
const sameDevice = (left: Device, right: Device): boolean =>
  left.dev === right.dev && left.rdev === right.rdev && left.ino === right.ino

type LinuxBinding = {
  platform: "linux"
  matched: "pty" | "dev-tty"
  selectedFd: number
  controllingTtyNr: number
  inputRdev: number
  outputRdev: number
  outputDevice: Device
}
type DarwinBinding = {
  platform: "darwin"
  selectedFd: number
  controllingTty: string
  tabTty: string
  inputDevice: Device
  outputDevice: Device
}

export type HostedDarwinAppId = "terminal-app" | "iterm2" | "ghostty" | "alacritty"
export type HostedDarwinApp = { id: HostedDarwinAppId; comm: string }
export type AncestryRow = { pid: number; ppid: number; comm: string }

const HOSTED_DARWIN_EXECUTABLE: Record<string, HostedDarwinApp> = {
  Terminal: { id: "terminal-app", comm: "Terminal" },
  iTerm2: { id: "iterm2", comm: "iTerm2" },
  ghostty: { id: "ghostty", comm: "ghostty" },
  alacritty: { id: "alacritty", comm: "alacritty" },
  Alacritty: { id: "alacritty", comm: "alacritty" },
}
const HOSTED_DARWIN_COMMS = new Set(["Terminal", "iTerm2", "ghostty", "alacritty"])

/** Map a github-hosted-runner appLaunch.executablePath to the four hosted Mac apps. */
export function hostedDarwinAppFromExecutablePath(executablePath: string): HostedDarwinApp {
  const base = executablePath.split("/").pop() ?? ""
  const app = HOSTED_DARWIN_EXECUTABLE[base]
  if (!app) {
    throw new Error(
      `Hosted Darwin receipt executable is not one of Terminal, iTerm2, ghostty, alacritty: ${JSON.stringify(executablePath)}`,
    )
  }
  return app
}

/** Grant-time process identity: the probe's ancestry must reach the receipt's app, never a different terminal. */
export function requireHostedDarwinAppAncestor(expectedComm: string, rows: AncestryRow[]): AncestryRow {
  const other = rows.find((row) => HOSTED_DARWIN_COMMS.has(row.comm) && row.comm !== expectedComm)
  if (other) {
    throw new Error(
      `Hosted Darwin ancestry reached ${other.comm} (pid ${other.pid}) while the receipt names ${expectedComm}`,
    )
  }
  const named = rows.find((row) => row.comm === expectedComm)
  if (!named) {
    const found = [...rows]
      .reverse()
      .map((row) => `${row.comm} (pid ${row.pid})`)
      .join(", ")
    throw new Error(`Hosted Darwin ancestry never reached ${expectedComm}; found ${found}`)
  }
  return named
}

function readProcessAncestry(startPid: number): AncestryRow[] {
  const rows: AncestryRow[] = []
  const seen = new Set<number>()
  let pid = startPid
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid)
    const line = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "comm="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 256,
    }).trim()
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    const pidText = match?.[1]
    const ppidText = match?.[2]
    const comm = match?.[3]
    if (!pidText || !ppidText || comm === undefined) {
      throw new Error(`Hosted Darwin ancestry ps parse failed for pid ${pid}: ${JSON.stringify(line)}`)
    }
    const row = { pid: Number(pidText), ppid: Number(ppidText), comm: comm.trim() }
    rows.push(row)
    if (row.comm === "launchd" || row.pid === 1 || row.ppid === 0 || row.ppid === row.pid) break
    pid = row.ppid
  }
  return rows
}
type OutputBinding = LinuxBinding | DarwinBinding

function selectedFd(out: NodeJS.WriteStream): number {
  const fd = (out as { fd?: unknown }).fd
  if (
    typeof fd !== "number" ||
    !Number.isSafeInteger(fd) ||
    fd < 0 ||
    (out !== process.stdout && !(out instanceof WriteStream))
  ) {
    throw new Error(`Owned output is not a real TTY stream (fd ${String(fd)})`)
  }
  if (!isatty(0)) throw new Error("Owned input fd 0 is not a TTY")
  if (!isatty(fd)) throw new Error(`Owned output fd ${fd} is not a TTY`)
  return fd
}

/** Linux keeps the existing controlling tty_nr and collector-opened alias rule. */
function linuxOutput(out: NodeJS.WriteStream): LinuxBinding {
  const fd = selectedFd(out)
  const stat = readFileSync("/proc/self/stat", "utf8")
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)
  const ttyNumber = Number(fields[4])
  if (!Number.isInteger(ttyNumber) || ttyNumber < -2147483648 || ttyNumber > 2147483647) {
    throw new Error(`Invalid controlling tty_nr ${String(fields[4])}`)
  }
  const controlling = ttyNumber >>> 0
  const inputDevice = device(fstatSync(0, { bigint: true }))
  if (controlling === 0 || inputDevice.rdev !== String(controlling)) {
    throw new Error(`Owned input device ${inputDevice.rdev} differs from controlling tty_nr ${controlling}`)
  }
  const inputRdev = controlling
  const outputDevice = device(fstatSync(fd, { bigint: true }))
  if (outputDevice.rdev === String(controlling)) {
    return {
      platform: "linux",
      matched: "pty",
      selectedFd: fd,
      controllingTtyNr: controlling,
      inputRdev,
      outputRdev: controlling,
      outputDevice,
    }
  }
  if (wasCollectorOpenedControllingTTY(out) && outputDevice.rdev === "1280") {
    return {
      platform: "linux",
      matched: "dev-tty",
      selectedFd: fd,
      controllingTtyNr: controlling,
      inputRdev,
      outputRdev: 1280,
      outputDevice,
    }
  }
  throw new Error(`Owned output device ${outputDevice.rdev} differs from controlling tty_nr ${controlling}`)
}

/** Darwin's ps name is paired with a same-read stat of that named PTY. */
function darwinOutput(out: NodeJS.WriteStream, assertion: TerminalAppOwnerAssertion): DarwinBinding {
  if (out !== process.stdout || (out as { fd?: unknown }).fd !== 1) {
    throw new Error("Terminal.app owned output requires the daemon's real stdout PTY")
  }
  selectedFd(out)
  const controllingTty = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "tty="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 256,
  }).trim()
  if (!/^tty[a-zA-Z0-9._-]+$/.test(controllingTty)) {
    throw new Error(`Terminal.app worker has no valid controlling TTY: ${JSON.stringify(controllingTty)}`)
  }
  if (`/dev/${controllingTty}` !== assertion.tabTty) {
    throw new Error(`Terminal.app worker TTY /dev/${controllingTty} differs from asserted tab ${assertion.tabTty}`)
  }
  const inputDevice = device(fstatSync(0, { bigint: true }))
  const outputDevice = device(fstatSync(1, { bigint: true }))
  const tabDevice = device(statSync(assertion.tabTty, { bigint: true }))
  if (!sameDevice(inputDevice, outputDevice) || !sameDevice(outputDevice, tabDevice)) {
    throw new Error("Terminal.app input, selected stdout and asserted tab PTY device identities differ")
  }
  return { platform: "darwin", selectedFd: 1, controllingTty, tabTty: assertion.tabTty, inputDevice, outputDevice }
}

/** Hosted Darwin PTY bind: fd0, selected out, and ps-tty are one device. Never calls darwinOutput. */
function darwinHostedOutput(out: NodeJS.WriteStream): DarwinBinding {
  if (process.platform !== "darwin") throw new Error("Owned Darwin hosted terminal requires Darwin")
  const fd = selectedFd(out)
  const controllingTty = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "tty="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 256,
  }).trim()
  if (!/^tty[a-zA-Z0-9._-]+$/.test(controllingTty)) {
    throw new Error(`Hosted Darwin worker has no valid controlling TTY: ${JSON.stringify(controllingTty)}`)
  }
  const ttyPath = `/dev/${controllingTty}`
  const inputDevice = device(fstatSync(0, { bigint: true }))
  const outputDevice = device(fstatSync(fd, { bigint: true }))
  const ttyDevice = device(statSync(ttyPath, { bigint: true }))
  if (!sameDevice(inputDevice, outputDevice) || !sameDevice(outputDevice, ttyDevice)) {
    throw new Error("Hosted Darwin input, selected output and controlling TTY device identities differ")
  }
  return {
    platform: "darwin",
    selectedFd: fd,
    controllingTty,
    tabTty: ttyPath,
    inputDevice,
    outputDevice,
  }
}

const geometrySource = (binding: OutputBinding): OwnedTerminal["geometrySource"] =>
  binding.platform === "linux"
    ? "stty size on a /proc/self/fd reopen of the verified output device"
    : "stty size on a /dev/fd reopen of the verified output device"

/** Always reopen the selected output, verify that clone, then ask stty for a fresh size. */
async function readBoundGeometry(binding: OutputBinding): Promise<GeometryMeasurement> {
  const at = new Date().toISOString()
  const source = geometrySource(binding)
  const unavailable = (diagnostic: string, stdout = "", stderr = ""): GeometryMeasurement => ({
    status: "unavailable",
    at,
    source,
    diagnostic,
    stdout,
    stderr,
  })
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let diagnostic: string | undefined
    let settled = false
    let inputFd: number | undefined
    try {
      const path = binding.platform === "linux" ? "/proc/self/fd" : "/dev/fd"
      inputFd = openSync(`${path}/${binding.selectedFd}`, constants.O_RDONLY | constants.O_NOCTTY)
      const reopened = device(fstatSync(inputFd, { bigint: true }))
      if (!isatty(inputFd) || !sameDevice(reopened, binding.outputDevice)) {
        closeSync(inputFd)
        inputFd = undefined
        resolve(unavailable(`stty reopened selected output fd ${binding.selectedFd} is not the verified output device`))
        return
      }
    } catch (error) {
      if (inputFd !== undefined) closeSync(inputFd)
      resolve(
        unavailable(
          `stty could not reopen selected output fd ${binding.selectedFd}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      return
    }
    let child: ChildProcess
    try {
      child = spawn(binding.platform === "darwin" ? "/bin/stty" : "stty", ["size"], {
        stdio: [inputFd, "pipe", "pipe"],
      })
    } catch (error) {
      closeSync(inputFd)
      resolve(unavailable(`stty size failed to start: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeSync(inputFd)
      if (!diagnostic && code !== 0) diagnostic = `stty size exited ${String(code)}`
      const match = /^(\d+) (\d+)\n?$/.exec(stdout)
      const rows = Number(match?.[1])
      const cols = Number(match?.[2])
      if (!diagnostic && match && Number.isSafeInteger(rows) && rows > 0 && Number.isSafeInteger(cols) && cols > 0) {
        resolve({ status: "measured", at, source, rows, cols, stdout, stderr })
      } else {
        resolve(unavailable(diagnostic ?? "stty size returned invalid rows and cols", stdout, stderr))
      }
    }
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8")
      if (Buffer.byteLength(next) > 256) {
        diagnostic = "stty size output exceeded 256 bytes"
        child.kill("SIGKILL")
      }
      return next.slice(0, 256)
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.on("error", (error) => {
      diagnostic = `stty size failed: ${error.message}`
      finish(null)
    })
    child.on("close", finish)
    const timer = setTimeout(() => {
      diagnostic = "stty size timed out after 1000 ms"
      child.kill("SIGKILL")
      finish(null)
    }, 1000)
  })
}

const verifiedTerminalOwners = new WeakMap<OwnedTerminal, { captureRunId: string; out: NodeJS.WriteStream }>()

export function ownedTerminalVerifiedFor(
  owner: OwnedTerminal | undefined,
  captureRunId: string,
  out: NodeJS.WriteStream,
): boolean {
  const grant = owner && verifiedTerminalOwners.get(owner)
  return grant !== undefined && grant.captureRunId === captureRunId && grant.out === out
}

/** The only path that registers a grant: platform validation, optional Linux fixture, then geometry. */
export async function createOwnedTerminal(options: {
  captureRunId: string
  out: NodeJS.WriteStream
  expectedLaunchRunId: string
  linux?: { receiptPath: string; executable: LiveExecutable }
  terminalApp?: TerminalAppOwnerAssertion
  darwinHosted?: { receiptPath: string }
}): Promise<OwnedTerminal> {
  const { captureRunId, out, expectedLaunchRunId, linux, terminalApp, darwinHosted } = options
  if (!/^[0-9a-f]{32}$/.test(captureRunId)) throw new Error("Invalid capture run ID for owned terminal")
  if (!/^[0-9a-f]{32}$/.test(expectedLaunchRunId)) throw new Error("Invalid launch run ID for owned terminal")
  const armCount = [linux, terminalApp, darwinHosted].filter(Boolean).length
  if (armCount !== 1) throw new Error("Owned terminal requires exactly one platform receipt")
  let binding: OutputBinding
  let hostedApp: HostedDarwinApp | undefined
  let hostedAncestor: AncestryRow | undefined
  let hostedReceiptSha256: string | undefined
  if (linux) {
    if (process.platform !== "linux") throw new Error("Owned Linux fixture requires Linux")
    binding = linuxOutput(out)
  } else if (terminalApp) {
    if (process.platform !== "darwin") throw new Error("Terminal.app owner requires Darwin")
    const assertion = parseTerminalAppOwner(terminalApp)
    if (
      assertion.launchRunId !== expectedLaunchRunId ||
      process.env.TERMINFO_RUN_ID !== expectedLaunchRunId ||
      assertion.workerPid !== process.pid
    ) {
      throw new Error("Terminal.app owner assertion differs from this worker launch run or PID")
    }
    binding = darwinOutput(out, assertion)
  } else {
    if (!darwinHosted) throw new Error("Owned terminal requires exactly one platform receipt")
    if (process.platform !== "darwin") throw new Error("Owned Darwin hosted terminal requires Darwin")
    const receipt = readDisposableReceipt(darwinHosted.receiptPath)
    if (receipt.kind !== "github-hosted-runner") {
      throw new Error(
        `Owned Darwin hosted terminal requires a github-hosted-runner receipt, not ${JSON.stringify(receipt.kind)}`,
      )
    }
    const executablePath = receipt.appLaunch?.executablePath
    if (!executablePath) {
      throw new Error("Hosted Darwin github-hosted-runner receipt names no appLaunch executable")
    }
    hostedApp = hostedDarwinAppFromExecutablePath(executablePath)
    binding = darwinHostedOutput(out)
    hostedAncestor = requireHostedDarwinAppAncestor(hostedApp.comm, readProcessAncestry(process.pid))
    hostedReceiptSha256 = receipt.sha256
  }
  let clipboard: LinuxClipboardAdapter | undefined
  try {
    if (linux) clipboard = await createLinuxClipboardAdapter(linux.receiptPath, expectedLaunchRunId, linux.executable)
    const geometryAtGrant = await readBoundGeometry(binding)
    const source = geometrySource(binding)
    const summary = JSON.stringify({
      platform: binding.platform,
      outputBinding: binding,
      geometryAtGrant,
      ...(terminalApp && {
        ownerAssertion: parseTerminalAppOwner(terminalApp),
        ownerAssertionSource: "authenticated-admin-request",
      }),
      ...(hostedApp && {
        darwinHosted: {
          appId: hostedApp.id,
          ancestor: hostedAncestor,
          receiptKind: "github-hosted-runner",
          receiptSha256: hostedReceiptSha256,
        },
      }),
    })
    const owner: OwnedTerminal = {
      geometryAtGrant,
      geometrySource: source,
      summary,
      ...(clipboard && { clipboard }),
      async readGeometry() {
        if (!verifiedTerminalOwners.has(owner)) throw new Error("Owned geometry read has no live bound capture")
        const current = linux
          ? linuxOutput(out)
          : terminalApp
            ? darwinOutput(out, parseTerminalAppOwner(terminalApp))
            : darwinHostedOutput(out)
        if (
          current.platform !== binding.platform ||
          current.selectedFd !== binding.selectedFd ||
          !sameDevice(current.outputDevice, binding.outputDevice) ||
          (current.platform === "linux" &&
            binding.platform === "linux" &&
            current.controllingTtyNr !== binding.controllingTtyNr)
        ) {
          throw new Error("Owned geometry output binding changed")
        }
        return readBoundGeometry(current)
      },
      async dispose() {
        verifiedTerminalOwners.delete(owner)
        await clipboard?.dispose()
      },
    }
    verifiedTerminalOwners.set(owner, { captureRunId, out })
    return owner
  } catch (error) {
    await clipboard?.dispose()
    throw error
  }
}
