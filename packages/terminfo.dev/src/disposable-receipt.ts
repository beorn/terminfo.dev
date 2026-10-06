import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

/**
 * A disposable-ownership receipt is what authorizes mutate+readback against a terminal (27832).
 * Only a receipt that names a kind whose terminal is provably not a person's may enable a write:
 * a Linux Xvfb container the apparatus creates, runs once and removes, or a GitHub-hosted runner
 * whose VM is shown never to be reused. An absent, unparsable or foreign receipt leaves the
 * untouched default path; nothing here accepts a flag or a caller option in place of a receipt.
 *
 * The collector verifies this ONCE, before its first write, and records the kind and the digest;
 * it is never a per-probe decision.
 */
export type DisposableKind = "linux-xvfb-container" | "github-hosted-runner"

export interface DisposableReceipt {
  kind: DisposableKind
  runId: string
  collectedAt: string
  /** sha256 of the exact bytes the verdict was read from, so a run names the receipt it trusted. */
  sha256: string
}

const RUN_ID = /^[0-9a-f]{32}$/
const DIGEST = /^[0-9a-f]{64}$/
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const CLIPBOARD_PROFILES = ["default", "allow", "deny-read"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(where: string, detail: string): never {
  throw new Error(`Disposable ownership receipt (${where}): ${detail}`)
}

function object(source: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const value = source[key]
  if (!isRecord(value)) fail(where, `${key} must be an object`)
  return value
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== "string" || value === "") fail(where, `${key} must be a non-empty string`)
  return value
}

function digest(source: Record<string, unknown>, key: string, where: string): string {
  const value = text(source, key, where)
  if (!DIGEST.test(value)) fail(where, `${key} must be a sha256 digest`)
  return value
}

function oneOf(source: Record<string, unknown>, key: string, allowed: readonly string[], where: string): string {
  const value = text(source, key, where)
  if (!allowed.includes(value)) fail(where, `${key} must be one of ${allowed.join(", ")}`)
  return value
}

/** The Linux half the collector can actually read: /out/host-measured.json, authored by the host
 * launcher and mounted read-only before the container starts. The composed container receipt is
 * written on the host after the container is removed, so it is deliberately not what this accepts. */
function assertLinuxXvfbContainer(value: Record<string, unknown>): void {
  const where = "linux-xvfb-container"
  const runtime = object(value, "runtime", where)
  text(runtime, "imageId", `${where} runtime`)
  digest(runtime, "imageTarSha256", `${where} runtime`)
  text(runtime, "arch", `${where} runtime`)
  text(runtime, "nixLockRevision", `${where} runtime`)
  text(runtime, "sourceRevision", `${where} runtime`)
  text(runtime, "sourceTreeStatus", `${where} runtime`)
  text(runtime, "rootRevision", `${where} runtime`)
  text(runtime, "suiteHash", `${where} runtime`)
  const runner = object(value, "runnerArtifact", where)
  digest(runner, "frozenRunnerSha256", `${where} runnerArtifact`)
  digest(runner, "buildReceiptSha256", `${where} runnerArtifact`)
  const target = object(value, "declaredTarget", where)
  text(target, "kind", `${where} declaredTarget`)
  text(target, "id", `${where} declaredTarget`)
  text(target, "os", `${where} declaredTarget`)
  text(value, "preset", where)
  oneOf(value, "clipboardProfile", CLIPBOARD_PROFILES, where)
}

/** A GitHub-hosted runner is disposable only when GitHub says so AND the VM identity never recurs.
 * This accepts the two checks a receipt can carry (hosted environment; one machine for the whole
 * job). Non-reuse across job identities is checked where all receipts are seen, not here. */
function assertGithubHostedRunner(value: Record<string, unknown>): void {
  const where = "github-hosted-runner"
  const job = object(value, "job", where)
  for (const key of ["repository", "workflow", "workflowRef", "githubRunId", "githubRunAttempt", "job", "jobId"]) {
    text(job, key, `${where} job`)
  }
  const runner = object(value, "runner", where)
  const environment = text(runner, "environment", `${where} runner`)
  if (environment !== "github-hosted") {
    fail(
      `${where} runner`,
      `environment must be "github-hosted", never assumed; received ${JSON.stringify(environment)}`,
    )
  }
  for (const key of ["name", "os", "arch", "imageOS", "imageVersion", "trackingId"]) {
    text(runner, key, `${where} runner`)
  }
  const vm = object(value, "vm", where)
  const samples = ["identityAtJobStart", "identityAtCollection"].map((key) => object(vm, key, `${where} vm`))
  for (const [index, sample] of samples.entries()) {
    digest(sample, "machineIdSha256", `${where} vm ${["identityAtJobStart", "identityAtCollection"][index]}`)
    digest(sample, "productUuidSha256", `${where} vm ${["identityAtJobStart", "identityAtCollection"][index]}`)
    digest(sample, "bootIdSha256", `${where} vm ${["identityAtJobStart", "identityAtCollection"][index]}`)
  }
  if (JSON.stringify(samples[0]) !== JSON.stringify(samples[1])) {
    fail(`${where} vm`, "identityAtJobStart and identityAtCollection disagree; one machine must serve the whole job")
  }
}

const KINDS: Record<DisposableKind, (value: Record<string, unknown>) => void> = {
  "linux-xvfb-container": assertLinuxXvfbContainer,
  "github-hosted-runner": assertGithubHostedRunner,
}

/** Strict, loud parse: a receipt is authority only if every field it must carry is present and sane. */
export function parseDisposableReceipt(bytes: string): DisposableReceipt {
  let value: unknown
  try {
    value = JSON.parse(bytes) as unknown
  } catch (cause) {
    throw new Error("Disposable ownership receipt is not JSON", { cause })
  }
  if (!isRecord(value)) fail("envelope", "must be a JSON object")
  if (value.schemaVersion !== 1) fail("envelope", "schemaVersion must be 1")
  const kind = text(value, "kind", "envelope")
  if (kind !== "linux-xvfb-container" && kind !== "github-hosted-runner") {
    fail("envelope", `unknown kind ${JSON.stringify(kind)}; only a named disposable kind may authorize a write`)
  }
  const runId = text(value, "runId", "envelope")
  if (!RUN_ID.test(runId)) fail("envelope", "runId must be 32 lowercase hex")
  const collectedAt = text(value, "collectedAt", "envelope")
  if (!UTC_INSTANT.test(collectedAt)) fail("envelope", "collectedAt must be an RFC3339 UTC instant")
  KINDS[kind](value)
  return { kind, runId, collectedAt, sha256: createHash("sha256").update(bytes).digest("hex") }
}

/** Read and parse the receipt at `path`; a missing file or a bad read is loud, never a silent default. */
export function readDisposableReceipt(path: string): DisposableReceipt {
  let bytes: string
  try {
    bytes = readFileSync(path, "utf8")
  } catch (cause) {
    throw new Error(`Disposable ownership receipt unreadable at ${path}`, { cause })
  }
  return parseDisposableReceipt(bytes)
}
