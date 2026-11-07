/**
 * @failure A mux borrows its outer Kitty's log reader, or a missing ownership/run
 *   binding reaches terminal I/O. Probe-layer tests have no attachment identity.
 * @level l2
 * @consumer The owned collector's shared exact-App table and semantic reader.
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appSemanticDeclarations,
  beginMuxSgrCommandRead,
  openAppCommandLog,
  readAppSemanticState,
} from "./app-semantic-state.ts"

afterEach(() => vi.unstubAllEnvs())

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
  expect(Object.keys(appSemanticDeclarations(kitty))).toEqual(["extensions.osc133-b"])
  expect(appSemanticDeclarations({ ...kitty, version: "unreviewed" })).toEqual({})
  expect(appSemanticDeclarations({ kind: "mux", id: "tmux", version: "3.8", os: "linux" })).toEqual({})
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

// Native tmux 3.8 / Kitty 0.49.2 run adebe1dc, daemon.log lines 3028..3097
// and the same callback's four paint writes. The variants remove only one deciding input.
const nativeMuxCommands = readFileSync(new URL("./fixtures/kitty-mux-sgr.txt", import.meta.url), "utf8")
const nativeMuxTrace = readFileSync(new URL("./fixtures/kitty-mux-sgr.trace.json", import.meta.url), "utf8")

test.each([
  ["forwarded", nativeMuxCommands, true, undefined],
  ["dropped", nativeMuxCommands.replace("select_graphic_rendition 4:3\n", ""), false, undefined],
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
  async (_name, commands, forwarded, refusal) => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-mux-sgr-"))
    const capture = join(directory, "artifacts")
    const path = join(directory, "daemon.log")
    mkdirSync(capture)
    try {
      // An earlier complete run cannot supply this callback's target or handled control.
      writeFileSync(path, nativeMuxCommands)
      const runId = "a".repeat(32)
      vi.stubEnv("TERMINFO_RUN_ID", runId)
      vi.stubEnv("TERMINFO_MUX_KIND", "tmux")
      vi.stubEnv("TERMINFO_TARGET_ID", "kitty")
      vi.stubEnv("TERMINFO_TARGET_VERSION", "0.49.2")
      vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", capture)
      const reader = beginMuxSgrCommandRead({
        featureId: "sgr.underline.curly",
        subject: { kind: "mux", id: "tmux", version: "3.8", os: "linux", outerTerminal: "kitty" },
        proof: { platform: "linux", mux: "tmux", launchRunId: runId, collector: { pid: process.pid, startTicks: "1" } },
      })
      expect(reader.status).toBe("ready")
      if (reader.status !== "ready") throw new Error(reader.reason)
      appendFileSync(path, commands)
      const result = await reader.read(nativeMuxTrace)
      if (refusal) {
        expect(result.status).toBe("unavailable")
        if (result.status === "unavailable") expect(result.reason).toMatch(refusal)
      } else {
        expect(result).toMatchObject({ status: "measured", targetSent: forwarded, target: "4:3" })
      }
      expect(result.detail.offset).toBe(Buffer.byteLength(nativeMuxCommands))
    } finally {
      rmSync(directory, { recursive: true })
    }
  },
  20_000,
)
