/**
 * Which cells a window-scoped owner basis may admit, and what to read before the first write.
 *
 * A footprint says how far a cell's effect reaches (probe-defs' `TERM_FOOTPRINTS`). It does not say
 * the reach is PROVABLE, and a window basis may only admit what it can prove it put back. This module
 * is that second decision, in the order it is made:
 *
 * 1. A ruling exclusion refuses by name before any byte — DECSTR, and the cells with no retained
 *    trace (@cto 69ad9f37). These are hand-written because they are rulings, not derived facts.
 * 2. A cell whose retained writes are not each one namable sequence refuses by name, because the
 *    ledger would otherwise hit an unclassifiable write at run time, which is run-fatal (@cto
 *    0.29.2 ruling point 2). The list is generated from the traces by
 *    `scripts/generate-window-basis-table.ts`, never guessed here.
 * 3. Anything else admits, with the pre-seed the ledger reads before the cell's first write and the
 *    state that cell's own cleanup leaves. Those are different values on purpose: a probe resets to the
 *    DEFAULT, not to the state it found, so a terminal that starts non-default would make pre differ
 *    from post and the ledger would stop the run. The caller compares the pre-read against the target
 *    and refuses the cell by name when they differ (@dev/brain e1b6910e1 review 1).
 *
 * A cell in none of the three is refused as unlisted, loudly: silence would admit a cell nobody
 * derived an admission for.
 */
import type { LedgerAttribute } from "./attribute-ledger.ts"
import {
  WINDOW_BASIS_PRE_SEED,
  WINDOW_BASIS_RESTORE_TARGET,
  WINDOW_BASIS_UNCLASSIFIABLE,
} from "./window-basis-table.ts"

import { WINDOW_BASIS_RULING_EXCLUSIONS } from "./window-basis-rulings.ts"

export type WindowBasisAdmission =
  | {
      readonly admitted: true
      readonly preSeed: readonly LedgerAttribute[]
      /** The state this cell's own cleanup leaves, per attribute key, as the readback reports it. */
      readonly restoreTarget: Readonly<Record<string, string>>
    }
  | { readonly admitted: false; readonly reason: string }

/** The admission decision for one cell under a window-scoped owner basis. */
export function windowBasisAdmission(id: string): WindowBasisAdmission {
  const ruling = WINDOW_BASIS_RULING_EXCLUSIONS[id]
  if (ruling !== undefined) return { admitted: false, reason: `${id} is not admitted on a window basis: ${ruling}` }
  const unclassifiable = WINDOW_BASIS_UNCLASSIFIABLE[id]
  if (unclassifiable !== undefined) {
    return { admitted: false, reason: `${id} is not admitted on a window basis: ${unclassifiable}` }
  }
  const preSeed = WINDOW_BASIS_PRE_SEED[id]
  if (preSeed !== undefined) return { admitted: true, preSeed, restoreTarget: WINDOW_BASIS_RESTORE_TARGET[id] ?? {} }
  return {
    admitted: false,
    reason:
      `${id} is not admitted on a window basis: it appears in no window-basis table entry, so no attribute ` +
      `pre-seed was derived for it; run bun scripts/generate-window-basis-table.ts if its trace is new`,
  }
}
