#!/usr/bin/env bun
/**
 * Release 1 decisive-count reader (#27909) — the instrument behind the Release 1 bar.
 *
 * Read-only. Two sections:
 *
 *  1. BAR ROWS — one per Release 1 desktop context (terminal id + os, from the 15323 § Release 1
 *     plan: Linux kitty/ghostty/wezterm/alacritty/xterm, macOS terminal-app/iterm2/ghostty/alacritty/
 *     kitty, Windows Terminal). Each row resolves the run the SITE selects for that context, by
 *     reusing docs/data/current-results.ts — there is no second selection here. When several contexts
 *     are current for one (terminal id, os) the reviewed `content/default-contexts.json` row decides,
 *     the same policy `compatibilityTargets` applies; the row it used is printed. It prints the run
 *     id, the decisive count and share over the declared 62 tier-1 rows AND over the ratified 52, the
 *     inconclusive share ON THE RATIFIED 52, the remainder rows by name, each row's selected suite id,
 *     and the bar verdict on BOTH clauses over the 52 (the declared 62 prints only as a labelled
 *     context line, never as the verdict). A context with no selected run
 *     prints "not measured — no selected run", a real tie with no reviewed row prints "ambiguous"
 *     naming the contexts, and neither is ever 0%.
 *  2. ADMITTED RUNS — one line per admitted schema-v2 run under content/probes-apps, labelled
 *     `<terminal id> <version> <os> <runId>` with decisive/62 and decisive/52, so the Release 1 Linux
 *     runs and any admitted-but-unselected run stay visible by run id without polluting the bar rows.
 *
 * It never touches content/terminals.json, collectors/probe-defs, the launcher, or any admitted run
 * document. It writes nothing. Bucket math is barOverMeasured's, not a second copy.
 *
 * Usage: bun scripts/decisive-share.ts [terminal-id ...]
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsonStrict } from "@terminfo/run-parser"
import {
  loadCurrentResults,
  loadDefaultContextPolicy,
  type DefaultContextReview,
} from "../docs/data/current-results.ts"
import { loadReleaseScope } from "../docs/data/load-release-scope.ts"
import { barOverMeasured } from "../docs/data/release-scope.ts"
import type { SelectedVersion } from "../docs/data/selected-results.ts"

/** The Release 1 bar, quoted from the plan: >=95% decisive, <=1% inconclusive on the tier-1 rows. */
export const RELEASE_BAR = { decisivePct: 95, inconclusivePct: 1 } as const

/**
 * The ratified tier-1 52 = the declared 62 minus the ten F2 movers (silent-consumed / fixture-gated
 * osc rows) named in the 27832 audit § "F2 mover list". There is no machine-readable mover list yet;
 * this is the audited list, hard-coded, and the 62-vs-52 disagreement is a separate ruling.
 */
export const F2_MOVERS = [
  "extensions.osc777-notify",
  "extensions.osc666-termprop",
  "extensions.osc3008-context",
  "extensions.osc440-audio",
  "extensions.osc555-flash",
  "extensions.osc176-app-id",
  "extensions.osc22-pointer",
  "extensions.osc52-clipboard",
  "extensions.osc52-read",
  "extensions.osc52-write",
] as const

export const RATIFIED_TIER1_COUNT = 52

/** The eleven Release 1 desktop contexts (15323 § Release 1; children 27834 Mac, 27835 Linux+Windows). */
export const RELEASE_1_CONTEXTS = [
  { terminalId: "kitty", os: "linux" },
  { terminalId: "ghostty", os: "linux" },
  { terminalId: "wezterm", os: "linux" },
  { terminalId: "alacritty", os: "linux" },
  { terminalId: "xterm", os: "linux" },
  { terminalId: "terminal-app", os: "macos" },
  { terminalId: "iterm2", os: "macos" },
  { terminalId: "ghostty", os: "macos" },
  { terminalId: "alacritty", os: "macos" },
  { terminalId: "kitty", os: "macos" },
  { terminalId: "windows-terminal", os: "windows" },
] as const

export interface ReleaseContext {
  terminalId: string
  os: string
}

/** A row that is neither decisive nor inconclusive: a present-but-error cell, or no cell at all. */
export interface RemainderRow {
  featureId: string
  bucket: "error" | "untested"
}

export interface DecisiveShare {
  denominator: number
  decisive: number
  decisivePct: number
  inconclusive: number
  inconclusivePct: number
  remainder: RemainderRow[]
  pass: boolean
}

/** Minimal cell view barOverMeasured consumes; SelectedCell satisfies it structurally. */
export type ShareCells = Record<string, { outcome: string; conclusive?: boolean }>

function sharePct(count: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((count / denominator) * 100)
}

/**
 * Reduce one cell map to the three buckets over the given tier-1 ids. Counts come from
 * barOverMeasured; the remainder names are a filter of the same cells, cross-checked against the
 * bar's own error+untested totals so the two can never drift apart silently.
 */
export function decisiveShare(cells: ShareCells, measuredIds: readonly string[]): DecisiveShare {
  const bar = barOverMeasured(cells, measuredIds)
  const remainder: RemainderRow[] = []
  for (const id of measuredIds) {
    const cell = cells[id]
    if (!cell) remainder.push({ featureId: id, bucket: "untested" })
    else if (cell.outcome === "error") remainder.push({ featureId: id, bucket: "error" })
  }
  if (remainder.length !== bar.errors + bar.untested) {
    throw new Error(
      `decisive-share remainder ${remainder.length} disagrees with barOverMeasured errors+untested ` +
        `${bar.errors + bar.untested} over ${measuredIds.length} rows`,
    )
  }
  const decisivePct = sharePct(bar.conclusive, bar.denominator)
  const inconclusivePct = sharePct(bar.inconclusive, bar.denominator)
  return {
    denominator: bar.denominator,
    decisive: bar.conclusive,
    decisivePct,
    inconclusive: bar.inconclusive,
    inconclusivePct,
    remainder,
    pass: decisivePct >= RELEASE_BAR.decisivePct && inconclusivePct <= RELEASE_BAR.inconclusivePct,
  }
}

/** The declared 62 tier-1 ids, validated against the feature catalog by the declaration's owner. */
export function tierOneIds(contentDir: string): string[] {
  const featuresPath = join(contentDir, "features.json")
  const raw = parseJsonStrict(featuresPath, readFileSync(featuresPath, "utf8"))
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${featuresPath}: expected a feature catalog object`)
  }
  const catalog: Record<string, { name: string }> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id.startsWith("$")) continue
    const declared = typeof value === "object" && value !== null ? (value as { name?: unknown }).name : value
    catalog[id] = { name: typeof declared === "string" && declared ? declared : id }
  }
  return loadReleaseScope({ catalog, declarationPath: join(contentDir, "release-scope.json") }).measuredIds
}

/** The ratified 52: the 62 minus the F2 movers, refusing loudly if the audited list no longer fits. */
export function ratifiedTierOneIds(declaredIds: readonly string[]): string[] {
  const declared = new Set(declaredIds)
  const missing = F2_MOVERS.filter((id) => !declared.has(id))
  if (missing.length) {
    throw new Error(`F2 movers (27832) are not all in the declared tier-1 set: ${missing.join(", ")}`)
  }
  const movers = new Set<string>(F2_MOVERS)
  const ratified = declaredIds.filter((id) => !movers.has(id))
  if (ratified.length !== RATIFIED_TIER1_COUNT) {
    throw new Error(`ratified tier-1 set is ${ratified.length}, expected ${RATIFIED_TIER1_COUNT}`)
  }
  return ratified
}

/** One candidate context the site currently selects, reduced to what the reader consumes. */
export interface ContextCandidate {
  key: string
  kind: string
  terminalId: string
  os: string
  permissions: string | null
  runId: string
  version: string
  measuredAt: string
  suiteId: string
  suiteFreshness: string
  cells: ShareCells
}

export interface ContextShares {
  tier62: DecisiveShare
  tier52: DecisiveShare
}

export interface MeasuredRow {
  context: ReleaseContext
  measured: true
  run: ContextCandidate
  selection: RunSelection
  shares: ContextShares
}

export interface NotMeasuredRow {
  context: ReleaseContext
  measured: false
  reason: string
}

export type BarRow = MeasuredRow | NotMeasuredRow

/** How the one run for a context was chosen, printed with the row so the choice is auditable. */
export type RunSelection = "only current" | "reviewed default-context row" | "default profile"

export type PickedContextRun = { run: ContextCandidate; selection: RunSelection } | { ambiguous: string[] }

/**
 * Choose the one run the site selects for a (terminal id, os) context. The site's own selection keys by
 * terminal id, not by id+os, so a context can carry several current entries: kitty/linux has the
 * default and two clipboard-override profiles, and xterm/linux carries one entry per frozen-runner
 * store path. The site resolves such a tie by the reviewed `default-contexts.json` row
 * (`compatibilityTargets`), and so does this reader.
 *
 * The bar keys rows by terminal id + os while the review is keyed by terminal id alone, so a review
 * is a tie-break ONLY for the group whose context it names — `app:kitty` names the macOS context, and
 * kitty/linux must still resolve on its own. A review that names no candidate of this group is
 * therefore not this group's tie-break and the fallbacks below apply; the single permissions-free
 * entry is the row, and anything still ambiguous is reported with its contexts, never guessed.
 */
export function pickContextRun(
  candidates: readonly ContextCandidate[],
  reviewed?: DefaultContextReview,
): PickedContextRun | undefined {
  if (candidates.length === 0) return undefined
  if (reviewed !== undefined) {
    const chosen = candidates.find((candidate) => candidate.key === reviewed.contextKey)
    if (chosen) return { run: chosen, selection: "reviewed default-context row" }
  }
  const [only] = candidates
  if (candidates.length === 1 && only) return { run: only, selection: "only current" }
  const defaults = candidates.filter((candidate) => candidate.permissions === null)
  const [onlyDefault] = defaults
  if (defaults.length === 1 && onlyDefault) return { run: onlyDefault, selection: "default profile" }
  return { ambiguous: candidates.map((candidate) => candidate.key) }
}

export function barRowForContext(args: {
  context: ReleaseContext
  candidates: readonly ContextCandidate[]
  reviewed?: DefaultContextReview
  tier62Ids: readonly string[]
  tier52Ids: readonly string[]
}): BarRow {
  const picked = pickContextRun(args.candidates, args.reviewed)
  if (!picked) {
    return {
      context: args.context,
      measured: false,
      reason: `not measured — no selected run for ${args.context.terminalId}/${args.context.os}`,
    }
  }
  if ("ambiguous" in picked) {
    return {
      context: args.context,
      measured: false,
      reason:
        `not measured — ambiguous current selection for ${args.context.terminalId}/${args.context.os}: ` +
        `${picked.ambiguous.join(", ")}; a reviewed default-context row must choose one`,
    }
  }
  return {
    context: args.context,
    measured: true,
    run: picked.run,
    selection: picked.selection,
    shares: {
      tier62: decisiveShare(picked.run.cells, args.tier62Ids),
      tier52: decisiveShare(picked.run.cells, args.tier52Ids),
    },
  }
}

function candidateFromSelected(key: string, selected: SelectedVersion): ContextCandidate {
  return {
    key,
    kind: selected.target.kind,
    terminalId: selected.target.id,
    os: selected.target.os ?? "",
    permissions: selected.target.permissions ?? null,
    runId: selected.runId,
    version: selected.target.version ?? "",
    measuredAt: selected.measuredAt,
    suiteId: selected.suiteId,
    suiteFreshness: selected.suiteFreshness,
    cells: selected.cells,
  }
}

export interface Report {
  tier62Ids: string[]
  tier52Ids: string[]
  barRows: BarRow[]
  admittedRuns: ContextCandidate[]
  legacySkipped: number
  rejected: number
  searched: string
}

/**
 * The whole report: bar rows from the site's current selection, and every admitted schema-v2 `app` run
 * (newest first per context key) for the by-run-id section.
 */
export function buildReport(args: { contentDir: string; contexts?: readonly ReleaseContext[] }): Report {
  const projection = loadCurrentResults(args.contentDir).projection
  const current = Object.entries(projection.current).map(([key, selected]) => candidateFromSelected(key, selected))
  const reviewed = loadDefaultContextPolicy(args.contentDir)
  const admitted: ContextCandidate[] = []
  let legacySkipped = 0
  for (const [key, list] of Object.entries(projection.history)) {
    for (const selected of list) {
      if (selected.target.kind !== "app") continue
      // The projection marks a schema-v1 legacy document with suiteId "legacy"; its boolean results
      // are unverified, so a bare decisive share would read as a false 0%.
      if (selected.suiteId === "legacy") {
        legacySkipped++
        continue
      }
      const candidate = candidateFromSelected(key, selected)
      admitted.push(candidate)
    }
  }
  admitted.sort(
    (left, right) =>
      left.terminalId.localeCompare(right.terminalId) ||
      left.os.localeCompare(right.os) ||
      right.measuredAt.localeCompare(left.measuredAt) ||
      left.runId.localeCompare(right.runId),
  )
  const tier62Ids = tierOneIds(args.contentDir)
  const tier52Ids = ratifiedTierOneIds(tier62Ids)
  const contexts = args.contexts ?? RELEASE_1_CONTEXTS
  const barRows = contexts.map((context) =>
    barRowForContext({
      context,
      candidates: current.filter(
        (candidate) =>
          candidate.kind === "app" && candidate.terminalId === context.terminalId && candidate.os === context.os,
      ),
      reviewed: reviewed[`app:${context.terminalId}`],
      tier62Ids,
      tier52Ids,
    }),
  )
  return {
    tier62Ids,
    tier52Ids,
    barRows,
    admittedRuns: admitted,
    legacySkipped,
    rejected: projection.exclusions.length,
    searched: join(args.contentDir, "probes-apps"),
  }
}

function remainderLine(remainder: readonly RemainderRow[]): string {
  if (remainder.length === 0) return "    remainder    0 rows"
  const named = remainder.map((entry) => `${entry.featureId} (${entry.bucket})`).join(", ")
  return `    remainder    ${remainder.length} rows: ${named}`
}

export function formatBarRow(row: BarRow): string[] {
  const label = `${row.context.terminalId}/${row.context.os || "os not recorded"}`
  if (!row.measured) return [label, `  ${row.reason}`]
  const { tier62, tier52 } = row.shares
  const lines = [
    `${label} ${row.run.version || "version not recorded"}`,
    `  run ${row.run.runId} · measured ${row.run.measuredAt} · suite ${row.run.suiteId} · ${row.run.suiteFreshness}`,
  ]
  if (row.selection !== "only current") {
    lines.push(`  selected by the ${row.selection} · ${row.run.key}`)
  }
  lines.push(
    `    decisive/52     ${tier52.decisive}/${tier52.denominator} = ${tier52.decisivePct}%  (bar >= ${RELEASE_BAR.decisivePct}%)`,
    `    inconclusive/52 ${tier52.inconclusive}/${tier52.denominator} = ${tier52.inconclusivePct}%  (bar <= ${RELEASE_BAR.inconclusivePct}%)`,
    remainderLine(tier52.remainder),
    `    verdict         ${tier52.pass ? "PASS" : "FAIL"}  (on the ratified 52; the named exceptions are excluded by name)`,
    `    context/62      decisive ${tier62.decisive}/${tier62.denominator} = ${tier62.decisivePct}%, inconclusive ${tier62.inconclusive}/${tier62.denominator} = ${tier62.inconclusivePct}%  (context only, not the bar)`,
  )
  return lines
}

export function formatAdmittedRun(run: ContextCandidate, shares: ContextShares): string {
  return (
    `${run.terminalId} ${run.version || "version not recorded"} ${run.os || "os not recorded"} ${run.runId} ` +
    `suite ${run.suiteId} · ` +
    `decisive/62 ${shares.tier62.decisive}/${shares.tier62.denominator} = ${shares.tier62.decisivePct}% · ` +
    `decisive/52 ${shares.tier52.decisive}/${shares.tier52.denominator} = ${shares.tier52.decisivePct}%`
  )
}

function main(): void {
  const contentDir = join(import.meta.dirname ?? process.cwd(), "..", "content")
  const terminalIds = process.argv.slice(2).filter((arg) => !arg.startsWith("-"))
  const report = buildReport({ contentDir })
  const contexts = terminalIds.length
    ? report.barRows.filter((row) => terminalIds.includes(row.context.terminalId))
    : report.barRows

  console.log(
    `Release 1 decisive-count reader · tier-1 rows: ${report.tier62Ids.length} declared / ` +
      `${report.tier52Ids.length} ratified (62 minus the ten 27832 F2 movers) · bar ON THE 52: ` +
      `>=${RELEASE_BAR.decisivePct}% decisive, <=${RELEASE_BAR.inconclusivePct}% inconclusive`,
  )
  console.log(
    `read ${report.searched} through the published selection projection (docs/data/current-results.ts); ` +
      `skipped ${report.legacySkipped} schema-v1 legacy documents (unverified callback results); ` +
      `${report.rejected} run documents rejected by that projection`,
  )
  console.log("")
  console.log(`BAR ROWS — the site's selected run per Release 1 (terminal, os) context`)
  for (const row of contexts) {
    for (const line of formatBarRow(row)) console.log(line)
    console.log("")
  }
  console.log(`ADMITTED RUNS — every admitted schema-v2 app run in ${report.searched}`)
  for (const run of report.admittedRuns) {
    console.log(
      `  ${formatAdmittedRun(run, {
        tier62: decisiveShare(run.cells, report.tier62Ids),
        tier52: decisiveShare(run.cells, report.tier52Ids),
      })}`,
    )
  }
}

if (import.meta.main) main()
