/**
 * Admit one collected probe run: declare its suite's derived manifest and place the run, so a
 * committed run can never be cited without a trusted declaration (27832 manifest direction (2)).
 *
 * This is the ONE public declare-and-admit entry point. `suite-manifest.ts` still owns the parsing,
 * verification and exclusive-create primitives, but it exposes only `--check`; there is no standalone
 * declare verb that could diverge from admission.
 */

import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import type { Interpretation, ProbeSuiteManifest, ProbeTarget } from "@terminfo/probe-defs"
import {
  decodeExactUtf8,
  measuredVersionTokens,
  parseJsonStrict,
  parseRun,
  parseSuiteManifest,
  type LoadedRun,
} from "@terminfo/run-parser"
import { WINDOWS_MESA_RENDERER_DLLS } from "../run-parser/src/app-launch.ts"
import {
  deriveIdentity,
  resolveMeasuredAppVersion,
  verifyTerminalIdentity,
  TERMINAL_IDENTITY_RULES,
  type TerminalIdentityRule,
} from "../terminfo.dev/src/identity-guard.ts"
import { windowsCommBase } from "../terminfo.dev/src/windows-process-ancestry.ts"
import { parseLinuxClipboardReceipt } from "../terminfo.dev/src/linux-clipboard.ts"
import { activeInterpretations, applies, nonempty, parseInterpretations } from "../../scripts/interpretations.ts"
import { loadFeatures } from "@terminfo/catalog"

import { probeSuiteSnapshot } from "./versions.ts"
import {
  bindReceiptToRun,
  HOSTED_IDENTITY_SOURCES,
  parseDisposableReceipt,
  parseMuxAttachmentProof,
  type ReceiptTarget,
} from "../terminfo.dev/src/disposable-receipt.ts"
import {
  assertDeclareIsAuthoring,
  declareCurrentSuiteManifest,
  derivedSuiteManifest,
  frozenSuiteIdFor,
  verifySuiteManifest,
} from "./suite-manifest.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const CONTENT_DIR = join(ROOT, "content")
const RUN_DIRS: Record<ProbeTarget["kind"], string> = {
  app: "probes-apps",
  headless: "probes-libs",
  mux: "probes-mux",
}

export interface IdentityAdmission {
  rule: string
  da1?: string
  xtversion?: string
  receipt?: { cfBundleShortVersionString: string }
  executable?: { version: string; sha256: string }
}

type ReceiptRefusalCode =
  | "windows-hosted-receipt-required"
  | "ownership-citation-invalid"
  | "ownership-receipt-missing"
  | "ownership-receipt-digest-mismatch"
  | "ownership-receipt-kind-mismatch"
  | "ownership-receipt-invalid"
  | "ownership-receipt-target-mismatch"
  | "ownership-receipt-app-launch-mismatch"
  | "ownership-receipt-run-required"
  | "ownership-receipt-non-reuse"
  | "ownership-receipt-collision"

export type AdmissionExclusionCode =
  | ReceiptRefusalCode
  | "identity-disputed"
  | "identity-unverified"
  | "identity-unreviewed"
  | "runtime-identity-unverified"
  | "identity-no-profile"
  | "identity-replies-mismatch"
  | "native-provenance-missing"
  | "native-provenance-dirty"
  | "outer-app-proof-missing"
  | "outer-app-identity-mismatch"
  | "mux-platform-unqualified"
  | "mux-attachment-missing"
  | "mux-attachment-invalid"
  | "source-uncommitted"
  | "community-unreviewed"
  | "suite-incomplete"

/** Only expected admission refusals become public exclusions; detail stays in authoring diagnostics. */
class ReceiptRefusal extends Error {
  constructor(
    readonly code: AdmissionExclusionCode,
    readonly detail: string,
    cause?: unknown,
  ) {
    super(detail, { cause })
  }
}

function isLinux(os: string | null | undefined): boolean {
  return (os ?? "").toLowerCase().startsWith("linux")
}

function xtversionVersionEquals(payload: string, declared: string): boolean {
  const paren = /^(?:[A-Za-z][\w.+-]*)\(([^)]+)\)$/.exec(payload)
  if (paren) return paren[1] === declared
  return payload === declared || payload.endsWith(` ${declared}`) || payload.endsWith(`/${declared}`)
}

const ADMISSION_IDENTITY_RULES: Record<string, TerminalIdentityRule> = {
  ...TERMINAL_IDENTITY_RULES,
  alacritty: {
    terminal: "alacritty",
    da1Pattern: /\?6c/,
    forbidXtversion: true,
  },
  "windows-terminal": {
    terminal: "windows-terminal",
    da1Pattern: /\?61;/,
    forbidXtversion: true,
  },
}

function identityMatch(run: LoadedRun): IdentityAdmission | null {
  if (run.target.kind === "headless") {
    const receipt = run.runtimeIdentity
    if (!receipt || receipt.engineVersion !== run.target.version) return null
    if (!(receipt.kind === "native" || receipt.integrity.kind === "registry" || receipt.integrity.cleanTree)) {
      return null
    }
    const versionReply = run.schemaVersion === 2 ? deriveIdentity(run.rawReplies).xtversionPayload : undefined
    return versionReply ? { rule: "runtime-identity", xtversion: versionReply } : { rule: "runtime-identity" }
  }
  return protocolIdentityMatch({
    target: run.target,
    rawReplies: run.rawReplies,
    provenance: run.provenance,
    appLaunch: run.origin.appLaunch,
    results: Object.fromEntries(run.observations.map((o) => [o.featureId, o.outcome === "supported"])),
  })
}

/** An identity preflight has no suite observations or fabricated LoadedRun. */
type ProtocolIdentitySubject = Pick<LoadedRun, "target" | "rawReplies" | "provenance"> & {
  appLaunch?: LoadedRun["origin"]["appLaunch"]
  results?: Record<string, boolean>
}

function protocolIdentityMatch(run: ProtocolIdentitySubject): IdentityAdmission | null {
  const rule = ADMISSION_IDENTITY_RULES[run.target.id]
  if (!rule) return null
  if (run.target.kind !== (rule.targetKind ?? "app")) return null
  const verification = TERMINAL_IDENTITY_RULES[run.target.id]
    ? verifyTerminalIdentity(run.target.id, run.rawReplies, run.results)
    : { ok: true, checked: true }
  if (!verification.checked || !verification.ok) return null
  const identity = deriveIdentity(run.rawReplies)
  if (!nonempty(identity.da1)) return null
  const os = (run.target.os ?? "").toLowerCase()
  // On Windows, ?61; is conhost's own reply (Alacritty runs its child inside a ConPTY session),
  // so DA1 identifies nothing there and identity rests on the measured launch receipt.
  const da1Pattern = run.target.id === "alacritty" && os.startsWith("win") ? /\?61;/ : rule.da1Pattern
  if (da1Pattern && !da1Pattern.test(identity.da1)) return null
  if (rule.da2VersionEncoding === "screen") {
    const measured = resolveMeasuredAppVersion(run.target.id, "", run.rawReplies)
    return measured === run.target.version ? { rule: run.target.id, da1: identity.da1 } : null
  }
  if (rule.forbidXtversion) {
    // Windows Terminal and Alacritty on Windows do not report XTVERSION. The hosted apparatus
    // measures the launched executable; identity is its byte-exact version and executable sha256,
    // plus the pinned Mesa3D renderer receipt on Alacritty.
    if ((run.target.id === "windows-terminal" || run.target.id === "alacritty") && os.startsWith("win")) {
      const receipt = run.appLaunch
      if (
        run.target.version === "unknown" ||
        !receipt ||
        receipt.platform !== "win32" ||
        receipt.productVersion !== run.target.version
      ) {
        return null
      }
      if (run.target.id === "windows-terminal") {
        if (
          receipt.sourceArtifact.kind !== "portable-zip" ||
          windowsCommBase(receipt.executablePath) !== "windowsterminal.exe"
        ) {
          return null
        }
      } else if (
        receipt.sourceArtifact.kind !== "portable-exe" ||
        windowsCommBase(receipt.executablePath) !== "alacritty.exe" ||
        !receipt.mesaRenderer
      ) {
        return null
      }
      return {
        rule: run.target.id,
        da1: identity.da1,
        executable: { version: receipt.productVersion, sha256: receipt.executableSha256 },
      }
    }
    // Linux: a terminal that answers no XTVERSION (alacritty) is attested by the APPARATUS, not by
    // itself. The container launcher runs the launched binary's own --version and exits on a
    // disagreement, and records the executable's path and sha256; parseRunProvenance carries that
    // receipt here as `provenance` (@cto 2026-10-07, 31d5bdd0 option b). `?6c` alone is too weak to
    // identify — VT102 is a whole class — so the executable version CONFIRMS what DA1 only bounds.
    if (isLinux(run.target.os)) {
      const provenance = run.provenance
      if (run.target.version === "unknown" || !provenance || !provenance.runtime.cleanTree) return null
      const { version, sha256 } = provenance.executable
      if (!/^[a-f0-9]{64}$/.test(sha256)) return null
      const tokens = measuredVersionTokens(version)
      if (tokens.length !== 1 || tokens[0] !== run.target.version) return null
      return { rule: run.target.id, da1: identity.da1, executable: { version, sha256 } }
    }
    // macOS: unchanged. The launched bundle's CFBundleShortVersionString must equal the declared version.
    if (os.startsWith("mac") || os.startsWith("darwin")) {
      const receipt = run.appLaunch
      if (
        !receipt ||
        receipt.platform === "win32" ||
        run.target.version === "unknown" ||
        receipt.cfBundleShortVersionString !== run.target.version
      ) {
        return null
      }
      return {
        rule: run.target.id,
        da1: identity.da1,
        receipt: { cfBundleShortVersionString: receipt.cfBundleShortVersionString },
      }
    }
    // Any other OS has no apparatus we trust: refused, with no fallback to either branch.
    return null
  }
  const versionReply = identity.xtversionPayload
  if (!versionReply || !xtversionVersionEquals(versionReply, run.target.version)) return null
  return { rule: run.target.id, da1: identity.da1, xtversion: versionReply }
}

function pinnedIdentity(run: LoadedRun, active: readonly Interpretation[]): boolean {
  return active.some(
    (entry) =>
      entry.runId === run.runId && entry.runSha256 === run.sha256 && applies(entry, run) && entry.verifiesIdentity,
  )
}

/** Identity, then provenance, then source/community/suite. Pin is one identity input. */
function identityDecision(
  run: LoadedRun,
  active: readonly Interpretation[],
  identityAdmission: IdentityAdmission | null,
): AdmissionExclusionCode | null {
  if (run.identity === "disputed") return "identity-disputed"
  const pin = pinnedIdentity(run, active)
  if (run.target.kind === "headless") {
    if (run.schemaVersion === 1 && !pin) {
      return run.identity === "unverified" ? "identity-unverified" : "identity-unreviewed"
    }
    return identityAdmission ? null : "runtime-identity-unverified"
  }
  if (!ADMISSION_IDENTITY_RULES[run.target.id]) return "identity-no-profile"
  if (run.schemaVersion === 1) {
    if (!pin) return run.identity === "unverified" ? "identity-unverified" : "identity-unreviewed"
    return identityAdmission ? null : "identity-replies-mismatch"
  }
  return identityAdmission ? null : "identity-replies-mismatch"
}

/** Historical custody joins retained bytes only; it never inspects today's processes or files. */
function muxFixtureMatches(run: LoadedRun, attachment: ReturnType<typeof parseMuxAttachmentProof>): boolean {
  const fixtureSource = run.rawReplies["collector.clipboardFixture"]
  const preflightSource = run.outerApp?.rawReplies["collector.preflightIdentity"]
  if (!fixtureSource || !preflightSource || !run.outerApp?.provenance) return false
  try {
    const fixture = parseJsonStrict("mux clipboard fixture", fixtureSource)
    const preflight = parseJsonStrict("mux outer preflight", preflightSource)
    if (!isRecord(fixture) || typeof fixture.receiptSource !== "string" || !isRecord(preflight)) return false
    const receiptSha256 = createHash("sha256").update(fixture.receiptSource, "utf8").digest("hex")
    if (receiptSha256 !== fixture.receiptSha256 || receiptSha256 !== attachment.receiptSha256) return false
    if (!isDeepStrictEqual(fixture.muxAttachmentProof, attachment)) {
      return false
    }
    const receipt = parseLinuxClipboardReceipt(parseJsonStrict("mux clipboard receipt", fixture.receiptSource))
    const target = receipt.target
    if (!target || target.kind !== "mux") return false
    return (
      receipt.runId === attachment.launchRunId &&
      target.mux === attachment.mux &&
      target.bootId === attachment.bootId &&
      isDeepStrictEqual(target.preflightCollector, attachment.preflightCollector) &&
      isDeepStrictEqual(target.outerShell, attachment.outerShell) &&
      isDeepStrictEqual(target.outerTerminal, attachment.outerTerminal) &&
      isDeepStrictEqual(target.collector, {
        pid: attachment.collector.pid,
        startTicks: attachment.collector.startTicks,
      }) &&
      isDeepStrictEqual(target.executable, attachment.executable) &&
      isDeepStrictEqual(target.config, attachment.config) &&
      target.socketPath === attachment.socketPath &&
      target.session === attachment.session &&
      isDeepStrictEqual(preflight, { ...attachment.preflightCollector, launchRunId: attachment.launchRunId }) &&
      attachment.chain.at(-1)?.executablePath === run.outerApp.provenance.executable.path &&
      receipt.config === run.outerApp.provenance.fixture.config &&
      run.outerApp.target.config === receipt.config &&
      run.target.permissions === (receipt.profile === "default" ? null : receipt.permissions)
    )
  } catch (cause) {
    // Malformed retained input is a named admission refusal, never an empty/default proof.
    if (!(cause instanceof Error)) throw cause
    throw new ReceiptRefusal("mux-attachment-invalid", cause.message, cause)
  }
}

/** All target kinds pass through this one provenance decision. */
function provenanceDecision(run: LoadedRun): AdmissionExclusionCode | null {
  if (run.provenance && !run.provenance.runtime.cleanTree) return "native-provenance-dirty"
  switch (run.target.kind) {
    case "headless":
      return null
    case "app":
      return isLinux(run.target.os) && !run.provenance ? "native-provenance-missing" : null
    case "mux": {
      // CTO 41878c53: the Linux arm may land alone; Darwin awaits its measured owner.
      if (!isLinux(run.target.os)) return "mux-platform-unqualified"
      const outer = run.outerApp
      if (!outer) return "outer-app-proof-missing"
      if (!protocolIdentityMatch(outer)) return "outer-app-identity-mismatch"
      if (outer.provenance && !outer.provenance.runtime.cleanTree) return "native-provenance-dirty"
      if (isLinux(outer.target.os) && !outer.provenance) return "native-provenance-missing"
      const ownershipSource = run.rawReplies["collector.terminalOwnership"]
      if (ownershipSource === undefined) return "mux-attachment-missing"
      let ownership: unknown
      try {
        ownership = parseJsonStrict("collector.terminalOwnership", ownershipSource)
      } catch (cause) {
        if (!(cause instanceof Error)) throw cause
        throw new ReceiptRefusal("mux-attachment-invalid", cause.message, cause)
      }
      if (!isRecord(ownership)) return "mux-attachment-invalid"
      if (ownership.muxAttachment === undefined) return "mux-attachment-missing"
      let attachment: ReturnType<typeof parseMuxAttachmentProof>
      try {
        attachment = parseMuxAttachmentProof(ownership.muxAttachment)
      } catch (cause) {
        if (!(cause instanceof Error) || !cause.message.startsWith("Disposable ownership receipt (mux attachment")) {
          throw cause
        }
        return "mux-attachment-invalid"
      }
      if (
        attachment.captureRunId !== run.runId ||
        attachment.mux !== run.target.id ||
        attachment.mux !== run.target.mux ||
        attachment.config.path !== run.target.config ||
        attachment.executable.version !== run.target.version ||
        !muxFixtureMatches(run, attachment)
      ) {
        return "mux-attachment-invalid"
      }
      return null
    }
    default: {
      const unhandled: never = run.target.kind
      return unhandled
    }
  }
}

function admissionRefusal(
  run: LoadedRun,
  active: readonly Interpretation[],
  reviewed: boolean,
  identityAdmission: IdentityAdmission | null,
): AdmissionExclusionCode | null {
  return (
    identityDecision(run, active, identityAdmission) ??
    provenanceDecision(run) ??
    (!/^[0-9a-f]{40}$/.test(run.sourceRevision ?? "") ? "source-uncommitted" : null) ??
    (run.origin.kind === "community-issue" && !reviewed ? "community-unreviewed" : null) ??
    (!run.suiteComplete ? "suite-incomplete" : null)
  )
}

/**
 * docs/ imports this read-only assessor only. Keep module scope effect-free and this path read-only;
 * placement and the CLI must never run as part of site projection.
 */
export function assessRunAdmission(
  run: LoadedRun,
  active: readonly Interpretation[],
  evidence: { receiptPath?: string; contentDir?: string; mode: "historical" | "placement" },
):
  | { accepted: true; identityAdmission: IdentityAdmission | null }
  | { accepted: false; reason: AdmissionExclusionCode; detail?: string; identityAdmission: null } {
  const identityAdmission = identityMatch(run)
  const reviewed = active.some(
    (entry) => entry.runId === run.runId && entry.runSha256 === run.sha256 && applies(entry, run) && entry.reviewed,
  )
  try {
    const reason = admissionRefusal(run, active, reviewed, identityAdmission)
    if (reason === null) {
      preflightOwnershipReceipt(
        run.path,
        run.rawReplies["collector.disposableOwnership"],
        run.runId,
        { kind: run.target.kind, id: run.target.id, os: run.target.os ?? "" },
        run,
        evidence.contentDir ?? dirname(dirname(run.path)),
        evidence.receiptPath ?? join(dirname(dirname(run.path)), "receipts", `${run.runId}.json`),
        evidence.mode === "placement",
      )
    }
    return reason === null
      ? { accepted: true, identityAdmission }
      : { accepted: false, reason, identityAdmission: null }
  } catch (cause) {
    if (!(cause instanceof ReceiptRefusal)) {
      throw new Error(`Cannot assess ownership receipt for run ${run.runId}`, { cause })
    }
    return { accepted: false, reason: cause.code, detail: cause.detail, identityAdmission: null }
  }
}

const SAFE_COMPONENT = /^[a-zA-Z0-9._-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface AdmissionPlan {
  source: string
  destination: string
  probeHash: string
  target: { kind: ProbeTarget["kind"]; id: string; version: string; os: string }
  runId: string
  frozenSuiteId?: string
  release?: string
}

function catalogIds(): string[] {
  return Object.keys(loadFeatures(CONTENT_DIR))
}

/** Compute where a run lands, from its own target and run id — never from a caller-supplied name. */
export function planAdmission(
  source: string,
  into?: string,
  options: { frozenSuiteId?: string; release?: string } = {},
): AdmissionPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(source, "utf8"))
  } catch (cause) {
    throw new Error(`Cannot read the run to admit: ${source}`, { cause })
  }
  if (!isRecord(parsed)) throw new Error(`Run to admit is not an object: ${source}`)
  if (parsed.schemaVersion !== 2) throw new Error(`Run to admit is not schema v2: ${source}`)
  const target = parsed.target
  if (!isRecord(target) || !["app", "headless", "mux"].includes(String(target.kind))) {
    throw new Error(`Run to admit has no app|headless|mux target kind: ${source}`)
  }
  const kind = target.kind as ProbeTarget["kind"]
  const id = String(target.id)
  const version = String(target.version)
  const os = typeof target.os === "string" && target.os.length > 0 ? target.os : "unknown"
  const runId = String(parsed.runId)
  for (const [label, value] of [
    ["target.id", id],
    ["target.version", version],
    ["target.os", os],
    ["runId", runId],
  ] as const) {
    if (!SAFE_COMPONENT.test(value)) throw new Error(`Run to admit has an unsafe ${label}: ${value}`)
  }
  if (typeof parsed.probeHash !== "string" || !/^[0-9a-f]{12}$/.test(parsed.probeHash)) {
    throw new Error(`Run to admit declares no valid probeHash: ${source}`)
  }
  const manifestPath = join(CONTENT_DIR, "suites", `${parsed.probeHash}.json`)
  const snapshot = probeSuiteSnapshot()
  const manifest = existsSync(manifestPath)
    ? parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8"))
    : parsed.probeHash === snapshot.probeHash
      ? derivedSuiteManifest(snapshot)
      : (() => {
          throw new Error(`Missing suite manifest ${manifestPath}`)
        })()
  const ids = catalogIds()
  const loaded = parseRun(source, readFileSync(source, "utf8"), ids, new Map([[manifest.probeHash, manifest]]))
  const interpretationsPath = join(CONTENT_DIR, "interpretations.json")
  const interpretations = activeInterpretations(
    parseInterpretations(interpretationsPath, readFileSync(interpretationsPath, "utf8"), ids),
  )
  const assessment = assessRunAdmission(loaded, interpretations, {
    receiptPath: join(dirname(source), RECEIPT_BESIDE_RUN),
    contentDir: CONTENT_DIR,
    mode: "placement",
  })
  if (!assessment.accepted) throw new Error(`${source}: ${assessment.detail ?? assessment.reason}`)
  if (parsed.probeHash !== snapshot.probeHash) {
    throw new Error(
      `Refusing to admit a run from suite ${parsed.probeHash}: this tree runs suite ${snapshot.probeHash}. ` +
        "Admit from a tree at the run's suite (its sourceRevision).",
    )
  }
  const frozenSuiteId =
    options.release === undefined ? options.frozenSuiteId : frozenSuiteIdFor(CONTENT_DIR, options.release)
  if (options.release !== undefined && options.frozenSuiteId !== undefined && options.frozenSuiteId !== frozenSuiteId) {
    throw new Error(
      `Asserted suite ${options.frozenSuiteId} is not the declared frozen suite ${frozenSuiteId} for ${options.release}`,
    )
  }
  if (frozenSuiteId !== undefined && (loaded.suiteId !== frozenSuiteId || snapshot.probeHash !== frozenSuiteId)) {
    throw new Error(
      `Run suite ${loaded.suiteId} and tree suite ${snapshot.probeHash} must equal ${options.release ? "declared " : ""}frozen suite ${frozenSuiteId}`,
    )
  }
  if (existsSync(manifestPath)) verifySuiteManifest(manifestPath, snapshot)
  preflightLinuxCompletionReceipt(source, loaded)
  preflightArtifacts(source, loaded.screenshotRefs, CONTENT_DIR, "screenshot")
  preflightArtifacts(source, loaded.textSnapshotRefs, CONTENT_DIR, "text-snapshot")
  const destination = into ?? join(CONTENT_DIR, RUN_DIRS[kind], `${id}-${version}-${os}-${runId}.json`)
  preflightDestination(destination, readFileSync(source), "admitted run")
  assertDeclareIsAuthoring(ROOT, parsed.probeHash)
  return { source, destination, probeHash: parsed.probeHash, target: { kind, id, version, os }, runId, ...options }
}

/**
 * Place one admitted artifact exclusively. Concurrent admission of the same bytes is SUCCESS when
 * the existing bytes are identical: two branches admitting the same hash must both compose, so
 * "exists and verifies" is never a conflict. Different bytes at the same name are loud.
 */
function preflightDestination(destination: string, bytes: Uint8Array, what: string): void {
  if (existsSync(destination) && !readFileSync(destination).equals(bytes)) {
    throw new Error(`Refusing to overwrite a different ${what} at ${destination}`)
  }
}

function placeExclusive(destination: string, bytes: Uint8Array, what: string): "created" | "existing" {
  mkdirSync(dirname(destination), { recursive: true })
  let descriptor: number
  try {
    descriptor = openSync(destination, "wx")
  } catch (cause) {
    if (isRecord(cause) && cause.code === "EEXIST") {
      if (readFileSync(destination).equals(bytes)) return "existing"
      throw new Error(`Refusing to overwrite a different ${what} at ${destination}`)
    }
    throw new Error(`Cannot place ${what} at ${destination}`, { cause })
  }
  try {
    writeFileSync(descriptor, bytes)
  } finally {
    closeSync(descriptor)
  }
  return "created"
}

/** Place the admitted run document exclusively. */
export function placeRun(destination: string, bytes: string): "created" | "existing" {
  return placeExclusive(destination, Buffer.from(bytes, "utf8"), "admitted run")
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/**
 * A retained artifact's kind decides its file extension and the check its bytes must pass. ONE table
 * and ONE verifier read both lists — never a second copy — so a text snapshot cannot be admitted
 * under a PNG's rules, or the other way round. Both are exported because the site verifies the same
 * retained bytes when it reads a projection; it must not grow a second table or a second check.
 */
export const RETAINED_ARTIFACT_KINDS = {
  screenshot: { extension: "png", noun: "Screenshot", png: true, utf8: false },
  "text-snapshot": { extension: "txt", noun: "Text snapshot", png: false, utf8: true },
} as const

export type RetainedArtifactKind = keyof typeof RETAINED_ARTIFACT_KINDS

/**
 * Check retained bytes against the digest their reference cites and the rules their kind names.
 * `where` is the path the bytes came from, so a failure names the artifact rather than a bare digest.
 */
export function verifyRetainedArtifact(kind: RetainedArtifactKind, bytes: Buffer, ref: string, where: string): void {
  const rules = RETAINED_ARTIFACT_KINDS[kind]
  if (!/^sha256:[a-f0-9]{64}$/.test(ref)) {
    throw new Error(`${rules.noun} reference ${ref} at ${where} is not a sha256 digest`)
  }
  const digest = ref.slice("sha256:".length)
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== digest) throw new Error(`${rules.noun} ${where} hashes to ${actual}, not its cited ${digest}`)
  if (rules.png && !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${rules.noun} ${where} is not a PNG`)
  }
  if (rules.utf8) {
    try {
      // The run parser's one exact decoder: it refuses malformed bytes AND bytes that change when
      // decoded (a BOM), so admitted text is the bytes that were retained, not a normalised reading.
      decodeExactUtf8(bytes, where)
    } catch {
      throw new Error(`${rules.noun} ${where} is not exact UTF-8`)
    }
  }
}

function preflightArtifacts(
  source: string,
  refs: readonly string[],
  contentDir: string = CONTENT_DIR,
  kind: RetainedArtifactKind = "screenshot",
): Array<{ destination: string; bytes: Buffer }> {
  const rules = RETAINED_ARTIFACT_KINDS[kind]
  const directory = join(dirname(source), "artifacts")
  const artifacts: Array<{ destination: string; bytes: Buffer }> = []
  for (const ref of refs) {
    if (!/^sha256:[a-f0-9]{64}$/.test(ref)) {
      throw new Error(`Run cites ${rules.noun.toLowerCase()} ${ref}, but that is not a sha256 digest`)
    }
    const digest = ref.slice("sha256:".length)
    const origin = join(directory, `${digest}.${rules.extension}`)
    if (!existsSync(origin)) {
      throw new Error(`Run cites ${rules.noun.toLowerCase()} ${ref}, but ${origin} does not exist beside the run`)
    }
    const bytes = readFileSync(origin)
    verifyRetainedArtifact(kind, bytes, ref, origin)
    const destination = join(contentDir, "artifacts", `${digest}.${rules.extension}`)
    preflightDestination(destination, bytes, kind)
    artifacts.push({ destination, bytes })
  }
  return artifacts
}

/**
 * Place every retained artifact the run cites, beside it, so an admitted run can never reference an
 * artifact that is not committed: admission copies the run document and every digest it cites.
 * Bytes come from `artifacts/` next to the run file — the collector's `/out/artifacts/`. Each must
 * hash to its cited digest and pass its kind's check; a missing or mismatched source refuses BY NAME
 * before the run is placed.
 */
export function placeRetainedArtifacts(
  source: string,
  refs: readonly string[],
  contentDir: string = CONTENT_DIR,
  kind: RetainedArtifactKind = "screenshot",
): { created: number; existing: number } {
  const artifacts = preflightArtifacts(source, refs, contentDir, kind)
  let created = 0
  let existing = 0
  for (const artifact of artifacts) {
    if (placeExclusive(artifact.destination, artifact.bytes, RETAINED_ARTIFACT_KINDS[kind].noun) === "created") {
      created += 1
    } else existing += 1
  }
  return { created, existing }
}

/**
 * The launcher's own name for the receipt it mounts read-only and hands the collector (27874):
 * `host-measured.json`. Admission reads it from beside the run and re-hashes it against the digest
 * the run cites, so the bytes the ownership claim rests on are in the repository, not only a digest.
 */
const RECEIPT_BESIDE_RUN = "host-measured.json"

/**
 * Place the disposable-ownership receipt a run cites (27874). The run document records the receipt
 * only as a digest, so a reader on main cannot see the identity the claim rests on — which is exactly
 * how the four hand-typed 27874 receipts stayed invisible. This places the exact bytes beside the run
 * at content/receipts/<runId>.json, exclusive-create and immutable once admitted, the same rule as
 * suite manifests, and re-parses them through the strict receipt parser so a placeholder identity is
 * refused by name HERE, at admission, and not only where the collector first read it.
 *
 * <runId> is the run document's own runId, so the receipt pairs with the admitted file name. The
 * receipt's own `runId` is the launcher's run id and is not required to equal it: the one genuine
 * container run on main differs (kitty 2912118b… cites a receipt whose own runId is 68eb134d…).
 *
 * What this proves is CONSISTENCY, not ORIGIN. The bytes hash to the digest the run cites, the run's
 * own target is the one the receipt names, and the identity fields are not degenerate — but a
 * determined hand-written receipt with plausible digests passes all of it. Origin is the apparatus
 * handoff (launcher-target-family): the receipt is written outside the measured environment, handed
 * in read-only, and refused if that environment rewrites it.
 *
 * A run collected against a shared terminal cites no receipt ({kind:"shared"}) and places nothing;
 * that is the untouched default path, and the F2 write gate is a separate question.
 */
function preflightOwnershipReceipt(
  source: string,
  ownership: string | undefined,
  runId: string,
  target: ReceiptTarget,
  run: LoadedRun | undefined,
  contentDir: string = CONTENT_DIR,
  receiptPath: string = join(dirname(source), RECEIPT_BESIDE_RUN),
  compareHostedHistory = true,
): { bytes?: Buffer; detail: string } {
  const windowsIdentity = run?.origin.appLaunch?.platform === "win32"
  const requireWindowsHostedReceipt = () => {
    throw new ReceiptRefusal(
      "windows-hosted-receipt-required",
      `Run ${runId}: win32 identity requires a cited github-hosted-runner ownership receipt`,
    )
  }
  if (ownership === undefined) {
    if (windowsIdentity) requireWindowsHostedReceipt()
    return { detail: "the run cites no collector.disposableOwnership reply" }
  }
  let citation: unknown
  try {
    citation = JSON.parse(ownership)
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause
    throw new ReceiptRefusal(
      "ownership-citation-invalid",
      `Run ${runId} has an unparsable collector.disposableOwnership reply: ${source}`,
      cause,
    )
  }
  if (!isRecord(citation)) {
    throw new ReceiptRefusal(
      "ownership-citation-invalid",
      `Run ${runId} has a collector.disposableOwnership reply that is not an object: ${source}`,
    )
  }
  const kind = citation.kind
  if (windowsIdentity && kind !== "github-hosted-runner") requireWindowsHostedReceipt()
  if (kind === "shared") {
    return { detail: "collected against a shared terminal: it cites no receipt, so none is placed" }
  }
  const cited = citation.receiptSha256
  if (typeof cited !== "string" || !/^[0-9a-f]{64}$/.test(cited)) {
    throw new ReceiptRefusal(
      "ownership-citation-invalid",
      `Run ${runId} cites disposable ownership kind ${JSON.stringify(kind)} but no sha256 receiptSha256, ` +
        "so the receipt it trusted cannot be re-checked",
    )
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(receiptPath)
  } catch (cause) {
    if (!isRecord(cause) || cause.code !== "ENOENT") throw cause
    throw new ReceiptRefusal(
      "ownership-receipt-missing",
      `Run ${runId} cites ownership receipt ${cited}, but ${receiptPath} does not exist beside the run: ` +
        "the bytes the claim rests on were not handed in",
      cause,
    )
  }
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== cited) {
    throw new ReceiptRefusal(
      "ownership-receipt-digest-mismatch",
      `Receipt ${receiptPath} hashes to ${actual}, not the ${cited} the run cites`,
    )
  }
  let receipt: ReturnType<typeof parseDisposableReceipt>
  try {
    receipt = parseDisposableReceipt(bytes.toString("utf8"))
  } catch (cause) {
    // This existing strict parser names every expected validation error. Unknown faults stay faults.
    if (!(cause instanceof Error) || !/^Disposable ownership receipt(?: \(| is not JSON)/.test(cause.message)) {
      throw cause
    }
    throw new ReceiptRefusal("ownership-receipt-invalid", cause.message, cause)
  }
  if (receipt.kind !== kind) {
    throw new ReceiptRefusal(
      "ownership-receipt-kind-mismatch",
      `Receipt ${receiptPath} is kind ${JSON.stringify(receipt.kind)} but the run records ${JSON.stringify(kind)}`,
    )
  }
  try {
    bindReceiptToRun(receipt, target, `run ${runId}`)
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.startsWith("Disposable ownership receipt (")) throw cause
    throw new ReceiptRefusal("ownership-receipt-target-mismatch", cause.message, cause)
  }
  if (receipt.appLaunch && !run) {
    throw new ReceiptRefusal(
      "ownership-receipt-run-required",
      `Receipt ${receiptPath} carries appLaunch; supply the loaded run to bind its copied identity`,
    )
  }
  if (run && !isDeepStrictEqual(run.origin.appLaunch, receipt.appLaunch)) {
    const launch = run.origin.appLaunch
    const measured = receipt.appLaunch
    const differing =
      launch && measured
        ? Object.keys({ ...launch, ...measured }).find(
            (key) =>
              !isDeepStrictEqual(
                (launch as unknown as Record<string, unknown>)[key],
                (measured as unknown as Record<string, unknown>)[key],
              ),
          )
        : undefined
    throw new ReceiptRefusal(
      "ownership-receipt-app-launch-mismatch",
      `Run ${runId} origin.appLaunch${differing ? `.${differing}` : ""} differs from cited ownership receipt ${receiptPath}`,
    )
  }
  // The measured renderer must be exactly the pinned Mesa3D set: a DLL beyond it is a renderer
  // nobody pinned, and the presence of opengl32.dll alone does not say which one drew the frames.
  const mesaRenderer = receipt.appLaunch?.platform === "win32" ? receipt.appLaunch.mesaRenderer : undefined
  if (mesaRenderer) {
    const names = mesaRenderer.dlls.map((dll) => dll.name.toLowerCase()).sort()
    if (names.join("\n") !== [...WINDOWS_MESA_RENDERER_DLLS].sort().join("\n")) {
      throw new ReceiptRefusal(
        "ownership-receipt-invalid",
        `Receipt ${receiptPath}: appLaunch.mesaRenderer.dlls ${names.join(", ")} is not exactly the Mesa3D set ${WINDOWS_MESA_RENDERER_DLLS.join(", ")}`,
      )
    }
  }
  if (receipt.kind === "github-hosted-runner" && compareHostedHistory) {
    // Strict parsing above owns validation. Decode only the already-validated hosted fields here;
    // history is visible to admission, never to the collector's single-receipt parser.
    type HostedFields = {
      runner: { os: string }
      job: { githubRunId: string; jobId: string }
      vm: { identityAtJobStart: Record<string, string> }
    }
    const current = JSON.parse(bytes.toString("utf8")) as HostedFields
    const os = current.runner.os
    if (!Object.hasOwn(HOSTED_IDENTITY_SOURCES, os)) {
      throw new ReceiptRefusal(
        "ownership-receipt-invalid",
        `Hosted receipt ${receiptPath}: runner.os ${JSON.stringify(os)} has no ratified identity source/scope table`,
      )
    }
    const directory = join(contentDir, "receipts")
    // ENOENT means the first admission in this content tree. Other directory/read failures stay loud.
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch (cause) {
      if (isRecord(cause) && cause.code === "ENOENT") names = []
      else throw new Error(`Cannot read admitted ownership receipt history at ${directory}`, { cause })
    }
    for (const name of names.filter((name) => name.endsWith(".json")).sort()) {
      const path = join(directory, name)
      let priorBytes: string
      let prior: ReturnType<typeof parseDisposableReceipt>
      try {
        priorBytes = readFileSync(path, "utf8")
        prior = parseDisposableReceipt(priorBytes)
      } catch (cause) {
        throw new Error(
          `Cannot read/parse admitted ownership receipt ${path}; restore valid receipt bytes before retrying admission`,
          { cause },
        )
      }
      if (prior.kind !== "github-hosted-runner") continue
      const previous = JSON.parse(priorBytes) as HostedFields
      if (previous.runner.os !== os) continue // Different OS source values are not comparable.
      if (previous.job.githubRunId === current.job.githubRunId && previous.job.jobId === current.job.jobId) continue
      for (const field of HOSTED_IDENTITY_SOURCES[os as keyof typeof HOSTED_IDENTITY_SOURCES].nonReuse) {
        if (previous.vm.identityAtJobStart[field] === current.vm.identityAtJobStart[field]) {
          throw new ReceiptRefusal(
            "ownership-receipt-non-reuse",
            `Hosted receipt non-reuse: ${field} repeats between jobs ` +
              `${previous.job.githubRunId}/${previous.job.jobId} (${path}) and ` +
              `${current.job.githubRunId}/${current.job.jobId} (${receiptPath}); refusing before placement. Recollect in a fresh hosted job`,
          )
        }
      }
    }
  }
  const destination = join(contentDir, "receipts", `${runId}.json`)
  if (existsSync(destination) && !readFileSync(destination).equals(bytes)) {
    throw new ReceiptRefusal(
      "ownership-receipt-collision",
      `Refusing to overwrite a different disposable-ownership receipt at ${destination}`,
    )
  }
  return { bytes, detail: `content/receipts/${runId}.json (${receiptPath}, ${actual})` }
}

export function placeOwnershipReceipt(
  source: string,
  ownership: string | undefined,
  runId: string,
  target: ReceiptTarget,
  contentDir: string = CONTENT_DIR,
  run?: LoadedRun,
): { placed: "created" | "existing" | "none"; detail: string } {
  const receipt = preflightOwnershipReceipt(source, ownership, runId, target, run, contentDir)
  const placed =
    receipt.bytes === undefined
      ? "none"
      : placeExclusive(join(contentDir, "receipts", `${runId}.json`), receipt.bytes, "disposable-ownership receipt")
  return { placed, detail: receipt.detail }
}

/** Host composition happens only after a completed Linux attach; bind those bytes to this run. */
function preflightLinuxCompletionReceipt(source: string, run: LoadedRun): void {
  if ((run.target.kind !== "app" && run.target.kind !== "mux") || !isLinux(run.target.os)) return
  const hostPath = join(dirname(source), RECEIPT_BESIDE_RUN)
  let host: unknown
  try {
    host = existsSync(hostPath) ? JSON.parse(readFileSync(hostPath, "utf8")) : undefined
  } catch (cause) {
    throw new Error(`Cannot read/parse Linux host-measured.json receipt ${hostPath}`, { cause })
  }
  const launcher =
    run.target.kind === "app" &&
    isRecord(host) &&
    typeof host.preset === "string" &&
    SAFE_COMPONENT.test(host.preset) &&
    typeof host.clipboardProfile === "string" &&
    SAFE_COMPONENT.test(host.clipboardProfile)
      ? `bash scripts/linux-container-run.sh --target ${run.target.id} --preset ${host.preset} --clipboard-profile ${host.clipboardProfile} <outdir>`
      : "bun scripts/release1-collection.ts --plan (read this target's exact launcher command)"
  const cure = `; collect through the launcher to produce an admissible run. From ${ROOT}, run: ${launcher}`
  const path = join(dirname(source), "run-receipt.json")
  if (!existsSync(path)) throw new Error(`${run.target.id}/linux: missing run-receipt.json next to ${source}${cure}`)
  let receipt: unknown
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"))
  } catch (cause) {
    throw new Error(`Cannot read Linux completion receipt ${path}${cure}`, { cause })
  }
  if (
    !isRecord(receipt) ||
    !isRecord(receipt.probeRun) ||
    receipt.probeRun.runId !== run.runId ||
    receipt.probeRun.sha256 !== run.sha256
  ) {
    throw new Error(`Linux completion receipt ${path} does not bind probeRun.runId and sha256 to ${source}${cure}`)
  }
  if (!existsSync(hostPath)) {
    throw new Error(`Linux completion receipt ${path} requires missing host receipt ${hostPath}${cure}`)
  }
  const hostSha256 = createHash("sha256").update(readFileSync(hostPath)).digest("hex")
  if (!isRecord(receipt.receiptInputs) || receipt.receiptInputs.hostSha256 !== hostSha256) {
    throw new Error(`Linux completion receipt ${path} does not bind receiptInputs.hostSha256 to ${hostPath}${cure}`)
  }
}

/**
 * Admit a run. Condition 1 of the ruling: a manifest may be computed ONLY from the run's own suite,
 * so this refuses by name unless the live suite equals the run's `probeHash`. That keeps "the
 * revision is current here" a check rather than an assumption, and it never computes `probes` from
 * a different suite.
 */
export function admitRun(plan: AdmissionPlan): {
  manifest: "created" | "existing"
  run: "created" | "existing"
  screenshots: { created: number; existing: number }
  /** Retained text snapshots placed for this run's text frames; zero for a pixel-only run. */
  textSnapshots: { created: number; existing: number }
  receipt: { placed: "created" | "existing" | "none"; detail: string }
} {
  const snapshot = probeSuiteSnapshot()
  if (snapshot.probeHash !== plan.probeHash) {
    throw new Error(
      `Refusing to admit a run from suite ${plan.probeHash}: this tree runs suite ${snapshot.probeHash}. ` +
        "Admit from a tree at the run's suite (its sourceRevision).",
    )
  }
  const validated = planAdmission(plan.source, plan.destination, {
    frozenSuiteId: plan.frozenSuiteId,
    release: plan.release,
  })
  if (
    validated.probeHash !== plan.probeHash ||
    validated.runId !== plan.runId ||
    JSON.stringify(validated.target) !== JSON.stringify(plan.target)
  ) {
    throw new Error("Admission plan no longer matches the collected run; plan admission again")
  }
  const declaration = declareCurrentSuiteManifest()
  const manifestPath = join(CONTENT_DIR, "suites", `${snapshot.probeHash}.json`)
  const manifest = verifySuiteManifest(manifestPath, snapshot)
  if (manifest.sourceRevision !== undefined && !/^[0-9a-f]{40}$/.test(manifest.sourceRevision)) {
    throw new Error(`Suite manifest ${manifestPath} declares an invalid sourceRevision`)
  }
  const suites = new Map<string, ProbeSuiteManifest>([[snapshot.probeHash, manifest]])
  const bytes = readFileSync(plan.source, "utf8")
  const loaded = parseRun(plan.source, bytes, catalogIds(), suites)

  // Refuse a cited receipt that is missing, mismatched, degenerate or bound to another target,
  // BEFORE placing the run: the ownership claim the run makes is part of what admission admits.
  const receipt = placeOwnershipReceipt(
    plan.source,
    loaded.rawReplies["collector.disposableOwnership"],
    loaded.runId,
    {
      kind: loaded.target.kind,
      id: loaded.target.id,
      os: loaded.target.os ?? "",
    },
    CONTENT_DIR,
    loaded,
  )

  const screenshots = placeRetainedArtifacts(plan.source, loaded.screenshotRefs)
  const textSnapshots = placeRetainedArtifacts(plan.source, loaded.textSnapshotRefs, CONTENT_DIR, "text-snapshot")
  const run = placeRun(plan.destination, bytes)
  return { manifest: declaration.status, run, screenshots, textSnapshots, receipt }
}
