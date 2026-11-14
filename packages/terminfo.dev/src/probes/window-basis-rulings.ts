/**
 * Cells a window-scoped owner basis must refuse even though their footprint is `window`, with the
 * sentence each refusal gives. A footprint says how far an effect reaches; it cannot say the reach is
 * provable, and these are the cases where it is not (@cto 69ad9f37).
 *
 * Hand-written on purpose: these are rulings and traces that do not exist, not facts derived from the
 * content tree. The derived half lives in `window-basis-table.ts`.
 */

/** Cells refused on a window basis by a ruling, with the sentence the refusal gives. */
export const WINDOW_BASIS_RULING_EXCLUSIONS: Readonly<Record<string, string>> = {
  "reset.soft":
    "DECSTR clears the saved cursor and the charset tables as well as the modes; neither has a readback, so the restore cannot be proven and reading the defaults back after the reset proves the reset, not the restore",
  "modes.application-cursor":
    "no retained trace: the collector recorded no write events for this cell, so the attributes it touches cannot be derived and there is nothing to pre-seed",
  "modes.mouse-all":
    "no retained trace: the collector recorded no write events for this cell, so the attributes it touches cannot be derived and there is nothing to pre-seed",
  "modes.mouse-sgr":
    "no retained trace: the collector recorded no write events for this cell, so the attributes it touches cannot be derived and there is nothing to pre-seed",
  "modes.mouse-tracking":
    "no retained trace: the collector recorded no write events for this cell, so the attributes it touches cannot be derived and there is nothing to pre-seed",
}
