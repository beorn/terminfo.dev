/**
 * A feature's probe status, DERIVED at build time from the probe definitions (28792 item 4).
 *
 * What the definitions settle, they settle. A row whose arms all declare evidence reads
 * `automated` when every arm that runs declares MEASURING evidence, and `partial` when an arm is
 * null or declares non-measuring evidence (consumed / legacy / none), because then the probe
 * establishes consumption or acceptance, not the feature's effect.
 *
 * What the definitions cannot settle is a CURATED row, and it carries a reviewed `probeStatus`
 * (manual or partial) with its `probeStatusReason`. Two things put a row there:
 *  - a definition that leaves an arm UNDECLARED (`termObservationEvidence` is opt-in), where the
 *    honest value is partial because no arm claims a measurement on every run;
 *  - a gate the definition cannot express today, such as the owned clipboard fixture that
 *    `liveClipboardProbe` needs (27832 section F2); 28450 moves that declaration into the kind.
 * Nothing derives `automated` by default. The build and validate print how many rows still stand on
 * a curated value, and which of those stand OVER a settled derivation, so the gap is visible and
 * never silent as 28450 lands.
 */
import { ALL_PROBES, isNonMeasuringEvidence, type ProbeDefinition } from "@terminfo/probe-defs"
import type { FeatureCatalog } from "@terminfo/catalog"

/** The two statuses a catalog row may carry as a reviewed value; each needs a reason beside it. */
export const REVIEWED_PROBE_STATUSES = ["manual", "partial"] as const
export type ReviewedProbeStatus = (typeof REVIEWED_PROBE_STATUSES)[number]

/** The four states a feature page can show. */
export type ProbeStatus = "automated" | ReviewedProbeStatus | "unprobed"

/** What the definitions alone settle; `null` leaves the row to its reviewed value. */
export type DerivedProbeStatus = "automated" | "partial" | null

const BY_ID = new Map(ALL_PROBES.map((probe) => [probe.id, probe]))
const isReviewed = (status: string | undefined): status is ReviewedProbeStatus =>
  status === "manual" || status === "partial"
const featureIds = (catalog: FeatureCatalog): string[] => Object.keys(catalog).filter((id) => !id.startsWith("$"))

/**
 * The one owner of the derivation. `partial` outranks "undeclared": an arm that is absent, or one
 * that declares acceptance-only evidence, fixes the row as partial even when another arm is silent.
 */
export function derivedProbeStatus(definition: ProbeDefinition): DerivedProbeStatus {
  const declared = [definition.termObservationEvidence, definition.termlessObservationEvidence]
  if (definition.term === null || definition.termless === null) return "partial"
  if (declared.some((evidence) => evidence !== undefined && isNonMeasuringEvidence(evidence))) return "partial"
  if (declared.some((evidence) => evidence === undefined)) return null
  return "automated"
}

/** `null` when the definitions cannot settle the row and the catalog carries no reviewed value. */
export function probeStatusOrNull(id: string, catalog: FeatureCatalog): ProbeStatus | null {
  const reviewed = catalog[id]?.probeStatus
  if (isReviewed(reviewed)) return reviewed
  const definition = BY_ID.get(id)
  if (!definition) return "unprobed"
  return derivedProbeStatus(definition)
}

/**
 * The one owner of a feature's status. A reviewed value wins, because a review is deliberate and
 * carries its reason; otherwise the definitions decide; a row with no definition at all reads
 * unprobed. A row the definitions leave unsettled and the catalog leaves unreviewed is a loud build
 * failure, never a silent default.
 */
export function probeStatusOf(id: string, catalog: FeatureCatalog): ProbeStatus {
  const status = probeStatusOrNull(id, catalog)
  if (status === null) {
    throw new Error(
      `Feature "${id}" leaves an arm undeclared, so its probeStatus cannot be derived from the definitions and it carries no reviewed probeStatus. Add "probeStatus": "partial" (or "manual") with a probeStatusReason to content/features.json, or declare the arm's evidence in the definition.`,
    )
  }
  return status
}

export interface ProbeStatusSummary {
  counts: Record<ProbeStatus, number>
  /** Rows with a definition that carry a reviewed value because the definitions cannot settle them. */
  unsettled: string[]
  /** Rows with a definition whose reviewed value stands over a derivation the definitions DO settle. */
  gated: string[]
  /** Rows with no definition that carry a reviewed manual/partial value (manual by design). */
  noDefinition: string[]
  /** Rows the definitions cannot settle and the catalog leaves unreviewed. Must be empty. */
  unreviewed: string[]
}

/** The curated gap: rows whose value comes from a review, not from a derivation. */
export const rowsOnCuratedValue = (summary: ProbeStatusSummary): number =>
  summary.unsettled.length + summary.gated.length

/** One summary for every printer and for validate: the distribution, and the curated gap. */
export function probeStatusSummary(catalog: FeatureCatalog): ProbeStatusSummary {
  const counts: Record<ProbeStatus, number> = { automated: 0, partial: 0, manual: 0, unprobed: 0 }
  const unsettled: string[] = []
  const gated: string[] = []
  const noDefinition: string[] = []
  const unreviewed: string[] = []
  for (const id of featureIds(catalog)) {
    const reviewed = catalog[id]?.probeStatus
    const definition = BY_ID.get(id)
    const derived = definition ? derivedProbeStatus(definition) : null
    if (isReviewed(reviewed)) {
      if (definition === undefined) noDefinition.push(id)
      else if (derived === null) unsettled.push(id)
      else gated.push(id)
    } else if (definition !== undefined && derived === null) {
      unreviewed.push(id)
    }
    const status = probeStatusOrNull(id, catalog)
    if (status !== null) counts[status]++
  }
  return { counts, unsettled, gated, noDefinition, unreviewed }
}
