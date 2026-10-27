/**
 * A feature's probe status, DERIVED at build time from the probe definitions (28792 item 4).
 *
 * What the definitions settle, they settle. A row whose arms all declare evidence reads `automated`
 * when every arm that runs declares MEASURING evidence, and `partial` when an arm is null or declares
 * non-measuring evidence (consumed / legacy / none), because then the probe establishes consumption or
 * acceptance, not the feature's effect.
 *
 * What they cannot settle reads `undeclared`, the honest word for "this row's evidence kind is not
 * declared yet". It is a temporary value: 28450 declares the evidence in each family's kind, and
 * 28801 deletes the value and its badge when the count reaches zero. Nothing derives `automated` by
 * default, and no badge claims more than the evidence behind it.
 *
 * Two exceptions carry a REVIEWED value instead of a derivation, and a reviewed value wins:
 *  - 23 rows were hand-marked partial in the catalog before the derivation existed, and keep it;
 *  - 3 rows (the 27832 section F2 osc52 family) declare measuring evidence on both arms yet are
 *    fixture-gated: `liveClipboardProbe` policy-refuses before sending unless an owned clipboard
 *    fixture is installed, so the standard run reads back only a round-trip against that fixture. A
 *    definition cannot express that gate until 28450, so it is a reviewed partial that stands OVER a
 *    settled derivation.
 * The build and validate print the undeclared count beside the gated rows, so the gap is visible and
 * never silent.
 */
import { ALL_PROBES, isNonMeasuringEvidence, type ProbeDefinition } from "@terminfo/probe-defs"
import type { FeatureCatalog } from "@terminfo/catalog"

/** The two statuses a catalog row may carry as a reviewed value; each needs a reason beside it. */
export const REVIEWED_PROBE_STATUSES = ["manual", "partial"] as const
export type ReviewedProbeStatus = (typeof REVIEWED_PROBE_STATUSES)[number]

/** The five states a feature page can show. `undeclared` is temporary (28801 deletes it). */
export type ProbeCoverageStatus = "automated" | ReviewedProbeStatus | "unprobed" | "undeclared"

/** What the definitions alone settle; `null` leaves the row to its reviewed value, or to undeclared. */
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

/**
 * The one owner of a feature's status. A reviewed value wins, because a review is deliberate and
 * carries its reason; otherwise the definitions decide; a row with no definition at all reads
 * unprobed; a row the definitions cannot settle and no one reviewed reads undeclared.
 */
export function probeStatusOf(id: string, catalog: FeatureCatalog): ProbeCoverageStatus {
  const reviewed = catalog[id]?.probeStatus
  if (isReviewed(reviewed)) return reviewed
  const definition = BY_ID.get(id)
  if (!definition) return "unprobed"
  return derivedProbeStatus(definition) ?? "undeclared"
}

export interface ProbeStatusSummary {
  counts: Record<ProbeCoverageStatus, number>
  /** Rows the definitions cannot settle and no one reviewed: the temporary `undeclared` value. */
  undeclared: string[]
  /** Rows with a definition whose reviewed value stands over a derivation the definitions DO settle. */
  gated: string[]
  /** Rows with no definition that carry a reviewed manual/partial value (manual by design). */
  noDefinition: string[]
}

/** One summary for every printer and for validate: the distribution, and the undeclared gap. */
export function probeStatusSummary(catalog: FeatureCatalog): ProbeStatusSummary {
  const counts: Record<ProbeCoverageStatus, number> = {
    automated: 0,
    partial: 0,
    manual: 0,
    unprobed: 0,
    undeclared: 0,
  }
  const undeclared: string[] = []
  const gated: string[] = []
  const noDefinition: string[] = []
  for (const id of featureIds(catalog)) {
    const reviewed = catalog[id]?.probeStatus
    const definition = BY_ID.get(id)
    if (isReviewed(reviewed)) {
      if (definition === undefined) noDefinition.push(id)
      else if (derivedProbeStatus(definition) !== null) gated.push(id)
    } else if (definition !== undefined && derivedProbeStatus(definition) === null) {
      undeclared.push(id)
    }
    counts[probeStatusOf(id, catalog)]++
  }
  return { counts, undeclared, gated, noDefinition }
}
