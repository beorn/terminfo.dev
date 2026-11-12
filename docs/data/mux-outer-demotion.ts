/**
 * The one multiplexer-input demotion (#33665, @cto 042da091). Moved here from tools/terminfo-remeasure.ts so the
 * instrument's cells.json and the site's current-results read (composeContextSummaries) run the same rule; the
 * instrument supplies its outer reading from Kitty's newest bare App run, the site from the placed outer run of the
 * same version. Placed files stay the raw sealed capture: the site marks a demoted cell with `outerAbsent` and keeps
 * the measured result beside it.
 */
import type { LoadedRun } from "@terminfo/run-parser"
import type { SelectedContextCell } from "./selected-results.ts"

/** The outer terminal reading one demotion leans on, or the file that was asked for when there is none. */
export type OuterTerminalLookup = Readonly<{
  /** What this lookup asked for: a cells path or last.json (instrument), or the placed runs searched (site). */
  queried: string
  reading?: Readonly<{
    terminalId: string
    runId: string
    /** The file the reading came from: an instrument cells.json, or a placed run document. */
    cellsPath: string
    states: Readonly<Record<string, string>>
    /** The version that run measured, or null with `versionSource` naming what was queried instead. */
    version: string | null
    versionSource: string
  }>
}>

/**
 * @cto fa07833c (#33304): a multiplexer re-encodes the input encodings it passes through, so a negative there
 * cannot be attributed to it while its outer terminal shows the same absence. Where the outer terminal's own bare
 * run reads Unsupported on the same row, the input cell records Untestable naming that terminal and its run. A row
 * the outer terminal supports keeps the multiplexer's Unsupported, and a row outside the input family is never
 * demoted: tmux really does not implement DECDC, and that absence is the mux's own (#33300 a8326778).
 */
export function demoteMuxInputRows(input: {
  context: string
  states: Readonly<Record<string, string>>
  reasons: Readonly<Record<string, string>>
  subject: { kind: string; outerTerminal?: string | null }
  /** The outer terminal version the mux run itself recorded (outerApp.subject.version). */
  outerVersion?: string | null
  results: readonly { featureId: string; status: string; assertionType?: string }[]
  /** The outer terminal's newest complete run, or a reader for it: read only once a demotion can apply. */
  outer: OuterTerminalLookup | (() => OuterTerminalLookup)
}): { states: Record<string, string>; reasons: Record<string, string>; demoted: string[]; refusals: string[] } {
  const states = { ...input.states }
  const reasons = { ...input.reasons }
  const refusals: string[] = []
  const unchanged = { states, reasons, demoted: [], refusals }
  if (input.subject.kind !== "mux") return unchanged
  const rows = input.results.filter(
    (result) =>
      result.status === "unsupported" &&
      result.assertionType === "input_bytes" &&
      input.states[result.featureId] === "unsupported",
  )
  if (rows.length === 0) return unchanged
  const keeps = rows.length === 1 ? "1 Unsupported input row keeps" : `${rows.length} Unsupported input rows keep`
  const outerTerminal = input.subject.outerTerminal
  if (outerTerminal === null || outerTerminal === undefined || outerTerminal === "") {
    refusals.push(`${input.context}: the mux names no outer terminal; ${keeps} this run's reading`)
    return unchanged
  }
  const outer = typeof input.outer === "function" ? input.outer() : input.outer
  const { reading } = outer
  if (reading === undefined) {
    refusals.push(
      `${input.context}: no complete bare run of outer terminal ${outerTerminal} in ${outer.queried}; ${keeps} this run's reading`,
    )
    return unchanged
  }
  if (reading.terminalId !== outerTerminal) {
    refusals.push(
      `${input.context}: outer baseline ${reading.cellsPath} names ${reading.terminalId}, not ${outerTerminal}; ${keeps} this run's reading`,
    )
    return unchanged
  }
  if (reading.version === null) {
    refusals.push(
      `${input.context}: outer terminal ${reading.terminalId} run ${reading.runId} records no readable version (queried ${reading.versionSource}); ${keeps} this run's reading`,
    )
    return unchanged
  }
  const outerVersion = input.outerVersion
  if (outerVersion === null || outerVersion === undefined || outerVersion === "") {
    refusals.push(`${input.context}: the mux run records no outer terminal version; ${keeps} this run's reading`)
    return unchanged
  }
  if (outerVersion !== reading.version) {
    refusals.push(
      `${input.context}: outer terminal ${reading.terminalId} run ${reading.runId} is ${reading.version}, the mux run recorded ${outerVersion}; ${keeps} this run's reading`,
    )
    return unchanged
  }
  // 33341 (@cto 8ce68510): the outer terminal is our choice of host and it lacks the feature, so the class is
  // (no setup); the reason names that terminal, its version and the run it read, after this cell's own reason.
  const sentence = `outer ${reading.terminalId} ${reading.version} reads Unsupported on this row in run ${reading.runId}`
  const demoted = rows
    .filter((result) => reading.states[result.featureId] === "unsupported")
    .map((result) => result.featureId)
  for (const featureId of demoted) {
    states[featureId] = "untestable"
    const existing = reasons[featureId]
    const own = existing === undefined || existing === "" ? "" : `${existing}; `
    reasons[featureId] = `Untestable (no setup): ${own}${sentence}`
  }
  return { states, reasons, demoted, refusals }
}

/**
 * The cell's marker (#33665 condition 9): a demoted cell is countable apart from other Untestable cells. `measured` is
 * the status the run recorded; `reason` is the reason the demotion wrote, the run's own reason plus fa07833c's sentence.
 */
export interface OuterAbsentMarker {
  readonly terminalId: string
  readonly version: string
  readonly runId: string
  readonly measured: string
  readonly reason: string
}

/**
 * The placed outer terminal run a mux run's input rows lean on: among placed bare runs of that terminal on the same OS,
 * the newest one at the version the mux run recorded; with none at that version, the newest of any version, so the
 * demotion refuses by naming both versions. Only placed observable results are read (@cto 0f1274ed condition 4).
 */
export function placedOuterTerminalRun(
  runs: readonly LoadedRun[],
  terminalId: string,
  os: string | null | undefined,
  version: string | null | undefined,
): OuterTerminalLookup {
  const bare = runs
    .filter((run) => run.subject.kind === "term" && run.subject.id === terminalId && run.subject.os === os)
    .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt) || b.runId.localeCompare(a.runId))
  const queried = `placed ${terminalId}/${os ?? "unknown"} runs (${bare.length})`
  const picked = bare.find((run) => run.subject.version === version) ?? bare[0]
  if (picked === undefined) return { queried }
  return {
    queried,
    reading: {
      terminalId,
      runId: picked.runId,
      cellsPath: picked.path,
      states: Object.fromEntries((picked.results ?? []).map((result) => [result.featureId, result.status])),
      version: picked.subject.version || null,
      versionSource: picked.path,
    },
  }
}

/**
 * Apply the demotion to one context's composed cells, one mux run at a time (a context's cells can come from several
 * runs). A demoted cell's feature result reads untestable with `outerAbsent` set; `result`, `run` and `origin` stay the
 * measured original. Returns the refusals, each naming why a run's Unsupported input rows kept their reading.
 */
export function applyOuterAbsent(
  contextKey: string,
  cells: Record<string, SelectedContextCell>,
  placedRuns: readonly LoadedRun[],
): string[] {
  const byRun = new Map<LoadedRun, string[]>()
  for (const [featureId, cell] of Object.entries(cells)) {
    if (cell.run.subject.kind !== "mux" || cell.featureResult === undefined) continue
    const ids = byRun.get(cell.run) ?? []
    ids.push(featureId)
    byRun.set(cell.run, ids)
  }
  const refusals: string[] = []
  for (const [run, ids] of byRun) {
    const states: Record<string, string> = {}
    const reasons: Record<string, string> = {}
    const results: { featureId: string; status: string; assertionType?: string }[] = []
    for (const featureId of ids) {
      const cell = cells[featureId]
      if (cell?.featureResult === undefined) continue
      states[featureId] = cell.featureResult.status
      if (cell.result.reason !== undefined && cell.result.reason !== "") reasons[featureId] = cell.result.reason
      results.push({ featureId, status: cell.result.status, assertionType: cell.result.assertionType })
    }
    const outerTerminal = typeof run.subject.outerTerminal === "string" ? run.subject.outerTerminal : null
    const outerVersion = run.outerApp?.subject.version ?? null
    // One lookup per run, read only once a demotion can apply (the function calls it lazily).
    let lookup: OuterTerminalLookup | undefined
    const outer = (): OuterTerminalLookup =>
      (lookup ??= placedOuterTerminalRun(placedRuns, outerTerminal ?? "", run.subject.os, outerVersion))
    const demotion = demoteMuxInputRows({
      context: `${contextKey} run ${run.runId}`,
      states,
      reasons,
      subject: run.subject,
      outerVersion,
      results,
      outer,
    })
    refusals.push(...demotion.refusals)
    const reading = lookup?.reading
    for (const featureId of demotion.demoted) {
      const cell = cells[featureId]
      // demoted is non-empty only after the lookup read a same-version reading, so these hold; fail loud if not.
      if (cell?.featureResult === undefined || reading === undefined || reading.version === null) {
        throw new Error(`${contextKey}: ${featureId} demoted without a cell or an outer reading`)
      }
      cells[featureId] = {
        ...cell,
        featureResult: { ...cell.featureResult, status: "untestable", strength: null },
        outerAbsent: {
          terminalId: reading.terminalId,
          version: reading.version,
          runId: reading.runId,
          measured: cell.result.status,
          reason: demotion.reasons[featureId] ?? "",
        },
      }
    }
  }
  return refusals
}
