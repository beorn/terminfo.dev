/**
 * @failure The OSC 22 multiplexer arm is graded without the outer terminal's command record: the one
 *   outer reader cannot match its forwarding control, drops a record line it does not know, or reads a
 *   missing control as an empty phase instead of a named failure (@cto 1818f9ec, #32593).
 * @level l2
 * @consumer The owned collector's outer command reader and the osc22-pointer multiplexer arm.
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCallLog, withCallLog } from "viprobe"
import { extensionsProbes, type TermProbeSource } from "@terminfo/probe-defs"
import { beginMuxSgrCommandRead, hasOuterCommandMatcher } from "./app-semantic-state.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

// Bare Kitty 0.49.2 --dump-commands capture, copied verbatim from
// /hh/var/@dev16/32593/kitty-dump/record.txt (sha256 a432e932819c98bfd7f5b41e0f76358f145a07a80691cbaa4bb8cb8c9355b49c).
const capture = readFileSync(new URL("./fixtures/kitty-osc2-osc22-commands.txt", import.meta.url), "utf8")
const definition = extensionsProbes.find((probe) => probe.id === "extensions.osc22-pointer")!

/** Runs the real multiplexer arm through the collector's recorder and returns its writes and call log. */
async function muxArm(mux: "tmux" | "screen") {
  const writes: string[] = []
  const source = { kind: "live", cols: 80, rows: 24, mux, write: (text: string) => void writes.push(text) }
  const log = createCallLog()
  const session = withCallLog(source as unknown as TermProbeSource, { mode: "record", log })
  const result = await definition.term!(session.context)
  session.finish()
  const title = /^\x1b\]2;(tdv-title-[0-9a-f]{24})\x1b\\$/.exec(writes[0] ?? "")?.[1]
  return { writes, result, title, callLog: JSON.stringify(log) }
}

async function read(mux: "tmux" | "screen", record: (title: string) => string) {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-mux-osc22-"))
  const artifacts = join(directory, "artifacts")
  const daemon = join(directory, "daemon.log")
  mkdirSync(artifacts)
  try {
    // An earlier record cannot supply this invocation's control or target.
    writeFileSync(daemon, capture.replace("tdv-title-32593", "tdv-title-0123456789abcdef01234567"))
    const runId = "a".repeat(32)
    vi.stubEnv("TERMINFO_RUN_ID", runId)
    vi.stubEnv("TERMINFO_MUX_KIND", mux)
    vi.stubEnv("TERMINFO_TARGET_ID", "kitty")
    vi.stubEnv("TERMINFO_TARGET_VERSION", "0.49.2")
    vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", artifacts)
    const reader = beginMuxSgrCommandRead({
      featureId: "extensions.osc22-pointer",
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
    if (reader.status !== "ready") throw new Error(reader.reason)
    const arm = await muxArm(mux)
    appendFileSync(daemon, record(arm.title!))
    return await reader.read(arm.callLog)
  } finally {
    rmSync(directory, { recursive: true })
  }
}

test("the osc22 multiplexer arm sends its forwarding control, then plain OSC 22 pointer, and no query", async () => {
  expect(hasOuterCommandMatcher("extensions.osc22-pointer")).toBe(true)
  for (const mux of ["tmux", "screen"] as const) {
    const arm = await muxArm(mux)
    expect(arm.writes, mux).toEqual([`\x1b]2;${arm.title}\x1b\\`, "\x1b]22;pointer\x1b\\"])
    expect(arm.result.criterionBranch, mux).toBe("osc22-mux-outer-command")
    expect(arm.result.observation, mux).toBeUndefined()
  }
})

test.each(["tmux", "screen"] as const)(
  "%s: the captured record with this invocation's title reads the target as sent",
  async (mux) => {
    const result = await read(mux, (title) => capture.replace("tdv-title-32593", title))
    expect(result).toMatchObject({
      status: "measured",
      target: "set_dynamic_color 22 pointer",
      targetSent: true,
      outer: { app: "kitty", version: "0.49.2" },
    })
    // The made-up name inside the window is counted and named, never dropped.
    expect(result.detail).toMatchObject({
      closedBy: "match",
      unknown: { count: 1, lines: ["set_dynamic_color 22 tdv-made-up-shape"] },
    })
  },
  20_000,
)

test("a record with the control and no OSC 22 line reads the target as not sent, naming every other line", async () => {
  // The multiplexer arm sends no made-up name, so its record line leaves with the target.
  const result = await read("tmux", (title) =>
    capture
      .replace("tdv-title-32593", title)
      .replace("set_dynamic_color 22 tdv-made-up-shape\n", "")
      .replace("set_dynamic_color 22 pointer\n", ""),
  )
  expect(result).toMatchObject({ status: "measured", targetSent: false })
  expect(result.detail).toMatchObject({
    closedBy: "deadline",
    unknown: {
      count: 5,
      lines: [
        "select_graphic_rendition 1",
        "draw B",
        "select_graphic_rendition 0",
        "screen_carriage_return",
        "screen_linefeed",
      ],
    },
  })
}, 20_000)

// 32593 peer (@dev/3): the callback sends the nonce title first, then OSC 22, so a target line before this
// invocation's control is an earlier invocation's and cannot qualify this one.
test("a target line before this invocation's control does not read as sent", async () => {
  const result = await read(
    "tmux",
    (title) =>
      `set_dynamic_color 22 pointer\nset_title ${title}\n` +
      capture
        .replace("set_title tdv-title-32593\n", "")
        .replace("set_dynamic_color 22 tdv-made-up-shape\n", "")
        .replace("set_dynamic_color 22 pointer\n", ""),
  )
  expect(result).toMatchObject({ status: "measured", targetSent: false })
  // Only the lines after the control are this invocation's: the earlier target is neither the target nor unknown.
  expect(result.detail).toMatchObject({
    closedBy: "deadline",
    unknown: {
      count: 5,
      lines: [
        "select_graphic_rendition 1",
        "draw B",
        "select_graphic_rendition 0",
        "screen_carriage_return",
        "screen_linefeed",
      ],
    },
  })
}, 20_000)

// @cto 18d11184: a target forwarded in another form must never read as "did not send".
test("the target's command word in another form is a named failure, never Unsupported", async () => {
  const result = await read("tmux", (title) =>
    capture
      .replace("tdv-title-32593", title)
      .replace("set_dynamic_color 22 tdv-made-up-shape\n", "")
      .replace("set_dynamic_color 22 pointer\n", "set_dynamic_color 22 hand\n"),
  )
  expect(result.status).toBe("unavailable")
  if (result.status === "unavailable") {
    expect(result.reason).toBe(
      "Outer command record has set_dynamic_color 22 in another form than the target line: set_dynamic_color 22 hand",
    )
  }
}, 20_000)

test.each([
  ["control missing", () => capture.replace("set_title tdv-title-32593\n", "")],
  ["another invocation's title", () => capture],
  ["no record", () => ""],
])(
  "%s is a named failure, never an empty phase",
  async (_name, record) => {
    const result = await read("tmux", record)
    expect(result.status).toBe("unavailable")
    if (result.status === "unavailable") {
      expect(result.reason).toMatch(
        /^Outer command record has no forwarding control line: set_title tdv-title-[0-9a-f]{24}$/,
      )
    }
  },
  20_000,
)
