/**
 * A feature's probe status, DERIVED at build time from the probe definitions (28792 item 4).
 *
 * The catalog no longer carries a hand-kept `probeStatus` for every row: a feature with a probe
 * definition reads automated, one without reads unprobed, and the two editorial states a definition
 * cannot express stay as a reviewed catalog override, each with its reason. Deriving the bulk is
 * what stops the value drifting from the definitions; before this, 15 rows said manual or unprobed
 * while a probe existed.
 */
import { ALL_PROBES } from "@terminfo/probe-defs"
import type { FeatureCatalog } from "@terminfo/catalog"

/** The two statuses a catalog row may declare as a reviewed override; each carries a reason. */
export const REVIEWED_PROBE_STATUSES = ["manual", "partial"] as const
export type ReviewedProbeStatus = (typeof REVIEWED_PROBE_STATUSES)[number]

/** The four states a feature page can show. */
export type ProbeStatus = "automated" | ReviewedProbeStatus | "unprobed"

const DEFINED = new Set(ALL_PROBES.map((probe) => probe.id))

/**
 * The one owner of the derivation. A catalog override (manual or partial) wins; otherwise a probe
 * definition means automated and its absence means unprobed. A curated `automated` or `unprobed`
 * value is not an override and is ignored, so the field cannot disagree with the definitions.
 */
export function probeStatusOf(id: string, catalog: FeatureCatalog): ProbeStatus {
  const override = catalog[id]?.probeStatus
  if (override === "manual" || override === "partial") return override
  return DEFINED.has(id) ? "automated" : "unprobed"
}
