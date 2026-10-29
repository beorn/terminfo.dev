#!/usr/bin/env bun
/**
 * The existing collection entry point, extended toward the full 273-feature, 33-subject-configuration pass.
 * Bare/--plan prints a read-only census and historical Linux launcher recipes.
 * --collect --development invokes existing raw collectors, validates the current suite in memory,
 * and retains private classifications. WIP: headless, Linux and hosted dispatch are wired; other contexts
 * stays visible as unfinished work. No development admission, suite declaration or inclusion.
 * Supplied-run --admit retains its existing admission-owner path and decisive-share report.
 * Explicit final collection validates the declared freeze and every raw context before admission.
 * Remaining platform routes and native qualification are unfinished. No deploy.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import {
  initializeRunDraft,
  recordCollectionFailure,
  recordCollectorSelection,
  recordCollectorAttempt,
  readCollectorAttempt,
  readCollectorSelection,
  resolveProbeIds,
  collectorIds,
  type CollectorAttempt,
  type RunDraft,
} from "@terminfo/probe-defs"
import { buildFullProjectRows } from "../docs/data/full-project.ts"
import { aggregateCurrentResults, currentCoverageSentence, type CurrentAggregate } from "../docs/data/release-scope.ts"
import { decodeCollectorDraft } from "@terminfo/run-parser"
import { saveDaemonProbeRun } from "../packages/terminfo.dev/src/daemon-client.ts"
import { loadFeatures } from "@terminfo/catalog"
import { fullContextCensus, type CensusContext } from "../docs/data/full-census.ts"
import { parseJsonStrict, parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import { frozenSuiteIdFor } from "../packages/admin/suite-manifest.ts"
import { assertPrivateCollectionOutput } from "../packages/admin/src/admit-collected-run.ts"
import { loadCurrentResults, loadDefaultContextPolicy, reviewedContextFor } from "../docs/data/current-results.ts"
import {
  classifyDevelopmentRun,
  consoleHostHeldResults,
  readVerifiedArtifact,
  statesFor as currentStatesFor,
} from "../docs/data/selected-results.ts"
import { parseInterpretations } from "./interpretations.ts"
import { derivedSuiteManifest, probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { collectHeadlessRuns } from "../packages/probes/collect-headless.ts"
import { admitRun, planAdmission, type AdmissionPlan } from "./admit-run.ts"
import { candidateFromSelected } from "../docs/data/run-selection.ts"
import { TRANSPORT_RECEIPT_KIND } from "../packages/terminfo.dev/src/disposable-receipt.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CONTENT = join(ROOT, "content")

/**
 * How a Release 1 context is measured. Every value names an entry point that already exists.
 * "hosted-workflow" is the one value for every context a GitHub-hosted measurement workflow
 * collects — macOS and Windows share it because the route names the collection METHOD, and the
 * row's own `command` names which workflow runs: the platform belongs to the row, not the route.
 */
export type CollectionRoute = "linux-container" | "hosted-workflow" | "headless-termless" | "mux" | "local-owned-app"

export interface CollectionContext {
  /** The context id, as the published row is keyed by. */
  readonly id: string
  readonly os: string
  readonly kind: "term" | "lib" | "mux"
  readonly route: CollectionRoute | null
  /** The entry point that measures this row — the same one the row was measured with. */
  readonly command: string | null
  /** What must land before the row can produce an admissible run; null when nothing is pending. */
  readonly requires: string | null
  /** The committed run that shows why this row exists here, when one does; null otherwise. */
  readonly sourceRun: string | null
  /** Why the row has no route at all, named so it is reported and never dropped. */
  readonly uncollectable: string | null
}

/**
 * The launcher flags a live pass declares for a Linux row, never read from historical runs. A mux row runs
 * inside the Kitty the Kitty row measures: the launcher's `--mux` arm starts tmux or Screen in that PTY and
 * proves the attachment, and refuses any other outer terminal.
 */
function linuxLiveArgs(kind: CollectionContext["kind"], id: string): string[] {
  const target = kind === "mux" ? "kitty" : id
  return [
    "--target",
    target,
    "--preset",
    target === "kitty" ? "current" : "default",
    "--clipboard-profile",
    "default",
    ...(kind === "mux" ? ["--mux", id] : []),
  ]
}

/** Discover the existing launcher's retained raw file on either successful or failed exit. */
function linuxRawRun(output: string): string | undefined {
  const runs = readdirSync(output, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  if (runs.length === 0) return undefined
  const run = runs[0]
  if (runs.length !== 1 || !run) {
    throw new Error(`Linux launcher produced ${runs.length} run directories in ${output}; expected exactly one`)
  }
  for (const name of ["v3-run.json", "v3-run.draft.json", "v3-capture.json"]) {
    const candidate = join(output, run.name, "raw", name)
    if (!existsSync(candidate)) continue
    const path = realpathSync(candidate)
    if (!path.startsWith(`${output}${sep}`)) throw new Error(`Linux raw output escaped its private context: ${path}`)
    return path
  }
  return undefined
}

/** A Linux app row runs the invocation the live pass declares; nothing is read back from a run. */
const linuxAppRow = (id: string): CollectionContext => ({
  id,
  os: "linux",
  kind: "term",
  route: "linux-container",
  command: `bash scripts/linux-container-run.sh ${linuxLiveArgs("term", id).join(" ")} <outdir>`,
  requires: null,
  sourceRun: null,
  uncollectable: null,
})

const macRow = (id: string): CollectionContext => ({
  id,
  os: "macos",
  kind: "term",
  route: "hosted-workflow",
  // The workflow declares `on: workflow_dispatch:` with NO inputs, so a dispatch takes no -f:
  // the printed `-f cli_version=<ver>` named a flag the workflow does not accept (and the
  // "macos-terminal-measurement-artifacts" upload never existed — the matrix uploads
  // per-app artifacts named macos-<app>-<run-id>-<attempt>).
  command:
    "gh workflow run macos-measurement.yml --repo beorn/terminfo.dev --ref <exact-source-ref>, then " +
    "gh run download <run-id> --repo beorn/terminfo.dev for the macos-<app>-<run-id>-<attempt> artifacts",
  requires: null,
  sourceRun: null,
  uncollectable: null,
})

// The register's headless OS sentinel maps to collection's historical unknown only here.
const engineRow = (id: string): CollectionContext => ({
  id,
  os: "unknown",
  kind: "lib",
  route: "headless-termless",
  command: `bun packages/admin/src/index.ts probe termless ${id}`,
  requires: null,
  sourceRun: null,
  uncollectable: null,
})

/**
 * macOS apps the admin launches and owns on this host. kitty is not one of them: its owned codimac
 * run was unadmitted for the missing capture adapter, and @cto then recorded it as not measurable on
 * the hosted runner (see UNMEASURABLE_MAC_APPS). The route stays live for a codimac-only app that
 * the hosted runner cannot run and that qualifies.
 */
const LOCAL_OWNED_MAC_APPS: ReadonlySet<string> = new Set<string>()

/**
 * A macOS row with a measured reason it cannot be collected at all, kept as a named fact instead of
 * a silent gap. kitty's GLFW finds no NSGL pixel format on the GitHub-hosted runner, so no window
 * opens and no collector runs: the receipt alone is not a read (@cto 2026-10-19, closing Option 2).
 * Evidence at /hh/var/@dev/luna3/28021/kitty-hosted-39302236007/.
 */
const UNMEASURABLE_MAC_APPS: ReadonlyMap<string, { readonly runId: string; readonly reason: string }> = new Map([
  [
    "kitty",
    {
      runId: "39302236007",
      reason:
        'not measurable on the hosted runner: run 39302236007 failed at launch with "NSGL: Failed to find a suitable pixel format" / "Failed to create GLFWwindow ... requires working OpenGL 3.3 drivers", so no window opened and no collector ran (README sha256 6be5c15f..., launcher.log 5371bc9b...)',
    },
  ],
])

const localOwnedAppRow = (id: string): CollectionContext => ({
  id,
  os: "macos",
  kind: "term",
  route: "local-owned-app",
  command: `bun packages/admin/src/index.ts probe app ${id} --output <private-directory>`,
  requires: "an owned app window launched by the admin on this host (run-scoped instance group, recorded pid)",
  sourceRun: null,
  uncollectable: null,
})

/** Route membership comes from the existing workflow matrix, not a second list of app IDs. */
function hostedAppIds(os: "macos" | "windows"): ReadonlySet<string> {
  const path = join(ROOT, ".github", "workflows", `${os}-measurement.yml`)
  const workflow = parse(readFileSync(path, "utf8")) as {
    jobs?: Record<string, { strategy?: { matrix?: { include?: Array<{ id?: unknown }> } } }>
  }
  const rows = workflow?.jobs?.[`measure-${os}`]?.strategy?.matrix?.include
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${path}: expected nonempty measure-${os} app matrix`)
  const ids = new Set<string>()
  for (const row of rows) {
    if (typeof row?.id !== "string" || row.id.length === 0) throw new Error(`${path}: matrix app is missing its id`)
    ids.add(row.id)
  }
  return ids
}

function collectionRoutes(expected: readonly CensusContext[]): CollectionContext[] {
  const hosted = { macos: hostedAppIds("macos"), windows: hostedAppIds("windows") }
  const contexts: CollectionContext[] = []
  for (const { terminalId: id, os, kind } of expected) {
    if (kind === "lib") continue
    if (kind === "mux" && os === "linux") {
      contexts.push({
        id,
        os,
        kind: "mux",
        route: "linux-container",
        command: `bash scripts/linux-container-run.sh ${linuxLiveArgs(kind, id).join(" ")} <outdir>`,
        requires: null,
        sourceRun: null,
        uncollectable: null,
      })
    } else if (kind === "mux") {
      contexts.push({
        id,
        os,
        kind: "mux",
        route: "mux",
        command: `bun packages/admin/src/index.ts probe mux ${id} --output <private-output>`,
        requires: "launch and qualify the named outer terminal and genuine mux identity on this host",
        sourceRun: null,
        uncollectable: null,
      })
    } else if (os === "linux") contexts.push(linuxAppRow(id))
    else if (os === "macos" && UNMEASURABLE_MAC_APPS.has(id)) {
      const fact = UNMEASURABLE_MAC_APPS.get(id)!
      contexts.push({
        id,
        os,
        kind: "term",
        route: null,
        command: null,
        requires: null,
        sourceRun: fact.runId,
        uncollectable: fact.reason,
      })
    } else if (os === "macos" && hosted.macos.has(id)) contexts.push(macRow(id))
    else if (os === "macos" && LOCAL_OWNED_MAC_APPS.has(id)) contexts.push(localOwnedAppRow(id))
    else if (os === "windows" && hosted.windows.has(id)) {
      contexts.push({
        id,
        os,
        kind: "term",
        route: "hosted-workflow",
        command:
          "gh workflow run windows-measurement.yml --repo beorn/terminfo.dev --ref <exact-source-ref>, then " +
          `gh run download <run-id> --repo beorn/terminfo.dev for the win32-${id}-<run-id>-<attempt> artifact`,
        requires: null,
        sourceRun: null,
        uncollectable: null,
      })
    } else {
      contexts.push({
        id,
        os,
        kind: "term",
        route: null,
        command: null,
        requires: null,
        sourceRun: null,
        uncollectable: `required route work: ${id}/${os} has no qualified automatic owned launch/capture recipe in the current collection routes`,
      })
    }
  }
  return contexts
}

/** Route the shared register after matching the collector's runtime engines to the catalog's own set. */
export function release1Census(engineBackends: readonly string[]): readonly CollectionContext[] {
  const census = fullContextCensus(CONTENT)
  const runtime = [...engineBackends].sort()
  // The committed catalog is the authority on which engines exist; a literal count here refused a
  // legitimate manifest change twice over (28385, area 15). Adding or dropping an engine still
  // shows up by name below, which is the check that keeps a different family from being published.
  if (runtime.join("\n") !== census.engines.join("\n")) {
    throw new Error(
      `Catalog/Termless engine membership differs: catalog [${census.engines.join(", ")}], runtime [${runtime.join(", ")}]`,
    )
  }
  return [...collectionRoutes(census.contexts), ...census.engines.map(engineRow)]
}

/** The engine backend names the collector would run, from the Termless manifest. */
export async function engineBackendsFromManifest(): Promise<string[]> {
  const { manifest } = await import("@termless/core")
  const backends = manifest().backends
  return Object.keys(backends).filter((name) => backends[name]?.type !== "os")
}

export interface CollectionPass {
  mode: "development" | "admit"
  freeze?: { id: string; release: string; deferrals?: Array<{ context: string; routeIssue: string; reason: string }> }
  directory: string
  probeHash: string
  sourceRevision: string
  inputSha256: Record<string, string>
  catalogIds: string[]
  selection?: { contexts: string[]; ids?: string[] }
  attempt?: CollectorAttempt
  transport?: {
    runner: string
    hostKeyFingerprint: string
    resourceManifestSha256: string
    resourceFiles: number
    receiptSha256: string
    remoteOutput: string
  }
  contexts: Array<{
    context: CollectionContext
    status: "not-started" | "pending-review" | "classified" | "admitted" | "failed"
    rawRun?: string
    directory?: string
    admittedPath?: string
    classification?: ReturnType<typeof classifyDevelopmentRun>
    summary?: CurrentAggregate
    transport?: CollectionPass["transport"]
    error?: string
    reason?: string
  }>
  errors: string[]
  complete: boolean
}

/**
 * Where an owned-app row starts. `local` is the historical behaviour. Any other runner is an
 * explicit ssh destination handed to the transport driver, which moves exact source to an existing
 * host and runs the identical argv there; the host and its trust are environment configuration
 * named on the command line, never product content.
 */
export interface OwnedAppTransportOptions {
  readonly runner: string
  readonly stage?: string
  readonly knownHosts?: string
  readonly removeStage?: boolean
}

/** The one owned-app argv both runners start from; the ssh runner hands the probe to the transport
 * driver, which runs exactly these arguments on the host. */
export function ownedAppCommand(
  context: CollectionContext,
  output: string,
  transport: OwnedAppTransportOptions,
  sourceRevision: string,
): { argv: string[]; label: string } {
  const probe = ["bun", "packages/admin/src/index.ts", "probe", "term", context.id]
  if (transport.runner === "local") {
    return { argv: [...probe, "--output", output], label: `${labelOf(context)} owned-app collection` }
  }
  if (!transport.knownHosts) {
    throw new Error(
      `${labelOf(context)}: an ssh owned-app transport requires --owned-app-known-hosts; trust is never invented`,
    )
  }
  return {
    argv: [
      "bun",
      "scripts/owned-app-remote-run.ts",
      "--transport",
      transport.runner,
      ...(transport.stage === undefined ? [] : ["--stage", transport.stage]),
      "--output",
      output,
      "--source-revision",
      sourceRevision,
      "--context",
      context.id,
      "--known-hosts",
      transport.knownHosts,
      ...(transport.removeStage ? ["--remove-stage"] : []),
      "--",
      ...probe,
    ],
    label: `${labelOf(context)} owned-app transport`,
  }
}

/** Read the host-written transport receipt as the pass's own evidence shape. It grants nothing:
 * the receipt is a record of where a run started and what bytes it moved, never a permission.
 * The receipt is bound to the revision this pass asked for, so a receipt from another run cannot
 * stand in for the bytes this one measured. */
/** Where a context's owned-app artifacts land: the local route writes into the context's own
 * output, the transport driver into <output>/transport. The collector reads from here only. */
export function ownedAppRunsDirectory(output: string, runner: string): string {
  return runner === "local" ? output : join(output, "transport")
}

export function readOwnedAppTransportProof(
  path: string,
  expectedRevision: string,
): NonNullable<CollectionPass["transport"]> {
  const bytes = readFileSync(path, "utf8")
  let value: unknown
  try {
    value = JSON.parse(bytes) as unknown
  } catch (cause) {
    throw new Error(`owned-app transport receipt is not JSON at ${path}`, { cause })
  }
  const receipt = value as {
    schemaVersion?: unknown
    kind?: unknown
    grants?: unknown
    sourceRevision?: unknown
    transport?: unknown
    hostKeyFingerprint?: unknown
    resourceManifestSha256?: unknown
    resourceFiles?: unknown
    output?: { directory?: unknown }
  }
  if (receipt.schemaVersion !== 1 || receipt.kind !== TRANSPORT_RECEIPT_KIND) {
    throw new Error(`owned-app transport receipt at ${path} is not a schemaVersion 1 owned-app-transport record`)
  }
  if (receipt.grants !== "nothing") {
    throw new Error(
      `owned-app transport receipt at ${path} claims ${JSON.stringify(receipt.grants)}; this kind grants nothing`,
    )
  }
  if (receipt.sourceRevision !== expectedRevision) {
    throw new Error(
      `owned-app transport receipt at ${path} names source ${JSON.stringify(receipt.sourceRevision)}, not the collected ${expectedRevision}`,
    )
  }
  for (const field of ["transport", "hostKeyFingerprint", "resourceManifestSha256", "resourceFiles"] as const) {
    if (typeof receipt[field] !== "string" && typeof receipt[field] !== "number") {
      throw new Error(`owned-app transport receipt at ${path} omits ${field}`)
    }
  }
  if (typeof receipt.output?.directory !== "string") {
    throw new Error(`owned-app transport receipt at ${path} omits the remote output directory`)
  }
  return {
    runner: String(receipt.transport),
    hostKeyFingerprint: String(receipt.hostKeyFingerprint),
    resourceManifestSha256: String(receipt.resourceManifestSha256),
    resourceFiles: Number(receipt.resourceFiles),
    receiptSha256: createHash("sha256").update(bytes).digest("hex"),
    remoteOutput: receipt.output.directory,
  }
}

/** Collect privately against live suite bytes; only an explicit, declared freeze enables admission. */
export async function collectPass(
  outputDirectory: string,
  frozenSuiteId?: string,
  ownedApp: OwnedAppTransportOptions = { runner: "local" },
  deferrals: NonNullable<NonNullable<CollectionPass["freeze"]>["deferrals"]> = [],
  selection?: { contexts?: readonly string[]; ids?: readonly string[] },
): Promise<CollectionPass> {
  const resolvedIds = selection?.ids === undefined ? undefined : resolveProbeIds(selection.ids)
  if (resolvedIds?.result === "invalid") {
    throw new Error(`Unknown or duplicate probe IDs: ${[...resolvedIds.unknownIds, ...resolvedIds.duplicateIds].join(", ")}`)
  }
  const probeIds = resolvedIds?.probes.map((probe) => probe.id)
  const snapshot = probeSuiteSnapshot()
  const declaredFreeze =
    frozenSuiteId === undefined ? undefined : declaredCollectionFreeze(frozenSuiteId, snapshot.probeHash)
  const freeze = declaredFreeze && { ...declaredFreeze, ...(deferrals.length > 0 && { deferrals }) }
  const canonical = fullContextCensus(CONTENT).contexts
  const deferred = new Map<string, string>()
  for (const entry of deferrals) {
    if (
      !freeze ||
      !canonical.some((row) => row.context === entry.context) ||
      !entry.routeIssue?.trim() ||
      !entry.reason?.trim() ||
      deferred.has(entry.context)
    ) {
      throw new Error(`Invalid frozen deferral ${entry.context}: requires one declared context, routeIssue and reason`)
    }
    deferred.set(entry.context, entry.reason)
  }
  assertPrivateCollectionOutput(outputDirectory)
  mkdirSync(outputDirectory, { recursive: true })
  const output = realpathSync(outputDirectory)
  const directory = mkdtempSync(join(output, "pass-"))
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  const catalogIds = Object.keys(loadFeatures(CONTENT))
  const interpretationsPath = join(CONTENT, "interpretations.json")
  parseInterpretations(interpretationsPath, readFileSync(interpretationsPath, "utf8"), catalogIds)
  const inputSha256: Record<string, string> = {}
  for (const path of new Set([
    ...snapshot.sourcePaths.map((path) => join(ROOT, path)),
    interpretationsPath,
    join(ROOT, "scripts/release1-collection.ts"),
    join(ROOT, "docs/data/full-census.ts"),
    join(ROOT, "content/features.json"),
    join(ROOT, "content/terminals.json"),
    join(ROOT, "scripts/linux-container-run.sh"),
    join(ROOT, "scripts/interpretations.ts"),
    join(ROOT, "docs/data/selected-results.ts"),
    join(ROOT, "docs/data/release-scope.ts"),
    resolve(ROOT, "../../bun.lock"),
    resolve(ROOT, "../../flake.lock"),
    resolve(ROOT, "../../flake.nix"),
    join(ROOT, "bun.lock"),
    join(ROOT, ".github/workflows/macos-measurement.yml"),
    join(ROOT, ".github/workflows/windows-measurement.yml"),
  ])) {
    inputSha256[path] = createHash("sha256").update(readFileSync(path)).digest("hex")
  }
  const declared = release1Census(await engineBackendsFromManifest()).map((context) =>
    context.route === "linux-container"
      ? {
          ...context,
          command: `bash scripts/linux-container-run.sh ${linuxLiveArgs(context.kind, context.id).join(" ")} <private-output>`,
        }
      : context,
  )
  const contextName = (context: CollectionContext): string =>
    context.kind === "lib" ? `${context.id}/headless` : `${context.id}/${context.os}`
  const requestedContexts = selection?.contexts ?? declared.map(contextName)
  for (const context of requestedContexts) {
    if (!canonical.some((row) => row.context === context)) throw new Error(`Unknown collection context ${context}`)
  }
  const selectedContexts = declared.filter((context) => requestedContexts.includes(contextName(context)))
  const census = selectedContexts.filter((context) => !deferred.has(contextName(context)))
  const pass: CollectionPass = {
    mode: freeze ? "admit" : "development",
    ...(freeze && { freeze }),
    directory,
    probeHash: snapshot.probeHash,
    sourceRevision,
    inputSha256,
    catalogIds,
    ...(selection && {
      selection: {
        contexts: selectedContexts.map(contextName),
        ...(probeIds === undefined ? {} : { ids: probeIds }),
      },
    }),
    contexts: selectedContexts
      .filter((context) => deferred.has(contextName(context)))
      .map((context) => ({
        context,
        status: "not-started",
        reason: deferred.get(contextName(context)),
      })),
    errors: [],
    complete: false,
  }
  const drafts = new Map<string, { draft: RunDraft; path: string }>()
  for (const context of census) {
    const draft = initializeRunDraft({
      source: { kind: "live" },
      runId: randomBytes(16).toString("hex"),
      sourceRevision,
      manifest: derivedSuiteManifest(snapshot),
      intendedSubject: {
        kind: context.kind,
        id: context.id,
        os: context.kind === "lib" ? process.platform : context.os,
      },
    })
    const path = join(directory, `${context.kind}-${context.id}-${context.os}.draft.json`)
    recordCollectorSelection(draft, probeIds ?? snapshot.probes[context.kind])
    if (probeIds?.length === 0) {
      recordCollectorAttempt(draft, { ids: [], result: "empty" })
      pass.contexts.push({ context, status: "not-started", rawRun: path, reason: "Explicit empty probe selection" })
    }
    writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`, { flag: "wx" })
    drafts.set(coverageKey(context.kind, context.id, context.os), { draft, path })
  }
  if (census.length === 0 || probeIds?.length === 0) {
    pass.attempt = { ids: probeIds ?? [], result: "empty" }
    writeFileSync(join(directory, "pass.json"), `${JSON.stringify(pass, null, 2)}\n`, { flag: "wx" })
    return pass
  }
  const suites = new Map([[snapshot.probeHash, derivedSuiteManifest(snapshot)]])
  const files = new Map<string, string[]>()
  const failures = new Map<string, string>()
  if (census.some((context) => context.kind === "lib")) {
    try {
      const collected = await collectHeadlessRuns(
        census.filter((context) => context.kind === "lib").map((context) => context.id),
        join(directory, "lib"),
        new Map(
          census
            .filter((context) => context.kind === "lib")
            .map((context) => {
              const handed = drafts.get(coverageKey(context.kind, context.id, context.os))
              if (!handed) throw new Error(`Missing initialized headless context ${context.id}`)
              return [context.id, handed]
            }),
        ),
        probeIds,
      )
      for (const failure of collected.failures) failures.set(failure.backend, failure.error)
      for (const path of collected.runs) {
        try {
          const file = realpathSync(path)
          if (!file.startsWith(`${directory}${sep}`)) {
            throw new Error(`collector returned raw output outside this private pass: ${file}`)
          }
          // This header only routes the file to its context; canonical parseRun validates every byte below.
          const header = JSON.parse(readFileSync(file, "utf8")) as {
            schemaVersion?: unknown
            subject?: { id?: unknown }
            target?: { id?: unknown }
          }
          // Preserve historical raw output custody before the current-contract refusal below.
          const id = header.schemaVersion === 4 ? header.subject?.id : header.target?.id
          if (typeof id !== "string" || !census.some((row) => row.kind === "lib" && row.id === id)) {
            throw new Error(`headless collector returned an unexpected target in ${file}`)
          }
          files.set(id, [...(files.get(id) ?? []), file])
        } catch (error) {
          pass.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      pass.errors.push(`headless collection: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const hosted = collectHostedArtifacts(
    census,
    directory,
    sourceRevision,
    snapshot.probeHash,
    inputSha256[join(ROOT, "bun.lock")] as string,
    pass.errors,
    drafts,
  )
  for (const context of census) {
    const row: CollectionPass["contexts"][number] = { context, status: "not-started" }
    pass.contexts.push(row)
    const handed = drafts.get(coverageKey(context.kind, context.id, context.os))
    if (!handed) throw new Error(`Context ${context.id} lost initialized draft`)
    row.rawRun = handed.path
    try {
      let path: string
      if (context.route === "linux-container") {
        const output = join(directory, "linux", context.id)
        row.directory = output
        mkdirSync(output, { recursive: true })
        runChild(
          ["bash", "scripts/linux-container-run.sh", ...linuxLiveArgs(context.kind, context.id),
            ...(probeIds === undefined ? [] : ["--ids", probeIds.join(",")]), output],
          `${labelOf(context)} Linux collection`,
          {
            stdout: join(output, "launcher.stdout.log"),
            stderr: join(output, "launcher.stderr.log"),
          },
          // The launcher's host readback (getTrustedSuiteReceipt) refuses without this pass's suite and source.
          {
            TERMINFO_CAPTURE_RUN_ID: handed.draft.runId,
            TERMINFO_PROBE_HASH: snapshot.probeHash,
            TERMINFO_SOURCE_REVISION: sourceRevision,
          },
        )
        const retained = linuxRawRun(output)
        if (!retained) throw new Error(`Linux launcher produced no raw run in ${output}`)
        path = retained
      } else if (context.route === "local-owned-app") {
        const output = join(directory, "owned-app", context.id)
        row.directory = output
        mkdirSync(output, { recursive: true })
        const command = ownedAppCommand(context, output, ownedApp, sourceRevision)
        runChild(
          command.argv,
          command.label,
          {
            stdout: join(output, "launcher.stdout.log"),
            stderr: join(output, "launcher.stderr.log"),
          },
          { TERMINFO_CAPTURE_RUN_ID: handed.draft.runId },
        )
        // One home for the transport's artifacts: the driver writes the run JSON and the receipt
        // into <output>/transport, so the collector reads them from exactly there.
        const runsDirectory = ownedAppRunsDirectory(output, ownedApp.runner)
        if (ownedApp.runner !== "local") {
          const proof = readOwnedAppTransportProof(join(runsDirectory, "transport-receipt.json"), sourceRevision)
          row.transport = proof
          pass.transport = proof
        }
        const runs = readdirSync(runsDirectory).filter(
          (entry) => entry.endsWith(".json") && entry !== "transport-receipt.json",
        )
        if (runs.length !== 1 || !runs[0]) {
          throw new Error(`owned-app probe produced ${runs.length} run JSON files in ${output}; expected exactly one`)
        }
        path = realpathSync(join(runsDirectory, runs[0]))
        if (!path.startsWith(`${output}${sep}`)) {
          throw new Error(`owned-app raw output escaped its private context: ${path}`)
        }
      } else if (context.route === "hosted-workflow") {
        const artifact = hosted.get(coverageKey(context.kind, context.id, context.os))
        if (!artifact) throw new Error("hosted dispatch lost its expected context result")
        row.directory = artifact.directory
        if (artifact.path) row.rawRun = artifact.path
        if (artifact.error) throw new Error(artifact.error)
        if (!artifact.path) throw new Error(`hosted artifact has no raw run in ${artifact.directory}`)
        path = artifact.path
      } else if (context.kind === "lib") {
        const paths = files.get(context.id) ?? []
        if (failures.has(context.id)) throw new Error(failures.get(context.id))
        if (paths.length !== 1 || !paths[0]) {
          throw new Error(`headless collector produced ${paths.length} raw runs; expected exactly one`)
        }
        path = paths[0]
      } else {
        throw new Error(
          context.route === null
            ? (context.uncollectable ?? "required route work")
            : context.kind === "mux"
              ? "required route work: launch and prove the named outer terminal and genuine mux identity"
              : `required automation work: ${context.route} dispatch is not wired yet`,
        )
      }
      row.rawRun = path
      const raw = readFileSync(path, "utf8")
      const header = JSON.parse(raw) as { schemaVersion?: unknown; sealedAt?: unknown }
      if (header.schemaVersion === 4 && header.sealedAt === undefined) {
        const decoded = decodeCollectorDraft(path, raw, derivedSuiteManifest(snapshot), sourceRevision)
        if (decoded.kind === "empty-selection") {
          row.status = "not-started"
          row.reason = "Explicit empty probe selection"
          continue
        }
        if (decoded.run.runId !== handed.draft.runId) {
          throw new Error(`Collector changed logical runId for ${labelOf(context)}`)
        }
        if (
          decoded.run.subject?.kind !== context.kind ||
          decoded.run.subject.id !== context.id ||
          (context.kind !== "lib" && decoded.run.subject.os !== context.os)
        ) {
          throw new Error(
            `raw draft does not identify the expected current schema-4 ${context.kind}:${context.id} context`,
          )
        }
        if (
          decoded.run.results.some((result) =>
            result.tests.some((check) => check.id === "review" && check.status === "test-todo"),
          ) &&
          Object.keys(decoded.run.rawReplies).some((key) => key.startsWith("collector.capture."))
        ) {
          row.status = "pending-review"
          row.reason = "Valid capture; required review pending (unsealed)"
          continue
        }
        path = saveDaemonProbeRun(
          {
            ...decoded.run,
            rawReplies: {
              ...decoded.run.rawReplies,
              "collector.httpResponseSha256": decoded.run.rawReplies["collector.httpResponseSha256"] ?? decoded.sha256,
            },
          },
          dirname(path),
        )
        if (path.endsWith(".draft.json")) {
          row.rawRun = path
          row.status = "pending-review"
          row.reason = "Valid capture; required review pending (unsealed)"
          continue
        }
        row.rawRun = path
      }
      const run = parseRun(path, readFileSync(path, "utf8"), catalogIds, suites)
      if (
        run.schemaVersion !== 4 ||
        run.subject.kind !== context.kind ||
        run.subject.id !== context.id ||
        (context.kind !== "lib" && run.subject.os !== context.os)
      ) {
        throw new Error(`raw run does not identify the expected current schema-4 ${context.kind}:${context.id} context`)
      }
      if (run.runId !== handed.draft.runId) throw new Error(`Collector changed logical runId for ${labelOf(context)}`)
      if (!run.suiteComplete) throw new Error(`raw run is incomplete for current suite ${snapshot.probeHash}`)
      if (run.sourceRevision !== sourceRevision) {
        throw new Error(`raw source ${run.sourceRevision} differs from pass source ${sourceRevision}`)
      }
      const textSnapshots = new Map<string, Uint8Array>()
      for (const ref of run.textSnapshotRefs) {
        textSnapshots.set(ref, readVerifiedArtifact(dirname(path), ref, path, "text-snapshot"))
      }
      if (!run.results || !run.catalogIds) throw new Error("Current run lacks frozen results")
      row.summary = aggregateCurrentResults(consoleHostHeldResults(run), run.catalogIds)
      row.classification = classifyDevelopmentRun(run)
      row.status = "classified"
    } catch (error) {
      row.error = `${labelOf(context)}: ${error instanceof Error ? error.message : String(error)}`
      if (context.route === "linux-container" && row.directory) {
        try {
          const actualPath = linuxRawRun(row.directory)
          if (actualPath) {
            row.rawRun = actualPath
            // Bind failure custody only; canonical report/admission still validates the original bytes.
            const actual = parseJsonStrict(actualPath, readFileSync(actualPath, "utf8")) as Partial<RunDraft> | null
            const ids = [...(probeIds ?? snapshot.probes[context.kind])]
            if (!actual || actual.schemaVersion !== 4 || actual.source?.kind !== "live" ||
              actual.runId !== handed.draft.runId || actual.sourceRevision !== sourceRevision ||
              actual.probeHash !== snapshot.probeHash || actual.suiteId !== snapshot.probeHash || !actual.rawReplies) {
              throw new Error(`Linux failure output differs from delegated identity: ${actualPath}`)
            }
            const actualSelection = readCollectorSelection(actual.rawReplies)
            const actualAttempt = readCollectorAttempt(actual.rawReplies)
            if (!actualSelection || actualSelection.ids.join("\n") !== ids.join("\n") ||
              !actualAttempt || actualAttempt.ids.join("\n") !== ids.join("\n")) {
              throw new Error(`Linux failure output differs from delegated selection/attempt: ${actualPath}`)
            }
            row.status = actualAttempt.startedAt ? "failed" : "not-started"
            continue
          }
        } catch (custodyError) {
          row.reason = `Untrusted Linux failure output: ${custodyError instanceof Error ? custodyError.message : String(custodyError)}`
        }
      }
      const retained = JSON.parse(readFileSync(handed.path, "utf8")) as RunDraft
      const previousAttempt = readCollectorAttempt(retained.rawReplies)
      const actualStart = previousAttempt?.startedAt
      const ids = [...(probeIds ?? snapshot.probes[context.kind])]
      recordCollectorAttempt(retained, {
        ...previousAttempt,
        ids,
        ...(actualStart && { startedAt: actualStart }),
        result: previousAttempt?.result === "cancelled" ? "cancelled" : "failed",
        error: previousAttempt?.error ?? row.error,
      })
      if (actualStart && previousAttempt?.result !== "cancelled") {
        recordCollectionFailure(retained, actualStart, previousAttempt?.error ?? row.error, ids)
      }
      row.status = retained.results.some((result) => result.status === "test-failure") ? "failed" : "not-started"
      if (!actualStart) {
        for (const result of retained.results) {
          if (result.status === "test-todo" && ids.includes(result.featureId)) result.reason = row.error
        }
      }
      writeFileSync(handed.path, `${JSON.stringify(retained, null, 2)}\n`)
    }
  }
  const eligible = pass.contexts.filter((row) => !deferred.has(contextName(row.context)))
  for (const [path, hash] of Object.entries(inputSha256)) {
    try {
      if (createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) {
        pass.errors.push(`Pass input changed during collection: ${path}`)
      }
    } catch (error) {
      pass.errors.push(
        `Pass input cannot be re-read: ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (
    freeze &&
    pass.errors.length === 0 &&
    eligible.length > 0 &&
    eligible.every((row) => row.status === "classified" && row.summary?.complete === true)
  ) {
    try {
      const paths = eligible.map((row) => {
        if (!row.rawRun) throw new Error(`${labelOf(row.context)}: validated context lost its raw run path`)
        return row.rawRun
      })
      admitProducedRuns(paths, freeze.id, freeze.release, (produced, destination) => {
        const key = coverageKey(produced.subject.kind, produced.subject.id, produced.subject.os)
        const row = pass.contexts.find((row) => coverageKey(row.context.kind, row.context.id, row.context.os) === key)
        if (!row) throw new Error(`Admission returned an unexpected context ${key}`)
        row.status = "admitted"
        row.admittedPath = destination
      })
    } catch (error) {
      const message = `Admission stopped: ${error instanceof Error ? error.message : String(error)}`
      pass.errors.push(message)
      for (const row of eligible) {
        if (row.status !== "admitted") {
          row.status = "failed"
          row.error = `${labelOf(row.context)}: ${message}; raw run retained privately`
        }
      }
    }
  }
  pass.complete =
    pass.contexts.length === 33 &&
    catalogIds.length === 273 &&
    pass.errors.length === 0 &&
    eligible.length > 0 &&
    eligible.every((row) => row.summary?.complete === true && (!freeze || row.status === "admitted"))
  writeFileSync(join(directory, "pass.json"), `${JSON.stringify(pass, null, 2)}\n`, { flag: "wx" })
  return pass
}

/** Resolve the assertion through the existing frozen-suite owner; never declare a suite here. */
function declaredCollectionFreeze(id: string, current: string): { id: string; release: string } {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error(`Invalid declared frozen suite id ${id}`)
  const path = join(CONTENT, "suites", `${id}.json`)
  let manifest: ReturnType<typeof parseSuiteManifest>
  try {
    manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
  } catch (cause) {
    throw new Error(`Cannot read declared frozen suite ${id} at ${path}`, { cause })
  }
  if (!manifest.freeze) throw new Error(`Suite ${id} has no declared freeze in ${path}`)
  const release = manifest.freeze.release
  const selected = frozenSuiteIdFor(CONTENT, release)
  if (selected !== id || current !== id) {
    throw new Error(
      `Declared frozen suite ${id}, registry suite ${selected} and current suite ${current} must match for ${release}`,
    )
  }
  return { id, release }
}

/** Dispatch each existing hosted matrix once and retain every job's companion artifacts. */
function collectHostedArtifacts(
  census: readonly CollectionContext[],
  directory: string,
  sourceRevision: string,
  probeHash: string,
  lockSha256: string,
  errors: string[],
  drafts: ReadonlyMap<string, { draft: RunDraft; path: string }>,
): Map<string, { directory: string; path?: string; error?: string }> {
  const results = new Map<string, { directory: string; path?: string; error?: string }>()
  const root = join(directory, "hosted")
  const logs = (directory: string, step: string) => ({
    stdout: join(directory, `${step}.stdout.log`),
    stderr: join(directory, `${step}.stderr.log`),
  })
  let branch: string
  try {
    mkdirSync(root, { recursive: true })
    branch = runChild(["git", "symbolic-ref", "--short", "HEAD"], "hosted source branch", logs(root, "branch")).trim()
    const remote = runChild(
      ["git", "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`],
      "hosted source revision",
      logs(root, "remote"),
    ).trim()
    if (!branch || remote !== `${sourceRevision}\trefs/heads/${branch}`) {
      throw new Error(
        `hosted source revision ${sourceRevision} is not the published branch ${branch}; publish that exact component branch before dispatch`,
      )
    }
  } catch (error) {
    for (const context of census.filter((row) => row.route === "hosted-workflow")) {
      results.set(coverageKey(context.kind, context.id, context.os), {
        directory: root,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return results
  }
  const dispatched: Array<{ os: string; contexts: CollectionContext[]; output: string; runId: string }> = []
  for (const os of ["macos", "windows"]) {
    const contexts = census.filter((row) => row.route === "hosted-workflow" && row.os === os)
    const output = join(root, os)
    try {
      mkdirSync(output, { recursive: true })
      const workflow = `${os}-measurement`
      const dispatchLogs = logs(output, "dispatch")
      const response =
        runChild(
          [
            "gh",
            "workflow",
            "run",
            `${workflow}.yml`,
            "--repo",
            "beorn/terminfo.dev",
            "--ref",
            branch,
            "--field",
            `capture_run_ids=${JSON.stringify(
              Object.fromEntries(
                contexts.map((context) => {
                  const initialized = drafts.get(coverageKey(context.kind, context.id, context.os))
                  if (!initialized) throw new Error(`Missing hosted context draft ${context.id}`)
                  return [context.id, initialized.draft.runId]
                }),
              ),
            )}`,
          ],
          workflow,
          dispatchLogs,
        ) + readFileSync(dispatchLogs.stderr, "utf8")
      const ids = new Set(
        [...response.matchAll(/https:\/\/github\.com\/beorn\/terminfo\.dev\/actions\/runs\/(\d+)/g)].map(
          (match) => match[1],
        ),
      )
      const runId = [...ids][0]
      if (ids.size !== 1 || !runId) {
        throw new Error(
          `${workflow}: dispatch returned no unique run URL; inspect ${dispatchLogs.stdout} before any redispatch`,
        )
      }
      const run = JSON.parse(
        runChild(
          [
            "gh",
            "run",
            "view",
            runId,
            "--repo",
            "beorn/terminfo.dev",
            "--json",
            "headSha,headBranch,event,workflowName",
          ],
          `${workflow} source verification`,
          logs(output, "verify"),
        ),
      ) as {
        headSha?: unknown
        headBranch?: unknown
        event?: unknown
        workflowName?: unknown
      }
      if (
        run?.headSha !== sourceRevision ||
        run.headBranch !== branch ||
        run.event !== "workflow_dispatch" ||
        run.workflowName !== workflow
      ) {
        throw new Error(
          `${workflow}: source revision or workflow identity differs from ${branch}@${sourceRevision}; run ${runId}`,
        )
      }
      writeFileSync(join(output, "workflow.json"), `${JSON.stringify({ runId, ...run }, null, 2)}\n`, { flag: "wx" })
      dispatched.push({ os, contexts, output, runId })
    } catch (error) {
      for (const context of contexts) {
        results.set(coverageKey(context.kind, context.id, context.os), {
          directory: output,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  // Both independent hosted platforms start before a blocking watch; local processes stay serial.
  for (const { os, contexts, output, runId } of dispatched) {
    const workflow = `${os}-measurement`
    try {
      try {
        runChild(
          ["gh", "run", "watch", runId, "--repo", "beorn/terminfo.dev", "--exit-status"],
          workflow,
          logs(output, "watch"),
        )
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
      const artifacts = join(output, "artifacts")
      mkdirSync(artifacts)
      // Download ALL artifacts, keeping the CLI's per-artifact directories even for one Windows job.
      runChild(
        ["gh", "run", "download", runId, "--repo", "beorn/terminfo.dev", "--dir", artifacts],
        `${workflow} artifacts`,
        logs(output, "download"),
      )
      const entries = readdirSync(artifacts, { withFileTypes: true })
      for (const context of contexts) {
        const result: { directory: string; path?: string; error?: string } = { directory: artifacts }
        results.set(coverageKey(context.kind, context.id, context.os), result)
        try {
          const prefix = `${os === "macos" ? "macos" : "win32"}-${context.id}-${runId}-`
          const matches = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
          if (matches.length !== 1 || !matches[0]) {
            throw new Error(`expected one ${prefix} artifact in ${artifacts}; found ${matches.length}`)
          }
          result.directory = realpathSync(join(artifacts, matches[0].name))
          if (!result.directory.startsWith(`${artifacts}${sep}`)) {
            throw new Error(`artifact escaped private directory: ${result.directory}`)
          }
          const raw = join(result.directory, "run.json")
          if (existsSync(raw)) result.path = raw
          const lock = join(result.directory, "collector-bun.lock")
          if (createHash("sha256").update(readFileSync(lock)).digest("hex") !== lockSha256) {
            throw new Error(`hosted dependency lock differs from pass lock: ${lock}`)
          }
          const receipt = JSON.parse(readFileSync(join(result.directory, "collector-build.json"), "utf8")) as {
            collectorRevision?: unknown
            probeHash?: unknown
            bundleSha256?: unknown
          }
          if (
            receipt?.collectorRevision !== sourceRevision ||
            receipt.probeHash !== probeHash ||
            typeof receipt.bundleSha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(receipt.bundleSha256) ||
            receipt.bundleSha256 !==
              createHash("sha256")
                .update(readFileSync(join(result.directory, "collector-bundle.mjs")))
                .digest("hex")
          ) {
            throw new Error(`hosted collector build differs from pass source/suite: ${result.directory}`)
          }
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error)
        }
      }
    } catch (error) {
      for (const context of contexts) {
        results.set(coverageKey(context.kind, context.id, context.os), {
          directory: output,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return results
}

/** Admission supplies the validated target; coverage needs no second raw-run parser. */
export interface ProducedRun {
  readonly runId?: string
  readonly subject: Pick<AdmissionPlan["subject"], "kind" | "id" | "os">
}

/** The owner completes admission before a produced input earns collection coverage. */
export function admitProducedRuns(
  paths: readonly string[],
  assertedSuiteId?: string,
  release = "candidate2",
  onAdmitted?: (produced: ProducedRun, destination: string) => void,
): ProducedRun[] {
  const plans = paths.map((path) =>
    planAdmission(path, undefined, {
      release,
      ...(assertedSuiteId === undefined ? {} : { frozenSuiteId: assertedSuiteId }),
    }),
  )
  const produced: ProducedRun[] = []
  for (const plan of plans) {
    admitRun(plan)
    const run = { subject: plan.subject, runId: plan.runId }
    produced.push(run)
    onAdmitted?.(run, plan.destination)
  }
  return produced
}

/**
 * The one key a census row and a produced run share. An app row is its (id, os). A headless engine
 * row is its id alone: the census cannot know the host os, and the run records the host it ran on,
 * so an id/os key matched no headless run and every engine row read uncovered (#27929 D7).
 */
const coverageKey = (kind: unknown, id: unknown, os: unknown): string =>
  kind === "lib" ? `headless:${String(id)}` : `${String(id)}/${String(os)}`

/** Contexts in the census that produced no run at all, each with its own named reason. */
export function uncoveredContexts(
  census: readonly CollectionContext[],
  producedRuns: readonly ProducedRun[],
): readonly { readonly context: CollectionContext; readonly reason: string }[] {
  const produced = new Set(producedRuns.map((run) => coverageKey(run.subject?.kind, run.subject?.id, run.subject?.os)))
  return census
    .filter((entry) => !produced.has(coverageKey(entry.kind, entry.id, entry.os)))
    .map((entry) => ({
      context: entry,
      reason:
        entry.uncollectable ??
        (entry.route === null ? "no collection route" : `no run produced by the ${entry.route} route`),
    }))
}

function planLines(census: readonly CollectionContext[]): string[] {
  const lines = census.map((entry) => {
    const state = entry.uncollectable !== null ? `UNCOLLECTABLE — ${entry.uncollectable}` : entry.command
    const pending = entry.requires === null ? "" : `\n      requires: ${entry.requires}`
    const source = entry.sourceRun === null ? "" : `\n      read from: ${entry.sourceRun}`
    return `  ${labelOf(entry)}  [${entry.route ?? "none"}]  ${state}${pending}${source}`
  })
  const uncollectable = census.filter((entry) => entry.uncollectable !== null).length
  const pending = census.filter((entry) => entry.requires !== null).length
  return [
    `Collection census — ${census.length} contexts` +
      ` (${census.filter((entry) => entry.kind === "term").length} app, ${census.filter((entry) => entry.kind === "mux").length} mux, ${census.filter((entry) => entry.kind === "lib").length} headless)`,
    `Scope: catalog app/mux platforms plus the Termless engine manifest; historical app/mux rows are excluded, and unsupported catalog kinds fail by name.`,
    `Routes are source recipes, not runtime qualification: ${uncollectable} have no qualified automatic route, ${pending} require a prerequisite.`,
    `Linux rows: the launcher flags are the live pass's own declared invocation, not a read-back from a committed run.`,
    ...lines,
  ]
}

const labelOf = (entry: CollectionContext): string =>
  entry.kind === "lib" ? `${entry.id} [headless]` : `${entry.id}/${entry.os}`

function runChild(
  argv: readonly string[],
  label: string,
  logs?: { stdout: string; stderr: string },
  environment?: Record<string, string>,
): string {
  const [command, ...rest] = argv
  if (command === undefined) throw new Error(`${label}: no command to run`)
  const stdout = logs ? openSync(logs.stdout, "wx") : undefined
  let stderr: number | undefined
  try {
    stderr = logs ? openSync(logs.stderr, "wx") : undefined
    const result = spawnSync(command, rest, {
      cwd: ROOT,
      ...(environment && { env: { ...process.env, ...environment } }),
      stdio: stdout === undefined || stderr === undefined ? "inherit" : ["ignore", stdout, stderr],
    })
    const retained = logs ? `; logs retained at ${dirname(logs.stderr)}` : ""
    if (result.error) throw new Error(`${label}: ${result.error.message}${retained}`, { cause: result.error })
    if (result.status !== 0) throw new Error(`${label} exited ${String(result.status)}${retained}`)
    return logs ? readFileSync(logs.stdout, "utf8") : ""
  } finally {
    if (stdout !== undefined) closeSync(stdout)
    if (stderr !== undefined) closeSync(stderr)
  }
}

function usage(): never {
  console.error(
    "Usage: bun run release1-collection [--plan]\n" +
      "       bun run release1-collection --collect --development --output <private-directory>\n" +
      "       bun run release1-collection --collect --admit --frozen-suite <id> [--deferrals <json-file>] --output <private-directory>\n" +
      "       [--owned-app-transport ssh:<user>@<host> [--owned-app-stage <remote-dir>]\n" +
      "        --owned-app-known-hosts <path> [--owned-app-remove-stage]]\n" +
      "       bun run release1-collection --admit [--frozen-suite <id>] <run.json>...\n" +
      "  (bare)   print the census — the default: every Release 1 context and the entry point that\n" +
      "           measures it. Read-only.\n" +
      "  --plan   the same census, named explicitly.\n" +
      "  --collect --development  collect private headless/Linux/hosted runs against the live suite.\n" +
      "           WIP: other routes remain named failures; this is not the completed full pass.\n" +
      "  --collect --admit  require the declared frozen suite; validate all contexts, plan all\n" +
      "           admissions, then place runs through the existing owner. No inclusion or publication.\n" +
      "  --deferrals  explicit frozen context/routeIssue/reason array; carried routes remain in the pass census.\n" +
      "  --contexts <JSON-array>  canonical context IDs; omitted runs all, [] starts none.\n" +
      "  --probe-ids <JSON-array>  exact probe IDs; omitted runs each context's full schedule, [] executes none.\n" +
      "  --owned-app-transport  where an owned-app row starts: local (default) or an existing ssh host.\n" +
      "           The host, stage and known-hosts file are environment configuration named here, never\n" +
      "           product content; the host's own authority is unchanged by the transport.\n" +
      "  --owned-app-stage  the persistent driver-owned remote subtree a staged run is checked out into.\n" +
      "                     Omitted, the driver uses <remote-home>/.cache/terminfo.dev/owned-app-stage.\n" +
      "  --owned-app-known-hosts  the environment-owned known-hosts file host trust is pinned against.\n" +
      "  --owned-app-remove-stage  remove the remote stage after the run; the default keeps it.\n" +
      "  --admit  admit produced runs through scripts/admit-run.ts, then report admitted coverage\n" +
      "           and print the decisive-share table. The owner reads candidate2's manifest freeze;\n" +
      "           --frozen-suite optionally asserts that id. Collection requires --collect;\n" +
      "           a bare run stays read-only.",
  )
  process.exit(2)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  let plan = false
  let admit = false
  let collect = false
  let development = false
  let outputDirectory: string | undefined
  let frozenSuite: string | undefined
  let deferralsPath: string | undefined
  let contextsInput: string | undefined
  let probeIdsInput: string | undefined
  let ownedAppRunner = "local"
  let ownedAppStage: string | undefined
  let ownedAppKnownHosts: string | undefined
  let ownedAppRemoveStage = false
  const runs: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--plan") plan = true
    else if (argv[index] === "--admit") admit = true
    else if (argv[index] === "--collect") collect = true
    else if (argv[index] === "--development") development = true
    else if (argv[index] === "--contexts") {
      contextsInput = argv[++index]
      if (contextsInput === undefined || contextsInput.startsWith("--")) usage()
    } else if (argv[index] === "--probe-ids") {
      probeIdsInput = argv[++index]
      if (probeIdsInput === undefined || probeIdsInput.startsWith("--")) usage()
    }
    else if (argv[index] === "--output") {
      outputDirectory = argv[++index]
      if (!outputDirectory || outputDirectory.startsWith("--")) usage()
    } else if (argv[index] === "--frozen-suite") {
      frozenSuite = argv[++index]
      if (frozenSuite === undefined || frozenSuite.startsWith("--")) usage()
    } else if (argv[index] === "--deferrals") {
      deferralsPath = argv[++index]
      if (!deferralsPath || deferralsPath.startsWith("--")) usage()
    } else if (argv[index] === "--owned-app-transport") {
      ownedAppRunner = argv[++index] ?? usage()
      if (ownedAppRunner.startsWith("--")) usage()
    } else if (argv[index] === "--owned-app-stage") {
      ownedAppStage = argv[++index]
      if (ownedAppStage === undefined || ownedAppStage.startsWith("--")) usage()
    } else if (argv[index] === "--owned-app-known-hosts") {
      ownedAppKnownHosts = argv[++index]
      if (ownedAppKnownHosts === undefined || ownedAppKnownHosts.startsWith("--")) usage()
    } else if (argv[index] === "--owned-app-remove-stage") {
      ownedAppRemoveStage = true
    } else {
      const value = argv[index]
      if (value === undefined) usage()
      runs.push(value)
    }
  }
  if (collect) {
    if (
      plan ||
      admit === development ||
      !outputDirectory ||
      (development && (frozenSuite || deferralsPath)) ||
      runs.length
    ) {
      usage()
    }
    try {
      const deferrals: NonNullable<NonNullable<CollectionPass["freeze"]>["deferrals"]> = []
      if (deferralsPath) {
        const values: unknown = parseJsonStrict(deferralsPath, readFileSync(deferralsPath, "utf8"))
        if (!Array.isArray(values)) throw new Error(`${deferralsPath}: expected context/routeIssue/reason array`)
        for (const value of values) {
          if (
            value === null ||
            typeof value !== "object" ||
            !("context" in value) ||
            !("routeIssue" in value) ||
            !("reason" in value) ||
            typeof value.context !== "string" ||
            typeof value.routeIssue !== "string" ||
            typeof value.reason !== "string"
          ) {
            throw new Error(`${deferralsPath}: each deferral requires context, routeIssue and reason`)
          }
          deferrals.push({ context: value.context, routeIssue: value.routeIssue, reason: value.reason })
        }
      }
      if (admit && !frozenSuite) throw new Error("--collect --admit requires --frozen-suite <declared-id>")
      if (ownedAppRunner === "local" && (ownedAppStage || ownedAppRemoveStage || ownedAppKnownHosts)) {
        throw new Error(
          "--owned-app-stage/--owned-app-known-hosts/--owned-app-remove-stage require --owned-app-transport ssh:<user>@<host>",
        )
      }
      const pass = await collectPass(
        resolve(outputDirectory),
        admit ? frozenSuite : undefined,
        {
          runner: ownedAppRunner,
          ...(ownedAppStage === undefined ? {} : { stage: ownedAppStage }),
          ...(ownedAppKnownHosts === undefined ? {} : { knownHosts: ownedAppKnownHosts }),
          ...(ownedAppRemoveStage ? { removeStage: true } : {}),
        },
        deferrals,
        contextsInput === undefined && probeIdsInput === undefined ? undefined : {
          ...(contextsInput === undefined ? {} : {
            contexts: collectorIds(parseJsonStrict("--contexts", contextsInput), "--contexts"),
          }),
          ...(probeIdsInput === undefined ? {} : {
            ids: collectorIds(parseJsonStrict("--probe-ids", probeIdsInput), "--probe-ids"),
          }),
        },
      )
      console.log(
        `${pass.mode === "admit" ? "Final collection" : "Private development"} pass: ${pass.directory}; cohort ${pass.complete ? "complete" : "incomplete"}`,
      )
      for (const row of pass.contexts) {
        console.log(
          `${labelOf(row.context)}: ${row.status}${row.reason || row.error ? ` — ${row.reason ?? row.error}` : ""}`,
        )
      }
      for (const error of pass.errors) console.error(error)
      if (
        ((!pass.selection || pass.mode === "admit") && !pass.complete && pass.attempt?.result !== "empty") ||
        pass.errors.length || pass.contexts.some((row) => row.status === "failed" || row.error)
      ) {
        process.exitCode = 1
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  } else {
    if (development || outputDirectory || deferralsPath || contextsInput !== undefined || probeIdsInput !== undefined) usage()
    if (!admit) {
      if (runs.length > 0) usage()
      plan = true
    }

    try {
      const census = release1Census(await engineBackendsFromManifest())
      if (plan) {
        for (const line of planLines(census)) console.log(line)
        if (!admit) process.exit(0)
      }
      if (!admit) process.exit(0)
      if (runs.length === 0) {
        throw new Error("--admit needs at least one produced run; nothing was admitted")
      }
      const produced = admitProducedRuns(runs, frozenSuite)
      const gaps = uncoveredContexts(census, produced)
      console.log(
        gaps.length === 0
          ? `Every one of the ${census.length} Release 1 contexts produced a run.`
          : `Contexts with no run in this pass — ${gaps.length} of ${census.length}, each named, none read as 0%:`,
      )
      for (const gap of gaps) console.log(`  ${labelOf(gap.context)}: ${gap.reason}`)
      const projection = loadCurrentResults(CONTENT).projection
      const admittedIds = new Set(produced.map((run) => run.runId))
      const admitted = Object.entries(projection.versions).flatMap(([key, versions]) =>
        versions.filter((run) => admittedIds.has(run.runId)).map((run) => ({ key, run })),
      )
      const requiredSuiteId = frozenSuite ?? admitted[0]?.run.suiteId
      if (!requiredSuiteId) {
        throw new Error(
          "No current schema-4 admitted executions; historical results cannot complete the current collection",
        )
      }
      const coverage = buildFullProjectRows({
        census: fullContextCensus(CONTENT).contexts,
        catalogIds: Object.keys(loadFeatures(CONTENT)),
        requiredSuiteId,
        candidates: admitted.map(({ key, run }) =>
          candidateFromSelected(key, run, currentStatesFor(projection, run.runId)),
        ),
        reviewed: loadDefaultContextPolicy(CONTENT),
      })
      for (const { key, run } of admitted) {
        console.log(
          `  ${key} ${run.runId}: ${currentCoverageSentence(run, run.catalogIds)}; ${run.score.supported}/${run.score.all} Supported / all`,
        )
      }
      const sources = new Set(admitted.map(({ run }) => run.sourceRevision))
      const complete =
        gaps.length === 0 &&
        coverage.contexts.length === 33 &&
        coverage.catalogRows === 273 &&
        coverage.recordedPositions === 9009 &&
        coverage.complete &&
        sources.size === 1
      console.log(`Current source: ${[...sources].join(", ") || "none"}; suite ${requiredSuiteId}`)
      console.log(
        `Current execution: ${coverage.collected}/33 contexts, ${coverage.recordedPositions}/9009 recorded positions; ${complete ? "complete: zero TEST TODO and TEST FAILURE" : "incomplete: fresh current execution or required tests remain"}`,
      )
      if (!complete) process.exitCode = 1
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
