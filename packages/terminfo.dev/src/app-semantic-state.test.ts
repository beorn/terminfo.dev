/**
 * @failure A mux borrows its outer Kitty's log reader, or a missing ownership/run
 *   binding reaches terminal I/O. Probe-layer tests have no attachment identity.
 * @level l2
 * @consumer The owned collector's shared exact-App table and semantic reader.
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appSemanticDeclarations, readAppSemanticState } from "./app-semantic-state.ts"

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }))
vi.mock("./linux-capture.ts", async (original) => ({
  ...(await original<typeof import("./linux-capture.ts")>()),
  kittyAncestor: vi.fn(() => 123),
}))

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
  expect(Object.keys(appSemanticDeclarations(kitty))).toEqual(["extensions.osc133-b", "extensions.osc3008-context"])
  expect(appSemanticDeclarations({ ...kitty, version: "unreviewed" })).toEqual({})
  expect(appSemanticDeclarations({ kind: "mux", id: "tmux", version: "3.8", os: "linux" })).toEqual({})
})

// Existing Kitty coverage cannot detect Ghostty's silently dropped unknown OSC.
// These exact source-format bytes exercise the shared reader, its row window and controls.
test.each([
  ["117", "background"],
  ["119", "foreground"],
] as const)("Ghostty OSC %s reads only its reset warning behind logged OSC113", async (code, slot) => {
  const root = mkdtempSync(join(tmpdir(), "app-semantic-ghostty-"))
  const capture = join(root, "capture")
  mkdirSync(capture)
  const log = join(root, "daemon.log")
  const line = (name: string) => `warning(stream): resetting dynamic color ${name} not implemented\n`
  const featureId = `extensions.osc${code}-reset-highlight-${slot === "background" ? "bg" : "fg"}`
  vi.stubEnv("TERMINFO_RUN_ID", "a".repeat(32))
  vi.stubEnv("TERMINFO_MUX_KIND", undefined)
  vi.stubEnv("TERMINFO_TARGET_ID", "ghostty")
  vi.stubEnv("TERMINFO_TARGET_VERSION", "1.4.0")
  vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", capture)
  vi.mocked(execFileSync).mockReturnValue("Ghostty 1.4.0\n")
  try {
    for (const variant of ["exact", "query-only", "handled-refusal"] as const) {
      // A stale matching line before this row must never become its target report.
      writeFileSync(log, line(`highlight_${slot}`))
      const writes: string[] = []
      const result = await readAppSemanticState({
        featureId,
        runId: "a".repeat(32),
        executable: { path: "/owned/ghostty", sha256: "b".repeat(64) },
        write: (bytes) => {
          writes.push(bytes)
          if (bytes.includes("\x1b]110\x07") && variant === "handled-refusal") appendFileSync(log, line("foreground"))
          if (bytes.includes(`\x1b]${code}\x07`)) {
            appendFileSync(log, variant === "exact" ? line(`highlight_${slot}`) : `info(stream): reporting dynamic color highlight_${slot} not implemented\n`)
          }
          if (bytes.includes("\x1b]113\x07")) appendFileSync(log, line("pointer_foreground"))
        },
      })
      if (variant === "handled-refusal") {
        expect(result).toMatchObject({ status: "invalid", reason: expect.stringContaining("110") })
      } else {
        expect(result).toMatchObject({
          status: "measured", reader: "report",
          unknown: { code: "113", reports: ["113"] },
          handled: { applied: true, reports: [] },
          target: { code, reports: variant === "exact" ? [code] : [] },
        })
      }
      expect(writes.join("")).toContain("\x1b]110\x07")
      expect(writes.join("")).toContain(`\x1b]${code}\x07\x1b]113\x07`)
      expect(writes.join("")).not.toContain("7654")
    }
  } finally {
    rmSync(root, { recursive: true })
  }
})
