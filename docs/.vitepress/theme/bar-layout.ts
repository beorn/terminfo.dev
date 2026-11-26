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

/**
 * Vertical placement of SupportBar's hover card in viewport px (#37631, #38757): below the bar, or flipped above it
 * when the room below is short and the room above is larger. `maxHeight` is the room on the chosen side, so the
 * card's list scrolls inside the viewport instead of the card running past its bottom edge.
 */
export function popoverVerticalPlacement(input: {
  readonly barTop: number
  readonly barBottom: number
  readonly popHeight: number
  readonly viewportHeight: number
}): { top: number; flipped: boolean; maxHeight: number } {
  const viewH = input.viewportHeight
  const belowTop = Math.round(input.barBottom + 6)
  const roomBelow = viewH - belowTop - 12
  const roomAbove = input.barTop - 18
  const flipped = roomBelow < Math.min(input.popHeight, 260) && roomAbove > roomBelow
  if (flipped) {
    return {
      top: Math.max(12, Math.round(input.barTop - 6 - Math.min(input.popHeight, roomAbove))),
      flipped,
      maxHeight: roomAbove,
    }
  }
  const top = Math.max(12, Math.min(belowTop, Math.max(12, viewH - 120)))
  return { top, flipped, maxHeight: viewH - 12 - top }
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

/** The cascading result pane's tallest frame; a shorter viewport lowers it (#38757). */
export const DETAIL_PANE_MAX_HEIGHT = 560

/**
 * Vertical placement of the cascading result pane, in px from the hover card's top (#37631, #38757). The pane opens
 * beside the hovered row and moves up only as far as its whole frame needs to fit the viewport; it is never taller
 * than the viewport allows, so a longer card scrolls inside it instead of painting past its frame. The seam arrow
 * keeps pointing at the row's centre. `paneHeight` is the pane's rendered height (0 before it renders).
 */
export function detailPanePlacement(input: {
  readonly popTop: number
  readonly popHeight: number
  readonly rowTop: number
  readonly rowHeight: number
  readonly paneHeight: number
  readonly viewportHeight: number
  readonly margin?: number
}): { top: number; notchTop: number; maxHeight: number } {
  const margin = input.margin ?? 12
  const maxHeight = Math.min(
    DETAIL_PANE_MAX_HEIGHT,
    Math.round(input.viewportHeight * 0.74),
    input.viewportHeight - 2 * margin,
  )
  const height = Math.min(input.paneHeight || maxHeight, maxHeight)
  const rowOffset = input.rowTop - input.popTop
  const besideRow = Math.max(0, Math.min(rowOffset - 10, Math.max(0, input.popHeight - 160)))
  const top = Math.round(
    Math.max(margin - input.popTop, Math.min(besideRow, input.viewportHeight - margin - height - input.popTop)),
  )
  const notchTop = Math.round(Math.max(16, Math.min(rowOffset + input.rowHeight / 2 - top, height - 16)))
  return { top, notchTop, maxHeight }
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
