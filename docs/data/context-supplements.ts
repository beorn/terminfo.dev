/**
 * Context supplements (issue 33119, @cto f7b7afb2): a second launch of a context's own terminal that may answer only
 * the feature ids it declares. A supplement is never a context. The collection keeps it on the default row, and the
 * one selection (selected-results.ts) reads it only for its declared ids, into the default context's open cell, so
 * every context key and every other cell stay as they are.
 */

export interface ContextSupplement {
  /** The supplement's name in the pass, its output directory and its cell marker. */
  readonly name: string
  /** Launcher flags that replace the default row's `--clipboard-profile default` pair. */
  readonly launcherArgs: readonly string[]
  /** The only feature ids this supplement may answer; the run measures exactly these. */
  readonly featureIds: readonly string[]
  /** Shown beside a cell the supplement filled. */
  readonly qualifier: string
  /** Per App id, the subject.permissions the launcher records for this supplement; it identifies a placed run. */
  readonly permissions: Readonly<Record<string, string>>
  /**
   * App ids whose pinned version ignores an unknown setting without a word (@cto f7b7afb2). For these, a reply proves
   * the setting in force; no reply leaves the default cell open with `notInForce` as its reason.
   */
  readonly silentIgnore: readonly string[]
  readonly notInForce: string
  /** Per App id, what the terminal does by default, as declared from its pinned version. Declared, never measured. */
  readonly declaredDefaults: Readonly<Record<string, string>>
}

const allowed = "clipboard: read=allow,write=allow"

export const READ_ALLOWED: ContextSupplement = {
  name: "read-allowed",
  launcherArgs: ["--clipboard-profile", "allow"],
  featureIds: ["extensions.osc52-read", "extensions.osc52-clipboard"],
  qualifier: "with clipboard read allowed",
  permissions: {
    kitty: allowed,
    ghostty: allowed,
    alacritty: allowed,
    xterm: allowed,
    wezterm: "clipboard: read=no-setting,write=allow",
  },
  silentIgnore: ["alacritty", "xterm"],
  notInForce: "read allowed by setting, not proved in force",
  declaredDefaults: {
    kitty: "by default: asks first (kitty clipboard_control default, 0.49.2)",
    ghostty: "by default: asks first (ghostty clipboard-read = ask, 1.4.0)",
    alacritty: "by default: read off (alacritty terminal.osc52 = OnlyCopy, 0.17.0)",
    xterm: "by default: read off (xterm disallowedWindowOps includes GetSelection, 411)",
  },
}

/** The supplements each Linux App row runs after its default launch. Mux rows run none. */
export const LINUX_SUPPLEMENTS: Readonly<Record<string, readonly ContextSupplement[]>> = {
  kitty: [READ_ALLOWED],
  ghostty: [READ_ALLOWED],
  alacritty: [READ_ALLOWED],
  xterm: [READ_ALLOWED],
  wezterm: [READ_ALLOWED],
}

/** The declared supplement a placed run belongs to, from its App id and recorded permissions; undefined otherwise. */
export function supplementOf(subject: {
  kind: string
  id: string
  os: string | null
  permissions: string | null
}): ContextSupplement | undefined {
  if (subject.kind !== "term" || subject.os !== "linux" || subject.permissions === null) return undefined
  return (LINUX_SUPPLEMENTS[subject.id] ?? []).find(
    (supplement) => supplement.permissions[subject.id] === subject.permissions,
  )
}
