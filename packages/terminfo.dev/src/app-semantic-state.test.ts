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
import { appSemanticDeclarations, openAppCommandLog, readAppSemanticState } from "./app-semantic-state.ts"

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
