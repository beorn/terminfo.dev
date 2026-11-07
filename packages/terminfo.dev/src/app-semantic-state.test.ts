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
  expect(Object.keys(appSemanticDeclarations(kitty))).toEqual(["extensions.osc133-b", "extensions.osc3008-context"])
  expect(appSemanticDeclarations({ ...kitty, version: "unreviewed" })).toEqual({})
  expect(appSemanticDeclarations({ kind: "mux", id: "tmux", version: "3.8", os: "linux" })).toEqual({})
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

// The real WezTerm warnings qualify only these two cells; Kitty's log grammar
// cannot catch a lost WezTerm route, wrong 710 payload or borrowed old warning.
test.each([
  ["kitty", "0.49.2", "extensions.osc176-app-id", "176", "176;terminfo-test"],
  ["wezterm", "0-unstable-2026-10-10", "extensions.osc555-flash", "555", "555"],
  ["wezterm", "0-unstable-2026-10-10", "extensions.osc710-font-normal", "710", "710;fixed"],
] as const)(
  "%s %s %s keeps fresh log controls and restores its title",
  async (app, version, featureId, code, targetBody) => {
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
    if (app === "wezterm") writeFileSync(join(root, "owner-executable.sha256"), `${"b".repeat(64)}  ${executable}\n`)
    let title = "original title"
    vi.mocked(execFileSync).mockImplementation((file, args) => {
      if (file === executable) return app === "kitty" ? "kitty 0.49.2 created by Kovid Goyal\n" : `wezterm ${version}\n`
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
            if (body.startsWith("2;")) title = body.slice(2)
            else appendFileSync(log, line(body))
          }
        },
      })
      expect(result).toMatchObject({
        status: "measured",
        reader: "report",
        unknown: { code: "7654", reports: ["7654"] },
        handled: { applied: true, reports: [] },
        target: { code, reports: [code] },
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
