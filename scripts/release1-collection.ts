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
 *      so a context can never be silently missing;
 *   2. the pre-flight — refuse unless this tree's own suite is the frozen suite;
 *   3. admission and the refusal checks — admit each produced run through `scripts/admit-run.ts` and
 *      refuse BY CONTEXT when a run is dirty, stale or unadmitted;
 *   4. the ending — `bun run decisive-share` (#27909), so the collection's result is the bar's own
 *      instrument.
 *
 * Read-only over `content/terminals.json`, `content/release-scope.json`, probe-defs, the receipt
 * producer and `scripts/admit-run.ts`'s admission rules; no deploy.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const ADMIT = "scripts/admit-run.ts"

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
  /** Why the row has no route at all, named so it is reported and never dropped. */
  readonly uncollectable: string | null
}

const linuxRow = (id: string): CollectionContext => ({
  id,
  os: "linux",
  kind: "app",
  route: "linux-container",
  command: `bash scripts/linux-container-run.sh --target ${id} --clipboard-profile default <outdir>`,
  requires: null,
  uncollectable: null,
})

const macRow = (id: string): CollectionContext => ({
  id,
  os: "macos",
  kind: "app",
  route: "macos-hosted",
  command:
    "dispatch .github/workflows/macos-measurement.yml (workflow_dispatch, job measure-macos) and bring its uploaded artifacts back as runs",
  requires: "27910 — the hosted-runner ownership receipt, without which the run is not admissible",
  uncollectable: null,
})

const engineRow = (id: string): CollectionContext => ({
  id,
  os: "unknown",
  kind: "headless",
  route: "headless-termless",
  command: `bun packages/admin/src/index.ts probe termless ${id}`,
  requires: null,
  uncollectable: null,
})

/** The 11 desktop contexts the bar reads (#27909 `RELEASE_1_CONTEXTS`), plus a named Windows gap. */
export const RELEASE_1_DESKTOP_CONTEXTS: readonly CollectionContext[] = [
  linuxRow("kitty"),
  linuxRow("alacritty"),
  linuxRow("ghostty"),
  linuxRow("xterm"),
  linuxRow("wezterm"),
  macRow("terminal-app"),
  macRow("iterm2"),
  macRow("ghostty"),
  macRow("alacritty"),
  macRow("kitty"),
  {
    id: "windows-terminal",
    os: "windows",
    kind: "app",
    route: null,
    command: null,
    requires: null,
    uncollectable: "no owner and no hosted workflow yet (27910 / @dev/agy-other)",
  },
]

/**
 * The whole census. The engine list is passed in rather than hard-coded so it comes from the SAME
 * source `collectHeadlessRuns` uses (the Termless manifest) and can never drift from the collector;
 * the count is asserted here exactly as the collector asserts it.
 */
export function release1Census(engineBackends: readonly string[]): readonly CollectionContext[] {
  if (engineBackends.length !== 11) {
    throw new Error(`Expected 11 headless engines in the Termless manifest; found ${engineBackends.length}`)
  }
  return [...RELEASE_1_DESKTOP_CONTEXTS, ...engineBackends.map(engineRow)]
}

/** The engine backend names the collector would run, from the Termless manifest. */
export async function engineBackendsFromManifest(): Promise<string[]> {
  const { manifest } = await import("@termless/core")
  const backends = manifest().backends
  return Object.keys(backends).filter((name) => backends[name]?.type !== "os")
}

export type RefusalKind = "dirty-tree" | "suite-stale" | "unadmitted"

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
  const cleanTree = run.provenance?.runtime?.cleanTree
  if (cleanTree !== true) {
    return {
      kind: "dirty-tree",
      context,
      detail:
        `provenance.runtime.cleanTree is ${String(cleanTree)}, not true; a dirty-tree collection ` +
        `is refused by the site as native-provenance-dirty and can never publish`,
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

/** Contexts in the census that produced no run at all, each with its own named reason. */
export function uncoveredContexts(
  census: readonly CollectionContext[],
  producedContexts: readonly string[],
): readonly { readonly context: CollectionContext; readonly reason: string }[] {
  const produced = new Set(producedContexts)
  return census
    .filter((entry) => !produced.has(`${entry.id}/${entry.os}`))
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
    return `  ${labelOf(entry)}  [${entry.route ?? "none"}]  ${state}${pending}`
  })
  const uncollectable = census.filter((entry) => entry.uncollectable !== null).length
  const pending = census.filter((entry) => entry.requires !== null).length
  return [
    `Release 1 final re-collection census — ${census.length} contexts` +
      ` (${census.filter((entry) => entry.kind === "app").length} app, ${census.filter((entry) => entry.kind === "headless").length} headless)`,
    `Routes: every row names the entry point it was measured with; ${uncollectable} uncollectable, ${pending} pending a prerequisite.`,
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
    "Usage: bun run release1-collection --plan\n" +
      "       bun run release1-collection --admit --frozen-suite <id> <run.json>...\n" +
      "  --plan   print the census: every Release 1 context and the entry point that measures it.\n" +
      "  --admit  refuse any produced run that is dirty, stale or unadmitted, admit the rest through\n" +
      "           scripts/admit-run.ts, then print the decisive-share table. The frozen suite id is\n" +
      "           required and asserted against this tree; it is never inferred.",
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
  if (!plan && !admit) usage()

  try {
    const census = release1Census(await engineBackendsFromManifest())
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
      const refusal = refusalForProducedRun(run, { frozenSuiteId: frozenSuite, admitted: false })
      if (refusal !== null) {
        throw new Error(`Refusing ${refusal.context} (${refusal.kind}): ${refusal.detail}`)
      }
      runChild(["bun", ADMIT, "--for", path], `admit-run ${contextOf(run)}`)
      produced.push(run)
    }
    const gaps = uncoveredContexts(
      census,
      produced.map((run) => contextOf(run)),
    )
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
