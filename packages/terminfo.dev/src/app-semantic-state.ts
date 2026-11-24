import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { readCallLog } from "viprobe"
import { ANSI_REGEX } from "@silvery/ansi"
import {
  MUX_TITLE_CONTROL_WRITE,
  settledTitle,
  sgrProbes,
  type AppSemanticReading,
  type LinuxMuxAttachmentProof,
  type ProbeSubject,
  type TermProbeSource,
} from "@terminfo/probe-defs"
import { kittyAncestor, type LiveExecutable } from "./linux-capture.ts"
import type { LinuxClipboardAdapter } from "./linux-clipboard.ts"
import { MUX_PROFILE_CONFIG_FILES } from "./disposable-receipt.ts"
import { readWindowsWezTermRows } from "./windows-wezterm-text.ts"
import type { ITermPromptRead, ITermPromptSession } from "./iterm2-protocol.ts"
import { retain as retainCaptureArtifact } from "./capture-core.ts"
import { WEZTERM_LINUX_SEMANTIC_BUILDS } from "./wezterm-linux-reviewed.ts"

// Reviewed declarations match the exact App/mux version.
// This is also the collector-side home for the owned semantic reader's App selection.
const promptFeatures = [
  "extensions.osc133-a",
  "extensions.osc133-b",
  "extensions.osc133-c",
  "extensions.osc133-d",
  "extensions.osc133-p",
  "extensions.semantic-prompts",
  "extensions.osc633-a",
  "extensions.osc633-b",
  "extensions.osc633-c",
  "extensions.osc633-d",
  "extensions.osc633-e",
  "extensions.osc633-p",
  "extensions.osc-633-vscode",
] as const

type AppSemanticCapability = {
  kind: string
  id: string
  version: string
  os: string
  featureId: string
  reason?: string
  requiresMissingSessionBus?: true
  outerCommands?: true
  reader?: "grid" | "cycle" | "cwd" | "report" | "osc8" | "kitty-prompt" | "kitty-cwd"
  command?: { code: string; body: string }
  reportControls?: {
    sentinel: { code: string; body: string; line: string }
    handled: { code: string; body: string; line: string }
    targetLine: string
  }
}

// 34841: the reachable reads of Terminal.app 2.15 on macOS 26.6.2, each exercised on an owned Mac on 2026-11-18.
const TERMINAL_APP_215_INVENTORY =
  "Exercised on Terminal.app 2.15 (bundle CDHash arm64 113489a0, x86_64 df446fa4) on macOS 26.6.2 build 25G83 at shipped settings, owned Mac, 2026-11-18: screen text through the scripting dictionary's contents and history; window pixels with View > Show Marks; Terminal's own line marks and Edit > Navigate > Select to Previous Mark, whose control (a keyboard prompt auto-mark) stops the selection, while after the emitted sequences the selection ran to the first line, so none left a navigable mark (this says nothing about hidden protocol state) - and the mark store is set by keyboard prompt marking with no protocol-created control, so it cannot decide this row; the accessibility tree of the window, walked completely (elements_complete true, 11 elements, every attribute, parameterized attribute and action listed), whose text area offers only AXValue screen text, selection ranges, line geometry and AXStringForRange plain text, with no attributed-string, style or mark attribute, and whose window AXDocument carries the working directory as a full file URL that follows OSC 7; the scripting dictionary (Terminal.sdef SHA256 efc515ec), whose tab properties are contents, history, processes, busy, tty and titles; and the window title and proxy icon, which show the AXDocument folder name."

const declarations: readonly AppSemanticCapability[] = [
  // CTO316a2912: this Mac apparatus cannot observe these rows; no capability verdict.
  ...[
    ...promptFeatures,
    "extensions.osc1-icon",
    "extensions.osc176-app-id",
    "extensions.osc3008-context",
    "extensions.osc440-audio",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
    "extensions.osc8",
  ].map((featureId) => ({
    kind: "term",
    id: "alacritty",
    version: "0.17.0",
    os: "macos",
    featureId,
    reason:
      "Untestable (no way): The selected Alacritty IPC surface reads configuration, not the terminal's parsed feature state. It provides no App-owned readback for this probe's unknown, independently handled, and target controls. This observation route cannot grade the feature; declare it untestable through this apparatus.",
  })),
  // Remove when either route rule changes: hosted pointer helper installed or owned-host rule changes.
  // These exact App routes are untestable under the current rules, not feature negatives (CTO2aabe241/fd05a5f1).
  ...[
    { id: "ghostty", version: "1.4.0" },
    { id: "alacritty", version: "0.17.0" },
    { id: "wezterm", version: "20240203-110809-5046fc22" },
    { id: "cursor", version: "3.25.9" },
    { id: "com.microsoft.VSCode", version: "1.142.0" },
    { id: "cmux", version: "0.65.2" },
    { id: "terminal-app", version: "2.15" },
    { id: "iterm2", version: "3.6.11" },
  ].flatMap((subject) =>
    ["extensions.osc22-pointer", "input.kitty-click-events", "modes.utf8-mouse-1005"]
      // A measured result beats a declaration (@cto b0de55c0): iTerm2's UTF-8 mouse mode read Supported on 26.6.2.
      .filter((featureId) => !(subject.id === "iterm2" && featureId === "modes.utf8-mouse-1005"))
      .map((featureId) => ({
        ...subject,
        kind: "term",
        os: "macos",
        featureId,
        reason: "no permitted pointer route: owned-host rule and hosted no-input rule",
      })),
  ),
  ...[
    { kind: "mux", id: "tmux", version: "3.8", os: "linux" },
    { kind: "mux", id: "screen", version: "5.0.2", os: "linux" },
  ].flatMap((subject) =>
    [...sgrProbes.map(({ id }) => id), "extensions.osc22-pointer"].map((featureId) => ({
      ...subject,
      featureId,
      outerCommands: true as const,
    })),
  ),
  // 33630: tmux only. These five rows read the outer terminal's own command record; Screen's rows for the same
  // features stay out of this slice and keep their existing arm.
  ...[
    "extensions.kitty-graphics",
    "extensions.osc701-locale",
    "extensions.osc702-version",
    "extensions.osc776-cell-size",
    "extensions.osc7770-font-size",
  ].map((featureId) => ({
    kind: "mux",
    id: "tmux",
    version: "3.8",
    os: "linux",
    featureId,
    outerCommands: true as const,
  })),
  {
    kind: "mux",
    id: "tmux",
    version: "3.8",
    os: "linux",
    featureId: "extensions.osc7-cwd",
    reader: "cwd",
  },
  {
    kind: "mux",
    id: "tmux",
    version: "3.8",
    os: "linux",
    featureId: "extensions.osc8",
    reader: "osc8",
  },
  ...promptFeatures
    .filter((featureId) => featureId !== "extensions.osc633-e")
    .map((featureId) => ({
      kind: "mux",
      id: "tmux",
      version: "3.8",
      os: "linux",
      featureId,
      reader: (featureId === "extensions.osc633-p"
        ? "cwd"
        : featureId === "extensions.semantic-prompts" || featureId === "extensions.osc-633-vscode"
          ? "cycle"
          : "grid") as AppSemanticCapability["reader"],
    })),
  ...promptFeatures
    .filter((featureId) => featureId.includes("633"))
    .map((featureId) => ({
      kind: "term",
      id: "kitty",
      version: "0.49.2",
      os: "linux",
      featureId,
      reader: "report" as const,
    })),
  ...(
    [
      ["extensions.osc176-app-id", "176", "176;terminfo-test"],
      ["extensions.osc440-audio", "440", "440;bell.wav"],
      ["extensions.osc666-termprop", "666", "666;test-prop=value"],
      ["extensions.osc555-flash", "555", "555"],
      ["extensions.osc710-font-normal", "710", "710;monospace"],
      ["extensions.osc113-reset-pointer-fg", "113", "113"],
      ["extensions.osc114-reset-pointer-bg", "114", "114"],
    ] as const
  ).map(([featureId, code, body]) => ({
    kind: "term",
    id: "kitty",
    version: "0.49.2",
    os: "linux",
    featureId,
    reader: "report" as const,
    command: { code, body },
  })),
  // Ghostty v1.4.0 stream_handler.zig:383-390 drops unknown OSC; :1680-1690
  // handles OSC110, while :1713 logs exact reset refusals. OSC113 after the
  // target qualifies this log path and bounds the appended bytes (CTO ef675012).
  // OSC113 uses OSC116 instead so its target cannot qualify its own control (CTO face495c).
  ...(
    [
      ["extensions.osc117-reset-highlight-bg", "117", "highlight_background"],
      ["extensions.osc119-reset-highlight-fg", "119", "highlight_foreground"],
      ["extensions.osc113-reset-pointer-fg", "113", "pointer_foreground"],
      ["extensions.osc114-reset-pointer-bg", "114", "pointer_background"],
    ] as const
  ).map(([featureId, code, colour]) => ({
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId,
    reader: "report" as const,
    command: { code, body: code },
    reportControls: {
      sentinel:
        code === "113"
          ? { code: "116", body: "116", line: "resetting dynamic color tektronix_background not implemented" }
          : { code: "113", body: "113", line: "resetting dynamic color pointer_foreground not implemented" },
      handled: { code: "110", body: "110", line: "resetting dynamic color foreground not implemented" },
      targetLine: `resetting dynamic color ${colour} not implemented`,
    },
  })),
  // WezTerm Linux audited builds (wezterm-linux-reviewed.ts):
  // term/src/terminalstate/performer.rs:776-785 space-joins unspecified OSC parameters in this warning when logging is on.
  ...WEZTERM_LINUX_SEMANTIC_BUILDS.flatMap(({ version }) =>
    (
      [
        ["extensions.osc555-flash", "555", "555"],
        ["extensions.osc710-font-normal", "710", "710;fixed"],
        // #32889 step 1: the same performer warning already measured for 555 and 710 covers the four
        // host-effect commands. Retained lines, run 2026-11-09T21-33-38-598Z (suite 76c756c56745):
        // "Unhandled OSC  666 test-prop=value", "Unhandled OSC  3008 type=test",
        // "Unhandled OSC  176 terminfo-test", "Unhandled OSC  440 bell.wav".
        ["extensions.osc176-app-id", "176", "176;terminfo-test"],
        ["extensions.osc3008-context", "3008", "3008;type=test"],
        ["extensions.osc440-audio", "440", "440;bell.wav"],
        ["extensions.osc666-termprop", "666", "666;test-prop=value"],
        ["extensions.osc633-a", "633", "633;A"],
        ["extensions.osc633-b", "633", "633;B"],
        ["extensions.osc633-c", "633", "633;C"],
        ["extensions.osc633-d", "633", "633;D;0"],
        ["extensions.osc633-e", "633", "633;E;ls -la;nonce123"],
        ["extensions.osc633-p", "633", "633;P;Cwd=/tmp"],
        ["extensions.osc-633-vscode", "633", "633;A"],
      ] as const
    ).map(([featureId, code, body]) => ({
      kind: "term",
      id: "wezterm",
      version,
      os: "linux",
      featureId,
      reader: "report" as const,
      command: { code, body },
      reportControls: {
        sentinel: { code: "7655", body: "7655;{nonce}", line: "Unhandled OSC  7655 {nonce}" },
        handled: { code: "2", body: "2;Q-{nonce}", line: "Unhandled OSC  2 Q-{nonce}" },
        targetLine: `Unhandled OSC  ${body.replaceAll(";", " ")}`,
      },
    })),
  ),
  // CTO third-table Ask4: preserve the separately delivered bus-dependent rows.
  ...[
    { kind: "term", id: "kitty", version: "0.49.2" },
    { kind: "term", id: "ghostty", version: "1.4.0" },
    ...WEZTERM_LINUX_SEMANTIC_BUILDS.map(({ version }) => ({ kind: "term" as const, id: "wezterm", version })),
    { kind: "term", id: "alacritty", version: "0.17.0" },
    { kind: "term", id: "xterm", version: "412" },
    { kind: "mux", id: "screen", version: "5.0.2" },
    { kind: "mux", id: "tmux", version: "3.8" },
  ].flatMap((subject) =>
    ["extensions.notifications", "extensions.osc777-notify"].map((featureId) => ({
      ...subject,
      os: "linux",
      featureId,
      requiresMissingSessionBus: true as const,
      reason: `Untestable (no setup): ${subject.id} ${subject.version} desktop notification delivery requires a session bus.`,
    })),
  ),
  ...promptFeatures.map((featureId) => ({
    kind: "term",
    id: "xterm",
    version: "412",
    os: "linux",
    featureId,
    reason:
      "Untestable (no way): xterm 412 has no prompt-mark store or public prompt action for OSC 133/633. Read ctlseqs.txt:2008 onward, misc.c:4353-4354 (TRACE-only unknown-OSC arm), and xterm.man in xterm-412.tgz (SHA256 b48bc780).",
  })),
  ...promptFeatures.map((featureId) => ({
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId,
    reason:
      "Untestable (no way): GNU Screen 5.0.2 drops OSC 133/633 without storing, reporting or forwarding a prompt mark. Read ansi.c:1267-1289, mark.c, comm.c, doc/screen.texinfo and doc/screen.1 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e); its character search does not read prompt marks.",
  })),
  {
    kind: "term",
    id: "kitty",
    version: "0.49.2",
    os: "linux",
    featureId: "extensions.osc133-b",
    reason:
      "Untestable (no way): Kitty 0.49.2 has no OSC 133 B arm or input-mark reader. Read tag v0.49.2 kitty/screen.c:3590-3610 (A/C/D only) and docs/shell-integration.rst:434-452; no command-specific log reports this handled OSC's unknown letter.",
  },
  ...WEZTERM_LINUX_SEMANTIC_BUILDS.flatMap(({ version }) =>
    ["extensions.osc133-d", "extensions.semantic-prompts"].map((featureId) => ({
      kind: "term",
      id: "wezterm",
      version,
      os: "linux",
      featureId,
      reason: `Untestable (no way): WezTerm ${version} exposes semantic zones but no command-exit status, so it cannot observe OSC 133 D or the complete A/C/D cycle. Read e2a98e1b8af1..ee6f3044d09f term/src/terminalstate/performer.rs:904-906 (empty CommandStatus arm, byte-identical through rev ee6f3044d09f), term/src/lib.rs:117-123 and public pane semantic-zone documentation.`,
    })),
  ),
  ...["extensions.osc633-e", "extensions.osc633-p"].map((featureId) => ({
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId,
    reason:
      "Untestable (no way): Ghostty 1.4.0 has no OSC 633 parser or corresponding stored command-line/Cwd reader. Read tag v1.4.0 src/terminal/osc.zig:485 and src/input/Binding.zig; opening a new tab is not this probe's Cwd reader.",
  })),
  // #33529 (@chief 2026-11-11T15:18Z): no readback at ghostty's SHIPPED default, which is what every App run is
  // launched at. The notification that carries the exit code needs three deviations from that default, and a
  // launch naming a notification setting is refused as non-default, so that route can never grade this row.
  ...["extensions.osc133-d", "extensions.semantic-prompts"].map((featureId) => ({
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId,
    reason:
      "Untestable (no setup): Ghostty 1.4.0 at its shipped default configuration exposes no readback of OSC 133;D. notify-on-command-finish defaults to never and its action to bell without notify (src/config/Config.zig:1214, 1228-1231), a notification also needs a command longer than five seconds (src/config/Config.zig:1265), and the path reaching sendDesktopNotification is gated on all three (src/apprt/gtk/class/surface.zig:1192-1218). OSC 133;D itself only sets internal row content (src/terminal/Terminal.zig:2266-2271). The run is at that default by construction: a launch naming any notification setting is refused as non-default, so a notification read cannot grade this row. The route needs notify-on-command-finish set away from never, which changes what Ghostty does when a command ends (it rings or posts a desktop notification), so it is a behaviour setting, not an observer-only switch (@cto 9de3bba2).",
  })),
  {
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId: "extensions.osc666-termprop",
    reason:
      "Untestable (no way): Ghostty 1.4.0 has no OSC 666 terminal-property handler or public property readback. Read tag v1.4.0 src/terminal/osc.zig:978-982,752,1103; src/terminal/stream.zig:579 and src/termio/Termio.zig:346-349 keep unknown OSC capture disabled, so the command is discarded without a target-state reading.",
  },
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "extensions.osc666-termprop",
    reason:
      "Untestable (no way): GNU Screen 5.0.2 drops OSC 666 without storing, reporting or forwarding a terminal property. Read ansi.c:1267-1289 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e); the OSC allowlist and non-title exit expose no property reading.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "412",
    os: "linux",
    featureId: "extensions.osc666-termprop",
    reason:
      "Untestable (no way): xterm 412 has no OSC 666 terminal-property handler or public property readback. Read misc.c:3480-3502,4353-4355 in xterm-412.tgz (SHA256 b48bc780); the unknown-OSC arm only traces an unnamed rejection and stores no property.",
  },
  {
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId: "extensions.osc176-app-id",
    reason:
      "Untestable (no way): Ghostty 1.4.0 has no OSC 176 application-id handler or target-state readback. Read tag v1.4.0 src/terminal/osc.zig:889-901,926-950: the 17 state rejects the next digit; default unknown_max_bytes=0 at 496 discards it through invalid at 752 and null at 1103. The app-id is neither stored nor reported.",
  },
  {
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId: "extensions.osc440-audio",
    reason:
      "Untestable (no way): Ghostty 1.4.0 has no OSC 440 audio handler or playback readback. Read tag v1.4.0 src/terminal/osc.zig:926-950: the 4 state accepts a delimiter, not another 4; default unknown_max_bytes=0 at 496 discards it through invalid at 752 and null at 1103. No audio action or command-specific rejection is reported.",
  },
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "extensions.osc176-app-id",
    reason:
      "Untestable (no way): GNU Screen 5.0.2 drops OSC 176 without an application-id state, forward or report. Read the complete StringEnd OSC dispatch in ansi.c:1236-1289 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e); the target reaches the non-title break before the status write at 1303-1305. No public target-state reading or command-specific rejection is exposed.",
  },
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "extensions.osc440-audio",
    reason:
      "Untestable (no way): GNU Screen 5.0.2 drops OSC 440 without an audio action, forward or report. Read the complete StringEnd OSC dispatch in ansi.c:1236-1289 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e); the target reaches the non-title break before the status write at 1303-1305. No playback reading or command-specific rejection is exposed.",
  },
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "extensions.osc3008-context",
    reason:
      "Untestable (no way): GNU Screen 5.0.2 drops OSC 3008 without storing, forwarding or reporting context tags. Read the complete StringEnd OSC dispatch in ansi.c:1236-1289 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e); the target reaches the non-title break before the status write at 1303-1305. No public context reading or command-specific rejection is exposed.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "412",
    os: "linux",
    featureId: "extensions.osc176-app-id",
    reason:
      "Untestable (no way): xterm 412 has no OSC 176 application-id handler or target-state readback. Read misc.c do_osc and its default at 4353-4358 in xterm-412.tgz (SHA256 b48bc780); the target stores no application-id and returns no response. The conditional rejection trace names no command, so it supplies no target report.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "412",
    os: "linux",
    featureId: "extensions.osc440-audio",
    reason:
      "Untestable (no way): xterm 412 has no OSC 440 audio handler or playback readback. Read misc.c do_osc and its default at 4353-4358 in xterm-412.tgz (SHA256 b48bc780); the target starts no audio action and returns no response. The conditional rejection trace names no command, so it supplies no target report.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "412",
    os: "linux",
    featureId: "extensions.osc3008-context",
    reason:
      "Untestable (no way): xterm 412 has no OSC 3008 context handler or public context readback. Read misc.c do_osc and its default at 4353-4358 in xterm-412.tgz (SHA256 b48bc780); the target stores no context tag and returns no response. The conditional rejection trace names no command, so it supplies no target report.",
  },
  {
    kind: "term",
    id: "kitty",
    version: "0.49.2",
    os: "linux",
    featureId: "extensions.osc3008-context",
    reason:
      "Untestable (no way): Kitty 0.49.2 recognizes OSC 3008 but its context callback stores no state and exposes no readback. Read tag v0.49.2 kitty/vt-parser.c:645-677, kitty/screen.c:3523-3524 and kitty/window.py:1582-1583: dispatch reaches the empty Window.osc_context callback. Generic OSC consumption tracing is not a command-specific rejection or context reading.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "412",
    os: "linux",
    featureId: "extensions.osc7-cwd",
    reason:
      "Untestable (no way): xterm 412 has no OSC 7 working-directory state or public readback. Read the complete do_osc dispatch in misc.c:3988-4360 and numeric OSC aliases at 3480-3502 in xterm-412.tgz (SHA256 b48bc780); OSC 7 reaches the unnamed default trace at 4353-4358. That generic trace is not a command-specific rejection or directory reading.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "412",
    os: "linux",
    featureId: "extensions.osc555-flash",
    reason:
      "Untestable (no way): xterm 412 has no OSC 555 flash handler or public flash readback. Read the complete do_osc dispatch in misc.c:3988-4360, numeric OSC aliases at 3480-3502 and colour codes at ptyx.h:1018-1034 in xterm-412.tgz (SHA256 b48bc780); OSC 555 reaches the unnamed default trace at 4353-4355. That generic trace is not a command-specific rejection or flash reading.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "412",
    os: "linux",
    featureId: "extensions.osc710-font-normal",
    reason:
      "Untestable (no way): xterm 412 has no OSC 710 font-selection handler or public font readback. Read the complete do_osc dispatch in misc.c:3988-4360, numeric OSC aliases at 3480-3502 and colour codes at ptyx.h:1018-1034 in xterm-412.tgz (SHA256 b48bc780); OSC 710 reaches the unnamed default trace at 4353-4355. That generic trace is not a command-specific rejection or font reading.",
  },
  {
    kind: "term",
    id: "alacritty",
    version: "0.17.0",
    os: "linux",
    featureId: "extensions.osc710-font-normal",
    reason:
      "Untestable (no way): Alacritty 0.17.0's locked VTE 0.15.0 OSC parser has no OSC 710 font-selection handler. Read the complete OSC dispatch in vte-0.15.0/src/ansi.rs:1329-1525 (crate SHA256 a5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd, pinned by Alacritty's Cargo.lock:2119-2125): 710 reaches only the unhandled Debug path at 1341/1523, not Alacritty's Term handler. The existing Warn launch has no qualified same-run report reader; silence is not Unsupported.",
  },
  // Alacritty does not implement OSC 133/633: the sequence is dropped at the parser, before any
  // handler runs, so this is a source read of an absent feature rather than a missing probe. The
  // version link is the shipped crate, not the engine receipt alone: Alacritty 0.17.0 pins
  // alacritty_terminal 0.26.0 (alacritty/Cargo.toml:3,13-15 at tag v0.17.0, file SHA256
  // ccbe547a224e9a13d3a08e6cd24f2c1fd1c92c28e02eda9324c14892244238ff), which is the crate the
  // App backend builds (receipt: upstreamCrate alacritty_terminal 0.26.0, crate SHA256
  // bda177466b9524d59f1b12f0dd30b68696788e9992a7e959021c4a0ed96fcf59), and that crate's locked
  // VTE 0.15.0 is the same dispatch already cited for its OSC 710 row.
  ...promptFeatures.map((featureId) => ({
    kind: "term",
    id: "alacritty",
    version: "0.17.0",
    os: "linux",
    featureId,
    reason:
      "Untestable (no way): Alacritty 0.17.0 does not implement OSC 133 or OSC 633 at all - the sequence is dropped at the parser, so no prompt mark exists to observe. This is a source read of an absent feature, not a silent runtime probe. It ships alacritty_terminal 0.26.0 (alacritty/Cargo.toml:3,13-15 at tag v0.17.0, file SHA256 ccbe547a224e9a13d3a08e6cd24f2c1fd1c92c28e02eda9324c14892244238ff), the crate this App backend is built from (engine receipt: upstreamCrate alacritty_terminal 0.26.0, crate SHA256 bda177466b9524d59f1b12f0dd30b68696788e9992a7e959021c4a0ed96fcf59), and that crate's locked VTE 0.15.0 (crate SHA256 a5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd) dispatches only OSC 0/2, 4, 8, 10-12, 22, 50, 52, 104 and 110-112: ansi.rs:1329-1525 sends every other code to `_ => unhandled(params)` at :1523, whose Debug line at :1341 never reaches the handler. alacritty_terminal 0.26.0 has no prompt-mark code at all - impl Handler for Term (src/term/mod.rs:1059) declares no OSC 133/633 method, and semantic_escape_chars there is selection word separators - and Alacritty's own escape table (extra/man/alacritty-escapes.7.scd:215-255 at the same tag, file SHA256 bf0e0fdadcb3be999e810ba07794f305f8ebb749491c872f2bf84970fa13da44) lists no 133 or 633.",
  })),
  // #32889: Alacritty 0.17.0 implements none of OSC 176, 3008, 440 or 666; VTE drops all four at
  // the parser before any handler runs, corroborated by the 47 [unhandled osc_dispatch] lines in
  // run 2026-11-10T00-20-28-870Z-502b6144aa69 / 2026-11-10T01-37-06-356Z-f7a0a479fab4.
  ...(
    [
      ["extensions.osc176-app-id", "176"],
      ["extensions.osc3008-context", "3008"],
      ["extensions.osc440-audio", "440"],
      ["extensions.osc666-termprop", "666"],
    ] as const
  ).map(([featureId, code]) => ({
    kind: "term" as const,
    id: "alacritty",
    version: "0.17.0",
    os: "linux",
    featureId,
    reason: `Untestable (no way): Alacritty 0.17.0 does not implement OSC ${code} - its locked VTE 0.15.0 parser drops the sequence before any handler runs, so no state or reply exists to observe. Read from source, not measured. It ships alacritty_terminal 0.26.0 (alacritty/Cargo.toml:3,13-15 at tag v0.17.0, file SHA256 ccbe547a224e9a13d3a08e6cd24f2c1fd1c92c28e02eda9324c14892244238ff; engine receipt: upstreamCrate alacritty_terminal 0.26.0, crate SHA256 bda177466b9524d59f1b12f0dd30b68696788e9992a7e959021c4a0ed96fcf59), and that crate's locked VTE 0.15.0 (crate SHA256 a5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd, pinned by Cargo.lock:2119-2125) dispatches only OSC 0/2, 4, 8, 10-12, 22, 50, 52, 104 and 110-112: ansi.rs:1329-1525 sends every other code to \`_ => unhandled(params)\` at :1523, whose Debug line at :1341 never reaches the handler. Across alacritty_terminal 0.26.0, impl Handler for Term (src/term/mod.rs:1059) has no osc_dispatch override (only dynamic_color_sequence at :1675 and set_title at :2221), and Alacritty's own escape table (extra/man/alacritty-escapes.7.scd:215-255 at tag v0.17.0, file SHA256 bf0e0fdadcb3be999e810ba07794f305f8ebb749491c872f2bf84970fa13da44) lists no ${code}.`,
  })),
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "extensions.osc7-cwd",
    reason:
      "Untestable (no way): GNU Screen 5.0.2 drops OSC 7 without storing, forwarding or reporting a working directory. Read the complete StringEnd OSC dispatch in ansi.c:1233-1307 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e); OSC 7 is outside the accepted title/colour list and reaches the non-title break. The outer terminal cannot supply Screen's missing own directory reading.",
  },
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "modes.decsclm",
    reason:
      "Untestable (no way): GNU Screen 5.0.2 exposes no smooth-scrolling state or public readback for DECSCLM. Read SetMode in ansi.c:1090-1122 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e): case 4 SCLM is commented out between cases 3 and 5. A static capture cannot read scroll timing, and the outer terminal cannot supply Screen's missing own mode reading.",
  },
  {
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId: "extensions.osc555-flash",
    reason:
      "Untestable (no way): Ghostty 1.4.0 has no OSC 555 flash command or public flash readback. In ghostty-xpli4r8n1mqrzhbgxmkj4jfbpsjsqm3m-derived-source-tar (SHA256 d692bb9b), osc.zig:965-968 and 984-987 send a third 5 to unknownOrInvalid at 748-753; unknown_max_bytes defaults to 0 at 496, so it marks the sequence invalid. end() at 1092-1103 returns no command and logs nothing. That silent parser rejection is not a command-specific refusal or flash reading.",
  },
  {
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId: "extensions.osc3008-context",
    reason:
      "Untestable (no way): Ghostty 1.4.0 parses OSC 3008 but keeps no context state and exposes no readback. In ghostty-xpli4r8n1mqrzhbgxmkj4jfbpsjsqm3m-derived-source-tar (SHA256 d692bb9b), osc.zig:1170 sends 3008 to parsers.hierarchical_context.parse, which validates the uapi start=<id>/end=<id> form and warns at hierarchical_context.zig:274; the parsed command then reaches stream.zig:2968, which lists .hierarchical_context among unimplemented OSC callbacks and only runs log.debug at :2970 (absent from the shipped binary: strings finds 0), a level main_ghostty.zig:203-211 pins off in every non-debug build. No context stack, environment, reply or public readback exists in src. A spec-valid payload leaves no observable trace, and the parser warning a malformed payload produces is payload validation, not a command-specific refusal.",
  },
  {
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId: "extensions.osc710-font-normal",
    reason:
      "Untestable (no way): Ghostty 1.4.0 has no OSC 710 font-selection command or public font readback. In ghostty-xpli4r8n1mqrzhbgxmkj4jfbpsjsqm3m-derived-source-tar (SHA256 d692bb9b), osc.zig:989-995 sends the digit 1 after 7 to unknownOrInvalid at 748-753; unknown_max_bytes defaults to 0 at 496, so it marks the sequence invalid. end() at 1092-1103 returns no command and logs nothing. That silent parser rejection is not a command-specific refusal or font reading.",
  },
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "modes.color-scheme-reporting",
    reason:
      "Untestable (no way): GNU Screen 5.0.2 has no private-mode 2031 handler. Read the complete private SetMode dispatch in ansi.c:1071-1191 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e): CSI ?2031h has no dispatch case, so this version exposes no color-scheme-reporting test path. A silent query is not an observed negative.",
  },
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "extensions.osc710-font-normal",
    reason:
      "Untestable (no way): GNU Screen 5.0.2 drops OSC 710 without storing, forwarding or reporting a font selection. Read the complete StringEnd OSC dispatch in ansi.c:1223-1312 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e): OSC 710 parses typ 710 and misses the accepted title/colour list (0, 1, 2, 11, 20, 39, 49, and 83 for commands) at 1267, so it reaches the non-title break at 1288. Screen has no font state, log or readback, and the outer terminal cannot supply Screen's missing own font reading.",
  },
  {
    kind: "mux",
    id: "tmux",
    version: "3.8",
    os: "linux",
    featureId: "extensions.osc0-icon-title",
    reason:
      "Untestable (no way): a multiplexer has no icon name; the outer terminal's row applies. tmux 3.8. Read in tmux-3.8.tar.gz (SHA256 e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e): input_exit_osc at input.c:2699 dispatches OSC 0 and OSC 2, and OSC 1 reaches the unknown-OSC default at input.c:2775-2777. That dispatch is not an icon name.",
  },
  {
    kind: "mux",
    id: "tmux",
    version: "3.8",
    os: "linux",
    featureId: "extensions.osc1-icon",
    reason:
      "Untestable (no way): a multiplexer has no icon name; the outer terminal's row applies. tmux 3.8. Read in tmux-3.8.tar.gz (SHA256 e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e): input_exit_osc at input.c:2699 does not dispatch OSC 1, so it reaches the unknown-OSC default at input.c:2775-2777. That drop is not an icon name.",
  },
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "extensions.osc0-icon-title",
    reason:
      "Untestable (no way): a multiplexer has no icon name; the outer terminal's row applies. GNU Screen 5.0.2. Read the StringEnd OSC dispatch in ansi.c:1223-1312 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e): OSC 0 is in the title/colour list at ansi.c:1267. That title is not an icon name.",
  },
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "extensions.osc1-icon",
    reason:
      "Untestable (no way): a multiplexer has no icon name; the outer terminal's row applies. GNU Screen 5.0.2. Read the StringEnd OSC dispatch in ansi.c:1223-1312 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e): OSC 1 is in the title/colour list at ansi.c:1267. That title is not an icon name.",
  },
  // #32889 step 1: tmux 3.8 carries no handler for any of these five codes, and the drop is the
  // unknown-OSC default in its own input parser. Read in tmux-3.8.tar.gz
  // (SHA256 e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e):
  // input_exit_osc at input.c:2699 parses the numeric option and dispatches only 0, 2, 4, 7, 8, 9,
  // 10, 11, 12, 52, 104, 110, 111, 112 and 133; every other option reaches the default at
  // input.c:2775-2777, which logs at debug level and returns. The file's only pass-through is DCS
  // (input_exit_dcs, the allow-passthrough option) and it does not carry OSC. The run image's tmux
  // 3.8 also keeps no verbose log at all (measured 2026-11-10: no log file, no open log fd, empty
  // server stderr), so that debug line cannot be read either.
  ...(
    [
      ["extensions.osc176-app-id", "176"],
      ["extensions.osc3008-context", "3008"],
      ["extensions.osc440-audio", "440"],
      ["extensions.osc666-termprop", "666"],
      ["extensions.osc710-font-normal", "710"],
    ] as const
  ).map(([featureId, code]) => ({
    kind: "mux" as const,
    id: "tmux",
    version: "3.8",
    os: "linux",
    featureId,
    reason: `Untestable (no way): tmux 3.8 has no OSC ${code} handler and drops it in the unknown-OSC default of its input parser. Read from source, not measured. Read in tmux-3.8.tar.gz (SHA256 e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e): input_exit_osc at input.c:2699 dispatches only 0, 2, 4, 7, 8, 9, 10, 11, 12, 52, 104, 110, 111, 112 and 133, and every other option reaches the default at input.c:2775-2777, which only logs at debug level and returns. The file's only pass-through is DCS (input_exit_dcs, the allow-passthrough option), which does not carry OSC. A debug-only drop with no state, reply or readback is not a command-specific refusal, and the run image's tmux 3.8 keeps no verbose log to read it from.`,
  })),
  // #32947 (@cto 8ca3f1d9): remaining 19 Linux App semantic-prompt rows at their exact pinned versions.
  ...[
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc-633-vscode",
  ].map((featureId) => ({
    kind: "term" as const,
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId,
    reason:
      'Untestable (no way): Ghostty 1.4.0 has no OSC 633 parser and drops the sequence silently without a target-state reading or log. In ghostty-xpli4r8n1mqrzhbgxmkj4jfbpsjsqm3m-derived-source-tar (SHA256 d692bb9b), src/terminal/osc.zig:455-505 lists 133 and no 633; state .@"6" at :972-975 sends 3 to unknownOrInvalid at :748-753 (unknown_max_bytes=0 at :496), so end() at :1092-1103 returns null and logs nothing.',
  })),
  ...["extensions.osc133-a", "extensions.osc133-b", "extensions.osc133-c", "extensions.osc133-p"].map((featureId) => ({
    kind: "term" as const,
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId,
    reason:
      "Untestable (no way): Ghostty 1.4.0 parses OSC 133 A/B/C/P into internal row state and an embedder callback with no public CLI, IPC, escape-query or non-debug log readback. Read tag v1.4.0 (ghostty-xpli4r8n1mqrzhbgxmkj4jfbpsjsqm3m-derived-source-tar, SHA256 d692bb9b) src/terminal/osc.zig:1180, src/terminal/osc/parsers/semantic_prompt.zig:23-32 and src/terminal/stream_terminal.zig:397,918-961 (page_row.semantic_prompt at src/terminal/Terminal.zig:1849,2259,3743). Scraping UI state via synthetic jump_to_prompt keys or triple-click X11 primary selection is not a non-intrusive prompt-mark reader.",
  })),
  // 34574 (@cto 386684bc option A): the same nine ids on macOS, as their own exact os rows. Each cites the Mac app's
  // own path and surfaces in the v1.4.0 tag the hosted macOS run's bundle version (34562) names.
  ...[
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc-633-vscode",
  ].map((featureId) => ({
    kind: "term" as const,
    id: "ghostty",
    version: "1.4.0",
    os: "macos",
    featureId,
    reason:
      'Untestable (no way): Ghostty 1.4.0 on macOS has no OSC 633 parser and drops the sequence silently without a target-state reading or log. The Mac app parses OSC in the shared core, not in its own frontend. Read tag v1.4.0 (ghostty-xpli4r8n1mqrzhbgxmkj4jfbpsjsqm3m-derived-source-tar, SHA256 d692bb9b), the source of the bundle version 1.4.0 the hosted run records: macos/Sources/Ghostty/Surface View/SurfaceView_AppKit.swift:389 creates each Mac surface through ghostty_surface_new (src/apprt/embedded.zig:617,1842), whose core Surface drives terminal.Stream in src/termio/Termio.zig:14,66 with the one StreamHandler every app runtime uses, and the shared core parser (src/terminal/osc.zig and src/terminal/stream.zig) carries no OS branch. In that shared core parser, src/terminal/osc.zig:455-505 lists 133 and no 633; state .@"6" at :972-975 sends 3 to unknownOrInvalid at :748-753 (unknown_max_bytes=0 at :496), so end() at :1092-1103 returns null and logs nothing. The embedded runtime behind the Swift app (src/apprt/embedded.zig) has no OSC 633 path, and macos/Sources names OSC only for the OSC 8 and OSC 52 actions the core raises (macos/Sources/Ghostty/Ghostty.App.swift:527-536,813-888, macos/Sources/Features/Terminal/BaseTerminalController.swift:1622).',
  })),
  ...["extensions.osc133-a", "extensions.osc133-b", "extensions.osc133-c", "extensions.osc133-p"].map((featureId) => ({
    kind: "term" as const,
    id: "ghostty",
    version: "1.4.0",
    os: "macos",
    featureId,
    reason:
      "Untestable (no way): Ghostty 1.4.0 on macOS parses OSC 133 A/B/C/P into core row state that no public macOS surface reads back. Read tag v1.4.0 (ghostty-xpli4r8n1mqrzhbgxmkj4jfbpsjsqm3m-derived-source-tar, SHA256 d692bb9b), the source of the bundle version 1.4.0 the hosted run records. src/terminal/osc.zig:1180 and src/terminal/osc/parsers/semantic_prompt.zig:23-32 parse it. The app's src/termio/stream_handler.zig:350,1475-1508 stores it through Terminal.semanticPrompt (src/terminal/Terminal.zig:2156), and it then drives only click handling and the jump_to_prompt viewport move (src/Surface.zig:4306,4370,5429). The Mac surfaces carry no mark. The C API text read ghostty_surface_read_text (src/apprt/embedded.zig:1929-1960) returns plain characters from Screen.selectionString (src/Surface.zig:2042-2051) in ghostty_text_s (include/ghostty.h:449-456). The Shortcuts intent Get Terminal Details returns only the title, the working directory or that plain text (macos/Sources/Features/App Intents/GetTerminalDetailsIntent.swift:35-47). The AppleScript dictionary exposes id, name, working directory, pid and tty, and its perform action returns only a boolean (macos/Ghostty.sdef:89-100,162-166). Only the debug inspector (src/inspector/widgets/page.zig:291, opened by the inspector binding at src/input/Binding.zig:688-691) and the session snapshot serializer (src/terminal/snapshot/grid.zig:259) see row.semantic_prompt, and neither is a default-launch reader. Running jump_to_prompt through perform action and reading the visible text back is scraping UI state, not a non-intrusive prompt-mark reader.",
  })),
  // 34591: WezTerm's six macOS prompt rows. The version names its own commit, so nothing rebinds from the Linux
  // nightly; this tag's empty CommandStatus arm is performer.rs:882-884 (the Linux rows cite :904-906 at e2a98e1b8af1).
  // No macOS reader exists for these ids (owned-terminal's darwin reader set), so a run cannot decide them; only
  // osc633-p stays undeclared, for the darwin WezTerm reader (@dev/11 spec REVISION 2, @chief 608886bd).
  ...["extensions.osc133-a", "extensions.osc133-b", "extensions.osc133-c", "extensions.osc133-p"].map((featureId) => ({
    kind: "term" as const,
    id: "wezterm",
    version: "20240203-110809-5046fc22",
    os: "macos",
    featureId,
    reason:
      'Untestable (no way): WezTerm 20240203-110809-5046fc22 on macOS parses OSC 133 A/B/C/P into in-process SemanticZone state that no default-launch surface reads back. Read tag 20240203-110809-5046fc22 (5046fc225992db6ba2ef8812743fadfdfe4b184a): termwiz/src/escape/osc.rs:439 defines FinalTermSemanticPrompt = "133" with dispatch at :326-327 and the action parser at :627-696; term/src/terminalstate/performer.rs:845-880 sets the pen semantic type for each mark; term/src/terminalstate/mod.rs:2704 is get_semantic_zones and mux/src/pane.rs:283 is its trait method. No client can ask: mux/src/lib.rs (1441 lines) has zero "semantic", the CLI\'s 19 verbs (CliSubCommand, wezterm/src/cli/mod.rs:77-166) at this tag read no zones, and wezterm/src/cli/get_text.rs:34,86-87 prints text or colour/style escapes only. The macOS frontend names no semantic state (window/src/os/macos, all eight .rs files, zero "semantic") and the app ships no AppleScript dictionary. The one reader is user Lua through docs/config/lua/pane/get_semantic_zones.md, and injecting a config script is not a default-launch reader.',
  })),
  ...["extensions.osc133-d", "extensions.semantic-prompts"].map((featureId) => ({
    kind: "term" as const,
    id: "wezterm",
    version: "20240203-110809-5046fc22",
    os: "macos",
    featureId,
    reason:
      'Untestable (no way): WezTerm 20240203-110809-5046fc22 on macOS records each OSC 133 mark but exposes neither it nor a command-exit status, so it cannot observe 133 D or the complete A/C/D cycle. Read tag 20240203-110809-5046fc22 (5046fc225992db6ba2ef8812743fadfdfe4b184a): term/src/terminalstate/performer.rs:882-884 is FinalTermSemanticPrompt::CommandStatus { .. } => {} (an empty arm, no status stored), the other mark arms at :845-880 store only a pen semantic type, and term/src/terminalstate/mod.rs:2704 get_semantic_zones returns SemanticZone spans with no status field. No surface reads them back on default launch: mux/src/lib.rs has zero "semantic", the CLI\'s 19 verbs (CliSubCommand, wezterm/src/cli/mod.rs:77-166) read no zones, wezterm/src/cli/get_text.rs:34,86-87 prints text or escapes only, and the macOS frontend (window/src/os/macos, eight .rs files) names no semantic state. The upstream Linux row records the same empty arm at performer.rs:904-906 (e2a98e1b8af1); this arm is shared core term code, not a frontend path.',
  })),
  // 34591: the 633 family has no parser at this tag, so the sequence is dropped rather than unreadable.
  ...[
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.osc-633-vscode",
  ].map((featureId) => ({
    kind: "term" as const,
    id: "wezterm",
    version: "20240203-110809-5046fc22",
    os: "macos",
    featureId,
    reason:
      'Untestable (no way): WezTerm 20240203-110809-5046fc22 has no OSC 633 parser, so the sequence is dropped without a target-state reading, a report or a non-debug log. Read tag 20240203-110809-5046fc22 (5046fc225992db6ba2ef8812743fadfdfe4b184a): termwiz/src/escape/osc.rs:409 is the OSC command table and carries SetHyperlink = "8" and FinalTermSemanticPrompt = "133" (:439) with no 633 entry — the file has zero occurrences of 633 — dispatched at :312,326-327 and parsed at :627-696. The macOS build runs this same termwiz parser (window/src/os/macos, all eight .rs files, carries no OSC handling of its own and names no semantic state), the mux protocol (mux/src/lib.rs, 1441 lines) has zero "semantic" and no unhandled-OSC verb, and the CLI at this tag reads no prompt state (wezterm/src/cli/get_text.rs:34,86-87 prints text or colour/style escapes only). macOS additionally offers no default-launch log surface for dropped OSCs.',
  })),
  // 34586: cmux's six macOS prompt rows. They say only that D's exit code is parsed and never read back: the fork's
  // stream handler (src/termio/stream_handler.zig at cb1ef709) was not read, so no claim that the status is discarded.
  ...["extensions.osc133-a", "extensions.osc133-b", "extensions.osc133-c", "extensions.osc133-p"].map((featureId) => ({
    kind: "term" as const,
    id: "cmux",
    version: "0.65.2",
    os: "macos",
    featureId,
    reason:
      'Untestable (no way): cmux 0.65.2 on macOS parses OSC 133 A/B/C/P into core prompt state and no public surface reads a mark back. Read tag v0.65.2 (9d01f956c51cd895e10e7d56b6dd7b5f6fcce625) and the vendored ghostty fork cb1ef7091cdef0b581ee2cbd83742b653253523e: src/terminal/osc.zig:371 lists 133 in the command table and :862 dispatches it to parsers.semantic_prompt.parse, whose action set is L,A,N,P,B,I,C,D (src/terminal/osc/parsers/semantic_prompt.zig:22-31). All three complete read surfaces at that commit were enumerated and carry no mark: the control-socket read plane (Packages/macOS/CmuxControlSocket/Sources/CmuxControlSocket/Wire/ControlCommandExecutionPolicy+ReadPlane.swift enumerates every read-only method as surface.list/current/read_text/read_selection, workspace.list/current, window.list/current/displays, pane.list/surfaces and system.identify/tree/top/memory), cmux-tui/spec/sdk-schema.json (protocol 12, 118 commands, 50 events, zero case-insensitive "prompt"), and docs/cli-contract.md (read-screen returns {text} only, vt-state returns the PTY byte stream, and jump-to-last-prompt only moves focus, answering {"opened": false} when there is no prompt: ControlCommandCoordinator+SurfaceJumpToLastPrompt.swift).',
  })),
  ...["extensions.osc133-d", "extensions.semantic-prompts"].map((featureId) => ({
    kind: "term" as const,
    id: "cmux",
    version: "0.65.2",
    os: "macos",
    featureId,
    reason:
      'Untestable (no way): cmux 0.65.2 on macOS parses OSC 133 D with its exit-code option and reports it nowhere, so neither the mark nor a command-exit status is observable. Read tag v0.65.2 (9d01f956c51cd895e10e7d56b6dd7b5f6fcce625) and the vendored ghostty fork cb1ef7091cdef0b581ee2cbd83742b653253523e: src/terminal/osc/parsers/semantic_prompt.zig:30 defines end_command for D, :105,118 carries exit_code as a typed option and :359 parses it, so the sequence is understood rather than dropped. No surface reads it back: the control-socket read plane (ControlCommandExecutionPolicy+ReadPlane.swift) exposes only surface/workspace/window/pane/system list-and-text methods, cmux-tui/spec/sdk-schema.json (protocol 12, 118 commands, 50 events) has zero case-insensitive "prompt", and docs/cli-contract.md has no verb returning a prompt mark or an exit status (read-screen returns {text}, vt-state returns the PTY byte stream, jump-to-last-prompt only focuses).',
  })),
  // 34586: no OSC 633 parser in the fork, and no Mac surface reads a mark or a command line. osc633-p is not here
  // (34671, @cto 34586-cmux-cwd-finding-1246): workspace.current returns the focused panel's reported directory, which
  // OSC 7 moves, so P has an observable; until a reader measures it, it stays Probe TODO.
  ...[
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.osc-633-vscode",
  ].map((featureId) => ({
    kind: "term" as const,
    id: "cmux",
    version: "0.65.2",
    os: "macos",
    featureId,
    reason:
      'Untestable (no way): cmux 0.65.2 has no OSC 633 parser — the fork OSC command table lists 133 and no 633 — so the sequence is dropped without a target-state reading or a report. Read tag v0.65.2 (9d01f956c51cd895e10e7d56b6dd7b5f6fcce625) and the vendored ghostty fork cb1ef7091cdef0b581ee2cbd83742b653253523e: src/terminal/osc.zig:371 lists @"133" in the command table (with @"8" at :335) and the file has zero occurrences of 633. No read surface carries a mark: the control-socket read plane (ControlCommandExecutionPolicy+ReadPlane.swift) enumerates only surface/workspace/window/pane/system list-and-text methods, cmux-tui/spec/sdk-schema.json (protocol 12, 118 commands, 50 events) has zero case-insensitive "prompt", and docs/cli-contract.md has no mark verb (read-screen returns {text}, vt-state returns the PTY byte stream, jump-to-last-prompt only focuses).',
  })),
  {
    kind: "term" as const,
    id: "cmux",
    version: "0.65.2",
    os: "macos",
    featureId: "extensions.osc8",
    reason:
      "Untestable (no way): cmux 0.65.2 parses OSC 8 hyperlinks into core state and no read surface returns a cell's link. Read tag v0.65.2 (9d01f956c51cd895e10e7d56b6dd7b5f6fcce625) and the vendored ghostty fork cb1ef7091cdef0b581ee2cbd83742b653253523e: src/terminal/osc.zig:335 lists @\"8\" in the command table, :832 dispatches it, and :101-108 define the hyperlink_start/hyperlink_end commands. The text read returns text only (read-screen returns {text}: ReadScreenResult.java:13-23). The vt-state bytes cannot carry a cell's link: cmux-tui replays through the fork's VT formatter (cmux-tui server.rs:9959-9985, crates/ghostty-vt terminal.rs:4037-4065), which emits cell hyperlinks only for HTML (src/terminal/formatter.zig:1361-1366, \"We currently only emit hyperlinks for HTML\"); in VT output only an OSC 8 still open at the cursor is written (:524-526, :670-686), which is cursor state, not a cell's link. vt-state is also not a route to the app: cmux-tui serves its own PTY sessions over $TMPDIR/cmux-tui-<uid>/<session>.sock (cmux-tui/README.md:48, server.rs:1-14), while the native app's surfaces are in-process libghostty (Sources/TerminalSurface+RuntimeSurfaceCreation.swift:370). cmux-tui/spec/sdk-schema.json has no hyperlink verb.",
  },
  // 34596 (REVISION 3): 633;E has no parser and no Mac surface carries a command line.
  {
    kind: "term" as const,
    id: "ghostty",
    version: "1.4.0",
    os: "macos",
    featureId: "extensions.osc633-e",
    reason:
      "Untestable (no way): Ghostty 1.4.0 on macOS has no OSC 633 parser and no Mac surface that carries a command line. Read tag v1.4.0 (SHA256 d692bb9b, the source of the bundle version 1.4.0 the hosted run records): the accepted-number table at src/terminal/osc.zig:447-490 lists 133 and no 633, and src/termio/Termio.zig:14,66 drives the same terminal.Stream with the one StreamHandler every app runtime uses, with no OS branch in src/terminal/osc.zig or stream.zig; src/apprt/embedded.zig and macos/Sources contain zero 633. Nothing on the Mac reads a command line back either: the AppleScript dictionary exposes id, name, name override, working directory, pid and tty only (macos/Ghostty.sdef:89-100), Get Terminal Details returns the title, the working directory and plain screen text (macos/Sources/Features/App Intents/GetTerminalDetailsIntent.swift:35-47), and the C API text read returns plain characters (src/apprt/embedded.zig:1929-1960 into src/Surface.zig:2042-2051 selectionString).",
  },
  // 34596 (REVISION 3.1, @dev/fixer 08:20): osc8 is a readback cell with no click arm, so the row is honest.
  {
    kind: "term" as const,
    id: "ghostty",
    version: "1.4.0",
    os: "macos",
    featureId: "extensions.osc8",
    reason:
      "Untestable (no way): Ghostty 1.4.0 on macOS stores OSC 8 hyperlinks in core page state and no Mac surface reads a URI back. Read tag v1.4.0 (SHA256 d692bb9b, the source of the bundle version the hosted run records): src/terminal/osc.zig:447,1160 and src/terminal/osc/parsers/hyperlink.zig parse and store the link in page.hyperlink_set (src/terminal/Screen.zig:2199,2222), read internally only by Surface.osc8URI (src/Surface.zig:4603-4613) for the hover and open-url paths. The one Mac consumer is the click action, macos/Sources/Ghostty/Ghostty.App.swift:808 openURL routing the osc8 kind to openUntrustedURL (:860-883), and hover only sets dirty.hyperlink_hover (src/Surface.zig:1717). There is no readback: src/apprt/embedded.zig and macos/Sources contain zero occurrences of hyperlink, so no C API, Swift API, AppleScript property (macos/Ghostty.sdef:89-100) or Shortcuts intent (macos/Sources/Features/App Intents/GetTerminalDetailsIntent.swift:35-47) returns a URI, and hyperlink-emitting serialization is reached only from the snapshot serializers (src/terminal/snapshot/grid.zig:405,412, src/terminal/snapshot/screen.zig:2526, src/terminal/snapshot/page.zig:1140,1145,1242) which have no CLI state-dump verb. The instrument's link-metadata read has no macOS provider, and its plain term fallback cannot stand in: it writes the link, reads the cursor, and always returns probe-todo because cursor movement cannot verify OSC 8 link metadata or click behaviour (packages/probe-defs/src/extensions.ts:7395-7402).",
  },
  // 34841 (@cto Warp Q2 evidence class; REVISE 2 04:34 Nov 18): closed-source Terminal.app, so each row names the
  // exact-version surfaces exercised on an owned Mac. OSC 133/633 A, D, semantic-prompts and 633 P stay open.
  ...(
    [
      ["extensions.osc133-b", "an OSC 133 B prompt-end boundary inside the prompt line"],
      ["extensions.osc633-b", "an OSC 633 B prompt-end boundary inside the prompt line"],
      ["extensions.osc133-c", "an OSC 133 C output-start region"],
      ["extensions.osc633-c", "an OSC 633 C output-start region"],
      // @cto batch 1534 Nov 18: the P criterion is bare secondary-prompt start (new marks at two positions, history
      // unchanged), not a prompt property; the only candidate surface, the mark store, is covered by the inventory.
      ["extensions.osc133-p", "an OSC 133 P secondary-prompt start (a new prompt mark at each emitted position)"],
      ["extensions.osc633-e", "an OSC 633 E recorded command line"],
      // 34936 (@cpo/term b348b7a3, the 34871 rule: no readback, then a declaration): Wayland and systemd identities
      // have no macOS surface. osc440 stays open (a host audio-device read is a candidate), as do osc710 and osc666.
      ["extensions.osc176-app-id", "an OSC 176 application id (a Wayland app-id)"],
      ["extensions.osc3008-context", "an OSC 3008 systemd context"],
    ] as const
  ).map(([featureId, effect]) => ({
    kind: "term" as const,
    id: "terminal-app",
    version: "2.15",
    os: "macos",
    featureId,
    reason: `Untestable (no way): Terminal.app 2.15 on macOS exposes no observable in this version and setup that could carry ${effect}. ${TERMINAL_APP_215_INVENTORY} No reachable read shows this sequence's effect; this records the observation surface, not whether Terminal.app parses the sequence.`,
  })),
  // 34882 (@chief 48acc556; inventory /hh/var/@dev11/34867-OSC8-READER-INVENTORY-2026-11-18.md, sha256 a62cf79d):
  // OSC 8 has no query form, so only a per-cell link read could decide it, and none exists on these exact versions.
  // A reader that returns a cell's link replaces its row (WezTerm 20240203 reads one, 34646).
  ...(
    [
      [
        "iterm2",
        "3.6.11",
        "iTerm2 3.6.11 on macOS declares a per-cell link in its API but never sends it. GetBufferRequest.include_styles returns CellStyle, whose optional URL url = 21 is declared (iterm2-api.proto:1383-1425, identical to upstream proto/api.proto at tag v3.6.11), and the owned cell read already asks for styles (iterm2-protocol.ts readITermCells, include_styles true). At tag v3.6.11, sources/PTYSession.m protoStyleForCharacter:externalAttributes: (:18681-18776) builds an ITMURL from the cell's external attribute (:18771-18775) and returns the style without assigning style.url, so every cell arrives with no link. The Python API and it2api wrap the same message and inherit the omission; a copy-with-control-sequences action needs a pointer the owned-host no-input rule forbids.",
      ],
      [
        "com.microsoft.VSCode",
        "1.142.0",
        "VS Code 1.142.0 on macOS offers no read of a terminal cell or its link. The extension API's Terminal interface (src/vscode-dts/vscode.d.ts:7672-7683 at tag 1.142.0) carries name, processId, creationOptions, exitStatus, state, shellIntegration and send/show/hide/dispose; TerminalShellExecution.read() (:7770-7780) is command output as plain text. The proposed terminalSelection API returns plain text and terminalDataWriteEvent echoes the data written to the terminal, which is the probe's own input and cannot show what the app stored. The renderer's link layer needs a --remote-debugging-port launch, which is not a default-launch reader, and its hover tooltip needs a pointer the owned-host no-input rule forbids.",
      ],
      [
        "cursor",
        "3.25.9",
        "Cursor 3.25.9 on macOS runs the same generated extension and reports the VS Code 1.128.0 extension API (the run's editor-activation record), whose Terminal interface (src/vscode-dts/vscode.d.ts:7661-7673 at tag 1.128.0) has no buffer, cell or link read; command output is plain text. Cursor is closed source, so its internals are unprobed; through the API it ships, no cell's link can be read. Its renderer link layer needs a non-default debug launch and its hover tooltip a pointer the owned-host no-input rule forbids.",
      ],
      [
        "terminal-app",
        "2.15",
        `Terminal.app 2.15 on macOS has no read that returns a cell's link. ${TERMINAL_APP_215_INVENTORY} Across the walked accessibility tree the attribute census is 49 names, none link- or URL-shaped (AXDocument is the window's working directory, not a cell's link), and the scripting dictionary has no attribute store.`,
      ],
      [
        "warp",
        "v0.2026.10.14.08.27.stable_01",
        "Warp v0.2026.10.14.08.27.stable_01 on macOS has no programmatic read surface: its only input is the write-only launch configuration YAML, and the owned run decides Warp rows by screenshot and query reply alone. Warp is closed source, so its internals are unprobed; its hover tooltip needs a pointer the owned-host no-input rule forbids, and its logs and telemetry are not a default-launch reader.",
      ],
    ] as const
  ).map(([id, version, surface]) => ({
    kind: "term" as const,
    id,
    version,
    os: "macos",
    featureId: "extensions.osc8",
    reason: `Untestable (no way): ${surface} OSC 8 has no query form, and the plain probe only reads the cursor, which cannot verify link metadata. This records the observation surface, not whether the app stores the link.`,
  })),
  // 34596 (REVISION 3): a no-setup reason, not a no-way one.
  ...["extensions.osc133-d", "extensions.semantic-prompts"].map((featureId) => ({
    kind: "term" as const,
    id: "ghostty",
    version: "1.4.0",
    os: "macos",
    featureId,
    reason:
      "Untestable (no setup): at shipped defaults Ghostty 1.4.0 on macOS raises nothing a run can read when OSC 133;D arrives, so the cell is undecidable without a user config change. Traced in tag v1.4.0 (SHA256 d692bb9b): src/terminal/osc.zig:1180 parses 133, the exit code is an option of that parser (src/terminal/osc/parsers/semantic_prompt.zig:77-111), src/terminal/stream_terminal.zig:918-965 passes it to the effect callback, src/termio/stream_handler.zig:1475-1508 turns end_command into stop_command at :1493, and src/Surface.zig:1198-1225 emits command_finished with the exit code and the measured duration. The Mac app returns immediately on the shipped default: macos/Sources/Ghostty/Ghostty.App.swift:1642-1712 reads notifyOnCommandFinish and returns when it is never (src/config/Config.zig:1214), the action defaults to bell without notify (:1228) behind a five-second floor (:1265), and only a user setting that gate reaches the bell or a UNUserNotificationCenter banner (:1599,:1620) outside the text cells and window screenshot the run measures. The D mark and the A/B/C cycle are stored as row content, visible only to the debug inspector (src/inspector/widgets/page.zig:291 via src/input/Binding.zig:688-691) and the snapshot serializer (src/terminal/snapshot/grid.zig:259), neither of which is a default-launch reader. The only readback route needs notify-on-command-finish set away from never, which changes what Ghostty does when a command ends (a bell or a notification banner), so it is a behaviour setting, not an observer-only switch (@cto 9de3bba2).",
  })),
  {
    kind: "term",
    id: "kitty",
    version: "0.49.2",
    os: "linux",
    featureId: "extensions.osc133-p",
    reason:
      "Untestable (no way): Kitty 0.49.2 has no OSC 133 P arm in its prompt-mark parser and logs no command-specific refusal for an unknown letter on handled OSC 133. Read tag v0.49.2 kitty/vt-parser.c:630-638, kitty/screen.c:3589-3612 (switches on A, C, D only) and docs/shell-integration.rst:438-440 (Kitty uses 133;A;k=s for secondary prompts).",
  },
  ...["extensions.osc133-a", "extensions.osc133-c", "extensions.osc133-d", "extensions.semantic-prompts"].map(
    (featureId) => ({
      kind: "term" as const,
      id: "kitty",
      version: "0.49.2",
      os: "linux",
      featureId,
      reader: "kitty-prompt" as const,
    }),
  ),
  // 33628 (@cto 1957): Kitty's OSC 7 report, read through a background launch with --cwd=last_reported.
  { kind: "term", id: "kitty", version: "0.49.2", os: "linux", featureId: "extensions.osc7-cwd", reader: "kitty-cwd" },
  ...WEZTERM_LINUX_SEMANTIC_BUILDS.flatMap(({ version }) =>
    ["extensions.osc133-a", "extensions.osc133-b", "extensions.osc133-c", "extensions.osc133-p"].map((featureId) => ({
      kind: "term" as const,
      id: "wezterm",
      version,
      os: "linux",
      featureId,
      reason: `Untestable (no way): WezTerm ${version} parses OSC 133 A/B/C/P into Rust SemanticZone state with no wezterm cli semantic-zone readback and no unknown-OSC log line. Read e2a98e1b8af1..ee6f3044d09f wezterm-escape-parser/src/osc.rs:500,750-830, term/src/terminalstate/performer.rs:867-908, term/src/terminalstate/mod.rs:2831 (get_semantic_zones) and wezterm/src/cli/ (byte-identical through rev ee6f3044d09f; get-text outputs text/escapes without zones). Injecting a custom Lua user-var-changed script into target launch configuration to dump pane:get_semantic_zones() is not a default-launch reader.`,
    })),
  ),
  {
    kind: "mux",
    id: "tmux",
    version: "3.8",
    os: "linux",
    featureId: "extensions.osc633-e",
    reason:
      "Untestable (no way): tmux 3.8 has no OSC 633 handler, drops OSC 633 E in the debug-only unknown-OSC default of its input parser, and exposes no stored command-line string in capture-pane -R or formats. Read in tmux-3.8.tar.gz (SHA256 e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e): input_exit_osc at input.c:2699-2777 dispatches 133 and not 633, cmd-capture-pane.c:132-160 reports row flags without an explicit E command-line field, and the run image keeps no -v server log.",
  },
  // #32948 (@cto f400853c): 6 Linux App and mux OSC 8 hyperlink declarations at their exact pinned versions.
  {
    kind: "mux",
    id: "screen",
    version: "5.0.2",
    os: "linux",
    featureId: "extensions.osc8",
    reason:
      "Untestable (no way): GNU Screen 5.0.2 drops OSC 8 without storing, forwarding or reporting a hyperlink. Read StringEnd in ansi.c:1237-1289 in screen-5.0.2.tar.gz (SHA256 ca9a2c7e): OSC 8 is outside Screen's accepted OSC 83 and title/colour list (0, 1, 2, 11, 20, 39, 49) and hits the non-title break at :1288-1289 without calling SetXtermOSC.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "412",
    os: "linux",
    featureId: "extensions.osc8",
    reason:
      "Untestable (no way): xterm 412 has no OSC 8 hyperlink handler, cell storage or public readback. Read the complete do_osc dispatch in misc.c:3988-4360, numeric OSC aliases at 3480-3502 and colour codes at ptyx.h:1017-1037 in xterm-412.tgz (SHA256 b48bc780); OSC 8 reaches the unnamed default TRACE at misc.c:4353-4355.",
  },
  {
    kind: "term",
    id: "alacritty",
    version: "0.17.0",
    os: "linux",
    featureId: "extensions.osc8",
    reason:
      "Untestable (no way): Alacritty 0.17.0 parses OSC 8 hyperlinks via locked VTE 0.15.0 (ansi.rs:1329-1525, crate SHA256 a5924018406ce0063cd67f8e008104968b74b563ee1b85dde3ed1f7cb87d3dbd) into internal CellExtra.hyperlink state in alacritty_terminal 0.26.0 (alacritty/Cargo.toml:3,13-15 SHA256 ccbe547a224e9a13d3a08e6cd24f2c1fd1c92c28e02eda9324c14892244238ff; crate SHA256 bda177466b9524d59f1b12f0dd30b68696788e9992a7e959021c4a0ed96fcf59; src/term/mod.rs:1874-1877, src/term/cell.rs:40-98,128,202-221), with no public IPC, CLI, escape-query or non-trace log readback (alacritty/src/cli.rs:256-266 and polling/ipc.rs:62-88 expose only CreateWindow, Config and GetConfig).",
  },
  {
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId: "extensions.osc8",
    reason:
      "Untestable (no way): Ghostty 1.4.0 parses OSC 8 hyperlinks into internal page state with no public CLI, IPC, escape-query or non-debug log readback on default launch. Read tag v1.4.0 (ghostty-xpli4r8n1mqrzhbgxmkj4jfbpsjsqm3m-derived-source-tar, SHA256 d692bb9b) src/terminal/osc.zig:103-110,1160, src/terminal/osc/parsers/hyperlink.zig:9-57 and src/terminal/Screen.zig:2848-2945 (page.hyperlink_set and page.hyperlink_map); ScreenFormatter VT/HTML hyperlink serialization (src/terminal/formatter.zig:1574-1693) is invoked only for interactive GUI selections (src/Surface.zig:2338-2430,5923-5941).",
  },
  {
    kind: "term",
    id: "kitty",
    version: "0.49.2",
    os: "linux",
    featureId: "extensions.osc8",
    reason:
      "Untestable (no setup): Kitty 0.49.2 parses OSC 8 hyperlinks into Screen.hyperlink_pool and CPUCell.hyperlink_id, which are readable via kitten @ get-text --ansi when remote control is enabled, but default launch sets allow_remote_control=no and daemon.log emits no line for handled OSC 8. Read tag v0.49.2 kitty/vt-parser.c:483-510,583, kitty/screen.c:1043-1051,4514-4576, kitty/line.c:543-569,646-648 and kitty/rc/get_text.py:48-52,132-137; enabling -o allow_remote_control=socket-only --listen-on unix:<path> with before/after App qualification is tracked in #32955.",
  },
  ...WEZTERM_LINUX_SEMANTIC_BUILDS.map(({ version }) => ({
    kind: "term" as const,
    id: "wezterm",
    version,
    os: "linux",
    featureId: "extensions.osc8",
    reader: "osc8" as const,
  })),
] as const

/** A prerequisite read from this terminal child's current environment, with no address value retained. */
export function readSessionBus(env: NodeJS.ProcessEnv = process.env) {
  const address = env.DBUS_SESSION_BUS_ADDRESS ? ("present" as const) : ("absent" as const)
  const uid = process.getuid?.()
  const directory = env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`)
  const path = directory === undefined ? undefined : join(directory, "bus")
  let socket: { path: string | undefined; outcome: "present" | "absent" | "error"; code?: string }
  if (path === undefined) {
    socket = { path, outcome: "error", code: "UID_UNAVAILABLE" }
  } else {
    try {
      statSync(path)
      socket = { path, outcome: "present" }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      socket = {
        path,
        outcome: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "error",
        code: code ?? "UNKNOWN_STAT_ERROR",
      }
    }
  }
  return { observedAt: new Date().toISOString(), address, socket }
}

/** Only audited exact subjects select a declaration; another version has no answer. */
export function appSemanticDeclarations(
  subject: Pick<ProbeSubject, "kind" | "id" | "version" | "os">,
  sessionBus?: ReturnType<typeof readSessionBus>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    declarations
      .filter(
        (row): row is AppSemanticCapability & { reason: string } =>
          row.reason !== undefined &&
          row.kind === subject.kind &&
          row.id === subject.id &&
          row.version === subject.version &&
          row.os === subject.os &&
          (!("requiresMissingSessionBus" in row) ||
            (sessionBus?.address === "absent" && sessionBus.socket.outcome === "absent")),
      )
      .map((row) => [
        row.featureId,
        "requiresMissingSessionBus" in row
          ? `${row.reason} This run has no DBUS_SESSION_BUS_ADDRESS and stat(${sessionBus?.socket.path}) returned ${sessionBus?.socket.code}; no session bus is available to read the notification.`
          : row.reason,
      ]),
  )
}

/**
 * The reviewed versions of this exact App and OS when the measured version has no reviewed row of its own (34555).
 * Without it a version bump reads as "No semantic reader for this App" on every cell (34534); undefined otherwise.
 */
export function declarationDrift(
  subject: Pick<ProbeSubject, "kind" | "id" | "version" | "os">,
): { measured: string; reviewed: string[] } | undefined {
  const sameApp = declarations.filter(
    (row) => row.reason !== undefined && row.kind === subject.kind && row.id === subject.id && row.os === subject.os,
  )
  if (subject.version === undefined || sameApp.some((row) => row.version === subject.version)) return undefined
  const reviewed = [...new Set(sameApp.map((row) => row.version))].sort()
  return reviewed.length === 0 ? undefined : { measured: subject.version, reviewed }
}

/** One file-custody owner for App reports, outer commands and a not-yet-created native reply. */
export function openAppCommandLog(capture: string, pendingReplyPath?: string) {
  const log = pendingReplyPath ?? join(dirname(capture), "daemon.log")
  // The ordinary daemon log is an expected existing resource: only a specifically selected reply
  // may still be absent before its extension answers. Once seen, that file's identity is pinned too.
  let identity = pendingReplyPath === undefined ? statSync(log) : undefined
  const inspect = () => {
    try {
      return statSync(log)
    } catch (error) {
      if (
        pendingReplyPath !== undefined &&
        identity === undefined &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined
      }
      throw error
    }
  }
  const mark = () => {
    const now = inspect()
    if (now === undefined) return 0
    if (identity !== undefined && (now.dev !== identity.dev || now.ino !== identity.ino)) {
      throw new Error("Owned App log rotated")
    }
    identity ??= now
    return now.size
  }
  return {
    mark,
    async read(offset: number, artifact: string, complete: (text: string) => number | undefined) {
      const deadline = Date.now() + 5000
      let text = ""
      const retain = (end: number, completed: boolean) => {
        const bytes = Buffer.from(text.slice(0, end))
        const path = join(capture, artifact)
        writeFileSync(path, bytes)
        return { complete: completed, offset, endOffset: offset + bytes.length, path, text: bytes.toString("utf8") }
      }
      do {
        const now = inspect()
        if (now !== undefined) {
          identity ??= now
          if (now.dev !== identity.dev || now.ino !== identity.ino || now.size < offset) {
            throw new Error("Owned App log changed identity or truncated")
          }
          text = readFileSync(log).subarray(offset).toString("utf8")
          const end = complete(text)
          if (end !== undefined) return retain(end, true)
        }
        await Bun.sleep(25)
      } while (Date.now() < deadline)
      return retain(text.length, false)
    },
  }
}

// These are command reports, not a second terminal emulator. Only the qualified
// four invocation-bound paint-witness roundtrips bound this callback's command phases.
function muxSgrCommandPhases(text: string, nonce: string): OuterCommandScan<[string[], string[], string[], string[]]> {
  const commands: [string[], string[], string[], string[]] = [[], [], [], []]
  const unknown: string[] = []
  let phase: 0 | 1 | 2 | 3 = 0
  let witnesses = 0
  let cleared = false
  let start: number | undefined
  let row: number | undefined
  let column: number | undefined
  let error: string | undefined
  for (const match of text.matchAll(/([^\n]*)\n/g)) {
    const line = match[0].slice(0, -1)
    const position = /^screen_cursor_position (\d+) (\d+)$/.exec(line)
    if (position) {
      row = Number(position[1])
      column = Number(position[2])
    } else if (line.startsWith("screen_cursor_")) {
      row = undefined
      column = undefined
    } else if (line === "screen_backspace") {
      column = column !== undefined && column > 1 ? column - 1 : undefined
    } else if (line === "screen_carriage_return") {
      column = 1
    } else if (line === "screen_linefeed") {
      row = row === undefined ? undefined : row + 1
    } else if (start !== undefined && line.startsWith("select_graphic_rendition")) {
      const parameters = /^select_graphic_rendition ([0-9;:]+)$/.exec(line)?.[1]
      if (!parameters || !/^(?:\d+(?::\d+)*)(?:;\d+(?::\d+)*)*$/.test(parameters)) {
        error = `Unrecognized outer SGR command report: ${line}`
      } else if (parameters.split(";").some((value) => [38, 48, 58].includes(Number(value.split(":")[0])))) {
        error = `Extended-colour outer SGR command report cannot identify attribute forwarding: ${line}`
      } else {
        commands[phase].push(
          ...parameters.split(";").map((value) => (value === "21" ? "4:2" : value === "4:1" ? "4" : value)),
        )
      }
    } else if (line.startsWith("draw ")) {
      const value = line.slice(5)
      if (row === 1 && column === 1) {
        const full = /^([0-3])-([a-f0-9]{24})$/.exec(value)
        if (start === undefined && full?.[1] === "0" && full[2] === nonce) start = match.index
        if (start !== undefined) {
          if (value === " " && witnesses === 1) cleared = true
          const matches = full?.[1] === String(phase) && full[2] === nonce
          if (matches && witnesses === 0) {
            witnesses = 1
          } else if (witnesses === 1 && cleared && (matches || value === String(phase))) {
            witnesses = 0
            cleared = false
            if (phase === 3) {
              return { commands, error, start, end: match.index + match[0].length, unknown: named(unknown) }
            }
            phase = phase === 0 ? 1 : phase === 1 ? 2 : 3
          } else if (full && !matches) {
            error = `Outer SGR command read encountered a different invocation or phase witness: ${value}`
          }
        }
      }
      column = column === undefined ? undefined : column + Array.from(value).length
    } else if (start !== undefined) {
      unknown.push(line)
    }
  }
  return { commands, error, start, end: undefined, unknown: named(unknown) }
}

/** Record lines inside a probe's window that its matcher does not know: counted and named (@cto 1818f9ec). */
type UnknownRecordLines = { count: number; lines: string[] }
const named = (lines: string[]): UnknownRecordLines => ({ count: lines.length, lines })

type OuterCommandScan<Commands> = {
  commands: Commands
  error?: string
  start?: number
  /** End of this invocation's window in the record, once the matcher has seen it close. */
  end?: number
  unknown: UnknownRecordLines
}

/** One invocation's plan, read from the callback's own writes. */
type OuterCommandPlan = {
  nonce: string
  scan(text: string): OuterCommandScan<unknown>
  /** "deadline": the reader's deadline closes a window the matcher could not close early. */
  window: "matched" | "deadline"
  /** The measured target, or a named failure for an expected line that is missing. */
  decide(scan: OuterCommandScan<unknown>): { target: string; targetSent: boolean }
}

/** A per-probe phase matcher over the outer terminal's command record. */
type OuterCommandMatcher = { label: string; artifact: string; plan(writes: readonly string[]): OuterCommandPlan }

const sgrPaintMatcher: OuterCommandMatcher = {
  label: "SGR",
  artifact: "mux-sgr",
  plan(writes) {
    const paint = /^\x1b\[0m\x1b\[2J\x1b\[3;3H((?:\x1b\[[0-9;:]*m)*)([^\x1b]*)\x1b\[0m\x1b\[2;1H\x1b\[1;1H $/
    const phases = writes
      .flatMap((value) => {
        const match = paint.exec(value)
        return match ? [{ sequence: match[1], sample: match[2] }] : []
      })
      .slice(0, 4)
    const target = /^\x1b\[([0-9:]+)m$/.exec(phases[1]?.sequence ?? "")?.[1]
    const handled = /^\x1b\[([47])m$/.exec(phases[3]?.sequence ?? "")?.[1]
    if (
      phases.length !== 4 ||
      phases[0]?.sequence !== "" ||
      phases[2]?.sequence !== "\x1b[99m" ||
      !target ||
      !handled ||
      phases.some((phase) => phase.sample !== phases[0]?.sample)
    ) {
      throw new Error("Outer SGR command read cannot join the four controlled paint phases")
    }
    const witnesses = writes
      .flatMap((value) => {
        const match = /^\x1b\[1;1H([0-3])-([a-f0-9]{24})$/.exec(value)
        return match ? [{ phase: match[1], nonce: match[2] }] : []
      })
      .slice(0, 8)
    const nonce = witnesses[0]?.nonce
    if (
      !nonce ||
      witnesses.length !== 8 ||
      witnesses.some((entry, index) => entry.nonce !== nonce || entry.phase !== String(Math.floor(index / 2)))
    ) {
      throw new Error("Outer SGR command read has no unique same-run phase witnesses")
    }
    return {
      nonce,
      window: "matched",
      scan: (text) => muxSgrCommandPhases(text, nonce),
      decide(scan) {
        const commands = scan.commands as [string[], string[], string[], string[]]
        if (!commands[3].includes(handled)) throw new Error("Outer SGR handled control was not forwarded")
        const normalizedTarget = target === "21" ? "4:2" : target === "4:1" ? "4" : target
        return { target: normalizedTarget, targetSent: commands[1].includes(normalizedTarget) }
      },
    }
  },
}

/**
 * The outer record was read and carried no forwarding-control line. That is the one read failure a config that
 * forwards no title explains, so the grade can tell it apart from a refused plan order, an unreadable call log or
 * an unqualified reader, which each keep their own reason (#32593, @dev/15 peer read).
 */
class NoForwardingControl extends Error {}

/**
 * One target line, then a forwarding control carrying the invocation's nonce that closes its window, as whole
 * record lines. The callback writes the target FIRST and the control second (@cto 33919 condition 3): a multiplexer
 * forwards a title when it next redraws, never at the instant the pane writes it, so everything it forwarded before
 * the control is already in the record when the control line arrives. A target line found before the control belongs
 * to this invocation; one found after it is a later write's and cannot make this arm's negative sound.
 * Lines are copied verbatim from the bare Kitty 0.49.2 --dump-commands capture
 * /hh/var/@dev16/32593/kitty-dump/record.txt (sha256 a432e932819c98bfd7f5b41e0f76358f145a07a80691cbaa4bb8cb8c9355b49c),
 * retained as fixtures/kitty-osc2-osc22-commands.txt; nothing here is read from terminal source.
 */
function controlTargetMatcher(spec: {
  label: string
  control: { write: RegExp; line: (nonce: string) => string }
  /** An exact record line (OSC 22) or a pattern for the rows whose qualified line is shape-dependent (`[1.000] …`). */
  target: { write: string; line?: string; match?: RegExp }
  otherForm?: RegExp
  artifact?: string
}): OuterCommandMatcher {
  const { line: targetLine, match: targetPattern } = spec.target
  if (targetLine === undefined && targetPattern === undefined) {
    throw new Error(`Outer ${spec.label} matcher has neither a target line nor a target pattern`)
  }
  const isTargetLine = (line: string): boolean =>
    targetLine === undefined ? targetPattern?.test(line) === true : line === targetLine
  // The command word an exact target line names, or the row's own name when the line is shape-dependent.
  const targetName = targetLine === undefined ? spec.label : targetLine.slice(0, targetLine.lastIndexOf(" "))
  return {
    label: spec.label,
    artifact: spec.artifact ?? "mux-commands",
    plan(writes) {
      const controls = writes.flatMap((value) => spec.control.write.exec(value)?.[1] ?? [])
      const nonce = controls[0]
      if (controls.length !== 1 || nonce === undefined) {
        throw new Error(`Outer ${spec.label} trace has ${controls.length} forwarding control writes; one is required`)
      }
      const at = writes.findIndex((value) => spec.control.write.exec(value) !== null)
      if (!writes.slice(0, at).includes(spec.target.write)) {
        throw new Error(`Outer ${spec.label} trace has no target write before its forwarding control`)
      }
      const controlLine = spec.control.line(nonce)
      return {
        nonce,
        window: "deadline",
        scan(text) {
          const unknown: string[] = []
          let control: number | undefined
          let target: number | undefined
          let targetAfterControl: number | undefined
          for (const match of text.matchAll(/([^\n]*)\n/g)) {
            const line = match[1] ?? ""
            // The control closes this invocation's phase but does not end the read: the window runs to the deadline so
            // a target line that arrives only AFTER the control is visible, and can be refused as a negative rather
            // than counted as "the multiplexer did not send" (@cto 33919 condition 3, 33920 condition 2).
            if (line === controlLine && control === undefined) {
              control = match.index
              continue
            }
            if (isTargetLine(line)) {
              if (control === undefined) {
                if (target === undefined) target = match.index
              } else if (targetAfterControl === undefined) {
                targetAfterControl = match.index
              }
              continue
            }
            unknown.push(line)
          }
          return {
            commands: { control, target, targetAfterControl },
            start: target ?? control,
            unknown: named(unknown),
          }
        },
        decide(scan) {
          const seen = scan.commands as { control?: number; target?: number; targetAfterControl?: number }
          if (seen.control === undefined) {
            throw new NoForwardingControl(`Outer command record has no forwarding control line: ${controlLine}`)
          }
          // A target forwarded in another form (terminator, parameter, name) is not "did not send"
          // (@cto 18d11184). For an exact line the command word is its tokens before the value; a pattern row
          // names its own other form.
          const other =
            targetLine === undefined
              ? scan.unknown.lines.find((line) => spec.otherForm?.test(line) ?? false)
              : scan.unknown.lines.find((line) => line.startsWith(`${targetName} `))
          if (seen.target === undefined && other !== undefined) {
            throw new Error(`Outer command record has ${targetName} in another form than the target line: ${other}`)
          }
          // A control that arrived before the target is not a negative (@cto 33919 condition 3, 33920 condition 2):
          // whatever the multiplexer forwarded before it is already in the record, so a target line after the
          // control is a later write's and shows nothing about this invocation.
          if (seen.target === undefined && seen.targetAfterControl !== undefined) {
            throw new Error(
              `Outer command record carries ${targetLine ?? spec.label} only after its forwarding control; this invocation's target must precede it`,
            )
          }
          return { target: targetLine ?? spec.label, targetSent: seen.target !== undefined }
        },
      }
    },
  }
}

const outerCommandMatchers: Readonly<Record<string, OuterCommandMatcher>> = {
  ...Object.fromEntries(sgrProbes.map(({ id }) => [id, sgrPaintMatcher])),
  "extensions.osc22-pointer": controlTargetMatcher({
    label: "OSC 22",
    control: { write: MUX_TITLE_CONTROL_WRITE, line: (nonce) => `set_title ${nonce}` },
    target: { write: "\x1b]22;pointer\x1b\\", line: "set_dynamic_color 22 pointer" },
  }),
  "extensions.kitty-graphics": controlTargetMatcher({
    label: "the Kitty graphics query",
    control: { write: MUX_TITLE_CONTROL_WRITE, line: (nonce) => `set_title ${nonce}` },
    target: {
      write: "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\",
      match: /^graphics_command \{.*"action": "q".*"format": 24,.*"id": 31,/,
    },
    otherForm: /^(?:Malformed )?[Gg]raphics/,
    artifact: "mux-outer-row",
  }),
  "extensions.osc701-locale": controlTargetMatcher({
    label: "OSC 701",
    control: { write: MUX_TITLE_CONTROL_WRITE, line: (nonce) => `set_title ${nonce}` },
    target: { write: "\x1b]701;?\x07", match: /^\[[0-9.]+\] Ignoring OSC 701, used by mintty for locale$/ },
    otherForm: /OSC 701|escape code: 701/,
    artifact: "mux-outer-row",
  }),
  "extensions.osc702-version": controlTargetMatcher({
    label: "OSC 702",
    control: { write: MUX_TITLE_CONTROL_WRITE, line: (nonce) => `set_title ${nonce}` },
    target: { write: "\x1b]702;?\x07", match: /^\[[0-9.]+\] Unknown OSC escape code: 702;\?$/ },
    otherForm: /escape code: 702(?!;\?$)|OSC 702/,
    artifact: "mux-outer-row",
  }),
  "extensions.osc776-cell-size": controlTargetMatcher({
    label: "OSC 776",
    control: { write: MUX_TITLE_CONTROL_WRITE, line: (nonce) => `set_title ${nonce}` },
    target: { write: "\x1b]776\x07", match: /^\[[0-9.]+\] Unknown OSC escape code: 776$/ },
    otherForm: /escape code: 776(?!$)|OSC 776/,
    artifact: "mux-outer-row",
  }),
  "extensions.osc7770-font-size": controlTargetMatcher({
    label: "OSC 7770",
    control: { write: MUX_TITLE_CONTROL_WRITE, line: (nonce) => `set_title ${nonce}` },
    target: { write: "\x1b]7770;?\x07", match: /^\[[0-9.]+\] Ignoring OSC 7770, used by mintty for font size$/ },
    otherForm: /OSC 7770|escape code: 7770/,
    artifact: "mux-outer-row",
  }),
}

/** True when the one outer command reader has a matcher for this probe's callback writes. */
export function hasOuterCommandMatcher(featureId: string): boolean {
  return featureId.startsWith("sgr.") || Object.hasOwn(outerCommandMatchers, featureId)
}

/** Collector-local outer command read for every per-probe matcher (the name predates the non-SGR matchers); ownership comes from the existing live terminal owner. */
/**
 * Does this run's mux config forward a title — the OSC 2 forwarding control — to the outer terminal? Declared per
 * multiplexer: GNU Screen passes the pane's title through with any config (measured in the 32593 run-1112 screen
 * record), while tmux forwards one only with its documented `set-titles` option on (off by default in 3.8). A
 * profile's exact bytes come from the same table the placement check reads, so a label cannot drift from its file.
 * Undefined when the mux or its recorded config is unknown, which leaves the reader's own reason in place.
 */
function muxForwardsTitle(mux: string | undefined, config: string | null | undefined): boolean | undefined {
  if (mux === undefined) return undefined
  if (mux !== "tmux") return true
  if (config === null || config === undefined) return undefined
  const profile = MUX_PROFILE_CONFIG_FILES[config]
  return profile === undefined ? false : configSetsOptionOn(profile.content, "set-titles")
}

/**
 * Reads one tmux option out of the bytes a profile starts the mux with, as tmux itself reads them (#33995): a
 * `set`/`set-option` command, its flags, then the option name and value. A bare `set-titles on` line is not a
 * command — tmux exits 0 having ignored it — so it does not count as setting anything.
 */
function configSetsOptionOn(content: string, option: string): boolean {
  return content.split("\n").some((line) => {
    const [command, ...words] = line.trim().split(/\s+/)
    if (command !== "set" && command !== "set-option") return false
    const [name, value] = words.filter((word) => !word.startsWith("-"))
    return name === option && value === "on"
  })
}

export function beginMuxSgrCommandRead(input: {
  featureId: string
  subject: Pick<ProbeSubject, "kind"> &
    Partial<Pick<ProbeSubject, "id" | "version" | "os" | "outerTerminal" | "config">>
  proof?: Pick<LinuxMuxAttachmentProof, "platform" | "mux" | "launchRunId" | "collector">
}) {
  try {
    const { subject, proof } = input
    const env = process.env
    const titlesForwarded = muxForwardsTitle(subject.id, subject.config)
    if (
      subject.kind !== "mux" ||
      !declarations.some(
        (entry) =>
          entry.outerCommands &&
          entry.featureId === input.featureId &&
          entry.kind === subject.kind &&
          entry.id === subject.id &&
          entry.version === subject.version &&
          entry.os === subject.os,
      )
    ) {
      throw new Error(`No qualified outer command reader for ${subject.id} ${subject.version} ${input.featureId}`)
    }
    if (
      subject.outerTerminal !== "kitty" ||
      env.TERMINFO_TARGET_ID !== "kitty" ||
      env.TERMINFO_TARGET_VERSION !== "0.49.2"
    ) {
      throw new Error("Outer command read requires this run's qualified Kitty 0.49.2")
    }
    if (
      !proof ||
      proof.platform !== "linux" ||
      proof.mux !== subject.id ||
      proof.mux !== env.TERMINFO_MUX_KIND ||
      proof.launchRunId !== env.TERMINFO_RUN_ID ||
      proof.collector.pid !== process.pid
    ) {
      throw new Error("Outer command read has no matching owned mux launch")
    }
    const capture = env.TERMINFO_CAPTURE_DIRECTORY
    if (!capture || !isAbsolute(capture)) throw new Error("Outer command read has no owned artifact directory")
    const matcher = outerCommandMatchers[input.featureId]
    if (!matcher) throw new Error(`No outer command matcher for ${input.featureId}`)
    const outer = { app: subject.outerTerminal, version: env.TERMINFO_TARGET_VERSION }
    const log = openAppCommandLog(capture)
    const offset = log.mark()
    return {
      status: "ready" as const,
      async read(callLog: string | undefined) {
        const detail: {
          offset: number
          endOffset?: number
          phaseStartOffset?: number
          nonce?: string
          path?: string
          appended?: string
          commands?: unknown
          unknown?: UnknownRecordLines
          closedBy?: "match" | "deadline"
        } = { offset }
        try {
          if (callLog === undefined) throw new Error(`Missing same-run callback trace: ${input.featureId}.callLog`)
          const writes: string[] = []
          readCallLog(JSON.parse(callLog), {
            onOperation(operation) {
              if (operation.path !== "context.write") return
              const text = operation.args[0]
              if (typeof text !== "string") {
                throw new Error(`Outer ${matcher.label} trace contains a non-text context.write`)
              }
              writes.push(text)
            },
          })
          const plan = matcher.plan(writes)
          detail.nonce = plan.nonce
          const reading = await log.read(
            offset,
            `${matcher.artifact}-${input.featureId}-${randomUUID()}.log`,
            (text) => plan.scan(text).end,
          )
          detail.path = reading.path
          detail.endOffset = reading.endOffset
          detail.appended = reading.text
          const parsed = plan.scan(reading.text)
          if (parsed.start !== undefined) {
            detail.phaseStartOffset = offset + Buffer.byteLength(reading.text.slice(0, parsed.start))
          }
          detail.commands = parsed.commands
          detail.unknown = parsed.unknown
          if (parsed.error) throw new Error(parsed.error)
          if (!reading.complete && plan.window === "matched") {
            throw new Error(`Outer ${matcher.label} command read did not observe phase completion`)
          }
          detail.closedBy = reading.complete ? "match" : "deadline"
          const { target, targetSent } = plan.decide(parsed)
          // Custody of the retained window (33630): the digest and size of the bytes this read kept. The row's
          // evidence stays the control and target lines; this only lets a reason name the trace it read.
          const retained = Buffer.from(reading.text)
          const trace = {
            sha256: createHash("sha256").update(retained).digest("hex"),
            lines:
              retained.length === 0
                ? 0
                : retained
                    .toString("utf8")
                    .split("\n")
                    .filter((line) => line.length > 0).length,
            window: { offset, endOffset: reading.endOffset },
          }
          return { status: "measured" as const, target, targetSent, outer, trace, detail }
        } catch (error) {
          return {
            status: "unavailable" as const,
            reason: error instanceof Error ? error.message : String(error),
            titlesForwarded,
            noForwardingControl: error instanceof NoForwardingControl,
            detail,
          }
        }
      },
    }
  } catch (error) {
    return {
      status: "unavailable" as const,
      reason: error instanceof Error ? error.message : String(error),
      titlesForwarded: muxForwardsTitle(input.subject.id, input.subject.config),
      noForwardingControl: error instanceof NoForwardingControl,
    }
  }
}

/** The existing bounded semantic read loop, shared by native readers without another polling mechanism. */
/**
 * An owned cwd getter's failure whose public half is safe to publish: the phase that failed and a reason built only
 * from error numbers and counts, never a path, title or URI (34870 r1 item 4). The raw diagnostic is the message,
 * which stays in the private evidence.
 */
export class OwnedCwdReadError extends Error {
  constructor(
    readonly phase: string,
    readonly publicReason: string,
    diagnostic: string,
  ) {
    super(diagnostic)
  }
}

/** The publishable reason for an owned cwd failure; anything but an OwnedCwdReadError keeps only a pointer. */
export function ownedCwdFailure(error: unknown): string {
  return error instanceof OwnedCwdReadError
    ? `Owned cwd observation failed in the ${error.phase} phase: ${error.publicReason}`
    : "Owned cwd observation failed; see private evidence"
}

export async function untilAppSemanticRead(
  read: () => string | Promise<string>,
  complete: (value: string) => boolean,
  name: string,
  phases: object[],
): Promise<string> {
  const deadline = Date.now() + 5000
  let last = ""
  do {
    last = await read()
    if (complete(last)) return last
    await Bun.sleep(25)
  } while (Date.now() < deadline)
  phases.push({ name, incomplete: last })
  throw new Error(`App semantic reader did not observe ${name} completion`)
}

/**
 * WezTerm `cli get-text --escapes` rows as the OSC 8 reader compares them: hyperlink escapes and their params
 * kept, the serializer's presentation wrappers (SGR, charset) discarded.
 */
export function weztermHyperlinkText(rows: readonly string[]): string {
  return rows
    .join("\n")
    .replace(ANSI_REGEX, (code) => (code.startsWith("\x1b]8;") || code.startsWith("\x9d8;") ? code : ""))
    .replaceAll("\x1b(B", "")
}

/** The prompt rows the iTerm2 prompt-mark reader answers (34570; the OSC 633 rows 34866). */
export const ITERM_PROMPT_FEATURES: ReadonlySet<string> = new Set([
  "extensions.osc133-a",
  "extensions.osc133-b",
  "extensions.osc133-c",
  "extensions.osc133-d",
  "extensions.osc133-p",
  "extensions.semantic-prompts",
  "extensions.osc633-a",
  "extensions.osc633-b",
  "extensions.osc633-c",
  "extensions.osc633-d",
  "extensions.osc633-e",
  "extensions.osc633-p",
  "extensions.osc-633-vscode",
])

const promptOsc = (value: string) => `\x1b]${value}\x07`
/**
 * What a shell prints around the marks (34570; hosted run 44146186014 read every mark EDITING without it).
 * iTerm2 3.6.11 VT100ScreenMutableState.m drops B as a duplicate when nothing moved the cursor since A
 * (promptEndedAndCommandStartedAt, shortCircuitDups), records C only when the command text since B is
 * non-blank (commandDidEndWithRange), and puts D's code on the last mark that ran a command.
 */
const ITERM_PROMPT_TEXT = "$ "
const itermCommand = (nonce: string) => `terminfo-command-${nonce}`
const EDITING_NEW = { mark: "new", state: "EDITING", command: "unset", output: "unset", exit: "absent" }

/**
 * Each prompt row: the feed appended after the finished baseline mark, the mark state that feed must
 * produce (`from`, default a finished mark), the target feeds in order, and the expected projection after
 * each. B is the command-entry boundary (command range set, still EDITING), C begins execution (output
 * start set, RUNNING), D;17 finishes with that code (iTerm2 3.6.11 PTYSession getPromptResponseForMark).
 */
type ITermPromptRow = {
  /** Printed after the clear and before the finished baseline mark; moves that mark down the screen. */
  head?: string
  tail: (nonce: string) => string
  from?: object
  feeds: ((nonce: string) => string)[]
  expected: object[]
}
const ITERM_PROMPT_ROWS: Record<string, ITermPromptRow> = {
  "extensions.osc133-a": { tail: () => "", feeds: [() => promptOsc("133;A")], expected: [EDITING_NEW] },
  "extensions.osc133-b": {
    tail: () => promptOsc("133;A") + ITERM_PROMPT_TEXT,
    from: { mark: "same", state: "EDITING", command: "unset", output: "unset", exit: "absent" },
    feeds: [() => promptOsc("133;B")],
    expected: [{ mark: "same", state: "EDITING", command: "set", output: "unset", exit: "absent" }],
  },
  "extensions.osc133-c": {
    tail: (nonce) => promptOsc("133;A") + ITERM_PROMPT_TEXT + promptOsc("133;B") + itermCommand(nonce),
    from: { mark: "same", state: "EDITING", command: "set", output: "unset", exit: "absent" },
    feeds: [() => promptOsc("133;C")],
    expected: [{ mark: "same", state: "RUNNING", command: "set", output: "set", exit: "absent" }],
  },
  "extensions.osc133-d": {
    tail: (nonce) =>
      promptOsc("133;A") +
      ITERM_PROMPT_TEXT +
      promptOsc("133;B") +
      itermCommand(nonce) +
      promptOsc("133;C") +
      `\r\nterminfo-output-${nonce}\r\n`,
    from: { mark: "same", state: "RUNNING", command: "set", output: "set", exit: "absent" },
    feeds: [() => promptOsc("133;D;17")],
    expected: [{ mark: "same", state: "FINISHED", command: "set", output: "set", exit: 17 }],
  },
  "extensions.semantic-prompts": {
    tail: () => "",
    feeds: [
      () => promptOsc("133;A") + ITERM_PROMPT_TEXT,
      (nonce) => promptOsc("133;B") + itermCommand(nonce),
      (nonce) => promptOsc("133;C") + `\r\nterminfo-output-${nonce}\r\n`,
      () => promptOsc("133;D;17"),
    ],
    expected: [
      EDITING_NEW,
      { mark: "new", state: "EDITING", command: "set", output: "unset", exit: "absent" },
      { mark: "new", state: "RUNNING", command: "set", output: "set", exit: "absent" },
      { mark: "new", state: "FINISHED", command: "set", output: "set", exit: 17 },
    ],
  },
}

/**
 * 34866 (@cto 34866-osc633-controls-r1 item 1): each OSC 633 mark row runs its OSC 133 counterpart from the
 * same start as the positive control, so the control moves the very projection the target is graded on; the
 * start is then rebuilt and checked before the 633 feed. The target is the counterpart's feed with 133
 * replaced by 633, letter for letter; the start is built with 133 as the counterpart's own row builds it.
 */
const ITERM_633_COUNTERPARTS: Record<string, string> = {
  "extensions.osc633-a": "extensions.osc133-a",
  "extensions.osc633-b": "extensions.osc133-b",
  "extensions.osc633-c": "extensions.osc133-c",
  "extensions.osc633-d": "extensions.osc133-d",
  "extensions.osc-633-vscode": "extensions.semantic-prompts",
}
const as633 = (feed: string) => feed.replaceAll("\x1b]133;", "\x1b]633;")

/**
 * Directory and command values the reader wrote itself are kept; any other value is logged by digest only.
 * Only text carrying this row's nonce is the reader's own: a session directory that merely looks like fixture
 * text is still the session's (34888).
 */
const itermFixtureText = (value: string, nonce: string) =>
  /^\/?terminfo-[A-Za-z0-9-]+$/.test(value) && value.endsWith(`-${nonce}`)

/**
 * One controlled iTerm2 prompt-mark observation per row (34570, @cto REVISE-1 R2-R5). Each phase writes its
 * feed plus an OSC 1337 SetUserVar fence, waits until the session reports that fence, then takes a FRESH
 * GetPrompt read of the session's last prompt mark; no row borrows another row's read. A read is projected
 * to the fields a row can change, with the mark named relative to the baseline mark: `same`, `new` or
 * `absent` (never an absolute id or row). The OSC 133 rows' handled control is the fence variable itself, as
 * Kitty's is its title. OSC 133;P (34866, @cto osc133p-r2, replacing R3 for this reader) is the secondary
 * prompt start: two OSC 133;A controls at the criterion's cells must each register a new prompt mark before
 * two bare P targets at the same cells are read. P adding no mark is Unsupported; any P mark stays a TODO,
 * since a line mark cannot show the target column (with the history read kept in the reading).
 *
 * The OSC 633 rows (34866) need a control that moves the graded projection, so a fence alone never
 * qualifies them: A-D and the composite take their 133 counterpart; E takes typed command text against
 * GetPrompt's command field; P keeps the Cwd criterion, two OSC 7 controls and two distinct Cwd targets on
 * GetPrompt's working directory, compared exactly. An inert control is unavailable, never unsupported.
 */
export async function readITermPromptMarks(input: {
  featureId: string
  runId: string
  write: (text: string) => void | Promise<void>
  /**
   * The owner's private TTY writer. Only P's restoration uses it: that feed carries the session's own
   * directory, which must stay out of the probe source's publishable write trace (CTO6a2de139).
   */
  privateWrite?: (text: string) => void | Promise<void>
  /** Opens the owned session's prompt API for one row; only rows that read anything open it. */
  withSession: (work: (session: ITermPromptSession) => Promise<AppSemanticReading>) => Promise<AppSemanticReading>
}): Promise<AppSemanticReading> {
  if (input.featureId === "extensions.osc633-p" && input.privateWrite === undefined) {
    return {
      status: "invalid",
      reason: "iTerm2 OSC 633 P needs the owner's private writer to restore the session's directory",
    }
  }
  const counterpart = ITERM_633_COUNTERPARTS[input.featureId]
  const markRow = ITERM_PROMPT_ROWS[counterpart ?? input.featureId]
  if (
    markRow === undefined &&
    input.featureId !== "extensions.osc633-e" &&
    input.featureId !== "extensions.osc633-p" &&
    input.featureId !== "extensions.osc133-p"
  ) {
    throw new Error(`No iTerm2 prompt-mark reader for ${input.featureId}`)
  }
  return input.withSession(async (session) => {
    const osc = promptOsc
    const nonce = randomUUID().slice(0, 8)
    const phases: object[] = []
    const detail: {
      reader: string
      nonce: string
      phases: object[]
      nonceVerification?: string
      column?: string
      history?: string | object
      controls?: object[]
      targets?: object[]
    } = {
      reader: "iterm2-prompt",
      nonce,
      phases,
    }
    let baselineId: string | undefined
    let serial = 0
    const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16)
    /** A command or directory the reader did not write is shown by digest, never as text. */
    const shown = (value: string | undefined) =>
      value === undefined ? undefined : itermFixtureText(value, nonce) ? value : `private-sha256:${digest(value)}`
    const logged = (read: ITermPromptRead): ITermPromptRead => {
      if (read.status !== "mark") return read
      const { command, workingDirectory, ...mark } = read.mark
      return {
        status: "mark",
        mark: {
          ...mark,
          ...(command !== undefined && { command: shown(command) }),
          ...(workingDirectory !== undefined && { workingDirectory: shown(workingDirectory) }),
        },
      }
    }
    const describe = (read: ITermPromptRead) => {
      if (read.status === "prompt-unavailable") return { mark: "prompt-unavailable" }
      const { mark } = read
      return {
        mark: mark.uniquePromptId === undefined ? "absent" : mark.uniquePromptId === baselineId ? "same" : "new",
        state: mark.promptState ?? "absent",
        command: mark.commandRange === undefined ? "unset" : "set",
        output: mark.outputRange === undefined ? "unset" : "set",
        exit: mark.exitStatus ?? "absent",
      }
    }
    let current = "first"
    const phase = async (
      name: string,
      feed: string,
      fence = `terminfo-${nonce}-${serial++}`,
      route: { write: (text: string) => void | Promise<void>; shownFeed?: string } = { write: input.write },
    ) => {
      current = name
      await route.write(feed + osc(`1337;SetUserVar=terminfo_fence=${Buffer.from(fence).toString("base64")}`))
      const observed = await untilAppSemanticRead(
        async () => String(await session.readUserVariable("terminfo_fence")),
        (value) => value === fence,
        `${name} user-variable fence`,
        phases,
      )
      const read = await session.readPrompt()
      phases.push({ name, feed: route.shownFeed ?? feed, fence: observed, read: logged(read) })
      return { read, fence: observed }
    }
    const finished =
      osc("133;A") + ITERM_PROMPT_TEXT + osc("133;B") + itermCommand(nonce) + osc("133;C") + "\r\n" + osc("133;D;0")
    const clear = "\x1b[2J\x1b[3J\x1b[H"
    const finishedMark = { mark: "same", state: "FINISHED", command: "set", output: "set", exit: 0 }
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
    const unavailableBaseline: AppSemanticReading = {
      status: "unavailable",
      reason:
        "iTerm2 answered PROMPT_UNAVAILABLE after the baseline OSC 133 sequence: the session has no prompt mark (the API's own status, not proof shell integration is absent)",
      detail,
    }
    /** Clear, finish one mark, append the row's tail; the fresh baseline mark names every later read. */
    const baseline = async (name: string, row: ITermPromptRow) => {
      const read = await phase(name, clear + (row.head ?? "") + finished + row.tail(nonce))
      if (read.read.status === "prompt-unavailable") return undefined
      baselineId = read.read.mark.uniquePromptId
      const start = describe(read.read)
      // The row's experiment holds only from its assumed starting mark. A baseline that did not reach it
      // is reported, never graded: a target compared against the wrong start could read as unsupported.
      if (JSON.stringify(start) !== JSON.stringify(row.from ?? finishedMark)) {
        throw new BaselineMiss(
          `iTerm2 prompt mark did not reach this row's ${name} ${JSON.stringify(row.from ?? finishedMark)}; read ${JSON.stringify(start)}`,
        )
      }
      return start
    }
    /** P's initial directory, kept only to restore it; never logged or returned as text. */
    let initialDirectory: string | undefined
    let directoryMoved = false
    let reading: AppSemanticReading
    try {
      reading =
        input.featureId === "extensions.osc633-e"
          ? await measureCommandText()
          : input.featureId === "extensions.osc633-p"
            ? await measureDirectory()
            : input.featureId === "extensions.osc133-p"
              ? await measureSecondaryPrompt()
              : counterpart !== undefined && markRow !== undefined
                ? await measureCounterpart(markRow)
                : await measureRow(markRow as ITermPromptRow)
    } catch (error) {
      reading = {
        status: "invalid",
        reason:
          error instanceof BaselineMiss
            ? error.message
            : `iTerm2 prompt read failed in the ${current} phase: ${message(error)}`,
        detail,
      }
    }
    const restoreFailures: string[] = []
    if (directoryMoved && initialDirectory !== undefined) {
      // 34866 (@cto r1 item 3): 133;D;0 and a clear do not restore a directory; OSC 7 to the initial value
      // does, through the private writer, and the fresh prompt line must read that value back exactly.
      const initial = initialDirectory
      try {
        const restored = await phase(
          "directory-restored",
          osc(`7;file://localhost${pathToFileURL(initial).pathname}`) + "\r\n" + osc("133;A") + ITERM_PROMPT_TEXT,
          `terminfo-${nonce}-directory-restored`,
          {
            write: input.privateWrite as (text: string) => void | Promise<void>,
            shownFeed: "OSC 7 to the initial directory (private)",
          },
        )
        const value = restored.read.status === "mark" ? restored.read.mark.workingDirectory : undefined
        if (value !== initial) restoreFailures.push(`the directory read back as ${String(shown(value))}`)
      } catch (error) {
        restoreFailures.push(`restoring the directory failed: ${message(error)}`)
      }
    }
    try {
      await phase("restored", osc("133;D;0") + clear, `terminfo-${nonce}-restored`)
    } catch (error) {
      restoreFailures.push(`restoring the session failed: ${message(error)}`)
    }
    if (restoreFailures.length > 0) {
      const restore = restoreFailures.join("; ")
      // Any unsuccessful reading, thrown or returned, keeps its own reason first (@cto 5a892117).
      const primary = reading.status === "measured" ? undefined : reading.reason
      reading = {
        status: "invalid",
        reason: primary === undefined ? `iTerm2 prompt row was read, but ${restore}` : `${primary}; then ${restore}`,
        detail,
      }
    }
    return reading

    async function measureRow(row: ITermPromptRow): Promise<AppSemanticReading> {
      const start = await baseline("baseline", row)
      if (start === undefined) return unavailableBaseline
      // The controls run from that start, so an unknown letter that moves the mark fails the controls.
      const unknown = await phase("unknown", osc("133;Z"))
      const handled = await phase("handled", "", `terminfo-control-${nonce}`)
      const before = describe(handled.read)
      const after: object[] = []
      for (const [index, feed] of row.feeds.entries()) {
        after.push(describe((await phase(`target-${index}`, feed(nonce))).read))
      }
      const single = row.feeds.length === 1
      return {
        status: "measured",
        reader: "state",
        runId: input.runId,
        unknown: { before: JSON.stringify(start), after: JSON.stringify(describe(unknown.read)) },
        handled: { before: unknown.fence, after: handled.fence, expected: `terminfo-control-${nonce}` },
        target: {
          before: JSON.stringify(single ? before : row.feeds.map(() => before)),
          after: JSON.stringify(single ? after[0] : after),
          expected: JSON.stringify(single ? row.expected[0] : row.expected),
        },
        detail,
      }
    }

    async function measureCounterpart(row: ITermPromptRow): Promise<AppSemanticReading> {
      const start = await baseline("baseline", row)
      if (start === undefined) return unavailableBaseline
      // The inert unknown is in the target's own namespace.
      const unknown = describe((await phase("unknown", osc("633;Z"))).read)
      const control: object[] = []
      for (const [index, feed] of row.feeds.entries()) {
        control.push(describe((await phase(`control-133-${index}`, feed(nonce))).read))
      }
      // Rebuild the start and bind mark identity to the fresh baseline before the 633 feed.
      const rebuilt = await baseline("rebaseline", row)
      if (rebuilt === undefined) return unavailableBaseline
      const target: object[] = []
      for (const [index, feed] of row.feeds.entries()) {
        target.push(describe((await phase(`target-633-${index}`, as633(feed(nonce)))).read))
      }
      const single = row.feeds.length === 1
      const each = (value: object) => JSON.stringify(single ? value : row.feeds.map(() => value))
      const list = (values: object[]) => JSON.stringify(single ? values[0] : values)
      return {
        status: "measured",
        reader: "state",
        runId: input.runId,
        unknown: { before: JSON.stringify(start), after: JSON.stringify(unknown) },
        handled: { before: each(start), after: list(control), expected: list(row.expected) },
        target: { before: each(rebuilt), after: list(target), expected: list(row.expected) },
        detail,
      }
    }

    async function measureCommandText(): Promise<AppSemanticReading> {
      // GetPrompt's command field, with presence: absent is not empty.
      const text = (read: ITermPromptRead) =>
        JSON.stringify(
          read.status !== "mark"
            ? { command: "prompt-unavailable" }
            : read.mark.command === undefined
              ? { command: "absent" }
              : { command: "text", text: shown(read.mark.command) },
        )
      const prompt = { tail: () => osc("133;A") + ITERM_PROMPT_TEXT + osc("133;B") }
      const first = await phase("baseline", clear + finished + prompt.tail())
      if (first.read.status === "prompt-unavailable") return unavailableBaseline
      const start = text(first.read)
      const unknown = text((await phase("unknown", osc("633;Z"))).read)
      const typed = `terminfo-typed-${nonce}`
      const control = text((await phase("control-typed", typed)).read)
      const controlExpected = JSON.stringify({ command: "text", text: typed })
      // An inert or missing control is unavailable, never unsupported (@cto r1 item 2).
      if (control === start) {
        return {
          status: "unavailable",
          reason: "iTerm2 GetPrompt command text did not move with typed command text; the field cannot grade E here",
          detail,
        }
      }
      // Reset: a fresh prompt must return the field to the start before E is sent.
      const reset = text((await phase("reset", "\r\n" + prompt.tail())).read)
      if (reset !== start) {
        throw new BaselineMiss(
          `iTerm2 command text did not return to its start ${start} after a fresh prompt; read ${reset}`,
        )
      }
      // The E payload differs from the typed control and is never printed as ordinary text.
      const payload = `terminfo-e-${nonce}`
      const target = text((await phase("target-633-e", osc(`633;E;${payload}`))).read)
      detail.nonceVerification = "not tested: OSC 633 E was sent without a nonce"
      return {
        status: "measured",
        reader: "state",
        runId: input.runId,
        unknown: { before: start, after: unknown },
        handled: { before: start, after: control, expected: controlExpected },
        target: { before: reset, after: target, expected: JSON.stringify({ command: "text", text: payload }) },
        detail,
      }
    }

    async function measureSecondaryPrompt(): Promise<AppSemanticReading> {
      // features.json osc133-p: two A controls, then bare P at row 0 col 0 and row 1 col 2. iTerm2 3.6.11
      // prompt marks are line marks (VT100ScreenMutableState setPromptStartLine writes prompt_range x 0), so a
      // mark is read as registered-or-not plus its screen row; no column is readable.
      const cells: [number, number][] = [
        [0, 0],
        [1, 2],
      ]
      const at = ([row, column]: [number, number]) => `\x1b[${row + 1};${column + 1}H`
      // An A at the current prompt's own start is a redraw (promptDidStartAt short circuit, issue 10963), so the
      // baseline mark sits on row 3, away from both cells.
      const baselineRow = 3
      const plainRow: ITermPromptRow = { head: "\r\n".repeat(baselineRow), tail: () => "", feeds: [], expected: [] }
      let originLine = 0n
      /** Bind screen rows to the baseline mark just read. */
      const anchorAt = (read: ITermPromptRead, name: string) => {
        const range = read.status === "mark" ? read.mark.promptRange : undefined
        if (range === undefined) throw new BaselineMiss(`iTerm2 ${name} mark has no prompt range to anchor lines`)
        originLine = BigInt(range.start.y) - BigInt(baselineRow)
      }
      // GetPrompt without an id answers lastPromptMark, the prompt mark LOWEST on screen, not the newest
      // (VT100ScreenState lastMarkMustBePrompt walks the interval tree in reverse position order; hosted runs
      // 44354139927 and 44357053950 read marks above the baseline as "same"). Registration is therefore read as
      // the ids ListPrompts gains across a phase, each new mark read by its id for its row.
      type Registration = { mark: string; line?: number | string }
      let known: string[] = []
      const listed = async (): Promise<string[] | string> => {
        try {
          return await session.listPrompts()
        } catch (error) {
          return `ListPrompts failed: ${message(error)}`
        }
      }
      const registered = async (): Promise<{ projection: Registration; ids: string[] } | string> => {
        const ids = await listed()
        if (typeof ids === "string") return ids
        const added = ids.filter((id) => !known.includes(id))
        const removed = known.filter((id) => !ids.includes(id)).length
        known = ids
        if (removed > 0) return { projection: { mark: `removed-${removed}` }, ids: added }
        if (added.length === 0) return { projection: { mark: "same" }, ids: [] }
        if (added.length > 1) return { projection: { mark: `new-${added.length}` }, ids: added }
        const read = await session.readPrompt(added[0])
        const range = read.status === "mark" ? read.mark.promptRange : undefined
        const line = range === undefined ? "absent" : Number(BigInt(range.start.y) - originLine)
        return { projection: { mark: "new", line }, ids: added }
      }
      const blind = (why: string): AppSemanticReading => ({
        status: "unavailable",
        reason: `iTerm2 prompt registration cannot be read without ListPrompts (${why}); OSC 133 P cannot be graded here`,
        detail,
      })
      /** The fields a later write cannot move. GetPrompt fills output end from the cursor, and command and
       * directory from the session when the mark has none (PTYSession getPromptResponseForMark), so those are
       * not history. */
      const stable = (read: ITermPromptRead) =>
        read.status !== "mark"
          ? read.status
          : JSON.stringify([
              read.mark.uniquePromptId,
              read.mark.promptState,
              read.mark.exitStatus,
              read.mark.promptRange,
              read.mark.commandRange,
              read.mark.outputRange?.start,
            ])
      const history = async (): Promise<Map<string, string> | string> => {
        const ids = await listed()
        if (typeof ids === "string") return ids
        try {
          const marks = new Map<string, string>()
          for (const id of ids) marks.set(id, stable(await session.readPrompt(id)))
          return marks
        } catch (error) {
          return message(error)
        }
      }
      const rebind = async (name: string) => {
        if ((await baseline(name, plainRow)) === undefined) return false
        anchorAt((phases.at(-1) as { read: ITermPromptRead }).read, name)
        const ids = await listed()
        if (typeof ids === "string") return ids
        known = ids
        return true
      }
      const first = await rebind("baseline")
      if (first === false) return unavailableBaseline
      if (typeof first === "string") return blind(first)
      const start: Registration = { mark: "same" }
      await phase("unknown", osc("133;Z"))
      const unknown = await registered()
      if (typeof unknown === "string") return blind(unknown)
      // A corrupt control is invalid whatever P later does; the grader only sees it on the measured path.
      if (JSON.stringify(unknown.projection) !== JSON.stringify(start)) {
        return {
          status: "invalid",
          reason: `iTerm2 unknown OSC 133 Z changed the prompt marks (${JSON.stringify(unknown.projection)}); controls failed in this row`,
          detail,
        }
      }
      const controls: Registration[] = []
      for (const [index, cell] of cells.entries()) {
        await phase(`control-133-a-${index}`, at(cell) + osc("133;A"))
        const control = await registered()
        if (typeof control === "string") return blind(control)
        controls.push(control.projection)
      }
      detail.column = "not observable: iTerm2 3.6.11 prompt marks are line marks (prompt_range x is always 0)"
      detail.controls = controls
      // An A control that registers no mark leaves the reader blind here: unavailable, never unsupported.
      if (!controls.every((control) => control.mark === "new")) {
        return {
          status: "unavailable",
          reason: `iTerm2 did not register a new prompt mark for both OSC 133 A controls (${JSON.stringify(controls)}); P cannot be graded here`,
          detail,
        }
      }
      const again = await rebind("rebaseline")
      if (again === false) return unavailableBaseline
      if (typeof again === "string") return blind(again)
      const before = await history()
      const targets: Registration[] = []
      const targetIds: string[] = []
      for (const [index, cell] of cells.entries()) {
        await phase(`target-133-p-${index}`, at(cell) + osc("133;P"))
        const target = await registered()
        if (typeof target === "string") return blind(target)
        targets.push(target.projection)
        targetIds.push(...target.ids)
      }
      detail.targets = targets
      const after = await history()
      let preserved: string
      if (typeof before === "string" || typeof after === "string") {
        preserved = "not observed"
        detail.history = `not observed: ${typeof before === "string" ? before : String(after)}`
      } else {
        const kept = [...before].every(([id, value]) => after.get(id) === value)
        const added = [...after.keys()].filter((id) => !before.has(id))
        preserved = kept && JSON.stringify(added) === JSON.stringify(targetIds) ? "unchanged" : "changed"
        detail.history = { before: before.size, after: after.size, added: added.length, preserved }
      }
      // Supported needs a new mark at each exact target cell. A line mark matching its A control's line cannot
      // show the column, so any P movement stays a TODO (@cto osc133p-r2 clarification); only a P that added
      // nothing is graded.
      if (targets.some((target) => target.mark !== "same")) {
        return {
          status: "unavailable",
          reason: `iTerm2 OSC 133 P targets read ${JSON.stringify(targets)} (history ${preserved}); a line mark cannot show the target column Supported needs`,
          detail,
        }
      }
      const unmoved = { marks: cells.map(() => start), history: "unchanged" }
      return {
        status: "measured",
        reader: "state",
        runId: input.runId,
        unknown: { before: JSON.stringify(start), after: JSON.stringify(unknown.projection) },
        handled: {
          before: JSON.stringify(cells.map(() => start)),
          after: JSON.stringify(controls.map(({ mark }) => ({ mark }))),
          expected: JSON.stringify(cells.map(() => ({ mark: "new" }))),
        },
        target: {
          before: JSON.stringify(unmoved),
          after: JSON.stringify({ marks: targets, history: preserved }),
          expected: JSON.stringify({
            marks: controls.map(({ line }) => ({ mark: "new", line })),
            history: "unchanged",
          }),
        },
        detail,
      }
    }

    async function measureDirectory(): Promise<AppSemanticReading> {
      // features.json osc633-p: an exact path comparison, no trailing-slash or symlink normalisation.
      // iTerm2 3.6.11 reports the directory recorded at the prompt line, so every control, target and the
      // unknown is followed by a fresh prompt line, identically.
      const directory = (read: ITermPromptRead) =>
        read.status === "mark" && read.mark.workingDirectory !== undefined ? read.mark.workingDirectory : null
      const atPrompt = (sequence: string) => sequence + "\r\n" + osc("133;A") + ITERM_PROMPT_TEXT
      const first = await phase("baseline", clear + finished)
      if (first.read.status === "prompt-unavailable") return unavailableBaseline
      const initial = directory(first.read)
      if (initial === null) {
        return {
          status: "unavailable",
          reason: "iTerm2 GetPrompt reported no working directory before the controls, so there is none to restore",
          detail,
        }
      }
      initialDirectory = initial
      directoryMoved = true
      const unknown = directory((await phase("unknown", atPrompt(osc("633;Z")))).read)
      const sentControls = [`/terminfo-osc7-control-A-${nonce}`, `/terminfo-osc7-control-B-${nonce}`]
      const controls: (string | null)[] = []
      for (const [index, path] of sentControls.entries()) {
        controls.push(
          directory((await phase(`control-osc7-${index}`, atPrompt(osc(`7;file://localhost${path}`)))).read),
        )
      }
      const publicPath = (value: string | null) => (value === null ? null : (shown(value) as string))
      if (controls.every((value) => value === initial)) {
        return {
          status: "unavailable",
          reason: "iTerm2 GetPrompt working directory is inert to two distinct OSC 7 controls",
          detail,
        }
      }
      const sentTargets = [`/terminfo-633-cwd-A-${nonce}`, `/terminfo-633-cwd-B-${nonce}`]
      const priors: (string | null)[] = []
      const targets: (string | null)[] = []
      let prior = controls.at(-1) ?? null
      for (const [index, path] of sentTargets.entries()) {
        priors.push(prior)
        prior = directory((await phase(`target-633-p-${index}`, atPrompt(osc(`633;P;Cwd=${path}`)))).read)
        targets.push(prior)
      }
      return {
        status: "measured",
        reader: "state",
        runId: input.runId,
        unknown: { before: String(publicPath(initial)), after: String(publicPath(unknown)) },
        handled: {
          before: JSON.stringify([publicPath(initial), publicPath(controls[0] ?? null)]),
          after: JSON.stringify(controls.map(publicPath)),
          expected: JSON.stringify(sentControls),
        },
        target: {
          before: JSON.stringify(priors.map(publicPath)),
          after: JSON.stringify(targets.map(publicPath)),
          expected: JSON.stringify(sentTargets),
        },
        detail,
      }
    }
  })
}

/** A row's experiment never started from its assumed state: reported as invalid, never graded. */
class BaselineMiss extends Error {}

/**
 * One controlled WezTerm CWD observation for the existing platform owners. The capabilities must bracket each
 * command with their live owner check. `write` is the owner's private TTY writer: restoration must not put the
 * initial host URI into the probe source's publishable write trace (CTO6a2de139).
 */
export async function readWezTermCwd(input: {
  runId: string
  captureDirectory: string
  onRetained: Parameters<typeof retainCaptureArtifact>[3]
  write: (text: string) => void | Promise<void>
  readPane: () => Promise<string>
  readText: () => Promise<string>
}): Promise<AppSemanticReading> {
  const nonce = randomUUID().slice(0, 8)
  const phases: object[] = []
  const privateRecord: { initial?: string; restored?: string; phases: object[] } = { phases }
  const detail: {
    privateEvidence?: string
    initialProtocolPresence: string
    initialSha256?: string
    restoredSha256?: string
    restoredEqual?: boolean
  } = { initialProtocolPresence: "unreported" }
  const retain = () => {
    try {
      retainCaptureArtifact(input.captureDirectory, Buffer.from(JSON.stringify(privateRecord)), "json", (artifact) => {
        detail.privateEvidence = basename(artifact.path)
        input.onRetained(artifact)
      })
    } catch (error) {
      throw new Error("WezTerm OSC7 private evidence retention failed", { cause: error })
    }
  }
  const digest = (value: string) => createHash("sha256").update(value).digest("hex")
  const control = `file:///terminfo-control-${nonce}`
  const target = `file:///terminfo-target-${nonce}`
  let initial: string | undefined
  let mutated = false
  let privateReady = false
  let serial = 0
  let phase = "setup"
  const sample = async (name: string, uri: string, command: "7" | "77") => {
    phase = name
    const marker = `Q-${nonce}-${serial++}`
    const feed = `\x1b[1;1H\x1b[2K\x1b]${command};${uri}\x07${marker}`
    phases.push({ name, feed, marker })
    await input.write(feed)
    const text = await untilAppSemanticRead(input.readText, (value) => value.includes(marker), `${name} marker`, phases)
    phases.push({ name, text })
  }
  try {
    if (!/^[0-9a-f]{32}$/.test(input.runId) || !isAbsolute(input.captureDirectory)) {
      throw new Error("WezTerm OSC7 has no owned run/private capture directory")
    }
    privateReady = true
    retain()
    for (const path of [`/terminfo-control-${nonce}`, `/terminfo-target-${nonce}`]) {
      try {
        statSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      throw new Error("WezTerm OSC7 control paths are not fresh nonexistent paths")
    }
    phase = "initial owned directory"
    initial = await input.readPane()
    privateRecord.initial = initial
    if (
      !initial.startsWith("file://") ||
      /[\x00-\x1f\x7f]/.test(initial) ||
      initial === control ||
      initial === target
    ) {
      throw new Error("WezTerm OSC7 initial public URI cannot be safely restored")
    }
    retain()
    detail.initialSha256 = digest(initial)
    mutated = true
    await sample("inert control", target, "77")
    const unknown = await input.readPane()
    phases.push({ name: phase, cwd: unknown })
    if (unknown !== initial) throw new Error("WezTerm OSC77 changed the public directory")
    await sample("handled control", control, "7")
    await untilAppSemanticRead(input.readPane, (value) => value === control, "OSC7 handled control", phases)
    await sample("target", target, "7")
    await untilAppSemanticRead(input.readPane, (value) => value === target, "OSC7 target", phases)
    return {
      status: "measured",
      reader: "state",
      runId: input.runId,
      unknown: { before: digest(initial), after: digest(unknown) },
      handled: { before: digest(initial), after: control, expected: control },
      target: { before: control, after: target, expected: target },
      detail,
    }
  } catch (error) {
    phases.push({ name: phase, error: error instanceof Error ? error.message : String(error) })
    return {
      status: "invalid",
      reason: `WezTerm OSC7 ${phase}: read method unavailable here`,
      detail,
    }
  } finally {
    if (mutated && initial !== undefined) {
      try {
        await sample("restoration", initial, "7")
        privateRecord.restored = await untilAppSemanticRead(
          input.readPane,
          (value) => value === initial,
          "OSC7 public directory restoration",
          phases,
        )
        detail.restoredSha256 = digest(privateRecord.restored)
        detail.restoredEqual = privateRecord.restored === initial
      } catch (error) {
        phases.push({ name: "restoration", error: error instanceof Error ? error.message : String(error) })
        try {
          retain()
        } catch (retentionError) {
          throw new AggregateError(
            [error, retentionError],
            "WezTerm OSC7 restoration failed: the pane's reported directory was left changed; private evidence retention also failed",
          )
        }
        throw new Error("WezTerm OSC7 restoration failed: the pane's reported directory was left changed")
      }
    }
    if (privateReady) retain()
  }
}

type NativeEditorSource = {
  appId: "com.microsoft.VSCode" | "cursor"
  assertProcess: (pid: number, collectorAncestor?: boolean) => void | Promise<void>
  capture: (featureId: string, phase: string) => Promise<unknown>
}

type NativeEditorActivation = {
  runId: string
  activationNonce: string
  extensionPid: number
  activatedAt: number
  app: { name: string; version: string }
  requestPath: string
  replyDirectory: string
}

type NativeEditorReply = Pick<NativeEditorActivation, "runId" | "activationNonce" | "extensionPid" | "app"> & {
  featureId: string
  phase: string
  nonce: string
  requestedAt: number
  deadline: number
  evaluatedAt: number
  sequence: number
  delivery: string
  status: string
  terminal: {
    name: string
    processId: { present: boolean; value?: number; reason?: string }
    shellIntegrationCwd: { present: boolean; value?: string; reason?: string }
  }
  executionApi?: Partial<Record<"start" | "end", { present: boolean; reason?: string }>>
  executions?: NativeExecutionFact[]
  awaitedEvent?: { kind: string; met: boolean }
}

/** One native execution event as the 34666 observer publishes it: digests only, never command text. */
type NativeExecutionFact = {
  eventSequence: number
  kind: "start" | "end"
  execution: string
  commandLine?: {
    present: boolean
    valueSha256?: string
    confidence?: { present: boolean; value?: number; reason?: string }
    isTrusted?: { present: boolean; value?: boolean; reason?: string }
    reason?: string
  }
  exitCode?: { present: boolean; value?: number; reason?: string }
}

/**
 * Native editor rows qualified from execution events that the collector's own written marks cause (34685, @cto
 * 34685-execution-scope-ruling-1435). C and D use the opposite selector as the handled control; 633 E uses a known
 * E payload, since OSC 133 has no E. Every other editor row keeps its refusal.
 *
 * A, B and P (34861, @cto 34861-editor-criterion-r2): the execution API shows command-line confidence and whether an
 * execution started, never a mark's position or earlier history, so these rows decide only a qualified negative and
 * a qualified positive stays PROBE TODO. B, C and D (A and C and D for B rows) stay in the control family. The
 * composites semantic-prompts and osc-633-vscode name no positions, so they may read Supported; they add no negative.
 */
const NATIVE_EXECUTION_ROWS: Record<
  string,
  { mark: "a" | "b" | "p" | "c" | "d" | "e" | "semantic" | "vscode"; selector: "133" | "633"; control: "133" | "633" }
> = {
  "extensions.osc633-c": { mark: "c", selector: "633", control: "133" },
  "extensions.osc133-c": { mark: "c", selector: "133", control: "633" },
  "extensions.osc633-d": { mark: "d", selector: "633", control: "133" },
  "extensions.osc133-d": { mark: "d", selector: "133", control: "633" },
  "extensions.osc633-e": { mark: "e", selector: "633", control: "633" },
  "extensions.osc133-a": { mark: "a", selector: "133", control: "633" },
  "extensions.osc633-a": { mark: "a", selector: "633", control: "133" },
  "extensions.osc133-b": { mark: "b", selector: "133", control: "633" },
  "extensions.osc633-b": { mark: "b", selector: "633", control: "133" },
  "extensions.osc133-p": { mark: "p", selector: "133", control: "633" },
  "extensions.semantic-prompts": { mark: "semantic", selector: "133", control: "133" },
  "extensions.osc-633-vscode": { mark: "vscode", selector: "633", control: "633" },
}

/** The API's TerminalShellExecutionCommandLineConfidence: Low = 0, Medium = 1, High = 2 (vscode.d.ts 1.142.0). */
const COMMAND_LINE_CONFIDENCE = ["low", "medium", "high"] as const

/** Public diagnostic for a native editor reading, which the committed run record keeps verbatim (34666). */
type NativeFailure = { diagnostic: string; privateEvidence?: string; sha256?: string; bytes?: number }

/** A native editor reason reaches the committed record: name the private directories instead of printing them. */
function redactNativeEditorPaths(text: string) {
  let redacted = text
  for (const [name, label] of [
    ["TERMINFO_EDITOR_RUN_DIRECTORY", "<private editor run directory>"],
    ["TERMINFO_CAPTURE_DIRECTORY", "<owned capture directory>"],
  ] as const) {
    const path = process.env[name]
    if (path) redacted = redacted.split(path).join(label)
  }
  return redacted
}

/** One native exchange owner shared by semantic observations and the exact Terminal's title. */
async function createNativeEditorExchange(input: {
  featureId: string
  runId: string
  editor: Pick<NativeEditorSource, "assertProcess">
}) {
  if (
    process.env.TERMINFO_RUN_ID !== input.runId ||
    !/^[0-9a-f]{32}$/.test(input.runId) ||
    process.env.TERMINFO_MUX_KIND
  ) {
    throw new Error("Native editor read has no matching unmultiplexed launch run")
  }
  const detail: {
    identity?: object
    /** A digest of each native reply: the committed record never carries its bytes (terminal name, paths, PID,
     * command lines). The bytes stay in the private retained artifact this entry names (34666, @chief 01ff2c88). */
    nativeObservations: Array<{ phase: string; artifact: string; sha256: string; bytes: number }>
    captures: Array<{ phase: string; observation: unknown }>
    restoration?: object
    nativeFailure?: NativeFailure
    executionTrials?: Array<{ phase: string; selector: string; state: string; commandLine?: object }>
    /** A qualified positive that the row cannot grade keeps its measured control and target states (34861). */
    executionStates?: object
  } = { nativeObservations: [], captures: [] }
  const captureDirectory = process.env.TERMINFO_CAPTURE_DIRECTORY
  if (!captureDirectory || !isAbsolute(captureDirectory)) {
    throw new Error("Native editor read has no owned capture directory")
  }
  // The owned Darwin receipt selected this App; the Linux launcher's environment is not a second authority.
  const directory = process.env.TERMINFO_EDITOR_RUN_DIRECTORY
  if (!directory || !isAbsolute(directory)) throw new Error("Native editor read has no private launch directory")
  const activationPath = join(directory, "editor-activation.json")
  const activationIdentity = statSync(activationPath)
  const activationRaw = readFileSync(activationPath, "utf8")
  const activation = JSON.parse(activationRaw) as NativeEditorActivation
  if (
    activation.runId !== input.runId ||
    typeof activation.activationNonce !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(activation.activationNonce) ||
    !Number.isInteger(activation.extensionPid) ||
    activation.extensionPid <= 0 ||
    !Number.isFinite(activation.activatedAt) ||
    typeof activation.app?.name !== "string" ||
    !activation.app.name ||
    typeof activation.app.version !== "string" ||
    !activation.app.version ||
    activation.requestPath !== join(directory, "editor-request.json") ||
    !isAbsolute(activation.replyDirectory) ||
    dirname(activation.replyDirectory) !== directory
  ) {
    throw new Error("Native editor activation has invalid run/process/App/path binding")
  }
  await input.editor.assertProcess(activation.extensionPid)
  const activationArtifact = join(captureDirectory, "editor-activation-retained.json")
  writeFileSync(activationArtifact, activationRaw)
  // Bounded public identity: the process id and launch paths stay in the private retained artifact (34666).
  detail.identity = {
    runId: activation.runId,
    activationNonce: activation.activationNonce,
    app: { name: activation.app.name, version: activation.app.version },
    activatedAt: activation.activatedAt,
    privateEvidence: basename(activationArtifact),
    sha256: createHash("sha256").update(activationRaw).digest("hex"),
    evidenceLimit: "Same-user files prove correlation with this activation, not which process wrote them",
  }
  let lastSequence = 0
  const availability: { reason?: string } = {}
  const exchange = async (
    phase: string,
    options: { expectedCwd?: string; awaitEvent?: "start" | "end"; deadlineMs?: number } = {},
  ): Promise<NativeEditorReply> => {
    const { expectedCwd, awaitEvent } = options
    const current = statSync(activationPath)
    if (
      current.dev !== activationIdentity.dev ||
      current.ino !== activationIdentity.ino ||
      readFileSync(activationPath, "utf8") !== activationRaw
    ) {
      throw new Error("Native editor activation changed during the row")
    }
    const nonce = randomUUID()
    const replyPath = join(activation.replyDirectory, `${nonce}.json`)
    try {
      statSync(replyPath)
      throw new Error("Native editor reply was present before its request")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const reader = openAppCommandLog(captureDirectory, replyPath)
    const offset = reader.mark()
    if (offset !== 0) throw new Error("Native editor reply contains data before its request")
    const requestedAt = Date.now()
    if (activation.activatedAt > requestedAt) throw new Error("Native editor activation does not predate its request")
    const request = {
      runId: input.runId,
      featureId: input.featureId,
      phase,
      nonce,
      activationNonce: activation.activationNonce,
      requestedAt,
      deadline: requestedAt + (options.deadlineMs ?? 4500),
      ...(expectedCwd === undefined ? {} : { expectedCwd }),
      ...(awaitEvent === undefined ? {} : { awaitEvent }),
    }
    const temporary = `${activation.requestPath}.${nonce}.tmp`
    writeFileSync(temporary, JSON.stringify(request), { flag: "wx", mode: 0o600 })
    renameSync(temporary, activation.requestPath)
    // The extension publishes a complete file atomically. Retain even malformed bytes before
    // interpreting them, so a failed read is reviewable rather than disappearing at JSON.parse.
    const retained = await reader.read(0, `editor-${input.featureId}-${phase}-${nonce}.json`, (text) =>
      text.length === 0 ? undefined : text.length,
    )
    detail.nativeObservations.push({
      phase,
      artifact: basename(retained.path),
      sha256: createHash("sha256").update(retained.text).digest("hex"),
      bytes: Buffer.byteLength(retained.text),
    })
    if (!retained.complete) {
      try {
        // The extension's error record names private paths: retain its exact bytes privately, publish a digest.
        const bytes = readFileSync(join(directory, "editor-reader-errors.jsonl"))
        const privateEvidence = `editor-reader-errors-${phase}.jsonl`
        writeFileSync(join(captureDirectory, privateEvidence), bytes)
        detail.nativeFailure = {
          diagnostic: "Native reader error record retained privately",
          privateEvidence,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        detail.nativeFailure = { diagnostic: "No native reader error record was created before the reply deadline" }
      }
      availability.reason = "Native editor reply deadline expired; no fresh API observation"
      throw new Error(availability.reason)
    }
    const reply = JSON.parse(retained.text) as NativeEditorReply
    if (
      reply.runId !== input.runId ||
      reply.featureId !== input.featureId ||
      reply.phase !== phase ||
      reply.nonce !== nonce ||
      reply.activationNonce !== activation.activationNonce ||
      reply.extensionPid !== activation.extensionPid ||
      reply.requestedAt !== requestedAt ||
      reply.deadline !== request.deadline ||
      reply.app?.name !== activation.app.name ||
      reply.app.version !== activation.app.version ||
      reply.status !== "observed" ||
      !Number.isInteger(reply.sequence) ||
      reply.sequence <= lastSequence ||
      !Number.isFinite(reply.evaluatedAt) ||
      reply.evaluatedAt < requestedAt ||
      reply.evaluatedAt > request.deadline ||
      !["interval", "watcher", "startup", "shell-integration"].includes(reply.delivery) ||
      typeof reply.terminal?.name !== "string" ||
      (input.featureId !== "collector.owned-editor-title" && reply.terminal.name === "")
    ) {
      throw new Error("Native editor reply has stale or mismatched activation/request/process binding")
    }
    const nativePid = reply.terminal.processId
    if (
      nativePid?.present === false &&
      typeof nativePid.reason === "string" &&
      nativePid.reason !== "" &&
      !("value" in nativePid)
    ) {
      availability.reason = `Native editor terminal.processId is unavailable: ${nativePid.reason}`
      throw new Error(availability.reason)
    }
    if (
      nativePid?.present !== true ||
      typeof nativePid.value !== "number" ||
      !Number.isSafeInteger(nativePid.value) ||
      nativePid.value <= 0
    ) {
      throw new Error("Native editor reply has an invalid terminal process PID")
    }
    await input.editor.assertProcess(reply.extensionPid)
    await input.editor.assertProcess(nativePid.value, true)
    lastSequence = reply.sequence
    const cwd = reply.terminal.shellIntegrationCwd
    if (
      typeof cwd?.present !== "boolean" ||
      (cwd.present && typeof cwd.value !== "string") ||
      (!cwd.present && (typeof cwd.reason !== "string" || "value" in cwd))
    ) {
      throw new Error("Native editor reply does not distinguish a CWD value from native API absence")
    }
    return reply
  }
  return { exchange, detail, availability }
}

/** Private owner wiring: replies come from its held Terminal, never the requested title or activeTerminal. */
export function createNativeEditorTitleReader(input: {
  runId: string
  assertProcess: NativeEditorSource["assertProcess"]
}): NonNullable<TermProbeSource["readTitle"]> {
  let source: ReturnType<typeof createNativeEditorExchange> | undefined
  return async () => {
    source ??= createNativeEditorExchange({
      featureId: "collector.owned-editor-title",
      runId: input.runId,
      editor: { assertProcess: input.assertProcess },
    })
    const { exchange } = await source
    return (await exchange("title")).terminal.name
  }
}

/** Native API replies from the single Terminal object held by this run's generated extension. */
async function readNativeEditorState(input: {
  featureId: string
  runId: string
  write: (text: string) => void
  editor: NativeEditorSource
}): Promise<AppSemanticReading> {
  const { exchange, detail, availability } = await createNativeEditorExchange(input)
  const sample = async (phase: string, expectedCwd?: string): Promise<string | undefined> => {
    const cwd = (await exchange(phase, { expectedCwd })).terminal.shellIntegrationCwd
    if (expectedCwd !== undefined && (!cwd.present || cwd.value !== expectedCwd)) {
      availability.reason =
        "Native editor did not observe the expected CWD; unchanged or absent state does not decide support"
      throw new Error(availability.reason)
    }
    return cwd.present ? cwd.value : undefined
  }
  const osc = (value: string) => `\x1b]${value}\x07`
  // 34685: staged native execution trials. Each trial is read after A/B, after C (before D), then after D, and
  // joined by execution identity; extra, stale, unpaired or other-execution facts make the row invalid, never a
  // grade. Reads whose emptiness could decide Unsupported wait the full deadline; reads expected empty use a short
  // one, since a late event then shows up as an extra fact in a later window and invalidates the row.
  async function readNativeExecutionRow(row: (typeof NATIVE_EXECUTION_ROWS)[string]): Promise<AppSemanticReading> {
    let lastEventSequence = 0
    let executionCaptured = false
    let executionReading: AppSemanticReading | undefined
    const trials: NonNullable<typeof detail.executionTrials> = []
    detail.executionTrials = trials
    const facts = (reply: NativeEditorReply) => {
      for (const kind of ["start", "end"] as const) {
        const api = reply.executionApi?.[kind]
        if (api?.present === false && typeof api.reason === "string" && api.reason !== "") {
          availability.reason = `Native editor execution event API is unavailable: ${api.reason}`
          throw new Error(availability.reason)
        }
        if (api?.present !== true) throw new Error("Native editor reply has no execution event API record")
      }
      if (!Array.isArray(reply.executions)) throw new Error("Native editor reply has no execution window")
      for (const fact of reply.executions) {
        if (
          !Number.isSafeInteger(fact.eventSequence) ||
          fact.eventSequence <= lastEventSequence ||
          (fact.kind !== "start" && fact.kind !== "end") ||
          typeof fact.execution !== "string"
        ) {
          throw new Error("Native editor execution facts are stale, out of order or malformed")
        }
        lastEventSequence = fact.eventSequence
      }
      return reply.executions
    }
    const read = async (phase: string, awaitEvent: "start" | "end", full: boolean) => {
      const reply = await exchange(phase, { awaitEvent, ...(full ? {} : { deadlineMs: 1500 }) })
      if (reply.awaitedEvent?.kind !== awaitEvent || typeof reply.awaitedEvent.met !== "boolean") {
        throw new Error("Native editor reply did not honour the awaited execution event")
      }
      const window = facts(reply)
      if (reply.awaitedEvent.met !== window.some((fact) => fact.kind === awaitEvent)) {
        throw new Error("Native editor execution window contradicts its awaited-event record")
      }
      return window
    }
    // One trial in three writes, each read apart: setup (A/B), the C stage, then D. `complete` waits the full
    // deadline after D even with no start, so an empty window is a complete observation (34861: with no B, VS Code
    // fires no event at all). `synthesized` admits the start-and-end pair D creates when C never arrived
    // (commandDetectionCapability.ts:390-397); only the C-stage window counts as this trial's start.
    const staged = async (
      phase: string,
      bytes: { ab: string; c: string; d: string },
      options: { full: boolean; complete?: boolean; synthesized?: boolean; ended?: boolean },
    ) => {
      input.write(bytes.ab)
      if ((await read(`${phase}-ab`, "start", false)).length !== 0) {
        throw new Error(`Native editor execution event arrived before C in ${phase}; the trial cannot be attributed`)
      }
      input.write(bytes.c)
      const afterC = await read(`${phase}-c`, "start", options.full)
      if (afterC.length > 1 || afterC.some((fact) => fact.kind !== "start")) {
        throw new Error(`Native editor execution window after C in ${phase} holds extra or unpaired facts`)
      }
      const start = afterC[0]
      input.write(bytes.d)
      const afterD = await read(`${phase}-d`, "end", options.complete === true || (options.full && start !== undefined))
      const [first, second] = afterD
      if (
        options.synthesized === true &&
        start === undefined &&
        afterD.length === 2 &&
        first?.kind === "start" &&
        second?.kind === "end" &&
        second.execution === first.execution
      ) {
        return { start, end: second, synthesized: first }
      }
      if (afterD.length > 1 || afterD.some((fact) => fact.kind !== "end")) {
        throw new Error(`Native editor execution window after D in ${phase} holds extra or unpaired facts`)
      }
      const end = afterD[0]
      if (end !== undefined && start === undefined) {
        // An end with no start in this trial cannot be attributed to these bytes (@cto 1435 amendment 1).
        throw new Error(`Native editor execution end in ${phase} has no start in this trial; the event is unpaired`)
      }
      if (start !== undefined && end !== undefined && end.execution !== start.execution) {
        throw new Error(`Native editor execution end in ${phase} belongs to another execution`)
      }
      if (options.ended === true && start !== undefined && end === undefined) {
        // A started trial that never ends would leave its command state for the next one (@cto ruling 2, fix 3).
        throw new Error(`Native editor execution in ${phase} did not end at D; the next trial would not start clean`)
      }
      return { start, end }
    }
    const trial = (
      phase: string,
      selector: string,
      options: { code?: number; command?: string; commandSelector?: string; nonce?: string; full: boolean },
    ) => {
      const suffix = options.nonce === undefined || options.nonce === "" ? "" : `;${options.nonce}`
      const command =
        options.command === undefined ? "" : osc(`${options.commandSelector ?? selector};E;${options.command}${suffix}`)
      return staged(
        phase,
        {
          ab: osc(`${selector};A`) + osc(`${selector};B`),
          c: command + osc(`${selector};C`),
          d: osc(`${selector};D;${options.code ?? 0}`),
        },
        { full: options.full },
      )
    }
    // A prompt and a one-line command, so B sits past column 0 and VS Code can read Medium; the marks given are
    // written in place, an omitted mark is simply absent, and every started trial must end at D (34861).
    const prompted = (
      phase: string,
      marks: { a?: string; b?: string; e?: string; c?: string; d: string },
      options: { complete?: boolean; synthesized?: boolean } = {},
    ) =>
      staged(
        phase,
        {
          ab: (marks.a === undefined ? "" : osc(marks.a)) + "$ " + (marks.b === undefined ? "" : osc(marks.b)) + "true",
          c: (marks.e === undefined ? "" : osc(marks.e)) + (marks.c === undefined ? "" : osc(marks.c)) + "\r\nok",
          d: osc(marks.d) + "\r\n",
        },
        { full: true, ended: true, ...options },
      )
    type Trial = Awaited<ReturnType<typeof trial>>
    const started = (result: Trial) => (result.start === undefined ? "none" : "start")
    const ended = (result: Trial) =>
      result.end === undefined
        ? "none"
        : result.end.exitCode?.present === true
          ? `end:${result.end.exitCode.value}`
          : "end:absent"
    const digest = (text: string) => createHash("sha256").update(text).digest("hex")
    const commanded = (result: Trial, command: string) =>
      result.start?.commandLine?.present === true && result.start.commandLine.valueSha256 === digest(command)
        ? "cmd:match"
        : "cmd:absent"
    const confidence = (result: Trial) => {
      if (result.start === undefined) return "none"
      const value = result.start.commandLine?.confidence
      if (value?.present !== true || typeof value.value !== "number") return "confidence:absent"
      return COMMAND_LINE_CONFIDENCE[value.value] ?? `confidence:${value.value}`
    }
    const record = (phase: string, selector: string, state: string, result: Trial) => {
      const line = result.start?.commandLine
      trials.push({
        phase,
        selector,
        state,
        ...((row.mark === "e" || row.mark === "vscode") && line !== undefined
          ? {
              commandLine: {
                present: line.present,
                ...(line.reason === undefined ? {} : { reason: line.reason }),
                confidence: line.confidence,
                isTrusted: line.isTrusted,
              },
            }
          : {}),
      })
      return state
    }
    // E is honoured only with the editor's own nonce: CommandDetectionCapability.setCommandLine then sets the
    // PromptInputModel, which UnixPtyHeuristics.handleCommandExecuted copies into the command at C (34894).
    const rawNonce = process.env.VSCODE_NONCE
    const nonce = typeof rawNonce === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(rawNonce) ? rawNonce : undefined
    try {
      facts(await exchange("initial"))
      let unknown: { before: string; after: string }
      let handled: { before: string; after: string; expected: string }
      let target: { before: string; after: string; expected: string }
      // A qualified positive on an A, B or P row: the API shows no position or history (@cto 34861 ruling 2).
      let positive = false
      if (row.mark === "a" || row.mark === "p") {
        // VS Code reads Medium only with a prompt start, a command start past column 0 and a one-line command
        // (commandDetectionCapability.ts:93-123), so A moves the start event's confidence from Low to Medium.
        // Two fresh positives bracket the target and the omission runs last; it is the separate Low negative.
        const promptTrial = async (phase: string, mark: string | undefined) => {
          const marks = { b: `${row.control};B`, c: `${row.control};C`, d: `${row.control};D;0` }
          const result = await prompted(phase, mark === undefined ? marks : { a: mark, ...marks })
          return record(phase, mark ?? "none", confidence(result), result)
        }
        const [early, late] = row.mark === "a" ? [`${row.control};A`, `${row.control};A`] : ["133;A", "633;A"]
        const before = await promptTrial("handled-before", early)
        const result = await promptTrial("target", row.mark === "a" ? `${row.selector};A` : "133;P")
        const after = await promptTrial("handled-after", late)
        const omitted = await promptTrial("omitted", undefined)
        // `unknown` carries the omission control here: without A the start must read Low.
        unknown = { before: "low", after: omitted }
        handled = { before: "low|low", after: `${before}|${after}`, expected: "medium|medium" }
        // No reading equals this expected state, so the grader can only return Unsupported (Low) or PROBE TODO.
        target = { before: "low", after: result, expected: "medium-at-known-positions" }
        positive = result === "medium"
      } else if (row.mark === "b") {
        // With no command start VS Code fires no execution event at all (UnixPtyHeuristics.handleCommandExecuted,
        // commandDetectionCapability.ts:574-589), so B decides whether one execution starts. Each window is read
        // to its full deadline, so an empty trial is a complete observation, never an invented end.
        const commandTrial = async (phase: string, mark: string | undefined) => {
          const marks = { a: `${row.control};A`, c: `${row.control};C`, d: `${row.control};D;0` }
          const result = await prompted(phase, mark === undefined ? marks : { ...marks, b: mark }, { complete: true })
          return record(phase, mark ?? "none", started(result), result)
        }
        const before = await commandTrial("handled-before", `${row.control};B`)
        const result = await commandTrial("target", `${row.selector};B`)
        const after = await commandTrial("handled-after", `${row.control};B`)
        const omitted = await commandTrial("omitted", undefined)
        unknown = { before: "none", after: omitted }
        handled = { before: "none|none", after: `${before}|${after}`, expected: "start|start" }
        target = { before: "none", after: result, expected: "start-at-known-positions" }
        positive = result === "start"
      } else if (row.mark === "semantic") {
        // Prompt start (Medium against the no-A Low control), output start (a start in the C-stage window and
        // none before) and command end at both exit codes. Without C, and with an unknown letter in its place,
        // the C stage must start nothing; D may then synthesize the start, which does not count.
        const marks = { a: "133;A", b: "133;B", c: "133;C" }
        const full = (result: Trial) => `${confidence(result)}:${ended(result)}`
        const zero = await prompted("target-0", { ...marks, d: "133;D;0" })
        const one = await prompted("target-1", { ...marks, d: "133;D;1" })
        const noPrompt = await prompted("handled", { b: "133;B", c: "133;C", d: "133;D;0" })
        const noOutput = await prompted("unknown-no-c", { a: "133;A", b: "133;B", d: "133;D;0" }, { synthesized: true })
        const letter = await prompted("unknown-letter", { ...marks, c: "133;Y", d: "133;D;0" }, { synthesized: true })
        unknown = {
          before: "none|none",
          after: `${record("unknown-no-c", "133", started(noOutput), noOutput)}|${record("unknown-letter", "133", started(letter), letter)}`,
        }
        handled = { before: "none", after: record("handled", "133", confidence(noPrompt), noPrompt), expected: "low" }
        // The row adds no negative branch (ruling 2): `before` is a state no reading takes, so the grader can
        // return Supported or PROBE TODO, never Unsupported.
        target = {
          before: "none",
          after: `${record("target-0", "133", full(zero), zero)}|${record("target-1", "133", full(one), one)}`,
          expected: "medium:end:0|medium:end:1",
        }
      } else if (row.mark === "vscode") {
        // VS Code-specific metadata: E makes the command line High and, with the nonce, its value. Two distinct
        // payloads over the same buffer text, and the same setup without E read first, below High.
        const marks = { a: "633;A", b: "633;B", c: "633;C", d: "633;D;0" }
        const suffix = nonce === undefined ? "" : `;${nonce}`
        const omitted = await prompted("unknown-no-e", marks)
        const omittedState = confidence(omitted)
        const known = `terminfo-control-${randomUUID()}`
        const first = await prompted("handled", { ...marks, e: `633;E;${known}${suffix}` })
        const chosen = `terminfo-target-${randomUUID()}`
        const second = await prompted("target", { ...marks, e: `633;E;${chosen}${suffix}` })
        const below = omittedState === "low" || omittedState === "medium" ? "below-high" : omittedState
        unknown = { before: "below-high", after: record("unknown-no-e", "633", below, omitted) }
        handled = {
          before: "cmd:absent",
          after: record("handled", "633", `${confidence(first)}:${commanded(first, known)}`, first),
          expected: "high:cmd:match",
        }
        target = {
          before: "cmd:absent",
          after: record("target", "633", `${confidence(second)}:${commanded(second, chosen)}`, second),
          expected: "high:cmd:match",
        }
      } else if (row.mark === "c") {
        const control = await trial("unknown", "9999", { full: false })
        unknown = { before: "none", after: record("unknown", "9999", started(control), control) }
        const known = await trial("handled", row.control, { full: true })
        handled = { before: "none", after: record("handled", row.control, started(known), known), expected: "start" }
        const result = await trial("target", row.selector, { full: true })
        target = { before: "none", after: record("target", row.selector, started(result), result), expected: "start" }
      } else if (row.mark === "d") {
        const control = await trial("unknown", "9999", { code: 0, full: false })
        unknown = { before: "none", after: record("unknown", "9999", ended(control), control) }
        const pair = async (phase: string, selector: string) => {
          const states = []
          for (const code of [0, 17]) {
            const result = await trial(`${phase}-${code}`, selector, { code, full: true })
            states.push(record(`${phase}-${code}`, selector, ended(result), result))
          }
          return states.join("|")
        }
        handled = { before: "none|none", after: await pair("handled", row.control), expected: "end:0|end:17" }
        target = { before: "none|none", after: await pair("target", row.selector), expected: "end:0|end:17" }
      } else {
        // An E under an unknown selector must not set the command line; known and target payloads differ.
        // VS Code 1.142.0 and Cursor 3.25.9 CommandDetectionCapability.setCommandLine updates PromptInputModel only
        // when the E sequence's nonce matches VSCODE_NONCE, and UnixPtyHeuristics.handleCommandExecuted overwrites
        // currentCommand.command from PromptInputModel at 633;C (34894, run 44267909484).
        const unknownCommand = `terminfo-unknown-${randomUUID()}`
        const control = await trial("unknown", "633", {
          command: unknownCommand,
          commandSelector: "9999",
          nonce,
          full: true,
        })
        unknown = { before: "cmd:absent", after: record("unknown", "633", commanded(control, unknownCommand), control) }
        const knownCommand = `terminfo-control-${randomUUID()}`
        const known = await trial("handled", "633", { command: knownCommand, nonce, full: true })
        handled = {
          before: "cmd:absent",
          after: record("handled", "633", commanded(known, knownCommand), known),
          expected: "cmd:match",
        }
        const targetCommand = `terminfo-target-${randomUUID()}`
        const result = await trial("target", "633", { command: targetCommand, nonce, full: true })
        target = {
          before: "cmd:absent",
          after: record("target", "633", commanded(result, targetCommand), result),
          expected: "cmd:match",
        }
      }
      detail.captures.push({ phase: "target", observation: await input.editor.capture(input.featureId, "target") })
      executionCaptured = true
      const qualified =
        unknown.before === unknown.after && handled.before !== handled.expected && handled.after === handled.expected
      if (positive && qualified) {
        detail.executionStates = { unknown, handled, target }
        availability.reason =
          row.mark === "b"
            ? "Native editor started one execution after the target B with qualified controls; the execution API shows neither the mark's exact position nor earlier history, so the positive branch stays PROBE TODO"
            : "Native editor read Medium command-line confidence after the target with qualified controls; the execution API shows neither exact prompt positions nor earlier history, so the positive branch stays PROBE TODO"
        executionReading = { status: "unavailable", reason: availability.reason, detail }
      } else {
        executionReading = { status: "measured", reader: "state", runId: input.runId, unknown, handled, target, detail }
      }
    } catch (error) {
      executionReading = {
        status: availability.reason === undefined ? "invalid" : "unavailable",
        reason: redactNativeEditorPaths(error instanceof Error ? error.message : String(error)),
        detail,
      }
    } finally {
      if (!executionCaptured) {
        try {
          detail.captures.push({
            phase: "failed-read",
            observation: await input.editor.capture(input.featureId, "failed-read"),
          })
        } catch (error) {
          executionReading = {
            status: "invalid",
            reason: `Native editor evidence capture failed: ${redactNativeEditorPaths(String(error))}`,
            detail,
          }
        }
      }
    }
    return executionReading
  }
  const executionRow = NATIVE_EXECUTION_ROWS[input.featureId]
  if (executionRow !== undefined) return readNativeExecutionRow(executionRow)
  let restore: string | undefined
  let mutated = false
  let captured = false
  let reading: AppSemanticReading | undefined
  try {
    const original = await sample("initial")
    if (input.featureId !== "extensions.osc633-p") {
      availability.reason = "Native editor API supplies no typed observable for this row"
      throw new Error(availability.reason)
    }
    if (original !== undefined) restore = fileURLToPath(original)
    const baseline = `/terminfo-fixture-${randomUUID()}`
    mutated = true
    input.write(osc("633;A") + osc(`633;P;Cwd=${baseline}`))
    const baselineValue = await sample("baseline", pathToFileURL(baseline).toString())
    if (restore === undefined) {
      if (baselineValue === undefined) throw new Error("Native editor baseline has no CWD to restore")
      restore = fileURLToPath(baselineValue)
      detail.restoration = { scope: "measured fixture baseline", reason: "Initial native API CWD was absent" }
    }
    const unknownBefore = await sample("unknown-before")
    input.write(osc(`9999;Cwd=/terminfo-unknown-${randomUUID()}`))
    const unknownAfter = await sample("unknown-after")
    const handledBefore = await sample("handled-before")
    const handled = `/terminfo-control-${randomUUID()}`
    input.write(osc(`633;P;Cwd=${handled}`))
    const handledExpected = pathToFileURL(handled).toString()
    const handledAfter = await sample("handled-after", handledExpected)
    const targetBefore = await sample("target-before")
    const target = `/terminfo-target-${randomUUID()}`
    input.write(osc(`633;P;Cwd=${target}`))
    const targetExpected = pathToFileURL(target).toString()
    const targetAfter = await sample("target-after", targetExpected)
    detail.captures.push({ phase: "target", observation: await input.editor.capture(input.featureId, "target") })
    captured = true
    if (
      unknownBefore === undefined ||
      unknownAfter === undefined ||
      handledBefore === undefined ||
      handledAfter === undefined ||
      targetBefore === undefined ||
      targetAfter === undefined
    ) {
      availability.reason = "Native editor CWD controls contain an absent API value"
      throw new Error(availability.reason)
    }
    reading = {
      status: "measured",
      reader: "state",
      runId: input.runId,
      unknown: { before: unknownBefore, after: unknownAfter },
      handled: { before: handledBefore, after: handledAfter, expected: handledExpected },
      target: { before: targetBefore, after: targetAfter, expected: targetExpected },
      detail,
    }
  } catch (error) {
    reading = {
      status: availability.reason === undefined ? "invalid" : "unavailable",
      reason: redactNativeEditorPaths(error instanceof Error ? error.message : String(error)),
      detail,
    }
  } finally {
    if (!captured) {
      try {
        detail.captures.push({
          phase: "failed-read",
          observation: await input.editor.capture(input.featureId, "failed-read"),
        })
      } catch (error) {
        reading = {
          status: "invalid",
          reason: `Native editor evidence capture failed: ${redactNativeEditorPaths(String(error))}`,
          detail,
        }
      }
    }
    if (mutated && restore !== undefined) {
      try {
        input.write(osc(`633;P;Cwd=${restore}`))
        await sample("restored", pathToFileURL(restore).toString())
      } catch (error) {
        reading = {
          status: "invalid",
          reason: `Native editor fixture restoration failed: ${redactNativeEditorPaths(String(error))}`,
          detail,
        }
      }
    } else if (mutated) {
      detail.restoration = {
        scope: "owned disposable fixture",
        status: "unrestored",
        reason: "No native CWD value was observed to restore; owned run cleanup is required",
      }
    }
  }
  if (reading === undefined) throw new Error("Native editor sampling completed without a reading")
  return reading
}

/** Owned App/mux read, with native editor observation selected outside the generic grader. */
export async function readAppSemanticState(
  input: {
    appId?: string
    featureId: string
    write: (text: string) => void
    runId: string
    mux?: "tmux" | "screen"
    readTitle?: LinuxClipboardAdapter["readTitle"]
    withIconNameFixture?: LinuxClipboardAdapter["withIconNameFixture"]
    /** Private port supplied only by the verified owner; the checkpoint fences the same pane writes. */
    readCwd?: (checkpoint?: {
      row: number
      marker: string
      phase?: "unknown" | "handled" | "target" | "restore"
      expectedPath?: string
    }) => Promise<{ uri: string; detail: object } | { path: string; detail: object }>
    /**
     * The verified owner's private TTY writer (34870, 34905): Terminal.app's and cmux's restoration feeds carry the
     * session's own directory, which must stay out of the probe source's publishable write trace (CTO6a2de139).
     */
    privateWrite?: (text: string) => void | Promise<void>
    onRetained?: Parameters<typeof retainCaptureArtifact>[3]
    /**
     * Private port supplied only by the verified macOS WezTerm owner (34646): the owned pane's top rows from its
     * bundle CLI `get-text`, already passed through weztermHyperlinkText when `escapes` is set.
     */
    readRows?: (escapes: boolean) => Promise<string>
  } & ({ editor: NativeEditorSource; executable?: never } | { editor?: never; executable: LiveExecutable }),
): Promise<AppSemanticReading> {
  const detail: { commands: Array<{ argv: string[]; stdout: string }>; phases: object[]; identity?: object } = {
    commands: [],
    phases: [],
  }
  try {
    const env = process.env
    if (env.TERMINFO_RUN_ID !== input.runId || !/^[0-9a-f]{32}$/.test(input.runId)) {
      throw new Error("App semantic reader has no matching launch run")
    }
    if (input.mux !== (env.TERMINFO_MUX_KIND || undefined)) {
      throw new Error("App semantic reader mux identity differs from its owned attachment")
    }
    if (input.editor !== undefined) {
      try {
        return await readNativeEditorState({ ...input, editor: input.editor })
      } catch (error) {
        // Setup can fail before sampling starts (for example, activation never completed).
        // The caller already verified its owner; retain that window on this failure too.
        const reason = redactNativeEditorPaths(error instanceof Error ? error.message : String(error))
        try {
          const observation = await input.editor.capture(input.featureId, "failed-read")
          return {
            status: "invalid",
            reason,
            detail: {
              nativeFailure: { diagnostic: reason },
              nativeObservations: [],
              captures: [{ phase: "failed-read", observation }],
            },
          }
        } catch (captureError) {
          return {
            status: "invalid",
            reason: `${reason}; native editor evidence capture failed: ${redactNativeEditorPaths(String(captureError))}`,
            detail: {
              nativeFailure: { diagnostic: reason },
              captureFailure: redactNativeEditorPaths(String(captureError)),
            },
          }
        }
      }
    }
    if (input.featureId === "extensions.osc0-icon-title" || input.featureId === "extensions.osc1-icon") {
      const fixture = input.withIconNameFixture
      const readTitle = input.readTitle
      if (input.mux || !fixture || !readTitle) {
        return {
          status: "unavailable",
          reason: input.mux
            ? "A multiplexer has no icon name; the outer terminal's row applies"
            : "No owned native App icon fixture",
        }
      }
      const osc1 = input.featureId === "extensions.osc1-icon"
      return await fixture(input.write, async (readIcon) => {
        const nonce = randomUUID().slice(0, 8)
        const titleA = `icon-title-a-${nonce}`
        const payloadB = `icon-name-b-${nonce}`
        // #34932: each read after a write settles past what the surface showed before it, through the one title settle
        // (#34836); WezTerm 13:06Z read the previous title right after OSC 2 and graded the control as failed.
        const prior = { title: await readTitle(), icon: await readIcon() }
        input.write(`\x1b]2;${titleA}\x07`)
        const set = {
          title: (await settledTitle(readTitle, titleA, prior.title)).value,
          icon: await readIcon(),
        }
        if (set.title !== titleA) {
          return { status: "invalid", reason: "OSC 2 did not set title A", detail: { titleA, prior, set } }
        }
        input.write(`\x1b]${osc1 ? "1" : "0"};${payloadB}\x07`)
        const after = {
          // OSC 0 also sets the title; OSC 1 leaves it at title A, which the first read already shows.
          title: (await settledTitle(readTitle, osc1 ? titleA : payloadB, titleA)).value,
          icon: (await settledTitle(readIcon, payloadB, set.icon)).value,
        }
        const before = JSON.stringify([set.title, set.icon])
        const seen = JSON.stringify([after.title, after.icon])
        const expected = JSON.stringify([titleA, payloadB])
        return {
          status: "measured",
          reader: "state",
          runId: input.runId,
          unknown: { before, after: before },
          handled: { before, after: before, expected: before },
          target: { before, after: seen, expected },
          detail: { titleA, payloadB, title: after.title, icon: after.icon },
        }
      })
    }
    const appId = input.appId ?? env.TERMINFO_TARGET_ID
    if (
      input.mux === "screen" ||
      (!input.mux &&
        appId !== "kitty" &&
        appId !== "ghostty" &&
        appId !== "wezterm" &&
        appId !== "cmux" &&
        // 34870: Terminal.app has only its owned cwd getter; without one it has no reader here.
        !(appId === "terminal-app" && input.readCwd !== undefined))
    ) {
      return { status: "unavailable", reason: "No semantic reader for this App", detail }
    }
    const capture = env.TERMINFO_CAPTURE_DIRECTORY
    if (!capture || !isAbsolute(capture)) throw new Error("App semantic reader has no owned artifact directory")
    const run = (argv: [string, ...string[]]) => {
      const stdout = execFileSync(argv[0], argv.slice(1), {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      })
      detail.commands.push({ argv, stdout })
      return stdout
    }
    const until = (read: () => string | Promise<string>, complete: (value: string) => boolean, name: string) =>
      untilAppSemanticRead(read, complete, name, detail.phases)
    const osc = (body: string) => `\x1b]${body}\x07`
    const nonce = randomUUID().slice(0, 8)
    /**
     * The OSC 8 state rows: plain, made-up OSC 888, handled control URI, target id+URI, each read back with its
     * hyperlink escapes. `readRows` is the owner's text read of the pane's top rows (tmux capture-pane, or the
     * WezTerm CLI get-text, on Linux or through the macOS owner's port).
     */
    const readOsc8 = async (readRows: (escapes: boolean) => string | Promise<string>): Promise<AppSemanticReading> => {
      let serial = 0
      const sample = async (number: number, feed: string) => {
        const marker = `Q-${nonce}-${serial++}`
        input.write(`\x1b[${number};1H\x1b[2K${feed}${marker}`)
        await until(
          () => readRows(false),
          (value) => value.split("\n")[number - 1]?.includes(marker) === true,
          "OSC8 marker",
        )
        const escaped = await readRows(true)
        const line = escaped.split("\n")[number - 1]
        const index = line?.lastIndexOf(marker) ?? -1
        if (line === undefined || index < 0) throw new Error(`Unreadable OSC8 row${number}`)
        const value = line.slice(0, index) + line.slice(index + marker.length)
        detail.phases.push({ number, feed, marker, line, escaped, value })
        return value
      }
      const controlUri = `https://control-${nonce}.invalid/osc8`
      const targetId = "ex-link-1"
      const targetUri = "https://terminfo.dev/osc8"
      input.write("\x1b]8;;\x07\x1b[2J\x1b[3J\x1b[H")
      try {
        const initial = await sample(1, "linked after ")
        const unknown = await sample(1, `${osc(`888;id=${targetId};${targetUri}`)}linked${osc("888;;")} after `)
        const handled = await sample(2, `${osc(`8;;${controlUri}`)}linked${osc("8;;")} after `)
        const target = await sample(3, `${osc(`8;id=${targetId};${targetUri}`)}linked${osc("8;;")} after `)
        return {
          status: "measured",
          reader: "state",
          runId: input.runId,
          unknown: { before: initial, after: unknown },
          handled: {
            before: initial,
            after: handled,
            expected: `\x1b]8;;${controlUri}\x1b\\linked\x1b]8;;\x1b\\ after `,
          },
          target: {
            before: initial,
            after: target,
            expected: `\x1b]8;id=${targetId};${targetUri}\x1b\\linked\x1b]8;;\x1b\\ after `,
          },
          detail,
        }
      } finally {
        input.write("\x1b]8;;\x07\x1b[2J\x1b[3J\x1b[H")
      }
    }
    const readCwdPhases = async <T extends { cwd: string }>(
      initial: T,
      sample: (number: number, feed: string) => Promise<T>,
      restore: () => Promise<void>,
      expectedValue: (value: string) => string = (value) => value,
      // A reader whose fresh values must exist (Kitty's launch enters them) passes its own; `unchanged` names it.
      fresh?: { control: string; target: string; unchanged: string },
    ): Promise<AppSemanticReading> => {
      const controlPath = fresh?.control ?? `file://localhost/terminfo-control-${nonce}`
      const isOsc7 = input.featureId === "extensions.osc7-cwd"
      const targetPath =
        fresh?.target ?? (isOsc7 ? `file://localhost/terminfo-target-${nonce}` : `/terminfo-target-${nonce}`)
      try {
        if (isOsc7 && (initial.cwd === controlPath || initial.cwd === targetPath)) {
          throw new Error("tmux OSC7 control and target paths must be fresh")
        }
        const unknown = await sample(1, osc(isOsc7 ? `77;${targetPath}` : "133;Z"))
        const unknownReading = {
          before: isOsc7 ? initial.cwd : JSON.stringify(initial),
          after: isOsc7 ? unknown.cwd : JSON.stringify(unknown),
        }
        const handled = await sample(2, osc(`7;${controlPath}`))
        const target = await sample(3, osc(isOsc7 ? `7;${targetPath}` : `633;P;Cwd=${targetPath}`))
        if (isOsc7 && target.cwd === handled.cwd) {
          return {
            status: "invalid",
            reason: fresh?.unchanged ?? "tmux OSC7 target left pane_path unchanged after its same-command control",
            detail,
          }
        }
        return {
          status: "measured",
          reader: "state",
          runId: input.runId,
          unknown: unknownReading,
          handled: { before: initial.cwd, after: handled.cwd, expected: expectedValue(controlPath) },
          target: { before: handled.cwd, after: target.cwd, expected: expectedValue(targetPath) },
          detail,
        }
      } finally {
        await restore()
      }
    }
    const ownedRows = input.readRows
    if (ownedRows) {
      // 34646: WezTerm 20240203-110809-5046fc22 on macOS reads OSC 8 through its owner's bundle CLI get-text,
      // the reader its Linux row already uses (@cto 17dda1f9 named this route when the no-way row was removed).
      if (
        input.mux ||
        appId !== "wezterm" ||
        env.TERMINFO_TARGET_VERSION !== "20240203-110809-5046fc22" ||
        input.featureId !== "extensions.osc8"
      ) {
        return { status: "unavailable", reason: "No reviewed owned row reader for this App/feature", detail }
      }
      detail.identity = { executable: input.executable, runId: input.runId }
      return await readOsc8(ownedRows)
    }
    const ownedCwd = input.readCwd
    if (ownedCwd) {
      // Each reviewed getter names its app, the version its source was read at, and the ids it can decide.
      const reviewed =
        (appId === "wezterm" &&
          env.TERMINFO_TARGET_VERSION === "20240203-110809-5046fc22" &&
          input.featureId === "extensions.osc633-p") ||
        // 34601: Ghostty 1.4.0's AppleScript `working directory` (macos/Ghostty.sdef:98, ScriptTerminal.swift).
        (appId === "ghostty" &&
          env.TERMINFO_TARGET_VERSION === "1.4.0" &&
          (input.featureId === "extensions.osc633-p" || input.featureId === "extensions.osc7-cwd")) ||
        // 34870 (@cto 34870-terminalapp-cwd-r1): Terminal.app 2.15's window AXDocument, read through JXA AX.
        (appId === "terminal-app" &&
          env.TERMINFO_TARGET_VERSION === "2.15" &&
          input.featureId === "extensions.osc633-p") ||
        // 34905: cmux 0.65.2's control-socket `workspace.current` current_directory.
        (appId === "cmux" && env.TERMINFO_TARGET_VERSION === "0.65.2" && input.featureId === "extensions.osc633-p")
      if (input.mux || !reviewed) {
        return { status: "unavailable", reason: "No reviewed owned cwd getter for this App/feature", detail }
      }
      // Terminal.app runs the accepted two-control, two-target experiment with restoration (r1 item 1); the other
      // reviewed getters keep their existing single-pair recipe unchanged.
      const pairs = appId === "terminal-app"
      // Run 44392648569: Terminal.app 2.15 clears AXDocument (kAXErrorNoValue) for an OSC 7 path that does not
      // exist, so nonce paths cannot move it. Its controls and targets are four fresh, empty directories this run
      // creates beside its capture area and removes after restoration (@cto r1 Q1 fallback; Kitty's precedent).
      const made: string[] = []
      let sentControls: string[] = []
      let sentTargets: string[] = []
      const freshDirectory = (name: string) => {
        const path = join(dirname(capture), `osc7-${name}-${nonce}`)
        mkdirSync(path)
        made.push(path)
        const real = realpathSync(path)
        if (!/^\/[A-Za-z0-9._/-]*$/.test(real)) {
          throw new Error(
            `Terminal.app cwd directory cannot be written literally in a file URI: ${JSON.stringify(real)}`,
          )
        }
        return real
      }
      const restoration: { attempted: boolean; equal: boolean | null } = { attempted: false, equal: null }
      const privateWrite = input.privateWrite
      const cmuxPrivateWrite = appId === "cmux" ? privateWrite : undefined
      if (appId === "cmux" && cmuxPrivateWrite === undefined) {
        return {
          status: "invalid",
          reason: "cmux owned cwd reader requires the owner's private restoration writer",
          detail,
        }
      }
      let restoredEqual = false
      let restoreFailed = false
      const observe = async (): Promise<AppSemanticReading> => {
        // Terminal.app 2.15 serialises AXDocument with one trailing slash (34841 ax-0..6.json, file:///private/var/);
        // its adapter alone removes exactly one, never from "/" (r1 item 3). No case, symlink or host folding.
        const pathValue = (value: string) => {
          const path = value.startsWith("file:") ? decodeURIComponent(new URL(value).pathname) : value
          return pairs && path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
        }
        const get = async (checkpoint?: {
          row: number
          marker: string
          phase?: "unknown" | "handled" | "target" | "restore"
          expectedPath?: string
        }) => {
          const read = await ownedCwd(checkpoint)
          let reading: { cwd: string; rawUri?: string; host?: string; sourceKind: string }
          if ("path" in read) {
            // A path getter has no host to compare: Ghostty stores OSC 7 only after its own local-host check
            // (src/termio/stream_handler.zig reportPwd), and "" is its "no pwd yet".
            reading = { cwd: read.path, sourceKind: "undetermined" }
          } else {
            const uri = new URL(read.uri)
            if (uri.protocol !== "file:") throw new Error(`Owned cwd getter returned a non-file URI: ${read.uri}`)
            reading = { cwd: pathValue(read.uri), rawUri: read.uri, host: uri.hostname, sourceKind: "undetermined" }
          }
          detail.phases.push({ ...(checkpoint && { checkpoint }), reading, receipt: read.detail })
          return reading
        }
        const initial = await get()
        if (pairs) {
          sentControls = [freshDirectory("control-A"), freshDirectory("control-B")]
          sentTargets = [freshDirectory("target-A"), freshDirectory("target-B")]
        }
        const processCwd = process.cwd()
        const freshPaths = pairs
          ? [...sentControls, ...sentTargets]
          : [`/terminfo-control-${nonce}`, `/terminfo-target-${nonce}`]
        if (freshPaths.includes(processCwd) || freshPaths.includes(initial.cwd)) {
          throw new Error("Owned cwd control/target must differ from process and baseline cwd")
        }
        detail.identity = { executable: input.executable, runId: input.runId, processCwd }
        let serial = 0
        let mutated = false
        const sample = async (number: number, feed: string) => {
          mutated = true
          const marker = `Q-${nonce}-${serial++}`
          const phase: "unknown" | "handled" | "target" = number === 1 ? "unknown" : number === 2 ? "handled" : "target"
          const expectedPath =
            number === 1 ? initial.cwd : number === 2 ? `/terminfo-control-${nonce}` : `/terminfo-target-${nonce}`
          const text = `\x1b[${number};1H${feed}${marker}`
          if (pairs && number >= 2) {
            // 34935 (@cto option A): Terminal.app's two OSC 7 controls and two OSC 633 P targets name run-owned
            // directories under the runner's capture area. They go through the owner's private writer, so the
            // public trace (rawReplies and callLog) omits them; the exact ordered bytes stay in private evidence,
            // marked written only once the write returned.
            if (privateWrite === undefined) throw new Error("Terminal.app cwd needs the owner's private writer")
            const stimulus = {
              row: number,
              stimulus: number <= 3 ? "osc7-control" : "osc633p-target",
              feed: text,
              written: false,
            }
            detail.phases.push({ stimulus })
            await privateWrite(text)
            stimulus.written = true
          } else {
            input.write(text)
          }
          const reading = await get({ row: number, marker, phase, expectedPath })
          const expectedHost = number === 1 ? initial.host : new URL("file://localhost/").hostname
          // Host is compared only between URI readings; a path getter's readings never carry one.
          if (reading.rawUri !== undefined && reading.host !== expectedHost) {
            throw new Error(
              `Owned cwd host mismatch: expected ${expectedHost}, read ${reading.host}; ${reading.rawUri}`,
            )
          }
          return reading
        }
        if (!pairs) {
          return readCwdPhases(
            initial,
            sample,
            async () => {
              if (cmuxPrivateWrite === undefined) {
                detail.phases.push({ note: "pane left pinned; owner closes it at end of run" })
                return
              }
              if (!mutated) return
              try {
                // eslint-disable-next-line no-control-regex -- raw OSC restoration data must contain no terminal controls
                if (!initial.cwd.startsWith("/") || /[\x00-\x1f\x7f]/u.test(initial.cwd)) {
                  throw new Error("Owned cwd initial path cannot be safely encoded for restoration")
                }
                // Ghostty reportPwd (src/termio/stream_handler.zig:1357-1391) parses OSC 7 via RFC 3986 std.Uri and
                // requires a non-empty local hostname (src/os/hostname.zig:96-119 isLocal returns true for "localhost"
                // and false for ""). WHATWG pathToFileURL().href emits "file:///path" (empty host), so use .pathname.
                const restoreUri = `file://localhost${pathToFileURL(initial.cwd).pathname}`
                const marker = `Q-${nonce}-${serial++}`
                await cmuxPrivateWrite(`\x1b[4;1H${osc(`7;${restoreUri}`)}${marker}`)
                const restored = await get({
                  row: 4,
                  marker,
                  phase: "restore",
                  expectedPath: initial.cwd,
                })
                if (restored.cwd !== initial.cwd) {
                  throw new Error("Owned cwd restoration read back a different directory")
                }
                restoredEqual = true
              } catch (error) {
                restoredEqual = false
                restoreFailed = true
                detail.phases.push({
                  phase: "restore",
                  error: error instanceof Error ? error.message : String(error),
                })
              }
            },
            pathValue,
          )
        }
        // The probe's own experiment (probe-defs extensions.ts promptCwdPropertyResult) in the reading fields the
        // iTerm2 arm already uses: both OSC 7 controls must read back exactly before either 633 P target counts.
        const initialUri = initial.rawUri
        if (privateWrite === undefined || initialUri === undefined || /[\x00-\x1f\x7f]/.test(initialUri)) {
          return {
            status: "invalid",
            reason: "Terminal.app cwd needs the owner's private writer and a restorable initial file URI",
            detail,
          }
        }
        let reading: AppSemanticReading
        try {
          const unknown = await sample(1, osc("133;Z"))
          const controls: string[] = []
          for (const [index, path] of sentControls.entries()) {
            restoration.attempted = true
            controls.push((await sample(2 + index, osc(`7;file://localhost${path}`))).cwd)
          }
          if (controls.every((value) => value === initial.cwd)) {
            reading = {
              status: "unavailable",
              reason: "Terminal.app AXDocument did not move for two distinct fresh run-owned OSC 7 control directories",
              detail,
            }
          } else {
            const priors: string[] = []
            const targets: string[] = []
            let prior = controls.at(-1) as string
            for (const [index, path] of sentTargets.entries()) {
              priors.push(prior)
              prior = (await sample(4 + index, osc(`633;P;Cwd=${path}`))).cwd
              targets.push(prior)
            }
            reading = {
              status: "measured",
              reader: "state",
              runId: input.runId,
              unknown: { before: initial.cwd, after: unknown.cwd },
              handled: {
                before: JSON.stringify([initial.cwd, controls[0]]),
                after: JSON.stringify(controls),
                expected: JSON.stringify(sentControls.map(pathValue)),
              },
              target: {
                before: JSON.stringify(priors),
                after: JSON.stringify(targets),
                expected: JSON.stringify(sentTargets.map(pathValue)),
              },
              detail,
            }
          }
        } catch (error) {
          detail.phases.push({ error: error instanceof Error ? error.message : String(error) })
          reading = { status: "invalid", reason: ownedCwdFailure(error), detail }
        }
        if (!restoration.attempted) return reading
        // Restore through the owner's private TTY writer, so the initial URI never enters the public feed trace,
        // and read it back under its own fence (r1 item 1). A failed restore keeps the reading's own reason first.
        let restoreFailure: string | undefined
        try {
          const marker = `Q-${nonce}-restore`
          await privateWrite(`\x1b[6;1H\x1b]7;${initialUri}\x07${marker}`)
          const restored = await get({ row: 6, marker })
          restoration.equal = restored.cwd === initial.cwd
          if (!restoration.equal) restoreFailure = "the initial directory did not read back after restoration"
        } catch (error) {
          detail.phases.push({ restoreError: error instanceof Error ? error.message : String(error) })
          restoreFailure = `restoring the initial directory failed: ${ownedCwdFailure(error)}`
        }
        if (restoreFailure === undefined) return reading
        const primary = reading.status === "measured" ? undefined : reading.reason
        return {
          status: "invalid",
          reason:
            primary === undefined
              ? `Terminal.app cwd was read, but ${restoreFailure}`
              : `${primary}; then ${restoreFailure}`,
          detail,
        }
      }
      let reading: AppSemanticReading
      try {
        reading = await observe()
      } catch (error) {
        detail.phases.push({ phase: "primary", error: error instanceof Error ? error.message : String(error) })
        reading = {
          status: "invalid",
          reason: pairs ? ownedCwdFailure(error) : "Owned cwd observation failed; see private evidence",
        }
      }
      if (cmuxPrivateWrite !== undefined && (restoreFailed || !restoredEqual) && reading.status === "measured") {
        reading = { status: "invalid", reason: "Owned cwd restoration failed; see private evidence" }
      }
      // The run's directories go only after restoration has been read; a failed removal is named, never dropped,
      // and follows any earlier failure the way a failed restoration does.
      for (const path of made.reverse()) {
        try {
          rmdirSync(path)
        } catch (error) {
          detail.phases.push({ cleanupError: error instanceof Error ? error.message : String(error) })
          const removal = "could not remove a run-owned control directory"
          reading = {
            status: "invalid",
            reason:
              reading.status === "measured"
                ? `Terminal.app cwd was read, but ${removal}`
                : `${reading.reason}; then ${removal}`,
          }
        }
      }
      const bytes = Buffer.from(JSON.stringify({ reading, detail, processCwd: process.cwd() }))
      // The shared phase reader is private. Clear its diagnostic carrier before any
      // retention failure reaches the outer, publishable error result.
      detail.commands.length = 0
      detail.phases.length = 0
      delete detail.identity
      let privateEvidence: string | undefined
      try {
        const onRetained = input.onRetained
        if (onRetained === undefined) throw new Error("Missing owned artifact observer")
        retainCaptureArtifact(capture, bytes, "json", (artifact) => {
          onRetained(artifact)
          privateEvidence = basename(artifact.path)
        })
      } catch (error) {
        throw new Error("Owned cwd private evidence retention failed", { cause: error })
      }
      const publicDetail = pairs
        ? { privateEvidence, initialSourceKind: "undetermined", paneLeftPinned: !restoration.equal, restoration }
        : cmuxPrivateWrite === undefined
          ? { privateEvidence, initialSourceKind: "undetermined", paneLeftPinned: true }
          : { privateEvidence, initialSourceKind: "undetermined", restoredEqual }
      if (reading.status !== "measured" || reading.reader !== "state") {
        // Terminal.app's reasons are built from phases and error numbers only (r1 item 4), so they publish as read;
        // an inert pair of controls stays unavailable (TODO), never invalid.
        if (pairs && reading.status !== "measured") {
          return { status: reading.status, reason: reading.reason, detail: publicDetail }
        }
        return {
          status: "invalid",
          reason: reading.status !== "measured" ? reading.reason : "Owned cwd observation failed; see private evidence",
          detail: publicDetail,
        }
      }
      const fresh = pairs
        ? [...sentControls, ...sentTargets]
        : [`/terminfo-control-${nonce}`, `/terminfo-target-${nonce}`]
      // A run-owned directory publishes as its own name under a fixed label, never the runner's absolute path; the
      // same mapping applies to sent and read values, so the grade is unchanged.
      const publicValue = (value: string) =>
        fresh.includes(value)
          ? pairs
            ? `/run-owned/${basename(value)}`
            : value
          : createHash("sha256").update(value).digest("hex")
      // The pair experiment's handled/target fields are JSON arrays: hash each element, keep the array.
      const publicField = (value: string) =>
        pairs ? JSON.stringify((JSON.parse(value) as string[]).map(publicValue)) : publicValue(value)
      return {
        ...reading,
        unknown: { before: publicValue(reading.unknown.before), after: publicValue(reading.unknown.after) },
        handled: {
          before: publicField(reading.handled.before),
          after: publicField(reading.handled.after),
          expected: publicField(reading.handled.expected),
        },
        target: {
          before: publicField(reading.target.before),
          after: publicField(reading.target.after),
          expected: publicField(reading.target.expected),
        },
        detail: publicDetail,
      }
    }
    const mux = input.mux === "tmux"
    let pane: string | undefined
    let tmux: ((...args: string[]) => string) | undefined
    let appPid: number | undefined
    let subject: { kind: string; id: string; version: string; os: string }
    if (mux) {
      const socket = readFileSync(join(dirname(capture), "mux-socket.txt"), "utf8").trim()
      pane = env.TMUX_PANE
      const binding = env.TMUX?.split(",")
      if (
        !pane ||
        !/^%\d+$/.test(pane) ||
        binding?.[0] !== socket ||
        !statSync(socket).isSocket() ||
        !socket.endsWith(`/terminfo-${input.runId}.sock`)
      ) {
        throw new Error("App semantic reader tmux socket/pane changed")
      }
      tmux = (...args) => run(["tmux", "-S", socket, ...args])
      const identity = tmux(
        "display-message",
        "-p",
        "-t",
        pane,
        "#{version}\t#{pid}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{socket_path}",
      )
        .trim()
        .split("\t")
      const version = identity[0]
      if (
        !version ||
        identity[1] !== binding[1] ||
        identity[2] !== pane ||
        Number(identity[3]) !== process.pid ||
        identity[4] !== readlinkSync("/proc/self/fd/0") ||
        identity[5] !== socket
      ) {
        throw new Error(`App semantic reader tmux owner changed: ${JSON.stringify(identity)}`)
      }
      detail.identity = { identity, runId: input.runId }
      subject = { kind: "mux", id: "tmux", version, os: "linux" }
    } else {
      if (appId !== "kitty" && appId !== "ghostty" && appId !== "wezterm") {
        return { status: "unavailable", reason: "No semantic reader for this App", detail }
      }
      const pid = kittyAncestor(input.executable)
      appPid = pid
      if (appId === "kitty" && String(pid) !== env.KITTY_PID) {
        throw new Error("App semantic reader Kitty PID differs from its owned ancestor")
      }
      const versionExecutable =
        appId === "wezterm" ? join(dirname(input.executable.path), "wezterm") : input.executable.path
      const versionText = run([versionExecutable, "--version"])
      const version = (
        appId === "kitty" ? /^kitty (\S+) created by /m : appId === "wezterm" ? /^wezterm (\S+)/m : /^Ghostty (\S+)/m
      ).exec(versionText)?.[1]
      if (!version || version !== env.TERMINFO_TARGET_VERSION) {
        throw new Error(`App semantic reader ${appId} version differs from its launch`)
      }
      detail.identity = { pid, executable: input.executable, version, runId: input.runId }
      subject = { kind: "term", id: appId, version, os: "linux" }
    }
    const row = declarations.find(
      (entry) =>
        entry.kind === subject.kind &&
        entry.id === subject.id &&
        entry.version === subject.version &&
        entry.os === subject.os &&
        entry.featureId === input.featureId &&
        entry.reader !== undefined,
    )
    if (!row?.reader) {
      return {
        status: "unavailable",
        reason: `No reviewed App semantic reader for ${subject.id} ${subject.version} ${input.featureId}`,
        detail,
      }
    }
    if (row.reader === "kitty-prompt" || row.reader === "kitty-cwd") {
      const kittyLabel = row.reader === "kitty-cwd" ? "Kitty cwd" : "Kitty prompt"
      const socket = env.KITTY_LISTEN_ON
      const windowId = env.KITTY_WINDOW_ID
      const socketPath = join(dirname(capture), `kitty-${input.runId}.sock`)
      if (
        socket !== `unix:${socketPath}` ||
        !windowId ||
        !/^[1-9]\d*$/.test(windowId) ||
        !statSync(socketPath).isSocket()
      ) {
        throw new Error(`${kittyLabel} read requires this run's private socket and window ID`)
      }
      const kitten = join(dirname(input.executable.path), "kitten")
      const remote = (...args: string[]) => run([kitten, "@", "--to", socket, ...args, "--match", `id:${windowId}`])
      const readWindow = () => {
        const tree: unknown = JSON.parse(remote("ls"))
        if (!Array.isArray(tree)) throw new Error(`${kittyLabel} ls returned no window tree`)
        const osWindows: readonly unknown[] = tree
        const windows: unknown[] = []
        for (const osWindow of osWindows) {
          const tabs =
            osWindow !== null && typeof osWindow === "object" ? (osWindow as Record<string, unknown>).tabs : undefined
          if (!Array.isArray(tabs)) throw new Error(`${kittyLabel} ls returned no tabs`)
          const tabRecords: readonly unknown[] = tabs
          for (const tab of tabRecords) {
            const entries =
              tab !== null && typeof tab === "object" ? (tab as Record<string, unknown>).windows : undefined
            if (!Array.isArray(entries)) throw new Error(`${kittyLabel} ls returned no windows`)
            windows.push(...entries)
          }
        }
        const window = windows[0] as Record<string, unknown> | undefined
        if (
          windows.length !== 1 ||
          !window ||
          window.id !== Number(windowId) ||
          window.pid !== process.pid ||
          typeof window.at_prompt !== "boolean" ||
          !Number.isSafeInteger(window.last_cmd_exit_status) ||
          typeof window.title !== "string"
        ) {
          throw new Error(`${kittyLabel} ls did not identify this collector's window and semantic fields`)
        }
        return { prompt: window.at_prompt, exit: window.last_cmd_exit_status as number, title: window.title }
      }
      const output = () => remote("get-text", "--extent", "last_cmd_output").replace(/\r\n/g, "\n").trimEnd()
      const original = readWindow()
      if (/[\x00-\x1f\x7f]/.test(original.title)) throw new Error(`${kittyLabel} fixture cannot restore its title`)
      let serial = 0
      const phase = async (name: string, feed: string, title = `terminfo-${nonce}-${serial++}`) => {
        input.write(feed + osc(`2;${title}`))
        let reading = readWindow()
        await until(
          () => {
            reading = readWindow()
            return reading.title
          },
          (value) => value === title,
          `${name} title fence`,
        )
        detail.phases.push({ name, feed, reading })
        return reading
      }
      if (row.reader === "kitty-cwd") {
        // 33628 (@cto 1957): Kitty 0.49.2 exposes its OSC 7 report only to a launch with --cwd=last_reported, which
        // starts a background child in path_from_osc7_url(screen.last_reported_cwd) when the source window has one
        // (window.py CwdRequest.cwd_of_child, then boss.py's Popen(cwd=)), else in the window's process cwd. The child
        // must enter that path, so control and target are two fresh, empty directories this run creates in its private
        // directory and removes. Each phase's title fence proves Kitty parsed its bytes before the launch reads.
        const literal = (path: string) => {
          if (!/^\/[A-Za-z0-9._/-]*$/.test(path)) {
            throw new Error(`Kitty cwd path cannot be written literally in a file URI: ${JSON.stringify(path)}`)
          }
          return path
        }
        const privateDir = dirname(capture)
        const kittyCwd = readlinkSync(`/proc/${appPid}/cwd`)
        let reads = 0
        const read = async () => {
          const out = join(privateDir, `osc7-read-${nonce}-${reads++}`)
          run([
            kitten,
            "@",
            "--to",
            socket,
            "launch",
            "--type=background",
            "--source-window",
            `id:${windowId}`,
            "--cwd=last_reported",
            "--",
            "/bin/sh",
            "-c",
            'pwd -P > "$1.part" && mv "$1.part" "$1"',
            "sh",
            out,
          ])
          // The child renames its one line into place, so the file existing means the read completed.
          const bytes = await until(
            () => (existsSync(out) ? readFileSync(out, "utf8") : ""),
            (value) => value !== "",
            `Kitty cwd read ${basename(out)}`,
          )
          rmSync(out)
          if (!/^[^\n]+\n$/.test(bytes)) throw new Error(`Kitty cwd read was not one line: ${JSON.stringify(bytes)}`)
          const reading = { cwd: bytes.slice(0, -1) }
          detail.phases.push({ name: "cwd read", file: basename(out), reading })
          return reading
        }
        const initial = await read()
        literal(initial.cwd)
        const made: string[] = []
        try {
          const fresh = (name: string) => {
            const path = join(privateDir, `osc7-${name}-${nonce}`)
            mkdirSync(path)
            made.push(path)
            return literal(realpathSync(path))
          }
          const control = fresh("control")
          const target = fresh("target")
          const others = [process.cwd(), kittyCwd, initial.cwd]
          if (control === target || others.includes(control) || others.includes(target)) {
            throw new Error("Kitty cwd control and target must differ from each other and every baseline cwd")
          }
          detail.identity = { ...detail.identity, kittyCwd, processCwd: process.cwd(), control, target }
          let serial = 0
          const sample = async (_number: number, feed: string) => {
            await phase(`cwd ${serial++}`, feed)
            return read()
          }
          return await readCwdPhases(
            initial,
            sample,
            async () => {
              // Kitty cannot clear last_reported_cwd: restore the observed public path, and say initial OSC 7
              // presence is neither restored nor reported (@cto a35de3e1, 1957).
              await phase("restored", osc(`7;file://${initial.cwd}`), original.title)
              const restored = await read()
              detail.phases.push({ restoration: "observed public path; initial OSC 7 presence not reported" })
              if (restored.cwd !== initial.cwd) {
                throw new Error(`Kitty cwd restoration read ${restored.cwd}, not ${initial.cwd}`)
              }
            },
            (uri) => uri.slice("file://".length),
            {
              control: `file://${control}`,
              target: `file://${target}`,
              unchanged: "Kitty OSC7 target left the launch cwd unchanged after its same-command control",
            },
          )
        } finally {
          for (const path of made.reverse()) rmdirSync(path)
        }
      }
      const commandOutput = `terminfo-output-${nonce}`
      try {
        input.write("\x1b[2J\x1b[3J\x1b[H")
        const initial = await phase(
          "baseline",
          osc("133;C") +
            `terminfo-baseline-${nonce}\r\n` +
            osc("133;D;0") +
            (input.featureId === "extensions.osc133-c" ? osc("133;A") : ""),
        )
        const initialOutput = output()
        const unknown = await phase("unknown", osc("133;Z"))
        const unknownOutput = output()
        const handled = await phase("handled", "", `terminfo-control-${nonce}`)
        let before: string
        let after: string
        let expected: string
        if (input.featureId === "extensions.osc133-a") {
          before = String(handled.prompt)
          after = String((await phase("target", osc("133;A"))).prompt)
          expected = "true"
        } else if (input.featureId === "extensions.osc133-c") {
          before = output()
          await phase("target", osc("133;C") + commandOutput + "\r\n" + osc("133;D;0"))
          after = output()
          expected = commandOutput
        } else if (input.featureId === "extensions.osc133-d") {
          before = String(handled.exit)
          after = String((await phase("target", osc("133;C") + commandOutput + "\r\n" + osc("133;D;17"))).exit)
          expected = "17"
        } else {
          before = JSON.stringify([initial.prompt, initial.prompt, initial.exit, output()])
          const prompt = await phase("prompt", osc("133;A"))
          const running = await phase("output", osc("133;C") + commandOutput + "\r\n")
          const ended = await phase("end", osc("133;D;17"))
          after = JSON.stringify([prompt.prompt, running.prompt, ended.exit, output()])
          expected = JSON.stringify([true, false, 17, commandOutput])
        }
        return {
          status: "measured",
          reader: "state",
          runId: input.runId,
          unknown: {
            before: JSON.stringify([initial.prompt, initial.exit, initialOutput]),
            after: JSON.stringify([unknown.prompt, unknown.exit, unknownOutput]),
          },
          handled: { before: unknown.title, after: handled.title, expected: `terminfo-control-${nonce}` },
          target: { before, after, expected },
          detail,
        }
      } finally {
        await phase(
          "restored",
          osc("133;C") + osc(`133;D;${original.exit}`) + (original.prompt ? osc("133;A") : "") + "\x1b[2J\x1b[3J\x1b[H",
          original.title,
        )
      }
    }
    const namespace = input.featureId.includes("633") ? "633" : "133"
    const letter = input.featureId.slice(-1).toUpperCase()
    if (row.reader === "report") {
      const controls = row.reportControls
      const nonceControl = controls?.sentinel.body.includes("{nonce}") === true
      if (nonceControl) {
        const before = readFileSync(join(dirname(capture), "owner-executable.sha256"), "utf8")
        const expected = `${input.executable.sha256}  ${input.executable.path}\n`
        if (before !== expected) throw new Error("App report owner differs from its prelaunch executable digest")
        const config = readFileSync(join(dirname(capture), "target-config.txt"), "utf8")
        if (!config.includes("--config log_unknown_escape_sequences=true ")) {
          throw new Error("App report has no recorded unknown-escape logging launch argument")
        }
      }
      let title: (() => string) | undefined
      let original: string | undefined
      if (!controls || nonceControl) {
        const windows = run(["xdotool", "search", "--onlyvisible", "--pid", String(appPid)])
          .trim()
          .split(/\s+/)
        const window = windows[0]
        if (windows.length !== 1 || !window || !/^\d+$/.test(window)) {
          throw new Error(`App semantic reader has no unique owned ${subject.id} window`)
        }
        title = () => run(["xdotool", "getwindowname", window]).trimEnd()
        original = title()
        if (/[\x00-\x1f\x7f]/.test(original)) throw new Error("App semantic reader cannot restore owned title")
      }
      const log = openAppCommandLog(capture)
      let phase = 0
      const readPhase = async (name: string, feed: string) => {
        const offset = log.mark()
        const marker = `${nonce}-${phase++}`
        const sentinel = controls?.sentinel.body.replaceAll("{nonce}", marker) ?? `7655;${marker}`
        input.write(feed + osc(sentinel))
        const completionLine =
          controls?.sentinel.line.replaceAll("{nonce}", marker) ?? `Unknown OSC escape code: ${sentinel}`
        const completion = `${completionLine}\n`
        const reading = await log.read(offset, `app-semantic-${nonce}-${name}.log`, (text) => {
          const end = text.indexOf(completion)
          return end < 0 ? undefined : end + completion.length
        })
        if (!reading.complete) {
          detail.phases.push({ name, incomplete: reading.text, path: reading.path, offset })
          throw new Error(`App semantic reader did not observe ${name} OSC ${sentinel} completion`)
        }
        detail.phases.push({
          name,
          offset,
          endOffset: reading.endOffset,
          feed,
          sentinel,
          path: reading.path,
          appended: reading.text,
        })
        return reading.text
          .split("\n")
          .filter((value) =>
            nonceControl
              ? value.includes(" > Unhandled OSC  ") && !value.endsWith(completionLine)
              : controls
                ? value.includes("resetting dynamic color ") && !value.endsWith(controls.sentinel.line)
                : value.includes("[PARSE ERROR]") && !value.endsWith(`Unknown OSC escape code: ${sentinel}`),
          )
          .map((value) => {
            if (nonceControl) {
              const report = / > (Unhandled OSC  (\d+)(?: .*)?)$/.exec(value)
              const code = report?.[2]
              if (code === controls?.handled.code) throw new Error(`App handled OSC ${code} reported a refusal`)
              if (code && report?.[1] === controls?.targetLine && code === row.command?.code) return code
              if (report?.[1] === `Unhandled OSC  7654 ${nonce}`) return "7654"
              throw new Error(`Unrecognized App command-report format: ${value}`)
            }
            if (controls && value.endsWith(controls.handled.line)) {
              throw new Error(`App handled OSC ${controls.handled.code} reported a refusal`)
            }
            const code = controls
              ? value.endsWith(controls.targetLine)
                ? row.command?.code
                : undefined
              : /\[PARSE ERROR\] (?:Unknown OSC escape code: |Ignoring OSC )(\d+)(?:[;, ]|$)/.exec(value)?.[1]
            if (!code) throw new Error(`Unrecognized App command-report format: ${value}`)
            return code
          })
      }
      try {
        const unknown = controls && !nonceControl ? [] : await readPhase("unknown", osc(`7654;${nonce}`))
        const handled = await readPhase(
          "handled",
          osc(controls?.handled.body.replaceAll("{nonce}", nonce) ?? `2;Q-${nonce}`),
        )
        if (controls && handled.length) throw new Error(`App handled OSC ${controls.handled.code} reported a refusal`)
        if (title) await until(title, (value) => value === `Q-${nonce}`, "handled title")
        const body = row.command
          ? osc(row.command.body)
          : input.featureId === "extensions.osc-633-vscode"
            ? osc("633;A") + osc("633;C") + osc("633;D;17")
            : osc(
                `633;${letter}${letter === "D" ? ";17" : letter === "E" ? ";echo terminfo" : letter === "P" ? ";Cwd=/terminfo-target" : ""}`,
              )
        const target = await readPhase("target", body)
        return {
          status: "measured",
          reader: "report",
          runId: input.runId,
          unknown: {
            code: controls && !nonceControl ? controls.sentinel.code : "7654",
            reports: controls && !nonceControl ? [controls.sentinel.code] : unknown,
          },
          handled: { applied: true, reports: handled },
          target: { code: row.command?.code ?? "633", reports: target },
          detail,
        }
      } finally {
        if (original !== undefined) input.write(osc(`2;${original}`))
        if (nonceControl && title && original !== undefined) {
          await until(title, (value) => value === original, "restored title")
        }
      }
    }
    if (row.reader === "osc8" && ((tmux && pane) || subject.id === "wezterm")) {
      const command = tmux
      const targetPane = pane
      const readRows = (escapes: boolean) => {
        if (command && targetPane) {
          return command("capture-pane", "-p", ...(escapes ? ["-e"] : []), "-t", targetPane)
        }
        const read = readWindowsWezTermRows({
          executable: join(dirname(input.executable.path), "wezterm"),
          pane: env.WEZTERM_PANE,
          socket: env.WEZTERM_UNIX_SOCKET,
          rows: 3,
          startLine: 0,
          escapes,
        })
        if (read.status === "refused") throw new Error(read.reason)
        detail.phases.push({ wezterm: JSON.parse(read.receipt) })
        return weztermHyperlinkText(read.rows)
      }
      return await readOsc8(readRows)
    }
    if (!tmux || !pane) throw new Error("App state reader has no bound tmux command")
    const command = tmux
    const targetPane = pane
    const format = () => {
      const fields = command("display-message", "-p", "-t", targetPane, "#{pane_command_status}\t#{pane_path}")
        .replace(/\n$/, "")
        .split("\t")
      const [status, cwd] = fields
      if (fields.length !== 2 || status === undefined || cwd === undefined) {
        throw new Error(`tmux state field count: expected 2, received ${fields.length}`)
      }
      return [status, cwd] as const
    }
    let serial = 0
    const sample = async (number: number, feed: string) => {
      const marker = `Q-${nonce}-${serial++}`
      input.write(`\x1b[${number};1H${feed}${marker}`)
      await until(
        () => command("capture-pane", "-p", "-t", targetPane),
        (value) => value.split("\n")[number - 1]?.includes(marker) === true,
        "tmux marker",
      )
      const grid = command("capture-pane", "-p", "-R", "-t", targetPane)
      const line = grid.split("\n").find((value) => new RegExp(`^\\s*L \\d+ \\(${number - 1}\\) flags=`).test(value))
      if (!line || !/flags=[A-Z_|,]+\[[0-9a-f]+\]/.test(line)) {
        throw new Error(`Unreadable tmux diagnostic row${number}`)
      }
      const data = /osc133=(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(line)
      const [status, cwd] = format()
      const flags = ["START_PROMPT", "START_COMMAND", "START_OUTPUT", "END_OUTPUT"].filter((flag) =>
        line.includes(flag),
      )
      if (flags.length && !data) throw new Error("tmux semantic flags have no diagnostic fields")
      const value =
        flags
          .map((flag) => {
            const indices: Record<string, number> = {
              START_PROMPT: 1,
              START_COMMAND: 2,
              START_OUTPUT: 3,
              END_OUTPUT: 4,
            }
            const index = indices[flag]
            if (index === undefined || !data || data[index] === undefined || data[5] === undefined) {
              throw new Error(`tmux diagnostic lacks ${flag} fields`)
            }
            return `${flag}@${data[index]}${flag === "END_OUTPUT" ? `:${data[5]};status=${status}` : ""}`
          })
          .join("|") || "NONE"
      const reading = { value, status, cwd }
      detail.phases.push({ number, feed, marker, line, grid, reading })
      return reading
    }
    input.write("\x1b[2J\x1b[3J\x1b[H")
    const initial = await sample(1, "")
    if (row.reader === "cwd") {
      if (/[\x00-\x1f\x7f]/.test(initial.cwd)) throw new Error("tmux pane_path cannot be restored")
      if (!initial.cwd) {
        detail.phases.push({ note: "tmux's pane_path cannot tell an unset path from an empty one" })
      }
      return await readCwdPhases(initial, sample, async () => {
        input.write(osc(`7;${initial.cwd}`))
        await until(
          () => format()[1],
          (value) => value === initial.cwd,
          "tmux pane_path restoration",
        )
      })
    }
    const unknown = await sample(1, osc("133;Z"))
    const unknownReading = { before: JSON.stringify(initial), after: JSON.stringify(unknown) }
    if (row.reader === "cycle") {
      const beforeCycle = async (start: number) => [
        (await sample(start, "")).value,
        (await sample(start + 1, "")).value,
        (await sample(start + 2, "")).value,
      ]
      const cycle = async (ns: string, start: number, status: number) => [
        (await sample(start, osc(`${ns};A`))).value,
        (await sample(start + 1, osc(`${ns};C`))).value,
        (await sample(start + 2, osc(`${ns};D;${status}`))).value,
      ]
      const handledBefore = await beforeCycle(2)
      const handled = await cycle("133", 2, 0)
      const targetBefore = await beforeCycle(5)
      const target = await cycle(namespace, 5, 17)
      return {
        status: "measured",
        reader: "state",
        runId: input.runId,
        unknown: unknownReading,
        handled: {
          before: JSON.stringify(handledBefore),
          after: JSON.stringify(handled),
          expected: JSON.stringify(["START_PROMPT@0", "START_OUTPUT@0", "END_OUTPUT@0:0;status=0"]),
        },
        target: {
          before: JSON.stringify(targetBefore),
          after: JSON.stringify(target),
          expected: JSON.stringify(["START_PROMPT@0", "START_OUTPUT@0", "END_OUTPUT@0:17;status=17"]),
        },
        detail,
      }
    }
    const flag = { A: "START_PROMPT", B: "START_COMMAND", C: "START_OUTPUT", D: "END_OUTPUT", P: "START_PROMPT" }[
      letter
    ]
    if (!flag) throw new Error(`No tmux semantic fixture for ${input.featureId}`)
    const handledLetter = namespace === "133" && letter !== "D" ? (letter === "A" ? "C" : "A") : letter
    const handledFlag = {
      A: "START_PROMPT",
      B: "START_COMMAND",
      C: "START_OUTPUT",
      D: "END_OUTPUT",
      P: "START_PROMPT",
    }[handledLetter]
    if (!handledFlag) throw new Error(`No tmux semantic control for ${handledLetter}`)
    const handledBefore = await sample(2, "")
    const handled = await sample(2, osc(`133;${handledLetter}${handledLetter === "D" ? ";0" : ""}`))
    const targetBefore = await sample(3, "")
    const target = await sample(3, osc(`${namespace};${letter}${letter === "D" ? ";17" : ""}`))
    return {
      status: "measured",
      reader: "state",
      runId: input.runId,
      unknown: unknownReading,
      handled: {
        before: handledBefore.value,
        after: handled.value,
        expected: `${handledFlag}@0${handledLetter === "D" ? ":0;status=0" : ""}`,
      },
      target: {
        before: targetBefore.value,
        after: target.value,
        expected: `${flag}@0${letter === "D" ? ":17;status=17" : ""}`,
      },
      detail,
    }
  } catch (error) {
    return {
      status: "invalid",
      reason: `App semantic read failed: ${error instanceof Error ? error.message : String(error)}`,
      detail,
    }
  }
}
