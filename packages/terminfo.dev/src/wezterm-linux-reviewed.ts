/**
 * Audited WezTerm Linux Nix builds, grouped by feature contract (#38127, @cto 146524d0 / 15dada37).
 *
 * Exact versions only — a new Nix build is refused loudly until its upstream diff is audited and
 * added here with its git revision and source citation. Keeping one named constant per feature
 * group makes an audited bump a single-file data edit instead of 26 scattered rows across 4 files.
 */

export interface ReviewedWezTermLinuxBuild {
  readonly version: string
  readonly rev: string
  readonly audit: string
}

const BUILD_2026_10_10: ReviewedWezTermLinuxBuild = {
  version: "0-unstable-2026-10-10",
  rev: "e2a98e1b8af1",
  audit: "33628 (@cto 1957): direct source audit of rev e2a98e1b8af1",
}

const BUILD_2026_11_08: ReviewedWezTermLinuxBuild = {
  version: "0-unstable-2026-11-08",
  rev: "458a100c1bf4",
  audit: "34932/34961 (@cto cc2dac5d, 146524d0): e2a98e1b8af1..458a100c1bf4 touches only docs/config/lua/config/ssh_backend.md and get-deps",
}

const BUILD_2026_11_20: ReviewedWezTermLinuxBuild = {
  version: "0-unstable-2026-11-20",
  rev: "ee6f3044d09f",
  audit:
    "@cto GO 146524d0: 458a100c1bf4..ee6f3044d09f leaves osc.rs, performer.rs, mux/src/lib.rs and wezterm/src/cli/ byte-identical; x11/cursor.rs only ::max_value() -> ::MAX; dbus.rs only urgency 2 -> 1",
}

/** Semantic-state report readers, DBus notification rows, OSC 133 declarations, and OSC 8 reader (22 rows/version). */
export const WEZTERM_LINUX_SEMANTIC_BUILDS: readonly ReviewedWezTermLinuxBuild[] = [
  BUILD_2026_11_08,
  BUILD_2026_11_20,
]

/** OSC 52 ? default posture citations (no clipboard-read reply or setting). */
export const WEZTERM_LINUX_CLIPBOARD_READ_DEFAULTS = [
  {
    posture: "absent" as const,
    version: BUILD_2026_11_08.version,
    source:
      "wezterm 458a100c1bf4 wezterm-escape-parser/src/osc.rs:176 parses OSC 52 ? as QuerySelection, and " +
      "term/src/terminalstate/performer.rs:792 handles it as QuerySelection(_) => {}: no reply, no setting",
  },
  {
    posture: "absent" as const,
    version: BUILD_2026_11_20.version,
    source:
      "wezterm ee6f3044d09f (audit 458a100c1bf4..ee6f3044d09f, @cto GO 146524d0): wezterm-escape-parser/src/osc.rs:176 " +
      "and term/src/terminalstate/performer.rs:792 are byte-identical — OSC 52 ? QuerySelection(_) => {}: no reply, no setting",
  },
] as const

/** Synchronized output (?2026) rendered-hold grading (mux/src/lib.rs). */
export const WEZTERM_LINUX_SYNC_OUTPUT_BUILDS: readonly ReviewedWezTermLinuxBuild[] = [
  BUILD_2026_10_10,
  BUILD_2026_11_08,
  BUILD_2026_11_20,
]
export const WEZTERM_LINUX_SYNC_OUTPUT_VERSIONS: ReadonlySet<string> = new Set(
  WEZTERM_LINUX_SYNC_OUTPUT_BUILDS.map((entry) => entry.version),
)

/** OSC 22 pointer-image capture route (window/src/os/x11/cursor.rs). */
export const WEZTERM_LINUX_POINTER_IMAGE_BUILDS: readonly ReviewedWezTermLinuxBuild[] = [
  BUILD_2026_10_10,
  BUILD_2026_11_08,
  BUILD_2026_11_20,
]
export const WEZTERM_LINUX_POINTER_IMAGE_VERSIONS: ReadonlySet<string> = new Set(
  WEZTERM_LINUX_POINTER_IMAGE_BUILDS.map((entry) => entry.version),
)

/** Owned CLI OSC 7 CWD readback (wezterm/src/cli/, osc.rs, performer.rs). */
export const WEZTERM_LINUX_OSC7_CLI_BUILDS: readonly ReviewedWezTermLinuxBuild[] = [
  BUILD_2026_10_10,
  BUILD_2026_11_08,
  BUILD_2026_11_20,
]
export const WEZTERM_LINUX_OSC7_CLI_VERSIONS: ReadonlySet<string> = new Set(
  WEZTERM_LINUX_OSC7_CLI_BUILDS.map((entry) => entry.version),
)
