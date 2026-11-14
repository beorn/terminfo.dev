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

/** A window-scoped basis admits exactly the `window` cells. */
export function windowBasisAdmits(id: string): boolean {
  return TERM_FOOTPRINTS[id] === "window"
}

/** The refusal sentence names the cell and its declared footprint; undeclared refuses too. */
export function footprintRefusal(id: string): string {
  const footprint = TERM_FOOTPRINTS[id]
  return footprint === undefined
    ? `footprint undeclared for ${id}`
    : `${id} declares footprint ${footprint}; a window-scoped owner basis admits window cells only`
}
