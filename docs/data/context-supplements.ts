/**
 * Context supplements (issue 33119, @cto f7b7afb2): a second launch of a context's own terminal that may answer only
 * the feature ids it declares. A supplement is never a context. The collection keeps it on the default row, and the
 * one selection (selected-results.ts) reads it only for its declared ids, into the default context's open cell, so
 * every context key and every other cell stay as they are.
 *
 * A placed run names its supplement by exactly one recorded field (#33151, @cto 4a546051): `subject.permissions` for
 * a permission (clipboard read allowed), or `subject.config` for a documented user option of a multiplexer (Screen's
 * `truecolor on`). A configuration is never recorded as a permission.
 */

import { SCREEN_TRUECOLOR_CONFIG } from "../../packages/terminfo.dev/src/disposable-receipt.ts"

/**
 * The config a default mux run records: the launcher's `--arg muxConfig` (scripts/linux-container-run.sh). The
 * launcher test keeps the two equal. A mux run with any other config is a declared supplement or is refused.
 */
export const MUX_DEFAULT_CONFIG = "/out/mux-empty.conf"
/** The config a Screen `--mux-profile truecolor` run records; its one home is the receipt check that verifies it. */
export { SCREEN_TRUECOLOR_CONFIG }

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
  readonly permissions?: Readonly<Record<string, string>>
  /** Per mux id, the subject.config the launcher records for this supplement; it identifies a placed run. */
  readonly config?: Readonly<Record<string, string>>
  /**
   * May add a note-only marker to a decided default cell (#33151, @cto a2cb755c): the cell's status, reason and tests
   * are never touched. Without it, a decided default cell is never touched.
   */
  readonly notesDecided?: true
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

/**
 * Screen with its documented `truecolor on` option (#33151, @cto 918fccd1 rule 2): GNU Screen 5.0.2 emits 24-bit colour
 * only with it on (display.c:1349, :1386; screen.c:144; doc/screen.1:3572-3582). The base run stays the default
 * configuration; this run notes the decided truecolour rows and may fill the open one. The colour-stack rows are not
 * here: they decide from OSC 10 replies, not 38;2 output.
 */
export const TRUECOLOR_ON: ContextSupplement = {
  name: "truecolor-on",
  launcherArgs: ["--clipboard-profile", "default", "--mux-profile", "truecolor"],
  featureIds: ["sgr.fg.truecolor", "sgr.bg.truecolor", "extensions.truecolor"],
  qualifier: "with truecolor on",
  config: { screen: SCREEN_TRUECOLOR_CONFIG },
  notesDecided: true,
  silentIgnore: [],
  notInForce: "truecolor on by config, not proved in force",
  declaredDefaults: { screen: "by default: truecolor off (screen truecolor default off, 5.0.2)" },
}

/** The supplements each Linux row runs after its default launch, by context id: Apps and the Screen mux row. */
export const LINUX_SUPPLEMENTS: Readonly<Record<string, readonly ContextSupplement[]>> = {
  kitty: [READ_ALLOWED],
  ghostty: [READ_ALLOWED],
  alacritty: [READ_ALLOWED],
  xterm: [READ_ALLOWED],
  wezterm: [READ_ALLOWED],
  screen: [TRUECOLOR_ON],
}

/** Each supplement is named by exactly one recorded field; both or neither is refused when this module loads. */
export function checkSupplement(supplement: ContextSupplement): void {
  if ((supplement.permissions === undefined) === (supplement.config === undefined)) {
    throw new Error(
      `Context supplement ${supplement.name} must declare exactly one of permissions or config; it declares ${
        supplement.permissions === undefined ? "neither" : "both"
      }`,
    )
  }
}
for (const supplement of new Set(Object.values(LINUX_SUPPLEMENTS).flat())) checkSupplement(supplement)

/**
 * The declared supplement a placed run belongs to, from its id and the one field its supplement declares: an App's
 * recorded permissions, or a mux's recorded config. Undefined otherwise.
 */
export function supplementOf(subject: {
  kind: string
  id: string
  os: string | null
  config: string | null
  permissions: string | null
}): ContextSupplement | undefined {
  if ((subject.kind !== "term" && subject.kind !== "mux") || subject.os !== "linux") return undefined
  return (LINUX_SUPPLEMENTS[subject.id] ?? []).find((supplement) =>
    subject.kind === "term"
      ? subject.permissions !== null && supplement.permissions?.[subject.id] === subject.permissions
      : subject.config !== null && supplement.config?.[subject.id] === subject.config,
  )
}
