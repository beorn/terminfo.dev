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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ProbeSuiteManifest, ProbeTarget } from "@terminfo/probe-defs"
import { parseRun } from "@terminfo/run-parser"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { assertDeclareIsAuthoring, declareCurrentSuiteManifest, verifySuiteManifest } from "./suite-manifest.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CONTENT_DIR = join(ROOT, "content")
const RUN_DIRS: Record<ProbeTarget["kind"], string> = {
  app: "probes-apps",
  headless: "probes-libs",
  mux: "probes-mux",
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
 * Admit a run. Condition 1 of the ruling: a manifest may be computed ONLY from the run's own suite,
 * so this refuses by name unless the live suite equals the run's `probeHash`. That keeps "the
 * revision is current here" a check rather than an assumption, and it never computes `probes` from
 * a different suite.
 */
export function admitRun(plan: AdmissionPlan): {
  manifest: "created" | "existing"
  run: "created" | "existing"
  screenshots: { created: number; existing: number }
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

  const screenshots = placeScreenshots(plan.source, loaded.screenshotRefs)
  const run = placeRun(plan.destination, bytes)
  return { manifest: declaration.status, run, screenshots }
}

function usage(): never {
  console.error(
    "Usage: bun scripts/admit-run.ts --for <run.json> [--into <path>]\n" +
      "  Declares the run's suite manifest (derived record only) and places the run and every\n" +
      "  screenshot it cites in content/. Refuses by name if a cited screenshot is missing.\n" +
      "  Refuses unless this tree runs the run's own suite; commit the admission in your own worktree.",
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
