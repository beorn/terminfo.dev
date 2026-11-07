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
] as const)("Ghostty OSC %s reads only its reset warning behind an independent logged control", async (code, family, slot, sentinel, sentinelSlot) => {
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
})

test("Kitty keeps unknown-command controls, unique logged sentinels and title restoration", async () => {
  const root = mkdtempSync(join(tmpdir(), "app-semantic-kitty-"))
  const capture = join(root, "capture")
  mkdirSync(capture)
  const log = join(root, "daemon.log")
  writeFileSync(log, "")
  vi.stubEnv("TERMINFO_RUN_ID", "a".repeat(32))
  vi.stubEnv("TERMINFO_MUX_KIND", undefined)
  vi.stubEnv("TERMINFO_TARGET_ID", "kitty")
  vi.stubEnv("TERMINFO_TARGET_VERSION", "0.49.2")
  vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", capture)
  vi.stubEnv("KITTY_PID", "123")
  let title = "original title"
  vi.mocked(execFileSync).mockImplementation((file, args) => {
    if (file === "/owned/kitty") return "kitty 0.49.2 created by Kovid Goyal\n"
    return Array.isArray(args) && args[0] === "search" ? "123\n" : title
  })
  const writes: string[] = []
  try {
    const result = await readAppSemanticState({
      featureId: "extensions.osc176-app-id",
      runId: "a".repeat(32),
      executable: { path: "/owned/kitty", sha256: "b".repeat(64) },
      write: (bytes) => {
        writes.push(bytes)
        for (const match of bytes.matchAll(/\x1b\]([^\x07]*)\x07/g)) {
          const body = match[1]!
          if (body.startsWith("2;")) title = body.slice(2)
          else appendFileSync(log, `[PARSE ERROR] Unknown OSC escape code: ${body}\n`)
        }
      },
    })
    expect(result).toMatchObject({
      status: "measured",
      reader: "report",
      unknown: { code: "7654", reports: ["7654"] },
      handled: { applied: true, reports: [] },
      target: { code: "176", reports: ["176"] },
    })
    const sentinels = writes.flatMap((bytes) => [...bytes.matchAll(/7655;([^\x07]+)/g)].map((match) => match[1]))
    expect(new Set(sentinels).size).toBe(3)
    expect(title).toBe("original title")
  } finally {
    rmSync(root, { recursive: true })
  }
})
