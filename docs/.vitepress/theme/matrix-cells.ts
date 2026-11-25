/**
 * Pure SSR/client HTML rendering for delegated matrix cells (#38451).
 *
 * Matrix tables on Home (`docs/index.md`), Baseline (`docs/baseline/[id].md`), and
 * Category/Standard (`docs/[id].md`) render plain `<button>` / `<span>` cells via `v-html`
 * and delegate hover/focus/click to one shared `DelegatedMatrix` host per table instead of
 * hydrating thousands of `ResultEvidenceCell` Vue component instances on page load.
 */
import type { FeatureResultStatus } from "../../../packages/probe-defs/src/types.ts"
import type { AppCellStatus } from "../../data/app-cells.ts"
import type {
  PublicContextSummary,
  PublicFeatureResult,
  PublicProbeResult,
  PublicRunMetadata,
  PublicVersion,
} from "../../data/public-results.ts"
import { publicResultFor } from "../../data/release-scope.ts"
import { featureAnchorId } from "./bar-layout.ts"
import { displayVersion } from "./display-version.ts"
import { evidenceStatus, NO_RESULT_STATUS, type EvidenceTone } from "./evidence-status.ts"

export type MatrixCellValue =
  | PublicProbeResult
  | (PublicFeatureResult & {
      joined?: { status: AppCellStatus; from: Array<{ context: string; status: FeatureResultStatus }> }
      derived?: { parent: string; parentRunId: string; reason: string }
    })

export interface MatrixCellInput {
  readonly featureId: string
  readonly featureName: string
  readonly subjectName: string
  readonly version?: PublicRunMetadata | PublicContextSummary
  readonly cell?: MatrixCellValue
}

export interface MatrixCellDescriptor {
  readonly blank: boolean
  readonly tone: EvidenceTone
  readonly icon: string
  readonly title?: string
  readonly accessibleName: string
}

export interface MatrixFeatureRow {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly slug: string
  readonly tooltip?: string
}

export interface MatrixBackendColumn {
  readonly name: string
  readonly label: string
}

export interface MatrixCategoryGroup {
  readonly id: string
  readonly label: string
  readonly features: readonly MatrixFeatureRow[]
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function resolveSourceRun(
  version: PublicRunMetadata | PublicContextSummary | undefined,
  featureId: string,
): PublicRunMetadata | undefined {
  if (!version) return undefined
  if (!("featureResults" in version)) return version
  const cell = version.featureResults[featureId]
  if (!cell) return undefined
  const source = version.sources[cell.origin.runId]
  if (!source) throw new Error(`Context feature ${featureId} lacks source ${cell.origin.runId}`)
  return source
}

export function describeMatrixCell(input: MatrixCellInput): MatrixCellDescriptor {
  const sourceRun = resolveSourceRun(input.version, input.featureId)
  const cell = input.cell
  const derived = Boolean(cell && "derived" in cell && cell.derived)
  const joined = cell && "joined" in cell ? cell.joined : undefined
  const currentStatus = cell && "status" in cell ? cell.status : undefined
  const status = evidenceStatus(input.featureId, joined?.status ?? currentStatus, derived)
  const blank = status === NO_RESULT_STATUS
  const versionSuffix = sourceRun ? ` ${displayVersion(sourceRun.subject.version)}` : ""
  const actionLabel = cell ? "Opens how this was tested" : "No evidence in current selection"
  const accessibleName = `${input.featureName} in ${input.subjectName}${versionSuffix}: ${
    blank ? `${NO_RESULT_STATUS.title}.` : `${status.text}. ${actionLabel}`
  }`

  return {
    blank,
    tone: status.tone,
    icon: status.icon,
    ...(status.title ? { title: status.title } : {}),
    accessibleName,
  }
}

export function renderMatrixCellHtml(input: MatrixCellInput & { readonly backendName: string }): string {
  const desc = describeMatrixCell(input)
  if (desc.blank) {
    const title = escapeHtml(desc.title ?? NO_RESULT_STATUS.title ?? "No result yet")
    return `<span class="result-evidence__blank" role="img" title="${title}" aria-label="${escapeHtml(desc.accessibleName)}">${escapeHtml(desc.icon)}</span>`
  }
  return `<button type="button" class="result-evidence__trigger result-evidence__trigger--${desc.tone}" aria-label="${escapeHtml(desc.accessibleName)}" aria-expanded="false" data-mc-f="${escapeHtml(input.featureId)}" data-mc-b="${escapeHtml(input.backendName)}">${escapeHtml(desc.icon)}</button>`
}

interface MatrixRenderOptions {
  readonly backends: readonly MatrixBackendColumn[]
  readonly selectionFor: (backendName: string) => PublicVersion | PublicContextSummary | undefined
  readonly includeAnchors?: boolean
  readonly tooltipAttr?: "title" | "data-tooltip"
  readonly linkClass?: string
}

function renderFeatureRowHtml(feature: MatrixFeatureRow, opts: MatrixRenderOptions): string {
  const rowIdAttr = opts.includeAnchors ? ` id="${escapeHtml(featureAnchorId(feature.id))}"` : ""
  const tipAttrName = opts.tooltipAttr ?? "title"
  const tipAttr = feature.tooltip ? ` ${tipAttrName}="${escapeHtml(feature.tooltip)}"` : ""
  const linkClassAttr = opts.linkClass ? ` class="${escapeHtml(opts.linkClass)}"` : ""
  const href = `/${encodeURI(feature.category)}/${encodeURI(feature.slug)}`

  const cells: string[] = []
  for (const backend of opts.backends) {
    const version = opts.selectionFor(backend.name)
    const cell = publicResultFor(version, feature.id) as MatrixCellValue | undefined
    cells.push(
      `<td>${renderMatrixCellHtml({
        featureId: feature.id,
        featureName: feature.name,
        backendName: backend.name,
        subjectName: backend.label,
        version,
        cell,
      })}</td>`,
    )
  }

  return `<tr${rowIdAttr}><td class="feature-name"${tipAttr}><a${linkClassAttr} href="${escapeHtml(href)}">${escapeHtml(feature.name)}</a></td>${cells.join("")}</tr>`
}

export function renderFlatMatrixBodyHtml(
  input: MatrixRenderOptions & { readonly features: readonly MatrixFeatureRow[] },
): string {
  return input.features.map((feature) => renderFeatureRowHtml(feature, input)).join("")
}

export function renderGroupedMatrixBodyHtml(
  input: MatrixRenderOptions & { readonly groups: readonly MatrixCategoryGroup[] },
): string {
  const colSpan = input.backends.length + 1
  const linkClassAttr = input.linkClass ? ` class="${escapeHtml(input.linkClass)}"` : ""
  const parts: string[] = []
  for (const group of input.groups) {
    parts.push(
      `<tr class="category-row"><td colspan="${colSpan}" class="category-header"><a${linkClassAttr} href="/${escapeHtml(encodeURI(group.id))}">${escapeHtml(group.label)}</a></td></tr>`,
    )
    for (const feature of group.features) {
      parts.push(renderFeatureRowHtml(feature, input))
    }
  }
  return parts.join("")
}
