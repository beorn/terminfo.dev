#!/usr/bin/env bun
/**
 * The ONE entry point for the Release 1 final corpus-wide re-collection (#27917): run once, on the
 * frozen probe suite, after the Thu 2026-10-08 12:00 PDT probe freeze (#27920, #27921).
 *
 * It collects nothing itself. Every row names the entry point that row IS measured with, so each
 * context keeps the one collection path it already has; a second collection path is the bug this
 * exists to prevent. What the runner adds:
 *
 *   1. the census — every Release 1 context, with a NAMED reason for any context that has no route,
 *      so a context can never be silently missing. Each Linux row's launcher invocation is READ BACK
 *      from the committed run that row re-measures (`target.version` / `target.config` /
 *      `target.permissions` in `content/probes-apps/`), the run the SITE selects via
 *      `docs/data/current-results.ts` — never a preset/profile handed to this file by hand. Kitty
 *      takes `--preset baseline|current` and would refuse the launcher's own default;
 *   2. the pre-flight — refuse unless this tree's own suite is the frozen suite;
 *   3. admission and the refusal checks — admit each produced run through `scripts/admit-run.ts` and
 *      refuse BY CONTEXT when a run is dirty, stale or unadmitted;
 *   4. the ending — `bun run decisive-share` (#27909), so the collection's result is the bar's own
 *      instrument.
 *
 * Read-only over `content/terminals.json`, `content/release-scope.json`, the committed runs, the
 * site's own selection (`docs/data/current-results.ts` + `scripts/decisive-share.ts`), probe-defs,
 * the receipt producer and `scripts/admit-run.ts`'s admission rules; no deploy.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadCurrentResults, loadDefaultContextPolicy } from "../docs/data/current-results.ts"
import { provenanceRefusal, type SelectedVersion } from "../docs/data/selected-results.ts"
import { pickContextRun, type ContextCandidate } from "./decisive-share.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const ADMIT = "scripts/admit-run.ts"
const CONTENT = join(ROOT, "content")

/** How a Release 1 context is measured. Every value names an entry point that already exists. */
export type CollectionRoute = "linux-container" | "macos-hosted" | "headless-termless"

export interface CollectionContext {
  /** The context id, as the published row is keyed by. */
  readonly id: string
  readonly os: string
  readonly kind: "app" | "headless"
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
  route: "macos-hosted",
  command:
    "gh workflow run macos-measurement.yml -f cli_version=<ver>, then bring the " +
    "macos-terminal-measurement-artifacts upload back as runs (the v2 run conversion is 27910)",
  requires: "27910 — the hosted-runner ownership receipt, without which the run is not admissible",
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

/**
 * The 11 desktop contexts the bar reads (#27909 `RELEASE_1_CONTEXTS`), plus a named Windows gap. The
 * five Linux rows carry the invocation read back from the committed run the ledger names.
 */
export function release1DesktopContexts(ledger: LinuxLedger): readonly CollectionContext[] {
  return [
    ...LINUX_TARGET_IDS.map((id) => linuxRow(id, ledger[id])),
    macRow("terminal-app"),
    macRow("iterm2"),
    macRow("ghostty"),
    macRow("alacritty"),
    {
      // kitty/darwin ships AS MEASURED (27928): no hosted kitty job exists and hosted runners open no
      // Kitty (no GPU, 27834), so it has no collection route and is named uncollectable, never a run
      // that silently never arrives (27929 D4).
      id: "kitty",
      os: "macos",
      kind: "app",
      route: null,
      command: null,
      requires: null,
      sourceRun: null,
      uncollectable: "ships as measured (27928): no hosted kitty job, and hosted runners open no Kitty (no GPU, 27834)",
    },
    {
      id: "windows-terminal",
      os: "windows",
      kind: "app",
      route: null,
      command: null,
      requires: null,
      sourceRun: null,
      uncollectable: "no owner and no hosted workflow yet (27910 / @dev/agy-other)",
    },
  ]
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
  return [...release1DesktopContexts(ledger), ...engineBackends.map(engineRow)]
}

/** The engine backend names the collector would run, from the Termless manifest. */
export async function engineBackendsFromManifest(): Promise<string[]> {
  const { manifest } = await import("@termless/core")
  const backends = manifest().backends
  return Object.keys(backends).filter((name) => backends[name]?.type !== "os")
}

const asContextCandidate = (key: string, selected: SelectedVersion): ContextCandidate => ({
  key,
  kind: String(selected.target.kind),
  terminalId: selected.target.id,
  os: selected.target.os ?? "",
  permissions: selected.target.permissions ?? null,
  runId: selected.runId,
  version: selected.target.version ?? "",
  measuredAt: selected.measuredAt,
  suiteId: selected.suiteId,
  suiteFreshness: selected.suiteFreshness,
  cells: selected.cells,
})

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
      (current.get(id) ?? []).map(({ key, selected }) => asContextCandidate(key, selected)),
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

export type RefusalKind = "dirty-tree" | "missing-provenance" | "suite-stale" | "unadmitted"

export interface RunRefusal {
  readonly kind: RefusalKind
  readonly context: string
  readonly detail: string
}

/** The run fields the refusal checks read. Loosely typed: an unknown document must REFUSE, not crash. */
export interface ProducedRun {
  readonly schemaVersion?: unknown
  readonly suiteId?: unknown
  readonly target?: { readonly kind?: unknown; readonly id?: unknown; readonly os?: unknown }
  readonly provenance?: { readonly runtime?: { readonly cleanTree?: unknown } }
}

export interface RefusalOptions {
  /** The frozen suite id, an explicit asserted input — never inferred from the tree. */
  readonly frozenSuiteId: string
  /** Whether the run has been admitted through `scripts/admit-run.ts`. */
  readonly admitted: boolean
}

const contextOf = (run: ProducedRun): string =>
  `${String(run.target?.id ?? "unknown")}/${String(run.target?.os ?? "unknown")}`

/**
 * The refusal options the `--admit` call site passes. The CLI is where admission HAPPENS, so only the
 * admission-independent gates — a dirty tree and a suite that is not the frozen one — are checked
 * before the run is handed to `scripts/admit-run.ts`; that hand-off IS the admission, so `admitted` is
 * `true` here. Passing `admitted: false` would make the classifier refuse EVERY clean frozen run as
 * `unadmitted` before `admit-run` could ever run, so the collection could admit nothing at all. A
 * caller that has not yet admitted a run passes `admitted: false` (see the classifier's own test).
 */
export const preAdmissionRefusalOptions = (frozenSuiteId: string): RefusalOptions => ({
  frozenSuiteId,
  admitted: true,
})

/**
 * The one refusal classifier. A run is refused BY NAME when it is dirty, stale or unadmitted, so a
 * row can never land on the bar from a collection that does not count. A missing clean-tree proof is
 * NOT clean: only an explicit `true` passes.
 */
export function refusalForProducedRun(run: ProducedRun, options: RefusalOptions): RunRefusal | null {
  const context = contextOf(run)
  if (run.schemaVersion !== 2) {
    return {
      kind: "unadmitted",
      context,
      detail: `not a schema-v2 run (schemaVersion ${String(run.schemaVersion)})`,
    }
  }
  // The site's OWN provenance gate, shared rather than reimplemented: only a linux app run must carry
  // a provenance block, so a headless (or macOS) run with none passes here exactly as the bar passes
  // it. A gate that demanded `cleanTree === true` refused EVERY headless run as `dirty-tree` (#27929 D6).
  const provenance = provenanceRefusal(run)
  if (provenance !== null) {
    return {
      kind: provenance === "native-provenance-missing" ? "missing-provenance" : "dirty-tree",
      context,
      detail:
        `provenance is ${provenance}; only a linux app run must carry a provenance block, and any run ` +
        `that carries one must prove provenance.runtime.cleanTree is true`,
    }
  }
  if (run.suiteId !== options.frozenSuiteId) {
    return {
      kind: "suite-stale",
      context,
      detail: `suiteId ${String(run.suiteId)} is not the frozen suite ${options.frozenSuiteId}`,
    }
  }
  if (!options.admitted) {
    return {
      kind: "unadmitted",
      context,
      detail: `not admitted through ${ADMIT}`,
    }
  }
  return null
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

/** Refuse unless this tree's own suite is the frozen suite (@chief's "a HEAD that is not the frozen suite"). */
export function assertFrozenSuite(treeSuiteId: string, frozenSuiteId: string): void {
  if (treeSuiteId !== frozenSuiteId) {
    throw new Error(
      `This tree's probe suite is ${treeSuiteId}, not the frozen suite ${frozenSuiteId}; ` +
        `commit the probe state and collect on the frozen suite, or pass the id you froze`,
    )
  }
}

function readRun(path: string): ProducedRun {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProducedRun
  } catch (cause) {
    throw new Error(`Cannot read the produced run ${path}`, { cause })
  }
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
    `Release 1 final re-collection census — ${census.length} contexts` +
      ` (${census.filter((entry) => entry.kind === "app").length} app, ${census.filter((entry) => entry.kind === "headless").length} headless)`,
    `Routes: every row names the entry point it was measured with; ${uncollectable} uncollectable, ${pending} pending a prerequisite.`,
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
      "       bun run release1-collection --admit --frozen-suite <id> <run.json>...\n" +
      "  (bare)   print the census — the default: every Release 1 context, the entry point that\n" +
      "           measures it, and the committed run each Linux row's flags were read from. Read-only.\n" +
      "  --plan   the same census, named explicitly.\n" +
      "  --admit  refuse any produced run that is dirty, stale or unadmitted, admit the rest through\n" +
      "           scripts/admit-run.ts, then print the decisive-share table. The frozen suite id is\n" +
      "           required and asserted against this tree; it is never inferred. Nothing is collected\n" +
      "           without this flag (or the per-row commands above), so a bare run never starts a\n" +
      "           multi-row collection by accident.",
  )
  process.exit(2)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  let plan = false
  let admit = false
  let frozenSuite: string | undefined
  const runs: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--plan") plan = true
    else if (argv[index] === "--admit") admit = true
    else if (argv[index] === "--frozen-suite") frozenSuite = argv[++index]
    else {
      const value = argv[index]
      if (value === undefined) usage()
      runs.push(value)
    }
  }
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
    if (frozenSuite === undefined) usage()
    if (runs.length === 0) {
      throw new Error("--admit needs at least one produced run; nothing was admitted")
    }
    const { probeHash } = await import("../packages/admin/versions.ts")
    assertFrozenSuite(probeHash(), frozenSuite)

    const produced: ProducedRun[] = []
    for (const path of runs) {
      const run = readRun(path)
      const refusal = refusalForProducedRun(run, preAdmissionRefusalOptions(frozenSuite))
      if (refusal !== null) {
        throw new Error(`Refusing ${refusal.context} (${refusal.kind}): ${refusal.detail}`)
      }
      runChild(["bun", ADMIT, "--for", path], `admit-run ${contextOf(run)}`)
      produced.push(run)
    }
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
