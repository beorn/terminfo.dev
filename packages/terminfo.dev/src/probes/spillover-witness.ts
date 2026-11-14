/**
 * Fold 3 of #34148: prove a window-declared mutation did not reach the app instance.
 *
 * A witness window B is opened by the same run, in the same app instance, and is never written to.
 * Reading a cell's attribute in B before and after the cell runs in window A decides the cell's real
 * reach: an unchanged B grades the cell as window-confined, a changed B means the declaration is
 * wrong and the run stops naming the cell and the attribute (@cto e6ae2880 condition 5).
 *
 * There is no default: an app outside the measured set refuses by name, a run with no second window
 * in its grant refuses every cell of this class, and an attribute the witness never read before the
 * cell refuses too. "Assume window" is not a reachable state here.
 *
 * Pure: the caller supplies the witness's readings. `readbackFor` in attribute-ledger.ts owns the
 * bytes and the bound, so the B read is the A read's query, not a second protocol.
 */

import { type LedgerAttribute, attributeKey } from "./attribute-ledger.ts"

/** The apps whose second window has been measured as a witness. Terminal.app first (@cto e6ae2880). */
export const WITNESS_APPS: ReadonlySet<string> = new Set(["terminal-app"])

export type WitnessAdmission = { readonly admitted: true } | { readonly admitted: false; readonly refusal: string }

/**
 * Whether this run may grade a window cell at all. `app` is the measured subject's id; `witness` says
 * whether the grant covers a second, unwritten window.
 */
export function witnessAdmission(input: {
  readonly app: string | undefined
  readonly witness: boolean
}): WitnessAdmission {
  if (!WITNESS_APPS.has(input.app ?? "")) {
    return {
      admitted: false,
      refusal: `spillover unmeasured for ${input.app ?? "this app"}: only ${[...WITNESS_APPS].join(", ")} has a measured witness window, so this app's window cells stay refused`,
    }
  }
  if (!input.witness) {
    return {
      admitted: false,
      refusal: "spillover unmeasured: no second window in this grant, so no cell can be shown to be window-confined",
    }
  }
  return { admitted: true }
}

export type SpilloverVerdict =
  | { readonly status: "unchanged" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "spilled"; readonly reason: string }

/**
 * One cell's cross-window check. `before` and `after` are the witness's parsed state words; `undefined`
 * is "the witness had no reading", never a pass.
 */
export function spilloverVerdict(input: {
  readonly attribute: LedgerAttribute
  readonly before: string | undefined
  readonly after: string | undefined
}): SpilloverVerdict {
  const key = attributeKey(input.attribute)
  if (input.before === undefined) {
    return {
      status: "refused",
      reason: `spillover unmeasured for ${key}: the witness window had no reading of it before this cell, so a change could not be told from an unchanged app instance`,
    }
  }
  if (input.after === undefined) {
    return {
      status: "refused",
      reason: `spillover unmeasured for ${key}: the witness window did not answer after this cell, and silence is not an unchanged instance`,
    }
  }
  if (input.after !== input.before) {
    return {
      status: "spilled",
      reason: `cell ${key} changed the app instance: the witness window read ${JSON.stringify(input.before)} before and ${JSON.stringify(input.after)} after, so this cell is not window-confined`,
    }
  }
  return { status: "unchanged" }
}

/** The run-fatal refusal a spilled cell raises, named like `MutationRestoreRefused`. */
export class SpilloverRefused extends Error {
  constructor(cell: string, verdict: Extract<SpilloverVerdict, { status: "spilled" | "refused" }>) {
    super(
      verdict.status === "spilled"
        ? `${cell} is not window-confined: ${verdict.reason}`
        : `${cell} cannot be shown window-confined: ${verdict.reason}`,
    )
    this.name = "SpilloverRefused"
  }
}
