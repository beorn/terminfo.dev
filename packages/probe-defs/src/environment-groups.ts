/**
 * The ONE environment-group partition. Nine catalogue positions ask about the environment the engine
 * process was started in (TERM, COLORTERM, TERM_PROGRAM and friends). They are recorded
 * `probeStatus: "manual"` with the reason "manual by design: no automatable probe exists for this
 * feature", and they are not graded capabilities: no capture route reads the environment today, so
 * grading them would claim a measurement nobody made.
 *
 * Operator ruling D132 B (2026-10-23 20:03:29 PDT), CPO plan 16502c90: 264 graded capability entries
 * × 33 contexts = 8,712 graded positions, plus these nine × 33 = 297 visible ungraded positions —
 * 8,712 + 297 = 9,009, the same total as 273 × 33, differently partitioned. Runs keep recording 273.
 *
 * One declared list plus this predicate is the single home (@cto, verdict 74a0bd62): display sites ask
 * `isEnvironmentGroup` rather than keeping a second list, and `gradedFeatureIds` is derived from the
 * ids it is given, so no second arithmetic exists. The record this list mirrors is checked by a test,
 * never by a runtime refusal — a new load-time throw would be a new gate.
 */
export const ENVIRONMENT_GROUP_IDS = [
  "device.env-term",
  "device.env-colorterm",
  "device.env-term-program",
  "device.env-lc-terminal",
  "device.env-vte-version",
  "device.env-kitty",
  "device.env-wezterm",
  "device.env-wt-session",
  "device.env-no-color",
] as const

export type EnvironmentGroupId = (typeof ENVIRONMENT_GROUP_IDS)[number]

const ENVIRONMENT_GROUP_SET: ReadonlySet<string> = new Set(ENVIRONMENT_GROUP_IDS)

/** Whether `id` is one of the nine environment positions, never a graded capability. */
export function isEnvironmentGroup(id: string): boolean {
  return ENVIRONMENT_GROUP_SET.has(id)
}

/**
 * The graded members of `cohortIds`, in the order given. The nine environment positions are the only
 * ids removed; an id absent from the cohort is not invented, so a historical run whose catalogue lacks
 * some of the nine still gets its own honest graded count from the same rule.
 */
export function gradedFeatureIds(cohortIds: readonly string[]): string[] {
  return cohortIds.filter((id) => !isEnvironmentGroup(id))
}
