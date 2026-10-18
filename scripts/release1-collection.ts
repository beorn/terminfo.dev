#!/usr/bin/env bun
/**
 * The existing collection entry point, extended toward the full 273-capability, 33-context pass.
 * Bare/--plan prints a read-only census and historical Linux launcher recipes.
 * --collect --development invokes existing raw collectors, validates the current suite in memory,
 * and retains private classifications. WIP: only headless dispatch is wired; every other context
 * stays visible as unfinished work. No development admission, suite declaration or inclusion.
 * Supplied-run --admit retains its existing admission-owner path and decisive-share report.
 * Full platform dispatch and the frozen final collection mode remain unfinished. No deploy.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { loadFeatures, loadTerminals } from "@terminfo/catalog"
import { parseRun } from "@terminfo/run-parser"
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
export type CollectionRoute = "linux-container" | "hosted-workflow" | "headless-termless" | "mux"

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

/** The catalog owns expected app/mux contexts; missing routes remain required work, never a scope cut. */
function catalogContexts(ledger: LinuxLedger): CollectionContext[] {
  const hosted = { macos: hostedAppIds("macos"), windows: hostedAppIds("windows") }
  const contexts: CollectionContext[] = []
  for (const [id, terminal] of Object.entries(loadTerminals(CONTENT))) {
    if (terminal.historical || (terminal.kind !== "app" && terminal.kind !== "mux")) continue
    if (!terminal.platforms?.length) throw new Error(`${CONTENT}/terminals.json: ${id} requires app/mux platforms`)
    for (const os of terminal.platforms) {
      if (terminal.kind === "mux") {
        contexts.push({
          id,
          os,
          kind: "mux",
          route: "mux",
          command: `bun packages/admin/src/index.ts probe mux ${id}`,
          requires: "qualify the named outer terminal, genuine mux identity and private unadmitted output on this host",
          sourceRun: null,
          uncollectable: null,
        })
      } else if (os === "linux") contexts.push(linuxRow(id, ledger[id]))
      else if (os === "macos" && hosted.macos.has(id)) contexts.push(macRow(id))
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
  }
  return contexts
}

/**
 * The whole census. The engine list is passed in rather than hard-coded so it comes from the SAME
 * source `collectHeadlessRuns` uses (the Termless manifest) and can never drift from the collector;
 * the count is asserted here exactly as the collector asserts it.
 */
export function release1Census(engineBackends: readonly string[], ledger: LinuxLedger): readonly CollectionContext[] {
  if (engineBackends.length !== 11) {
    throw new Error(`Expected 11 headless engines in the Termless manifest; found ${engineBackends.length}`)
  }
  return [...catalogContexts(ledger), ...engineBackends.map(engineRow)]
}

/** The engine backend names the collector would run, from the Termless manifest. */
export async function engineBackendsFromManifest(): Promise<string[]> {
  const { manifest } = await import("@termless/core")
  const backends = manifest().backends
  return Object.keys(backends).filter((name) => backends[name]?.type !== "os")
}

export interface DevelopmentCollection {
  mode: "development"
  directory: string
  probeHash: string
  sourceRevision: string
  inputSha256: Record<string, string>
  catalogIds: string[]
  contexts: Array<{
    context: CollectionContext
    status: "classified" | "failed"
    rawRun?: string
    classification?: ReturnType<typeof classifyDevelopmentRun>
    error?: string
  }>
  errors: string[]
}

/** Private collection uses live suite bytes only; it never enters admission or product selection. */
export async function collectDevelopmentPass(outputDirectory: string): Promise<DevelopmentCollection> {
  mkdirSync(outputDirectory, { recursive: true })
  const output = realpathSync(outputDirectory)
  if (output === ROOT || output.startsWith(`${ROOT}${sep}`)) {
    throw new Error(`Development output must be private, outside the source repository: ${output}`)
  }
  const directory = mkdtempSync(join(output, "pass-"))
  const snapshot = probeSuiteSnapshot()
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
    join(ROOT, "scripts/interpretations.ts"),
    join(ROOT, "docs/data/selected-results.ts"),
    join(ROOT, "docs/data/release-scope.ts"),
    resolve(ROOT, "../../bun.lock"),
    resolve(ROOT, "../../flake.lock"),
  ])) {
    inputSha256[path] = createHash("sha256").update(readFileSync(path)).digest("hex")
  }
  // The live pass must not obtain its target configuration from product-selected historical runs.
  const census = release1Census(await engineBackendsFromManifest(), {}).map((context) =>
    context.route === "linux-container"
      ? {
          ...context,
          uncollectable: null,
          requires: "wire the existing full-suite launcher with explicit version/config pins",
        }
      : context,
  )
  const pass: DevelopmentCollection = {
    mode: "development",
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
  for (const context of census) {
    const row: DevelopmentCollection["contexts"][number] = { context, status: "failed" }
    pass.contexts.push(row)
    try {
      if (context.kind !== "headless") {
        throw new Error(
          context.route === null
            ? (context.uncollectable ?? "required route work")
            : context.kind === "mux"
              ? "required route work: separate private raw mux output from automatic admission"
              : `required automation work: ${context.route} dispatch is not wired yet`,
        )
      }
      const paths = files.get(context.id) ?? []
      if (failures.has(context.id)) throw new Error(failures.get(context.id))
      if (paths.length !== 1) {
        throw new Error(`headless collector produced ${paths.length} raw runs; expected exactly one`)
      }
      const path = paths[0]
      if (!path) throw new Error("headless collector lost its raw run path")
      row.rawRun = path
      const run = parseRun(path, readFileSync(path, "utf8"), catalogIds, suites)
      if (run.schemaVersion !== 2 || run.target.kind !== context.kind || run.target.id !== context.id) {
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
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) {
      pass.errors.push(`Pass input changed during collection: ${path}`)
    }
  }
  writeFileSync(join(directory, "pass.json"), `${JSON.stringify(pass, null, 2)}\n`, { flag: "wx" })
  return pass
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
export function admitProducedRuns(paths: readonly string[], assertedSuiteId?: string): ProducedRun[] {
  const produced: ProducedRun[] = []
  for (const path of paths) {
    const plan = planAdmission(path, undefined, {
      release: "candidate2",
      ...(assertedSuiteId === undefined ? {} : { frozenSuiteId: assertedSuiteId }),
    })
    admitRun(plan)
    produced.push({ target: plan.target })
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
    `Scope: catalog app/mux platforms plus the Termless engine manifest; historical and other catalog kinds are excluded from the app/mux projection.`,
    `Routes are source recipes, not runtime qualification: ${uncollectable} have no qualified automatic route, ${pending} require a prerequisite.`,
    `Linux rows: preset, clipboard profile and ids are read back from the committed run named under each row.`,
    ...lines,
  ]
}

const labelOf = (entry: CollectionContext): string =>
  entry.kind === "headless" ? `${entry.id} [headless]` : `${entry.id}/${entry.os}`

function runChild(argv: readonly string[], label: string): void {
  const [command, ...rest] = argv
  if (command === undefined) throw new Error(`${label}: no command to run`)
  const result = spawnSync(command, rest, { cwd: ROOT, stdio: "inherit" })
  if (result.error) throw new Error(`${label}: ${result.error.message}`, { cause: result.error })
  if (result.status !== 0) throw new Error(`${label} exited ${String(result.status)}`)
}

function usage(): never {
  console.error(
    "Usage: bun run release1-collection [--plan]\n" +
      "       bun run release1-collection --collect --development --output <private-directory>\n" +
      "       bun run release1-collection --admit [--frozen-suite <id>] <run.json>...\n" +
      "  (bare)   print the census — the default: every Release 1 context, the entry point that\n" +
      "           measures it, and the committed run each Linux row's flags were read from. Read-only.\n" +
      "  --plan   the same census, named explicitly.\n" +
      "  --collect --development  collect private headless runs and classify against the live suite.\n" +
      "           WIP: other routes remain named failures; this is not the completed full pass.\n" +
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
    if (plan || admit || !development || !outputDirectory || frozenSuite || runs.length) usage()
    try {
      const pass = await collectDevelopmentPass(resolve(outputDirectory))
      console.log(`Private development pass: ${pass.directory}`)
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
