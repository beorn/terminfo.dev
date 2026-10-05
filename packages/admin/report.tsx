/** Canonical CLI capability matrix, rendered through the existing Silvery text layout. */

import React from "react"
import { Box, Text, renderString } from "silvery"
import type { SelectedCell, SelectedProjection, SelectedVersion } from "../../docs/data/selected-results.ts"

type CurrentColumn = { label: string; contextKey: string; run: SelectedVersion }
type StateToken = "YES" | "NO" | "INC" | "ERR" | "NT"

function score(run: SelectedVersion): string {
  const { supported, conclusive } = run.counts
  return conclusive === 0
    ? "no conclusive score"
    : `${supported}/${conclusive} ${Math.round((supported / conclusive) * 100)}%`
}

function stateToken(cell: SelectedCell | undefined): StateToken {
  if (!cell) return "NT"
  switch (cell.outcome) {
    case "supported":
      return "YES"
    case "unsupported":
      return "NO"
    case "inconclusive":
      return "INC"
    case "error":
      return "ERR"
  }
}

function StateCell({ cell, width }: { cell: SelectedCell | undefined; width: number }): React.ReactElement {
  const token = stateToken(cell)
  const color = token === "YES" ? "$success" : token === "NO" ? "$error" : "$muted"
  return (
    <Box width={width} justifyContent="center">
      <Text color={color}>{token}</Text>
    </Box>
  )
}

function CurrentSummary({ column }: { column: CurrentColumn }): React.ReactElement {
  const { target, counts, cells } = column.run
  const inconclusive = Object.values(cells).filter((cell) => cell.outcome === "inconclusive").length
  const errors = Object.values(cells).filter((cell) => cell.outcome === "error").length
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>
        {column.label}: {target.kind}:{target.id} {target.version} — run {column.run.runId}
      </Text>
      <Text color="$muted">context {column.contextKey}</Text>
      <Text>
        {score(column.run)} · {counts.tested} tested · {counts.notTested} not tested
        {column.run.notTestedCoverage.namedCount > 0
          ? ` (${column.run.notTestedCoverage.namedCount} named: no observable)`
          : ""}{" "}
        · {counts.supported} supported · {counts.unsupported} unsupported · {inconclusive} inconclusive · {errors} error
      </Text>
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
      <Text color="$muted">YES supported · NO unsupported · INC inconclusive · ERR error · NT not tested</Text>
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
                <StateCell key={column.label} cell={column.run.cells[id]} width={columnWidth} />
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
  const columns = Object.entries(projection.current)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([contextKey, run], index) => ({ label: `C${index + 1}`, contextKey, run }))
  const ungraded = Object.entries(projection.history).flatMap(([contextKey, runs]) =>
    runs.filter((run) => Object.keys(run.ungradedDiagnostics.results).length > 0).map((run) => ({ contextKey, run })),
  )
  return (
    <Box flexDirection="column">
      <Text bold color="$primary">
        terminfo report — {featureIds.length} catalog features
      </Text>
      <Text bold>Current selected contexts: {columns.length}</Text>
      {columns.length === 0 && <Text color="$muted">No selected current results</Text>}
      {columns.map((column) => (
        <CurrentSummary key={column.contextKey} column={column} />
      ))}
      {columns.length > 0 && <FeatureMatrix columns={columns} featureIds={featureIds} width={width} />}
      <Text bold>Observation reasons and notes</Text>
      {columns.flatMap((column) =>
        featureIds.flatMap((id) => {
          const cell = column.run.cells[id]
          if (!cell?.reason && !cell?.note) return []
          return [
            <Text key={`${column.label}:${id}`}>
              {column.label} {id}: {cell.reason ?? ""}
              {cell.note ? ` — ${cell.note}` : ""}
            </Text>,
          ]
        }),
      )}
      <Text bold>Ungraded history: {ungraded.length}</Text>
      {ungraded.map(({ contextKey, run }) => (
        <Text key={`${contextKey}:${run.runId}`}>
          {run.target.kind}:{run.target.id} {run.target.version} — run {run.runId}: {run.ungradedDiagnostics.label} (
          {Object.keys(run.ungradedDiagnostics.results).length} diagnostics)
        </Text>
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
