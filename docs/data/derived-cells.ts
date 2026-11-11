/**
 * Unsupported, derived (#33019, @cto 2300c1b4 / 1192f8b5 / 6588ac5f / ed184562): a child feature reads Unsupported
 * when its declared parent is DECIDED Unsupported, with its own direct witness, in the same context. The pairs are
 * data; the reader names no feature. Stored rows stay exactly as measured, and the parent is read live on every
 * projection, so a parent that is reopened or re-measured takes the child with it.
 */
import type { SelectedContextCell } from "./selected-results.ts"

export interface DerivedPair {
  readonly child: string
  readonly parent: string
  /** The parent as a reader knows it, for the cell's sentence. */
  readonly parentName: string
  /** Why the child needs the parent, completing "because …". */
  readonly needs: string
}

/** Every declared pair. Any pair beyond these goes to @cto first (33019 condition 5). */
export const DERIVED_UNSUPPORTED: readonly DerivedPair[] = [
  {
    child: "extensions.kitty-graphics.display",
    parent: "extensions.kitty-graphics.transmit",
    parentName: "Kitty graphics transmit",
    needs: "an image must be transmitted before it can be displayed",
  },
  {
    child: "extensions.kitty-graphics.animation",
    parent: "extensions.kitty-graphics.transmit",
    parentName: "Kitty graphics transmit",
    needs: "an animation's frames are transmitted images",
  },
  {
    child: "extensions.kitty-graphics.unicode-placeholders",
    parent: "extensions.kitty-graphics.transmit",
    parentName: "Kitty graphics transmit",
    needs: "a placeholder shows a transmitted image",
  },
  {
    child: "sgr.underline-color-reset",
    parent: "sgr.underline.color",
    parentName: "underline colour (SGR 58)",
    needs: "a terminal that cannot colour an underline has nothing to reset",
  },
  {
    child: "extensions.osc117-reset-highlight-bg",
    parent: "extensions.osc17-highlight-bg",
    parentName: "highlight background colour (OSC 17)",
    needs: "there is no highlight background colour to reset",
  },
  {
    child: "extensions.osc119-reset-highlight-fg",
    parent: "extensions.osc19-highlight-fg",
    parentName: "highlight foreground colour (OSC 19)",
    needs: "there is no highlight foreground colour to reset",
  },
]

/** Set only on a derived cell: the parent it was read from, and the child's own stored reading kept beside it. */
export interface DerivedMarker {
  readonly parent: string
  readonly parentName: string
  readonly parentRunId: string
  readonly parentReason: string | null
  readonly needs: string
  /** The child's own reading before derivation, so the move is visible and reversible. */
  readonly ownStatus: string
  /** The child's own stored refusal or reason, kept as a note (@cto ed184562 answer 3). */
  readonly ownReason: string | null
}

const cellStatus = (cell: SelectedContextCell) => cell.featureResult?.status ?? cell.result.status

/** A parent entails only when it is decided Unsupported by its own direct witness, never by derivation. */
function entailingParent(cell: SelectedContextCell | undefined): cell is SelectedContextCell {
  return (
    cell !== undefined &&
    cell.derived === undefined &&
    cellStatus(cell) === "unsupported" &&
    cell.result.status === "unsupported" &&
    cell.result.assertionType !== undefined
  )
}

/**
 * Derive the declared children of one context in place; returns the child ids it derived. A child already decided
 * Unsupported stays direct. A child reading Supported under an entailing parent throws: the table or a measurement
 * is wrong, and that comes to @cto. A conflicting or reopened child is left as it reads.
 */
export function applyDerived(
  contextKey: string,
  cells: Record<string, SelectedContextCell>,
  pairs: readonly DerivedPair[],
): string[] {
  const derived: string[] = []
  for (const pair of pairs) {
    const parent = cells[pair.parent]
    const child = cells[pair.child]
    if (!child || !entailingParent(parent)) continue
    const status = cellStatus(child)
    if (status === "supported") {
      throw new Error(
        `Derived pair ${pair.parent} -> ${pair.child} in ${contextKey}: the child reads Supported while the parent reads Unsupported with its own witness (run ${parent.run.runId}); the pair table or a measurement is wrong, bring it to @cto (#33019)`,
      )
    }
    if (status === "unsupported" || status === "probe-conflict" || child.reopened || !child.featureResult) continue
    cells[pair.child] = {
      ...child,
      featureResult: { ...child.featureResult, status: "unsupported", strength: null },
      derived: {
        parent: pair.parent,
        parentName: pair.parentName,
        parentRunId: parent.run.runId,
        parentReason: parent.result.reason ?? null,
        needs: pair.needs,
        ownStatus: status,
        ownReason: child.result.reason ?? null,
      },
    }
    derived.push(pair.child)
  }
  return derived
}

/** The words a derived cell shows wherever it is displayed. */
export function publicDerivedReason(marker: DerivedMarker): string {
  const witness = marker.parentReason ? ` (${marker.parentReason})` : ""
  return `Unsupported, derived: ${marker.parentName} was refused in run ${marker.parentRunId}${witness}; ${marker.needs}.`
}
