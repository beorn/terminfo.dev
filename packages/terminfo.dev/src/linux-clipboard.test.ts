/**
 * @failure A foreign or incomplete receipt authorizes OSC 52, or a failed callback leaves a disposable selection mutated.
 * @level l1
 * @consumer Owned Linux clipboard adapter used by the app probe batch.
 * @testonly none
 * @reach fs-walk /tmp/terminfo-clipboard-receipts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { createClipboardTransaction, createLinuxClipboardAdapter, type ClipboardTraceEvent } from "./linux-clipboard.ts"

const originalCapture = process.env.TERMINFO_CAPTURE_DIRECTORY
const measuredExecutable = { path: process.execPath, sha256: "0".repeat(64) }
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  if (originalCapture === undefined) delete process.env.TERMINFO_CAPTURE_DIRECTORY
  else process.env.TERMINFO_CAPTURE_DIRECTORY = originalCapture
})

test.runIf(process.platform === "linux")(
  "missing live display and process receipt refuses before xclip access",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminfo-clipboard-receipts-"))
    directories.push(dir)
    process.env.TERMINFO_CAPTURE_DIRECTORY = join(dir, "artifacts")
    const receipt = join(dir, "clipboard-fixture.json")
    writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, runId: "a".repeat(32), profile: "allow" }), {
      mode: 0o600,
    })
    await expect(createLinuxClipboardAdapter(receipt, "a".repeat(32), measuredExecutable)).rejects.toThrow(
      "Invalid owned clipboard receipt",
    )
    writeFileSync(
      receipt,
      JSON.stringify({
        schemaVersion: 1,
        runId: "a".repeat(32),
        profile: "allow",
        display: {},
        terminal: {},
        selection: {},
        config: "",
        permissions: "",
      }),
    )
    await expect(createLinuxClipboardAdapter(receipt, "a".repeat(32), measuredExecutable)).rejects.toThrow(
      "invalid PID",
    )
    writeFileSync(
      receipt,
      JSON.stringify({
        schemaVersion: 1,
        runId: "a".repeat(32),
        profile: "allow",
        display: { name: ":22", number: 22, displayFdPath: join(dir, "display-number"), xvfbPid: 123 },
        terminal: { pid: 456, collectorPid: process.pid, windowId: "42", windowPid: 456 },
        selection: {
          helperPid: 789,
          helperExecutable: { path: "/bin/false", sha256: "b".repeat(64) },
          baselinePath: join(dir, "baseline"),
          baselineSha256: "c".repeat(64),
          initialReadSha256: "c".repeat(64),
        },
        config: "fixture",
        permissions: "clipboard: read=allow,write=allow",
      }),
    )
    await expect(createLinuxClipboardAdapter(receipt, "b".repeat(32), measuredExecutable)).rejects.toThrow(
      "does not match this collector run",
    )
  },
)

test("a nested transaction refuses and callback failure restores and verifies the generated baseline", async () => {
  let text = "baseline-nonce"
  const events: ClipboardTraceEvent[] = []
  const transaction = createClipboardTransaction("baseline-nonce", {
    assertOwned: async () => {},
    readText: async (trace, kind = "clipboard-read") => {
      trace({ kind, at: new Date().toISOString(), sha256: "a".repeat(64), length: text.length })
      return text
    },
    writeText: async (value, trace, kind = "clipboard-write") => {
      text = value
      trace({ kind, at: new Date().toISOString(), sha256: "a".repeat(64), length: text.length })
    },
  })
  await expect(
    transaction(
      async (fixture) => {
        await fixture.writeText("callback-nonce")
        await expect(
          transaction(
            async () => ({ pass: true }),
            (event) => events.push(event),
          ),
        ).rejects.toThrow("cannot nest")
        throw new Error("query failed")
      },
      (event) => events.push(event),
    ),
  ).rejects.toThrow("query failed")
  expect(text).toBe("baseline-nonce")
  expect(events.map((event) => event.kind)).toEqual([
    "clipboard-read",
    "clipboard-write",
    "clipboard-restore",
    "clipboard-verify",
  ])
  expect(events.every((event) => !Number.isNaN(Date.parse(event.at)))).toBe(true)
})

test("restoration failure overrides a supported callback result", async () => {
  const transaction = createClipboardTransaction("baseline-nonce", {
    assertOwned: async () => {},
    readText: async () => "baseline-nonce",
    writeText: async () => {
      throw new Error("xclip exited")
    },
  })
  await expect(
    transaction(
      async () => ({ pass: true, observation: { outcome: "supported", evidence: "behavior" } }),
      () => {},
    ),
  ).rejects.toThrow("Owned clipboard restoration failed: xclip exited")
})
