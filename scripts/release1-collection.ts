#!/usr/bin/env bun
/**
 * The existing collection entry point, extended toward the full 273-capability, 33-context pass.
 * Bare/--plan prints a read-only census and historical Linux launcher recipes.
 * --collect --development invokes existing raw collectors, validates the current suite in memory,
 * and retains private classifications. WIP: headless, Linux and hosted dispatch are wired; other contexts
 * stays visible as unfinished work. No development admission, suite declaration or inclusion.
 * Supplied-run --admit retains its existing admission-owner path and decisive-share report.
 * Explicit final collection validates the declared freeze and every raw context before admission.
 * Remaining platform routes and native qualification are unfinished. No deploy.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
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
import { loadFeatures } from "@terminfo/catalog"
import { fullContextCensus, type CensusContext } from "../docs/data/full-census.ts"
import { parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import { frozenSuiteIdFor } from "../packages/admin/suite-manifest.ts"
import { assertPrivateCollectionOutput } from "../packages/admin/src/admit-collected-run.ts"
import { loadCurrentResults, loadDefaultContextPolicy } from "../docs/data/current-results.ts"
import { classifyDevelopmentRun, statesFor, type SelectedVersion } from "../docs/data/selected-results.ts"
import { activeInterpretations, parseInterpretations } from "./interpretations.ts"
import { derivedSuiteManifest, probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { collectHeadlessRuns } from "../packages/probes/collect-headless.ts"
import { admitRun, planAdmission, type AdmissionPlan } from "./admit-run.ts"
import { candidateFromSelected, pickContextRun } from "../docs/data/run-selection.ts"

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
  readonly kind: "app" | "headless" | "mux"
  readonly route: CollectionRoute | null
  /** The entry point that measures this row — the same one the row was measured with. */
  readonly command: string | null
  /** What must land before the row can produce an admissible run; null when nothing is pending. */
  readonly requires: string | null
  /** The committed run this row's entry point was read back from, with how it was resolved. */
  readonly sourceRun: string | null
  /** Why the row has no route at all, named so it is reported and never dropped. */
  readonly uncollectable: string | null
}

/** The five Linux app rows the launcher serves, in the bar's order. */
const LINUX_TARGET_IDS = ["kitty", "ghostty", "wezterm", "alacritty", "xterm"] as const

/** The clipboard profiles `scripts/linux-container-run.sh` declares, and the permissions each writes. */
export type ClipboardProfile = "default" | "allow" | "deny-read"

/**
 * flake.nix's `kitty-visual-baseline-image` is the 0.46.2 archive and `kitty-visual-current-image` the
 * official build; kitty is the only target with a preset (`--preset` for every other target must be
 * `default`), so the committed run's version is the one thing that tells the two apart.
 */
export const KITTY_BASELINE_VERSION = "0.46.2"

/** The launcher flags for one Linux row, read back from the committed run that row re-measures. */
export interface LinuxLedgerEntry {
  /** The committed run's id. */
  readonly runId: string
  /** Where in the content dir the run document was read from. */
  readonly file: string
  readonly version: string
  readonly preset: "default" | "baseline" | "current"
  readonly clipboardProfile: ClipboardProfile
  /** The probe ids the committed run measured; null when it ran the whole suite (no `--ids` flag). */
  readonly ids: readonly string[] | null
  /** Whether the site selects this run for the context, or it is the newest run the site excludes. */
  readonly selection: "site-selected" | "newest-admitted"
  /** The site's exclusion reason when it does not select the run; null when it does. */
  readonly exclusion: string | null
}

export type LinuxLedger = Readonly<Record<string, LinuxLedgerEntry>>

/** A permissions string, as the launcher writes it, mapped to the profile flag that produced it. */
export function clipboardProfileFor(permissions: string | null | undefined, where: string): ClipboardProfile {
  if (permissions === null || permissions === undefined) return "default"
  if (permissions === "clipboard: read=allow,write=allow") return "allow"
  if (permissions === "clipboard: read=deny,write=allow") return "deny-read"
  throw new Error(
    `${where}: recorded permissions ${permissions} are not one the launcher declares ` +
      `(a permissions-free run is --clipboard-profile default)`,
  )
}

/** The preset the committed run was measured with; only kitty has one, and it is never `default`. */
export function presetFor(id: string, version: string): "default" | "baseline" | "current" {
  if (id !== "kitty") return "default"
  if (version.length === 0) {
    throw new Error(`kitty: the committed run records no version, so its baseline/current preset cannot be read`)
  }
  return version === KITTY_BASELINE_VERSION ? "baseline" : "current"
}

const linuxRow = (id: string, entry: LinuxLedgerEntry | undefined): CollectionContext => {
  if (entry === undefined) {
    return {
      id,
      os: "linux",
      kind: "app",
      route: "linux-container",
      command: null,
      requires: null,
      sourceRun: null,
      uncollectable:
        `no committed run to read the launcher flags from — neither the site's selection nor ` +
        `content/probes-apps holds a ${id}/linux run, and the preset/profile/ids are never guessed`,
    }
  }
  const ids = entry.ids === null ? "" : ` --ids ${entry.ids.join(",")}`
  const exclusion = entry.exclusion === null ? "" : ` — the site excludes it: ${entry.exclusion}`
  return {
    id,
    os: "linux",
    kind: "app",
    route: "linux-container",
    command:
      `bash scripts/linux-container-run.sh --target ${id} --preset ${entry.preset} ` +
      `--clipboard-profile ${entry.clipboardProfile}${ids} <outdir>`,
    requires: null,
    sourceRun: `${entry.runId} (${entry.selection}${exclusion})`,
    uncollectable: null,
  }
}

const macRow = (id: string): CollectionContext => ({
  id,
  os: "macos",
  kind: "app",
  route: "hosted-workflow",
  // The workflow declares `on: workflow_dispatch:` with NO inputs, so a dispatch takes no -f:
  // the printed `-f cli_version=<ver>` named a flag the workflow does not accept (and the
  // "macos-terminal-measurement-artifacts" upload never existed — the matrix uploads four
  // per-app artifacts named macos-<app>-<run-id>-<attempt>, macos-measurement.yml:289).
  command:
    "gh workflow run macos-measurement.yml --repo beorn/terminfo.dev --ref <exact-source-ref>, then " +
    "gh run download <run-id> --repo beorn/terminfo.dev for the four macos-<app>-<run-id>-<attempt> artifacts",
  requires: null,
  sourceRun: null,
  uncollectable: null,
})

// The register's headless OS sentinel maps to collection's historical unknown only here.
const engineRow = (id: string): CollectionContext => ({
  id,
  os: "unknown",
  kind: "headless",
  route: "headless-termless",
  command: `bun packages/admin/src/index.ts probe termless ${id}`,
  requires: null,
  sourceRun: null,
  uncollectable: null,
})

/**
 * macOS apps the admin launches and owns on this host. kitty is the first one (15323): the launch
 * proves ownership through kitty's own exported identity plus live TTY and process descent, so the
 * pass runs the same admin entry point the local development route uses and classifies its output.
 */
const LOCAL_OWNED_MAC_APPS: ReadonlySet<string> = new Set(["kitty"])

const localOwnedAppRow = (id: string): CollectionContext => ({
  id,
  os: "macos",
  kind: "app",
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

function collectionRoutes(ledger: LinuxLedger, expected: readonly CensusContext[]): CollectionContext[] {
  const hosted = { macos: hostedAppIds("macos"), windows: hostedAppIds("windows") }
  const contexts: CollectionContext[] = []
  for (const { terminalId: id, os, kind } of expected) {
    if (kind === "headless") continue
    if (kind === "mux") {
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
    } else if (os === "linux") contexts.push(linuxRow(id, ledger[id]))
    else if (os === "macos" && hosted.macos.has(id)) contexts.push(macRow(id))
    else if (os === "macos" && LOCAL_OWNED_MAC_APPS.has(id)) contexts.push(localOwnedAppRow(id))
    else if (os === "windows" && hosted.windows.has(id)) {
      contexts.push({
        id,
        os,
        kind: "app",
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
        kind: "app",
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

/** Route the shared register after checking the collector's runtime engine resources. */
export function release1Census(engineBackends: readonly string[], ledger: LinuxLedger): readonly CollectionContext[] {
  if (engineBackends.length !== 11) {
    throw new Error(`Expected 11 headless engines in the Termless manifest; found ${engineBackends.length}`)
  }
  const census = fullContextCensus(CONTENT)
  const runtime = [...engineBackends].sort()
  if (runtime.join("\n") !== census.engines.join("\n")) {
    throw new Error(
      `Catalog/Termless engine membership differs: catalog [${census.engines.join(", ")}], runtime [${runtime.join(", ")}]`,
    )
  }
  return [...collectionRoutes(ledger, census.contexts), ...census.engines.map(engineRow)]
}

/** The engine backend names the collector would run, from the Termless manifest. */
export async function engineBackendsFromManifest(): Promise<string[]> {
  const { manifest } = await import("@termless/core")
  const backends = manifest().backends
  return Object.keys(backends).filter((name) => backends[name]?.type !== "os")
}

export interface CollectionPass {
  mode: "development" | "admit"
  freeze?: { id: string; release: string }
  directory: string
  probeHash: string
  sourceRevision: string
  inputSha256: Record<string, string>
  catalogIds: string[]
  contexts: Array<{
    context: CollectionContext
    status: "classified" | "admitted" | "failed"
    rawRun?: string
    directory?: string
    admittedPath?: string
    classification?: ReturnType<typeof classifyDevelopmentRun>
    error?: string
  }>
  errors: string[]
}

/** Collect privately against live suite bytes; only an explicit, declared freeze enables admission. */
export async function collectPass(outputDirectory: string, frozenSuiteId?: string): Promise<CollectionPass> {
  const snapshot = probeSuiteSnapshot()
  const freeze = frozenSuiteId === undefined ? undefined : declaredCollectionFreeze(frozenSuiteId, snapshot.probeHash)
  assertPrivateCollectionOutput(outputDirectory)
  mkdirSync(outputDirectory, { recursive: true })
  const output = realpathSync(outputDirectory)
  const directory = mkdtempSync(join(output, "pass-"))
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  const catalogIds = Object.keys(loadFeatures(CONTENT))
  const interpretationsPath = join(CONTENT, "interpretations.json")
  const interpretations = activeInterpretations(
    parseInterpretations(interpretationsPath, readFileSync(interpretationsPath, "utf8"), catalogIds),
  )
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
  // The live pass must not obtain its target configuration from product-selected historical runs.
  const census = release1Census(await engineBackendsFromManifest(), {}).map((context) =>
    context.route === "linux-container"
      ? {
          ...context,
          uncollectable: null,
          requires: null,
          command: `bash scripts/linux-container-run.sh --target ${context.id} --preset ${context.id === "kitty" ? "current" : "default"} --clipboard-profile default <private-output>`,
        }
      : context,
  )
  const pass: CollectionPass = {
    mode: freeze ? "admit" : "development",
    ...(freeze && { freeze }),
    directory,
    probeHash: snapshot.probeHash,
    sourceRevision,
    inputSha256,
    catalogIds,
    contexts: [],
    errors: [],
  }
  const suites = new Map([[snapshot.probeHash, derivedSuiteManifest(snapshot)]])
  const files = new Map<string, string[]>()
  const failures = new Map<string, string>()
  try {
    const collected = await collectHeadlessRuns([], join(directory, "headless"))
    for (const failure of collected.failures) failures.set(failure.backend, failure.error)
    for (const path of collected.runs) {
      try {
        const file = realpathSync(path)
        if (!file.startsWith(`${directory}${sep}`)) {
          throw new Error(`collector returned raw output outside this private pass: ${file}`)
        }
        // This header only routes the file to its context; canonical parseRun validates every byte below.
        const header = JSON.parse(readFileSync(file, "utf8")) as { target?: { id?: unknown } }
        const id = header?.target?.id
        if (typeof id !== "string" || !census.some((row) => row.kind === "headless" && row.id === id)) {
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
  const hosted = collectHostedArtifacts(
    census,
    directory,
    sourceRevision,
    snapshot.probeHash,
    inputSha256[join(ROOT, "bun.lock")] as string,
    pass.errors,
  )
  for (const context of census) {
    const row: CollectionPass["contexts"][number] = { context, status: "failed" }
    pass.contexts.push(row)
    try {
      let path: string
      if (context.route === "linux-container") {
        const output = join(directory, "linux", context.id)
        row.directory = output
        mkdirSync(output, { recursive: true })
        runChild(
          [
            "bash",
            "scripts/linux-container-run.sh",
            "--target",
            context.id,
            "--preset",
            context.id === "kitty" ? "current" : "default",
            "--clipboard-profile",
            "default",
            output,
          ],
          `${labelOf(context)} Linux collection`,
          {
            stdout: join(output, "launcher.stdout.log"),
            stderr: join(output, "launcher.stderr.log"),
          },
        )
        const runs = readdirSync(output, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        if (runs.length !== 1 || !runs[0]) {
          throw new Error(`Linux launcher produced ${runs.length} run directories in ${output}; expected exactly one`)
        }
        path = realpathSync(join(output, runs[0].name, "raw", "v2-run.json"))
        if (!path.startsWith(`${output}${sep}`)) {
          throw new Error(`Linux raw output escaped its private context: ${path}`)
        }
      } else if (context.route === "local-owned-app") {
        const output = join(directory, "owned-app", context.id)
        row.directory = output
        mkdirSync(output, { recursive: true })
        runChild(
          ["bun", "packages/admin/src/index.ts", "probe", "app", context.id, "--output", output],
          `${labelOf(context)} owned-app collection`,
          {
            stdout: join(output, "launcher.stdout.log"),
            stderr: join(output, "launcher.stderr.log"),
          },
        )
        const runs = readdirSync(output).filter((entry) => entry.endsWith(".json"))
        if (runs.length !== 1 || !runs[0]) {
          throw new Error(`owned-app probe produced ${runs.length} run JSON files in ${output}; expected exactly one`)
        }
        path = realpathSync(join(output, runs[0]))
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
      } else if (context.kind === "headless") {
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
      const run = parseRun(path, readFileSync(path, "utf8"), catalogIds, suites)
      if (
        run.schemaVersion !== 2 ||
        run.target.kind !== context.kind ||
        run.target.id !== context.id ||
        (context.kind !== "headless" && run.target.os !== context.os)
      ) {
        throw new Error(`raw run does not identify the expected v2 ${context.kind}:${context.id} context`)
      }
      if (!run.suiteComplete) throw new Error(`raw run is incomplete for current suite ${snapshot.probeHash}`)
      if (run.sourceRevision !== sourceRevision) {
        throw new Error(`raw source ${run.sourceRevision} differs from pass source ${sourceRevision}`)
      }
      row.classification = classifyDevelopmentRun(run, interpretations)
      row.status = "classified"
    } catch (error) {
      row.error = `${labelOf(context)}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
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
  if (freeze && pass.errors.length === 0 && pass.contexts.every((row) => row.status === "classified")) {
    try {
      const paths = pass.contexts.map((row) => {
        if (!row.rawRun) throw new Error(`${labelOf(row.context)}: validated context lost its raw run path`)
        return row.rawRun
      })
      admitProducedRuns(paths, freeze.id, freeze.release, (produced, destination) => {
        const key = coverageKey(produced.target.kind, produced.target.id, produced.target.os)
        const row = pass.contexts.find((row) => coverageKey(row.context.kind, row.context.id, row.context.os) === key)
        if (!row) throw new Error(`Admission returned an unexpected context ${key}`)
        row.status = "admitted"
        row.admittedPath = destination
      })
    } catch (error) {
      const message = `Admission stopped: ${error instanceof Error ? error.message : String(error)}`
      pass.errors.push(message)
      for (const row of pass.contexts) {
        if (row.status !== "admitted") {
          row.status = "failed"
          row.error = `${labelOf(row.context)}: ${message}; raw run retained privately`
        }
      }
    }
  }
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
          ["gh", "workflow", "run", `${workflow}.yml`, "--repo", "beorn/terminfo.dev", "--ref", branch],
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

/** The newest admitted Linux app run for a context the site does not currently select. */
function newestAdmittedLinuxRun(
  history: Readonly<Record<string, readonly SelectedVersion[]>>,
  id: string,
): SelectedVersion | undefined {
  let newest: SelectedVersion | undefined
  for (const list of Object.values(history)) {
    for (const selected of list) {
      if (selected.target.kind !== "app" || selected.target.os !== "linux" || selected.target.id !== id) continue
      if (selected.suiteId === "legacy") continue
      if (
        newest === undefined ||
        selected.measuredAt > newest.measuredAt ||
        (selected.measuredAt === newest.measuredAt && selected.runId > newest.runId)
      ) {
        newest = selected
      }
    }
  }
  return newest
}

/**
 * Read one row's launcher flags back from the committed run document itself — `target.version`,
 * `target.config` and `target.permissions` — never from a value typed into this file. Every field
 * that is unexpected throws and names the file: a run the reader cannot read is never "default".
 */
function linuxLedgerEntry(
  contentDir: string,
  id: string,
  runId: string,
  selection: "site-selected" | "newest-admitted",
  exclusion: string | null,
): LinuxLedgerEntry {
  const dir = join(contentDir, "probes-apps")
  const files = readdirSync(dir).filter((name) => name.endsWith(`-${runId}.json`))
  if (files.length !== 1) {
    throw new Error(
      `${id}/linux: expected exactly one committed run ending -${runId}.json in ${dir}; found ${files.length}`,
    )
  }
  const file = `probes-apps/${files[0]}`
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(contentDir, file), "utf8"))
  } catch (cause) {
    throw new Error(`${id}/linux: cannot read the committed run ${file}`, { cause })
  }
  const document = (parsed ?? {}) as Record<string, unknown>
  const target = document.target
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(`${id}/linux ${file}: no target object; the launcher flags cannot be read`)
  }
  const fields = target as Record<string, unknown>
  if (fields.id !== id || fields.os !== "linux" || fields.kind !== "app") {
    throw new Error(
      `${id}/linux ${file}: target is ${String(fields.kind)} ${String(fields.id)}/${String(fields.os)}, ` +
        `not the app row this census is reading`,
    )
  }
  const version = typeof fields.version === "string" ? fields.version : ""
  const permissions = fields.permissions
  if (permissions !== null && permissions !== undefined && typeof permissions !== "string") {
    throw new Error(`${id}/linux ${file}: target.permissions is not a string or null`)
  }
  const config = typeof fields.config === "string" ? fields.config : ""
  const preset = presetFor(id, version)
  const clipboardProfile = clipboardProfileFor(permissions, `${id}/linux ${file}`)
  if (id === "kitty" && config.includes("clipboard_control=") !== (clipboardProfile !== "default")) {
    throw new Error(`${id}/linux ${file}: target.config and target.permissions disagree about the clipboard profile`)
  }
  const ids = Array.isArray(document.selectedIDs) ? document.selectedIDs.map((value) => String(value)) : null
  return { runId, file, version, preset, clipboardProfile, ids, selection, exclusion }
}

/**
 * The lines the census prints for a Linux row, read from the committed run that row re-measures. The
 * run is the one the SITE selects for the (terminal id, os) context, by `decisive-share.ts`'s own
 * `pickContextRun` — the selection is not re-implemented here — including the reviewed
 * `default-contexts.json` row that breaks a multi-current tie (xterm/linux carries one entry per
 * frozen-runner store path). When the site selects none (alacritty and wezterm linux are excluded on
 * identity/provenance today), the row falls back to the newest admitted run for that context and
 * NAMES the exclusion, because those are exactly the rows this re-collection exists to bring back; a
 * context with no committed run at all is left for the census to report as uncollectable, named.
 */
export function linuxLedger(contentDir: string): LinuxLedger {
  const projection = loadCurrentResults(contentDir).projection
  const reviewed = loadDefaultContextPolicy(contentDir)
  const exclusions = new Map(projection.exclusions.map((entry) => [entry.runId, entry.reason]))
  const current = new Map<string, Array<{ key: string; selected: SelectedVersion }>>()
  for (const [key, selected] of Object.entries(projection.current)) {
    if (selected.target.kind !== "app" || selected.target.os !== "linux") continue
    const list = current.get(selected.target.id) ?? []
    list.push({ key, selected })
    current.set(selected.target.id, list)
  }
  const ledger: Record<string, LinuxLedgerEntry> = {}
  for (const id of LINUX_TARGET_IDS) {
    const picked = pickContextRun(
      (current.get(id) ?? []).map(({ key, selected }) =>
        candidateFromSelected(key, selected, statesFor(projection, selected.runId)),
      ),
      reviewed[`app:${id}`],
    )
    if (picked !== undefined && "ambiguous" in picked) {
      throw new Error(
        `${id}/linux: the site selects more than one run for the context (${picked.ambiguous.join(", ")}); ` +
          `refusing to guess which run this row re-measures`,
      )
    }
    const fallback = picked === undefined ? newestAdmittedLinuxRun(projection.history, id) : undefined
    if (picked === undefined && fallback === undefined) continue
    const runId = picked === undefined ? (fallback as SelectedVersion).runId : picked.run.runId
    ledger[id] = linuxLedgerEntry(
      contentDir,
      id,
      runId,
      picked === undefined ? "newest-admitted" : "site-selected",
      exclusions.get(runId) ?? null,
    )
  }
  return ledger
}

/** Admission supplies the validated target; coverage needs no second raw-run parser. */
export interface ProducedRun {
  readonly target: Pick<AdmissionPlan["target"], "kind" | "id" | "os">
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
    const run = { target: plan.target }
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
  kind === "headless" ? `headless:${String(id)}` : `${String(id)}/${String(os)}`

/** Contexts in the census that produced no run at all, each with its own named reason. */
export function uncoveredContexts(
  census: readonly CollectionContext[],
  producedRuns: readonly ProducedRun[],
): readonly { readonly context: CollectionContext; readonly reason: string }[] {
  const produced = new Set(producedRuns.map((run) => coverageKey(run.target?.kind, run.target?.id, run.target?.os)))
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
      ` (${census.filter((entry) => entry.kind === "app").length} app, ${census.filter((entry) => entry.kind === "mux").length} mux, ${census.filter((entry) => entry.kind === "headless").length} headless)`,
    `Scope: catalog app/mux platforms plus the Termless engine manifest; historical app/mux rows are excluded, and unsupported catalog kinds fail by name.`,
    `Routes are source recipes, not runtime qualification: ${uncollectable} have no qualified automatic route, ${pending} require a prerequisite.`,
    `Linux rows: preset, clipboard profile and ids are read back from the committed run named under each row.`,
    ...lines,
  ]
}

const labelOf = (entry: CollectionContext): string =>
  entry.kind === "headless" ? `${entry.id} [headless]` : `${entry.id}/${entry.os}`

function runChild(argv: readonly string[], label: string, logs?: { stdout: string; stderr: string }): string {
  const [command, ...rest] = argv
  if (command === undefined) throw new Error(`${label}: no command to run`)
  const stdout = logs ? openSync(logs.stdout, "wx") : undefined
  let stderr: number | undefined
  try {
    stderr = logs ? openSync(logs.stderr, "wx") : undefined
    const result = spawnSync(command, rest, {
      cwd: ROOT,
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
      "       bun run release1-collection --collect --admit --frozen-suite <id> --output <private-directory>\n" +
      "       bun run release1-collection --admit [--frozen-suite <id>] <run.json>...\n" +
      "  (bare)   print the census — the default: every Release 1 context, the entry point that\n" +
      "           measures it, and the committed run each Linux row's flags were read from. Read-only.\n" +
      "  --plan   the same census, named explicitly.\n" +
      "  --collect --development  collect private headless/Linux/hosted runs against the live suite.\n" +
      "           WIP: other routes remain named failures; this is not the completed full pass.\n" +
      "  --collect --admit  require the declared frozen suite; validate all contexts, plan all\n" +
      "           admissions, then place runs through the existing owner. No inclusion or publication.\n" +
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
  const runs: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--plan") plan = true
    else if (argv[index] === "--admit") admit = true
    else if (argv[index] === "--collect") collect = true
    else if (argv[index] === "--development") development = true
    else if (argv[index] === "--output") {
      outputDirectory = argv[++index]
      if (!outputDirectory || outputDirectory.startsWith("--")) usage()
    } else if (argv[index] === "--frozen-suite") {
      frozenSuite = argv[++index]
      if (frozenSuite === undefined || frozenSuite.startsWith("--")) usage()
    } else {
      const value = argv[index]
      if (value === undefined) usage()
      runs.push(value)
    }
  }
  if (collect) {
    if (plan || admit === development || !outputDirectory || (development && frozenSuite) || runs.length) usage()
    try {
      if (admit && !frozenSuite) throw new Error("--collect --admit requires --frozen-suite <declared-id>")
      const pass = await collectPass(resolve(outputDirectory), admit ? frozenSuite : undefined)
      console.log(`${pass.mode === "admit" ? "Final collection" : "Private development"} pass: ${pass.directory}`)
      for (const row of pass.contexts) {
        console.log(`${labelOf(row.context)}: ${row.status}${row.error ? ` — ${row.error}` : ""}`)
      }
      for (const error of pass.errors) console.error(error)
      if (pass.errors.length || pass.contexts.some((row) => row.status === "failed")) process.exitCode = 1
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  } else {
    if (development || outputDirectory) usage()
    if (!admit) {
      if (runs.length > 0) usage()
      plan = true
    }

    try {
      const census = release1Census(await engineBackendsFromManifest(), linuxLedger(CONTENT))
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
      runChild(["bun", "run", "decisive-share"], "decisive-share")
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
