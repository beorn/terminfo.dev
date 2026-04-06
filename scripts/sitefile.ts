/**
 * sitefile.ts — Content manifest for terminfo.dev
 *
 * Single source of truth for:
 * - Upstream sources (specs, vendor docs, proposals, release feeds)
 * - Tracked terminals (what we probe and how)
 * - Freshness SLAs (how stale is too stale)
 * - Explicit ignores (what we intentionally skip)
 *
 * Usage:
 *   bun scripts/sitefile.ts                    # Validate manifest + generate lockfile
 *   bun scripts/sitefile.ts --check            # Check freshness against SLAs
 *   bun -e "import { sources } from './scripts/sitefile.ts'; console.log(sources.length, 'sources')"
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Source {
  id: string
  type: "spec" | "vendor-doc" | "proposal" | "release-feed"
  label: string
  url: string
  description: string
  freshnessDays: number
  definesFeatures: boolean
  definesSupport: boolean
  featureFamilies: string[]
}

export interface TrackedTerminal {
  id: string
  label: string
  releaseUrl: string
  currentVersion: string
  probeMethod: "termless" | "app" | "server" | "manual"
}

export interface FreshnessSLA {
  contentType:
    | "probe-data"
    | "analysis"
    | "feature-metadata"
    | "terminal-metadata"
  maxAgeDays: number
}

export interface ExplicitIgnore {
  sourceId: string
  item: string
  reason: string
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const sources: Source[] = [
  // --- Formal standards ---
  {
    id: "ecma-48",
    type: "spec",
    label: "ECMA-48 (ISO 6429)",
    url: "https://ecma-international.org/publications-and-standards/standards/ecma-48/",
    description:
      "The foundational standard for terminal control sequences. Defines CSI grammar, SGR parameters, cursor movement, erase operations, and mode switching. 5th edition (1991), frozen since.",
    freshnessDays: 365, // frozen standard, annual check sufficient
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: [
      "sgr",
      "cursor",
      "erase",
      "editing",
      "text",
      "modes",
      "reset",
    ],
  },
  {
    id: "uax11",
    type: "spec",
    label: "UAX #11 East Asian Width",
    url: "https://unicode.org/reports/tr11/",
    description:
      "Unicode Standard Annex defining character width classes (narrow, wide, ambiguous). Determines whether a character occupies 1 or 2 terminal columns.",
    freshnessDays: 180, // updates with Unicode releases (~annual)
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["unicode"],
  },
  {
    id: "vt100-spec",
    type: "spec",
    label: "DEC VT100 User Guide",
    url: "https://vt100.net/docs/vt100-ug/",
    description:
      "Original VT100 documentation (1978). Defines baseline terminal behavior: CSI grammar, cursor addressing, scroll regions, character sets.",
    freshnessDays: 365, // historical, never changes
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["cursor", "modes", "charsets", "scrollback"],
  },
  {
    id: "vt220-spec",
    type: "spec",
    label: "DEC VT220 Reference Manual",
    url: "https://vt100.net/docs/vt220-rm/contents.html",
    description:
      "VT220 documentation (1983). Adds editing operations (ICH, DCH, IL, DL), device attributes (DA1, DA2), 8-bit controls.",
    freshnessDays: 365,
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["editing", "device"],
  },
  {
    id: "vt510-spec",
    type: "spec",
    label: "DEC VT510 Reference Manual",
    url: "https://vt100.net/docs/vt510-rm/contents.html",
    description:
      "The most comprehensive DEC terminal specification (1993, 600+ pages). Definitive reference for DECTCEM, DECSCNM, scroll commands, and mode queries.",
    freshnessDays: 365,
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["cursor", "modes", "device", "scrollback"],
  },

  // --- De facto standards ---
  {
    id: "xterm-ctlseqs",
    type: "vendor-doc",
    label: "xterm ctlseqs",
    url: "https://invisible-island.net/xterm/ctlseqs/ctlseqs.html",
    description:
      "The de facto terminal specification. Maintained by Thomas Dickey (patch 400+). Defines 256-color, truecolor, mouse tracking, bracketed paste, OSC 8 hyperlinks, OSC 52 clipboard, and more.",
    freshnessDays: 30,
    definesFeatures: true,
    definesSupport: true,
    featureFamilies: [
      "sgr",
      "cursor",
      "modes",
      "input",
      "extensions",
      "device",
    ],
  },

  // --- Vendor documentation ---
  {
    id: "kitty-docs",
    type: "vendor-doc",
    label: "Kitty Protocol Extensions",
    url: "https://sw.kovidgoyal.net/kitty/protocol-extensions/",
    description:
      "Kitty keyboard protocol, graphics protocol, extended underline styles, and other Kitty-originated extensions.",
    freshnessDays: 30,
    definesFeatures: true,
    definesSupport: true,
    featureFamilies: ["extensions", "input", "sgr"],
  },
  {
    id: "iterm2-docs",
    type: "vendor-doc",
    label: "iTerm2 Escape Codes",
    url: "https://iterm2.com/documentation-escape-codes.html",
    description:
      "iTerm2 proprietary extensions under OSC 1337: inline images, cell size reporting, capability queries, annotations.",
    freshnessDays: 30,
    definesFeatures: true,
    definesSupport: true,
    featureFamilies: ["extensions"],
  },
  {
    id: "conemu-docs",
    type: "vendor-doc",
    label: "ConEmu ANSI Codes",
    url: "https://conemu.github.io/en/AnsiEscapeCodes.html",
    description:
      "ConEmu-originated OSC 9 subcommands: progress reporting, desktop notifications, tab manipulation. OSC 9;4 progress widely adopted.",
    freshnessDays: 90, // ConEmu is legacy, slow-moving
    definesFeatures: true,
    definesSupport: true,
    featureFamilies: ["extensions"],
  },
  {
    id: "mintty-docs",
    type: "vendor-doc",
    label: "mintty Control Sequences",
    url: "https://github.com/mintty/mintty/wiki/CtrlSeqs",
    description:
      "mintty-specific control sequences: OSC 440, 7700-series, and extensions for Windows terminal emulation.",
    freshnessDays: 90,
    definesFeatures: true,
    definesSupport: true,
    featureFamilies: ["extensions"],
  },
  {
    id: "foot-docs",
    type: "vendor-doc",
    label: "foot Control Sequences",
    url: "https://codeberg.org/dnkl/foot/src/branch/master/doc/foot-ctlseqs.7.scd",
    description:
      "foot terminal control sequence documentation. Covers OSC 176, OSC 555, and foot-specific extensions.",
    freshnessDays: 60,
    definesFeatures: true,
    definesSupport: true,
    featureFamilies: ["extensions"],
  },
  {
    id: "vte-docs",
    type: "vendor-doc",
    label: "VTE (GNOME Terminal Engine)",
    url: "https://gitlab.gnome.org/GNOME/vte",
    description:
      "VTE library powering GNOME Terminal, Tilix, and others. Source reference for OSC 6, 666, 3008 and VTE-specific behavior.",
    freshnessDays: 60,
    definesFeatures: true,
    definesSupport: true,
    featureFamilies: ["extensions"],
  },
  {
    id: "wezterm-docs",
    type: "vendor-doc",
    label: "WezTerm Documentation",
    url: "https://wezfurlong.org/wezterm/",
    description:
      "WezTerm escape sequence documentation. Supports Kitty keyboard, Kitty graphics, sixel, OSC 8, and extensive Unicode.",
    freshnessDays: 60,
    definesFeatures: false,
    definesSupport: true,
    featureFamilies: [],
  },

  // --- Proposals ---
  {
    id: "osc8-hyperlinks",
    type: "proposal",
    label: "OSC 8 Hyperlinks",
    url: "https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda",
    description:
      "Proposal for clickable hyperlinks in terminals via OSC 8. Widely adopted by Ghostty, iTerm2, WezTerm, foot, and most modern terminals.",
    freshnessDays: 180,
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["extensions"],
  },
  {
    id: "osc133-semantic-prompts",
    type: "proposal",
    label: "FinalTerm OSC 133 Semantic Prompts",
    url: "https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md",
    description:
      "Shell integration protocol marking prompt, command, and output boundaries. Adopted by iTerm2, VS Code, Ghostty, and others.",
    freshnessDays: 180,
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["extensions"],
  },
  {
    id: "fixterms-csiu",
    type: "proposal",
    label: "CSI u / fixterms Keyboard Protocol",
    url: "http://www.leonerd.org.uk/hacks/fixterms/",
    description:
      "Paul Evans' original CSI u proposal for unambiguous keyboard encoding. Basis for Kitty keyboard protocol.",
    freshnessDays: 365, // historical proposal, stable
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["input"],
  },
  {
    id: "mode-2026-sync-output",
    type: "proposal",
    label: "Mode 2026 Synchronized Output",
    url: "https://gist.github.com/christianparpart/d8a62cc1ab659194571ec44c5a4eba40",
    description:
      "DEC private mode 2026 for synchronized rendering. Terminal buffers output until the application signals a frame is complete, eliminating flicker.",
    freshnessDays: 180,
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["modes"],
  },
  {
    id: "mode-2031-color-scheme",
    type: "proposal",
    label: "Mode 2031 Color Scheme Reporting",
    url: "https://github.com/contour-terminal/contour/blob/master/docs/vt-extensions/color-palette-update-notifications.md",
    description:
      "DEC private mode 2031 for dark/light mode detection and change notification. Enables apps to adapt to terminal theme changes.",
    freshnessDays: 180,
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["modes"],
  },
  {
    id: "vscode-osc633",
    type: "proposal",
    label: "VS Code OSC 633 Shell Integration",
    url: "https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration",
    description:
      "VS Code extension of FinalTerm OSC 133 with additional markers for command line capture, property reporting, and nonce verification.",
    freshnessDays: 60,
    definesFeatures: true,
    definesSupport: false,
    featureFamilies: ["extensions"],
  },

  // --- Release feeds ---
  {
    id: "release-ghostty",
    type: "release-feed",
    label: "Ghostty Releases",
    url: "https://github.com/ghostty-org/ghostty/releases",
    description: "GitHub releases for Ghostty terminal emulator.",
    freshnessDays: 14,
    definesFeatures: false,
    definesSupport: false,
    featureFamilies: [],
  },
  {
    id: "release-kitty",
    type: "release-feed",
    label: "Kitty Releases",
    url: "https://github.com/kovidgoyal/kitty/releases",
    description: "GitHub releases for Kitty terminal emulator.",
    freshnessDays: 14,
    definesFeatures: false,
    definesSupport: false,
    featureFamilies: [],
  },
  {
    id: "release-wezterm",
    type: "release-feed",
    label: "WezTerm Releases",
    url: "https://github.com/wez/wezterm/releases",
    description: "GitHub releases for WezTerm terminal emulator.",
    freshnessDays: 14,
    definesFeatures: false,
    definesSupport: false,
    featureFamilies: [],
  },
  {
    id: "release-foot",
    type: "release-feed",
    label: "foot Releases",
    url: "https://codeberg.org/dnkl/foot/releases",
    description: "Codeberg releases for foot terminal emulator.",
    freshnessDays: 14,
    definesFeatures: false,
    definesSupport: false,
    featureFamilies: [],
  },
  {
    id: "release-alacritty",
    type: "release-feed",
    label: "Alacritty Releases",
    url: "https://github.com/alacritty/alacritty/releases",
    description: "GitHub releases for Alacritty terminal emulator.",
    freshnessDays: 14,
    definesFeatures: false,
    definesSupport: false,
    featureFamilies: [],
  },
  {
    id: "release-windows-terminal",
    type: "release-feed",
    label: "Windows Terminal Releases",
    url: "https://github.com/microsoft/terminal/releases",
    description: "GitHub releases for Windows Terminal.",
    freshnessDays: 14,
    definesFeatures: false,
    definesSupport: false,
    featureFamilies: [],
  },
  {
    id: "release-iterm2",
    type: "release-feed",
    label: "iTerm2 Releases",
    url: "https://iterm2.com/downloads.html",
    description: "iTerm2 release downloads page.",
    freshnessDays: 14,
    definesFeatures: false,
    definesSupport: false,
    featureFamilies: [],
  },
  {
    id: "release-xtermjs",
    type: "release-feed",
    label: "xterm.js Releases",
    url: "https://github.com/xtermjs/xterm.js/releases",
    description: "GitHub releases for xterm.js terminal emulator library.",
    freshnessDays: 14,
    definesFeatures: false,
    definesSupport: false,
    featureFamilies: [],
  },
]

// ---------------------------------------------------------------------------
// Tracked terminals
// ---------------------------------------------------------------------------

export const terminals: TrackedTerminal[] = [
  // --- App-probed terminals ---
  {
    id: "ghostty",
    label: "Ghostty",
    releaseUrl: "https://github.com/ghostty-org/ghostty/releases",
    currentVersion: "1.3.1",
    probeMethod: "app",
  },
  {
    id: "kitty",
    label: "Kitty",
    releaseUrl: "https://github.com/kovidgoyal/kitty/releases",
    currentVersion: "0.46.2",
    probeMethod: "app",
  },
  {
    id: "iterm2",
    label: "iTerm2",
    releaseUrl: "https://iterm2.com/downloads.html",
    currentVersion: "3.6.9",
    probeMethod: "app",
  },
  {
    id: "terminal-app",
    label: "Terminal.app",
    releaseUrl:
      "https://support.apple.com/guide/terminal/welcome/mac",
    currentVersion: "2.15",
    probeMethod: "app",
  },
  {
    id: "warp",
    label: "Warp",
    releaseUrl: "https://www.warp.dev",
    currentVersion: "0.2026.03.18.08.24.03",
    probeMethod: "server",
  },
  {
    id: "cursor",
    label: "Cursor",
    releaseUrl: "https://cursor.com",
    currentVersion: "2.6.21",
    probeMethod: "server",
  },
  {
    id: "vscode",
    label: "VS Code",
    releaseUrl: "https://github.com/microsoft/vscode/releases",
    currentVersion: "1.113.0",
    probeMethod: "server",
  },

  // --- Headless-probed terminals (libraries) ---
  {
    id: "alacritty",
    label: "Alacritty",
    releaseUrl: "https://github.com/alacritty/alacritty/releases",
    currentVersion: "0.26.0",
    probeMethod: "termless",
  },
  {
    id: "wezterm",
    label: "WezTerm",
    releaseUrl: "https://github.com/wez/wezterm/releases",
    currentVersion: "0.1.0-fork.5",
    probeMethod: "termless",
  },
  {
    id: "xtermjs",
    label: "xterm.js",
    releaseUrl: "https://github.com/xtermjs/xterm.js/releases",
    currentVersion: "5.5.0",
    probeMethod: "termless",
  },
  {
    id: "vterm",
    label: "vterm.js",
    releaseUrl: "https://github.com/beorn/vterm",
    currentVersion: "0.2.0",
    probeMethod: "termless",
  },
  {
    id: "vt100",
    label: "vt100.js",
    releaseUrl: "https://github.com/beorn/vt100",
    currentVersion: "0.2.1",
    probeMethod: "termless",
  },

  // --- Intermediaries (multiplexer probes) ---
  {
    id: "tmux",
    label: "tmux",
    releaseUrl: "https://github.com/tmux/tmux/releases",
    currentVersion: "3.6a",
    probeMethod: "manual",
  },
  {
    id: "screen",
    label: "GNU Screen",
    releaseUrl: "https://www.gnu.org/software/screen/",
    currentVersion: "5.0.1",
    probeMethod: "manual",
  },
]

// ---------------------------------------------------------------------------
// Freshness SLAs
// ---------------------------------------------------------------------------

export const freshnessSLAs: FreshnessSLA[] = [
  {
    contentType: "probe-data",
    maxAgeDays: 30,
  },
  {
    contentType: "analysis",
    maxAgeDays: 30,
  },
  {
    contentType: "feature-metadata",
    maxAgeDays: 90,
  },
  {
    contentType: "terminal-metadata",
    maxAgeDays: 90,
  },
]

// ---------------------------------------------------------------------------
// Explicit ignores
// ---------------------------------------------------------------------------

export const explicitIgnores: ExplicitIgnore[] = [
  {
    sourceId: "xterm-ctlseqs",
    item: "Tektronix 4014 mode",
    reason:
      "Legacy vector graphics mode from 1970s. No modern terminal implements it meaningfully.",
  },
  {
    sourceId: "xterm-ctlseqs",
    item: "Sun function keys",
    reason: "Sun keyboard-specific key encoding. Not relevant to modern terminals.",
  },
  {
    sourceId: "xterm-ctlseqs",
    item: "HP function keys",
    reason: "HP terminal-specific key encoding. Not relevant to modern terminals.",
  },
  {
    sourceId: "ecma-48",
    item: "C1 control codes (0x80-0x9F) as 8-bit",
    reason:
      "8-bit C1 codes conflict with UTF-8 encoding. Only the 7-bit ESC-prefixed forms are tested.",
  },
  {
    sourceId: "vt510-spec",
    item: "VT510 dual-session mode",
    reason:
      "Hardware-specific feature for splitting a physical CRT into two sessions. No software emulator implements this.",
  },
  {
    sourceId: "mintty-docs",
    item: "Windows-specific DPI handling",
    reason: "Platform-specific to Windows. terminfo.dev probes primarily on macOS/Linux.",
  },
  {
    sourceId: "conemu-docs",
    item: "ConEmu GUI macros",
    reason:
      "ConEmu-specific GUI automation commands. Not terminal escape sequences.",
  },
]

// ---------------------------------------------------------------------------
// CLI: validate manifest + generate lockfile
// ---------------------------------------------------------------------------

async function generateLockfile() {
  const fs = await import("node:fs")
  const path = await import("node:path")

  const contentDir = path.join(import.meta.dir, "..", "content")
  const lockfilePath = path.join(import.meta.dir, "..", "scripts", "sitefile.lock.json")

  // Count features from features.json
  const featuresJson = JSON.parse(
    fs.readFileSync(path.join(contentDir, "features.json"), "utf-8"),
  )
  const featureKeys = Object.keys(featuresJson).filter(
    (k) => k !== "$comment",
  )
  const totalFeatures = featureKeys.length

  // Count features per family
  const featureFamilies: Record<string, number> = {}
  for (const key of featureKeys) {
    const family = key.split(".")[0]
    featureFamilies[family] = (featureFamilies[family] || 0) + 1
  }

  // Build source lock entries
  const sourceLock = sources.map((s) => {
    const familyCount = s.featureFamilies.reduce(
      (sum, fam) => sum + (featureFamilies[fam] || 0),
      0,
    )
    return {
      sourceId: s.id,
      lastChecked: new Date().toISOString().split("T")[0],
      extractedFeatureCount: s.definesFeatures ? familyCount : 0,
      notes: "",
    }
  })

  // Build terminal lock entries from probe files
  const terminalLock: Array<{
    terminalId: string
    lastProbedVersion: string
    lastProbedDate: string
    featureCount: number
    probeFile: string
  }> = []

  for (const terminal of terminals) {
    // Search across all probe directories
    const probeDirs = ["probes-apps", "probes-libs", "probes-mux"]
    let bestMatch: {
      file: string
      date: string
      count: number
      version: string
    } | null = null

    for (const dir of probeDirs) {
      const probeDir = path.join(contentDir, dir)
      if (!fs.existsSync(probeDir)) continue

      const files = fs.readdirSync(probeDir).filter((f: string) => f.endsWith(".json"))

      for (const file of files) {
        // Match by terminal id in filename
        const lowerFile = file.toLowerCase()
        const termId = terminal.id.toLowerCase()

        // Match patterns like "ghostty-1.3.1-macos.json", "alacritty-0.26.0.json",
        // "com-microsoft-vscode-1.113.0-macos.json", etc.
        const idVariants = [
          termId,
          termId.replace(/-/g, ""),
          // VS Code special case
          ...(termId === "vscode"
            ? ["com-microsoft-vscode", "com.microsoft.vscode"]
            : []),
          // screen special case: prefer latest version
          ...(termId === "screen" ? ["screen-5", "screen-4"] : []),
        ]

        const matches = idVariants.some(
          (variant) =>
            lowerFile.startsWith(variant + "-") ||
            lowerFile.startsWith(variant + "."),
        )

        if (matches) {
          const filePath = path.join(probeDir, file)
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
          const date = data.generated
            ? new Date(data.generated).toISOString().split("T")[0]
            : "unknown"
          const count = data.results
            ? Object.keys(data.results).length
            : 0

          // Extract version from filename
          const versionMatch = file.match(
            /(?:^[a-z0-9.-]+-)([\d][^-]*?)(?:-(?:macos|linux|windows))?\.json$/i,
          )
          const version = data.version || (versionMatch ? versionMatch[1] : terminal.currentVersion)

          // Prefer file matching currentVersion, then newer probe date, then later filename
          const matchesCurrentVersion =
            file.includes(terminal.currentVersion)
          const bestMatchesCurrent =
            bestMatch?.file.includes(terminal.currentVersion) ?? false

          const isBetter =
            !bestMatch ||
            (matchesCurrentVersion && !bestMatchesCurrent) ||
            (!bestMatchesCurrent &&
              !matchesCurrentVersion &&
              new Date(data.generated || 0) >
                new Date(
                  bestMatch.date === "unknown" ? 0 : bestMatch.date,
                ))

          if (isBetter) {
            bestMatch = { file, date, count, version }
          }
        }
      }
    }

    terminalLock.push({
      terminalId: terminal.id,
      lastProbedVersion: bestMatch?.version || terminal.currentVersion,
      lastProbedDate: bestMatch?.date || "never",
      featureCount: bestMatch?.count || 0,
      probeFile: bestMatch?.file || "none",
    })
  }

  const lockfile = {
    $comment:
      "Generated by scripts/sitefile.ts — do not edit by hand. Tracks current state of all sources and terminals.",
    generated: new Date().toISOString(),
    totalFeatures,
    featureFamilies,
    sources: sourceLock,
    terminals: terminalLock,
  }

  fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2) + "\n")
  console.log(`Written ${lockfilePath}`)
  console.log(`  ${totalFeatures} features across ${Object.keys(featureFamilies).length} families`)
  console.log(`  ${sources.length} sources`)
  console.log(`  ${terminals.length} terminals`)

  // Check freshness if --check flag
  if (process.argv.includes("--check")) {
    console.log("\nFreshness check:")
    const now = Date.now()
    let staleCount = 0

    for (const entry of terminalLock) {
      if (entry.lastProbedDate === "never" || entry.lastProbedDate === "unknown") {
        console.log(`  STALE: ${entry.terminalId} — never probed`)
        staleCount++
        continue
      }
      const age = Math.floor(
        (now - new Date(entry.lastProbedDate).getTime()) / (1000 * 60 * 60 * 24),
      )
      const sla = freshnessSLAs.find((s) => s.contentType === "probe-data")
      if (sla && age > sla.maxAgeDays) {
        console.log(
          `  STALE: ${entry.terminalId} — ${age} days old (SLA: ${sla.maxAgeDays} days)`,
        )
        staleCount++
      }
    }

    if (staleCount === 0) {
      console.log("  All terminals within freshness SLAs.")
    } else {
      console.log(`\n  ${staleCount} terminal(s) need re-probing.`)
    }
  }
}

// Run if executed directly
if (import.meta.main) {
  await generateLockfile()
}
