/**
 * The full-scope project's row builder: one row for every expected context, each either scored over
 * the whole catalog or explicitly NOT COLLECTED with its cause.
 *
 * This module is pure. It receives the census, the catalog basis in display order, the classified
 * candidate runs and the required suite, and decides nothing about the corpus: the caller reads the
 * projection once and passes its candidates here. Keeping the decision pure is what lets the row
 * shape — never 0% for a missing context, never included without a denominator — be tested without
 * a corpus.
 */
import type { ContextCandidate } from "./run-selection.ts"
import { pickContextRun } from "./run-selection.ts"
import type { FeatureResultStatus } from "@terminfo/probe-defs"
import { originalRunFor, type SelectedProjection } from "./selected-results.ts"
import { scopeAggregate, type ScopeResult } from "./full-scope.ts"
import {
  environmentGroupIds,
  scoredFeatureIds,
  isEnvironmentGroup,
} from "../../packages/probe-defs/src/environment-groups.ts"
import type { CensusContext, ContextKind } from "./full-census.ts"

/** One catalog row of a collected context, with its state and the run's own method and words. */
export interface ObservationRow {
  id: string
  state: FeatureResultStatus
  /** The observation method the run recorded (pixel, text cell, query/reply), when it names one. */
  method: string | null
  note: string | null
  reason: string | null
  origin: { runId: string; resultId: string }
  suiteId: string
  measuredAt: string
  hold?: string
}

export interface CollectedRow {
  context: string
  terminalId: string
  os: string
  kind: ContextKind
  collected: true
  selection: {
    contextKey: string
    method: string
  }
  sources: ContextCandidate["sources"]
  heldIds: string[]
  result: ScopeResult
  /** Every catalog id, so the preview shows the row itself and not only its count. */
  observations: readonly ObservationRow[]
}

export interface UncollectedRow {
  context: string
  terminalId: string
  os: string
  kind: ContextKind
  collected: false
  cause: string
}

export type FullContextRow = CollectedRow | UncollectedRow

export interface FullProjectRows {
  /** The suite every collected row was measured on; a run on another suite is not collected. */
  requiredSuiteId: string
  /** Every recorded catalogue position, environment groups included. */
  catalogRows: number
  /** The graded features: `catalogRows` minus the environment groups (D132 B). */
  gradedRows: number
  /** The environment groups the catalogue records: manual by design, never graded. */
  environmentGroups: number
  contexts: readonly FullContextRow[]
  collected: number
  notCollected: number
  complete: boolean
  recordedPositions: number
}

/**
 * One row per expected context. A context is COLLECTED only when the site's own selection resolves
 * one current run on the required suite; everything else is named, with its own reason, and carries
 * no score. Ambiguity is never guessed, and an engine whose current runs span several operating
 * systems is named rather than silently reduced to one.
 */
export function buildFullProjectRows(args: {
  census: readonly CensusContext[]
  catalogIds: readonly string[]
  candidates: readonly ContextCandidate[]
  requiredSuiteId: string
  projection?: Pick<SelectedProjection, "history">
}): FullProjectRows {
  if (!args.requiredSuiteId) throw new Error("the full-scope reader needs the suite it scores against")
  const rows = args.census.map((context): FullContextRow => buildRow(context, args))
  return {
    requiredSuiteId: args.requiredSuiteId,
    catalogRows: args.catalogIds.length,
    gradedRows: scoredFeatureIds(args.catalogIds).length,
    environmentGroups: environmentGroupIds(args.catalogIds).length,
    contexts: rows,
    collected: rows.filter((row) => row.collected).length,
    notCollected: rows.filter((row) => !row.collected).length,
    complete: rows.length > 0 && rows.every((row) => row.collected && row.result.complete),
    recordedPositions: rows.reduce((sum, row) => sum + (row.collected ? row.result.catalogRows : 0), 0),
  }
}

function buildRow(
  context: CensusContext,
  args: {
    catalogIds: readonly string[]
    candidates: readonly ContextCandidate[]
    requiredSuiteId: string
    projection?: Pick<SelectedProjection, "history">
  },
): FullContextRow {
  const base = { context: context.context, terminalId: context.terminalId, os: context.os, kind: context.kind }
  const matches = args.candidates.filter(
    (candidate) =>
      candidate.kind === context.kind &&
      candidate.terminalId === context.terminalId &&
      (context.kind === "lib" || candidate.os === context.os),
  )
  if (matches.length === 0) {
    return { ...base, collected: false, cause: "no selected run for this context" }
  }
  if (context.kind === "lib") {
    // An engine's adapter is one context. Several current runs across operating systems are several
    // candidates for one row, so the row names them instead of choosing one and hiding the rest.
    const onSuite = matches.filter((candidate) =>
      candidate.sources.some((source) => source.suiteId === args.requiredSuiteId),
    )
    const distinctOs = [...new Set(onSuite.map((candidate) => candidate.os))].sort()
    if (distinctOs.length > 1) {
      return {
        ...base,
        collected: false,
        cause: `engine has current runs on ${distinctOs.join(", ")}; one headless context cannot choose an operating system`,
      }
    }
  }
  const picked = pickContextRun(matches)
  if (!picked) return { ...base, collected: false, cause: "no selected run for this context" }
  const onSuiteSources = picked.run.sources.filter((source) => source.suiteId === args.requiredSuiteId)
  const [firstOnSuite] = onSuiteSources
  if (!firstOnSuite) {
    return {
      ...base,
      collected: false,
      cause: `selected run is on suite ${[...new Set(picked.run.sources.map((source) => source.suiteId))].join(", ")}; required ${args.requiredSuiteId}; sources ${picked.run.sources.map((source) => source.runId).join(", ")}`,
    }
  }
  const results = picked.run.results
  if (!results) {
    return { ...base, collected: false, cause: "selected run is historical; stored current results required" }
  }
  const byId = new Map(results.map((result) => [result.featureId, result]))
  const projection = args.projection
  if (picked.run.context && !projection) {
    throw new Error(`Current context ${picked.run.key} needs its original projection history`)
  }
  for (const source of onSuiteSources) {
    const original =
      picked.run.context && projection ? originalRunFor(projection, picked.run.key, source.runId).results : results
    for (const id of args.catalogIds) {
      if (!original?.some((result) => result.featureId === id)) {
        throw new Error(`Current run ${source.runId} lacks recorded catalogue feature ${id}`)
      }
    }
  }
  const heldIds: string[] = []
  const observations = args.catalogIds.map((id): ObservationRow => {
    const cell = byId.get(id)
    if (!cell) throw new Error(`Current context ${picked.run.key} lacks recorded catalogue feature ${id}`)
    const featureResult = picked.run.context?.cells[id]?.featureResult
    if (picked.run.context && !isEnvironmentGroup(id) && !featureResult) {
      throw new Error(`Current context ${picked.run.key}/${id} lacks its computed feature result`)
    }
    const original = picked.run.context?.cells[id]?.run
    const source = original ?? firstOnSuite
    const hold =
      source.suiteId !== args.requiredSuiteId
        ? `retained from suite ${source.suiteId}, measured ${source.measuredAt}; not release evidence`
        : undefined
    if (hold) heldIds.push(id)
    return {
      id,
      state: isEnvironmentGroup(id) ? cell.status : (featureResult?.status ?? cell.status),
      method: cell.assertionType ?? null,
      note: null,
      reason: cell.reason ?? null,
      origin: { runId: source.runId, resultId: id },
      suiteId: source.suiteId,
      measuredAt: source.measuredAt,
      ...(hold && { hold }),
    }
  })
  const held = new Set(heldIds)
  const states = new Map(observations.map((observation) => [observation.id, observation.state]))
  return {
    ...base,
    collected: true,
    selection: {
      contextKey: picked.run.key,
      method: picked.selection,
    },
    sources: picked.run.sources,
    heldIds,
    result: scopeAggregate({
      scope: context.context,
      catalogIds: args.catalogIds,
      results: results.map((result) => {
        const status = states.get(result.featureId)
        if (status === undefined) {
          throw new Error(`Current context ${picked.run.key} has foreign feature ${result.featureId}`)
        }
        return { featureId: result.featureId, status: held.has(result.featureId) ? "probe-todo" : status }
      }),
    }),
    observations,
  }
}
