/**
 * @failure A run file with no runId is loaded with its FILE NAME as the run id, so the harness
 *   invents an identity the producer never wrote and a legacy-shaped fixture passes a contract
 *   that was supposed to have no subject left (#30815).
 * @level l0
 * @consumer probe-defs group harness (28454); #30815 legacy-shape cleanup.
 * @reach fs-walk <fixture-only: /tmp/group-harness-runid-*>
 * @testonly none
 */
import { expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadGroupRows } from "./group-harness.ts"

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "group-harness-runid-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeRaw(root: string, name: string, body: Record<string, unknown>): void {
  mkdirSync(join(root, "probes-apps"), { recursive: true })
  writeFileSync(join(root, "probes-apps", name), JSON.stringify(body))
}

test("a run file with no runId is a loud fault naming the file, never the file name as an id", () => {
  const { root, cleanup } = fixture()
  try {
    writeRaw(root, "no-runid.json", {
      schemaVersion: 2,
      target: { id: "fixture", version: "1.0.0" },
      observations: [],
      rawReplies: {},
    })
    expect(() => loadGroupRows(root, [{ dir: "probes-apps" }])).toThrow(/runId/u)
    expect(() => loadGroupRows(root, [{ dir: "probes-apps" }])).toThrow(/no-runid\.json/u)
  } finally {
    cleanup()
  }
})

test("a run file that carries its runId still loads, so the refusal is about the missing identity only", () => {
  const { root, cleanup } = fixture()
  try {
    writeRaw(root, "real.json", {
      schemaVersion: 2,
      runId: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
      target: { id: "fixture", version: "1.0.0" },
      observations: [],
      rawReplies: {},
    })
    const read = loadGroupRows(root, [{ dir: "probes-apps" }])
    expect(read.rows).toHaveLength(1)
    expect(read.rows[0]?.runId).toBe("0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f")
  } finally {
    cleanup()
  }
})
