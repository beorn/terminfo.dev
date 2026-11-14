/**
 * What a mutation probe may touch, declared once per probe id.
 *
 * A window-scoped owner basis admits a cell only when its footprint is `window`. `app-instance` and
 * `machine` cells refuse, and the refusal names the footprint (#34148, @cto a4fc490d condition 1).
 * A probe that needs a disposal grant and is missing here has an UNDECLARED footprint and refuses at
 * admission — never a default.
 *
 * The split is decided from what the callback does, not the feature's name. Two entries were checked
 * against their bodies because their names suggest wider effects:
 * - `modes.color-scheme-reporting` sets and resets reporting mode 2031 on this surface
 *   (`helpers.ts` decrpmModeProbe); it does not flip the system appearance.
 * - `modes.focus-tracking` moves OS focus to a helper window and back, proven by its own focus
 *   witness (`input.ts` focusTracking1004); it writes no preference.
 *
 * `app-instance` is refused pending measurement: Terminal.app may hold one colour table per app
 * instance, so a throwaway window may still mutate shared state. The OSC 4 cross-window read decides
 * it (@cto condition 4). `machine` is refused outright.
 */
export type TermFootprint = "window" | "app-instance" | "machine"

/**
 * What a verified owner basis covers. The process arm (a terminal process this run started) covers
 * its whole app instance and admits every footprint, exactly as it does today. The window arm covers
 * the one window the run opened, so it admits `window` cells only.
 */
export type OwnerBasisScope = "process" | "window"

/** Why a footprint is not `window`, where that is not obvious from the id alone. */
export const TERM_FOOTPRINT_NOTES: Readonly<Record<string, string>> = {
  "modes.color-scheme-reporting":
    "sets then resets reporting mode 2031 on this surface only; no system appearance change",
  "modes.focus-tracking": "moves OS focus to a helper window and back, proven by its focus witness",
  "extensions.osc22-pointer":
    "pointer shape per surface; pointer position is a transient global effect with a readback restore",
  "modes.bracketed-paste": "reaches the pasteboard; clipboard custody is not window custody",
}

export const TERM_FOOTPRINTS: Readonly<Record<string, TermFootprint>> = {
  // Window-confined: mode state, own grid, own window geometry.
  "modes.alt-screen.enter": "window",
  "modes.application-cursor": "window",
  "modes.auto-wrap": "window",
  "modes.deccolm": "window",
  "modes.decsclm": "window",
  "modes.reverse-video": "window",
  "modes.synchronized-output": "window",
  "reset.soft": "window",
  "extensions.reflow": "window",
  "text.wrap": "window",
  "scrollback.viewport-hold-output": "window",
  "modes.color-scheme-reporting": "window",
  "modes.focus-tracking": "window",
  "modes.mouse-tracking": "window",
  "modes.mouse-sgr": "window",
  "modes.mouse-all": "window",
  "modes.utf8-mouse-1005": "window",
  "extensions.osc22-pointer": "window",

  // App-instance: colour/cursor/highlight tables that may be shared across windows. Refused until
  // the OSC 4 cross-window read measures them.
  "extensions.osc104-reset-palette": "app-instance",
  "extensions.osc110-reset-fg": "app-instance",
  "extensions.osc111-reset-bg": "app-instance",
  "extensions.osc112-reset-cursor": "app-instance",
  "extensions.osc113-reset-pointer-fg": "app-instance",
  "extensions.osc114-reset-pointer-bg": "app-instance",
  "extensions.osc117-reset-highlight-bg": "app-instance",
  "extensions.osc119-reset-highlight-fg": "app-instance",

  // Machine: shared pasteboard.
  "modes.bracketed-paste": "machine",
}

/** The footprint a probe declares, or undefined when it declares none. */
export function termFootprintFor(id: string): TermFootprint | undefined {
  return TERM_FOOTPRINTS[id]
}

/**
 * Does a basis with this scope cover this cell's footprint?
 * - no scope on the basis refuses (a basis must say what it covers)
 * - an undeclared footprint refuses
 * - `process` covers everything the run's own terminal process owns, which is the whole instance —
 *   the behaviour every existing process-owned run has today, unchanged
 * - `window` admits `window` cells only
 */
export function basisScopeAdmits(scope: OwnerBasisScope | undefined, id: string): boolean {
  if (scope === undefined) return false
  const footprint = TERM_FOOTPRINTS[id]
  if (footprint === undefined) return false
  return scope === "process" ? true : footprint === "window"
}

/** The refusal sentence names the cell, its declared footprint and the basis scope it met. */
export function basisScopeRefusal(scope: OwnerBasisScope | undefined, id: string): string {
  const footprint = TERM_FOOTPRINTS[id]
  const what = footprint === undefined ? `footprint undeclared for ${id}` : `${id} declares footprint ${footprint}`
  return scope === undefined
    ? `${what}; this owner basis declares no scope, so it covers nothing`
    : `${what}; a ${scope}-scoped owner basis does not cover it`
}
