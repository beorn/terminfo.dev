import { statSync } from "node:fs"
import { join } from "node:path"
import type { ProbeSubject } from "@terminfo/probe-defs"

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

const declarations = [
  // CTO third-table Ask4: these fourteen App positions need this run's bus absence.
  ...[
    { kind: "term", id: "kitty", version: "0.49.2" },
    { kind: "term", id: "ghostty", version: "1.4.0" },
    { kind: "term", id: "wezterm", version: "0-unstable-2026-10-10" },
    { kind: "term", id: "alacritty", version: "0.17.0" },
    { kind: "term", id: "xterm", version: "411" },
    { kind: "mux", id: "screen", version: "5.0.2" },
    { kind: "mux", id: "tmux", version: "3.8" },
  ].flatMap((subject) =>
    ["extensions.notifications", "extensions.osc777-notify"].map((featureId) => ({
      ...subject,
      os: "linux",
      featureId,
      requiresMissingSessionBus: true,
      reason: `Untestable (no setup): ${subject.id} ${subject.version} desktop notification delivery requires a session bus.`,
    })),
  ),
  ...promptFeatures.map((featureId) => ({
    kind: "term",
    id: "xterm",
    version: "411",
    os: "linux",
    featureId,
    reason:
      "Untestable (no way): xterm 411 has no prompt-mark store or public prompt action for OSC 133/633. Read ctlseqs.txt:2008 onward, misc.c:4353-4354 (TRACE-only unknown-OSC arm), and xterm.man in xterm-411.tgz (SHA256 969be283).",
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
  ...["extensions.osc133-d", "extensions.semantic-prompts"].map((featureId) => ({
    kind: "term",
    id: "wezterm",
    version: "0-unstable-2026-10-10",
    os: "linux",
    featureId,
    reason:
      "Untestable (no way): WezTerm 0-unstable-2026-10-10 exposes semantic zones but no command-exit status, so it cannot observe OSC 133 D or the complete A/C/D cycle. Read e2a98e1b8af1 term/src/terminalstate/performer.rs:904-906 (empty CommandStatus arm), term/src/lib.rs:117-123 and public pane semantic-zone documentation.",
  })),
  ...["extensions.osc633-e", "extensions.osc633-p"].map((featureId) => ({
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId,
    reason:
      "Untestable (no way): Ghostty 1.4.0 has no OSC 633 parser or corresponding stored command-line/Cwd reader. Read tag v1.4.0 src/terminal/osc.zig:485 and src/input/Binding.zig; opening a new tab is not this probe's Cwd reader.",
  })),
  ...["extensions.osc133-d", "extensions.semantic-prompts"].map((featureId) => ({
    kind: "term",
    id: "ghostty",
    version: "1.4.0",
    os: "linux",
    featureId,
    requiresMissingSessionBus: true,
    reason:
      "Untestable (no setup): Ghostty 1.4.0 exposes the end mark, but the exit number reaches a desktop notification. Read tag v1.4.0 src/terminal/Terminal.zig:2266-2271 and src/apprt/gtk/class/surface.zig:1204-1218. A mark alone cannot observe D or the complete A/C/D cycle.",
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
    version: "411",
    os: "linux",
    featureId: "extensions.osc666-termprop",
    reason:
      "Untestable (no way): xterm 411 has no OSC 666 terminal-property handler or public property readback. Read misc.c:3480-3502,4353-4355 in xterm-411.tgz (SHA256 969be283); the unknown-OSC arm only traces an unnamed rejection and stores no property.",
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
    version: "411",
    os: "linux",
    featureId: "extensions.osc176-app-id",
    reason:
      "Untestable (no way): xterm 411 has no OSC 176 application-id handler or target-state readback. Read misc.c do_osc and its default at 4353-4358 in xterm-411.tgz (SHA256 969be283); the target stores no application-id and returns no response. The conditional rejection trace names no command, so it supplies no target report.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "411",
    os: "linux",
    featureId: "extensions.osc440-audio",
    reason:
      "Untestable (no way): xterm 411 has no OSC 440 audio handler or playback readback. Read misc.c do_osc and its default at 4353-4358 in xterm-411.tgz (SHA256 969be283); the target starts no audio action and returns no response. The conditional rejection trace names no command, so it supplies no target report.",
  },
  {
    kind: "term",
    id: "xterm",
    version: "411",
    os: "linux",
    featureId: "extensions.osc3008-context",
    reason:
      "Untestable (no way): xterm 411 has no OSC 3008 context handler or public context readback. Read misc.c do_osc and its default at 4353-4358 in xterm-411.tgz (SHA256 969be283); the target stores no context tag and returns no response. The conditional rejection trace names no command, so it supplies no target report.",
  },
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
        (row) =>
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
