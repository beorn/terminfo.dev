import { readMuxAllowPassthrough } from "./notification-defaults.ts"
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
import { mappedLibX11, readSelectionTaker, selectionOwnerIo, type SelectionTakerRead } from "./linux-selection-owner.ts"

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
    /** X11 PRIMARY, owned by a second helper only when a paste route reads it (xterm Shift+Insert, #32164). */
    primary?: { helperPid: number; baselinePath: string; baselineSha256: string; initialReadSha256: string }
  }
  config: string
  permissions: string
  target?: { kind: "app" } | MuxReceiptTarget
}

export interface ClipboardTraceEvent {
  kind:
    | "clipboard-read"
    | "clipboard-write"
    | "clipboard-restore"
    | "clipboard-verify"
    | "clipboard-key"
    | "clipboard-owner-exit"
    | "clipboard-reown"
  at: string
  sha256?: string
  length?: number
  status?: "error"
  helperPid?: number
  /** clipboard-owner-exit: the helper's exit code and signal, as Node reported them when it exited (33003). */
  exitCode?: number | null
  signal?: string | null
  /** clipboard-owner-exit: false when the helper is not our child, so only its absence was seen, at `at`. */
  exitObserved?: boolean
  /** clipboard-owner-exit: who owned the selection when our helper's exit was seen (33693); read: false names why not. */
  taker?: SelectionTakerRead
  /** clipboard-owner-exit: the taker was read and no helper of ours could be it, so the pre-flight may re-own once. */
  takerOurs?: boolean
  /** clipboard-owner-exit: true only when the taker's pid and its client's window are this run's outer terminal. */
  takerOuterTerminal?: boolean
  /** clipboard-key: the keysym pressed and released through XTEST. */
  key?: string
  /** clipboard-key: the focused window read back before the press. */
  windowId?: string
  /** clipboard-key: X server time bracketing the press, ms mod 2^32. */
  xTimeMs?: [number, number]
}

export interface LinuxClipboardAdapter {
  readonly getScrollback?: TermProbeSource["getScrollback"]
  readonly resetScrollback?: TermProbeSource["resetScrollback"]
  /** Set only by the hosted Darwin pasteboard. Linux receipts leave it absent. */
  readonly pasteboard?: "darwin"
  /**
   * The app this pasteboard belongs to, as the receipt's launched executable resolves it
   * (`HOSTED_DARWIN_EXECUTABLE`). A FIELD, because a gate that binds a fixture to a run must not
   * read the human sentence in `summary` (#31741, @cto a6f2b5fd: matched by field, never by parsing
   * that sentence). Set only by the hosted Darwin pasteboard; Linux leaves it absent.
   */
  readonly pasteboardApp?: string
  readonly config: string | null
  readonly profile: ClipboardReceipt["profile"]
  readonly permissions: string
  readonly summary: string
  readonly muxAttachmentProof?: LinuxMuxAttachmentProof
  /**
   * tmux's live `allow-passthrough`, the option that decides whether anything an application writes inside a
   * pane reaches the outer terminal at all (#33333). Absent unless this run owns a tmux server.
   */
  readonly readAllowPassthrough?: () => Promise<{ readonly value: string } | { readonly reason: string }>
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
  /** The same transaction over X11 PRIMARY; present only when the receipt owns a PRIMARY baseline. */
  withPrimaryFixture?: LinuxClipboardAdapter["withClipboardFixture"]
  dispose(): Promise<void>
}

type Trace = (event: ClipboardTraceEvent) => void

/** How a selection helper ended: Node's exit code and signal, and when (33003, @cto 67370e55). */
export interface ClipboardHelperExit {
  readonly code: number | null
  readonly signal: string | null
  readonly at: string
}

/** Whether the helper that should be serving a selection's baseline is still running. */
export type ClipboardOwnerState =
  | { readonly helperPid: number; readonly alive: true }
  | {
      readonly helperPid: number
      readonly alive: false
      readonly exit?: ClipboardHelperExit
      /** Who held the selection when the exit was seen (33693); absent when nothing could read it. */
      readonly taker?: SelectionTakerRead
      /** True only when the taker was read and could be a helper of ours; re-own needs false. */
      readonly takerOurs?: boolean
      /** True only when the taker is proven to be this run's outer terminal (33968); re-own needs true. */
      readonly takerOuterTerminal?: boolean
    }

/**
 * Which helper serves each selection, and how each of our helpers ended (33003). The receipt's helper serves
 * until one of our writers acquires the selection; a helper we displaced ourselves is no longer the owner, so
 * its exit is recorded and never reported. `state` writes one clipboard-owner-exit event per dead owner.
 *
 * When the owner exits and no writer of ours is claiming its selection, `readTaker` names who holds the selection
 * at that instant (33693, @cto 379b191a); a non-child owner's exit is seen only at `state`, so its taker is read
 * then. `takerOurs` is false only when the taker was read and no helper of ours could be it.
 *
 * `outerTerminal` is this run's outer terminal from the receipt (33968, @cto e387bb82): `takerOuterTerminal` is
 * true only when the taker's _NET_WM_PID is its pid and the taker's X client owns its window.
 */
export function createClipboardOwnership<S extends string>(
  initial: Partial<Record<S, number>>,
  externalAlive: (pid: number) => boolean,
  readTaker?: (selection: S) => Promise<SelectionTakerRead>,
  outerTerminal?: { readonly pid: number; readonly windowId: string },
) {
  const owners = new Map<S, number>(Object.entries(initial) as [S, number][])
  const ours = new Set<number>()
  /** Our writers still running, and those not yet confirmed as the owner, by selection. */
  const live = new Map<number, S>()
  const claiming = new Map<number, S>()
  const exits = new Map<number, ClipboardHelperExit>()
  const takers = new Map<number, Promise<SelectionTakerRead>>()
  const reported = new Set<number>()
  const couldBeOurs = (selection: S, helperPid: number, taker: Extract<SelectionTakerRead, { read: true }>) => {
    if ([...live.values()].includes(selection)) return true
    const receiptHelper = initial[selection]
    if (receiptHelper !== undefined && receiptHelper !== helperPid && externalAlive(receiptHelper)) return true
    return taker.takerPid !== undefined && (ours.has(taker.takerPid) || Object.values(initial).includes(taker.takerPid))
  }
  return {
    spawned(pid: number, selection: S): void {
      ours.add(pid)
      live.set(pid, selection)
      claiming.set(pid, selection)
    },
    exited(pid: number, code: number | null, signal: string | null): void {
      exits.set(pid, { code, signal, at: new Date().toISOString() })
      const selection = live.get(pid)
      live.delete(pid)
      claiming.delete(pid)
      if (readTaker && selection !== undefined && owners.get(selection) === pid) {
        if (![...claiming.values()].includes(selection)) takers.set(pid, readTaker(selection))
      }
    },
    acquired(selection: S, pid: number): void {
      owners.set(selection, pid)
      claiming.delete(pid)
    },
    async state(selection: S, trace: Trace): Promise<ClipboardOwnerState | undefined> {
      const helperPid = owners.get(selection)
      if (helperPid === undefined) return undefined
      const exit = exits.get(helperPid)
      if (!exit && (ours.has(helperPid) || externalAlive(helperPid))) return { helperPid, alive: true }
      if (readTaker && !exit && !takers.has(helperPid)) takers.set(helperPid, readTaker(selection))
      const taker = await takers.get(helperPid)
      const takerOurs = taker?.read ? couldBeOurs(selection, helperPid, taker) : undefined
      const takerOuterTerminal =
        taker?.read && outerTerminal
          ? taker.takerPid === outerTerminal.pid &&
            taker.clientWindows.some((window) => BigInt(window) === BigInt(outerTerminal.windowId))
          : undefined
      const known = {
        ...(taker && { taker }),
        ...(takerOurs !== undefined && { takerOurs }),
        ...(takerOuterTerminal !== undefined && { takerOuterTerminal }),
      }
      if (!reported.has(helperPid)) {
        reported.add(helperPid)
        trace({
          kind: "clipboard-owner-exit",
          at: exit?.at ?? new Date().toISOString(),
          helperPid,
          ...(exit ? { exitCode: exit.code, signal: exit.signal } : { exitObserved: false }),
          ...known,
        })
      }
      return { helperPid, alive: false, ...(exit && { exit }), ...known }
    },
  }
}

function describeOwnerExit(owner: Extract<ClipboardOwnerState, { alive: false }>): string {
  return owner.exit
    ? `exited at ${owner.exit.at} (code ${owner.exit.code}, signal ${owner.exit.signal ?? "none"})`
    : "is gone (not our child, so its exit code and signal are unknown)"
}

function describeTaker(owner: Extract<ClipboardOwnerState, { alive: false }>): string {
  const taker = owner.taker
  if (!taker) return "taker not read"
  if (!taker.read) return `taker not read (${taker.reason})`
  const name = taker.takerClass ? `class ${taker.takerClass}` : "no WM_CLASS on its client's windows"
  return (
    `taker window ${taker.window} (${name}${taker.takerPid === undefined ? "" : `, pid ${taker.takerPid}`})` +
    (owner.takerOurs ? ", which could be a helper of ours" : "") +
    (owner.takerOuterTerminal === true ? ", this run's outer terminal" : "") +
    (owner.takerOuterTerminal === false ? ", not this run's outer terminal" : "")
  )
}

/** A recovered pre-flight is said on the result row itself, so a reader tells it from a clean one (@cto 379b191a). */
function noteRecovered(result: ProbeCallbackResult, recovered: string): ProbeCallbackResult {
  const join = (note: string | undefined) => (note ? `${note}; ${recovered}` : recovered)
  if (result.observation) {
    return { ...result, observation: { ...result.observation, note: join(result.observation.note) } }
  }
  return { ...result, note: join(result.note) }
}

/** The pre-flight's stray read, by digest and length; a zero length says so in words (@cto 67370e55). */
function describeRead(text: string): string {
  const length = Buffer.byteLength(text)
  return `read sha256 ${digest(text)} length ${length}${length === 0 ? ", empty read (no owner or empty owner)" : ""}`
}

/** /proc/uptime counts centiseconds: a read of t means the clock is in [t, t + 10 ms). */
const UPTIME_RESOLUTION_MS = 10

/**
 * The X server's clock in ms mod 2^32. Xorg's GetTimeInMillis reads CLOCK_MONOTONIC; /proc/uptime is the same
 * kernel clock on a host that never suspends. Measured on the xterm image (#33145): xterm's claim TIMESTAMP
 * 3979146112 fell inside the press's uptime bracket 3979146100..3979146120.
 */
function xServerTimeMs(): number {
  const seconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0])
  if (!Number.isFinite(seconds)) throw new Error("/proc/uptime has no readable seconds field")
  return Math.floor(seconds * 1000) % 2 ** 32
}

/**
 * One real XTEST key event (shift press and release) on the owned window before an OSC 52 write (#33145,
 * @cto 70645b74). xterm and Alacritty stamp their selection claim with their last input-event time, and X
 * ignores a claim older than the current owner's (ICCCM), so a terminal that never saw input loses to the
 * fixture's own xclip writer. A focus or XTEST failure throws by name; the probe refuses the sample.
 */
export async function pressRealKey(
  windowId: string,
  run: (file: string, args: string[]) => Promise<string>,
  clock: () => number,
  trace: Trace,
  verify: () => Promise<void>,
): Promise<void> {
  const at = new Date().toISOString()
  try {
    await verify()
    // Xvfb has no window manager: XSetInputFocus then getwindowfocus, as linux-input.ts focusOwnedWindow.
    await run("xdotool", ["windowfocus", windowId])
    const focused = (await run("xdotool", ["getwindowfocus"])).trim()
    if (focused !== windowId) {
      throw new Error(`owned window ${windowId} is not focused; getwindowfocus is ${focused || "empty"}`)
    }
    const before = clock()
    await run("xdotool", ["key", "--window", "0", "--clearmodifiers", "shift"])
    const after = clock()
    trace({
      kind: "clipboard-key",
      at,
      key: "shift",
      windowId: focused,
      xTimeMs: [before, after + UPTIME_RESOLUTION_MS],
    })
  } catch (error) {
    trace({ kind: "clipboard-key", at, status: "error" })
    throw new Error(
      `Real key event before the OSC 52 write failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Single flight includes the finally restoration; failure there overrides the callback. */
export function createClipboardTransaction(
  baseline: string,
  io: {
    readText(trace: Trace, kind: ClipboardTraceEvent["kind"], verify: () => Promise<void>): Promise<string>
    writeText(text: string, trace: Trace, kind: ClipboardTraceEvent["kind"], verify: () => Promise<void>): Promise<void>
    /** X selection fixtures: the real key event the OSC 52 write probes call first (#33145). */
    realKeyEvent?(trace: Trace, verify: () => Promise<void>): Promise<void>
    /**
     * The helper that should be serving the baseline (33003). Read by the pre-flight only: inside a callback the
     * terminal taking the selection is the measurement, so a displaced helper there is expected.
     */
    owner?(trace: Trace): Promise<ClipboardOwnerState | undefined>
  },
  options?: {
    readonly writeDeadlineMs?: number
    readonly writePollMs?: number
    /** @cto 2026-11-13: the clipboard-read setting this run applied, so a profile reading names itself. */
    readonly readProfile?: { readonly profile: string; readonly setting: string }
    /** @cto 2026-11-13: the app's pinned default for a clipboard read, so a silent read grades what it means. */
    readonly readDefault?: { readonly posture: "ask" | "deny" | "absent"; readonly source: string }
    /** The citation this tree holds is for another version: name both, never grade from the other version's. */
    readonly readDefaultRefusal?: string
    /**
     * An owned host's pasteboard is shared with everything else on that machine (@cto 1c7e19df):
     * the sha256 of foreign text in a diagnostic is a guessable fingerprint of a short secret, so
     * those runs record the read's length and never its digest. Linux and hosted runs keep it.
     *
     * `"absent"` is the ordinary-open case (@cto 2026-11-13): the pasteboard belongs to the person
     * using the app, so neither its digest NOR its length may be published — only whether a value was
     * present at all.
     */
    readonly foreignReadDigest?: "record" | "omit" | "absent"
    readonly muxState?: {
      snapshot(): Promise<{ readonly tmuxSetClipboard?: string; readonly buffers: readonly string[] }>
      restore(before: readonly string[]): Promise<void>
    }
  },
): LinuxClipboardAdapter["withClipboardFixture"] {
  let busy = false
  const described = (text: string): string => {
    if (options?.foreignReadDigest === "absent") {
      return text === "" ? "read empty (no owner or empty owner)" : "read present"
    }
    if (options?.foreignReadDigest !== "omit") return describeRead(text)
    const length = Buffer.byteLength(text)
    return `read length ${length}${length === 0 ? ", empty read (no owner or empty owner)" : ""}`
  }
  return async (work, trace, verify) => {
    if (busy) throw new Error("Owned clipboard transaction cannot nest or overlap")
    busy = true
    let result: ProbeCallbackResult | undefined
    let failure: unknown
    let muxSnapshot: { readonly tmuxSetClipboard?: string; readonly buffers: readonly string[] } | undefined
    let recovered: string | undefined
    try {
      await verify()
      const owner = await io.owner?.(trace)
      if (owner && !owner.alive) {
        // Re-own once, only when the taker was read, cannot be ours and is proven to be this run's outer terminal,
        // after a clean exit or a non-child helper's unobserved one (@cto 379b191a, e387bb82). A crashed helper, an
        // unread taker, a taker that could be ours and any other client refuse as before.
        const exitClean = owner.exit === undefined || owner.exit.code === 0
        if (
          !exitClean ||
          owner.taker?.read !== true ||
          owner.takerOurs !== false ||
          owner.takerOuterTerminal !== true
        ) {
          const read = await io.readText(trace, "clipboard-read", verify).then(described, (error: unknown) => {
            return `read failed: ${error instanceof Error ? error.message : String(error)}`
          })
          throw new Error(
            `Owned clipboard helper ${owner.helperPid} ${describeOwnerExit(owner)} before callback; ` +
              `${describeTaker(owner)}; ${read}`,
          )
        }
        await io.writeText(baseline, trace, "clipboard-reown", verify)
        recovered =
          `pre-flight re-owned the clipboard baseline: helper ${owner.helperPid} ${describeOwnerExit(owner)}; ` +
          describeTaker(owner)
      }
      // The same baseline, re-read by hash and length, before the probe continues; after a re-own too.
      const read = await io.readText(trace, "clipboard-read", verify)
      if (read !== baseline) {
        throw new Error(
          `Owned clipboard baseline changed before callback${recovered ? " after its one re-own" : ""}: ` +
            described(read) +
            (owner?.alive ? `; owner helper ${owner.helperPid} alive` : ""),
        )
      }
      if (options?.muxState) {
        muxSnapshot = await options.muxState.snapshot()
      }
      const realKeyEvent = io.realKeyEvent
      const fixture: ClipboardFixture = {
        baseline,
        ...(options?.readProfile && { readProfile: options.readProfile }),
        ...(options?.readDefault && { readDefault: options.readDefault }),
        ...(options?.readDefaultRefusal && { readDefaultRefusal: options.readDefaultRefusal }),
        ...(muxSnapshot?.tmuxSetClipboard !== undefined && { tmuxSetClipboard: muxSnapshot.tmuxSetClipboard }),
        ...(options?.writeDeadlineMs !== undefined && { writeDeadlineMs: options.writeDeadlineMs }),
        ...(options?.writePollMs !== undefined && { writePollMs: options.writePollMs }),
        readText: () => io.readText(trace, "clipboard-read", verify),
        writeText: (text) => io.writeText(text, trace, "clipboard-write", verify),
        ...(realKeyEvent && { realKeyEvent: () => realKeyEvent(trace, verify) }),
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
        const detail = error instanceof Error ? error.message : String(error)
        failure = new Error(
          options?.foreignReadDigest === "absent"
            ? // The person's clipboard is not ours to leave changed (@cto 2026-11-13): name whose clipboard it is,
              // not just that a restore failed, so the one line reads as the warning it is.
              `The person's clipboard was left changed: restoration failed: ${detail}`
            : `Owned clipboard restoration failed: ${detail}`,
        )
      }
      busy = false
    }
    if (failure) throw failure
    if (!result) throw new Error("Owned clipboard callback returned no result")
    return recovered ? noteRecovered(result, recovered) : result
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

/** True only when the kernel has no such process (ENOENT); any other read failure is raised, never read as gone. */
function processGone(pid: number): boolean {
  try {
    readFileSync(`/proc/${pid}/status`, "utf8")
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
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
  const primary = r.selection.primary
  if (
    primary !== undefined &&
    (!primary ||
      typeof primary !== "object" ||
      !Number.isSafeInteger(primary.helperPid) ||
      primary.helperPid < 2 ||
      primary.helperPid === r.selection.helperPid ||
      typeof primary.baselinePath !== "string" ||
      !primary.baselinePath.startsWith("/") ||
      !/^[0-9a-f]{64}$/.test(primary.baselineSha256 ?? "") ||
      primary.initialReadSha256 !== primary.baselineSha256)
  ) {
    throw new Error("Owned clipboard receipt has an invalid PRIMARY selection")
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

export type ClipboardApp = "kitty" | "ghostty" | "alacritty" | "xterm" | "wezterm"

/**
 * Each terminal's own clipboard-read-allowed setting, read from its pinned version (issue 33119, @cto 53ee5175).
 * scripts/linux-container-run.sh passes exactly these args under the allow profile; clipboard-allow-args.test.ts
 * keeps the two equal. WezTerm has no read setting: it runs as it is and its result is measured, never declared.
 */
export const CLIPBOARD_ALLOW_ARGS: Readonly<Record<ClipboardApp, readonly string[]>> = {
  kitty: ["-o", "clipboard_control=write-clipboard read-clipboard"],
  ghostty: ["--clipboard-read=allow"],
  alacritty: ["-o", 'terminal.osc52="CopyPaste"'],
  xterm: ["-xrm", "*disallowedWindowOps: GetChecksum,GetIconTitle,GetWinTitle,SetXprop"],
  wezterm: [],
}

/**
 * Each app's PINNED DEFAULT for a clipboard read, cited from its own source at the version it is measured at
 * (@cto 2026-11-13): a silent read means "the user was asked" for one app and "the answer is no" for another, and a
 * default taken from the silence is a guess, not evidence. An app absent here is unpinned: its read rows say
 * "default not established" by name. A version not named below has no entry — extend this with that version's own
 * source rather than reusing another version's citation.
 */
export const CLIPBOARD_READ_DEFAULTS: Readonly<
  Partial<
    Record<
      ClipboardApp,
      { readonly posture: "ask" | "deny" | "absent"; readonly version: string; readonly source: string }
    >
  >
> = {
  kitty: {
    posture: "ask",
    version: "0.49.2",
    source:
      "kitty v0.49.2 kitty/options/definition.py:3121: clipboard_control defaults to " +
      "'write-clipboard write-primary read-clipboard-ask read-primary-ask' (\"ask for permission when a program tries to read\")",
  },
  ghostty: {
    posture: "ask",
    version: "1.4.0",
    source: 'ghostty v1.4.0 src/config/Config.zig:2458: "clipboard-read": ClipboardAccess = .ask',
  },
  alacritty: {
    posture: "deny",
    version: "0.17.0",
    source:
      "alacritty v0.17.0 alacritty_terminal/src/term/mod.rs:372-384: Osc52::OnlyCopy is #[default] — " +
      '"only copy sequence is accepted"',
  },
}

/**
 * The default a run may use: its OWN version's citation or nothing (@cto 2026-11-13 — a citation from another version
 * must never grade a run, and "deny" is the case where that writes a wrong negative). A run whose version has no
 * citation gets a refusal naming both versions, so the row says which citation was missing, not that none exists.
 */
export function clipboardReadDefault(
  app: ClipboardApp,
  profile: "default" | "allow" | "deny-read",
  measuredVersion: string | undefined,
): {
  readDefault?: { readonly posture: "ask" | "deny" | "absent"; readonly source: string }
  readDefaultRefusal?: string
} {
  if (profile !== "default") return {}
  const cited = CLIPBOARD_READ_DEFAULTS[app]
  if (!cited) return {}
  if (cited.version === measuredVersion) return { readDefault: { posture: cited.posture, source: cited.source } }
  return {
    readDefaultRefusal: `default not established: this tree cites ${app} ${cited.version}, this run measured ${
      measuredVersion ?? "(no version recorded)"
    }`,
  }
}

/**
 * The read setting a run's profile ACTUALLY applied, as `assertClipboardProfile` verifies against the live argv:
 * allow = the app's read-allowed args; deny-read = write-clipboard only. A record names this, so a deny-read reading
 * cannot be printed as if it had granted reads (@dev/16 peer).
 */
export const CLIPBOARD_DENY_READ_ARGS: readonly string[] = ["-o", "clipboard_control=write-clipboard"]

export function clipboardReadProfile(
  app: ClipboardApp,
  profile: "default" | "allow" | "deny-read",
): { readonly profile: string; readonly setting: string } | undefined {
  if (profile === "default") return undefined
  const applied = profile === "deny-read" ? CLIPBOARD_DENY_READ_ARGS : CLIPBOARD_ALLOW_ARGS[app]
  return applied.length > 0 ? { profile, setting: `${app} ${applied.join(" ")}` } : undefined
}

/** The argv tokens that set each terminal's clipboard read control, flag and value together. */
function clipboardControls(app: ClipboardApp, options: string[]): string[] {
  const valueOf = (flags: string[], value: (part: string) => boolean) =>
    options.flatMap((part, index) => {
      const flag = options[index - 1]
      return flag !== undefined && flags.includes(flag) && value(part) ? [flag, part] : []
    })
  switch (app) {
    case "kitty":
      return valueOf(["-o", "--override"], (part) => part.startsWith("clipboard_control="))
    case "ghostty":
      return options.filter((part) => part.startsWith("--clipboard-read"))
    case "alacritty":
      return valueOf(["-o", "--option"], (part) => part.startsWith("terminal.osc52="))
    case "xterm":
      return valueOf(["-xrm"], (part) => /(^|[*.])(disallowedWindowOps|allowWindowOps)\s*:/.test(part))
    case "wezterm":
      return []
  }
}

function clipboardApp(id: string | undefined): ClipboardApp {
  if (id !== undefined && Object.hasOwn(CLIPBOARD_ALLOW_ARGS, id)) return id as ClipboardApp
  throw new Error(`Owned clipboard target ${id ?? "(unset)"} has no declared clipboard control`)
}

/** Compare the terminal's actual argv, not a shell-escaped display string in the receipt. */
export function assertClipboardProfile(app: ClipboardApp, profile: ClipboardReceipt["profile"], argv: string[]): void {
  // The collector-command boundary: the launcher runs the collector as `bun …` after the terminal's own options, so
  // the first `bun` token ends them. Collector arguments after it are never read as terminal controls.
  const commandIndex = argv.findIndex((part) => part === "bun")
  const options = commandIndex < 0 ? argv : argv.slice(0, commandIndex)
  if (profile === "deny-read" && app !== "kitty") {
    throw new Error(`Owned ${app} has no declared deny-read clipboard control`)
  }
  const expected = {
    default: [],
    allow: CLIPBOARD_ALLOW_ARGS[app],
    "deny-read": CLIPBOARD_DENY_READ_ARGS,
  }[profile]
  if (JSON.stringify(clipboardControls(app, options)) !== JSON.stringify(expected)) {
    throw new Error(`Owned ${app} argv clipboard control differs from ${profile} receipt`)
  }
}

function expectedClipboardPermissions(app: ClipboardApp, profile: ClipboardReceipt["profile"]): string {
  switch (profile) {
    case "default":
      return "clipboard: read=ask,write=allow; OSC52: write=run,read=not-run"
    case "allow":
      return app === "wezterm" ? "clipboard: read=no-setting,write=allow" : "clipboard: read=allow,write=allow"
    case "deny-read":
      return "clipboard: read=deny,write=allow"
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
  const app = clipboardApp(process.env.TERMINFO_TARGET_ID)
  if (receipt.permissions !== expectedClipboardPermissions(app, receipt.profile)) {
    throw new Error(`Owned clipboard profile and ${app} configuration disagree`)
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
  const primaryReceipt = receipt.selection.primary
  const primaryBaseline = primaryReceipt && readFileSync(ownedFile(primaryReceipt.baselinePath), "utf8")
  if (
    primaryReceipt &&
    (primaryBaseline !== `terminfo-owned-primary-${receipt.runId}` ||
      digest(primaryBaseline) !== primaryReceipt.baselineSha256)
  ) {
    throw new Error("Owned PRIMARY baseline is not this collector's generated nonce")
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
    assertClipboardProfile(
      app,
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
  if (primaryReceipt && processExecutable(primaryReceipt.helperPid) !== helperExe) {
    throw new Error("Owned PRIMARY selection helper executable differs from receipt")
  }
  const children = new Set<ChildProcess>()
  // The libX11 the receipt helper has mapped is the one the taker read loads (33693); a miss is named per read.
  let libX11: string | Error
  try {
    libX11 = mappedLibX11(receipt.selection.helperPid)
  } catch (error) {
    libX11 = error instanceof Error ? error : new Error(String(error))
  }
  const takerIo = selectionOwnerIo(env, (file, args) => command(file, args, env))
  const ownership = createClipboardOwnership<Selection>(
    { clipboard: receipt.selection.helperPid, ...(primaryReceipt && { primary: primaryReceipt.helperPid }) },
    (pid) => !processGone(pid) && processExecutable(pid) === helperExe,
    (selection) =>
      typeof libX11 === "string"
        ? readSelectionTaker(selection, libX11, takerIo)
        : Promise.resolve({ read: false, at: new Date().toISOString(), reason: libX11.message }),
    { pid: receipt.terminal.pid, windowId: receipt.terminal.windowId },
  )
  const log = (trace: Trace, kind: ClipboardTraceEvent["kind"], text: string, helperPid?: number) =>
    trace({
      kind,
      at: new Date().toISOString(),
      sha256: digest(text),
      length: Buffer.byteLength(text),
      ...(helperPid && { helperPid }),
    })
  type Selection = "clipboard" | "primary"
  async function readText(
    trace: Trace,
    kind: ClipboardTraceEvent["kind"],
    verify: () => Promise<void>,
    selection: Selection = "clipboard",
  ): Promise<string> {
    const at = new Date().toISOString()
    try {
      await verify()
      const text = await command(helperExe, ["-quiet", "-selection", selection, "-o"], env)
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
    selection: Selection = "clipboard",
  ): Promise<void> {
    const at = new Date().toISOString()
    try {
      await verify()
    } catch (error) {
      trace({ kind, at, status: "error" })
      throw error
    }
    const child = spawn(helperExe, ["-quiet", "-selection", selection, "-i"], {
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
    child.once("exit", (code, signal) => {
      children.delete(child)
      if (child.pid) ownership.exited(child.pid, code, signal)
    })
    const pid = child.pid
    if (!pid) {
      trace({ kind, at, status: "error" })
      throw new Error("Owned xclip writer failed to start")
    }
    ownership.spawned(pid, selection)
    child.stdin.end(text)
    log(trace, kind, text, pid)
    for (let attempt = 0; attempt < 30; attempt++) {
      if (childError) throw childError
      try {
        if ((await readText(trace, "clipboard-read", verify, selection)) === text) {
          ownership.acquired(selection, pid)
          return
        }
      } catch (error) {
        if (attempt === 29) throw error
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20)
      })
    }
    throw new Error(`Owned xclip writer did not acquire the ${selection} selection`)
  }
  if ((await readText(() => {}, "clipboard-read", assertOwned)) !== baseline) {
    throw new Error("Initial owned clipboard readback differs from generated baseline")
  }
  if (primaryBaseline && (await readText(() => {}, "clipboard-read", assertOwned, "primary")) !== primaryBaseline) {
    throw new Error("Initial owned PRIMARY readback differs from generated baseline")
  }
  const withPrimaryFixture =
    primaryBaseline &&
    createClipboardTransaction(primaryBaseline, {
      readText: (trace, kind, verify) => readText(trace, kind, verify, "primary"),
      writeText: (text, trace, kind, verify) => writeText(text, trace, kind, verify, "primary"),
      owner: (trace) => ownership.state("primary", trace),
    })
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
  const readProfile = clipboardReadProfile(app, receipt.profile)
  // The launcher has already compared TERMINFO_TARGET_VERSION with the app's own version reply at this point
  // (linux-container-run.sh:721), so this is the version the run measured, not one asserted here.
  const readDefaultChoice = clipboardReadDefault(app, receipt.profile, process.env.TERMINFO_TARGET_VERSION)
  const withClipboardFixture = createClipboardTransaction(
    baseline,
    {
      readText,
      writeText,
      owner: (trace) => ownership.state("clipboard", trace),
      realKeyEvent: (trace, verify) =>
        pressRealKey(receipt.terminal.windowId, (file, args) => command(file, args, env), xServerTimeMs, trace, verify),
    },
    {
      // @cto 2026-11-13: a profile reading names its profile and its exact setting; a default-configuration reading
      // names nothing, and that absence is what tells the two apart downstream.
      ...(readProfile && { readProfile }),
      ...readDefaultChoice,
      ...(tmuxTarget && {
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
      }),
    },
  )
  const screenTarget = receipt.target?.kind === "mux" && receipt.target.mux === "screen" ? receipt.target : undefined
  let screenRead = 0
  const adapter: LinuxClipboardAdapter = {
    profile: receipt.profile,
    config: receipt.config,
    ...(tmuxTarget && {
      readAllowPassthrough: () =>
        readMuxAllowPassthrough({
          run: async (args) =>
            (await command(tmuxTarget.executable.path, ["-S", tmuxTarget.socketPath, ...args], env)).toString(),
        }),
    }),
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
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 25)
              })
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
        ...(primaryReceipt && { primary: primaryReceipt }),
      },
    }),
    withClipboardFixture,
    ...(withPrimaryFixture && { withPrimaryFixture }),
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
