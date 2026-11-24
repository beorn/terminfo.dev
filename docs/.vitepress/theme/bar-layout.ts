/**
 * Pure placement, anchor, and single-popover coordination helpers for SupportBar,
 * ResultEvidenceCell hover cards, and result row scroll targets (#37631).
 */

/** Hover-intent delay before opening any hover card so sweeping across pills opens nothing. */
export const HOVER_OPEN_DELAY_MS = 300
/** Short grace period on pointer leave before closing an unpinned card. */
export const HOVER_CLOSE_GRACE_MS = 180

let activePopoverClose: (() => void) | undefined

/**
 * Page-wide single-popover coordinator (#37631): opening any SupportBar card or ResultEvidenceCell
 * preview immediately closes whichever card was previously open.
 */
export function registerActivePopover(close: () => void): void {
  if (activePopoverClose !== undefined && activePopoverClose !== close) {
    activePopoverClose()
  }
  activePopoverClose = close
}

/** Release coordinator ownership when the active popover closes on its own. */
export function clearActivePopover(close: () => void): void {
  if (activePopoverClose === close) activePopoverClose = undefined
}

/**
 * Horizontal shift (px from the bar's left edge) for SupportBar's segment hover popover.
 * Anchors the popover's left edge to the hovered segment so the pointer moves straight down
 * onto the card without leaving it, while keeping at least `margin` px inside both viewport edges.
 */
export function segmentPopoverShift(input: {
  readonly barLeft: number
  readonly segmentLeft: number
  readonly popWidth: number
  readonly pageWidth: number
  readonly margin?: number
}): number {
  const margin = input.margin ?? 16
  const anchorOffset = input.segmentLeft - input.barLeft
  const minShift = margin - input.barLeft
  const maxShift = input.pageWidth - margin - input.popWidth - input.barLeft
  return Math.max(minShift, Math.min(anchorOffset, maxShift))
}

export type DetailPaneSide = "right" | "left" | "below"

/**
 * Placement for the cascading feature-result pane attached to a SupportBar hover card.
 * Below 600 px viewport width it opens inline below the hovered/focused row; otherwise it
 * attaches to the right side of the hover card, flipping to the left if there is not room on the right.
 */
export function detailPaneSide(input: {
  readonly popLeft: number
  readonly popWidth: number
  readonly detailWidth: number
  readonly pageWidth: number
  readonly margin?: number
}): DetailPaneSide {
  if (input.pageWidth < 600) return "below"
  const margin = input.margin ?? 16
  if (input.popLeft + input.popWidth + input.detailWidth <= input.pageWidth - margin) return "right"
  if (input.popLeft - input.detailWidth >= margin) return "left"
  return "right"
}

function slugifyAnchor(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
}

/** Stable DOM anchor for a feature row on terminal, home, baseline, and compare pages. */
export function featureAnchorId(featureId: string): string {
  return `feature-${slugifyAnchor(featureId)}`
}

/** Stable DOM anchor for a terminal row on feature pages. */
export function termAnchorId(termSlug: string): string {
  return `term-${slugifyAnchor(termSlug)}`
}
