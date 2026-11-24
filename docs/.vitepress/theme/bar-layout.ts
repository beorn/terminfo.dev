/**
 * Pure horizontal placement for SupportBar's segment hover popover (#37631).
 * Anchors the popover's left edge to the hovered segment so the pointer moves
 * straight down onto the card without leaving it, while keeping at least
 * `margin` px inside both viewport edges.
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
