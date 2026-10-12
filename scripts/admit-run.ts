#!/usr/bin/env bun
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
import type { Interpretation, ProbeSuiteManifest, ProbeTarget } from "@terminfo/probe-defs"
import { measuredVersionTokens, parseRun, parseSuiteManifest, type LoadedRun } from "@terminfo/run-parser"
import {
  deriveIdentity,
  verifyTerminalIdentity,
  TERMINAL_IDENTITY_RULES,
  type TerminalIdentityRule,
} from "terminfo.dev/src/identity-guard.ts"
import { activeInterpretations, applies, nonempty, parseInterpretations } from "./interpretations.ts"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import {
  bindReceiptToRun,
  HOSTED_IDENTITY_SOURCES,
  parseDisposableReceipt,
  type ReceiptTarget,
} from "../packages/terminfo.dev/src/disposable-receipt.ts"
import {
  assertDeclareIsAuthoring,
  declareCurrentSuiteManifest,
  derivedSuiteManifest,
  verifySuiteManifest,
} from "./suite-manifest.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CONTENT_DIR = join(ROOT, "content")
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
  const rule = ADMISSION_IDENTITY_RULES[run.target.id]
  if (!rule) return null
  const results = Object.fromEntries(run.observations.map((o) => [o.featureId, o.outcome === "supported"]))
  const verification = TERMINAL_IDENTITY_RULES[run.target.id]
    ? verifyTerminalIdentity(run.target.id, run.rawReplies, results)
    : { ok: true, checked: true }
  if (!verification.checked || !verification.ok) return null
  const identity = deriveIdentity(run.rawReplies)
  if (!nonempty(identity.da1)) return null
  if (rule.da1Pattern && !rule.da1Pattern.test(identity.da1)) return null
  if (rule.forbidXtversion) {
    const os = (run.target.os ?? "").toLowerCase()
    // Linux: a terminal that answers no XTVERSION (alacritty) is attested by the APPARATUS, not by
    // itself. The container launcher runs the launched binary's own --version and exits on a
    // disagreement, and records the executable's path and sha256; parseRunProvenance carries that
    // receipt here as `provenance` (@cto 2026-10-07, 31d5bdd0 option b). `?6c` alone is too weak to
    // identify — VT102 is a whole class — so the executable version CONFIRMS what DA1 only bounds.
    if (os.startsWith("linux")) {
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
      const receipt = run.origin.appLaunch
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
): string | null {
  if (run.identity === "disputed") return "identity-disputed"
  const pin = pinnedIdentity(run, active)
  if (run.target.kind === "headless") {
    if (run.schemaVersion !== 2 && !pin) {
      return run.identity === "unverified" ? "identity-unverified" : "identity-unreviewed"
    }
    return identityAdmission ? null : "runtime-identity-unverified"
  }
  if (!ADMISSION_IDENTITY_RULES[run.target.id]) return "identity-no-profile"
  if (run.schemaVersion !== 2) {
    if (!pin) return run.identity === "unverified" ? "identity-unverified" : "identity-unreviewed"
    return identityAdmission ? null : "identity-replies-mismatch"
  }
  return identityAdmission ? null : "identity-replies-mismatch"
}

/**
 * The run fields the native-provenance gate reads, written structurally so the SITE and the Release 1
 * re-collection runner (`scripts/release1-collection.ts`) share ONE gate: the runner reads unknown
 * documents, and a document it cannot recognise must be judged, never crash.
 */
export interface ProvenanceSubject {
  readonly target?: { readonly kind?: unknown; readonly os?: unknown }
  readonly provenance?: { readonly runtime?: { readonly cleanTree?: unknown } }
}

/**
 * The ONE native-provenance gate (#27929 D6). Only a LINUX APP run must carry a provenance block, and
 * any run that carries one must prove its tree was clean. `scripts/linux-container-run.sh` is the only
 * collector that writes a provenance block, so a headless or macOS run has none BY CONSTRUCTION — a
 * gate that demanded `cleanTree === true` would refuse every such run as `native-provenance-dirty`,
 * and no headless row could ever be admitted.
 */
export function provenanceRefusal(subject: ProvenanceSubject): string | null {
  const kind = subject.target?.kind
  const os = typeof subject.target?.os === "string" ? subject.target.os.toLowerCase() : undefined
  if (kind === "app" && os?.startsWith("linux") && !subject.provenance) return "native-provenance-missing"
  if (subject.provenance && !subject.provenance.runtime?.cleanTree) return "native-provenance-dirty"
  return null
}

function provenanceDecision(run: LoadedRun): string | null {
  return provenanceRefusal(run)
}

function admissionRefusal(
  run: LoadedRun,
  active: readonly Interpretation[],
  reviewed: boolean,
  identityAdmission: IdentityAdmission | null,
): string | null {
  return (
    identityDecision(run, active, identityAdmission) ??
    provenanceDecision(run) ??
    (!/^[0-9a-f]{40}$/.test(run.sourceRevision ?? "") ? "source-uncommitted" : null) ??
    (run.origin.kind === "community-issue" && !reviewed ? "community-unreviewed" : null) ??
    (!run.suiteComplete ? "suite-incomplete" : null)
  )
}

/**
 * docs/ imports this pure assessor only. Keep module scope effect-free and this path read-only;
 * placement and the CLI must never run as part of site projection.
 */
export function assessRunAdmission(
  run: LoadedRun,
  active: readonly Interpretation[] = [],
):
  | { accepted: true; identityAdmission: IdentityAdmission | null }
  | { accepted: false; reason: string; identityAdmission: IdentityAdmission | null } {
  const identityAdmission = identityMatch(run)
  const reviewed = active.some(
    (entry) => entry.runId === run.runId && entry.runSha256 === run.sha256 && applies(entry, run) && entry.reviewed,
  )
  const reason = admissionRefusal(run, active, reviewed, identityAdmission)
  return reason === null ? { accepted: true, identityAdmission } : { accepted: false, reason, identityAdmission }
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
}

function catalogIds(): string[] {
  const path = join(CONTENT_DIR, "features.json")
  const features: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isRecord(features)) throw new Error(`Invalid feature catalog ${path}`)
  return Object.keys(features).filter((id) => !id.startsWith("$"))
}

/** Compute where a run lands, from its own target and run id — never from a caller-supplied name. */
export function planAdmission(source: string, into?: string): AdmissionPlan {
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
  const assessment = assessRunAdmission(loaded, interpretations)
  if (!assessment.accepted) throw new Error(`${source}: ${assessment.reason}`)
  const destination = into ?? join(CONTENT_DIR, RUN_DIRS[kind], `${id}-${version}-${os}-${runId}.json`)
  return { source, destination, probeHash: parsed.probeHash, target: { kind, id, version, os }, runId }
}

/**
 * Place one admitted artifact exclusively. Concurrent admission of the same bytes is SUCCESS when
 * the existing bytes are identical: two branches admitting the same hash must both compose, so
 * "exists and verifies" is never a conflict. Different bytes at the same name are loud.
 */
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
 * Place every screenshot the run cites, beside it, so an admitted run can never reference a PNG
 * that is not committed (27876: admission copied the run document but silently dropped its
 * `screenshotRefs`, and `content/artifacts/` then lacked them). Bytes come from `artifacts/`
 * next to the run file — the collector's `/out/artifacts/`. Each must hash to its cited digest and
 * be a PNG; a missing or mismatched source refuses BY NAME before the run is placed.
 */
export function placeScreenshots(
  source: string,
  refs: readonly string[],
  contentDir: string = CONTENT_DIR,
): { created: number; existing: number } {
  const directory = join(dirname(source), "artifacts")
  let created = 0
  let existing = 0
  for (const ref of refs) {
    const digest = ref.slice("sha256:".length)
    const origin = join(directory, `${digest}.png`)
    if (!existsSync(origin)) {
      throw new Error(`Run cites screenshot ${ref}, but ${origin} does not exist beside the run`)
    }
    const bytes = readFileSync(origin)
    const actual = createHash("sha256").update(bytes).digest("hex")
    if (actual !== digest) throw new Error(`Screenshot ${origin} hashes to ${actual}, not its cited ${digest}`)
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`Screenshot ${origin} is not a PNG`)
    const placed = placeExclusive(join(contentDir, "artifacts", `${digest}.png`), bytes, "screenshot")
    if (placed === "created") created += 1
    else existing += 1
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
export function placeOwnershipReceipt(
  source: string,
  ownership: string | undefined,
  runId: string,
  target: ReceiptTarget,
  contentDir: string = CONTENT_DIR,
): { placed: "created" | "existing" | "none"; detail: string } {
  if (ownership === undefined) {
    return { placed: "none", detail: "the run cites no collector.disposableOwnership reply" }
  }
  let citation: unknown
  try {
    citation = JSON.parse(ownership)
  } catch (cause) {
    throw new Error(`Run ${runId} has an unparsable collector.disposableOwnership reply: ${source}`, { cause })
  }
  if (!isRecord(citation)) {
    throw new Error(`Run ${runId} has a collector.disposableOwnership reply that is not an object: ${source}`)
  }
  const kind = citation.kind
  if (kind === "shared") {
    return { placed: "none", detail: "collected against a shared terminal: it cites no receipt, so none is placed" }
  }
  const cited = citation.receiptSha256
  if (typeof cited !== "string" || !/^[0-9a-f]{64}$/.test(cited)) {
    throw new Error(
      `Run ${runId} cites disposable ownership kind ${JSON.stringify(kind)} but no sha256 receiptSha256, ` +
        "so the receipt it trusted cannot be re-checked",
    )
  }
  const receiptPath = join(dirname(source), RECEIPT_BESIDE_RUN)
  if (!existsSync(receiptPath)) {
    throw new Error(
      `Run ${runId} cites ownership receipt ${cited}, but ${receiptPath} does not exist beside the run: ` +
        "the bytes the claim rests on were not handed in",
    )
  }
  const bytes = readFileSync(receiptPath)
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== cited) {
    throw new Error(`Receipt ${receiptPath} hashes to ${actual}, not the ${cited} the run cites`)
  }
  const receipt = parseDisposableReceipt(bytes.toString("utf8"))
  if (receipt.kind !== kind) {
    throw new Error(
      `Receipt ${receiptPath} is kind ${JSON.stringify(receipt.kind)} but the run records ${JSON.stringify(kind)}`,
    )
  }
  bindReceiptToRun(receipt, target, `run ${runId}`)
  if (receipt.kind === "github-hosted-runner") {
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
      throw new Error(
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
          throw new Error(
            `Hosted receipt non-reuse: ${field} repeats between jobs ` +
              `${previous.job.githubRunId}/${previous.job.jobId} (${path}) and ` +
              `${current.job.githubRunId}/${current.job.jobId} (${receiptPath}); refusing before placement. Recollect in a fresh hosted job`,
          )
        }
      }
    }
  }
  const placed = placeExclusive(join(contentDir, "receipts", `${runId}.json`), bytes, "disposable-ownership receipt")
  return { placed, detail: `${placed} content/receipts/${runId}.json (${RECEIPT_BESIDE_RUN}, ${actual})` }
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
  receipt: { placed: "created" | "existing" | "none"; detail: string }
} {
  const snapshot = probeSuiteSnapshot()
  if (snapshot.probeHash !== plan.probeHash) {
    throw new Error(
      `Refusing to admit a run from suite ${plan.probeHash}: this tree runs suite ${snapshot.probeHash}. ` +
        "Admit from a tree at the run's suite (its sourceRevision).",
    )
  }
  assertDeclareIsAuthoring(ROOT, plan.probeHash)
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
  const receipt = placeOwnershipReceipt(plan.source, loaded.rawReplies["collector.disposableOwnership"], loaded.runId, {
    kind: loaded.target.kind,
    id: loaded.target.id,
    os: loaded.target.os ?? "",
  })

  const screenshots = placeScreenshots(plan.source, loaded.screenshotRefs)
  const run = placeRun(plan.destination, bytes)
  return { manifest: declaration.status, run, screenshots, receipt }
}

function usage(): never {
  console.error(
    "Usage: bun scripts/admit-run.ts --for <run.json> [--into <path>]\n" +
      "  Declares the run's suite manifest (derived record only) and places the run and every\n" +
      "  screenshot it cites in content/. Refuses by name if a cited screenshot is missing.\n" +
      "  Refuses unless this tree runs the run's own suite; commit the admission in your own worktree.\n" +
      "  Refuses by name when a receipt the run cites is missing beside it, mismatched or bound to another target.",
  )
  process.exit(2)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  let source: string | undefined
  let into: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--for") source = argv[++index]
    else if (argv[index] === "--into") into = argv[++index]
    else usage()
  }
  if (!source) usage()
  try {
    const plan = planAdmission(source, into)
    const result = admitRun(plan)
    console.log(
      `Admitted run ${result.run} (screenshots ${result.screenshots.created} created, ` +
        `${result.screenshots.existing} already present): ${plan.destination}`,
    )
    console.log(`Suite manifest ${result.manifest}: ${join(CONTENT_DIR, "suites", `${plan.probeHash}.json`)}`)
    console.log(`Ownership receipt ${result.receipt.placed}: ${result.receipt.detail}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
