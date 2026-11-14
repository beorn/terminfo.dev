/**
 * Thin probe server — TTY I/O only, no bundled probe logic.
 *
 * Usage: npx terminfo.dev serve
 *
 * Starts an HTTP server that accepts probe requests. Run this in each
 * terminal you want to test, then use `terminfo.dev test-all` or
 * curl to run probes remotely.
 *
 * Probe definitions are loaded at daemon startup; restart after changing them.
 *
 * Discovery: writes terminal info + port to ~/.terminfo-dev/daemons/
 * so clients can find all running daemons automatically.
 */

import { createStyle } from "@silvery/ansi"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, win32 } from "node:path"
import { homedir } from "node:os"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import {
  assertCalibratedCaptureGeometry,
  type CaptureCells,
  type ObservationFrame,
  DEFAULT_TIMEOUT_MS,
  queryPixelGeometry,
  type PixelGeometrySource,
  type PixelGeometry,
  type CapturedRunDraft,
  type RunDraft,
  type ProbeSubject,
  initializeRunDraft,
  recordCollectionFailure,
  recordCollectorSelection,
  recordCollectorAttempt,
  collectorIds,
  resolveProbeIds,
  type ProbeSuiteManifest,
  type TermProbeSource,
  type TerminalQueryOutcome,
  type TextQualification,
  type TextSnapshotDiagnostic,
  type OuterColourControl,
  type InputFixture,
} from "@terminfo/probe-defs"
import { clipboardConfigAgrees } from "./clipboard-config.ts"
import { readThroughSentinel } from "./sentinel-read.ts"
import { detectTerminal } from "./detect.ts"
import { appSemanticDeclarations, readSessionBus } from "./app-semantic-state.ts"
import {
  COMPLETE_DA2,
  COMPLETE_XTVERSION,
  declaredAppVersion,
  resolveMeasuredAppVersion,
  verifyTerminalIdentity,
} from "./identity-guard.ts"
import {
  withRawMode,
  withTTYOperation,
  drainStdin,
  queryOutcome,
  queryWithSentinelOutcome,
  readResponse,
} from "./tty.ts"
import { ALL_PROBES, runProbeBatch, type GeometryCorroboration, type ProbeCapture } from "./probes/unified.ts"
import { createLinuxCapture, type LiveExecutable } from "./linux-capture.ts"
import { createDarwinCapture, type DarwinInstallCensus } from "./darwin-capture.ts"
import { calibrateCaptureOrigin, type CaptureChromeBand } from "./capture-calibration.ts"
import { collectTextQualification, recordTextQualificationTests } from "./text-qualification.ts"
import { retain } from "./capture-core.ts"
import { muxAttachmentConfigMatches, muxAttachmentVersionMatches } from "./disposable-receipt.ts"
import { ORDINARY_OPEN_COLLECTOR_KEY } from "./ordinary-open-receipt.ts"
import {
  assertOneProofPerRun,
  assertOrdinaryOpenVersionBound,
  ordinaryOpenReceiptPath,
  ordinaryOpenRecord,
  resolveOrdinaryOpenRun,
  type OrdinaryOpenRun,
} from "./ordinary-open-run.ts"
import { createLinuxInput } from "./linux-input.ts"
import {
  buildDarwinInputHelper,
  createDarwinInput,
  DARWIN_INPUT_HELPER_ENV,
  ownedHostHelperPath,
} from "./darwin-input.ts"
import {
  createOwnedTerminal,
  parseOwnedAppOwnerAssertion,
  parseProcessOwnerAssertion,
  parseTerminalAppOwner,
  type OwnedAppOwnerAssertion,
  type OwnedTerminal,
  type ProcessOwnerAssertion,
  type TerminalAppOwnerAssertion,
} from "./owned-terminal.ts"
import { cmuxHistoryEvidence } from "./cmux-history-record.ts"
import type { ConsoleCellRead } from "./windows-console-cells.ts"
import type { TerminalTextRead } from "./darwin-terminal-text.ts"
import { parseJsonStrict, parseOuterApp, parseRunProvenance, parseSubject } from "@terminfo/run-parser"
import { derivedSuiteManifest, probeSuiteSnapshot, uncommittedCollectorDirt } from "../../admin/versions.ts"

/**
 * The checkpoint's cells as rows of the read, or a refusal. A checkpoint that names cells the read
 * does not cover is refused BY NAME: silently cropping it would digest less than the row asked for.
 */
export function textCellRegion(
  rows: readonly string[],
  gridRows: number,
  gridCols: number,
  requested?: CaptureCells,
): { cells: CaptureCells; rows: readonly string[] } {
  const cells = requested ?? {
    top: 1,
    left: 1,
    bottom: rows.length,
    right: Math.max(...rows.map((row) => row.length), 1),
  }
  if (cells.top < 1 || cells.left < 1 || cells.bottom > gridRows || cells.right > gridCols) {
    throw new Error(
      `the checkpoint asks for rows ${String(cells.top)}-${String(cells.bottom)} and columns ${String(cells.left)}-${String(cells.right)} of a ${String(gridRows)}x${String(gridCols)} text read, so the snapshot cannot cover it`,
    )
  }
  return { cells, rows: rows.slice(cells.top - 1, cells.bottom).map((row) => row.slice(cells.left - 1, cells.right)) }
}

/**
 * The bytes a text frame's digests are taken over: the visible rows, newline-terminated, with the
 * attributes block the arm reported underneath. One encoding, so a frame's ref and its cell digest
 * describe the same characters whether or not the arm carries attributes.
 */
function encodeTextCells(rows: readonly string[], attributes: readonly (readonly number[])[] | undefined): string {
  return attributes === undefined
    ? rows.join("\n")
    : `${rows.join("\n")}\n#attributes\n${attributes.map((row) => row.join(",")).join("\n")}`
}

/** The checkpoint a text frame answers, and the read it answers it from. */
export interface TextFrameCheckpoint {
  readonly role: ObservationFrame["role"]
  readonly label: string
  readonly cells?: CaptureCells
}

/**
 * A text read the terminal refused by name, carrying what the reply stated about it. The message is
 * the refusal text and nothing else, so every caller that only reads it sees what it always saw; a
 * caller that records the refusal keeps the diagnostic instead of re-deriving it from the script.
 */
export class TextSnapshotRefused extends Error {
  override name = "TextSnapshotRefused"
  readonly diagnostic: TextSnapshotDiagnostic | undefined
  readonly diagnosticDropped: number | undefined

  constructor(message: string, diagnostic: TextSnapshotDiagnostic | undefined, diagnosticDropped: number | undefined) {
    super(message)
    this.diagnostic = diagnostic
    this.diagnosticDropped = diagnosticDropped
  }
}

/**
 * One text read, as the frame and trace a checkpoint answers with — everything the collector's text
 * adapter does except the write itself. Pure, so the digests, the compared rectangle and the refusal
 * are testable where no terminal exists.
 *
 * `ref` and `frameDigest` hash the WHOLE retained snapshot, and `cellDigest` hashes exactly the
 * checkpoint's rectangle, attributes included, so a sub-rectangle's cell digest differs from its
 * frame digest exactly when the rectangle is smaller than the screen. `retained` is the byte-for-byte
 * content of `<digest>.txt`: the caller writes those bytes and nothing re-encodes them.
 *
 * A cell the console host wrote as U+FFFD — its stand-in for a glyph longer than one UTF-16 unit —
 * is content the host held, so it stays in the whole digest exactly as written. Its READING is what
 * the rectangle withholds: inside the compared cells it refuses by name, because digest equality
 * over stand-ins cannot tell two glyphs apart; outside them the trace names the cell and the
 * rectangle measures what it owns. Integrity failures (bytes the host never wrote, inconsistent
 * wide-glyph markers) refuse the read wherever the cell is: only interpretation can be scoped.
 */
export function textCellsFrame(
  checkpoint: TextFrameCheckpoint,
  read: ConsoleCellRead | TerminalTextRead,
  capturedAt: number,
): { frame: ObservationFrame; trace: Record<string, unknown>; retained: Buffer } {
  if (read.status === "refused") {
    throw new TextSnapshotRefused(
      `${checkpoint.label}: the terminal refused the text snapshot — ${read.reason}`,
      "diagnostic" in read ? read.diagnostic : undefined,
      "diagnosticDropped" in read ? read.diagnosticDropped : undefined,
    )
  }
  const rows = "grid" in read ? read.grid.text : read.cells.text
  const attributes = "grid" in read ? read.grid.attributes : undefined
  const gridRows = "grid" in read ? read.grid.rows : read.cells.rows
  const gridCols = "grid" in read ? read.grid.cols : read.cells.cols
  const bufferOwner = "grid" in read ? read.bufferOwner : undefined
  // A macOS text read says what it had to leave behind and fill in; the trace carries both so an
  // evidence reader sees them without re-deriving them from the artifact.
  const textGrid = "grid" in read ? undefined : read.cells
  const standIns = "grid" in read ? read.standIns : []
  const retained = Buffer.from(encodeTextCells(rows, attributes), "utf8")
  const hex = createHash("sha256").update(retained).digest("hex")
  const ref = `sha256:${hex}`
  const region = textCellRegion(rows, gridRows, gridCols, checkpoint.cells)
  const cells = region.cells
  const inside = standIns.find(
    (cell) =>
      cell.row >= cells.top && cell.row <= cells.bottom && cell.column >= cells.left && cell.column <= cells.right,
  )
  if (inside !== undefined) {
    throw new Error(
      `${checkpoint.label}: the terminal refused the text snapshot — row ${String(inside.row)}, column ${String(inside.column)} holds U+FFFD, the host's stand-in for a glyph longer than one UTF-16 unit, and this checkpoint compares that cell`,
    )
  }
  const outside = standIns.filter(
    (cell) => cell.row < cells.top || cell.row > cells.bottom || cell.column < cells.left || cell.column > cells.right,
  )
  const regionAttributes = attributes
    ?.slice(cells.top - 1, cells.bottom)
    .map((row) => row.slice(cells.left - 1, cells.right))
  return {
    frame: {
      kind: "text-cells",
      role: checkpoint.role,
      label: checkpoint.label,
      capturedAt,
      ref,
      cellDigest: `sha256:${createHash("sha256").update(encodeTextCells(region.rows, regionAttributes)).digest("hex")}`,
      frameDigest: ref,
      cellRectangle: cells,
    },
    trace: {
      kind: "text-cells",
      retained: `${hex}.txt`,
      // What was actually read. On Windows it is the console host's buffer, and the read now
      // records the host executable's path and digest, so the label names both rather than
      // promising a fact the trace does not carry (30033 ruling f1f3c64b; 30042).
      source:
        bufferOwner === undefined
          ? "the terminal's own text snapshot"
          : `the console host's buffer (${bufferOwner.image}); executable ${bufferOwner.executablePath} ${bufferOwner.executableSha256}`,
      ...(outside.length === 0 ? {} : { standIns: outside }),
      ...(textGrid === undefined
        ? {}
        : {
            droppedLines: textGrid.droppedLines,
            carriedHistory: textGrid.droppedLines > 0,
            paddedRows: textGrid.paddedRows,
            // The app returned LOGICAL lines and this read rebuilt the rows from them (30729 AC3b):
            // named in the trace so an evidence reader knows the rows were reconstructed, and how
            // many lines had to be split, without re-deriving either from the retained text.
            ...(textGrid.splitLineCount === undefined
              ? {}
              : { reconstructedFromLogicalLines: true, splitLineCount: textGrid.splitLineCount }),
          }),
      ...(bufferOwner === undefined ? {} : { bufferOwner }),
    },
    retained,
  }
}

const s = createStyle()

const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")
const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/** Bun's CLI build replaces this identifier with a validated immutable receipt. */
declare const __TERMINFO_BUNDLED_SUITE__: { manifest: ProbeSuiteManifest; collectorRevision: string }
const bundledSuite = typeof __TERMINFO_BUNDLED_SUITE__ === "undefined" ? null : __TERMINFO_BUNDLED_SUITE__

/**
 * The outer control for a mux colour negative (#33041): the launcher copies the outer terminal's
 * placed record (or why there is none) into the run, and this names exactly what the batch may cite.
 * A named but absent or malformed file is our own launcher's defect and fails the run loudly; an
 * unnamed one is a missing control and leaves the colour rows open with that reason.
 */
export function readOuterColourControl(
  path: string | undefined,
  outerApp: Pick<ProbeSubject, "id" | "version" | "os">,
): OuterColourControl {
  if (!path) return { missing: "the launcher named no outer-terminal record (TERMINFO_OUTER_COLOUR_RECORD unset)" }
  if (!existsSync(path)) {
    throw new Error(`Outer-terminal record ${path} is named but absent: the launcher writes it for every mux run`)
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  const record = value as Record<string, unknown>
  if (record && typeof record === "object" && typeof record.missing === "string" && Object.keys(record).length === 1) {
    return { missing: record.missing }
  }
  const strings = ["id", "version", "os", "recordPath", "recordRunId"] as const
  const statuses = record?.statuses
  if (
    !record ||
    typeof record !== "object" ||
    strings.some((key) => typeof record[key] !== "string" || (record[key] as string).length === 0) ||
    !statuses ||
    typeof statuses !== "object" ||
    Object.values(statuses).some((status) => typeof status !== "string")
  ) {
    throw new Error(
      `Outer-terminal record ${path} is malformed: expected {id, version, os, recordPath, recordRunId, statuses} or {missing}`,
    )
  }
  return {
    record: {
      id: record.id as string,
      version: record.version as string,
      os: record.os as string,
      recordPath: record.recordPath as string,
      recordRunId: record.recordRunId as string,
      statuses: statuses as Record<string, string>,
    },
    outerApp: { id: outerApp.id, version: outerApp.version, os: outerApp.os },
  }
}

function measuredExecutable(value: unknown): LiveExecutable {
  if (!value || typeof value !== "object") throw new Error("Runtime provenance has no executable")
  const executable = (value as { executable?: unknown }).executable
  if (!executable || typeof executable !== "object") throw new Error("Runtime provenance has no executable")
  const { path, sha256 } = executable as { path?: unknown; sha256?: unknown }
  const isAbs = typeof path === "string" && (isAbsolute(path) || win32.isAbsolute(path))
  if (typeof path !== "string" || !isAbs || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("Runtime provenance has invalid measured executable")
  }
  return { path, sha256 }
}

function assertLoadedAppSuite(
  manifest: ProbeSuiteManifest,
  probeHash: string,
  location: string,
): asserts manifest is ProbeSuiteManifest & { schemaVersion: 4 } {
  if (manifest.schemaVersion !== 4) {
    throw new Error(`Current collection requires schema-4 suite declaration: ${location}`)
  }
  const actual = ALL_PROBES.map((probe) => probe.id).sort()
  if (manifest.probeHash !== probeHash || JSON.stringify(manifest.probes.term) !== JSON.stringify(actual)) {
    throw new Error(`Loaded app probes disagree with suite declaration ${location}`)
  }
}

export function getCliSuiteProbeHash(): string {
  if (bundledSuite) {
    const { manifest, collectorRevision } = bundledSuite
    if (!/^[0-9a-f]{12}$/.test(manifest.probeHash) || !/^[0-9a-f]{40}$/.test(collectorRevision)) {
      throw new Error("Compiled CLI has invalid suite or collector revision metadata")
    }
    assertLoadedAppSuite(manifest, manifest.probeHash, "compiled CLI receipt")
    return manifest.probeHash
  }
  return probeSuiteSnapshot(SOURCE_ROOT).probeHash
}

export function getTrustedSuiteReceipt(): {
  manifest: ProbeSuiteManifest & { schemaVersion: 4 }
  collectorRevision: string
} {
  if (bundledSuite) {
    const { manifest, collectorRevision } = bundledSuite
    if (!/^[0-9a-f]{12}$/.test(manifest.probeHash) || !/^[0-9a-f]{40}$/.test(collectorRevision)) {
      throw new Error("Compiled CLI has invalid suite or collector revision metadata")
    }
    assertLoadedAppSuite(manifest, manifest.probeHash, "compiled CLI receipt")
    if (
      (process.env.TERMINFO_PROBE_HASH && process.env.TERMINFO_PROBE_HASH !== manifest.probeHash) ||
      (process.env.TERMINFO_SOURCE_REVISION && process.env.TERMINFO_SOURCE_REVISION !== collectorRevision)
    ) {
      throw new Error("Runtime suite metadata disagrees with compiled CLI receipt")
    }
    return { manifest, collectorRevision }
  }
  const probeHash = process.env.TERMINFO_PROBE_HASH
  const sourceRevision = process.env.TERMINFO_SOURCE_REVISION
  if (!probeHash || !/^[0-9a-f]{12}$/.test(probeHash) || !sourceRevision || !/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error(
      "Current collection requires TERMINFO_PROBE_HASH and TERMINFO_SOURCE_REVISION from a source-tree launcher",
    )
  }
  const snapshot = probeSuiteSnapshot(SOURCE_ROOT)
  if (snapshot.probeHash !== probeHash) {
    throw new Error(`Collector suite ${snapshot.probeHash} differs from TERMINFO_PROBE_HASH`)
  }
  const manifestPath = join(SOURCE_ROOT, "content", "suites", `${probeHash}.json`)
  const manifest: ProbeSuiteManifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as ProbeSuiteManifest)
    : derivedSuiteManifest(snapshot)
  assertLoadedAppSuite(manifest, probeHash, existsSync(manifestPath) ? manifestPath : "derived source suite")
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: SOURCE_ROOT, encoding: "utf8" }).trim()
  if (revision !== sourceRevision) throw new Error(`Collector revision differs from TERMINFO_SOURCE_REVISION`)
  const dirty = uncommittedCollectorDirt(SOURCE_ROOT, snapshot)
  if (dirty) throw new Error(`Collector source is uncommitted: ${dirty}`)
  return { manifest, collectorRevision: sourceRevision }
}

/** The capture a controlled Linux run installs when no capture directory is configured (27875).
 * Absence is a fact about the run, and a probe that needs a frame must be able to say so: the
 * named error lands as an `ungradedDiagnostic` keyed by that probe's own id. */
export function frameUnavailableCapture(): ProbeCapture {
  return () => {
    const error = new Error("This run has no capture directory, so no frame is available for a probe that needs one")
    error.name = "FrameUnavailable"
    return Promise.reject(error)
  }
}

type OwnedTerminalKind = "linux" | "terminalApp" | "process" | "ownedApp" | "darwinHosted" | "windowsHosted"

/**
 * The arms that carry a Darwin owner claim: one launcher-asserted window, re-proved here before any row is
 * graded. One predicate, so the exclusivity, capture-directory and launch checks cannot drift apart, and
 * step 2's fold of `terminalApp` into the owned-app shape is one place rather than ten edits (@cto 9f889378).
 */
function isDarwinClaimKind(kind: OwnedTerminalKind | undefined): boolean {
  return kind === "terminalApp" || kind === "process" || kind === "ownedApp"
}

/** One geometry query the capture pre-flight asked, kept with its raw reply. The refusal of a
 * terminal that cannot be calibrated is re-derivable from these bytes, never from a summary. */
interface CaptureCalibrationQuery {
  sequence: string
  /** The measured outcome of that reply, typed as the query layer reports it (`timeout` is a fact). */
  reason: TerminalQueryOutcome["reason"]
  raw: string
  rawBase64: string
}

/**
 * How this run's cell-to-pixel geometry was established, or why it was refused, as ONE recorded fact.
 * An absent `options.capture` alone cannot tell a reader "this terminal refused to be calibrated"
 * from "this run has no capture adapter at all" (28785) — and those are different facts about the
 * terminal, so the run records which one it is before a single probe runs.
 */
interface CaptureCalibrationFact {
  outcome: "installed" | "refused"
  /** The census the adapter took AT INSTALL, before the pre-flight asked anything: the selected window,
   * its observations and every owned layer-0 window, plus takenAt. It proves the verified app pid owned
   * one visible layer-0 window at that moment — never that a frame showed the terminal (@cto 2026-10-22,
   * #30392 C1). Present on both branches: a refusal is exactly when the census is worth having. */
  installCensus?: DarwinInstallCensus
  /** The one basis the geometry rests on, present exactly when a capture adapter was installed. */
  basis?: PixelGeometrySource
  /** The measured geometry a frame request is checked against, present on the same terms as basis. */
  geometry?: PixelGeometry
  /** Complete raster witness, including any collector-launch cursor default. */
  rasterBasis?: string
  /** Every reply the pre-flight read, in the order it asked, so the refusal is re-derivable. */
  queries: CaptureCalibrationQuery[]
  /** The named cause, present exactly when the geometry was refused. */
  refusal?: string
  causes?: Array<{ name: string; message: string; captureCommand?: unknown }>
}

/** Linux collections export both the clipboard receipt and TERMINFO_DISPOSABLE_RECEIPT; clipboard wins. */
function ownedTerminalKind(input: {
  clipboardReceipt: string | undefined
  /** TERMINFO_DISPOSABLE_RECEIPT: the hosted-runner receipt, which now names TWO arms — Darwin's
   * four Mac apps and the one Windows app — so the platform, not the variable, picks the arm. */
  hostedReceipt: string | undefined
  terminalAppOwner: unknown
  processOwner: unknown
  ownedAppOwner: unknown
  platform: NodeJS.Platform
}): OwnedTerminalKind | undefined {
  const { clipboardReceipt, hostedReceipt, terminalAppOwner, processOwner, ownedAppOwner, platform } = input
  const claims = [terminalAppOwner, processOwner, ownedAppOwner].filter(Boolean).length
  if (claims > 1) {
    throw new Error("Collection cannot have more than one owner claim")
  }
  if (clipboardReceipt && claims > 0) {
    throw new Error("Collection cannot have both Linux and a Darwin claim owner")
  }
  if (claims > 0 && hostedReceipt && (platform === "darwin" || platform === "win32")) {
    throw new Error("Collection cannot have both a Darwin claim owner and a hosted-runner owner")
  }
  if (clipboardReceipt) return "linux"
  if (terminalAppOwner) return "terminalApp"
  if (processOwner) return "process"
  if (ownedAppOwner) return "ownedApp"
  if (platform === "darwin" && hostedReceipt) return "darwinHosted"
  if (platform === "win32" && hostedReceipt) return "windowsHosted"
  return undefined
}

/** Both hosted arms compare the detected subject with the existing receipt-derived owner identity. */
function assertHostedIdentity(detected: string, owner: OwnedTerminal, platform: "Darwin" | "Windows"): void {
  const appId = owner.hostedAppId
  if (!appId) {
    throw new Error(
      `Hosted ${platform} terminal detected ${JSON.stringify(detected)} while the receipt app ID is missing`,
    )
  }
  if (detected !== appId) {
    throw new Error(`Hosted ${platform} terminal detected ${JSON.stringify(detected)} while the receipt names ${appId}`)
  }
}

type ProbeCollectionOptions = {
  ids?: string[]
  out?: NodeJS.WriteStream
  terminalAppOwner?: TerminalAppOwnerAssertion
  processOwner?: ProcessOwnerAssertion
  ownedAppOwner?: OwnedAppOwnerAssertion
  expectedLaunchRunId?: string
  captureRunId?: string
  intendedSubject?: Partial<ProbeSubject>
}

/** The same source-tree collector powers daemon and inline CLI entry points. */
export function collectProbeRun(
  options?: Omit<ProbeCollectionOptions, "ids"> & { ids?: undefined },
): Promise<CapturedRunDraft>
export function collectProbeRun(options: ProbeCollectionOptions): Promise<RunDraft | CapturedRunDraft>
export async function collectProbeRun(options: ProbeCollectionOptions = {}): Promise<RunDraft | CapturedRunDraft> {
  const out = options.out ?? process.stdout
  const captureRunId =
    options.captureRunId ?? (process.env.TERMINFO_CAPTURE_RUN_ID || undefined) ?? randomBytes(16).toString("hex")
  if (!/^[a-zA-Z0-9._-]+$/.test(captureRunId)) throw new Error("Unsafe capture runId")
  const { manifest, collectorRevision: sourceRevision } = getTrustedSuiteReceipt()
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: captureRunId,
    sourceRevision,
    manifest,
    intendedSubject: options.intendedSubject ?? {
      kind: "term",
      ...(process.env.TERMINFO_TARGET_ID && { id: process.env.TERMINFO_TARGET_ID }),
      ...(process.env.TERMINFO_TARGET_VERSION && { version: process.env.TERMINFO_TARGET_VERSION }),
    },
  })
  let selectedIds = [...(options.ids ?? manifest.probes.term)]
  recordCollectorSelection(draft, selectedIds)
  const draftDirectory = process.env.TERMINFO_CAPTURE_DIRECTORY || join(homedir(), ".terminfo-dev", "http-responses")
  mkdirSync(draftDirectory, { recursive: true, mode: 0o700 })
  const draftPath = join(draftDirectory, `${captureRunId}.draft.json`)
  writeFileSync(draftPath, `${JSON.stringify(draft)}\n`, { flag: "wx", mode: 0o600 })
  const checkpoint = () => writeFileSync(draftPath, `${JSON.stringify(draft)}\n`, { mode: 0o600 })
  if (options.ids?.length === 0) {
    recordCollectorAttempt(draft, { ids: selectedIds, result: "empty" })
    checkpoint()
    return draft
  }
  let collectionStartedAt: string | undefined
  let collectionStartedMs: number | undefined
  let delegatedIds = manifest.probes.term.filter((id) => !options.ids || options.ids.includes(id))
  try {
    const terminal = detectTerminal()
    const probeHash = manifest.probeHash
    const captureDirectory = process.env.TERMINFO_CAPTURE_DIRECTORY
    const retainedArtifacts = new Map<string, { path: string; sha256: string }>()
    const onRetained: Parameters<typeof retain>[3] = (artifact) => {
      if (!captureDirectory) throw new Error("Retained capture artifact has no configured capture directory")
      const path = relative(dirname(captureDirectory), artifact.path).split("\\").join("/")
      if (!path || path.startsWith("../") || isAbsolute(path)) {
        throw new Error("Retained capture artifact is outside its bundle root: " + artifact.path)
      }
      const previous = retainedArtifacts.get(path)
      if (previous && previous.sha256 !== artifact.sha256) throw new Error("Retained capture path changed: " + path)
      retainedArtifacts.set(path, { path, sha256: artifact.sha256 })
    }
    const clipboardReceipt = process.env.TERMINFO_CLIPBOARD_FIXTURE_RECEIPT
    const hostedReceipt = process.env.TERMINFO_DISPOSABLE_RECEIPT
    const kind = ownedTerminalKind({
      clipboardReceipt,
      hostedReceipt,
      terminalAppOwner: options.terminalAppOwner,
      processOwner: options.processOwner,
      ownedAppOwner: options.ownedAppOwner,
      platform: process.platform,
    })
    if (process.platform === "darwin" && captureDirectory && kind !== "darwinHosted" && !isDarwinClaimKind(kind)) {
      throw new Error(
        "Darwin capture directory requires a verified hosted-runner receipt, owned process, owned app or Terminal.app owner",
      )
    }
    // A hosted capture is a runner-owned terminal and a Darwin owned-process capture is an app the
    // owner proof verified; neither is a controlled Linux run, so neither can supply Linux runtime
    // provenance. macOS names darwinHosted, process or terminalApp; Windows names windowsHosted.
    const nonLinuxCapture =
      Boolean(captureDirectory) &&
      (kind === "darwinHosted" ||
        kind === "windowsHosted" ||
        (isDarwinClaimKind(kind) && process.platform === "darwin"))
    const provenancePath = process.env.TERMINFO_RUNTIME_PROVENANCE
    if ((captureDirectory || clipboardReceipt) && !provenancePath && !nonLinuxCapture) {
      throw new Error("Controlled Linux collection requires runtime provenance")
    }
    if (provenancePath && !captureDirectory && !clipboardReceipt) {
      throw new Error("Runtime provenance requires owned capture or clipboard")
    }
    const provenanceSource: unknown = provenancePath ? JSON.parse(readFileSync(provenancePath, "utf8")) : undefined
    const envelope =
      provenanceSource &&
      typeof provenanceSource === "object" &&
      !Array.isArray(provenanceSource) &&
      Object.hasOwn(provenanceSource, "outerApp")
        ? (provenanceSource as Record<string, unknown>)
        : undefined
    if (envelope && Object.keys(envelope).some((key) => key !== "subject" && key !== "outerApp")) {
      throw new Error("Mux runtime provenance envelope has unexpected fields")
    }
    const muxSubject = envelope ? parseSubject(envelope.subject, provenancePath ?? "mux runtime provenance") : undefined
    delegatedIds = manifest.probes[muxSubject ? "mux" : "term"].filter((id) => !options.ids || selectedIds.includes(id))
    if (options.ids === undefined) {
      selectedIds = [...delegatedIds]
      recordCollectorSelection(draft, selectedIds)
      checkpoint()
    }
    if (
      muxSubject &&
      (muxSubject.kind !== "mux" || muxSubject.os !== terminal.os || muxSubject.osVersion !== terminal.osVersion)
    ) {
      throw new Error("Mux runtime provenance target disagrees with the collector platform")
    }
    const outerApp = muxSubject
      ? parseOuterApp(
          envelope?.outerApp,
          muxSubject,
          "collector",
          { probeHash, sourceRevision },
          provenancePath ?? "mux runtime provenance",
        )
      : undefined
    if (muxSubject && !outerApp?.provenance) throw new Error("Mux runtime provenance lacks outer app provenance")
    const colourControl =
      muxSubject && outerApp?.provenance
        ? {
            outer: readOuterColourControl(process.env.TERMINFO_OUTER_COLOUR_RECORD, outerApp.subject),
            harnessProfile: outerApp.provenance.fixture.config || "no outer harness config declared",
            muxConfig: muxSubject.config ?? "no mux config declared",
          }
        : undefined
    const executableSource = outerApp?.provenance ?? provenanceSource
    const executable = executableSource ? measuredExecutable(executableSource) : undefined
    const measuredTerminal = muxSubject ? { name: muxSubject.id, version: muxSubject.version } : terminal
    if ((captureDirectory || clipboardReceipt) && !executable && !nonLinuxCapture) {
      throw new Error("Controlled Linux collection lacks measured executable")
    }
    let capture: ProbeCapture | undefined
    /** The installed pixel capture's fixed settle wait, when its adapter declares one. */
    let captureSettleMs: number | undefined
    /** Set when `capture` above reads the terminal's own text rather than pixels. */
    let textCapture = false
    let textQualification: TextQualification | undefined
    let textQualificationStartedAt: string | undefined
    const retainedTextSnapshots = new Map<string, Uint8Array>()
    /**
     * The text-snapshot adapter: the terminal's own cells, for the arm whose pixels cannot be read at
     * all. It answers a checkpoint with a text-cells frame whose digests are computed from the cells —
     * never from a raster — and it retains the snapshot in the run's artifact directory so admission
     * can place it and re-hash it. A refused read throws: a row that asked for a frame must not be
     * graded as if the screen were empty.
     *
     * Every arm that can read cells installs it — the hosted Darwin arm, the hosted Windows arm and
     * the app arm — but only when the run supplies a retention directory. Without one the arm names
     * that skip and every row keeps its own no-capture branch rather than grading an unretainable read.
     */
    let disposeQualifiedWindow = false
    const installTextCapture = (terminal: OwnedTerminal): boolean => {
      const readCells = terminal.readCells?.bind(terminal)
      if (!readCells) return false
      if (!captureDirectory) {
        // No retention directory, so no frame: the arm keeps exactly the behaviour it had, and the
        // rows that need a frame name the absent adapter instead of grading an unretainable read.
        process.stderr.write(
          `${kind}: this arm can read cells from the terminal's own text, but the run has no TERMINFO_CAPTURE_DIRECTORY to retain a snapshot in, so every row takes its own no-capture branch\n`,
        )
        return false
      }
      // captureDirectory IS the artifact directory: the launch receipt hands the collector
      // `<out>/artifacts`, and admission reads the bytes from there.
      const artifactDirectory = captureDirectory
      mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 })
      // The selected stream's completion can be synchronous while console cells remain stale.
      // The existing operation lease puts this query after earlier writes on that same stream.
      const consoleBarrier = async (label: string): Promise<void> => {
        const outcome = await queryOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 700)
        if (!outcome.match) {
          throw new Error(
            `${label}: console read refused: cursor query ${outcome.reason}, ${Buffer.from(outcome.rawBase64, "base64").length} bytes`,
          )
        }
      }
      capture = async (checkpoint) => {
        // Preserve the failed selected write; a later empty write would replace it with stream-destroyed.
        if (out.errored) throw out.errored
        if (process.platform === "win32") {
          await consoleBarrier(checkpoint.label)
        } else {
          await new Promise<void>((resolve, reject) => {
            out.write("", (error) => {
              if (error) reject(out.errored ?? error)
              else resolve()
            })
          })
        }
        const read = await readCells({ label: checkpoint.label, directory: artifactDirectory, onRetained })
        const result = textCellsFrame(checkpoint, read, Date.now())
        // Same discipline as the pixel path: a repeated identical screen is one artifact, not a
        // second write, and a digest that maps to different bytes is named instead of overwritten.
        // The bytes are the ones the frame's ref hashed — never a re-encoded copy.
        retain(artifactDirectory, result.retained, "txt", onRetained)
        retainedTextSnapshots.set(result.frame.ref, result.retained)
        return { frame: result.frame, trace: result.trace }
      }
      textCapture = true
      // Qualification belongs to a terminal-owned observer, named by its recipe; a console-host read
      // has none, and its text rows stay test-todo.
      const recipe = terminal.textRecipe
      if (recipe !== undefined) {
        // One fact selects qualification after probes and the destroy ending: an outside owner closes
        // this window and proves it, the local launcher or the hosted workflow's close step (32670).
        disposeQualifiedWindow =
          (kind === "terminalApp" && process.platform === "darwin") ||
          (kind === "darwinHosted" && terminal.hostedAppId === "terminal-app")
        const textAdapter = capture
        const consoleHostOwnership = terminal.consoleHostOwnership?.bind(terminal)
        const qualify: typeof prepareCapture = async ({ source: probeSource, featureId, recordCapture }) => {
          if (disposeQualifiedWindow) await drainStdin(1000)
          textQualification = await collectTextQualification({
            ctx: probeSource,
            recipe,
            ...(disposeQualifiedWindow && { ending: "owned-window-disposal" as const }),
            ...(consoleHostOwnership && {
              ownership: async () => {
                await consoleBarrier("text qualification console-host-ownership")
                return consoleHostOwnership()
              },
            }),
            onAttempt: () => {
              textQualificationStartedAt = new Date().toISOString()
            },
            capture: async (checkpoint) => {
              const result = await textAdapter({ featureId, ...checkpoint })
              recordCapture(result)
              return result.frame
            },
          })
        }
        // One qualification, called from exactly one of the two points.
        if (disposeQualifiedWindow) finishCapture = qualify
        else prepareCapture = qualify
      }
      return true
    }
    let prepareCapture:
      | ((input: {
          source: TermProbeSource
          featureId: string
          recordCapture: (result: Awaited<ReturnType<ProbeCapture>>) => void
        }) => Promise<void>)
      | undefined
    let finishCapture: typeof prepareCapture
    /**
     * Read protocol geometry once before the batch, then witness the complete raster and restoration
     * before its first callback. An intrinsic missing report does not prevent measurement; a transient
     * query failure aborts. The recorded fact names the measured authority or the actual refusal.
     */
    let preflightPixelCapture: (() => Promise<void>) | undefined
    let captureCalibration: CaptureCalibrationFact | undefined
    let captureInstallationRefusal: string | undefined
    let input: InputFixture | undefined
    /**
     * What happened when the Darwin input adapter was installed, so the run record carries it:
     * a refusal that only reached stdout is lost to the artifact (measured: run 43102072805).
     */
    let inputInstallFact: string | undefined
    const installPixelCapture = (
      adapter: Pick<Awaited<ReturnType<typeof createDarwinCapture>>, "capture" | "captureRaw">,
      installCensus?: DarwinInstallCensus,
      chromeBand?: CaptureChromeBand,
    ) => {
      // Preflight installs pixels later; preserve the hosted observer's retained text preparation.
      const prepareTextCapture = prepareCapture
      const platform = process.platform === "linux" ? "Linux" : "Darwin"
      let textOrigin: Awaited<ReturnType<typeof calibrateCaptureOrigin>> | undefined
      let calibrationError: Error | undefined
      /** The source whose next read anchors its crop on the sentinel it paints (33000). */
      let pixelSource: TermProbeSource | undefined
      /** Records every raw frame this route takes outside a read (calibration, 33981 pre-paint) in the artifact. */
      let frameRecord: ((result: Awaited<ReturnType<ProbeCapture>>) => void) | undefined
      /**
       * The one way this route takes a frame it does not digest: same adapter, same window, same
       * timeout, and recorded so the artifact can account for it. Calibration uses it to confirm
       * geometry; each sentinel read uses it for the frame taken BEFORE its paint (33981).
       */
      const captureRawFrame = async (featureId: string, label: string, deadline: number) => {
        const result = await adapter.captureRaw({ featureId, role: "control", label }, deadline)
        frameRecord?.(result.result)
        return result.decoded
      }
      // The ONE place a capture adapter is installed, and it takes the geometry the pre-flight
      // already measured: the adapter never queries the terminal itself, so the geometry it tests a
      // frame request against and the geometry the origin was calibrated on can never diverge.
      const installCapture = (reportedGeometry: PixelGeometry | undefined, queries: CaptureCalibrationQuery[]) => {
        textCapture = false
        capture = async (checkpoint) => {
          if (calibrationError) throw calibrationError
          const calibrated = assertCalibratedCaptureGeometry(textOrigin, checkpoint, platform)
          if (!calibrated) {
            const result = await adapter.captureRaw(checkpoint)
            return result.result
          }
          const sentinel = calibrated.sentinel
          const regions = [checkpoint.cells, checkpoint.controlCells].filter(
            (region): region is CaptureCells => region !== undefined,
          )
          const source = pixelSource
          if (sentinel === undefined || source === undefined || regions.length === 0) {
            return adapter.capture(checkpoint, calibrated)
          }
          // 33000: the crop follows the sentinel this read paints, never calibration's stale origin.
          // 33981: the sentinel is located by the difference to one frame taken BEFORE the paint,
          // through this same adapter route and the same window (@cto 41cd2559 conditions 1-3).
          return readThroughSentinel({
            source,
            prePaint: () =>
              captureRawFrame(checkpoint.featureId, `${checkpoint.label}: pre-paint`, Date.now() + DEFAULT_TIMEOUT_MS),
            capture: (resolve) => adapter.capture(checkpoint, resolve),
            label: checkpoint.label,
            sentinel,
            regions,
            ...(checkpoint.avoid ? { avoid: checkpoint.avoid } : {}),
            deadline: Date.now() + DEFAULT_TIMEOUT_MS,
          })
        }
        prepareCapture = async ({ source: probeSource, featureId, recordCapture }) => {
          textOrigin = undefined
          calibrationError = undefined
          pixelSource = probeSource
          frameRecord = recordCapture
          probeSource.captureGeometry = undefined
          probeSource.captureGeometryRefusal = undefined
          // Text restoration remains fatal, outside the pixel calibration refusal handling.
          await prepareTextCapture?.({ source: probeSource, featureId, recordCapture })
          try {
            textOrigin = await calibrateCaptureOrigin({
              ctx: probeSource,
              pixelGeometry: reportedGeometry,
              timeoutMs: DEFAULT_TIMEOUT_MS,
              ...(chromeBand ? { chromeBand } : {}),
              collectorLaunched:
                kind === "darwinHosted" ||
                // NOT terminalApp: that arm's value is unchanged by this head. The collector launches the
                // owned app and the process arm; Terminal.app is asserted, not launched, here (@cto fa402ac27).
                ((kind === "process" || kind === "ownedApp") && process.platform === "darwin") ||
                (process.platform === "linux" && kind === "linux"),
              captureRaw: (label, deadline) => captureRawFrame(featureId, label, deadline),
            })
            probeSource.captureGeometry = {
              geometry: textOrigin.pixelGeometry,
              source: "measured by complete raster calibration",
              sentinel: textOrigin.sentinel,
            }
            captureCalibration = {
              outcome: "installed",
              basis: probeSource.captureGeometry.source,
              geometry: textOrigin.pixelGeometry,
              rasterBasis: textOrigin.basis,
              queries,
              installCensus,
            }
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause))
            const causes: NonNullable<CaptureCalibrationFact["causes"]> = []
            const seen = new Set<Error>()
            for (
              let current: unknown = error;
              current instanceof Error && !seen.has(current);
              current = current.cause
            ) {
              seen.add(current)
              causes.push({
                name: current.name,
                message: current.message,
                ...("captureCommand" in current ? { captureCommand: current.captureCommand } : {}),
              })
            }
            // A native capture command can fail before the raster is installed.
            // Retain its primary cause and secondary restoration failure while
            // each affected row names the existing no-adapter outcome.
            const darwinCommandFailure =
              process.platform === "darwin" && causes.some((cause) => cause.captureCommand !== undefined)
            if (error.name !== "CaptureCalibrationRefused" && !darwinCommandFailure) throw error
            calibrationError = error
            probeSource.captureGeometryRefusal = error.message
            captureCalibration = { outcome: "refused", queries, refusal: error.message, causes, installCensus }
          }
        }
      }
      preflightPixelCapture = async () => {
        const queries: CaptureCalibrationQuery[] = []
        const report = await queryPixelGeometry({
          queryWithSentinelOutcome: async (sequence, pattern, timeoutMs) => {
            const outcome = await queryWithSentinelOutcome(sequence, pattern, timeoutMs)
            queries.push({
              sequence,
              reason: outcome.reason,
              raw: outcome.raw,
              rawBase64: outcome.rawBase64,
            })
            return outcome
          },
        })
        if ("missing" in report) {
          // Only the terminal's OWN answer may complete as a no-capture run (@cto, 28785 REVISE
          // rounds 1-2). A TIMEOUT - nothing answered at all, DA1 included - is a property of THIS
          // run, never of the terminal, so the batch aborts loudly, by name, carrying the replies it
          // read: the failure itself is evidence, and the run is repeated. A sentinel is NOT this
          // case: tty.ts measures it as DA1 answered and then silence, the terminal's own negative,
          // so it completes below as a named refusal.
          if (report.transient) {
            const read = queries
              .map((query) => `${query.sequence} = ${query.reason} (${JSON.stringify(query.raw)})`)
              .join("; ")
            const error = new Error(
              `${platform} capture calibration could not be measured: ${report.missing}. A needed reply timed out, so REPEAT THE RUN. Replies read: ${read}`,
            )
            error.name = "TerminalGeometryUnmeasurable"
            throw error
          }
          // An intrinsic missing report is not a missing measurement: the existing calibration
          // now measures the complete raster. A transient query failure still aborts above.
          installCapture(undefined, queries)
          return
        }
        installCapture(report.geometry, queries)
      }
    }
    /**
     * Bind OS-level injection to the owned app window (#33574). A missing helper, a missing
     * Accessibility grant or a key that does not come back through the app's own TTY names the
     * refusal on this run and installs nothing: no probe may read a row this runner never delivered.
     */
    const installDarwinInput = async (terminal: OwnedTerminal, owned: { windowId: number; windowTty: string }) => {
      const refuse = (reason: string) => {
        inputInstallFact = `refused: ${reason}`
        out.write(`input not installed: ${reason}\n`)
        // The collector's stdout is the measured terminal, so a refusal kept only there never
        // reaches the artifact. stderr lands in collector.log and rawReplies in run.json.
        process.stderr.write(`collector.inputInstall refused: ${reason}\n`)
      }
      const appPid = terminal.appPid
      if (!appPid) {
        refuse(`the verified ${kind} terminal has no measured app PID`)
        return
      }
      try {
        // An owned Mac (33587) has no job step that builds the helper, so it is always compiled here
        // from the staged source, into this run's own directory, and kept there as evidence (@cto 75732b9d).
        const helperPath = ownedHostHelperPath(process.env[DARWIN_INPUT_HELPER_ENV], () => {
          if (!captureDirectory) {
            throw new Error(
              "macOS input on an owned host builds its helper in the run directory, and this run has none",
            )
          }
          return buildDarwinInputHelper(
            join(SOURCE_ROOT, "native", "darwin-input", "main.swift"),
            join(dirname(captureDirectory), "darwin-input-helper"),
          )
        })
        input = await createDarwinInput({
          appPid,
          appName: terminal.hostedAppId ?? kind ?? "macOS app",
          helperPath,
          // The owner assertion names the run's own window and tab.
          ...owned,
          ownedHost: true,
          log: (line) => process.stderr.write(`collector.input ${line}\n`),
          selfTest: async (inject) => {
            // The app echoes a typed key only in cooked mode, so this read stays out of raw mode -
            // and it must restore the flowing state that withRawMode's lease restores, or the
            // collector holds the launcher's poll open long after its run.json (run 43102072805).
            try {
              // Both self-test probes post a printable key and expect its echo; the pattern covers
              // exactly those two (z, then x by bare keycode), so unrelated traffic cannot satisfy it.
              const echoed = await readResponse(/[zx]/, 2500, inject)
              return echoed === null ? null : echoed.join("")
            } finally {
              if (process.stdin.isTTY && process.stdin.readableFlowing === true) process.stdin.pause()
            }
          },
          report: (fact) => {
            inputInstallFact = `installed: ${fact}`
            out.write(`${fact}\n`)
            process.stderr.write(`collector.inputInstall ${fact}\n`)
          },
        })
      } catch (error) {
        refuse(error instanceof Error ? error.message : String(error))
      }
    }
    const installDarwinCapture = async (terminal: OwnedTerminal) => {
      if (!captureDirectory) {
        captureInstallationRefusal = `Verified ${kind} screenshot capture requires TERMINFO_CAPTURE_DIRECTORY to retain its evidence`
        return
      }
      const appPid = terminal.appPid
      if (!appPid) throw new Error(`Verified ${kind} terminal has no measured app PID for capture`)
      // main's structure (a pixel adapter stays primary; the text recipe is a per-app qualification on
      // top of it). The owned-app arm is excluded: an owned-Mac app is pixel-first always, and a text
      // route there would be a declared field in its proof entry, never a fallback (@cto 9f889378).
      if (terminal.textRecipe && (kind === "darwinHosted" || kind === "terminalApp")) installTextCapture(terminal)
      const darwinCapture = await createDarwinCapture(captureDirectory, {
        appPid,
        hostedAppId: terminal.hostedAppId,
        // Terminal.app's asserted window, or the CG window the iTerm2 owner census proved new (33845).
        // The owned-app arm (34107) names its own window: it is not on OwnedTerminal yet, so it comes
        // from the owner assertion here; every other kind reads the field main sets on the receipt.
        expectedWindowId: kind === "ownedApp" ? options.ownedAppOwner?.windowId : terminal.expectedWindowId,
        windowSelection: terminal.captureWindowSelection ?? "unique",
        // Only a hosted runner's disposable VM may fall back to a region capture.
        ownedHost: kind !== "darwinHosted",
        // No `measureWindowName` for a hosted runner (33821): the apps that need a title declare a measured
        // refusal instead, so the collector no longer spends a bounded census on a name it cannot certify.
        onRetained,
      })
      installPixelCapture(darwinCapture, darwinCapture.installCensus, terminal.captureChromeBand)
    }
    if (captureDirectory && process.platform === "linux") {
      if (!executable) throw new Error("Configured Linux capture lacks measured executable")
      const linuxCapture = await createLinuxCapture(captureDirectory, executable, onRetained)
      installPixelCapture(linuxCapture)
      captureSettleMs = linuxCapture.settleMs
      input = await createLinuxInput(executable, { onResizeWindow: linuxCapture.declareWindowSize })
    } else if (provenancePath) {
      // A controlled Linux run with no capture directory cannot make a frame, so a probe that needs
      // one must fail BY NAME in its own result instead of reaching an absent callback (27875).
      // The stub is installed ONLY here: every other run keeps no capture callback at all, so the
      // probes' own absence branches (cursor, erase, charsets, helpers) still decide those rows
      // exactly as they do today, and no non-container row changes.
      capture = frameUnavailableCapture()
    }
    let ownedTerminal: OwnedTerminal | undefined
    if (kind === "linux") {
      if (!clipboardReceipt || !executable) throw new Error("Owned clipboard receipt lacks measured executable")
      ownedTerminal = await createOwnedTerminal({
        onRetained,
        captureRunId,
        out,
        expectedLaunchRunId: process.env.TERMINFO_RUN_ID ?? "",
        linux: { receiptPath: clipboardReceipt, executable },
      })
    } else if (kind === "terminalApp") {
      if (!options.terminalAppOwner) throw new Error("Owned Terminal.app collection lacks owner assertion")
      ownedTerminal = await createOwnedTerminal({
        onRetained,
        captureRunId,
        out,
        expectedLaunchRunId: options.expectedLaunchRunId ?? process.env.TERMINFO_RUN_ID ?? "",
        terminalApp: options.terminalAppOwner,
      })
      await installDarwinCapture(ownedTerminal)
      // An owned Mac: keys only, posted to Terminal's pid into the asserted window (@cto 60e39dfc).
      await installDarwinInput(ownedTerminal, {
        windowId: options.terminalAppOwner.windowId,
        windowTty: options.terminalAppOwner.tabTty,
      })
    } else if (kind === "process") {
      if (!options.processOwner) throw new Error("Owned process collection lacks owner assertion")
      ownedTerminal = await createOwnedTerminal({
        onRetained,
        captureRunId,
        out,
        expectedLaunchRunId: options.expectedLaunchRunId ?? process.env.TERMINFO_RUN_ID ?? "",
        process: options.processOwner,
        ...(muxSubject && outerApp && { darwinMux: { subject: muxSubject, outerApp } }),
        darwinPreflight: !muxSubject,
      })
      await installDarwinCapture(ownedTerminal)
    } else if (kind === "ownedApp") {
      if (!options.ownedAppOwner) throw new Error("Owned-Mac app collection lacks its launch record")
      ownedTerminal = await createOwnedTerminal({
        onRetained,
        captureRunId,
        out,
        expectedLaunchRunId: options.expectedLaunchRunId ?? process.env.TERMINFO_RUN_ID ?? "",
        ownedApp: options.ownedAppOwner,
        // The launcher asserts the window; the worker proves it again before any row is graded, and
        // there is no mux to attach, so the outer collector's identity is always retained.
        darwinPreflight: true,
      })
      await installDarwinCapture(ownedTerminal)
    } else if (kind === "darwinHosted") {
      if (!hostedReceipt) throw new Error("Owned Darwin hosted terminal requires a github-hosted-runner receipt")
      ownedTerminal = await createOwnedTerminal({
        onRetained,
        captureRunId,
        out,
        expectedLaunchRunId: process.env.TERMINFO_RUN_ID ?? "",
        darwinHosted: { receiptPath: hostedReceipt },
      })
      assertHostedIdentity(terminal.name, ownedTerminal, "Darwin")
      await installDarwinCapture(ownedTerminal)
    } else if (kind === "windowsHosted") {
      if (!hostedReceipt) throw new Error("Owned Windows hosted terminal requires a github-hosted-runner receipt")
      // The Windows arm has no pixel capture (that stays Darwin-only), so it is the geometry-only arm:
      // the receipt names the launched WindowsTerminal.exe or alacritty.exe, the collector proves it is
      // an ancestor, and every geometry probe then reads the console it is actually writing to.
      ownedTerminal = await createOwnedTerminal({
        onRetained,
        captureRunId,
        out,
        expectedLaunchRunId: process.env.TERMINFO_RUN_ID ?? "",
        windowsHosted: { receiptPath: hostedReceipt },
      })
      assertHostedIdentity(terminal.name, ownedTerminal, "Windows")
      // The hosted Windows arm has no pixels at all, so its only frame source is the console buffer.
      installTextCapture(ownedTerminal)
    }
    const clipboard = ownedTerminal?.clipboard
    const attachment = ownedTerminal?.muxAttachmentProof
    let batch: Awaited<ReturnType<typeof runProbeBatch>>
    // Set only when this run was handed an ordinary-open receipt: the app a person opened themselves
    // (@cto 2026-11-13). It grants the three OSC 52 rows and nothing else.
    let ordinaryOpen: OrdinaryOpenRun | undefined
    try {
      if (kind === "process" && !muxSubject) {
        if (!ownedTerminal) throw new Error("Darwin outer collector has no verified owner")
        const ownership = parseJsonStrict("Darwin outer collector ownership", ownedTerminal.summary)
        if (
          !ownership ||
          typeof ownership !== "object" ||
          Array.isArray(ownership) ||
          !("preflightIdentity" in ownership)
        ) {
          throw new Error("Darwin outer collector ownership lacks measured preflight identity")
        }
        const identity = ownership.preflightIdentity
        if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
          throw new Error("Darwin outer collector preflight identity is not an object")
        }
        draft.rawReplies["collector.preflightIdentity"] = JSON.stringify(identity)
      }
      if (
        muxSubject &&
        (!attachment ||
          attachment.captureRunId !== captureRunId ||
          attachment.mux !== muxSubject.id ||
          attachment.mux !== muxSubject.mux ||
          !muxAttachmentVersionMatches(attachment, muxSubject.version) ||
          !muxAttachmentConfigMatches(attachment, muxSubject.config))
      ) {
        throw new Error("Mux target differs from the verified mux attachment")
      }
      if (attachment && !muxSubject) {
        throw new Error("Verified mux attachment requires its mux runtime provenance envelope")
      }
      if (attachment && outerApp) {
        const source = outerApp.rawReplies["collector.preflightIdentity"]
        if (
          !source ||
          !isDeepStrictEqual(parseJsonStrict("mux outer preflight", source), {
            ...attachment.preflightCollector,
            launchRunId: attachment.launchRunId,
          })
        ) {
          throw new Error("Outer preflight differs from the verified mux attachment")
        }
      }
      collectionStartedAt = new Date().toISOString()
      collectionStartedMs = Date.now()
      recordCollectorAttempt(draft, {
        result: "started",
        startedAt: collectionStartedAt,
        ids: selectedIds,
      })
      checkpoint()
      batch = await withRawMode(
        () =>
          withTTYOperation(
            async () => {
              let geometryCorroboration: GeometryCorroboration | undefined
              let declarationVersion: string | undefined
              let identityQuery:
                | { sequence: string; outbound: string; reason: string; raw: string; rawBase64: string }
                | undefined
              let da2Query: Awaited<ReturnType<typeof queryWithSentinelOutcome>> | undefined
              if (ownedTerminal) {
                const response = await queryWithSentinelOutcome("\x1b[18t", /\x1b\[8;([1-9][0-9]*);([1-9][0-9]*)t/, 700)
                const query = {
                  sequence: "\x1b[18t" as const,
                  outbound: "\x1b[18t\x1b[c" as const,
                  reason: response.reason,
                  raw: response.raw,
                  rawBase64: response.rawBase64,
                }
                if (response.match) {
                  const rows = Number(response.match[1])
                  const cols = Number(response.match[2])
                  const grant = ownedTerminal.geometryAtGrant
                  const status =
                    !Number.isSafeInteger(rows) || !Number.isSafeInteger(cols)
                      ? "malformed"
                      : grant?.status !== "measured"
                        ? "uncorroborated"
                        : rows === grant.rows && cols === grant.cols
                          ? "agree"
                          : "conflict"
                  geometryCorroboration = { status, query, ...(status !== "malformed" ? { rows, cols } : {}) }
                } else {
                  geometryCorroboration = {
                    status: response.raw.includes("\x1b[8;") ? "malformed" : "silent",
                    query,
                  }
                }
                const identity = await queryWithSentinelOutcome("\x1b[>0q", COMPLETE_XTVERSION, 700)
                identityQuery = {
                  sequence: "\x1b[>0q",
                  outbound: "\x1b[>0q\x1b[c",
                  reason: identity.reason,
                  raw: identity.raw,
                  rawBase64: identity.rawBase64,
                }
                // Only Screen consumes DA2 for its measured version; ordinary apps keep their preflight.
                if (measuredTerminal.name === "screen") {
                  da2Query = await queryWithSentinelOutcome("\x1b[>c", COMPLETE_DA2, 700)
                }
                declarationVersion = declaredAppVersion(
                  resolveMeasuredAppVersion(measuredTerminal.name, measuredTerminal.version, {
                    "collector.xtversion": identity.raw,
                    ...(da2Query && { "collector.da2": da2Query.raw }),
                  }),
                  process.env.TERMINFO_TARGET_VERSION,
                )
              }
              // Before the batch, because the answer decides whether this run HAS a capture adapter at all:
              // a terminal whose OWN cell size cannot be mapped is refused here and installs nothing, so no
              // row is handed an adapter that can only throw: every probe takes its own no-capture branch,
              // names the refusal in its row, and the suite completes (28785). Only a timeout aborts.
              if (preflightPixelCapture) await preflightPixelCapture()
              const sessionBus = terminal.os === "linux" ? readSessionBus() : undefined
              // A person's own window (@cto 2026-11-13 PLAN GO, F3): one proof per run, so an owned terminal and an
              // ordinary-open receipt refuse together instead of OR-ing two ownership claims into one artifact.
              const ordinaryOpenReceipt = ordinaryOpenReceiptPath()
              assertOneProofPerRun(ordinaryOpenReceipt !== undefined, ownedTerminal ? kind : undefined)
              if (ordinaryOpenReceipt !== undefined) {
                // The version bound here is what the run knows before its first probe; the subject below publishes
                // what the probes measured, and `assertOrdinaryOpenVersionBound` refuses if the two disagree.
                const beforeProbes = resolveMeasuredAppVersion(
                  measuredTerminal.name,
                  measuredTerminal.version,
                  draft.rawReplies,
                )
                const beforeProbesVersion = declaredAppVersion(beforeProbes, process.env.TERMINFO_TARGET_VERSION)
                ordinaryOpen = await resolveOrdinaryOpenRun({
                  receiptPath: ordinaryOpenReceipt,
                  runId: options.expectedLaunchRunId ?? process.env.TERMINFO_RUN_ID ?? "",
                  subject: {
                    id: measuredTerminal.name,
                    os: terminal.os,
                    // @dev/16 12:26: the declaration is applied FIRST, so a declared target still binds; only an
                    // answer that is still "unknown" after it becomes the no-measured-version refusal.
                    version: beforeProbesVersion === "unknown" ? undefined : beforeProbesVersion,
                  },
                })
              }
              const result = await runProbeBatch({
                ids: options.ids === undefined ? undefined : selectedIds,
                out,
                captureRunId,
                draft,
                onCheckpoint: (progress) => {
                  Object.assign(draft, {
                    rawReplies: { ...draft.rawReplies, ...progress.rawReplies },
                    assertions: progress.assertions,
                    screenshotRefs: progress.screenshotRefs,
                    textSnapshotRefs: progress.textSnapshotRefs,
                  })
                  checkpoint()
                },
                // The run's own target, from the launched app: the receipt is bound to this before any write.
                subject: {
                  ...muxSubject,
                  kind: muxSubject?.kind ?? "term",
                  id: measuredTerminal.name,
                  os: terminal.os,
                  ...(declarationVersion !== undefined && { version: declarationVersion }),
                },
                ...(colourControl === undefined ? {} : { colourControl }),
                appDeclarations:
                  declarationVersion === undefined
                    ? {}
                    : appSemanticDeclarations(
                        {
                          kind: muxSubject?.kind ?? "term",
                          id: measuredTerminal.name,
                          version: declarationVersion,
                          os: terminal.os,
                        },
                        sessionBus,
                      ),
                ...(capture && { capture }),
                ...(captureInstallationRefusal && { captureGeometryRefusal: captureInstallationRefusal }),
                ...(capture && !textCapture && captureSettleMs !== undefined && { captureSettleMs }),
                ...(textCapture && { captureKind: "text-cells" as const }),
                ...(input && { input }),
                ...(ownedTerminal && { ownedTerminal }),
                ...(ownedTerminal?.observeWrite && { onWrite: ownedTerminal.observeWrite.bind(ownedTerminal) }),
                ...(geometryCorroboration && { geometryCorroboration }),
                ...(ordinaryOpen && {
                  ordinaryOpen: {
                    receipt: ordinaryOpen.receipt,
                    expectedBundleId: ordinaryOpen.expectedBundleId,
                    clipboard: ordinaryOpen.clipboard,
                  },
                }),
                ...(prepareCapture && { prepareCapture }),
                ...(finishCapture && { finishCapture }),
              })
              if (sessionBus) result.rawReplies["collector.sessionBus"] = JSON.stringify(sessionBus)
              if (inputInstallFact) result.rawReplies["collector.inputInstall"] = inputInstallFact
              if (identityQuery) {
                result.rawReplies["collector.xtversion"] = identityQuery.raw
                result.rawReplies["collector.xtversionQuery"] = JSON.stringify(identityQuery)
              }
              if (da2Query) {
                result.rawReplies["collector.da2"] = da2Query.raw
                result.rawReplies["collector.da2Query"] = JSON.stringify({ sequence: "\x1b[>c", ...da2Query })
              }
              if (captureCalibration) {
                result.rawReplies["collector.captureCalibration"] = JSON.stringify(captureCalibration)
              }
              if (!disposeQualifiedWindow) await drainStdin(1000)
              return result
            },
            out,
            clipboard ? () => clipboard.assertOwned() : undefined,
          ),
        out,
      )
    } finally {
      await ownedTerminal?.dispose()
    }
    if (ownedTerminal) batch.rawReplies["collector.terminalOwnership"] = ownedTerminal.summary
    if (clipboard) batch.rawReplies["collector.clipboardFixture"] = clipboard.summary
    if (ordinaryOpen) batch.rawReplies[ORDINARY_OPEN_COLLECTOR_KEY] = ordinaryOpenRecord(ordinaryOpen)
    const measuredVersion =
      (terminal.name === "windows-terminal" || terminal.name === "alacritty") && batch.appLaunch?.platform === "win32"
        ? batch.appLaunch.productVersion
        : resolveMeasuredAppVersion(measuredTerminal.name, measuredTerminal.version, batch.rawReplies)
    const subject: ProbeSubject = muxSubject
      ? { ...muxSubject, version: measuredVersion }
      : {
          kind: "term",
          id: terminal.name,
          // Windows Terminal uses its parsed launched-executable ProductVersion; other apps use terminal
          // identity replies. alacritty reports none at all -
          // XTVERSION answers with nothing and neither TERM_PROGRAM nor TERM_PROGRAM_VERSION is set - so
          // it is "unknown" here, which provenance can never agree with. When the APPARATUS declared a
          // version for this target (the launcher passes TERMINFO_TARGET_VERSION in the image
          // environment; it is never read back out of the ownership receipt), write that declaration
          // instead. The value is NOT a version the terminal reported - the raw replies show it reported
          // none - and the provenance check still does its work: the binary's own `--version` must agree
          // with the declaration. A non-apparatus run has no declaration, so "unknown" stays as before.
          version: declaredAppVersion(measuredVersion, process.env.TERMINFO_TARGET_VERSION),
          os: terminal.os,
          osVersion: terminal.osVersion,
          outerTerminal: null,
          mux: null,
          config: null,
          permissions: null,
        }
    // @dev/16 12:22 R1: START binds the pre-probe version, the subject above carries the measured one. If the
    // probes turned out to measure a different build, these rows are about another app and are refused, not published.
    if (ordinaryOpen) assertOrdinaryOpenVersionBound(ordinaryOpen, subject.version)
    const provenance =
      provenancePath && !muxSubject
        ? parseRunProvenance(provenanceSource, subject, { probeHash, sourceRevision }, provenancePath)
        : undefined
    if (provenancePath && !provenance && !outerApp?.provenance) {
      throw new Error(`Missing runtime provenance in ${provenancePath}`)
    }
    if (provenance) subject.config = provenance.fixture.config
    if (clipboard) {
      clipboardConfigAgrees(outerApp?.provenance ?? provenance, clipboard)
      if (clipboard.profile !== "default") subject.permissions = clipboard.permissions
    }
    // Retain owned binary proof for placement; collector drafts never claim verified identity.
    const historyIdentity = ownedTerminal?.getScrollback
      ? verifyTerminalIdentity(subject.id, batch.rawReplies)
      : undefined
    const historyControl = ownedTerminal?.historyControl?.()
    if (historyControl) batch.rawReplies["collector.historyControl"] = JSON.stringify(historyControl)
    // The cmux arm's evidence belongs in the persisted run, not only on the object the collector keeps
    // (@dev/1 peer read 2026-11-13): the grant's outcome and the last read reduced to facts. Serializing
    // here evaluates the live getter, so the record carries the read that happened — never its text, which
    // is the pane transcript (@cto REVISE 2026-11-13).
    const cmuxEvidence = cmuxHistoryEvidence(ownedTerminal?.cmuxHistory)
    if (cmuxEvidence !== undefined) Object.assign(batch.rawReplies, cmuxEvidence)
    // An arm that reads through a separate CLI (WezTerm, 31741) names THAT program: the launched
    // shell's bytes cannot explain a count the terminal's own CLI produced — and when that CLI's proof was
    // not measured, naming the shell's binary instead would be the silent substitution this comment
    // forbids (@dev/18 peer read). A CLI arm therefore reports unmeasured rather than borrowing.
    const historyExecutable =
      ownedTerminal?.historyReadsThroughCli === true
        ? ownedTerminal.historyExecutable
        : (ownedTerminal?.muxAttachmentProof?.executable ?? provenance?.executable)
    const hasHistoryExecutable = Boolean(
      historyExecutable?.path && /^[a-f0-9]{64}$/u.test(historyExecutable.sha256) && historyExecutable.version,
    )
    // One reason, chosen once: an unproven CLI arm says so in its own words instead of reading like an arm
    // that simply never needed a binary.
    const historyIdentityReason = hasHistoryExecutable
      ? undefined
      : ownedTerminal?.historyReadsThroughCli === true
        ? (ownedTerminal.historyExecutableUnmeasured ??
          "owned scrollback CLI proof unmeasured: this arm reads through the terminal's own CLI, and no other binary explains its count")
        : "owned scrollback binary path, sha256 and version unavailable"
    if (historyIdentity) {
      batch.rawReplies["collector.historyIdentityCheck"] = JSON.stringify({
        ...historyIdentity,
        ...(historyExecutable && { executable: historyExecutable }),
        ...(historyIdentityReason !== undefined && { reason: historyIdentityReason }),
      })
    }
    const captured: CapturedRunDraft = {
      ...draft,
      subject,
      ...(provenance && { provenance }),
      ...(outerApp && { outerApp }),
      identity: "unverified",
      measuredAt: new Date().toISOString(),
      origin: { kind: "collector", ...(batch.appLaunch && { appLaunch: batch.appLaunch }) },
      rawReplies: { ...draft.rawReplies, ...batch.rawReplies },
      assertions: batch.assertions,
      screenshotRefs: batch.screenshotRefs,
      ...((batch.textSnapshotRefs?.length ?? 0) > 0 && { textSnapshotRefs: batch.textSnapshotRefs }),
      ...(textQualification === undefined ? {} : { textQualification }),
      results: batch.results,
    }
    if (disposeQualifiedWindow) {
      captured.rawReplies["collector.windowDisposal"] =
        kind === "darwinHosted"
          ? "owned-window-disposal: measured prior modes not restored; pending the hosted workflow's exact-window close and absence proof"
          : "owned-window-disposal: measured prior modes not restored; pending launcher daemon stop, exact-window close and absence proof"
      captured.rawReplies["collector.collectionStatus"] =
        `Collected selected probe results; draft ${captured.runId} awaits final writer`
    }
    const fontResult = captured.results.find((result) => result.featureId === "extensions.font-ligatures")
    const fontReview = fontResult?.tests.find((test) => test.id === "review")
    if (fontResult && fontReview) {
      const fontSource = provenance?.fixture.font
      if (fontSource !== undefined) {
        captured.rawReplies["collector.fontSource"] = fontSource
        // Current evidence projections bind explicit cell references, not unrelated collector fields.
        fontReview.rawReplyRef = "collector.fontSource"
      }
      if (fontReview.status === "probe-todo") {
        let proofState = "absent"
        let detail = "no structured native font source proof retained"
        if (fontSource !== undefined) {
          try {
            const receipt: unknown = JSON.parse(fontSource)
            if (
              receipt !== null &&
              typeof receipt === "object" &&
              "proofState" in receipt &&
              typeof receipt.proofState === "string"
            ) {
              proofState = ["absent", "failed to load", "inconclusive", "source-capable"].includes(receipt.proofState)
                ? receipt.proofState
                : "inconclusive"
              detail = `retained proof state ${receipt.proofState}; it does not decide the ligature`
              if ("reason" in receipt && typeof receipt.reason === "string" && receipt.reason !== "") {
                detail += `: ${receipt.reason}`
              }
            }
          } catch (error) {
            detail = `cannot read structured fixture.font: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        fontReview.reason = `#32062 font control: ${proofState}; ${detail}`
        fontResult.reason = fontReview.reason
      }
    }
    recordTextQualificationTests(
      captured,
      manifest,
      retainedTextSnapshots,
      textQualificationStartedAt ? { scope: "probe", startedAt: textQualificationStartedAt } : undefined,
    )
    if (retainedArtifacts.size > 0) {
      captured.rawReplies["collector.traceManifest"] = JSON.stringify({ blobs: [...retainedArtifacts.values()] })
    }
    recordCollectorAttempt(captured, { ids: selectedIds, startedAt: collectionStartedAt, result: "completed" })
    if (collectionStartedMs !== undefined) captured.collectorDurationMs = Date.now() - collectionStartedMs
    Object.assign(draft, captured)
    checkpoint()
    return captured
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error)
    const result = error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed"
    recordCollectorAttempt(draft, {
      ids: selectedIds,
      ...(collectionStartedAt && { startedAt: collectionStartedAt }),
      result,
      error: diagnostic,
    })
    if (result === "failed" && collectionStartedAt) {
      recordCollectionFailure(draft, collectionStartedAt, diagnostic, delegatedIds)
    } else if (result === "failed") {
      draft.rawReplies["collector.prerequisite"] = diagnostic
      for (const row of draft.results) {
        if (row.status === "probe-todo" && selectedIds.includes(row.featureId)) row.reason = diagnostic
      }
    }
    checkpoint()
    throw error
  }
}

interface DaemonInfo {
  pid: number
  port: number
  terminal: string
  terminalVersion: string
  os: string
  osVersion: string
  started: string
  token: string
  runId: string
}

function register(info: DaemonInfo): string {
  mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 })
  const filename = `${info.terminal}-${info.pid}.json`
  const filepath = join(DAEMON_DIR, filename)
  writeFileSync(filepath, JSON.stringify(info, null, 2), { flag: "wx", mode: 0o600 })
  return filepath
}

function unregister(filepath: string) {
  try {
    unlinkSync(filepath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error(
      `Could not remove daemon registration ${filepath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function listDaemons(): DaemonInfo[] {
  let files: string[]
  try {
    files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".json"))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new Error(
      `Could not list daemon registrations in ${DAEMON_DIR}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return files.map((file) => {
    const filepath = join(DAEMON_DIR, file)
    try {
      const data = JSON.parse(readFileSync(filepath, "utf-8")) as DaemonInfo
      if (!Number.isInteger(data.pid) || !Number.isInteger(data.port) || !/^[0-9a-f]{64}$/.test(data.token)) {
        throw new Error("missing or invalid pid, port, or token")
      }
      return data
    } catch (err) {
      throw new Error(`Invalid daemon registration ${filepath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

export function startDaemon(port = 0): void {
  let ids: string[] | undefined
  if (process.env.TERMINFO_PROBE_IDS !== undefined) {
    let value: unknown
    try {
      value = JSON.parse(process.env.TERMINFO_PROBE_IDS)
    } catch {
      throw new Error("Invalid TERMINFO_PROBE_IDS JSON")
    }
    ids = collectorIds(value, "TERMINFO_PROBE_IDS")
    const resolved = resolveProbeIds(ids)
    if (resolved.result === "invalid") {
      if (resolved.unknownIds.length) {
        throw new Error(`Unknown or inapplicable TERMINFO_PROBE_IDS: ${JSON.stringify(resolved.unknownIds)}`)
      }
      throw new Error(`Duplicate TERMINFO_PROBE_IDS: ${JSON.stringify(ids)}`)
    }
  }
  const terminal = detectTerminal()
  const token = randomBytes(32).toString("hex")
  const runId =
    process.env.TERMINFO_RUN_ID && /^[0-9a-f]{32}$/.test(process.env.TERMINFO_RUN_ID)
      ? process.env.TERMINFO_RUN_ID
      : randomBytes(16).toString("hex")

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json")

      const url = new URL(req.url ?? "/", `http://localhost`)
      const mutatesTTY = url.pathname === "/probe" || url.pathname === "/probe/single" || url.pathname === "/query"
      if (mutatesTTY) {
        const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
        const expected = Buffer.from(token)
        const actual = Buffer.from(supplied)
        const authorized = actual.length === expected.length && timingSafeEqual(actual, expected)
        const origin = req.headers.origin
        const sameOrigin = !origin || origin === `http://${req.headers.host}`
        if (!authorized || !sameOrigin) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "TTY mutation requires this daemon's token and same origin" }))
          return
        }
      }

      if (url.pathname === "/info") {
        res.end(
          JSON.stringify({
            terminal: terminal.name,
            terminalVersion: terminal.version,
            pid: process.pid,
            runId,
            os: terminal.os,
            osVersion: terminal.osVersion,
            probes: "loaded-at-start",
          }),
        )
        return
      }

      if (url.pathname === "/probe") {
        let requestedIds = ids
        let terminalAppOwner: TerminalAppOwnerAssertion | undefined
        let processOwner: ProcessOwnerAssertion | undefined
        let ownedAppOwner: OwnedAppOwnerAssertion | undefined
        if (req.method === "POST") {
          try {
            const body: unknown = JSON.parse(await readBody(req))
            if (
              !body ||
              typeof body !== "object" ||
              Array.isArray(body) ||
              Object.keys(body).some(
                (key) =>
                  key !== "terminalAppOwner" && key !== "processOwner" && key !== "ownedAppOwner" && key !== "ids",
              ) ||
              ["terminalAppOwner", "processOwner", "ownedAppOwner"].filter((key) => key in body).length > 1
            ) {
              throw new Error("Invalid probe request shape")
            }
            if ("ids" in body) requestedIds = collectorIds(body.ids, "probe request ids")
            if ("terminalAppOwner" in body) {
              terminalAppOwner = parseTerminalAppOwner(body.terminalAppOwner)
              if (terminalAppOwner.launchRunId !== runId || terminalAppOwner.workerPid !== process.pid) {
                throw new Error("Terminal.app owner assertion differs from this daemon's launch run or PID")
              }
            }
            if ("processOwner" in body) {
              processOwner = parseProcessOwnerAssertion(body.processOwner)
              if (processOwner.launchRunId !== runId || processOwner.workerPid !== process.pid) {
                throw new Error("Process owner assertion differs from this daemon's launch run or PID")
              }
            }
            if ("ownedAppOwner" in body) {
              ownedAppOwner = parseOwnedAppOwnerAssertion(body.ownedAppOwner)
              if (ownedAppOwner.launchRunId !== runId || ownedAppOwner.workerPid !== process.pid) {
                throw new Error("Owned-app owner assertion differs from this daemon's launch run or PID")
              }
            }
          } catch (error) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
            return
          }
        } else if (req.method !== "GET") {
          res.statusCode = 405
          res.end(JSON.stringify({ error: "Probe collection requires GET or POST" }))
          return
        }
        console.log(
          s.dim(`[${new Date().toISOString()}] Running ${requestedIds?.length ?? ALL_PROBES.length} probes...`),
        )
        const run = await collectProbeRun({
          ...(requestedIds !== undefined && { ids: requestedIds }),
          terminalAppOwner,
          processOwner,
          ownedAppOwner,
          expectedLaunchRunId: runId,
        })
        if (!run.rawReplies["collector.windowDisposal"]) {
          console.log(
            s.dim(
              requestedIds?.length === 0
                ? `Empty selection; draft ${run.runId} retained; no probes executed`
                : `Collected selected probe results; draft ${run.runId} awaits final writer`,
            ),
          )
        }
        res.end(JSON.stringify(run))
        return
      }

      if (url.pathname === "/probe/single") {
        const probeId = url.searchParams.get("id")
        if (!probeId) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Missing ?id= parameter" }))
          return
        }
        const probes = ALL_PROBES
        const probe = probes.find((p) => p.id === probeId)
        if (!probe) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: `Unknown probe: ${probeId}` }))
          return
        }

        res.end(JSON.stringify(await collectProbeRun({ ids: [probeId] })))
        return
      }

      if (url.pathname === "/query" && req.method === "POST") {
        // Execute raw escape sequence commands in this terminal
        // POST body: { commands: [{ write: "\\x1b[6n", read: "\\x1b\\[(\\d+);(\\d+)R", timeout?: 1000 }, ...] }
        try {
          const body = await readBody(req)
          const { commands } = JSON.parse(body) as {
            commands: Array<{ write?: string; read?: string; timeout?: number; measure?: string }>
          }
          if (!Array.isArray(commands)) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "commands must be an array" }))
            return
          }
          if (
            commands.length > 64 ||
            commands.some(
              (cmd) =>
                typeof cmd !== "object" ||
                cmd === null ||
                (cmd.write !== undefined && (typeof cmd.write !== "string" || cmd.write.length > 16384)) ||
                (cmd.measure !== undefined && (typeof cmd.measure !== "string" || cmd.measure.length > 16384)) ||
                (cmd.read !== undefined && (typeof cmd.read !== "string" || cmd.read.length > 512)) ||
                (cmd.timeout !== undefined &&
                  (!Number.isInteger(cmd.timeout) || cmd.timeout < 1 || cmd.timeout > 5000)),
            )
          ) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "commands exceed count, size, or timeout limits" }))
            return
          }

          const results: Array<{
            response?: string | null
            width?: Awaited<ReturnType<TermProbeSource["measureRenderedWidth"]>>
            error?: string
          }> = []

          await withRawMode(async () => {
            process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
            for (const cmd of commands) {
              try {
                if (cmd.measure) {
                  // Measure rendered width of a string
                  const { measureRenderedWidth } = await import("./tty.ts")
                  const width = await measureRenderedWidth(cmd.measure)
                  results.push({ width })
                } else if (cmd.write && cmd.read) {
                  // Write sequence, read response
                  const { query } = await import("./tty.ts")
                  const match = await query(unescapeSequence(cmd.write), new RegExp(cmd.read), cmd.timeout ?? 1000)
                  results.push({ response: match ? match[0] : null })
                } else if (cmd.write) {
                  // Just write, no response expected
                  process.stdout.write(unescapeSequence(cmd.write))
                  results.push({ response: "ok" })
                } else {
                  results.push({ error: "command needs write, read, or measure" })
                }
              } catch (err) {
                results.push({ error: err instanceof Error ? err.message : String(err) })
              }
            }
            process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
            await drainStdin(500)
          })
          console.log(s.dim(`[${new Date().toISOString()}] Executed ${commands.length} commands`))
          res.end(JSON.stringify({ terminal: terminal.name, results }))
        } catch (err) {
          res.statusCode = err instanceof RangeError ? 413 : 400
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
        return
      }

      // Default: show help
      res.end(
        JSON.stringify({
          endpoints: {
            "/info": "Terminal info",
            "/probe": "Run all probes loaded at daemon startup",
            "/probe/single?id=sgr.bold": "Run single probe",
            "/query": "POST — execute raw escape sequence commands",
          },
          terminal: terminal.name,
          version: terminal.version,
        }),
      )
    })().catch((err) => {
      console.error("Probe daemon request failed:", err)
      if (res.headersSent) res.destroy(err instanceof Error ? err : new Error(String(err)))
      else {
        res.statusCode = 500
        res.end(
          JSON.stringify({
            name: err instanceof Error ? err.name : "Error",
            error: err instanceof Error ? err.message : String(err),
            ...(err instanceof Error && "captureCommand" in err ? { captureCommand: err.captureCommand } : {}),
          }),
        )
      }
    })
  })

  server.listen(port, "127.0.0.1", () => {
    const addr = server.address()
    if (!addr || typeof addr === "string") return
    const actualPort = addr.port

    const info: DaemonInfo = {
      pid: process.pid,
      port: actualPort,
      terminal: terminal.name,
      terminalVersion: terminal.version,
      os: terminal.os,
      osVersion: terminal.osVersion,
      started: new Date().toISOString(),
      token,
      runId,
    }

    const filepath = register(info)

    console.log(s.yellow(`! Probe daemon listening on localhost:${actualPort}; stop with Ctrl+C when done.\n`))
    console.log(`${s.bold("terminfo.dev")} daemon running\n`)
    console.log(`  Terminal:  ${s.bold(terminal.name)} ${terminal.version}`)
    console.log(`  Port:      ${s.bold(String(actualPort))}`)
    console.log(`  Probes:    loaded at startup (restart after definitions change)`)
    console.log(``)
    console.log(`  Test:   use the registered daemon token to authorize /probe`)
    console.log(`  Info:   curl http://localhost:${actualPort}/info`)
    console.log(`  Single: /probe/single?id=sgr.bold (token required)`)

    // Clean up on exit
    const cleanup = () => {
      let exitCode = 0
      try {
        unregister(filepath)
      } catch (err) {
        console.error(err)
        exitCode = 1
      }
      server.close()
      process.exit(exitCode)
    }
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)
  })
}

/** Read full request body */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 65536) {
        reject(new RangeError("Query body exceeds 64 KiB"))
      } else chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}

/** Convert \\x1b notation to actual escape characters */
function unescapeSequence(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\e/g, "\x1b")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
}
