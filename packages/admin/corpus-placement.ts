/** Place collected runs and read the stored corpus through the canonical parser. */
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import type { ProbeSuiteManifest, ProbeSubject } from "@terminfo/probe-defs"
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
import { hostedDarwinAppFromExecutablePath } from "../terminfo.dev/src/owned-terminal.ts"
import { parseLinuxClipboardReceipt } from "../terminfo.dev/src/linux-clipboard.ts"
import { nonempty } from "../../scripts/interpretations.ts"
import { loadFeatures } from "@terminfo/catalog"

import { outerLaunchMismatch } from "./src/outer-launch.ts"
import {
  bindReceiptToRun,
  parseDisposableReceipt,
  parseMuxAttachmentProof,
  type ReceiptTarget,
} from "../terminfo.dev/src/disposable-receipt.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const CONTENT_DIR = join(ROOT, "content")
const RUN_DIRS: Record<ProbeSubject["kind"], string> = {
  term: "probes-apps",
  lib: "probes-libs",
  mux: "probes-mux",
}

/** One corpus read: LoadedRun.sha256 is parseRun's hash of the exact bytes read once here. */
export function loadStoredRuns(contentDir: string, catalog: readonly string[]): LoadedRun[] {
  const suites = new Map<string, ProbeSuiteManifest>()
  const suitesDir = join(contentDir, "suites")
  if (existsSync(suitesDir)) {
    for (const file of readdirSync(suitesDir)
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      const path = join(suitesDir, file)
      const manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
      if (file !== `${manifest.probeHash}.json`) {
        throw new Error(`${path}: suite filename does not match ${manifest.probeHash}`)
      }
      suites.set(manifest.probeHash, manifest)
    }
  }
  const runs: LoadedRun[] = []
  for (const dir of [RUN_DIRS.term, RUN_DIRS.mux, RUN_DIRS.lib]) {
    const path = join(contentDir, dir)
    if (!existsSync(path)) throw new Error(`${path}: missing required probe directory`)
    for (const file of readdirSync(path)
      .filter((name) => name.endsWith(".json") && name !== "unified.json")
      .sort()) {
      const runPath = join(path, file)
      runs.push(parseRun(runPath, readFileSync(runPath, "utf8"), catalog, suites))
    }
  }
  return runs
}

interface MeasuredIdentity {
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

type PlacementRefusalCode =
  | ReceiptRefusalCode
  | "identity-disputed"
  | "runtime-identity-unverified"
  | "identity-no-profile"
  | "identity-replies-mismatch"
  | "native-provenance-missing"
  | "native-provenance-dirty"
  | "outer-app-proof-missing"
  | "outer-app-identity-mismatch"
  | "mux-attachment-missing"
  | "mux-attachment-invalid"

/** Only expected admission refusals become public exclusions; detail stays in authoring diagnostics. */
class ReceiptRefusal extends Error {
  constructor(
    readonly code: PlacementRefusalCode,
    readonly detail: string,
    cause?: unknown,
  ) {
    super(detail, { cause })
  }
}

function isLinux(os: string | null | undefined): boolean {
  return (os ?? "").toLowerCase().startsWith("linux")
}

function isDarwin(os: string | null | undefined): boolean {
  const name = (os ?? "").toLowerCase()
  return name.startsWith("mac") || name.startsWith("darwin")
}

function xtversionVersionEquals(payload: string, declared: string): boolean {
  const paren = /^(?:[A-Za-z][\w.+-]*)\(([^)]+)\)$/.exec(payload)
  if (paren) return paren[1] === declared
  return payload === declared || payload.endsWith(` ${declared}`) || payload.endsWith(`/${declared}`)
}

type PlacementIdentityRule = TerminalIdentityRule & { identitySource?: "hosted-darwin" }

const PLACEMENT_IDENTITY_RULES: Record<string, PlacementIdentityRule> = {
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
  cmux: { terminal: "cmux", identitySource: "hosted-darwin" },
  cursor: { terminal: "cursor", identitySource: "hosted-darwin" },
  "com.microsoft.VSCode": { terminal: "com.microsoft.VSCode", identitySource: "hosted-darwin" },
}

function identityMatch(run: LoadedRun): MeasuredIdentity | null {
  if (run.subject.kind === "lib") {
    const receipt = run.runtimeIdentity
    if (!receipt || receipt.engineVersion !== run.subject.version) return null
    if (!(receipt.kind === "native" || receipt.integrity.kind === "registry" || receipt.integrity.cleanTree)) {
      return null
    }
    const versionReply = run.schemaVersion !== 1 ? deriveIdentity(run.rawReplies).xtversionPayload : undefined
    return versionReply ? { rule: "runtime-identity", xtversion: versionReply } : { rule: "runtime-identity" }
  }
  return protocolIdentityMatch({
    subject: run.subject,
    rawReplies: run.rawReplies,
    provenance: run.provenance,
    appLaunch: run.origin.appLaunch,
    results: Object.fromEntries(
      run.schemaVersion === 3 || run.schemaVersion === 4
        ? (run.results ?? []).map((result) => [result.featureId, result.status === "supported"])
        : run.observations.map((o) => [o.featureId, o.outcome === "supported"]),
    ),
  })
}

/** An identity preflight has no suite observations or fabricated LoadedRun. */
type ProtocolIdentitySubject = Pick<LoadedRun, "subject" | "rawReplies" | "provenance"> & {
  appLaunch?: LoadedRun["origin"]["appLaunch"]
  results?: Record<string, boolean>
}

function protocolIdentityMatch(run: ProtocolIdentitySubject): MeasuredIdentity | null {
  const rule = PLACEMENT_IDENTITY_RULES[run.subject.id]
  if (!rule) return null
  if (run.subject.kind !== (rule.subjectKind ?? "term")) return null
  const verification = TERMINAL_IDENTITY_RULES[run.subject.id]
    ? verifyTerminalIdentity(run.subject.id, run.rawReplies, run.results)
    : { ok: true, checked: true }
  if (!verification.checked || !verification.ok) return null
  const identity = deriveIdentity(run.rawReplies)
  if (!nonempty(identity.da1)) return null
  const os = (run.subject.os ?? "").toLowerCase()
  // On Windows, ?61; is conhost's own reply (Alacritty runs its child inside a ConPTY session),
  // so DA1 identifies nothing there and identity rests on the measured launch receipt.
  const da1Pattern = run.subject.id === "alacritty" && os.startsWith("win") ? /\?61;/ : rule.da1Pattern
  if (da1Pattern && !da1Pattern.test(identity.da1)) return null
  if (rule.identitySource === "hosted-darwin") {
    const launch = run.appLaunch
    if (
      !isDarwin(os) ||
      !launch ||
      launch.platform === "win32" ||
      run.subject.version === "unknown" ||
      launch.cfBundleShortVersionString !== run.subject.version
    ) {
      return null
    }
    // The engine reply cannot identify its enclosing app. This provisional version match still
    // needs the cited measured launch and GUI app binding in preflightOwnershipReceipt.
    return {
      rule: run.subject.id,
      da1: identity.da1,
      receipt: { cfBundleShortVersionString: launch.cfBundleShortVersionString },
    }
  }
  if (rule.da2VersionEncoding === "screen") {
    const measured = resolveMeasuredAppVersion(run.subject.id, "", run.rawReplies)
    return measured === run.subject.version ? { rule: run.subject.id, da1: identity.da1 } : null
  }
  if (rule.forbidXtversion) {
    // Windows Terminal and Alacritty on Windows do not report XTVERSION. The hosted apparatus
    // measures the launched executable; identity is its byte-exact version and executable sha256,
    // plus the pinned Mesa3D renderer receipt on Alacritty.
    if ((run.subject.id === "windows-terminal" || run.subject.id === "alacritty") && os.startsWith("win")) {
      const receipt = run.appLaunch
      if (
        run.subject.version === "unknown" ||
        !receipt ||
        receipt.platform !== "win32" ||
        receipt.productVersion !== run.subject.version
      ) {
        return null
      }
      if (run.subject.id === "windows-terminal") {
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
        rule: run.subject.id,
        da1: identity.da1,
        executable: { version: receipt.productVersion, sha256: receipt.executableSha256 },
      }
    }
    // Linux: a terminal that answers no XTVERSION (alacritty) is attested by the APPARATUS, not by
    // itself. The container launcher runs the launched binary's own --version and exits on a
    // disagreement, and records the executable's path and sha256; parseRunProvenance carries that
    // receipt here as `provenance` (@cto 2026-10-07, 31d5bdd0 option b). `?6c` alone is too weak to
    // identify — VT102 is a whole class — so the executable version CONFIRMS what DA1 only bounds.
    if (isLinux(run.subject.os)) {
      const provenance = run.provenance
      if (run.subject.version === "unknown" || !provenance || !provenance.runtime.cleanTree) return null
      const { version, sha256 } = provenance.executable
      if (!/^[a-f0-9]{64}$/.test(sha256)) return null
      const tokens = measuredVersionTokens(version)
      if (tokens.length !== 1 || tokens[0] !== run.subject.version) return null
      return { rule: run.subject.id, da1: identity.da1, executable: { version, sha256 } }
    }
    // macOS: unchanged. The launched bundle's CFBundleShortVersionString must equal the declared version.
    if (os.startsWith("mac") || os.startsWith("darwin")) {
      const receipt = run.appLaunch
      if (
        !receipt ||
        receipt.platform === "win32" ||
        run.subject.version === "unknown" ||
        receipt.cfBundleShortVersionString !== run.subject.version
      ) {
        return null
      }
      return {
        rule: run.subject.id,
        da1: identity.da1,
        receipt: { cfBundleShortVersionString: receipt.cfBundleShortVersionString },
      }
    }
    // Any other OS has no apparatus we trust: refused, with no fallback to either branch.
    return null
  }
  const versionReply = identity.xtversionPayload
  if (!versionReply || !xtversionVersionEquals(versionReply, run.subject.version)) return null
  return { rule: run.subject.id, da1: identity.da1, xtversion: versionReply }
}

/** Collection requires measured identity; editorial decisions supply no identity evidence. */
function identityDecision(run: LoadedRun, identity: MeasuredIdentity | null): PlacementRefusalCode | null {
  if (run.identity === "disputed") return "identity-disputed"
  if (run.subject.kind === "lib") return identity ? null : "runtime-identity-unverified"
  if (!PLACEMENT_IDENTITY_RULES[run.subject.id]) return "identity-no-profile"
  return identity ? null : "identity-replies-mismatch"
}

/** Historical custody joins retained bytes only; it never inspects today's processes or files. */
function muxFixtureMatches(run: LoadedRun, attachment: ReturnType<typeof parseMuxAttachmentProof>): boolean {
  // Darwin joins against its own owner launch record (§D4.6); Linux against the clipboard fixture.
  // An arm with no join fails closed.
  if (attachment.platform === "darwin") {
    // The app run measures the owner launch record (app.ts writes it into that run's rawReplies);
    // the mux run is the row being admitted, so it reads the app's reply, as Linux reads
    // collector.preflightIdentity (@cto 72e4b60b).
    if (!run.outerApp) {
      throw new ReceiptRefusal(
        "mux-attachment-invalid",
        `Darwin mux run ${run.runId} cites owner launch receipt ${attachment.receiptSha256} but names no outer app run`,
      )
    }
    if (!isDarwin(run.subject.os) || !isDarwin(run.outerApp.subject.os)) {
      throw new ReceiptRefusal(
        "mux-attachment-invalid",
        `Darwin mux run ${run.runId} cites a darwin owner launch receipt but reports os ${run.subject.os ?? "unknown"} and outer os ${run.outerApp.subject.os ?? "unknown"}`,
      )
    }
    const source = run.outerApp.rawReplies["collector.outerLaunch"]
    if (source === undefined) {
      throw new ReceiptRefusal(
        "mux-attachment-invalid",
        `Darwin mux run ${run.runId} cites owner launch receipt ${attachment.receiptSha256} but has no collector.outerLaunch reply`,
      )
    }
    const ownerExecutablePath = attachment.chain.at(-1)?.executablePath
    if (ownerExecutablePath === undefined) {
      throw new ReceiptRefusal("mux-attachment-invalid", `Darwin mux run ${run.runId} has no outer terminal hop`)
    }
    const mismatch = outerLaunchMismatch(source, attachment, ownerExecutablePath)
    if (mismatch !== null) {
      throw new ReceiptRefusal("mux-attachment-invalid", `Darwin mux receipt refused: ${mismatch}`)
    }
    return true
  }
  if (attachment.platform !== "linux") return false
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
      run.outerApp.subject.config === receipt.config &&
      run.subject.permissions === (receipt.profile === "default" ? null : receipt.permissions)
    )
  } catch (cause) {
    // Malformed retained input is a named admission refusal, never an empty/default proof.
    if (!(cause instanceof Error)) throw cause
    throw new ReceiptRefusal("mux-attachment-invalid", cause.message, cause)
  }
}

/** All subject kinds pass through this one provenance decision. */
function provenanceDecision(run: LoadedRun): PlacementRefusalCode | null {
  if (run.provenance && !run.provenance.runtime.cleanTree) return "native-provenance-dirty"
  switch (run.subject.kind) {
    case "lib":
      return null
    case "term":
      return isLinux(run.subject.os) && !run.provenance ? "native-provenance-missing" : null
    case "mux": {
      const outer = run.outerApp
      if (!outer) return "outer-app-proof-missing"
      if (!protocolIdentityMatch(outer)) return "outer-app-identity-mismatch"
      if (outer.provenance && !outer.provenance.runtime.cleanTree) return "native-provenance-dirty"
      if (isLinux(outer.subject.os) && !outer.provenance) return "native-provenance-missing"
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
        attachment.mux !== run.subject.id ||
        attachment.mux !== run.subject.mux ||
        attachment.config.path !== run.subject.config ||
        attachment.executable.version !== run.subject.version ||
        !muxFixtureMatches(run, attachment)
      ) {
        return "mux-attachment-invalid"
      }
      return null
    }
    default: {
      const unhandled: never = run.subject.kind
      return unhandled
    }
  }
}

const SAFE_COMPONENT = /^[a-zA-Z0-9._-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Place one collected record after all factual checks, using its own subject and run identity. */
export function placeCollectedRun(
  source: string,
  trustedSuite: ProbeSuiteManifest,
  contentDir: string = CONTENT_DIR,
): string {
  const bytes = readFileSync(source)
  const text = decodeExactUtf8(bytes, source)
  const parsed: unknown = parseJsonStrict(source, text)
  if (!isRecord(parsed) || parsed.schemaVersion !== 4) {
    throw new Error(`${source}: collection placement requires a current schema-4 record`)
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(trustedSuite, null, 2)}\n`, "utf8")
  const manifest = parseSuiteManifest(`${source}: trusted collection suite`, manifestBytes.toString("utf8"))
  if (parsed.probeHash !== manifest.probeHash) {
    throw new Error(
      `${source}: collected suite ${String(parsed.probeHash)} differs from trusted suite ${manifest.probeHash}`,
    )
  }
  const loaded = parseRun(
    source,
    text,
    Object.keys(loadFeatures(contentDir)),
    new Map([[manifest.probeHash, manifest]]),
  )
  const { kind, id, version } = loaded.subject
  const os = loaded.subject.os ?? "unknown"
  for (const [label, value] of Object.entries({ id, version, os, runId: loaded.runId })) {
    if (!SAFE_COMPONENT.test(value)) throw new Error(`${source}: unsafe collected ${label}: ${value}`)
  }
  const refusal = identityDecision(loaded, identityMatch(loaded)) ?? provenanceDecision(loaded)
  if (refusal !== null) throw new Error(`${source}: ${refusal}`)
  preflightOwnershipReceipt(
    source,
    loaded.rawReplies["collector.disposableOwnership"],
    loaded.runId,
    { kind, id, os },
    loaded,
    join(dirname(source), RECEIPT_BESIDE_RUN),
  )
  preflightLinuxCompletionReceipt(source, loaded)
  const artifacts = [
    ...preflightArtifacts(source, loaded.screenshotRefs, contentDir, "screenshot"),
    ...preflightArtifacts(source, loaded.textSnapshotRefs, contentDir, "text-snapshot"),
  ]
  const manifestPath = join(contentDir, "suites", `${manifest.probeHash}.json`)
  const destination = join(contentDir, RUN_DIRS[kind], `${id}-${version}-${os}-${loaded.runId}.json`)
  preflightDestination(manifestPath, manifestBytes, "collection suite manifest")
  preflightDestination(destination, bytes, "collected run")
  placeExclusive(manifestPath, manifestBytes, "collection suite manifest")
  for (const artifact of artifacts) placeExclusive(artifact.destination, artifact.bytes, "collected artifact")
  placeRun(destination, text)
  return destination
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
function placeRun(destination: string, bytes: string): "created" | "existing" {
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

/** The launcher retains this receipt beside the collected run for verification. */
const RECEIPT_BESIDE_RUN = "host-measured.json"

/** Verify a cited ownership receipt and bind its measured target and launch to the run. */
function preflightOwnershipReceipt(
  source: string,
  ownership: string | undefined,
  runId: string,
  target: ReceiptTarget,
  run: LoadedRun | undefined,
  receiptPath: string = join(dirname(source), RECEIPT_BESIDE_RUN),
): { bytes?: Buffer; detail: string } {
  const windowsIdentity = run?.origin.appLaunch?.platform === "win32"
  const hostedDarwinIdentity =
    run?.subject.kind === "term" &&
    isDarwin(run.subject.os) &&
    PLACEMENT_IDENTITY_RULES[run.subject.id]?.identitySource === "hosted-darwin"
  const requireDarwinHostedReceipt = () => {
    throw new ReceiptRefusal(
      "ownership-receipt-missing",
      `Run ${runId}: ${run?.subject.id} identity requires a cited github-hosted-runner ownership receipt`,
    )
  }
  const requireWindowsHostedReceipt = () => {
    throw new ReceiptRefusal(
      "windows-hosted-receipt-required",
      `Run ${runId}: win32 identity requires a cited github-hosted-runner ownership receipt`,
    )
  }
  if (ownership === undefined) {
    if (windowsIdentity) requireWindowsHostedReceipt()
    if (hostedDarwinIdentity) requireDarwinHostedReceipt()
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
  if (hostedDarwinIdentity && kind !== "github-hosted-runner") requireDarwinHostedReceipt()
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
  if (hostedDarwinIdentity) {
    // Strict parsing above validated these fields; compare their actual values, not their presence.
    const measured = JSON.parse(bytes.toString("utf8")) as { runner: { os: string } }
    const launch = receipt.appLaunch
    if (!isDarwin(measured.runner.os) || !launch || launch.platform === "win32") {
      throw new ReceiptRefusal(
        "ownership-receipt-target-mismatch",
        `Receipt ${receiptPath}: ${run.subject.id} requires a measured Mac app launch on a Darwin runner; runner OS ${JSON.stringify(measured.runner.os)}`,
      )
    }
    let app: ReturnType<typeof hostedDarwinAppFromExecutablePath>
    try {
      app = hostedDarwinAppFromExecutablePath(launch.executablePath)
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.startsWith("Hosted Darwin receipt executable is not one of")) {
        throw cause
      }
      throw new ReceiptRefusal(
        "ownership-receipt-target-mismatch",
        `Receipt ${receiptPath}: executable ${JSON.stringify(launch.executablePath)} does not identify requested app ${run.subject.id}`,
        cause,
      )
    }
    if (app.id !== run.subject.id) {
      throw new ReceiptRefusal(
        "ownership-receipt-target-mismatch",
        `Receipt ${receiptPath}: executable ${JSON.stringify(launch.executablePath)} identifies ${app.id}, not requested app ${run.subject.id}`,
      )
    }
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
  return { bytes, detail: `${receiptPath} (${actual})` }
}

/** Host composition happens only after a completed Linux attach; bind those bytes to this run. */
function preflightLinuxCompletionReceipt(source: string, run: LoadedRun): void {
  if ((run.subject.kind !== "term" && run.subject.kind !== "mux") || !isLinux(run.subject.os)) return
  const hostPath = join(dirname(source), RECEIPT_BESIDE_RUN)
  let host: unknown
  try {
    host = existsSync(hostPath) ? JSON.parse(readFileSync(hostPath, "utf8")) : undefined
  } catch (cause) {
    throw new Error(`Cannot read/parse Linux host-measured.json receipt ${hostPath}`, { cause })
  }
  const launcher =
    run.subject.kind === "term" &&
    isRecord(host) &&
    typeof host.preset === "string" &&
    SAFE_COMPONENT.test(host.preset) &&
    typeof host.clipboardProfile === "string" &&
    SAFE_COMPONENT.test(host.clipboardProfile)
      ? `bash scripts/linux-container-run.sh --target ${run.subject.id} --preset ${host.preset} --clipboard-profile ${host.clipboardProfile} <outdir>`
      : "bun scripts/release1-collection.ts --plan (read this target's exact launcher command)"
  const cure = `; collect through the launcher to produce an admissible run. From ${ROOT}, run: ${launcher}`
  const path = join(dirname(source), "run-receipt.json")
  if (!existsSync(path)) throw new Error(`${run.subject.id}/linux: missing run-receipt.json next to ${source}${cure}`)
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
  if (run.schemaVersion === 3 || run.schemaVersion === 4) {
    const containerPath = join(dirname(source), "container-receipt.json")
    const capturePath = join(dirname(source), "v3-capture.json")
    let container: unknown
    let capture: Buffer
    try {
      const bytes = readFileSync(containerPath)
      if (createHash("sha256").update(bytes).digest("hex") !== receipt.receiptInputs.containerSha256) {
        throw new Error("container receipt digest differs from completion receipt")
      }
      container = JSON.parse(bytes.toString("utf8"))
      capture = readFileSync(capturePath)
    } catch (cause) {
      throw new Error(
        `Linux completion receipt ${path} cannot resolve original custody inputs ${containerPath} and ${capturePath}${cure}`,
        { cause },
      )
    }
    const captureSha256 = createHash("sha256").update(capture).digest("hex")
    if (
      !isRecord(container) ||
      !isRecord(container.probeRun) ||
      container.probeRun.runId !== run.runId ||
      container.probeRun.sha256 !== captureSha256 ||
      run.rawReplies["collector.httpResponseSha256"] !== captureSha256
    ) {
      throw new Error(
        `Linux completion receipt ${path} does not bind original capture bytes ${capturePath} to the final run${cure}`,
      )
    }
    const originalPath = join(dirname(source), "http-responses", captureSha256)
    try {
      if (!readFileSync(originalPath).equals(capture)) {
        throw new Error("retained HTTP entity differs from original capture")
      }
    } catch (cause) {
      throw new Error(
        `Linux completion receipt ${path} cannot resolve matching retained HTTP bytes ${originalPath}${cure}`,
        { cause },
      )
    }
  }
}
