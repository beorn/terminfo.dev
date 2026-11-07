import { statSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { AppSemanticReading, ProbeSubject } from "@terminfo/probe-defs"
import { kittyAncestor, type LiveExecutable } from "./linux-capture.ts"

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
  reader?: "grid" | "cycle" | "cwd" | "report"
  command?: { code: string; body: string }
  reportControls?: {
    sentinel: { code: string; body: string; line: string }
    handled: { code: string; body: string; line: string }
    targetLine: string
  }
}

const declarations: readonly AppSemanticCapability[] = [
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
      sentinel: code === "113"
        ? { code: "116", body: "116", line: "resetting dynamic color tektronix_background not implemented" }
        : { code: "113", body: "113", line: "resetting dynamic color pointer_foreground not implemented" },
      handled: { code: "110", body: "110", line: "resetting dynamic color foreground not implemented" },
      targetLine: `resetting dynamic color ${colour} not implemented`,
    },
  })),
  // CTO third-table Ask4: preserve the separately delivered fourteen bus-dependent rows.
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
      requiresMissingSessionBus: true as const,
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
    requiresMissingSessionBus: true as const,
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
  {
    kind: "term",
    id: "kitty",
    version: "0.49.2",
    os: "linux",
    featureId: "extensions.osc3008-context",
    reason:
      "Untestable (no way): Kitty 0.49.2 recognizes OSC 3008 but its context callback stores no state and exposes no readback. Read tag v0.49.2 kitty/vt-parser.c:645-677, kitty/screen.c:3523-3524 and kitty/window.py:1582-1583: dispatch reaches the empty Window.osc_context callback. Generic OSC consumption tracing is not a command-specific rejection or context reading.",
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

/** Owned Linux App/mux read, using only the public actions qualified by #32566. */
export async function readAppSemanticState(input: {
  featureId: string
  write: (text: string) => void
  runId: string
  executable: LiveExecutable
  mux?: "tmux" | "screen"
}): Promise<AppSemanticReading> {
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
    const appId = env.TERMINFO_TARGET_ID
    if (input.mux === "screen" || (!input.mux && appId !== "kitty" && appId !== "ghostty")) {
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
    const until = async (read: () => string, complete: (value: string) => boolean, name: string) => {
      const deadline = Date.now() + 5000
      let last = ""
      do {
        last = read()
        if (complete(last)) return last
        await Bun.sleep(25)
      } while (Date.now() < deadline)
      detail.phases.push({ name, incomplete: last })
      throw new Error(`App semantic reader did not observe ${name} completion`)
    }
    const osc = (body: string) => `\x1b]${body}\x07`
    const nonce = randomUUID().slice(0, 8)
    const mux = input.mux === "tmux"
    let pane: string | undefined
    let tmux: ((...args: string[]) => string) | undefined
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
      if (appId !== "kitty" && appId !== "ghostty") {
        return { status: "unavailable", reason: "No semantic reader for this App", detail }
      }
      const pid = kittyAncestor(input.executable)
      if (appId === "kitty" && String(pid) !== env.KITTY_PID) {
        throw new Error("App semantic reader Kitty PID differs from its owned ancestor")
      }
      const versionText = run([input.executable.path, "--version"])
      const version = (appId === "kitty" ? /^kitty (\S+) created by /m : /^Ghostty (\S+)/m).exec(versionText)?.[1]
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
    const namespace = input.featureId.includes("633") ? "633" : "133"
    const letter = input.featureId.slice(-1).toUpperCase()
    if (row.reader === "report") {
      const controls = row.reportControls
      let title: (() => string) | undefined
      let original: string | undefined
      if (!controls) {
        const windows = run(["xdotool", "search", "--onlyvisible", "--pid", String(env.KITTY_PID)])
          .trim()
          .split(/\s+/)
        const window = windows[0]
        if (windows.length !== 1 || !window || !/^\d+$/.test(window)) {
          throw new Error("App semantic reader has no unique owned Kitty window")
        }
        title = () => run(["xdotool", "getwindowname", window]).trimEnd()
        original = title()
        if (/[\x00-\x1f\x7f]/.test(original)) throw new Error("App semantic reader cannot restore Kitty title")
      }
      const log = join(dirname(capture), "daemon.log")
      const identity = statSync(log)
      let phase = 0
      const readPhase = async (name: string, feed: string) => {
        const before = statSync(log)
        if (before.dev !== identity.dev || before.ino !== identity.ino) throw new Error("Owned App log rotated")
        const offset = before.size
        const sentinel = controls?.sentinel.body ?? `7655;${nonce}-${phase++}`
        const completion = `${controls?.sentinel.line ?? `Unknown OSC escape code: ${sentinel}`}\n`
        const read = () => {
          const now = statSync(log)
          if (now.dev !== identity.dev || now.ino !== identity.ino || now.size < offset) {
            throw new Error("Owned App log changed identity or truncated")
          }
          return readFileSync(log).subarray(offset).toString("utf8")
        }
        input.write(feed + osc(sentinel))
        const appended = await until(read, (value) => value.includes(completion), `${name} OSC ${sentinel}`)
        const end = appended.indexOf(completion) + completion.length
        const bytes = Buffer.from(appended.slice(0, end))
        const path = join(capture, `app-semantic-${nonce}-${name}.log`)
        writeFileSync(path, bytes)
        detail.phases.push({
          name,
          offset,
          endOffset: offset + bytes.length,
          feed,
          sentinel,
          path,
          appended: bytes.toString("utf8"),
        })
        return bytes
          .toString("utf8")
          .split("\n")
          .filter((value) =>
            controls
              ? value.includes("resetting dynamic color ") && !value.endsWith(controls.sentinel.line)
              : value.includes("[PARSE ERROR]") && !value.endsWith(`Unknown OSC escape code: ${sentinel}`),
          )
          .map((value) => {
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
        const unknown = controls ? [] : await readPhase("unknown", osc(`7654;${nonce}`))
        const handled = await readPhase("handled", osc(controls?.handled.body ?? `2;Q-${nonce}`))
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
          unknown: { code: controls?.sentinel.code ?? "7654", reports: controls ? [controls.sentinel.code] : unknown },
          handled: { applied: true, reports: handled },
          target: { code: row.command?.code ?? "633", reports: target },
          detail,
        }
      } finally {
        if (original !== undefined) input.write(osc(`2;${original}`))
      }
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
    const unknown = await sample(1, osc("133;Z"))
    const unknownReading = { before: JSON.stringify(initial), after: JSON.stringify(unknown) }
    if (row.reader === "cwd") {
      if (/[\x00-\x1f\x7f]/.test(initial.cwd)) throw new Error("tmux pane_path cannot be restored")
      if (!initial.cwd) {
        detail.phases.push({ note: "tmux's pane_path cannot tell an unset path from an empty one" })
      }
      const controlPath = `file://localhost/terminfo-control-${nonce}`
      const targetPath = `/terminfo-target-${nonce}`
      try {
        const handled = await sample(2, osc(`7;${controlPath}`))
        const target = await sample(3, osc(`633;P;Cwd=${targetPath}`))
        return {
          status: "measured",
          reader: "state",
          runId: input.runId,
          unknown: unknownReading,
          handled: { before: initial.cwd, after: handled.cwd, expected: controlPath },
          target: { before: handled.cwd, after: target.cwd, expected: targetPath },
          detail,
        }
      } finally {
        input.write(osc(`7;${initial.cwd}`))
        await until(
          () => format()[1],
          (value) => value === initial.cwd,
          "tmux pane_path restoration",
        )
      }
    }
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
