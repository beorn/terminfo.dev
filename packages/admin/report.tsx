/** Canonical CLI feature matrix, rendered through the existing Silvery text layout. */

import React from "react"
import { Box, Text, renderString } from "silvery"
import type { SelectedProjection, SelectedContextSummary } from "../../docs/data/selected-results.ts"

import type { ProbeResult } from "@terminfo/probe-defs"
import { isEnvironmentGroup } from "@terminfo/probe-defs"
import { currentCoverageSentence } from "../../docs/data/release-scope.ts"

type CurrentColumn = { label: string; contextKey: string; view: SelectedContextSummary }
type StateToken = "YES" | "NO" | "UNTEST" | "FAIL" | "TODO" | "N/M" | "—"

function score(run: SelectedContextSummary): string {
  return `${run.score.supported}/${run.score.all} Supported / all (${Math.round((100 * run.score.supported) / run.score.all)}%)`
}

function stateToken(cell: ProbeResult | undefined): StateToken {
  if (!cell) return "—"
  // D132 B (#30917): the nine environment positions are recorded TEST TODO by the catalogue but are
  // manual by design, not graded, and were never measured. They must never read as TODO.
  if (cell.status === "test-todo" && isEnvironmentGroup(cell.featureId)) return "N/M"
  switch (cell.status) {
    case "supported":
      return "YES"
    case "unsupported":
      return "NO"
    case "untestable":
      return "UNTEST"
    case "test-todo":
      return "TODO"
    case "test-failure":
      return "FAIL"
  }
}

function StateCell({ cell, width }: { cell: ProbeResult | undefined; width: number }): React.ReactElement {
  const token = stateToken(cell)
  const color = token === "YES" ? "$success" : token === "NO" ? "$error" : "$muted"
  return (
    <Box width={width} justifyContent="center">
      <Text color={color}>{token}</Text>
    </Box>
  )
}

function CurrentSummary({ column }: { column: CurrentColumn }): React.ReactElement {
  const { view } = column
  const single =
    view.contributingRunIds.length === 1
      ? Object.values(view.cells).find((cell) => cell.origin.runId === view.contributingRunIds[0])?.run
      : undefined
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>
        {column.label}:{" "}
        {single
          ? `${single.subject.kind}:${single.subject.id} ${single.subject.version} — run ${single.runId}`
          : column.contextKey}
      </Text>
      <Text color="$muted">context {column.contextKey}</Text>
      <Text>Contributing runs: {view.contributingRunIds.join(", ") || "none; no emitted evidence"}</Text>
      <Text>
        {score(view)} · {currentCoverageSentence(view, view.catalogIds)} ·{" "}
        {view.complete ? "result coverage complete" : "result coverage incomplete"}
      </Text>
      {view.attempts.map((entry) => (
        <Text key={entry.runId} color="$muted">
          Requested run {entry.runId}: {entry.attempt?.result ?? "outcome not recorded"};{" "}
          {entry.attempt?.startedAt ?? "start not recorded"}; selected {entry.selection.ids.length}; no output{" "}
          {entry.noOutputIds.join(", ") || "none"}; {entry.attempt?.error ?? ""} · {entry.path}
        </Text>
      ))}
    </Box>
  )
}

function FeatureMatrix({
  columns,
  featureIds,
  width,
}: {
  columns: CurrentColumn[]
  featureIds: string[]
  width: number
}): React.ReactElement {
  const featureWidth = Math.max(10, ...featureIds.map((id) => id.length)) + 2
  const columnWidth = 8
  const columnsPerGroup = Math.max(1, Math.floor((width - featureWidth - 2) / columnWidth))
  const groups: CurrentColumn[][] = []
  for (let offset = 0; offset < columns.length; offset += columnsPerGroup) {
    groups.push(columns.slice(offset, offset + columnsPerGroup))
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="$primary">
        Feature comparison
      </Text>
      <Text color="$muted">
        YES Supported · NO Unsupported · UNTEST Untestable · TODO TEST TODO · FAIL TEST FAILURE · N/M manual by design
        (catalogue), NOT MEASURED
      </Text>
      {groups.map((group) => (
        <Box key={group[0]?.label} flexDirection="column" marginBottom={1}>
          <Box>
            <Box width={featureWidth}>
              <Text bold>Feature</Text>
            </Box>
            {group.map((column) => (
              <Box key={column.label} width={columnWidth} justifyContent="center">
                <Text bold>{column.label}</Text>
              </Box>
            ))}
          </Box>
          {featureIds.map((id) => (
            <Box key={id}>
              <Box width={featureWidth}>
                <Text>{id}</Text>
              </Box>
              {group.map((column) => (
                <StateCell key={column.label} cell={column.view.cells[id]?.result} width={columnWidth} />
              ))}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export function CensusReport({
  projection,
  featureIds,
  width,
}: {
  projection: SelectedProjection
  featureIds: string[]
  width: number
}): React.ReactElement {
  const columns = Object.entries(projection.contexts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([contextKey, view], index) => ({ label: `C${index + 1}`, contextKey, view }))
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold color="$primary">
        terminfo report — {featureIds.length} catalog features
      </Text>
      <Text bold>Current selected contexts: {columns.length}</Text>
      {columns.length === 0 && <Text color="$muted">No current result evidence or selected attempts.</Text>}
      {columns.map((column) => (
        <CurrentSummary key={column.contextKey} column={column} />
      ))}
      {columns.length > 0 && <FeatureMatrix columns={columns} featureIds={featureIds} width={width} />}
      <Text bold>Observation reasons and notes</Text>
      {columns.flatMap((column) =>
        featureIds.flatMap((id) => {
          const cell = column.view.cells[id]?.result
          if (!cell?.reason) return []
          return [
            <Text key={`${column.label}:${id}`}>
              {column.label} {id}: {cell.reason ?? ""}
            </Text>,
          ]
        }),
      )}
      {columns
        .filter((column) => column.view.attempts.length > 0)
        .map((column) => (
          <Box key={`origins:${column.contextKey}`} flexDirection="column">
            <Text bold>Original result evidence · {column.label}</Text>
            {Object.entries(column.view.cells).map(([id, cell]) => (
              <Text key={id}>
                {id}: {cell.origin.runId} / {cell.origin.resultId} · {cell.run.measuredAt} · {cell.run.path}
              </Text>
            ))}
          </Box>
        ))}
      <Text bold>Excluded runs: {projection.exclusions.length}</Text>
      {projection.exclusions.map((excluded) => (
        <Text key={`${excluded.path}:${excluded.runId}`}>
          {excluded.runId}: {excluded.reason} ({excluded.path})
        </Text>
      ))}
    </Box>
  )
}

/** Render the selected comparison to a string via Silvery. */
export async function renderReport(projection: SelectedProjection, featureIds: string[]): Promise<string> {
  const width = process.stdout.columns || 120
  const minimumWidth = Math.max(10, ...featureIds.map((id) => id.length)) + 12
  return renderString(React.createElement(CensusReport, { projection, featureIds, width }), {
    width: Math.max(width, minimumWidth),
  })
}
