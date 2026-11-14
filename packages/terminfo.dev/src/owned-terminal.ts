import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs"
import { isatty, WriteStream } from "node:tty"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, win32 } from "node:path"
import type {
  DarwinMuxAttachmentProof,
  MuxAttachmentProof,
  OuterAppProof,
  ProbeSubject,
  TerminalScrollbackReading,
  TermProbeSource,
} from "@terminfo/probe-defs"
import { readTermFeaturesEnvironment } from "./terminal-child-environment.ts"
import { readAppSemanticState, readWezTermCwd, untilAppSemanticRead } from "./app-semantic-state.ts"
import { parseJsonStrict, measuredVersionTokens } from "@terminfo/run-parser"
import { retain } from "./capture-core.ts"
import type { CaptureChromeBand } from "./capture-calibration.ts"
import {
  readDisposableReceipt,
  parseLstart,
  parseMuxAttachmentProof,
  HOSTED_IDENTITY_SOURCES,
} from "./disposable-receipt.ts"
import { kittyAncestor, type LiveExecutable } from "./linux-capture.ts"
import {
  findAncestorComm,
  readProcessEnvironment,
  terminalBusState,
  type TerminalBusReading,
} from "./terminal-environment.ts"
import { createDarwinClipboardAdapter } from "./darwin-clipboard.ts"
import { createLinuxClipboardAdapter, type LinuxClipboardAdapter } from "./linux-clipboard.ts"
import { readLinuxKittyScrollback } from "./linux-kitty-text.ts"
import { ownedHistoryReceipt, ttyName } from "./owned-history-receipt.ts"
import {
  cmuxConfigPath,
  cmuxHistoryIdentity,
  observeCmuxConfig,
  ownedCmuxHistoryExecutable,
  type CmuxLastRead,
  type CmuxReadFacts,
  readOwnedCmuxHistory,
} from "./cmux-owned-history.ts"
import { wasCollectorOpenedControllingTTY } from "./tty.ts"
import {
  ScrollbackReadingUnavailable,
  TEXT_QUALIFICATION_OWNERSHIP_CELL,
  type TextQualificationOwnership,
  type TextQualificationRecipe,
} from "@terminfo/probe-defs"
import { readWindowsConsoleGeometry, readWindowsConsoleIdentity, writeConsoleCellsRaw } from "./windows-console-ffi.ts"
import {
  consoleBufferOwner,
  consoleHostFromTable,
  consoleIdentityMismatch,
  readWindowsConsoleCells,
  resolveConsoleHostIdentity,
  type ConsoleCellRead,
  type ConsoleHostLookup,
} from "./windows-console-cells.ts"
import { kernelExecPath } from "./darwin-kernel-exec.ts"
import {
  mapSnapshotToCells,
  type OsascriptReply,
  readTerminalAppHistory,
  readTerminalTextSnapshot,
  terminalAppHistoryReader,
  type TerminalHistoryControl,
  type TerminalTextApp,
  type TerminalTextRead,
} from "./darwin-terminal-text.ts"
import { readConsoleGeometry } from "./windows-console-geometry.ts"
import { readITermCells } from "./iterm2-protocol.ts"
import {
  HOSTED_WINDOWS_EXECUTABLE,
  hostedWindowsAppFromExecutablePath,
  readWindowsProcessTable,
  requireHostedWindowsAppAncestor,
  windowsProcessAncestry,
  type HostedWindowsApp,
  type HostedWindowsAppId,
} from "./windows-process-ancestry.ts"
import { loadKernel32 } from "./windows-kernel32.ts"
import { assertOwnedTerminalWindow } from "./terminal-app-window.ts"
import {
  assertOwnedProcess,
  runScopedMarker,
  processCommand,
  argvCarriesMarker,
  type ProcessOwnerBasis,
} from "./owned-process.ts"
import {
  createLineRenditionTracker,
  readWindowsTerminalRows,
  readWindowsTerminalText,
} from "./windows-terminal-text.ts"
import { readWindowsWezTermRows, readWindowsWezTermText } from "./windows-wezterm-text.ts"
import {
  hostedWezTermPrerequisites,
  hostedWezTermOwnerProof,
  ownedWezTermHistoryExecutable,
  readOwnedWezTermHistory,
  readOwnedWezTermPane,
  socketHeldByPid,
  wezTermHistoryIdentity,
} from "./wezterm-owned-history.ts"

export { HOSTED_WINDOWS_EXECUTABLE, hostedWindowsAppFromExecutablePath, type HostedWindowsApp, type HostedWindowsAppId }

export type GeometrySource =
  | "stty size on a /proc/self/fd reopen of the verified output device"
  | "stty size on a /dev/fd reopen of the verified output device"
  | "GetConsoleScreenBufferInfo on the collector's own CONOUT$"
  | "`mode con` on the collector's own console"
  | "unavailable: no verified output device"

/** The two named Windows reads, in the design's order. Recorded per measurement, so a run says
 * WHICH read answered instead of naming the primary when the fallback did. */
const WINDOWS_FFI_SOURCE = "GetConsoleScreenBufferInfo on the collector's own CONOUT$" as const
const WINDOWS_MODE_CON_SOURCE = "`mode con` on the collector's own console" as const

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

/**
 * The admin's claim for a process-backed Darwin arm, verified by the worker field by field. It names
 * the ONE shared process proof's own observables (owned-process.ts's OwnedProcess): the live pid, its
 * realpath executable, the ownership basis and the window TTY. The basis is the run-scoped argv marker
 * (kitty, cli-process) or, for iTerm2, which takes no marker, the launch preflight that found no
 * instance (@cto 11983ea0, condition 1). Only iTerm2 names a window id: the CG id the admin's census
 * proved new and owned, which the worker's capture pins its window to.
 */
export interface ProcessOwnerAssertion {
  asserter: "terminfo-admin"
  launchRunId: string
  workerPid: number
  provider: "kitty" | "cli-process" | "iterm2"
  ownerPid: number
  executablePath: string
  basis: ProcessOwnerBasis
  tty: string
  /** iTerm2 only, and required there: the CG window id. Refused on every other provider. */
  windowId?: number
  intendedVersion: string
}

/** Exactly these keys, no more and no fewer. */
const exactKeys = (object: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key))

/** The basis is a tagged union, and each provider has exactly one kind: kitty and cli-process prove a
 * marker, iTerm2 the sole instance. An unknown kind, or a kind on the wrong provider, is invalid. */
function parseProcessOwnerBasis(value: unknown, provider: unknown): ProcessOwnerBasis | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const basis = value as Record<string, unknown>
  switch (basis.kind) {
    case "marker": {
      if (!exactKeys(basis, ["kind", "marker"]) || (provider !== "kitty" && provider !== "cli-process")) {
        return undefined
      }
      const marker = basis.marker
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) return undefined
      const markerObject = marker as Record<string, unknown>
      if (
        !exactKeys(markerObject, ["flag", "value"]) ||
        typeof markerObject.flag !== "string" ||
        markerObject.flag.length === 0 ||
        /\s/.test(markerObject.flag) ||
        typeof markerObject.value !== "string" ||
        markerObject.value.length === 0 ||
        /\s/.test(markerObject.value)
      ) {
        return undefined
      }
      return { kind: "marker", marker: { flag: markerObject.flag, value: markerObject.value } }
    }
    case "sole-instance":
      return exactKeys(basis, ["kind", "preflightAbsent"]) && basis.preflightAbsent === true && provider === "iterm2"
        ? { kind: "sole-instance", preflightAbsent: true }
        : undefined
    default:
      return undefined
  }
}

/** The request is an admin assertion; the worker independently verifies every observable field. */
export function parseProcessOwnerAssertion(value: unknown): ProcessOwnerAssertion {
  const invalid = () => new Error("Invalid process owner assertion")
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const object = value as Record<string, unknown>
  const keys = [
    "asserter",
    "launchRunId",
    "workerPid",
    "provider",
    "ownerPid",
    "executablePath",
    "basis",
    "tty",
    ...(object.provider === "iterm2" ? ["windowId"] : []),
    "intendedVersion",
  ]
  if (!exactKeys(object, keys)) throw invalid()
  const basis = parseProcessOwnerBasis(object.basis, object.provider)
  if (
    basis === undefined ||
    object.asserter !== "terminfo-admin" ||
    typeof object.launchRunId !== "string" ||
    !/^[0-9a-f]{32}$/.test(object.launchRunId) ||
    typeof object.workerPid !== "number" ||
    !Number.isSafeInteger(object.workerPid) ||
    object.workerPid < 1 ||
    (object.provider !== "kitty" && object.provider !== "cli-process" && object.provider !== "iterm2") ||
    typeof object.ownerPid !== "number" ||
    !Number.isSafeInteger(object.ownerPid) ||
    object.ownerPid < 1 ||
    typeof object.executablePath !== "string" ||
    !object.executablePath.startsWith("/") ||
    typeof object.tty !== "string" ||
    !/^\/dev\/tty[a-zA-Z0-9._-]+$/.test(object.tty) ||
    (object.provider === "iterm2" &&
      (typeof object.windowId !== "number" || !Number.isSafeInteger(object.windowId) || object.windowId < 1)) ||
    typeof object.intendedVersion !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,79}$/.test(object.intendedVersion)
  ) {
    throw invalid()
  }
  return {
    asserter: object.asserter,
    launchRunId: object.launchRunId,
    workerPid: object.workerPid,
    provider: object.provider,
    ownerPid: object.ownerPid,
    executablePath: object.executablePath,
    basis,
    tty: object.tty,
    ...(typeof object.windowId === "number" && { windowId: object.windowId }),
    intendedVersion: object.intendedVersion,
  }
}

/** Both Darwin claim arms bind the assertion to THIS worker: the launch run id it was started with,
 * that same id in its environment, and its own pid. One check, so the two arms cannot drift. */
function requireOwnWorker(
  claim: { launchRunId: string; workerPid: number },
  expectedLaunchRunId: string,
  who: string,
): void {
  if (
    claim.launchRunId !== expectedLaunchRunId ||
    process.env.TERMINFO_RUN_ID !== expectedLaunchRunId ||
    claim.workerPid !== process.pid
  ) {
    throw new Error(`${who} owner assertion differs from this worker launch run or PID`)
  }
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

/** One process's own environment and bus state; the environment itself never leaves the collector in a record. */
export interface NotificationEnvironmentReading {
  readonly status: "measured" | "refused"
  readonly reason: string
  readonly pid?: number
  readonly environment?: Readonly<Record<string, string>>
  readonly bus?: TerminalBusReading
}

export interface OwnedTerminal {
  readonly getScrollback?: TermProbeSource["getScrollback"]
  /** Terminal.app history reader's per-run control, once it has run (31741). */
  readonly historyControl?: () => TerminalHistoryControl | undefined
  readonly resetScrollback?: TermProbeSource["resetScrollback"]
  readonly readTitle?: TermProbeSource["readTitle"]
  readonly readTermFeatures?: TermProbeSource["readTermFeatures"]
  readonly readAppSemanticState?: TermProbeSource["readAppSemanticState"]
  /** When present, only these rows consume this owner's reader; other rows retain their term callbacks. */
  readonly appSemanticStateFeatures?: ReadonlySet<string>
  /**
   * The terminal process's own session bus, read from /proc rather than assumed from the collector's
   * environment (#33333). A mux reads the outer terminal, which is the process that would emit a Notify.
   */
  readonly readNotificationEnvironment?: () => NotificationEnvironmentReading
  readonly geometryAtGrant: GeometryMeasurement
  readonly geometrySource: Exclude<GeometrySource, "unavailable: no verified output device">
  readonly summary: string
  /** The verified PID of the app whose window holds this terminal, which a Darwin capture photographs.
   * A hosted arm measures the receipt-named app in this collector's process ancestry; the owned-process
   * arm takes the owner that assertOwnedProcess proved. Absent on every other arm. */
  readonly appPid?: number
  /** Window identity already proved by this arm's launch/owner evidence. */
  readonly expectedWindowId?: number
  /** Legacy hosted arms retain their census policy; new PID-only routes require a unique window. */
  readonly captureWindowSelection?: "largest" | "unique"
  /** Canonical identity from the hosted receipt's executable mapping, shared by both platforms. */
  readonly hostedAppId?: HostedDarwinAppId | HostedWindowsAppId
  /** The hosted app's declared self-repainting chrome strip, for capture calibration (33056). Absent: whole window. */
  readonly captureChromeBand?: CaptureChromeBand
  readonly clipboard?: LinuxClipboardAdapter
  /** One verified attachment carrier for both platforms; clipboard is only a Linux adapter. */
  readonly muxAttachmentProof?: MuxAttachmentProof
  /**
   * The CLI this run reads its own history THROUGH, with the bytes and version it reported (31741).
   * Present only where the arm reads history through a separate program, so the artifact's history
   * identity names the program that produced the count instead of the launched shell.
   */
  readonly historyExecutable?: { readonly path: string; readonly sha256: string; readonly version: string }
  /**
   * Why this arm's CLI proof could not be measured. Present only beside `historyReadsThroughCli`: the reader
   * refuses to borrow another binary's proof, so an unmeasured arm must say so in its own words rather than
   * record an identity check with no executable (@cto REVISE at f1b0a7ffe).
   */
  readonly historyExecutableUnmeasured?: string
  /** True when this arm's scrollback count comes from the terminal's own CLI, so no other binary's proof applies. */
  readonly historyReadsThroughCli?: true
  /**
   * The cmux history arm as this run can prove it: the executable, the surface id acquired at grant, the
   * grant's outcome, and the last read reduced to facts. `lastRead` is a getter, so a record built after the
   * probes sees the latest read rather than the grant (@cto 81073ae1) — and it publishes no receipt text at
   * all, because that receipt carries the pane transcript (@cto REVISE 2026-11-13). The receipt and the
   * grant proof stay on this object, which no run record serializes.
   */
  readonly cmuxHistory?: {
    readonly executable: string
    readonly surface: string | null
    /** Whether the surface was proved at grant. The proof itself stays on this object, out of any record. */
    readonly grant: "proved" | "failed" | "not attempted"
    /** The path-free refusal code, with its reason only when the reason names no path. Null when proved. */
    readonly grantRefusal: string | null
    readonly grantProof: string
    readonly lastRead: CmuxLastRead | null
  }
  /**
   * This run's app was measured to expose no permitted read of its own pane (#31741, @cto 20b9ffed).
   * Carried on the record so the batch handoff in probes/unified.ts can put it on the probe source once,
   * where the history rows read it as their declared Untestable reason. Absent where the app has a read;
   * a later app version that grows one removes the entry.
   */
  readonly scrollbackUnavailable?: string
  /**
   * Why this arm cannot reach an owned read the app may well expose — a PROBE TODO reason, never the
   * declaration above (8c084f05). The history rows say "hosted WezTerm pane published no socket" instead of
   * falling back to a screenshot arm that cannot read retained history, and no grade follows from it.
   */
  readonly scrollbackProbeTodo?: string
  /** Presence only, never the values: whether this run's pane published what an owned read needs (A0). */
  readonly wezTermPaneEnvironment?: { readonly socket: boolean; readonly paneId: boolean }
  readGeometry(): Promise<GeometryMeasurement>
  /** The arm's own cell read where a raster cannot answer: the hosted Windows arm reads the
   * visible window from the console host's buffer, and the two macOS terminals whose pixel geometry
   * cannot be calibrated answer with their own text snapshot, which carries no attributes by
   * construction. Absent on every other arm, where the pixel capture is the read. A macOS app's read
   * is not decisive until that app's hosted rows pass the five shapes — a mid-line gap, a trailing
   * gap, a soft wrap, an empty last row, and prior scrollback — with the empty-last-row shape run
   * WITH prior scrollback: an app that leaves trailing blank rows out of its contents would pull
   * scrollback onto the screen without refusing, which no separate shape can show. Until then the
   * text snapshot is admitted as non-measuring evidence. */
  readCells?(checkpoint?: {
    label: string
    directory: string
    onRetained: Parameters<typeof retain>[3]
  }): Promise<ConsoleCellRead | TerminalTextRead>
  /** The qualification recipe of a terminal-owned `readCells`: the macOS text snapshot, or Windows
   * Terminal through UI Automation. Absent where the read is the console host's buffer. */
  readonly textRecipe?: TextQualificationRecipe
  /** Windows Terminal only: write U+0001 into the console host's buffer at the ownership cell, then
   * read that cell from the host and the row from the terminal, raw. The caller clears the screen
   * and orders this after its writes. */
  consoleHostOwnership?(): Promise<TextQualificationOwnership>
  /** Windows Terminal only: every probe write, so the read can refuse a screen that may hold a
   * double-width or double-height line, which UI Automation returns unmarked. */
  observeWrite?(text: string): void
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
/** Hosted Windows has no fd device to compare; the console's OWN identity is the binding. */
type WindowsBinding = {
  platform: "windows"
  /** GetConsoleWindow's handle: stable inside one console, different for another (measured
   * 327766 twice in one console, 328074 in the previous), which is what makes a re-read meaningful. */
  consoleIdentity: string
}

export type HostedDarwinAppId =
  | "terminal-app"
  | "iterm2"
  | "ghostty"
  | "alacritty"
  | "wezterm"
  | "cursor"
  | "com.microsoft.VSCode"
  | "warp"
  | "cmux"
export type HostedDarwinApp = {
  id: HostedDarwinAppId
  comm: string
  /** Window-title method for this subject. The Darwin reader follows this and names no app. */
  titleRead: "system-events" | "none"
  /**
   * The measured reason this app's title cannot be read on a hosted runner (33821). Set only where a run
   * measured the window server's name and the reading did not certify the run's own title — the name was
   * the app's own title, or the read did not finish inside the cap. The hosted collector then refuses by
   * name instead of spending a 5 s System Events timeout per row.
   */
  titleUnavailable?: string
  /** Chrome strip the app repaints by itself; capture calibration excuses and counts changes there (33056). */
  captureChromeBand?: CaptureChromeBand
  captureWindowSelection?: "largest" | "unique"
  /**
   * This app was measured and exposes no permitted read of its own pane (#31741, @cto 20b9ffed). The
   * history rows return it as their declared Untestable reason instead of falling back to a screenshot
   * arm that cannot read retained history, and instead of "the first route tried failed". Absent where
   * the app has a read; a later app version that grows one removes the entry.
   */
  scrollbackUnavailable?: string
}
export type AncestryRow = {
  pid: number
  ppid: number
  /** argv0 as ps prints it, kept separate from measured kernel executable identity. */
  comm: string
  uid?: number
  startedAtEpochSeconds?: number
  ttyRdev?: number | null
  command?: string
  /** The kernel's executed path for a Darwin mux walk, or null when neither reader answered.
   * Absent when the walk does not request kernel identity; never guessed from `comm`. */
  kernelExecutable?: string | null
  kernelExecutableReader?: "proc_pidpath" | "KERN_PROCARGS2" | null
  kernelExecutableError?: string | null
  /** Every reader's outcome for this pid, so a refusal can name what each one said (#30518 A3). */
  kernelExecutableAttempts?: { reader: string; result: number | string | null; error: string | null }[]
}

/** @cto 20b9ffed verbatim: the reason text these apps' history rows declare, so one string names the absence. */
const NO_PANE_READ = "no pane read on this app"

/**
 * The app this run's terminal is, resolved in ONE place (@cto 8c084f05). On the hosted Darwin arm the receipt
 * already proved the app from the launched executable and the measured ancestry, so the launcher's
 * TERMINFO_TARGET_ID must not be a second source for that fact; the Linux arm has no such receipt and keeps the
 * launcher's value, unchanged. `hostedAppId` is only ever set by a hosted Darwin receipt.
 */
export function resolveOwnedAppId(input: {
  readonly platform: string
  readonly hostedAppId: string | undefined
  readonly launcherAppId: string | undefined
}): string | undefined {
  return input.platform === "darwin" && input.hostedAppId !== undefined ? input.hostedAppId : input.launcherAppId
}

/** Terminal.app's own row: one object, so the map and the pasteboard fixture cannot disagree. */
const TERMINAL_APP_HOSTED: HostedDarwinApp = {
  id: "terminal-app",
  comm: "Terminal",
  titleRead: "system-events",
  captureWindowSelection: "largest",
}

const HOSTED_DARWIN_EXECUTABLE: Record<string, HostedDarwinApp> = {
  Terminal: TERMINAL_APP_HOSTED,
  // The System Events permission dialog hangs a hosted iTerm2 collector (#33017).
  iTerm2: { id: "iterm2", comm: "iTerm2", titleRead: "none", captureWindowSelection: "largest" },
  // Ghostty's own scrollback-file action is an acceptable read under @cto a1663f9d's five conditions, so the
  // absence here is Alacritty/Code/Cursor only.
  ghostty: { id: "ghostty", comm: "ghostty", titleRead: "system-events" },
  alacritty: {
    id: "alacritty",
    comm: "alacritty",
    titleRead: "system-events",
    scrollbackUnavailable: NO_PANE_READ,
  },
  Alacritty: {
    id: "alacritty",
    comm: "alacritty",
    titleRead: "system-events",
    scrollbackUnavailable: NO_PANE_READ,
  },
  // WezTerm.app's CFBundleExecutable is wezterm-gui; the `wezterm` CLI only starts it.
  "wezterm-gui": { id: "wezterm", comm: "wezterm-gui", titleRead: "system-events" },
  // On 33821 calibration run 43325922491 the run wrote its own marker title and the window server still
  // reported "[Extension Development Host] Cursor" (other-title). That is the app's window title, so the
  // read could not observe the run's title; the counted runs attempted no title-row read (titleRead none).
  Cursor: {
    id: "cursor",
    comm: "Cursor",
    titleRead: "none",
    scrollbackUnavailable: NO_PANE_READ,
    titleUnavailable:
      "Hosted Darwin title read unavailable for Cursor: on 33821 calibration run 43325922491 the read saw the window server report the app's own window title (\"[Extension Development Host] Cursor\") rather than that run's title, so it could not observe the title and the row recorded other-title; the counted runs attempted no title-row read (titleRead none)",
  },
  // On 33821 calibration run 43325922491 the last poll was killed at the 2 s census cap with
  // "[Extension Development Host] Visual Studio Code" observed, so the row recorded read-failed with
  // that name observed; the counted runs attempted no title-row read (titleRead none).
  Code: {
    id: "com.microsoft.VSCode",
    comm: "Code",
    titleRead: "none",
    scrollbackUnavailable: NO_PANE_READ,
    titleUnavailable:
      "Hosted Darwin title read unavailable for com.microsoft.VSCode: on 33821 calibration run 43325922491 the poll was killed at the 2 s census cap with its last observation the app's own window title (\"[Extension Development Host] Visual Studio Code\") rather than that run's title, so the row recorded read-failed with that name observed; the counted runs attempted no title-row read (titleRead none)",
  },
  // Warp's title bar shows an "Update Warp" pill ~3 s after launch (797 px at y 6-29 on run 42861023633; grid from
  // y 46), so calibration excuses y 0-39 there and records the count (33056, @cto f15dec92).
  stable: {
    id: "warp",
    comm: "stable",
    titleRead: "system-events",
    captureChromeBand: { y: 0, height: 40, reason: "Warp title bar: Update Warp pill" },
  },
  // On 33821 calibration run 43327254711 the 2 s window-name measurement was killed at 2003 ms with its
  // last observation "Terminal", the pre-marker name. Every raster-capture census of the same cmux window
  // (id 36, /Applications/cmux.app) after the marker write did record that run's title, through
  // 23:17:27.999Z — so the receipt showed a capped read, not an app that can never expose its title; the
  // counted runs attempted no title-row read (titleRead none).
  cmux: {
    id: "cmux",
    comm: "cmux",
    titleRead: "none",
    titleUnavailable:
      'Hosted Darwin title read unavailable for cmux: on 33821 calibration run 43327254711 the 2 s window-name measurement was killed at 2003 ms with its last observation "Terminal", the pre-marker name, while raster-capture censuses of the same cmux window after the marker write did record that run\'s title, so the bounded read was what failed and not the app; the counted runs attempted no title-row read (titleRead none)',
  },
}
const CMUX_GUI_EXECUTABLE_PATH = "/Applications/cmux.app/Contents/MacOS/cmux"

const HOSTED_DARWIN_COMMS = new Set([
  "Terminal",
  "iTerm2",
  "ghostty",
  "alacritty",
  "wezterm-gui",
  "Cursor",
  "Code",
  "stable",
  "cmux",
])

/** macOS `ps -o comm=` prints a full executable path; match and stop on the last segment. */
function hostedDarwinCommBase(comm: string): string {
  const trimmed = comm.trim()
  const slash = trimmed.lastIndexOf("/")
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** Map a github-hosted-runner appLaunch.executablePath to the hosted Mac apps. */
export function hostedDarwinAppFromExecutablePath(executablePath: string): HostedDarwinApp {
  const base = executablePath.split("/").pop() ?? ""
  const app =
    base === "cmux" && executablePath !== CMUX_GUI_EXECUTABLE_PATH ? undefined : HOSTED_DARWIN_EXECUTABLE[base]
  if (!app) {
    throw new Error(
      `Hosted Darwin receipt executable is not one of Terminal, iTerm2, ghostty, alacritty, wezterm, Cursor, Code, stable, cmux: ${JSON.stringify(executablePath)}`,
    )
  }
  return app
}

/**
 * Grant-time process identity: the probe's ancestry must reach the receipt's app, never a different terminal.
 * Rows follow the measured collector-to-launchd chain, so the last app match is its outermost ancestor.
 */
export function requireHostedDarwinAppAncestor(
  expectedComm: string,
  rows: AncestryRow[],
  receiptExecutablePath?: string,
): AncestryRow {
  const other = rows.find((row) => {
    const base = hostedDarwinCommBase(row.comm)
    return (
      HOSTED_DARWIN_COMMS.has(base) &&
      base !== expectedComm &&
      (base !== "cmux" || row.comm.trim() === CMUX_GUI_EXECUTABLE_PATH)
    )
  })
  if (other) {
    throw new Error(
      `Hosted Darwin ancestry reached ${other.comm} (pid ${other.pid}) while the receipt names ${expectedComm}`,
    )
  }
  const named = rows.findLast((row) =>
    expectedComm === "cmux"
      ? receiptExecutablePath === CMUX_GUI_EXECUTABLE_PATH && row.comm.trim() === receiptExecutablePath
      : hostedDarwinCommBase(row.comm) === expectedComm,
  )
  if (!named) {
    const found = [...rows]
      .reverse()
      .map((row) => `${row.comm} (pid ${row.pid})`)
      .join(", ")
    throw new Error(`Hosted Darwin ancestry never reached ${expectedComm}; found ${found}`)
  }
  return named
}

/**
 * One line naming every hop the hosted Darwin proof walked, kernel path included, so a run's
 * collector.log carries the chain #30392 Acceptance 4 cites instead of only the refusal that used it.
 * A row whose kernel read failed says so by name rather than printing argv0 as if it were the path.
 */
export function formatHostedDarwinAncestry(rows: AncestryRow[]): string {
  return rows
    .map((row) => {
      const hop = `${String(row.pid)}:${row.comm.trim()}`
      if (row.kernelExecutableError) return `${hop} <kernel-error: ${row.kernelExecutableError}>`
      return row.kernelExecutable ? `${hop} <${row.kernelExecutable}>` : hop
    })
    .join(" <- ")
}

function readProcessAncestry(startPid: number, stopPid?: number, kernelIdentity = false): AncestryRow[] {
  const rows: AncestryRow[] = []
  const seen = new Set<number>()
  let pid = startPid
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid)
    const measured = process.platform === "darwin" && stopPid !== undefined
    const env = { ...process.env, LC_ALL: "C", TZ: "UTC" }
    const birth = () =>
      parseLstart(
        execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
          encoding: "utf8",
          timeout: 1000,
          maxBuffer: 256,
          env,
        }),
      )
    const before = measured ? birth() : undefined
    const line = execFileSync(
      "/bin/ps",
      measured
        ? ["-p", String(pid), "-o", "pid=,ppid=,uid=,ruid=,tty="]
        : ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "comm="],
      {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 256,
        env,
      },
    ).trim()
    const match = (measured ? /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/ : /^(\d+)\s+(\d+)\s+(.+)$/).exec(line)
    const pidText = match?.[1]
    const ppidText = match?.[2]
    const comm = measured
      ? execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], {
          encoding: "utf8",
          timeout: 1000,
          maxBuffer: 256,
          env,
        }).trim()
      : match?.[3]
    if (!pidText || !ppidText || comm === undefined || Number(pidText) !== pid) {
      throw new Error(`Hosted Darwin ancestry ps parse failed for pid ${pid}: ${JSON.stringify(line)}`)
    }
    const row: AncestryRow = { pid: Number(pidText), ppid: Number(ppidText), comm: comm.trim() }
    if (kernelIdentity && process.platform === "darwin") {
      // Tmux attachment and hosted ancestry evidence both need kernel paths, never argv0 as a substitute.
      // The measured mux walk keeps this read inside its existing birth check.
      const kernel = kernelExecPath(row.pid)
      row.kernelExecutable = kernel.path
      row.kernelExecutableReader = kernel.reader
      row.kernelExecutableError = kernel.error
      row.kernelExecutableAttempts = kernel.attempts
    }
    if (measured) {
      row.uid = Number(match?.[3])
      row.startedAtEpochSeconds = before
      const tty = match?.[5]
      if (tty === "??") row.ttyRdev = null
      else {
        if (!tty || !/^tty[a-zA-Z0-9._-]+$/.test(tty)) throw new Error(`Darwin pid ${pid} has no measured TTY name`)
        let raw: string
        try {
          raw = execFileSync("/usr/bin/stat", ["-f", "%r", `/dev/${tty}`], {
            encoding: "utf8",
            timeout: 1000,
            maxBuffer: 256,
          })
        } catch (error) {
          throw new Error(
            `Darwin pid ${pid} TTY /dev/${tty} could not be measured: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
        if (!/^[0-9]+\n?$/.test(raw)) {
          throw new Error(`Darwin pid ${pid} TTY rdev is not decimal: ${JSON.stringify(raw)}`)
        }
        row.ttyRdev = Number(raw.trim())
      }
      const command = processCommand(pid)
      if (command === null) throw new Error(`Darwin pid ${pid} command could not be measured`)
      row.command = command
      if (birth() !== before) throw new Error(`Darwin pid ${pid} birth changed during measurement`)
    }
    rows.push(row)
    if (pid === stopPid) break
    if (hostedDarwinCommBase(row.comm) === "launchd" || row.pid === 1 || row.ppid === 0 || row.ppid === row.pid) break
    pid = row.ppid
  }
  return rows
}

type DarwinMuxInput = { subject: ProbeSubject; outerApp: OuterAppProof }

/** Complete the existing proof from the one ancestry reader. Historical launch bytes stay intact;
 * the existing placement owner performs their strict outer-launch join. */
function readDarwinMuxAttachment(
  input: DarwinMuxInput,
  assertion: ProcessOwnerAssertion,
  captureRunId: string,
): DarwinMuxAttachmentProof {
  const { subject, outerApp } = input
  const mux = subject.id
  if (subject.kind !== "mux" || mux !== "tmux" || subject.mux !== mux || !subject.config) {
    throw new Error("Darwin mux target has no measured mux/configuration")
  }
  const rows = readProcessAncestry(process.pid, assertion.ownerPid, true)
  const chain = rows.map((row) => {
    if (row.uid === undefined || row.startedAtEpochSeconds === undefined || row.ttyRdev === undefined) {
      throw new Error(`Darwin pid ${row.pid} lacks measured birth, UID or TTY`)
    }
    return {
      pid: row.pid,
      ppid: row.ppid,
      uid: row.uid,
      startedAtEpochSeconds: row.startedAtEpochSeconds,
      executablePath: row.comm,
      ttyRdev: row.ttyRdev,
      kernelExecutable: row.kernelExecutable,
      kernelExecutableReader: row.kernelExecutableReader,
      kernelExecutableError: row.kernelExecutableError,
      kernelExecutableAttempts: row.kernelExecutableAttempts,
    }
  })
  const collector = chain[0],
    shell = chain.at(-3),
    owner = chain.at(-1)
  const server = chain[1]
  if (!collector || !shell || !owner || !server?.kernelExecutable) {
    throw new Error("Darwin mux ancestry lacks named roles")
  }
  const binary = server.kernelExecutable
  const run = (args: string[]) => {
    const result = spawnSync(binary, args, {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 4096,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    })
    if (result.error || result.signal || result.status !== 0) {
      throw new Error(`Darwin mux ${binary} ${args.join(" ")} failed: ${JSON.stringify(result)}`)
    }
    return { stdout: String(result.stdout), stderr: String(result.stderr) }
  }
  const argv = rows[1]?.command?.split(/\s+/) ?? []
  if (/\s/.test(subject.config) || !argvCarriesMarker(argv, { flag: "-f", value: subject.config })) {
    throw new Error("Darwin mux live argv differs from its explicit configuration")
  }
  const named = argv.indexOf("-S")
  const selected = named >= 0 && argv.lastIndexOf("-S") === named ? argv[named + 1] : undefined
  if (!selected) throw new Error("Darwin mux live argv names no unique socket/session")
  const socketPath = selected
  if (!isAbsolute(socketPath)) throw new Error("Darwin tmux socket is not an absolute measured path")
  const listed = run([
    "-S",
    socketPath,
    "list-clients",
    "-F",
    "#{client_pid}\t#{client_tty}\t#{session_id}\t#{client_session}",
  ])
    .stdout.trim()
    .split("\n")
  const fields = listed[0]?.split("\t")
  if (listed.length !== 1 || !fields || fields.length !== 4) {
    throw new Error("Darwin tmux has no unique measured attached client")
  }
  const [clientPid, clientTty, sessionId, sessionName] = fields
  if (!clientPid || !clientTty || !sessionId || !sessionName || !/^[0-9]+$/.test(clientPid)) {
    throw new Error("Darwin tmux attached-client fields are missing or malformed")
  }
  const clientRows = readProcessAncestry(Number(clientPid), assertion.ownerPid, true)
  const row = clientRows[0]
  if (
    !row ||
    row.uid === undefined ||
    row.startedAtEpochSeconds === undefined ||
    row.ttyRdev === undefined ||
    clientRows[1]?.pid !== shell.pid ||
    row.kernelExecutable !== binary
  ) {
    throw new Error("Darwin tmux client is not the measured outer shell child")
  }
  if (!/^\/dev\/tty[a-zA-Z0-9._-]+$/.test(clientTty) || statSync(clientTty).rdev !== row.ttyRdev) {
    throw new Error("Darwin tmux listed client TTY differs from the measured client")
  }
  const client = {
    ...row,
    startedAtEpochSeconds: row.startedAtEpochSeconds,
    ttyRdev: row.ttyRdev,
    executablePath: row.comm,
    uid: row.uid,
  }
  const session = sessionName
  const serverPid = run(["-S", socketPath, "display-message", "-p", "#{pid}"]).stdout.trim()
  const panes = run([
    "-S",
    socketPath,
    "list-panes",
    "-a",
    "-F",
    "#{session_id}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{socket_path}",
  ])
    .stdout.trim()
    .split("\n")
  const pane = panes
    .map((line) => line.split("\t"))
    .filter((row) => row[0] === sessionId && row[2] === String(collector.pid) && row[4] === socketPath)
  if (serverPid !== String(server.pid) || pane.length !== 1) {
    throw new Error("Darwin tmux socket/session does not join the measured collector/server")
  }
  const paneTty = pane[0]?.[3]
  if (!paneTty || !/^\/dev\/tty[a-zA-Z0-9._-]+$/.test(paneTty) || statSync(paneTty).rdev !== collector.ttyRdev) {
    throw new Error("Darwin tmux listed pane TTY differs from the measured collector")
  }
  if (!statSync(socketPath).isSocket()) throw new Error(`Darwin mux socket ${socketPath} is not a socket`)
  const rawPreflight = outerApp.rawReplies["collector.preflightIdentity"]
  const launch = outerApp.rawReplies["collector.outerLaunch"]
  if (!rawPreflight || !launch) throw new Error("Darwin mux lacks retained preflight identity or outer launch bytes")
  const value = parseJsonStrict("Darwin mux outer preflight", rawPreflight)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Darwin mux preflight identity is not an object")
  }
  const preflight = value as Record<string, unknown>
  if (preflight.launchRunId !== assertion.launchRunId) throw new Error("Darwin mux preflight names another launch run")
  const bootReader = HOSTED_IDENTITY_SOURCES.macOS.sources.bootIdSha256
  const bootId = execFileSync(`/usr/sbin/${bootReader.command}`, [...bootReader.args], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 256,
  }).trim()
  const version = run(["-V"])
  const versionText = version.stdout + version.stderr
  const tokens = measuredVersionTokens(versionText)
  if (tokens.length !== 1) throw new Error("Darwin tmux version has no unique measured version")
  const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
  const proof = parseMuxAttachmentProof({
    platform: "darwin",
    mux,
    bootId,
    receiptSha256: digest(launch),
    launchRunId: assertion.launchRunId,
    captureRunId,
    preflightCollector: { pid: preflight.pid, startedAtEpochSeconds: preflight.startedAtEpochSeconds },
    outerShell: { pid: shell.pid, startedAtEpochSeconds: shell.startedAtEpochSeconds, ttyRdev: shell.ttyRdev },
    outerTerminal: { pid: assertion.ownerPid, startedAtEpochSeconds: owner.startedAtEpochSeconds },
    collector: {
      pid: collector.pid,
      startedAtEpochSeconds: collector.startedAtEpochSeconds,
      ttyRdev: collector.ttyRdev,
    },
    attachedClient: { pid: client.pid, startedAtEpochSeconds: client.startedAtEpochSeconds, ttyRdev: client.ttyRdev },
    chain,
    executable: {
      path: binary,
      sha256: digest(readFileSync(binary)),
      version: tokens[0],
    },
    config: { path: subject.config, sha256: digest(readFileSync(subject.config)) },
    socketPath,
    session,
  })
  if (proof.platform !== "darwin") throw new Error("Darwin mux producer returned another platform")
  return proof
}
type OutputBinding = LinuxBinding | DarwinBinding | WindowsBinding

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

/** Darwin's ps name is paired with a same-read stat of that named PTY. Both Darwin claim arms bind
 * through this one function: they differ in how the TTY was proven, never in the device binding. */
function darwinOutput(out: NodeJS.WriteStream, assertedTty: string): DarwinBinding {
  if (out !== process.stdout || (out as { fd?: unknown }).fd !== 1) {
    throw new Error("Owned Darwin output requires the daemon's real stdout PTY")
  }
  selectedFd(out)
  const controllingTty = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "tty="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 256,
  }).trim()
  if (!/^tty[a-zA-Z0-9._-]+$/.test(controllingTty)) {
    throw new Error(`Owned Darwin worker has no valid controlling TTY: ${JSON.stringify(controllingTty)}`)
  }
  if (`/dev/${controllingTty}` !== assertedTty) {
    throw new Error(`Owned Darwin worker TTY /dev/${controllingTty} differs from asserted tab ${assertedTty}`)
  }
  const inputDevice = device(fstatSync(0, { bigint: true }))
  const outputDevice = device(fstatSync(1, { bigint: true }))
  const tabDevice = device(statSync(assertedTty, { bigint: true }))
  if (!sameDevice(inputDevice, outputDevice) || !sameDevice(outputDevice, tabDevice)) {
    throw new Error("Owned Darwin input, selected stdout and asserted tab PTY device identities differ")
  }
  return { platform: "darwin", selectedFd: 1, controllingTty, tabTty: assertedTty, inputDevice, outputDevice }
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

/** Hosted Windows console bind. There is no fd device to compare on Windows - the collector's own
 * CONOUT$ stream IS the console - so the bind is (a) this is the collector's own controlling output
 * stream and (b) the console window handle the geometry read is checked against. */
function windowsHostedOutput(out: NodeJS.WriteStream, consoleIdentity: string): WindowsBinding {
  if (process.platform !== "win32") throw new Error("Owned Windows hosted terminal requires Windows")
  if (!wasCollectorOpenedControllingTTY(out)) {
    throw new Error("Owned Windows hosted terminal requires the collector's own CONOUT$ output stream")
  }
  return { platform: "windows", consoleIdentity }
}

const geometrySource = (binding: OutputBinding): OwnedTerminal["geometrySource"] =>
  binding.platform === "linux"
    ? "stty size on a /proc/self/fd reopen of the verified output device"
    : binding.platform === "darwin"
      ? "stty size on a /dev/fd reopen of the verified output device"
      : WINDOWS_FFI_SOURCE

/** Always reopen the selected output, verify that clone, then ask stty for a fresh size. */
async function readBoundGeometry(
  binding: OutputBinding,
  windowsKernel?: ReturnType<typeof loadKernel32>,
): Promise<GeometryMeasurement> {
  // The Windows arm is the one read with no fd to reopen: the console read IS the verified read, on
  // the console windowsHostedOutput bound this process to.
  if (binding.platform === "windows") return readWindowsBoundGeometry(windowsKernel)
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

/**
 * The Windows geometry read. The source names WHICH read answered (the ffi console read, or the
 * `mode con` fallback) rather than claiming the primary; with neither answering, the result is
 * `unavailable` carrying both attempts' diagnostics, so the caller keeps today's loud note instead
 * of grading on a guessed size.
 */
async function readWindowsBoundGeometry(kernel?: ReturnType<typeof loadKernel32>): Promise<GeometryMeasurement> {
  const at = new Date().toISOString()
  // The arm loads kernel32 once; the geometry read reuses that binding instead of loading a second.
  const read = await readConsoleGeometry({ ffi: () => readWindowsConsoleGeometry(kernel) })
  if (read.status === "measured") {
    return {
      status: "measured",
      at,
      source: read.via === "ffi" ? WINDOWS_FFI_SOURCE : WINDOWS_MODE_CON_SOURCE,
      rows: read.rows,
      cols: read.cols,
      stdout: "",
      stderr: "",
    }
  }
  return {
    status: "unavailable",
    at,
    source: WINDOWS_FFI_SOURCE,
    diagnostic: read.diagnostic,
    stdout: "",
    stderr: "",
  }
}

const verifiedTerminalOwners = new WeakMap<
  OwnedTerminal,
  { captureRunId: string; out: NodeJS.WriteStream; processOwnerBasis?: string }
>()

export function ownedTerminalVerifiedFor(
  owner: OwnedTerminal | undefined,
  captureRunId: string,
  out: NodeJS.WriteStream,
): boolean {
  const grant = owner && verifiedTerminalOwners.get(owner)
  return grant !== undefined && grant.captureRunId === captureRunId && grant.out === out
}

/** The verified process arm's lifetime basis, bound to the same live capture grant. */
export function ownedTerminalProcessBasisFor(
  owner: OwnedTerminal | undefined,
  captureRunId: string,
  out: NodeJS.WriteStream,
): string | undefined {
  return owner && ownedTerminalVerifiedFor(owner, captureRunId, out)
    ? verifiedTerminalOwners.get(owner)?.processOwnerBasis
    : undefined
}

/**
 * A read reduced to what a record may publish: which read it was, the receipt's hash and length so the
 * receipt can be matched without being shown, and the counts it proved (@cto REVISE 2026-11-13).
 */
const cmuxReadRecord = (kind: "grant" | "read", receipt: string, facts: CmuxReadFacts): CmuxLastRead => ({
  kind,
  receiptSha256: createHash("sha256").update(receipt).digest("hex"),
  receiptLength: receipt.length,
  ...facts,
})

const pathSeparator = /[\\/]/u

/**
 * A refusal's code is always publishable; its reason is a diagnostic the CLI wrote and may name the path it
 * failed on. A reason carrying a separator is withheld by name rather than published or silently dropped.
 */
const publishedRefusal = (failure: string): string => {
  const split = failure.indexOf(": ")
  const code = split === -1 ? failure : failure.slice(0, split)
  const reason = split === -1 ? "" : failure.slice(split + 2)
  if (reason === "") return code
  return pathSeparator.test(reason) ? code + " (reason withheld: names a host path)" : failure
}

/** The only path that registers a grant: platform validation, optional Linux fixture, then geometry. */
export async function createOwnedTerminal(options: {
  captureRunId: string
  onRetained?: Parameters<typeof retain>[3]
  out: NodeJS.WriteStream
  expectedLaunchRunId: string
  linux?: { receiptPath: string; executable: LiveExecutable }
  terminalApp?: TerminalAppOwnerAssertion
  process?: ProcessOwnerAssertion
  darwinMux?: DarwinMuxInput
  /** Retain this outer collector's identity before the launcher attaches a mux. */
  darwinPreflight?: boolean
  darwinHosted?: { receiptPath: string }
  windowsHosted?: { receiptPath: string }
  /** The collector's already-owned window capture, called before native semantic fixture restoration. */
  appSemanticCapture?: (featureId: string, phase: string) => Promise<unknown>
}): Promise<OwnedTerminal> {
  const {
    captureRunId,
    out,
    expectedLaunchRunId,
    linux,
    terminalApp,
    process: processOwner,
    darwinMux,
    darwinPreflight,
    darwinHosted,
    windowsHosted,
  } = options
  if (!/^[0-9a-f]{32}$/.test(captureRunId)) throw new Error("Invalid capture run ID for owned terminal")
  if (!/^[0-9a-f]{32}$/.test(expectedLaunchRunId)) throw new Error("Invalid launch run ID for owned terminal")
  const armCount = [linux, terminalApp, processOwner, darwinHosted, windowsHosted].filter(Boolean).length
  if (armCount !== 1) throw new Error("Owned terminal requires exactly one platform receipt")
  let binding: OutputBinding
  let hostedApp: HostedDarwinApp | undefined
  /** The receipt's own executable path, kept for the per-read ancestry re-check (8c084f05). */
  let hostedAppExecutablePath: string | undefined
  let hostedWindowsApp: HostedWindowsApp | undefined
  let windowsWezTermExecutable: string | undefined
  let hostedAncestor: AncestryRow | undefined
  let processOwnerPid: number | undefined
  let terminalAppPid: number | undefined
  let expectedWindowId: number | undefined
  let processOwnerBasis: string | undefined
  let darwinAttachment: DarwinMuxAttachmentProof | undefined
  /** The owned-process arm's own proof, re-run before a later history read (31741). */
  let processOwnerRecheck: (() => void) | undefined
  let preflightIdentity: { pid: number; startedAtEpochSeconds: number; launchRunId: string } | undefined
  let hostedReceiptSha256: string | undefined
  let hostedPid1Comm: string | undefined
  /** The console host whose buffer the Windows cell read sees, or the reason none could be
   * selected. Windows Terminal draws the window and the host owns the buffer, so the name must come
   * from the process table and never from the drawing program. */
  let windowsConsoleHost: ConsoleHostLookup | undefined
  /** The console identity this run bound to, re-checked before every cell read. */
  let windowsConsoleIdentity: string | undefined
  /** One kernel32 binding for the whole arm: the identity, table, geometry and cell reads share it. */
  let windowsKernel: ReturnType<typeof loadKernel32> | undefined
  if (linux) {
    if (process.platform !== "linux") throw new Error("Owned Linux fixture requires Linux")
    binding = linuxOutput(out)
  } else if (terminalApp) {
    if (process.platform !== "darwin") throw new Error("Terminal.app owner requires Darwin")
    const assertion = parseTerminalAppOwner(terminalApp)
    expectedWindowId = assertion.windowId
    requireOwnWorker(assertion, expectedLaunchRunId, "Terminal.app")
    binding = darwinOutput(out, assertion.tabTty)
    // The app's pid, for macOS keys posted to that pid only (33587, @cto 60e39dfc b): the assertion
    // names the window and tab, not the app, so it is read from this collector's own ancestry. A
    // chain that never reaches Terminal leaves the pid absent and says so here; input then refuses
    // by name ("no measured app PID") and nothing else on the run changes. The pid read is printed
    // by the input install's own report.
    try {
      terminalAppPid = requireHostedDarwinAppAncestor("Terminal", readProcessAncestry(process.pid)).pid
    } catch (error) {
      process.stderr.write(`Terminal.app pid not read: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  } else if (processOwner) {
    if (process.platform !== "darwin") throw new Error("Owned process owner requires Darwin")
    const assertion = parseProcessOwnerAssertion(processOwner)
    requireOwnWorker(assertion, expectedLaunchRunId, assertion.provider)
    let basis: ProcessOwnerBasis
    let disposableBasis: string | undefined
    switch (assertion.basis.kind) {
      case "marker": {
        // The marker must carry THIS launch run id, by runScopedMarker's own rule: a marker from another
        // run would let a live process belonging to that run satisfy this one's proof.
        const marker = runScopedMarker({
          appName: assertion.provider,
          runId: expectedLaunchRunId,
          flag: assertion.basis.marker.flag,
          value: assertion.basis.marker.value,
        })
        basis = { kind: "marker", marker }
        disposableBasis = `Disposable prerequisite satisfied by run-scoped process owner pid ${assertion.ownerPid}, marker ${marker.flag} ${marker.value}`
        break
      }
      case "sole-instance":
        // iTerm2 (@cto 11983ea0): the admin's preflight found no instance, so there is no argv to read;
        // the pid, executable, TTY and ancestry below are re-verified here. It runs the operator's own
        // profile, so it makes no disposable-prerequisite claim.
        basis = assertion.basis
        break
      default: {
        const unknown: never = assertion.basis
        throw new Error(`Process owner assertion has an unknown ownership basis: ${JSON.stringify(unknown)}`)
      }
    }
    if (darwinMux) darwinAttachment = readDarwinMuxAttachment(darwinMux, assertion, captureRunId)
    // The one process proof, not a second reading of ps/argv/ancestry: the same function the admin
    // calls, with the daemon (this worker) as the process that must descend from the owner.
    const ownedProcess = {
      ownerPid: assertion.ownerPid,
      executablePath: assertion.executablePath,
      basis,
      tty: assertion.tty,
    }
    const ownerDaemonPid = darwinAttachment ? darwinAttachment.attachedClient.pid : process.pid
    assertOwnedProcess(ownedProcess, ownerDaemonPid, assertion.provider)
    if (assertion.provider === "iterm2") expectedWindowId = assertion.windowId
    // A history read that happens later re-runs this same proof rather than trusting the grant: the
    // pid may be reused and the marker may be gone, and a reading must not outlive the ownership it
    // claims (31741).
    processOwnerRecheck = () => assertOwnedProcess(ownedProcess, ownerDaemonPid, assertion.provider)
    processOwnerBasis = disposableBasis
    processOwnerPid = assertion.ownerPid
    binding = darwinAttachment ? darwinHostedOutput(out) : darwinOutput(out, assertion.tty)
    if (darwinPreflight) {
      const collector = readProcessAncestry(process.pid, process.pid)[0]
      if (!collector || collector.startedAtEpochSeconds === undefined) {
        throw new Error("Darwin outer collector birth could not be measured")
      }
      preflightIdentity = {
        pid: collector.pid,
        startedAtEpochSeconds: collector.startedAtEpochSeconds,
        launchRunId: expectedLaunchRunId,
      }
    }
  } else if (darwinHosted) {
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
    hostedAppExecutablePath = executablePath
    binding = darwinHostedOutput(out)
    const ancestry = readProcessAncestry(process.pid, undefined, true)
    // Prints before the app check, so a refusal by requireHostedDarwinAppAncestor still leaves the
    // measured chain in the artifact; the binding itself runs earlier, on darwinHostedOutput.
    process.stderr.write(`Hosted Darwin measured process ancestry: ${formatHostedDarwinAncestry(ancestry)}\n`)
    hostedAncestor = requireHostedDarwinAppAncestor(hostedApp.comm, ancestry, executablePath)
    hostedReceiptSha256 = receipt.sha256
    hostedPid1Comm = execFileSync("/bin/ps", ["-p", "1", "-o", "comm="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 256,
    }).trim()
    process.stderr.write(`Hosted Darwin measured ps -p 1 -o comm=: ${JSON.stringify(hostedPid1Comm)}\n`)
  } else {
    if (!windowsHosted) throw new Error("Owned terminal requires exactly one platform receipt")
    if (process.platform !== "win32") throw new Error("Owned Windows hosted terminal requires Windows")
    const receipt = readDisposableReceipt(windowsHosted.receiptPath)
    if (receipt.kind !== "github-hosted-runner") {
      throw new Error(
        `Owned Windows hosted terminal requires a github-hosted-runner receipt, not ${JSON.stringify(receipt.kind)}`,
      )
    }
    const appLaunch = receipt.appLaunch
    // The win32 member of the appLaunch union is the discriminator, so a receipt from another
    // platform cannot pass as this one's.
    if (appLaunch?.platform !== "win32") {
      throw new Error("Hosted Windows github-hosted-runner receipt names no win32 appLaunch")
    }
    hostedWindowsApp = hostedWindowsAppFromExecutablePath(appLaunch.executablePath)
    if (hostedWindowsApp.id === "wezterm") {
      windowsWezTermExecutable = win32.join(win32.dirname(appLaunch.executablePath), "wezterm.exe")
    }
    // The receipt's own launch id must be THIS launch, the same claim the Terminal.app arm makes.
    if (receipt.runId !== expectedLaunchRunId) {
      throw new Error(`Hosted Windows receipt run id ${receipt.runId} differs from this launch ${expectedLaunchRunId}`)
    }
    // The walk runs and PRINTS before the CONOUT$ precondition is checked: a refusal at the binding
    // must not leave the toolhelp32 layout - the one read here never yet seen from real bytes - unread
    // in the artifact. The Darwin arm prints its ps evidence to stderr the same way.
    windowsKernel = loadKernel32()
    // The TABLE, not the ancestry walk: the console host is the terminal's other child, a sibling
    // of the shell, so a chain from this process can never contain it.
    const windowsTable = readWindowsProcessTable(process, windowsKernel)
    const windowsAncestry = windowsProcessAncestry(windowsTable, process.pid)
    process.stderr.write(
      `Hosted Windows measured process ancestry: ${windowsAncestry
        .map((row) => `${String(row.pid)}:${row.comm}`)
        .join(" <- ")}\n`,
    )
    hostedAncestor = requireHostedWindowsAppAncestor(hostedWindowsApp.comm, windowsAncestry)
    windowsConsoleHost = consoleHostFromTable(hostedAncestor.pid, windowsTable)
    process.stderr.write(
      `Hosted Windows console buffer owner: ${
        windowsConsoleHost.status === "named"
          ? `${windowsConsoleHost.host.image} (pid ${String(windowsConsoleHost.host.pid)}, parent ${String(windowsConsoleHost.host.ppid)})`
          : `refused: ${windowsConsoleHost.reason}`
      }\n`,
    )
    windowsConsoleIdentity = readWindowsConsoleIdentity(windowsKernel)
    binding = windowsHostedOutput(out, windowsConsoleIdentity)
    hostedReceiptSha256 = receipt.sha256
  }
  let clipboard: LinuxClipboardAdapter | undefined
  const kittyOwner =
    binding.platform === "darwin" && processOwner?.provider === "kitty"
      ? parseProcessOwnerAssertion(processOwner)
      : undefined
  // The two macOS terminals that answer no cell geometry: their read is the app's own text
  // snapshot, selected by the owned tab's TTY. Every other Darwin app keeps the capture path.
  const darwinTextApp: TerminalTextApp | "kitty" | undefined =
    binding.platform === "darwin"
      ? kittyOwner
        ? "kitty"
        : terminalApp
          ? "terminal-app"
          : hostedApp?.id === "terminal-app" || hostedApp?.id === "iterm2"
            ? hostedApp.id
            : undefined
      : undefined
  const darwinTextTty = binding.platform === "darwin" ? binding.tabTty : undefined
  // One executable digest per console host per run: the identity is resolved on every read because
  // a pid can be reused, but a 598-capture run has no reason to hash the same file 598 times.
  const windowsExecutableDigests = new Map<string, string>()
  try {
    if (linux) {
      clipboard = await createLinuxClipboardAdapter(
        linux.receiptPath,
        expectedLaunchRunId,
        linux.executable,
        captureRunId,
        async () => {
          const geometry = await readBoundGeometry(binding, windowsKernel)
          return geometry.status === "measured" ? geometry.rows : undefined
        },
      )
    } else if (darwinHosted && hostedApp) {
      // #30724 (@cto 41cd2559 condition 1 and 2): the hosted arm is the same implementation as the
      // owned-host sentinel path, told apart only by the disposable fact this branch already proved
      // - the receipt above is a github-hosted-runner or this run never got here. A fresh runner's
      // pasteboard starts empty, so without the sentinel a negative grade has nothing to compare
      // against. Restore of earlier contents stays off: a single-use machine has none to restore.
      clipboard = await createDarwinClipboardAdapter({
        appComm: hostedApp.comm,
        appId: hostedApp.id,
        titleRead: hostedApp.titleRead,
        ...(hostedApp.titleUnavailable === undefined ? {} : { titleUnavailable: hostedApp.titleUnavailable }),
        disposableHost: { receiptKind: "github-hosted-runner" },
        assertOwned: () =>
          process.platform === "darwin"
            ? Promise.resolve()
            : Promise.reject(new Error("Darwin pasteboard read left Darwin")),
      })
    }
    if (!clipboard && binding.platform === "darwin" && terminalApp) {
      // @cto 1c7e19df and @dev/3's REVISE: condition 4 is about the machine's SHARED pasteboard, so
      // the platform alone is not ownership. The first pbcopy in the adapter below must be preceded
      // by the admin's own window assert, run here with this worker's pid: the window and tab the
      // launch recorded must still be the run's, or nothing touches the shared pasteboard at all.
      const ownedShell = parseTerminalAppOwner(terminalApp)
      // 31741's follow-on: the owned Terminal.app window is the app this run owns, so its pasteboard
      // is a fixture for the subject the run measures. Without this the artifact records no
      // clipboard fixture at all and the OSC 52 rows cannot say anything but "no fixture".
      clipboard = await createDarwinClipboardAdapter({
        appComm: TERMINAL_APP_HOSTED.comm,
        appId: TERMINAL_APP_HOSTED.id,
        titleRead: "none",
        titleUnavailable: "The owned Terminal.app tab reads its title through JXA, not this pasteboard",
        ownedHost: true,
        assertOwned: async () => {
          if (process.platform !== "darwin") throw new Error("Darwin pasteboard read left Darwin")
          assertOwnedTerminalWindow(
            { provider: "terminal-app", windowId: ownedShell.windowId, tty: ownedShell.tabTty },
            process.pid,
          )
        },
      })
    }
    const muxAttachmentProof = binding.platform === "darwin" ? darwinAttachment : clipboard?.muxAttachmentProof
    // An owned Terminal.app window reads its title through the tab's JXA reader, never through a
    // pasteboard adapter: that adapter's title path spawns System Events, which is the 33821 bug.
    const readTitle = terminalApp ? undefined : clipboard?.readTitle.bind(clipboard)
    const withIconNameFixture = clipboard?.withIconNameFixture?.bind(clipboard)
    const assertIconOwner = clipboard?.assertOwned.bind(clipboard)
    // A mux's own reader wins; foreign terminal variables never select an App reader.
    //
    // The app id is resolved in ONE place (@cto 8c084f05): the hosted Darwin arm's receipt already proved it from
    // the launched executable and the measured ancestry, so a launcher-typed variable must not be a second source
    // for a fact the receipt carries; the Linux arm has no such receipt and keeps the launcher's value unchanged.
    const launcherAppId = process.env.TERMINFO_TARGET_ID
    const ownedAppId = resolveOwnedAppId({
      platform: binding.platform,
      hostedAppId: hostedApp?.id,
      launcherAppId,
    })
    const nativeEditorId =
      binding.platform === "darwin" &&
      !muxAttachmentProof &&
      (ownedAppId === "cursor" || ownedAppId === "com.microsoft.VSCode")
        ? ownedAppId
        : undefined
    const assertNativeEditorProcess = (pid: number, collectorAncestor = false) => {
      if (!hostedApp || !hostedAncestor) throw new Error("Native editor read has no measured hosted App ancestor")
      const actual = requireHostedDarwinAppAncestor(
        hostedApp.comm,
        readProcessAncestry(pid),
        hostedAppExecutablePath,
      ).pid
      if (actual !== hostedAncestor.pid) {
        throw new Error(`Native editor ancestor is now pid ${actual}, not pid ${hostedAncestor.pid} measured at launch`)
      }
      if (collectorAncestor && !readProcessAncestry(process.pid).some((ancestor) => ancestor.pid === pid)) {
        throw new Error(`Native terminal pid ${pid} is not an ancestor of this collector`)
      }
    }
    // The Darwin clipboard adapter's assertOwned resolves without proving anything, so it stays bound to the
    // launcher variable exactly as before: it is a Linux-arm ownership proof and never a Darwin one (8c084f05).
    const appClipboard =
      !muxAttachmentProof && (launcherAppId === "kitty" || launcherAppId === "wezterm") ? clipboard : undefined
    // Presence only, never the values (A0, folded into this change by 8c084f05's addendum): the receipt records
    // whether the pane published the two things an owned read needs, which decides whether a reader can exist.
    const wezTermPaneEnvironment = {
      socket: (process.env.WEZTERM_UNIX_SOCKET ?? "").trim() !== "",
      paneId: (process.env.WEZTERM_PANE ?? "").trim() !== "",
    }
    // Why an owned WezTerm read cannot exist on this arm, in the history row's own words. This is a PROBE TODO
    // reason, never a declaration: the app may well expose a read; this arm has no way to reach it.
    const wezTermOwnedReadProbeTodo =
      binding.platform === "darwin" && darwinHosted !== undefined && ownedAppId === "wezterm"
        ? hostedWezTermPrerequisites({
            socketPresent: wezTermPaneEnvironment.socket,
            paneIdPresent: wezTermPaneEnvironment.paneId,
            measuredTty: binding.platform === "darwin" ? binding.tabTty : undefined,
          })
        : undefined
    const kittySocket = process.env.KITTY_LISTEN_ON
    const kittyWindow = process.env.KITTY_WINDOW_ID
    const resetScrollback = clipboard?.resetScrollback?.bind(clipboard)
    // Terminal.app keeps its history on the owned tab: the same JXA read as its screen text (31741).
    let historyControl: TerminalHistoryControl | undefined
    let terminalAppHistory: (() => Promise<TerminalScrollbackReading>) | undefined
    const readTerminalAppHistoryReading =
      darwinTextApp === "terminal-app" && darwinTextTty !== undefined
        ? async () => {
            if (!terminalAppHistory) {
              const geometry = await readBoundGeometry(binding, windowsKernel)
              if (geometry.status !== "measured") {
                throw new ScrollbackReadingUnavailable(
                  `Terminal.app history needs a measured grid: ${geometry.diagnostic}`,
                )
              }
              terminalAppHistory = terminalAppHistoryReader({
                read: () => readTerminalAppHistory({ tty: darwinTextTty, cols: geometry.cols, rows: geometry.rows }),
                write: (text) => {
                  out.write(text)
                },
                rows: geometry.rows,
                nonce: captureRunId,
                onControl: (control) => {
                  historyControl = control
                },
              })
            }
            return terminalAppHistory()
          }
        : undefined
    // An owned WezTerm pane answers history on the owned-process arm too: that arm has no pasteboard
    // adapter, so its live proof is the same assertOwnedProcess the grant ran, re-run at each read.
    // Read at CALL time, never bound here: the adapter's assertOwned is a live field, and a copy taken at
    // construction would answer a check the run has since replaced.
    const processOwnerCheck = processOwnerRecheck
    // The hosted Darwin arm's ownership proof: all three, re-checked before EVERY read, because a reading of a
    // second WezTerm or a recycled pane is not this run's history (@cto 8c084f05).
    const hostedWezTermOwnerCheck =
      binding.platform === "darwin" &&
      darwinHosted !== undefined &&
      ownedAppId === "wezterm" &&
      wezTermOwnedReadProbeTodo === undefined
        ? (): Promise<void> => {
            if (hostedApp === undefined) {
              return Promise.reject(new Error("Hosted WezTerm read has no receipt app"))
            }
            // The three proofs, in order: the same ancestor pid, that pid's own socket, and a measured tty —
            // every one re-read here, before each read (@cto 8c084f05). The check is the first await of the
            // reader, so a refusal means no read was attempted.
            const proof = hostedWezTermOwnerProof({
              readAncestorPid: () =>
                requireHostedDarwinAppAncestor(
                  hostedApp.comm,
                  readProcessAncestry(process.pid, undefined, true),
                  hostedAppExecutablePath,
                ).pid,
              measuredPid: hostedAncestor?.pid,
              socket: process.env.WEZTERM_UNIX_SOCKET,
              heldSockets: (socketPath, pid) => socketHeldByPid({ socketPath, pid }),
              measuredTty: binding.platform === "darwin" ? binding.tabTty : undefined,
            })
            return proof.status === "refused" ? Promise.reject(new Error(proof.reason)) : Promise.resolve()
          }
        : undefined
    const wezTermOwnerCheck =
      hostedWezTermOwnerCheck ??
      (appClipboard !== undefined
        ? () => appClipboard.assertOwned()
        : processOwnerCheck === undefined
          ? undefined
          : () => Promise.resolve(processOwnerCheck()))
    const ownedWezTermCli = ownedWezTermHistoryExecutable({
      platform: binding.platform,
      ownsWezTermPane: ownedAppId === "wezterm" && wezTermOwnerCheck !== undefined,
      ...(linux === undefined ? {} : { linuxExecutablePath: linux.executable.path }),
      environment: process.env,
    })
    // The CLI proof answers "which WezTerm produced this count" (31741): it hashes the bundle's own CLI and
    // reads the version that CLI reports. It runs on EVERY platform, not only macOS: the reader refuses to
    // borrow another binary's proof, so a Linux arm that skipped the proof would record an identity check with
    // no executable at all (@cto REVISE at f1b0a7ffe).
    const ownedWezTermIdentity = wezTermHistoryIdentity(ownedWezTermCli)
    const ownedWezTermHistory =
      wezTermOwnerCheck !== undefined && ownedWezTermCli !== undefined
        ? async (): Promise<TerminalScrollbackReading> => {
            await wezTermOwnerCheck()
            const geometry = await readBoundGeometry(binding, windowsKernel)
            if (geometry.status !== "measured") {
              throw new Error(`Owned WezTerm history needs a measured grid: ${geometry.diagnostic}`)
            }
            const pane = process.env.WEZTERM_PANE
            const socket = process.env.WEZTERM_UNIX_SOCKET
            const read =
              binding.platform === "darwin"
                ? readOwnedWezTermHistory({
                    executable: ownedWezTermCli,
                    pane,
                    socket,
                    ...(binding.tabTty === undefined ? {} : { tty: binding.tabTty }),
                    rows: geometry.rows,
                  })
                : (() => {
                    const rows = readWindowsWezTermRows({
                      executable: ownedWezTermCli,
                      pane,
                      socket,
                      cols: geometry.cols,
                      rows: geometry.rows,
                      startLine: -2147483648,
                    })
                    if (rows.status === "refused") return rows
                    // Windows has no pane list and no tty to compare, so the record names the pane and the
                    // socket's presence and leaves the two tty fields absent rather than guessing one.
                    const identity = ownedHistoryReceipt({
                      surface: "wezterm",
                      pane,
                      socketPresent: socket !== undefined && socket.trim() !== "",
                      executable: ownedWezTermCli,
                    })
                    if (identity.status === "refused") return { status: "refused" as const, reason: identity.reason }
                    return {
                      status: "read" as const,
                      totalLines: rows.rows.length,
                      screenLines: geometry.rows,
                      receipt: identity.receipt,
                    }
                  })()
            await wezTermOwnerCheck()
            if (read.status === "refused") throw new Error(read.reason)
            return { totalLines: read.totalLines, screenLines: read.screenLines, receipt: read.receipt }
          }
        : undefined
    // A cmux surface answers history through its own CLI, and the collector runs INSIDE that surface: the
    // hosted launch writes the initial-command key and opens the app, which is the only caller cmuxOnly
    // admits (@cto plan GO af8608c3, corrected in f6cc9bb8). Ownership is the receipt's app plus the nonce
    // line the run writes into the surface it is running in: a read of any other surface cannot carry it.
    const hostedCmuxOwnerCheck =
      binding.platform === "darwin" && darwinHosted !== undefined && ownedAppId === "cmux"
        ? (): Promise<void> => {
            if (hostedApp === undefined) return Promise.reject(new Error("Hosted cmux read has no receipt app"))
            const ancestorPid = requireHostedDarwinAppAncestor(
              hostedApp.comm,
              readProcessAncestry(process.pid),
              hostedAppExecutablePath,
            ).pid
            return hostedAncestor?.pid !== undefined && ancestorPid !== hostedAncestor.pid
              ? Promise.reject(
                  new Error(
                    "Hosted cmux ancestor is now pid " +
                      ancestorPid +
                      ", not pid " +
                      hostedAncestor.pid +
                      " measured at launch",
                  ),
                )
              : Promise.resolve()
          }
        : undefined
    const ownedCmuxCli = ownedCmuxHistoryExecutable({
      platform: binding.platform,
      ownsCmuxSurface: hostedCmuxOwnerCheck !== undefined,
      ...(hostedAppExecutablePath === undefined ? {} : { declaredExecutable: hostedAppExecutablePath }),
    })
    const ownedCmuxIdentity = ownedCmuxCli === undefined ? undefined : cmuxHistoryIdentity(ownedCmuxCli)
    const cmuxConfigAtLaunch = ownedCmuxCli === undefined ? undefined : observeCmuxConfig(cmuxConfigPath(homedir()))
    // Ownership is proved ONCE here, before the probe writes anything: the nonce line goes into the surface
    // this process is running in and a read that carries it exactly once is this run's own history. Every
    // later read names that surface and writes nothing, so the instrument never moves what it measures
    // (@cto REVISE F1 at 9ae6fad2459). A proof that never reads back leaves every read refusing by name.
    let cmuxSurface: string | undefined
    let cmuxGrantReceipt: string | undefined
    let cmuxGrantFailure: string | undefined
    let cmuxLastRead: CmuxLastRead | undefined
    if (hostedCmuxOwnerCheck !== undefined && ownedCmuxCli !== undefined) {
      const published = (process.env.CMUX_SURFACE_ID ?? "").trim()
      if (published === "") {
        // Without a published id every later read would have to let the CLI pick "whatever surface is
        // current", which is the unnamed read this arm must never make: a second surface in the same
        // instance could then answer for ours (@dev/1 peer read 2026-11-13). Refuse at grant instead.
        cmuxGrantFailure =
          "cmux-surface-not-owned: the app published no CMUX_SURFACE_ID, so no read can name the surface this run acquired"
      } else {
        cmuxSurface = published
        out.write("\nCMUX-" + captureRunId + "-BEGIN\n")
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const proof = readOwnedCmuxHistory({
            executable: ownedCmuxCli,
            surface: published,
            ownership: { kind: "nonce", nonce: captureRunId },
            configAtLaunch: cmuxConfigAtLaunch,
            observeConfig: () => observeCmuxConfig(cmuxConfigPath(homedir())),
          })
          if (proof.status === "read") {
            cmuxGrantReceipt = proof.receipt
            cmuxLastRead = cmuxReadRecord("grant", proof.receipt, proof.facts)
            break
          }
          if (proof.refusal !== "cmux-surface-not-owned") {
            cmuxGrantFailure = `${proof.refusal}: ${proof.reason}`
            break
          }
          // The sentinel may not have rendered yet; a bounded wait is the only thing the grant proof retries.
          await new Promise((resolve) => {
            setTimeout(resolve, 250)
          })
        }
        if (cmuxGrantReceipt === undefined && cmuxGrantFailure === undefined) {
          cmuxGrantFailure = "cmux-surface-not-owned: this run's nonce line never read back from its own surface"
        }
      }
    }
    const ownedCmuxHistory =
      hostedCmuxOwnerCheck !== undefined && ownedCmuxCli !== undefined
        ? async (): Promise<TerminalScrollbackReading> => {
            await hostedCmuxOwnerCheck()
            if (cmuxGrantFailure !== undefined) throw new ScrollbackReadingUnavailable(cmuxGrantFailure)
            const geometry = await readBoundGeometry(binding, windowsKernel)
            if (geometry.status !== "measured") {
              throw new ScrollbackReadingUnavailable("Owned cmux history needs a measured grid: " + geometry.diagnostic)
            }
            const read = readOwnedCmuxHistory({
              executable: ownedCmuxCli,
              ...(cmuxSurface === undefined ? {} : { surface: cmuxSurface }),
              rows: geometry.rows,
              ownership: { kind: "surface" },
              configAtLaunch: cmuxConfigAtLaunch,
              observeConfig: () => observeCmuxConfig(cmuxConfigPath(homedir())),
            })
            if (read.status === "refused") {
              throw new ScrollbackReadingUnavailable(read.refusal + ": " + read.reason)
            }
            cmuxLastRead = cmuxReadRecord("read", read.receipt, read.facts)
            // cmux's own command receipt stays in the grant; the count carries the surface by id, and its
            // surface id is the pane this run proved at grant.
            const identity = ownedHistoryReceipt({
              surface: "cmux",
              pane: cmuxSurface,
              executable: ownedCmuxCli,
            })
            if (identity.status === "refused") throw new ScrollbackReadingUnavailable(identity.reason)
            return { ...read.reading, receipt: identity.receipt }
          }
        : undefined
    const readScrollback =
      clipboard?.getScrollback?.bind(clipboard) ??
      (linux && appClipboard && ownedAppId !== "wezterm"
        ? async () => {
            await appClipboard.assertOwned()
            if (kittySocket === undefined || kittyWindow === undefined) {
              throw new Error("Owned Kitty history requires KITTY_LISTEN_ON and KITTY_WINDOW_ID from its child")
            }
            const kitten = join(dirname(linux.executable.path), "kitten")
            const read = readLinuxKittyScrollback({ kitten, socket: kittySocket, window: kittyWindow })
            await appClipboard.assertOwned()
            if (read.status === "refused") throw new Error(read.reason)
            const identity = ownedHistoryReceipt({
              surface: "kitty",
              pane: kittyWindow,
              socketPresent: kittySocket.trim() !== "",
              executable: kitten,
            })
            if (identity.status === "refused") throw new Error(identity.reason)
            return { totalLines: read.totalLines, screenLines: read.screenLines, receipt: identity.receipt }
          }
        : undefined) ??
      ownedWezTermHistory ??
      ownedCmuxHistory ??
      readTerminalAppHistoryReading
    const geometryAtGrant = await readBoundGeometry(binding, windowsKernel)
    const source = geometrySource(binding)
    const summary = JSON.stringify({
      platform: binding.platform,
      outputBinding: binding,
      geometryAtGrant,
      ...(muxAttachmentProof && { muxAttachment: muxAttachmentProof }),
      ...(ownedWezTermCli !== undefined && {
        // The count's own provenance, including the reason when the version could not be read.
        wezTermHistory:
          ownedWezTermIdentity?.historyExecutable === undefined
            ? {
                executable: ownedWezTermCli,
                // Never an `unmeasured` with no reason: an absent proof is a bug in this file, said out loud.
                unmeasured:
                  ownedWezTermIdentity?.historyExecutableUnmeasured ??
                  `WezTerm CLI ${JSON.stringify(ownedWezTermCli)} proof was never attempted`,
              }
            : { executable: ownedWezTermCli, proof: ownedWezTermIdentity.historyExecutable },
      }),
      ...(preflightIdentity && { preflightIdentity }),
      ...(terminalApp && {
        ownerAssertion: parseTerminalAppOwner(terminalApp),
        ownerAssertionSource: "authenticated-admin-request",
      }),
      ...(processOwner && {
        processOwnerAssertion: parseProcessOwnerAssertion(processOwner),
        ownerAssertionSource: "authenticated-admin-request",
      }),
      ...(hostedWindowsApp && {
        windowsHosted: {
          appId: hostedWindowsApp.id,
          ancestor: hostedAncestor,
          // Which program's buffer a cell read returns, so the evidence can name it.
          consoleHost: windowsConsoleHost?.status === "named" ? windowsConsoleHost.host : null,
          consoleHostRefusal: windowsConsoleHost?.status === "refused" ? windowsConsoleHost.reason : null,
          receiptKind: "github-hosted-runner",
          receiptSha256: hostedReceiptSha256,
        },
      }),
      ...(hostedApp && {
        darwinHosted: {
          appId: hostedApp.id,
          ancestor: hostedAncestor,
          receiptKind: "github-hosted-runner",
          receiptSha256: hostedReceiptSha256,
          pid1Comm: hostedPid1Comm,
        },
      }),
      // Presence booleans only: a reader that needs a socket records whether the pane published one, so a
      // missing route is a named fact in the artifact rather than an inference from an empty result (A0).
      ...(ownedAppId === "wezterm" && { wezTermPaneEnvironment }),
    })
    const hostedAppId = hostedApp?.id ?? hostedWindowsApp?.id
    const appPid = hostedAncestor?.pid ?? processOwnerPid ?? terminalAppPid
    const captureDirectory = process.env.TERMINFO_CAPTURE_DIRECTORY
    if (hostedApp === TERMINAL_APP_HOSTED && captureDirectory) {
      expectedWindowId = readTerminalLaunchWindowId(dirname(captureDirectory))
    }
    // WT uses UIA; WezTerm's candidate uses the owned pane CLI. Both must pass the shared writer's
    // mapping and host-ownership witnesses. Alacritty retains its explicitly unqualified host read.
    const windowsTerminalPid = hostedWindowsApp?.id === "windows-terminal" ? hostedAncestor?.pid : undefined
    const wezTermExecutable = windowsWezTermExecutable
    const readOwnedWindowsRows =
      windowsTerminalPid !== undefined
        ? (geometry: { rows: number; cols: number }) =>
            readWindowsTerminalRows({ pid: windowsTerminalPid, rows: geometry.rows })
        : wezTermExecutable !== undefined
          ? (geometry: { rows: number; cols: number }) =>
              readWindowsWezTermRows({
                executable: wezTermExecutable,
                pane: process.env.WEZTERM_PANE,
                socket: process.env.WEZTERM_UNIX_SOCKET,
                ...geometry,
              })
          : undefined
    const renditions = windowsTerminalPid === undefined ? undefined : createLineRenditionTracker()
    const readConsoleHostCells = async (): Promise<ConsoleCellRead> => {
      if (!verifiedTerminalOwners.has(owner)) throw new Error("Owned cell read has no live bound capture")
      // The console is re-checked as the geometry read re-checks its device: a cell read on a
      // different console than this run bound to is not this run's frame.
      const identity = readWindowsConsoleIdentity(windowsKernel)
      const mismatch = consoleIdentityMismatch(identity, windowsConsoleIdentity)
      if (mismatch !== undefined) throw new Error(mismatch)
      const bufferOwner = consoleBufferOwner(windowsConsoleHost)
      if (bufferOwner.status === "refused") return { status: "refused", reason: bufferOwner.reason }
      const hostIdentity = resolveConsoleHostIdentity(bufferOwner.host, {
        kernel: windowsKernel,
        cache: windowsExecutableDigests,
      })
      if (hostIdentity.status === "refused") return { status: "refused", reason: hostIdentity.reason }
      return readWindowsConsoleCells({ bufferOwner: hostIdentity.host, kernel: windowsKernel })
    }
    const owner: OwnedTerminal = {
      geometryAtGrant,
      geometrySource: source,
      summary,
      ...(appPid !== undefined && { appPid }),
      ...(expectedWindowId !== undefined && { expectedWindowId }),
      ...(binding.platform === "darwin" && { captureWindowSelection: hostedApp?.captureWindowSelection ?? "unique" }),
      ...(hostedAppId && { hostedAppId }),
      ...(hostedApp?.captureChromeBand && { captureChromeBand: hostedApp.captureChromeBand }),
      ...(hostedApp?.scrollbackUnavailable && { scrollbackUnavailable: hostedApp.scrollbackUnavailable }),
      ...(wezTermOwnedReadProbeTodo && { scrollbackProbeTodo: wezTermOwnedReadProbeTodo }),
      ...(ownedAppId === "wezterm" && { wezTermPaneEnvironment }),
      ...(clipboard && { clipboard }),
      // This arm counts through the terminal's own CLI, so its evidence may name only that program: the
      // reader in serve.ts refuses to borrow another binary's proof for it (31741, @dev/18 peer read).
      ...(wezTermOwnerCheck === undefined ? undefined : ownedWezTermIdentity),
      ...(hostedCmuxOwnerCheck === undefined ? undefined : ownedCmuxIdentity),
      ...(ownedCmuxCli !== undefined && {
        cmuxHistory: {
          executable: ownedCmuxCli,
          surface: cmuxSurface ?? null,
          grant:
            cmuxGrantReceipt !== undefined ? "proved" : cmuxGrantFailure !== undefined ? "failed" : "not attempted",
          grantRefusal: cmuxGrantFailure === undefined ? null : publishedRefusal(cmuxGrantFailure),
          grantProof: cmuxGrantReceipt ?? cmuxGrantFailure ?? "not attempted",
          // A getter, not a captured value: this object is built once at owner creation, so a snapshot
          // would pin the field to the grant receipt and never show a later read (@cto 81073ae1).
          get lastRead(): CmuxLastRead | null {
            return cmuxLastRead ?? null
          },
        },
      }),
      ...(readTitle && {
        async readTitle() {
          if (!verifiedTerminalOwners.has(owner)) throw new Error("Owned title read has no live bound capture")
          return readTitle()
        },
      }),
      ...(readTerminalAppHistoryReading && { historyControl: () => historyControl }),
      ...(readScrollback && {
        async getScrollback() {
          if (!verifiedTerminalOwners.has(owner)) throw new Error("Owned history read has no live bound capture")
          return readScrollback()
        },
      }),
      ...(resetScrollback && {
        async resetScrollback() {
          if (!verifiedTerminalOwners.has(owner)) throw new Error("Owned history reset has no live bound capture")
          return resetScrollback()
        },
      }),
      ...(muxAttachmentProof && { muxAttachmentProof }),
      ...((binding.platform === "linux" || binding.platform === "darwin") && {
        async readTermFeatures() {
          if (!verifiedTerminalOwners.has(owner)) {
            return { status: "unavailable" as const, reason: "TERM_FEATURES child read has no live owned capture" }
          }
          // Reuses this owner's device check; geometry need not be measurable to bind the TTY.
          await owner.readGeometry()
          const tty =
            binding.platform === "linux"
              ? `tty_nr=${binding.controllingTtyNr};fd=${binding.selectedFd};rdev=${binding.outputRdev}`
              : binding.controllingTty
          return readTermFeaturesEnvironment(process.env, expectedLaunchRunId, process.pid, tty)
        },
      }),
      ...(nativeEditorId !== undefined && {
        async readAppSemanticState(featureId: string, write: (text: string) => void) {
          if (!verifiedTerminalOwners.has(owner)) {
            return { status: "invalid" as const, reason: "Native editor read has no live owned terminal" }
          }
          const capture = options.appSemanticCapture
          if (!capture) {
            return { status: "unavailable" as const, reason: "Native editor read has no owned window capture" }
          }
          await owner.readGeometry()
          assertNativeEditorProcess(process.pid)
          return readAppSemanticState({
            featureId,
            write,
            runId: expectedLaunchRunId,
            editor: { appId: nativeEditorId, assertProcess: assertNativeEditorProcess, capture },
          })
        },
      }),
      ...(linux && {
        readNotificationEnvironment(): NotificationEnvironmentReading {
          if (!verifiedTerminalOwners.has(owner)) {
            return { status: "refused", reason: "Notification environment read has no live owned terminal" }
          }
          try {
            // A mux run's Notify would come from the outer terminal, which the owned Linux mux launch
            // refuses to be anything but Kitty; a direct app is its own process.
            const pid = muxAttachmentProof ? findAncestorComm("kitty") : kittyAncestor(linux.executable)
            const environment = readProcessEnvironment(pid)
            return {
              status: "measured",
              reason: "Terminal process environment read from /proc",
              pid,
              environment,
              bus: terminalBusState(environment, process.env),
            }
          } catch (error) {
            return { status: "refused", reason: `Terminal process environment unreadable: ${(error as Error).message}` }
          }
        },
      }),
      ...(binding.platform === "darwin" &&
        ownedAppId === "wezterm" && {
          appSemanticStateFeatures: new Set(["extensions.osc7-cwd", "extensions.osc633-p"]),
        }),
      ...((linux || (ownedAppId === "wezterm" && (binding.platform === "linux" || binding.platform === "darwin"))) && {
        async readAppSemanticState(featureId: string, write: (text: string) => void) {
          if (!verifiedTerminalOwners.has(owner)) {
            return { status: "invalid" as const, reason: "App semantic read has no live owned terminal" }
          }
          const ownedPromptCwd = binding.platform === "darwin" && featureId === "extensions.osc633-p"
          if (ownedAppId === "wezterm" && (featureId === "extensions.osc7-cwd" || ownedPromptCwd)) {
            const reviewedVersion = binding.platform === "linux" ? "0-unstable-2026-10-10" : "20240203-110809-5046fc22"
            const cliVersion = /^wezterm (\S+)/m.exec(ownedWezTermIdentity?.historyExecutable?.version ?? "")?.[1]
            if (
              cliVersion !== reviewedVersion ||
              process.env.TERMINFO_TARGET_VERSION !== reviewedVersion ||
              process.env.TERMINFO_RUN_ID !== expectedLaunchRunId ||
              muxAttachmentProof !== undefined ||
              Boolean(process.env.TERMINFO_MUX_KIND)
            ) {
              return {
                status: "invalid" as const,
                reason: "WezTerm OSC7 has no reviewed CLI version bound to this App launch",
              }
            }
            const socket = process.env.WEZTERM_UNIX_SOCKET
            const pane = process.env.WEZTERM_PANE
            const captureDirectory = process.env.TERMINFO_CAPTURE_DIRECTORY
            const onRetained = options.onRetained
            if (
              wezTermOwnerCheck === undefined ||
              ownedWezTermCli === undefined ||
              ownedWezTermIdentity?.historyExecutable === undefined ||
              !socket ||
              !pane ||
              !/^\d+$/.test(pane) ||
              !captureDirectory ||
              !isAbsolute(captureDirectory) ||
              onRetained === undefined
            ) {
              return {
                status: "invalid" as const,
                reason: "WezTerm OSC7 needs an owned pane, measured CLI and private capture with its artifact observer",
              }
            }
            // Every command uses the current owner, including the private restoration write. In
            // particular, never pass the callback's publishable writer a URI from the host's pane.
            const check = async () => {
              if (!verifiedTerminalOwners.has(owner)) throw new Error("WezTerm OSC7 ownership is no longer live")
              await wezTermOwnerCheck()
            }
            let ownershipReceipt: string | undefined
            const nativeReads: string[] = []
            const retainNative = (transcript: string) => {
              try {
                nativeReads.push(retain(captureDirectory, Buffer.from(transcript), "json", onRetained))
              } catch (error) {
                throw new Error("WezTerm OSC7 native evidence retention failed", { cause: error })
              }
            }
            const readPane = async () => {
              await check()
              const read = readOwnedWezTermPane({ executable: ownedWezTermCli, socket, pane })
              await check()
              if (read.status === "refused") throw new Error(read.reason)
              retainNative(read.privateTranscript)
              if (read.matchingPanes !== 1) throw new Error("WezTerm OSC7 owned pane is ambiguous")
              if (binding.platform === "darwin" && ttyName(read.tty) !== ttyName(binding.tabTty)) {
                throw new Error("WezTerm OSC7 pane TTY differs from the measured owner")
              }
              if (
                typeof read.cwd !== "string" ||
                !read.cwd.startsWith("file://") ||
                // eslint-disable-next-line no-control-regex -- raw OSC restoration data must contain no terminal controls
                /[\x00-\x1f\x7f]/.test(read.cwd)
              ) {
                throw new Error("WezTerm OSC7 owned pane has no safe public directory URI")
              }
              const identity = ownedHistoryReceipt({
                surface: "wezterm",
                pane,
                listedTty: read.tty,
                measuredTty: binding.platform === "darwin" ? binding.tabTty : undefined,
                socketPresent: true,
                executable: ownedWezTermCli,
              })
              if (identity.status === "refused") throw new Error(identity.reason)
              ownershipReceipt = identity.receipt
              return read.cwd
            }
            const readText = async () => {
              await check()
              const geometry = await owner.readGeometry()
              await check()
              if (geometry.status !== "measured") throw new Error("WezTerm OSC7 text fence needs measured geometry")
              const read = readWindowsWezTermRows({ executable: ownedWezTermCli, socket, pane, rows: geometry.rows })
              await check()
              if (read.status === "refused") throw new Error(read.reason)
              retainNative(read.receipt)
              return read.rows.join("\n")
            }
            if (ownedPromptCwd) {
              try {
                if (
                  hostedAppExecutablePath === undefined ||
                  realpathSync(ownedWezTermCli) !== join(dirname(realpathSync(hostedAppExecutablePath)), "wezterm")
                ) {
                  throw new Error("WezTerm cwd CLI is outside the verified App bundle")
                }
                return await readAppSemanticState({
                  featureId,
                  onRetained,
                  runId: expectedLaunchRunId,
                  executable: ownedWezTermIdentity.historyExecutable,
                  write,
                  async readCwd(checkpoint) {
                    if (checkpoint !== undefined) {
                      await untilAppSemanticRead(
                        readText,
                        (text) => (text.split("\n")[checkpoint.row - 1] ?? "").includes(checkpoint.marker),
                        "owned cwd checkpoint",
                        [],
                      )
                    }
                    const uri = await readPane()
                    return { uri, detail: { ownershipReceipt, nativeReads } }
                  },
                })
              } catch (error) {
                return { status: "invalid" as const, reason: error instanceof Error ? error.message : String(error) }
              }
            }
            const reading = await readWezTermCwd({
              runId: expectedLaunchRunId,
              captureDirectory,
              onRetained,
              async write(text) {
                await check()
                out.write(text)
                await check()
              },
              readPane,
              readText,
            })
            if (ownershipReceipt !== undefined && typeof reading.detail === "object" && reading.detail !== null) {
              Object.assign(reading.detail, { ownershipReceipt, nativeReads })
            }
            return reading
          }
          if (!linux) {
            return { status: "invalid" as const, reason: "No owned App semantic reader for this feature on macOS" }
          }
          await owner.readGeometry()
          return readAppSemanticState({
            featureId,
            write,
            runId: expectedLaunchRunId,
            executable: linux.executable,
            ...(withIconNameFixture &&
              !muxAttachmentProof && {
                readTitle: owner.readTitle,
                withIconNameFixture: (write, work) =>
                  withIconNameFixture(write, work, async () => {
                    if (!assertIconOwner || !verifiedTerminalOwners.has(owner)) {
                      throw new Error("Owned icon read has no live terminal owner")
                    }
                    await assertIconOwner()
                  }),
              }),
            ...(muxAttachmentProof && { mux: muxAttachmentProof.mux }),
          })
        },
      }),
      async readGeometry() {
        if (!verifiedTerminalOwners.has(owner)) throw new Error("Owned geometry read has no live bound capture")
        // A Windows console has no device to re-open, so the re-read is the console's own identity:
        // a changed window handle means these probes no longer write where the geometry came from.
        if (binding.platform === "windows") {
          const identity = readWindowsConsoleIdentity(windowsKernel)
          if (identity !== binding.consoleIdentity) {
            throw new Error(
              `Owned geometry console changed: window handle ${identity}, bound to ${binding.consoleIdentity}`,
            )
          }
          return readBoundGeometry(binding, windowsKernel)
        }
        const current = linux
          ? linuxOutput(out)
          : terminalApp
            ? darwinOutput(out, parseTerminalAppOwner(terminalApp).tabTty)
            : processOwner && !darwinAttachment
              ? darwinOutput(out, parseProcessOwnerAssertion(processOwner).tty)
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
        return readBoundGeometry(current, windowsKernel)
      },
      ...(hostedWindowsApp?.id === "alacritty" && { readCells: readConsoleHostCells }),
      ...(wezTermExecutable !== undefined && {
        textRecipe: "wezterm-windows-text-cells-v1" as const,
        async readCells(): Promise<TerminalTextRead> {
          // This collector IS the verified terminal child. Read its environment only after the
          // live owner/console recheck, never from the workflow parent or a pane-list fallback.
          const geometry = await owner.readGeometry()
          if (geometry.status !== "measured") {
            return { status: "refused", reason: `WezTerm owned text needs a measured grid: ${geometry.diagnostic}` }
          }
          return readWindowsWezTermText({
            executable: wezTermExecutable,
            pane: process.env.WEZTERM_PANE,
            socket: process.env.WEZTERM_UNIX_SOCKET,
            cols: geometry.cols,
            rows: geometry.rows,
          })
        },
      }),
      ...(windowsTerminalPid !== undefined && {
        textRecipe: "windows-terminal-text-cells-v1" as const,
        observeWrite: (written: string) => renditions?.observe(written),
        async readCells(): Promise<TerminalTextRead> {
          // The geometry read re-checks the live owner and the bound console before every frame.
          const geometry = await owner.readGeometry()
          if (geometry.status !== "measured") {
            return {
              status: "refused",
              reason: `the Windows Terminal text read needs a measured grid: ${geometry.diagnostic}`,
            }
          }
          const doubled = renditions?.refusal()
          if (doubled !== undefined) return { status: "refused", reason: doubled }
          return readWindowsTerminalText({ pid: windowsTerminalPid, cols: geometry.cols, rows: geometry.rows })
        },
      }),
      ...(readOwnedWindowsRows !== undefined && {
        async consoleHostOwnership(): Promise<TextQualificationOwnership> {
          const geometry = await owner.readGeometry()
          if (geometry.status !== "measured") {
            throw new Error(`The ownership witness needs a measured grid: ${geometry.diagnostic}`)
          }
          const { row, col } = TEXT_QUALIFICATION_OWNERSHIP_CELL
          // The caller cleared the screen and homed the cursor, so the raw write lands on this cell.
          await writeConsoleCellsRaw("\u0001", windowsKernel)
          const host = await readConsoleHostCells()
          if (host.status === "refused") throw new Error(`The console host's read refused: ${host.reason}`)
          const observer = readOwnedWindowsRows(geometry)
          if (observer.status === "refused") throw new Error(`Owned Windows text read refused: ${observer.reason}`)
          const observerRow = observer.rows[row - 1]
          if (observerRow === undefined) throw new Error(`Owned Windows text returned no row ${String(row)}`)
          return { cell: { row, col }, host: host.grid.text[row - 1]?.charAt(col - 1) ?? "", observerRow }
        },
      }),
      ...(darwinTextApp !== undefined &&
        darwinTextTty !== undefined && {
          textRecipe:
            darwinTextApp === "iterm2" ? ("iterm2-api-text-cells-v1" as const) : ("macos-text-cells-v1" as const),
          async readCells(checkpoint?: Parameters<NonNullable<OwnedTerminal["readCells"]>>[0]) {
            if (!verifiedTerminalOwners.has(owner)) throw new Error("Owned cell read has no live bound capture")
            const geometry = await owner.readGeometry()
            if (geometry.status !== "measured") {
              return {
                status: "refused",
                reason: `the ${darwinTextApp} text snapshot needs a measured grid: ${geometry.diagnostic}`,
              } satisfies TerminalTextRead
            }
            if (darwinTextApp === "kitty") {
              const assertion = parseProcessOwnerAssertion(processOwner)
              const captureDirectory = process.env.TERMINFO_CAPTURE_DIRECTORY
              const socket = process.env.KITTY_LISTEN_ON
              const windowId = process.env.KITTY_WINDOW_ID
              if (
                !captureDirectory ||
                !isAbsolute(captureDirectory) ||
                socket !== `unix:${join(dirname(captureDirectory), `kitty-${expectedLaunchRunId}.sock`)}` ||
                process.env.KITTY_PID !== String(assertion.ownerPid) ||
                !windowId ||
                !/^[1-9]\d*$/u.test(windowId)
              ) {
                return {
                  status: "refused",
                  reason:
                    "Kitty text read requires this run's capture-directory socket, verified owner PID and window ID",
                } satisfies TerminalTextRead
              }
              let stdout: Buffer
              try {
                stdout = execFileSync(
                  join(dirname(assertion.executablePath), "kitten"),
                  ["@", "--to", socket, "get-text", "--extent", "screen", "--match", `id:${windowId}`],
                  { encoding: "buffer", timeout: 5000, maxBuffer: 1024 * 1024 },
                )
              } catch (cause) {
                return {
                  status: "refused",
                  reason: `Kitty window ${windowId} text read through ${socket} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                } satisfies TerminalTextRead
              }
              if (!options.onRetained) throw new Error("Kitty text retention requires its artifact observer")
              const ref = retain(captureDirectory, stdout, "bin", options.onRetained)
              const snapshot = stdout.toString("utf8")
              const lines = snapshot === "" ? [] : snapshot.replace(/\n$/u, "").split("\n")
              // The shared macOS mapper does not witness DECDWL/DECDHL; unknown character widths remain unmeasurable.
              const cells = mapSnapshotToCells(lines, geometry.cols, geometry.rows, 0)
              if (typeof cells === "string") {
                const lineByteLengths: number[] = []
                let lineStart = 0
                let lineFeeds = 0
                for (let index = 0; index < stdout.length; index++) {
                  if (stdout[index] !== 0x0a) continue
                  lineFeeds++
                  if (lineByteLengths.length < geometry.rows) lineByteLengths.push(index - lineStart)
                  lineStart = index + 1
                }
                if (lineStart < stdout.length && lineByteLengths.length < geometry.rows) {
                  lineByteLengths.push(stdout.length - lineStart)
                }
                const preview = Array.from(
                  stdout.subarray(0, 256),
                  (byte) => `\\x${byte.toString(16).padStart(2, "0")}`,
                ).join("")
                return {
                  status: "refused",
                  reason: `Kitty get-text: ${cells}; stdout=${ref}; bytes=${stdout.length}; lf=${lineFeeds}; lineBytes=${JSON.stringify(lineByteLengths)}; first256bytes=${JSON.stringify(preview)}`,
                }
              }
              return { status: "read", app: "kitty", cells }
            }
            // Each app's raw reply is kept with its checkpoint, so a refused read keeps what the app returned.
            const retainReply =
              checkpoint &&
              ((bytes: Uint8Array) => {
                const reply = retain(checkpoint.directory, Buffer.from(bytes), "bin", checkpoint.onRetained)
                retain(
                  checkpoint.directory,
                  Buffer.from(
                    JSON.stringify({
                      captureRunId,
                      checkpoint: checkpoint.label,
                      tty: darwinTextTty,
                      grid: { rows: geometry.rows, cols: geometry.cols },
                      reply,
                    }),
                  ),
                  "json",
                  checkpoint.onRetained,
                )
              })
            if (darwinTextApp === "iterm2") {
              return readITermCells({
                tty: darwinTextTty,
                cols: geometry.cols,
                rows: geometry.rows,
                ...(retainReply && { onReply: retainReply }),
              })
            }
            return readTerminalTextSnapshot({
              app: darwinTextApp,
              tty: darwinTextTty,
              cols: geometry.cols,
              rows: geometry.rows,
              ...(retainReply && { onReply: (reply: OsascriptReply) => retainReply(Buffer.from(reply.stdout)) }),
            })
          },
        }),
      async dispose() {
        verifiedTerminalOwners.delete(owner)
        await clipboard?.dispose()
      },
    }
    verifiedTerminalOwners.set(owner, { captureRunId, out, ...(processOwnerBasis && { processOwnerBasis }) })
    return owner
  } catch (error) {
    await clipboard?.dispose()
    throw error
  }
}

export function readTerminalLaunchWindowId(artifactDirectory: string): number {
  const record = join(artifactDirectory, "terminal-launch.json")
  if (!existsSync(record)) {
    throw new Error(
      `Terminal.app capture requires the launch receipt ${record} that names the owned window id; that record is absent`,
    )
  }
  const raw = readFileSync(record, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    // A malformed receipt is the operator's evidence to read, never a bare parser error.
    throw new Error(
      `Terminal.app launch receipt ${record} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}: ${raw}`,
    )
  }
  const row = parsed as { appId?: unknown; terminalWindow?: { provider?: unknown; windowId?: unknown } }
  const windowId = row.terminalWindow?.windowId
  if (
    row.appId !== "terminal-app" ||
    row.terminalWindow?.provider !== "terminal-app" ||
    typeof windowId !== "number" ||
    !Number.isSafeInteger(windowId) ||
    windowId < 1
  ) {
    throw new Error(`Terminal.app launch receipt ${record} names no owned window id: ${raw}`)
  }
  return windowId
}
