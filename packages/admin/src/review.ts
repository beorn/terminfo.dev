/** Explicit retained-capture review: issuer index, pinned citations and private immutable application. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { CaptureDecision, CapturedRunDraft } from "@terminfo/probe-defs"
import {
  applyCaptureDecision,
  canonicalJson,
  decodeCollectorDraft,
  parseCaptureDecision,
  parseJsonStrict,
  parseRun,
  parseSuiteManifest,
  retainCaptureBinding,
} from "@terminfo/run-parser"
import { readExplicitSuiteTarget } from "../suite-manifest.ts"
import { saveDaemonProbeRun } from "../../terminfo.dev/src/capture-writer.ts"

type Context = { kind: string; id: string; os?: string }
type Pin = { repo: string; commit: string }
type Citation = { sourceIndex: number } & (
  | { kind: "git"; repo: "terminfo.dev" | "termless"; commit: string; path: string; startLine: number; endLine: number }
  | { kind: "external"; root: string; path: string; sha256: string }
  | { kind: "reference"; text: string }
)
type IndexedDecision = { source: string; startedAt: string; sha256: string; citations: Citation[] }
export type IntakeOptions = {
  input: string
  context: Context
  suiteRoot: string
  terminfoRepo: string
  terminfoCommit: string
  termlessRepo: string
  termlessCommit: string
  output: string
}
type Index = {
  format: "capture-review-index-v1"
  options: IntakeOptions
  input: { path: string; sha256: string }
  run: { path: string; sha256: string }
  manifest: { kind: "registry" | "source-receipt"; path?: string; producer: string; pin: string; sha256: string }
  sources: Record<"terminfo.dev" | "termless", Pin>
  pending: Array<{ featureId: string; captureSha256: string; evidence: unknown }>
  decisions: IndexedDecision[]
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex")
function absolute(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`Absolute path required: ${String(path)}`)
  return resolve(path)
}
function read(path: string) {
  const bytes = readFileSync(absolute(path))
  return { path, bytes, source: new TextDecoder("utf-8", { fatal: true }).decode(bytes), sha256: sha(bytes) }
}
function git(pin: Pin, args: string[]): string {
  absolute(pin.repo)
  if (!/^[a-f0-9]{40}$/.test(pin.commit)) throw new Error(`Full 40-hex source commit required: ${pin.commit}`)
  const result = spawnSync("git", args, { cwd: pin.repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0)
    throw new Error(`Cannot resolve source ${pin.repo}@${pin.commit}: ${result.error?.message ?? result.stderr}`)
  return result.stdout
}
function sameContext(value: unknown, context: Context): boolean {
  return (
    record(value) &&
    value.kind === context.kind &&
    value.id === context.id &&
    (context.os === undefined || value.os === context.os)
  )
}
function trustedManifest(options: IntakeOptions, suite: string) {
  if (!/^[a-f0-9]{12}$/.test(suite)) throw new Error(`Invalid capture suite: ${suite}`)
  const path = join(absolute(options.suiteRoot), "content", "suites", `${suite}.json`)
  const pin = { repo: options.terminfoRepo, commit: options.terminfoCommit }
  if (git(pin, ["rev-parse", "HEAD"]).trim() !== pin.commit)
    throw new Error("Source receipt requires checkout at the capture source commit")
  const producer = join(absolute(pin.repo), "packages/terminfo.dev/src/serve.ts")
  git(pin, ["show", `${pin.commit}:packages/terminfo.dev/src/serve.ts`])
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const {getTrustedSuiteReceipt}=await import(process.argv[1]); console.log(JSON.stringify(getTrustedSuiteReceipt()))",
      producer,
    ],
    {
      cwd: pin.repo,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, TERMINFO_PROBE_HASH: suite, TERMINFO_SOURCE_REVISION: pin.commit },
    },
  )
  if (result.error || result.status !== 0)
    throw new Error(
      `Source receipt producer ${producer}@${pin.commit} failed: ${result.error?.message ?? result.stderr}`,
    )
  const receipt = parseJsonStrict(producer, result.stdout)
  if (!record(receipt) || !record(receipt.manifest))
    throw new Error("Source receipt requires manifest and collector revision")
  if (receipt.collectorRevision !== pin.commit) throw new Error("Source receipt commit mismatch")
  if (receipt.manifest.probeHash !== suite) throw new Error("Source receipt suite mismatch")
  const manifest = parseSuiteManifest(producer, canonicalJson(receipt.manifest))
  if (existsSync(path)) {
    const target = readExplicitSuiteTarget(options.suiteRoot, suite)
    for (const key of [
      "schemaVersion",
      "probeHash",
      "adapterVersion",
      "catalogIds",
      "catalogEntrySha256",
      "probes",
      "textClaims",
      "textQualification",
    ] as const)
      if (canonicalJson(target.manifest[key]) !== canonicalJson(manifest[key]))
        throw new Error(`Registry suite identity differs from pinned producer: ${key}`)
    return {
      manifest: target.manifest,
      binding: { kind: "registry" as const, path, producer, pin: pin.commit, sha256: sha(readFileSync(path)) },
    }
  }
  return {
    manifest,
    binding: { kind: "source-receipt" as const, producer, pin: pin.commit, sha256: sha(canonicalJson(manifest)) },
  }
}
function load(options: IntakeOptions) {
  if (
    !record(options.context) ||
    !["term", "lib", "mux"].includes(options.context.kind) ||
    !options.context.id ||
    (options.context.kind !== "lib" && !options.context.os)
  )
    throw new Error("Explicit context requires kind, id and OS for term/mux")
  const input = read(options.input),
    header = parseJsonStrict(input.path, input.source)
  if (!record(header)) throw new Error(`${input.path}: run or pass object required`)
  let runInput = input
  if (Object.hasOwn(header, "contexts")) {
    if (!Array.isArray(header.contexts)) throw new Error(`${input.path}: pass contexts array required`)
    const rows = header.contexts.filter((row) => record(row) && sameContext(row.context, options.context))
    if (rows.length !== 1) throw new Error(`${input.path}: explicit context must identify exactly one pass row`)
    const row = rows[0] as Record<string, unknown>
    if (typeof row.rawRun !== "string" || !row.rawRun)
      throw new Error(`${input.path}: selected context requires rawRun`)
    if (!["pending-review", "classified", "admitted"].includes(String(row.status)))
      throw new Error(`${input.path}: context status ${String(row.status)} is not a measured pass row`)
    runInput = read(resolve(dirname(input.path), row.rawRun))
  }
  const raw = parseJsonStrict(runInput.path, runInput.source)
  if (!record(raw) || typeof raw.probeHash !== "string" || typeof raw.sourceRevision !== "string")
    throw new Error(`${runInput.path}: run suite/source metadata required`)
  if (runInput !== input && (header.probeHash !== raw.probeHash || header.sourceRevision !== raw.sourceRevision))
    throw new Error(`${input.path}: pass rawRun suite/source mismatch`)
  if (options.terminfoCommit !== raw.sourceRevision)
    throw new Error(`${runInput.path}: Terminfo source pin differs from run sourceRevision`)
  const target = trustedManifest(options, raw.probeHash)
  if (!target.manifest.catalogIds || !target.manifest.catalogEntrySha256)
    throw new Error(`${target.binding.producer}: frozen catalogue identities required`)
  const decoded = decodeCollectorDraft(runInput.path, runInput.source, target.manifest, raw.sourceRevision)
  if (!sameContext(decoded.run.subject ?? decoded.run.intendedSubject, options.context))
    throw new Error(`${runInput.path}: selected context differs from run`)
  const sources = {
    "terminfo.dev": { repo: options.terminfoRepo, commit: options.terminfoCommit },
    termless: { repo: options.termlessRepo, commit: options.termlessCommit },
  }
  if (sources["terminfo.dev"].commit !== raw.sourceRevision)
    throw new Error(`${runInput.path}: Terminfo source pin differs from run sourceRevision`)
  for (const pin of Object.values(sources)) git(pin, ["cat-file", "-e", `${pin.commit}^{commit}`])
  const pending = decoded.run.results
    .filter((row) =>
      row.tests.some(
        (test) =>
          test.id === "review" &&
          (test.status === "test-todo" ||
            (row.criterionBranch === "source-negative-review" && test.status === "test-failure")),
      ),
    )
    .map((row) => {
      const hash = target.manifest.catalogEntrySha256![row.featureId]
      if (
        !hash ||
        !decoded.run.rawReplies[`collector.capture.${row.featureId}`] ||
        !decoded.run.rawReplies[`collector.evidence.${row.featureId}`]
      )
        throw new Error(`${runInput.path}: required retained binding/evidence missing for ${row.featureId}`)
      const binding = retainCaptureBinding(structuredClone(decoded.run), row.featureId, hash)
      return { featureId: row.featureId, captureSha256: binding.sha256, evidence: binding.evidence }
    })
  const index: Index = {
    format: "capture-review-index-v1",
    options,
    input: { path: input.path, sha256: input.sha256 },
    run: { path: runInput.path, sha256: runInput.sha256 },
    manifest: target.binding,
    sources,
    pending,
    decisions: [],
  }
  return { index, decoded, manifest: target.manifest }
}
/** Resolve existing ancestors too: a symlink must not turn a private destination into a source write. */
function destination(path: string, index: Index): string {
  const target = absolute(path)
  let ancestor = target
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const actual = resolve(realpathSync(ancestor), relative(ancestor, target))
  for (const root of [index.options.suiteRoot, ...Object.values(index.sources).map((pin) => pin.repo)]) {
    const rel = relative(realpathSync(absolute(root)), actual)
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel)))
      throw new Error(`Private output must be outside source/suite repository: ${target}`)
  }
  if ([index.input.path, index.run.path, index.manifest.path].includes(target))
    throw new Error(`Immutable input cannot be an output: ${target}`)
  return target
}
function writePrivate(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 })
}
export function intakeReview(options: IntakeOptions) {
  const { index } = load(options)
  writePrivate(destination(options.output, index), index)
  return {
    intake: options.output,
    run: index.run,
    manifest: index.manifest,
    pending: index.pending.length,
    empty: index.pending.length === 0,
  }
}
function citations(input: IndexedDecision, decision: CaptureDecision, index: Index): string[] {
  if (typeof input.source !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256) || sha(input.source) !== input.sha256)
    throw new Error("Decision byte hash mismatch")
  if (!Array.isArray(input.citations) || input.citations.length !== decision.sources.length)
    throw new Error("Every decision source entry requires one explicit citation classification")
  const seen = new Set<number>()
  return input.citations.map((citation) => {
    if (!record(citation) || !Number.isInteger(citation.sourceIndex) || seen.has(citation.sourceIndex))
      throw new Error("Invalid/duplicate citation source index")
    seen.add(citation.sourceIndex)
    let rendered: string, status: string
    if (citation.kind === "git") {
      const pin = index.sources[citation.repo]
      if (
        !pin ||
        citation.commit !== pin.commit ||
        typeof citation.path !== "string" ||
        isAbsolute(citation.path) ||
        citation.path.split("/").some((part) => !part || part === "." || part === "..") ||
        !Number.isInteger(citation.startLine) ||
        !Number.isInteger(citation.endLine) ||
        citation.startLine < 1 ||
        citation.endLine < citation.startLine
      )
        throw new Error("Invalid pinned source citation")
      rendered = `${citation.repo}@${citation.commit}:${citation.path}:L${citation.startLine}-L${citation.endLine}`
      const blob = git(pin, ["show", `${pin.commit}:${citation.path}`])
      const lines = blob.endsWith("\n") ? blob.slice(0, -1).split("\n") : blob.split("\n")
      if (citation.endLine > lines.length) throw new Error(`Source citation line range absent: ${rendered}`)
      status = `verified: ${rendered}`
    } else if (citation.kind === "external") {
      if (
        typeof citation.path !== "string" ||
        isAbsolute(citation.path) ||
        citation.path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("External citation requires a portable source path")
      const localPath = join(absolute(citation.root), citation.path)
      if (!/^[a-f0-9]{64}$/.test(citation.sha256))
        throw new Error(`External citation requires file SHA256: ${citation.path}`)
      rendered = `${citation.path} sha256:${citation.sha256}`
      if (!existsSync(localPath)) status = `unverified: ${citation.path} (tree absent)`
      else {
        if (sha(readFileSync(localPath)) !== citation.sha256)
          throw new Error(`External source SHA256 mismatch: ${citation.path}`)
        status = `verified: ${citation.path}`
      }
    } else if (citation.kind === "reference" && typeof citation.text === "string" && citation.text.length) {
      if (/^(terminfo\.dev|termless)@/.test(citation.text) || / sha256:[a-f0-9]{64}$/.test(citation.text))
        throw new Error("Code citation requires git/external classification")
      rendered = citation.text
      status = `reference (not code-verified): ${citation.text}`
    } else throw new Error("Unknown source citation classification")
    if (decision.sources[citation.sourceIndex] !== rendered)
      throw new Error(`Citation does not exactly match decision sources[${citation.sourceIndex}]: ${rendered}`)
    return status
  })
}
function checkPreservation(
  before: CapturedRunDraft,
  after: CapturedRunDraft,
  decisions: Array<{ decision: CaptureDecision; source: string }>,
) {
  const targets = new Set(decisions.map(({ decision }) => decision.featureId))
  const ensure = (condition: boolean, what: string) => {
    if (!condition) throw new Error(`Review postcheck failed: ${what}`)
  }
  ensure(!Object.hasOwn(after, "sealedAt"), "output must remain unsealed")
  ensure(
    isDeepStrictEqual(
      before.results.map((row) => row.featureId),
      after.results.map((row) => row.featureId),
    ),
    "result population/order",
  )
  before.results.forEach((row, i) => {
    if (!targets.has(row.featureId)) ensure(isDeepStrictEqual(row, after.results[i]), `non-target ${row.featureId}`)
  })
  ensure(
    isDeepStrictEqual(before.assertions, after.assertions.slice(0, before.assertions.length)),
    "original assertion prefix",
  )
  for (const [key, value] of Object.entries(before.rawReplies))
    ensure(after.rawReplies[key] === value, `original raw entry ${key}`)
  const expectedRaw = { ...before.rawReplies }
  const appended = decisions.flatMap(({ decision, source }) => {
    expectedRaw[`collector.review.${decision.id}`] = source
    if (
      ["untestable", "tool-gap"].includes(decision.decision) ||
      before.results.find((row) => row.featureId === decision.featureId)?.criterionBranch ===
        "semantic-prompt-source-review"
    )
      return []
    return before.assertions
      .filter((assertion) => assertion.featureId === decision.featureId)
      .map((assertion) => ({
        ...assertion,
        kind: decision.decision === "supported" ? "positive" : "negative",
        note: `Capture review ${decision.id}: ${decision.reason}`,
      }))
  })
  ensure(isDeepStrictEqual(after.rawReplies, expectedRaw), "exact retained decision records")
  ensure(
    isDeepStrictEqual(after.assertions.slice(before.assertions.length), appended),
    "canonical assertion append semantics",
  )
  const { results: _oldResults, assertions: _oldAssertions, rawReplies: _oldRaw, ...oldOther } = before
  const { results: _newResults, assertions: _newAssertions, rawReplies: _newRaw, ...newOther } = after
  ensure(isDeepStrictEqual(oldOther, newOther), "other original run fields")
}
export function applyReview(options: { intake: string; output: string; receipt: string }) {
  const originalIndex = read(options.intake),
    parsed = parseJsonStrict(originalIndex.path, originalIndex.source)
  if (
    !record(parsed) ||
    parsed.format !== "capture-review-index-v1" ||
    !record(parsed.options) ||
    !Array.isArray(parsed.decisions)
  )
    throw new Error("Capture review index and explicit decisions array required")
  const index = parsed as unknown as Index,
    current = load(index.options)
  for (const key of ["input", "run", "manifest", "sources", "pending"] as const)
    if (!isDeepStrictEqual(index[key], current.index[key])) throw new Error(`Review ${key} binding/hash changed`)
  const output = destination(options.output, index),
    receiptPath = destination(options.receipt, index)
  if (existsSync(receiptPath)) throw new Error(`Receipt already exists: ${receiptPath}`)
  const verified: string[] = [],
    decisions = index.decisions.map((input) => {
      const decision = parseCaptureDecision(
        parseJsonStrict("review decision", input.source),
        "review decision",
        new Set(current.manifest.catalogIds),
      )
      verified.push(...citations(input, decision, index))
      return { decision, source: input.source, startedAt: input.startedAt }
    })
  let written: string | null = null
  if (decisions.length) {
    if (current.decoded.kind !== "captured") throw new Error("Empty selection has no captured reviews to apply")
    const before = current.decoded.run,
      shadow = structuredClone(before)
    for (const input of decisions) {
      applyCaptureDecision(
        shadow,
        input.source,
        input.startedAt,
        undefined,
        current.manifest.catalogEntrySha256![input.decision.featureId],
      )
      if (shadow.rawReplies[`collector.review.${input.decision.id}.lapse`])
        throw new Error(`Review binding lapsed: ${shadow.rawReplies[`collector.review.${input.decision.id}.lapse`]}`)
    }
    checkPreservation(before, shadow, decisions)
    parseRun(
      "review shadow",
      JSON.stringify(shadow),
      current.manifest.catalogIds!,
      new Map([[current.manifest.probeHash, current.manifest]]),
      { mode: "capture" },
    )
    mkdirSync(output, { recursive: true, mode: 0o700 })
    written = saveDaemonProbeRun(before, output, undefined, {
      manifest: current.manifest,
      decisions,
      origin: () => undefined,
      keepDraft: true,
    })
    const after = read(written)
    parseRun(
      after.path,
      after.source,
      current.manifest.catalogIds!,
      new Map([[current.manifest.probeHash, current.manifest]]),
      { mode: "capture" },
    )
    const actual = parseJsonStrict(after.path, after.source) as CapturedRunDraft
    checkPreservation(before, actual, decisions)
    if (!isDeepStrictEqual(actual, shadow)) throw new Error("Writer output differs from canonical application")
  }
  for (const binding of [
    index.input,
    index.run,
    ...(index.manifest.path ? [{ path: index.manifest.path, sha256: index.manifest.sha256 }] : []),
    { path: options.intake, sha256: originalIndex.sha256 },
  ])
    if (read(binding.path).sha256 !== binding.sha256) throw new Error(`Immutable input bytes changed: ${binding.path}`)
  const receipt = {
    output: written,
    decisionsApplied: decisions.length,
    empty: decisions.length === 0,
    canonicalReadback: "PASS",
    input: index.input,
    run: index.run,
    manifest: index.manifest,
    citations: verified,
    downstreamOperationInvoked: false,
  }
  writePrivate(receiptPath, receipt)
  for (const status of verified) if (status.startsWith("unverified:")) console.error(status)
  return receipt
}
