/**
 * @failure Offline submission rewrites a partial v2 run or revives legacy boolean scores/posting.
 * @level l2
 * @consumer Public installed CLI draft command
 * @testonly none
 */
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { createDraft } from "./submit.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const receipt = {
  manifest: {
    probeHash: "abcdef123456",
    sourceRevision: "c".repeat(40),
    generatedAt: "2026-09-28T00:00:00.000Z",
    adapterVersion: "3.3.1",
    probes: { app: ["device.primary-da"], mux: ["device.primary-da"], headless: ["device.primary-da"] },
  } satisfies ProbeSuiteManifest,
  collectorRevision: "a".repeat(40),
  cliVersion: "3.3.1",
}
const partialRun = {
  schemaVersion: 2,
  runId: "1234567890abcdef1234567890abcdef",
  target: {
    kind: "app",
    id: "kitty",
    version: "0.49.1",
    os: "linux",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  },
  identity: "unverified",
  suiteId: receipt.manifest.probeHash,
  probeHash: receipt.manifest.probeHash,
  suiteComplete: false,
  sourceRevision: receipt.collectorRevision,
  measuredAt: "2026-09-28T12:00:00.000Z",
  origin: { kind: "collector" },
  rawReplies: {},
  assertions: [],
  screenshotRefs: [],
  observations: [],
  ungradedDiagnostics: {},
}

it("creates an exclusive offline draft containing the exact partial run and its SHA", () => {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-draft-"))
  dirs.push(dir)
  const rawPath = join(dir, "run.json")
  const draftPath = join(dir, "draft.md")
  const raw = `${JSON.stringify(partialRun)}\n`
  writeFileSync(rawPath, raw)
  const result = createDraft(rawPath, draftPath, receipt)
  const draft = readFileSync(draftPath, "utf8")
  expect(result.sha256).toBe(createHash("sha256").update(raw).digest("hex"))
  expect(draft).toContain(result.attachmentPath.split("/").at(-1) ?? "")
  expect(readFileSync(result.attachmentPath).equals(Buffer.from(raw))).toBe(true)
  expect(draft).toContain("history only")
  expect(draft).toContain("0/1")
  expect(draft).toContain(result.sha256)
  expect(draft).toContain(
    "I dedicate these results to the public domain (CC0 1.0) so terminfo.dev can publish them under any license.",
  )
  expect(statSync(draftPath).mode & 0o777).toBe(0o600)
  expect(() => createDraft(rawPath, draftPath, receipt)).toThrow()
  expect(readFileSync(draftPath, "utf8")).toBe(draft)
})

it("keeps exact bytes when original JSON has no final LF or has CRLF", () => {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-draft-"))
  dirs.push(dir)
  for (const [label, raw] of [
    ["no-lf", JSON.stringify(partialRun)],
    ["crlf", `${JSON.stringify(partialRun)}\r\n`],
  ] as Array<[string, string]>) {
    const rawPath = join(dir, `${label}.json`)
    writeFileSync(rawPath, raw)
    const result = createDraft(rawPath, join(dir, `${label}.md`), receipt)
    expect(readFileSync(result.attachmentPath).equals(Buffer.from(raw))).toBe(true)
    expect(result.sha256).toBe(createHash("sha256").update(raw).digest("hex"))
  }
})

it("refuses legacy booleans, malformed bytes, and unbound screenshot artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-draft-"))
  dirs.push(dir)
  const rawPath = join(dir, "run.json")
  const draftPath = join(dir, "draft.md")
  writeFileSync(
    rawPath,
    JSON.stringify({
      terminal: "kitty",
      version: "0.49.1",
      generated: partialRun.measuredAt,
      results: { "device.primary-da": true },
    }),
  )
  expect(() => createDraft(rawPath, draftPath, receipt)).toThrow(/v2|schema/i)
  writeFileSync(rawPath, Buffer.from([0xff]))
  expect(() => createDraft(rawPath, draftPath, receipt)).toThrow(/UTF-8/i)
  writeFileSync(rawPath, JSON.stringify({ ...partialRun, screenshotRefs: [`sha256:${"b".repeat(64)}`] }))
  expect(() => createDraft(rawPath, draftPath, receipt)).toThrow(/screenshot.*artifact/i)
})
