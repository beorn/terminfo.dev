/**
 * The ONE app-id → bundle-id table (@cto 2026-11-13, F1 on f3f5e725b).
 *
 * It is a leaf on purpose: no imports at all. `packages/terminfo.dev` is the published CLI, so a table it needs
 * must not drag the admin package in behind it, and the admin registry must not keep a second copy that can drift.
 * `packages/admin/src/app.ts` builds every APPS row's bundle id FROM here, and the ordinary-open collector reads
 * the same entries statically.
 *
 * A key is the terminfo subject id (which is also the admin app id). A subject with no key here has no bundle, and
 * a caller that needs one refuses by name rather than guessing (§ the ordinary-open start refusals).
 */
export const APP_BUNDLE_IDS = {
  ghostty: "com.mitchellh.ghostty",
  iterm2: "com.googlecode.iterm2",
  "terminal-app": "com.apple.Terminal",
  kitty: "net.kovidgoyal.kitty",
  wezterm: "com.github.wez.wezterm",
  cursor: "com.todesktop.230313mzl4w4u92",
  // VSCode's admin id is its bundle id (298); the entry is correct even though the two strings coincide.
  "com.microsoft.VSCode": "com.microsoft.VSCode",
  warp: "dev.warp.Warp-Stable",
} as const satisfies Record<string, string>

/** The bundle id for `id`, or undefined when the table has no row — never a fallback string. */
export function appBundleId(id: string): string | undefined {
  return (APP_BUNDLE_IDS as Record<string, string>)[id]
}
