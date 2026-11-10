/**
 * @failure A mux borrows its outer Kitty's log reader, or a missing ownership/run
 *   binding reaches terminal I/O. Probe-layer tests have no attachment identity.
 * @level l2
 * @consumer The owned collector's shared exact-App table and semantic reader.
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import nativeScreen from "./fixtures/screen-sgr-backspace.json"
import { extensionsProbes, type AppSemanticReading } from "@terminfo/probe-defs"
import { replayTermProbeSource } from "../../probe-defs/src/testing/group-harness.ts"
import {
  appSemanticDeclarations,
  beginMuxSgrCommandRead,
  openAppCommandLog,
  readAppSemanticState,
} from "./app-semantic-state.ts"

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }))
vi.mock("./linux-capture.ts", async (original) => ({
  ...(await original<typeof import("./linux-capture.ts")>()),
  kittyAncestor: vi.fn(() => 123),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// Native callback binding tests cannot see the collector's independent controls.
// Model only the three OSC effects and native reads; production builds the result.
test.each(["extensions.osc0-icon-title", "extensions.osc1-icon"])(
  "%s sets title A, sends payload B, and records the icon name that was read",
  async (featureId) => {
    const runId = "a".repeat(32)
    vi.stubEnv("TERMINFO_RUN_ID", runId)
    vi.stubEnv("TERMINFO_MUX_KIND", "")
    vi.stubEnv("TERMINFO_TARGET_ID", "xterm")
    const osc1 = featureId.includes("osc1")
    for (const mode of ["applies-b", "absent", "unchanged", "mirrors-title", "title-becomes-b"] as const) {
      let title = "original title"
      let icon: string | null = "original icon"
      const writes: string[] = []
      const input = {
        featureId,
        runId,
        executable: { path: "/unused", sha256: "b".repeat(64) },
        readTitle: async () => title,
        withIconNameFixture: async (
          _write: (s: string) => void,
          work: (read: () => Promise<string | null>) => Promise<AppSemanticReading>,
        ) => work(async () => icon),
        write(bytes: string) {
          writes.push(bytes)
          const match = /^\x1b\](0|1|2);([^\x07]*)\x07$/.exec(bytes)
          if (!match) return
          const code = match[1]
          const payload = match[2]
          if (!code || payload === undefined) throw Error("invalid OSC fixture")
          if (code === "2") {
            title = payload
            return
          }
          if (mode === "unchanged" || mode === "absent") {
            if (mode === "absent") icon = null
            return
          }
          if (mode === "title-becomes-b") {
            title = payload
            icon = payload
            return
          }
          if (mode === "mirrors-title") {
            title = payload
            icon = `${payload}-mirrored`
            return
          }
          icon = payload
        },
      }
      const reading = await readAppSemanticState(input)
      expect(reading.status).toBe("measured")
      if (reading.status !== "measured" || reading.reader !== "state") throw Error("icon reading")
      const { gradeIconNameReading } = await import("../../probe-defs/src/app-semantic-state.ts")
      const result = gradeIconNameReading(featureId, reading)
      const supported =
        mode === "applies-b" || (mode === "mirrors-title" && !osc1) || (mode === "title-becomes-b" && !osc1)
      expect(result.observation).toMatchObject({ outcome: supported ? "supported" : "unsupported" })
      expect(writes.some((line) => line.startsWith("\x1b]2;icon-title-a-"))).toBe(true)
      expect(writes.some((line) => line.startsWith(osc1 ? "\x1b]1;icon-name-b-" : "\x1b]0;icon-name-b-"))).toBe(true)
    }
  },
)

test("Screen never borrows the outer Kitty reader and mismatched attachments are invalid", async () => {
  const runId = "a".repeat(32)
  vi.stubEnv("TERMINFO_RUN_ID", runId)
  vi.stubEnv("TERMINFO_MUX_KIND", "screen")
  vi.stubEnv("TERMINFO_TARGET_ID", "kitty")
  vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", undefined)
  const write = vi.fn()
  const request = {
    featureId: "extensions.osc633-a",
    write,
    runId,
    executable: { path: "/unused", sha256: "b".repeat(64) },
  }
  expect(await readAppSemanticState({ ...request, mux: "screen" })).toMatchObject({ status: "unavailable" })
  expect(await readAppSemanticState(request)).toMatchObject({
    status: "invalid",
    reason: expect.stringContaining("attachment"),
  })
  expect(write).not.toHaveBeenCalled()
})

test("reader capability rows do not become declarations or lend their identity to another version", () => {
  const kitty = { kind: "term" as const, id: "kitty", version: "0.49.2", os: "linux" }
  expect(Object.keys(appSemanticDeclarations(kitty)).sort()).toEqual([
    "extensions.osc133-a",
    "extensions.osc133-b",
    "extensions.osc133-c",
    "extensions.osc133-d",
    "extensions.osc133-p",
    "extensions.osc3008-context",
    "extensions.semantic-prompts",
  ])
  expect(appSemanticDeclarations({ ...kitty, version: "unreviewed" })).toEqual({})
  const tmux = { kind: "mux" as const, id: "tmux", version: "3.8", os: "linux" }
  const tmuxDeclared = appSemanticDeclarations(tmux)
  expect(Object.keys(tmuxDeclared).sort()).toEqual([
    "extensions.osc0-icon-title",
    "extensions.osc1-icon",
    "extensions.osc176-app-id",
    "extensions.osc3008-context",
    "extensions.osc440-audio",
    "extensions.osc633-e",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
  ])
  expect(tmuxDeclared["extensions.osc0-icon-title"]).toMatch(/multiplexer has no icon name/)
  expect(tmuxDeclared["extensions.osc1-icon"]).toMatch(/multiplexer has no icon name/)
  for (const [featureId, code] of [
    ["extensions.osc176-app-id", "176"],
    ["extensions.osc3008-context", "3008"],
    ["extensions.osc440-audio", "440"],
    ["extensions.osc666-termprop", "666"],
    ["extensions.osc710-font-normal", "710"],
  ] as const) {
    expect(tmuxDeclared[featureId]).toMatch(
      new RegExp(
        `^Untestable \\(no way\\): tmux 3\\.8 has no OSC ${code} handler.*Read from source, not measured\\..*input\\.c:2775-2777`,
      ),
    )
  }
  for (const subject of [
    { ...tmux, version: "3.7c" },
    { ...tmux, os: "darwin" },
    { ...tmux, kind: "term" as const },
  ]) {
    expect(appSemanticDeclarations(subject)).toEqual({})
  }
  const alacritty = { kind: "term" as const, id: "alacritty", version: "0.17.0", os: "linux" }
  const alacrittyDeclared = appSemanticDeclarations(alacritty)
  expect(alacrittyDeclared["extensions.osc710-font-normal"]).toMatch(
    /^Untestable \(no way\): Alacritty 0\.17\.0's locked VTE 0\.15\.0 OSC parser has no OSC 710 font-selection handler\./,
  )
  for (const [featureId, code] of [
    ["extensions.osc176-app-id", "176"],
    ["extensions.osc3008-context", "3008"],
    ["extensions.osc440-audio", "440"],
    ["extensions.osc666-termprop", "666"],
  ] as const) {
    expect(alacrittyDeclared[featureId]).toMatch(
      new RegExp(
        `^Untestable \\(no way\\): Alacritty 0\\.17\\.0 does not implement OSC ${code}.*Read from source, not measured\\..*ansi\\.rs:1329-1525.*alacritty-escapes\\.7\\.scd:215-255`,
      ),
    )
  }
  for (const subject of [
    { ...alacritty, version: "0.18.0" },
    { ...alacritty, os: "darwin" },
    { ...alacritty, kind: "mux" as const },
  ]) {
    expect(appSemanticDeclarations(subject)).toEqual({})
  }
  const screen = { kind: "mux" as const, id: "screen", version: "5.0.2", os: "linux" }
  const screenDeclared = appSemanticDeclarations(screen)
  expect(screenDeclared["modes.color-scheme-reporting"]).toMatch(/Untestable \(no way\):.*2031/)
  expect(screenDeclared["extensions.osc0-icon-title"]).toMatch(/multiplexer has no icon name/)
  expect(screenDeclared["extensions.osc1-icon"]).toMatch(/multiplexer has no icon name/)
  for (const subject of [
    { ...screen, version: "5.0.3" },
    { ...screen, os: "darwin" },
    { ...screen, kind: "term" as const },
  ]) {
    expect(appSemanticDeclarations(subject)).not.toHaveProperty("modes.color-scheme-reporting")
  }
})

// Existing Kitty coverage cannot detect Ghostty's silently dropped unknown OSC,
// and highlight-only cases cannot catch missing pointer rows or OSC113 guarding itself.
// These exact source-format bytes exercise the shared reader, its row window and controls.
test.each([
  ["117", "highlight", "background", "113", "pointer_foreground"],
  ["119", "highlight", "foreground", "113", "pointer_foreground"],
  ["113", "pointer", "foreground", "116", "tektronix_background"],
  ["114", "pointer", "background", "113", "pointer_foreground"],
] as const)(
  "Ghostty OSC %s reads only its reset warning behind an independent logged control",
  async (code, family, slot, sentinel, sentinelSlot) => {
    const root = mkdtempSync(join(tmpdir(), "app-semantic-ghostty-"))
    const capture = join(root, "capture")
    mkdirSync(capture)
    const log = join(root, "daemon.log")
    const line = (name: string) => `warning(stream): resetting dynamic color ${name} not implemented\n`
    const featureId = `extensions.osc${code}-reset-${family}-${slot === "background" ? "bg" : "fg"}`
    vi.stubEnv("TERMINFO_RUN_ID", "a".repeat(32))
    vi.stubEnv("TERMINFO_MUX_KIND", undefined)
    vi.stubEnv("TERMINFO_TARGET_ID", "ghostty")
    vi.stubEnv("TERMINFO_TARGET_VERSION", "1.4.0")
    vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", capture)
    vi.mocked(execFileSync).mockReturnValue("Ghostty 1.4.0\n")
    try {
      for (const variant of [
        "exact",
        "query-only",
        "handled-refusal",
        "late-handled-refusal",
        "missing-sentinel",
      ] as const) {
        // A stale matching line before this row must never become its target report.
        writeFileSync(log, line(`${family}_${slot}`))
        const writes: string[] = []
        const clock =
          variant === "missing-sentinel"
            ? vi
                .spyOn(Date, "now")
                .mockImplementationOnce(() => 0)
                .mockImplementation(() => 6001)
            : undefined
        const result = await readAppSemanticState({
          featureId,
          runId: "a".repeat(32),
          executable: { path: "/owned/ghostty", sha256: "b".repeat(64) },
          write: (bytes) => {
            writes.push(bytes)
            if (bytes.includes("\x1b]110\x07") && variant === "handled-refusal") appendFileSync(log, line("foreground"))
            if (bytes.includes(`\x1b]${code}\x07`)) {
              if (variant === "late-handled-refusal") appendFileSync(log, line("foreground"))
              appendFileSync(
                log,
                variant === "exact"
                  ? line(`${family}_${slot}`)
                  : `info(stream): reporting dynamic color ${family}_${slot} not implemented\n`,
              )
            }
            if (bytes.includes(`\x1b]${sentinel}\x07`) && variant !== "missing-sentinel") {
              appendFileSync(log, line(sentinelSlot))
            }
          },
        })
        clock?.mockRestore()
        if (variant === "handled-refusal" || variant === "late-handled-refusal" || variant === "missing-sentinel") {
          expect(result).toMatchObject({
            status: "invalid",
            reason: expect.stringContaining(variant === "missing-sentinel" ? sentinel : "110"),
          })
        } else {
          expect(result).toMatchObject({
            status: "measured",
            reader: "report",
            unknown: { code: sentinel, reports: [sentinel] },
            handled: { applied: true, reports: [] },
            target: { code, reports: variant === "exact" ? [code] : [] },
          })
        }
        expect(writes.join("")).toContain("\x1b]110\x07")
        if (variant === "exact" || variant === "query-only") {
          expect(writes.join("")).toContain(`\x1b]${code}\x07\x1b]${sentinel}\x07`)
        }
        expect(writes.join("")).not.toContain("7654")
      }
    } finally {
      rmSync(root, { recursive: true })
    }
  },
)

// WezTerm's seven OSC633 rows share a code, so only the exact payload warning
// distinguishes a row from its sibling. Keep each row's controls independent.
test.each(
  (
    [
      ["kitty", "0.49.2", "extensions.osc176-app-id", "176", "176;terminfo-test"],
      ["kitty", "0.49.2", "extensions.osc710-font-normal", "710", "710;monospace"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc555-flash", "555", "555"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc710-font-normal", "710", "710;fixed"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc176-app-id", "176", "176;terminfo-test"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc3008-context", "3008", "3008;type=test"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc440-audio", "440", "440;bell.wav"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc666-termprop", "666", "666;test-prop=value"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc633-a", "633", "633;A"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc633-b", "633", "633;B"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc633-c", "633", "633;C"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc633-d", "633", "633;D;0"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc633-e", "633", "633;E;ls -la;nonce123"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc633-p", "633", "633;P;Cwd=/tmp"],
      ["wezterm", "0-unstable-2026-10-10", "extensions.osc-633-vscode", "633", "633;A"],
    ] as const
  ).flatMap(([app, version, featureId, code, targetBody]) =>
    (code === "633"
      ? (["exact", "sibling-row"] as const)
      : app === "wezterm"
        ? ([
            "exact",
            "silent-target",
            "silent-unknown",
            "handled-refusal",
            "wrong-payload",
            "missing-sentinel",
            "missing-digest",
            "wrong-digest",
            "missing-flag",
            "restore-failure",
            "wrong-version",
            "missing-cli",
          ] as const)
        : (["exact"] as const)
    ).map((variant) => ({ app, version, featureId, code, targetBody, variant })),
  ),
)(
  "$app $featureId $variant keeps fresh log controls and restores its title",
  async ({ app, version, featureId, code, targetBody, variant }) => {
    const root = mkdtempSync(join(tmpdir(), "app-semantic-kitty-"))
    const capture = join(root, "capture")
    mkdirSync(capture)
    const log = join(root, "daemon.log")
    writeFileSync(log, "")
    vi.stubEnv("TERMINFO_RUN_ID", "a".repeat(32))
    vi.stubEnv("TERMINFO_MUX_KIND", undefined)
    vi.stubEnv("TERMINFO_TARGET_ID", app)
    vi.stubEnv("TERMINFO_TARGET_VERSION", version)
    vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", capture)
    vi.stubEnv("KITTY_PID", "123")
    const executable = app === "kitty" ? "/owned/kitty" : "/owned/wezterm-gui"
    const line = (body: string) =>
      app === "kitty"
        ? `[PARSE ERROR] Unknown OSC escape code: ${body}\n`
        : `14:01:40.193  WARN   wezterm_term::terminalstate::performer > Unhandled OSC  ${body.replaceAll(";", " ")}\n`
    // Only the newly appended target window counts, never this older matching warning.
    writeFileSync(log, line(targetBody))
    if (app === "wezterm") {
      writeFileSync(join(root, "owner-executable.sha256"), `${"b".repeat(64)}  ${executable}\n`)
      writeFileSync(
        join(root, "target-config.txt"),
        "nice -n 10 /owned/wezterm --config log_unknown_escape_sequences=true start -- collector\n",
      )
    }
    if (variant === "missing-digest") rmSync(join(root, "owner-executable.sha256"))
    if (variant === "wrong-digest") {
      writeFileSync(join(root, "owner-executable.sha256"), `${"c".repeat(64)}  ${executable}\n`)
    }
    if (variant === "missing-flag") {
      writeFileSync(join(root, "target-config.txt"), "nice -n 10 /owned/wezterm start -- collector\n")
    }
    let tick = 0
    if (variant === "missing-sentinel" || variant === "restore-failure") {
      vi.spyOn(Date, "now").mockImplementation(() => (tick += 6000))
    }
    let title = "original title"
    vi.mocked(execFileSync).mockImplementation((file, args) => {
      // The owned GUI reports this placeholder before its bootstrap; its same-output
      // sibling CLI reports the build version. One mock for both hid the native failure.
      if (file === executable) {
        return app === "kitty"
          ? "kitty 0.49.2 created by Kovid Goyal\n"
          : "wezterm-gui someone forgot to call assign_version_info\n"
      }
      if (app === "wezterm" && file === "/owned/wezterm") {
        if (variant === "missing-cli") throw new Error("ENOENT: /owned/wezterm")
        return `wezterm ${variant === "wrong-version" ? "different" : version}\n`
      }
      return Array.isArray(args) && args[0] === "search" ? "123\n" : title
    })
    const writes: string[] = []
    try {
      const result = await readAppSemanticState({
        featureId,
        runId: "a".repeat(32),
        executable: { path: executable, sha256: "b".repeat(64) },
        write: (bytes) => {
          writes.push(bytes)
          for (const match of bytes.matchAll(/\x1b\]([^\x07]*)\x07/g)) {
            const body = match[1]!
            if (body.startsWith("2;")) {
              if (variant !== "restore-failure" || body !== "2;original title") title = body.slice(2)
              if (variant === "handled-refusal") appendFileSync(log, line(body))
            } else if (
              !(variant === "silent-target" && body === targetBody) &&
              !(variant === "silent-unknown" && body.startsWith("7654;")) &&
              !(variant === "missing-sentinel" && body.startsWith("7655;"))
            ) {
              const reportedBody =
                variant === "sibling-row" && body === targetBody
                  ? targetBody === "633;A"
                    ? "633;B"
                    : "633;A"
                  : variant === "wrong-payload" && body === targetBody
                    ? `${code};wrong`
                    : body
              appendFileSync(log, line(reportedBody))
            }
          }
        },
      })
      if (app === "wezterm") {
        expect(result).toMatchObject({
          detail: {
            commands: expect.not.arrayContaining([expect.objectContaining({ argv: [executable, "--version"] })]),
          },
        })
        if (variant === "missing-cli") {
          expect(result).toMatchObject({ status: "invalid", reason: expect.stringContaining("ENOENT") })
          expect(writes).toEqual([])
          return
        }
        expect(result).toHaveProperty("detail.commands.0", {
          argv: ["/owned/wezterm", "--version"],
          stdout: `wezterm ${variant === "wrong-version" ? "different" : version}\n`,
        })
        if (variant === "wrong-version") {
          expect(result).toMatchObject({ status: "invalid", reason: expect.stringContaining("version differs") })
          expect(writes).toEqual([])
          return
        }
      }
      if (
        [
          "handled-refusal",
          "wrong-payload",
          "sibling-row",
          "missing-sentinel",
          "missing-digest",
          "wrong-digest",
          "missing-flag",
          "restore-failure",
        ].includes(variant)
      ) {
        expect(result).toMatchObject({ status: "invalid" })
        if (variant === "sibling-row") expect(result).toHaveProperty("reason", expect.stringContaining("Unrecognized"))
        if (variant !== "restore-failure") expect(title).toBe("original title")
        if (variant === "missing-digest" || variant === "wrong-digest" || variant === "missing-flag") {
          expect(writes).toEqual([])
        }
        return
      }
      expect(result).toMatchObject({
        status: "measured",
        reader: "report",
        unknown: { code: "7654", reports: variant === "silent-unknown" ? [] : ["7654"] },
        handled: { applied: true, reports: [] },
        target: { code, reports: variant === "silent-target" ? [] : [code] },
      })
      const sentinels = writes.flatMap((bytes) => [...bytes.matchAll(/7655;([^\x07]+)/g)].map((match) => match[1]))
      expect(new Set(sentinels).size).toBe(3)
      expect(writes.join("")).toContain(`\x1b]${targetBody}\x07`)
      expect(title).toBe("original title")
    } finally {
      rmSync(root, { recursive: true })
    }
  },
)

// A reviewed 710 reader must not lend its identity to another version or App.
test.each([
  ["kitty", "unreviewed", "kitty unreviewed created by Kovid Goyal\n"],
  ["ghostty", "1.4.0", "Ghostty 1.4.0\n"],
  ["alacritty", "0.17.0", "alacritty 0.17.0\n"],
  ["xterm", "411", "XTerm(411)\n"],
  ["wezterm", "unreviewed", "wezterm unreviewed\n"],
] as const)("%s %s keeps its previous OSC710 result", async (app, version, versionText) => {
  vi.stubEnv("TERMINFO_RUN_ID", "a".repeat(32))
  vi.stubEnv("TERMINFO_MUX_KIND", undefined)
  vi.stubEnv("TERMINFO_TARGET_ID", app)
  vi.stubEnv("TERMINFO_TARGET_VERSION", version)
  vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", "/owned/artifacts")
  vi.stubEnv("KITTY_PID", "123")
  vi.mocked(execFileSync).mockReturnValue(versionText)
  const definition = extensionsProbes.find((probe) => probe.id === "extensions.osc710-font-normal")!
  const source = replayTermProbeSource(new Map())
  const previous = await definition.term!(source)
  let status: string | undefined
  source.readAppSemanticState = async (featureId, write) => {
    const reading = await readAppSemanticState({
      featureId,
      write,
      runId: "a".repeat(32),
      executable: { path: `/owned/${app}`, sha256: "b".repeat(64) },
    })
    status = reading.status
    return reading
  }
  expect(await definition.term!(source)).toEqual(previous)
  expect(status).toBe("unavailable")
})

// The existing OSC reader and mux command reader must cite only their own completed phase.
// An old handled command must never qualify a later negative.
test("owned command phases retain fresh completed bytes and refuse changed file custody", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-command-log-"))
  const capture = join(directory, "artifacts")
  const path = join(directory, "daemon.log")
  mkdirSync(capture)
  try {
    writeFileSync(path, "old handled command\nold completion\n")
    const log = openAppCommandLog(capture)
    const offset = log.mark()
    appendFileSync(path, "new phase\nnew completion\nnot this phase\n")
    const phase = await log.read(offset, "phase.log", (text) => {
      const end = text.indexOf("new completion\n")
      return end < 0 ? undefined : end + "new completion\n".length
    })
    expect(phase.text).toBe("new phase\nnew completion\n")
    expect(phase.offset).toBe(offset)
    expect(phase.endOffset).toBe(offset + Buffer.byteLength(phase.text))
    expect(readFileSync(phase.path, "utf8")).toBe(phase.text)

    writeFileSync(path, "short\n")
    await expect(log.read(offset, "truncated.log", () => 1)).rejects.toThrow(/truncated/)
    renameSync(path, join(directory, "old.log"))
    writeFileSync(path, "replacement log\n")
    expect(() => log.mark()).toThrow(/rotated/)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

// Protocol fixtures project native run adebe1dc lines 3028..3097 and its first four phases.
// Opaque invocation nonces are added to the existing paint witnesses; these are not new App readings.
const nativeMuxCommands = readFileSync(new URL("./fixtures/kitty-mux-sgr.txt", import.meta.url), "utf8")
const nativeMuxTrace = readFileSync(new URL("./fixtures/kitty-mux-sgr.trace.json", import.meta.url), "utf8")

test.each([
  ["forwarded", nativeMuxCommands, true, undefined],
  // Screen 5.0.2 clears then backspaces before the exact retained nonce witness.
  [
    "Screen backspace before witness",
    nativeScreen.commands,
    false,
    undefined,
    "sgr.hidden",
    nativeScreen.callLog,
    "screen",
  ],
  [
    "buffered previous callback",
    nativeMuxCommands
      .replaceAll("0123456789abcdef01234567", "fedcba9876543210fedcba98")
      .replace("select_graphic_rendition 4:3\n", "select_graphic_rendition 1\n") + nativeMuxCommands,
    true,
    undefined,
  ],
  ["dropped", nativeMuxCommands.replace("select_graphic_rendition 4:3\n", ""), false, undefined],
  // RGB/indexed colour payloads cannot impersonate the target attribute.
  // Existing standalone attribute reports never exercise grouped SGR parameters.
  [
    "RGB payload is not bold",
    nativeMuxCommands.replace("select_graphic_rendition 4:3\n", "select_graphic_rendition 38;2;1;0;0\n"),
    undefined,
    /Extended-colour outer SGR/,
    "sgr.bold",
  ],
  [
    "indexed colour payload is not overline",
    nativeMuxCommands.replace("select_graphic_rendition 4:3\n", "select_graphic_rendition 38;5;53\n"),
    undefined,
    /Extended-colour outer SGR/,
    "sgr.overline",
  ],
  [
    "unreadable",
    nativeMuxCommands.replace("select_graphic_rendition 4:3\n", "select_graphic_rendition unreadable\n"),
    undefined,
    /Unrecognized outer SGR/,
  ],
  ["blind control", nativeMuxCommands.replace("select_graphic_rendition 7\n", ""), undefined, /handled control/],
  ["unfinished", nativeMuxCommands.slice(0, nativeMuxCommands.lastIndexOf("draw 3\n")), undefined, /completion/],
] as const)(
  "mux command read: %s",
  async (
    _name,
    commands,
    forwarded,
    refusal,
    featureId: string = "sgr.underline.curly",
    trace: string = nativeMuxTrace,
    mux: "tmux" | "screen" = "tmux",
  ) => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-mux-sgr-"))
    const capture = join(directory, "artifacts")
    const path = join(directory, "daemon.log")
    mkdirSync(capture)
    try {
      // An earlier complete run cannot supply this callback's target or handled control.
      writeFileSync(path, nativeMuxCommands)
      const runId = "a".repeat(32)
      vi.stubEnv("TERMINFO_RUN_ID", runId)
      vi.stubEnv("TERMINFO_MUX_KIND", mux)
      vi.stubEnv("TERMINFO_TARGET_ID", "kitty")
      vi.stubEnv("TERMINFO_TARGET_VERSION", "0.49.2")
      vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", capture)
      const reader = beginMuxSgrCommandRead({
        featureId,
        subject: {
          kind: "mux",
          id: mux,
          version: mux === "tmux" ? "3.8" : "5.0.2",
          os: "linux",
          outerTerminal: "kitty",
        },
        proof: {
          platform: "linux",
          mux,
          launchRunId: runId,
          collector: { pid: process.pid, startTicks: "1", ttyRdev: 1 },
        },
      })
      expect(reader.status).toBe("ready")
      if (reader.status !== "ready") throw new Error(reader.reason)
      appendFileSync(path, commands)
      const target =
        featureId === "sgr.bold" ? "1" : featureId === "sgr.overline" ? "53" : featureId === "sgr.hidden" ? "8" : "4:3"
      const result = await reader.read(trace.replaceAll("[4:3m", `[${target}m`))
      if (refusal) {
        expect(result.status).toBe("unavailable")
        if (result.status === "unavailable") expect(result.reason).toMatch(refusal)
      } else {
        expect(result).toMatchObject({ status: "measured", targetSent: forwarded, target })
      }
      expect(result.detail.offset).toBe(Buffer.byteLength(nativeMuxCommands))
    } finally {
      rmSync(directory, { recursive: true })
    }
  },
  20_000,
)

test("Ghostty 1.4.0 declares extensions.osc3008-context untestable with the audited source-and-binary reason", async () => {
  const definition = extensionsProbes.find((probe) => probe.id === "extensions.osc3008-context")!
  const fallback = await definition.term!(
    replayTermProbeSource(new Map(), { queryCursorPosition: async () => ({ row: 0, col: 0 }) }),
  )
  expect(fallback.note).toBe("Cursor response does not measure OSC 3008 systemd context")

  const declared = appSemanticDeclarations({ kind: "term", id: "ghostty", version: "1.4.0", os: "linux" })
  expect(declared["extensions.osc3008-context"]).toBe(
    "Untestable (no way): Ghostty 1.4.0 parses OSC 3008 but keeps no context state and exposes no readback. In ghostty-xpli4r8n1mqrzhbgxmkj4jfbpsjsqm3m-derived-source-tar (SHA256 d692bb9b), osc.zig:1170 sends 3008 to parsers.hierarchical_context.parse, which validates the uapi start=<id>/end=<id> form and warns at hierarchical_context.zig:274; the parsed command then reaches stream.zig:2968, which lists .hierarchical_context among unimplemented OSC callbacks and only runs log.debug at :2970 (absent from the shipped binary: strings finds 0), a level main_ghostty.zig:203-211 pins off in every non-debug build. No context stack, environment, reply or public readback exists in src. A spec-valid payload leaves no observable trace, and the parser warning a malformed payload produces is payload validation, not a command-specific refusal.",
  )
})

test("xterm 411 declares extensions.clipboard-paste untestable naming the unbuilt Shift+Insert PRIMARY route", () => {
  const declared = appSemanticDeclarations({ kind: "term", id: "xterm", version: "411", os: "linux" })
  expect(declared["extensions.clipboard-paste"]).toMatch(
    /^Untestable \(unbuilt Shift\+Insert\/PRIMARY route\): default xterm 411 has no Ctrl\+Shift\+V or CLIPBOARD paste binding, and its own default paste route \(Shift\+Insert or Button2 from X11 PRIMARY\) is not built in this probe\..*charproc\.c:15021-15061.*xterm\.man:5452,5481/,
  )
  expect(appSemanticDeclarations({ kind: "term", id: "xterm", version: "412", os: "linux" })).toEqual({})
})

test("remaining 19 Linux App semantic-prompt rows declare exact-version Untestable with source citations and routes not taken (#32947)", () => {
  const ghostty = appSemanticDeclarations({ kind: "term", id: "ghostty", version: "1.4.0", os: "linux" })
  for (const id of [
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc-633-vscode",
  ] as const) {
    expect(ghostty[id]).toMatch(/^Untestable \(no way\): Ghostty 1\.4\.0 has no OSC 633 parser/)
    expect(ghostty[id]).toContain("osc.zig:455-505")
  }
  for (const id of [
    "extensions.osc133-a",
    "extensions.osc133-b",
    "extensions.osc133-c",
    "extensions.osc133-p",
  ] as const) {
    expect(ghostty[id]).toMatch(/^Untestable \(no way\): Ghostty 1\.4\.0 parses OSC 133/)
    expect(ghostty[id]).toContain("semantic_prompt.zig:23-32")
    expect(ghostty[id]).toContain("jump_to_prompt")
  }

  const kitty = appSemanticDeclarations({ kind: "term", id: "kitty", version: "0.49.2", os: "linux" })
  expect(kitty["extensions.osc133-p"]).toMatch(/^Untestable \(no way\): Kitty 0\.49\.2 has no OSC 133 P arm/)
  expect(kitty["extensions.osc133-p"]).toContain("screen.c:3589-3612")
  for (const id of [
    "extensions.osc133-a",
    "extensions.osc133-c",
    "extensions.osc133-d",
    "extensions.semantic-prompts",
  ] as const) {
    expect(kitty[id]).toMatch(/^Untestable \(no setup\): Kitty 0\.49\.2 parses OSC 133/)
    expect(kitty[id]).toContain("kitten @")
    expect(kitty[id]).toContain("#32955")
  }

  const wezterm = appSemanticDeclarations({
    kind: "term",
    id: "wezterm",
    version: "0-unstable-2026-10-10",
    os: "linux",
  })
  for (const id of [
    "extensions.osc133-a",
    "extensions.osc133-b",
    "extensions.osc133-c",
    "extensions.osc133-p",
  ] as const) {
    expect(wezterm[id]).toMatch(/^Untestable \(no way\): WezTerm 0-unstable-2026-10-10 parses OSC 133/)
    expect(wezterm[id]).toContain("get_semantic_zones")
    expect(wezterm[id]).toContain("user-var-changed")
  }

  const tmux = appSemanticDeclarations({ kind: "mux", id: "tmux", version: "3.8", os: "linux" })
  expect(tmux["extensions.osc633-e"]).toMatch(/^Untestable \(no way\): tmux 3\.8 has no OSC 633 handler/)
  expect(tmux["extensions.osc633-e"]).toContain("input.c:2699-2777")
})
