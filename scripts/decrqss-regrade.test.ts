/**
 * @failure Replaying admitted device.decrqss raw through the conditional second setting would move a
 *   decided (supported/unsupported) row, so the stimulus change would rewrite history instead of
 *   reaching only currently-inconclusive refusals.
 * @level l2
 * @consumer 27919 admitted-run regrade of device.decrqss
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/ vendor/terminfo.dev/content/probes-mux/
 * @testonly none
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { deviceProbes } from "@terminfo/probe-defs"
import type { TermContext, TerminalQueryOutcome } from "@terminfo/probe-defs"

const SGR_QUERY = "\x1bP$qm\x1b\\"
const DECSTBM_QUERY = "\x1bP$qr\x1b\\"
const CONTENT = join(import.meta.dirname, "../content")

interface StoredQuery {
  sequence: string
  match: string[] | null
  reason: TerminalQueryOutcome["reason"]
  raw: string
  sentinel?: { atMs: number; graceMs: number }
}

interface RowInstance {
  file: string
  terminal: string
  version: string
  runId: string
  storedOutcome: string
  storedNote: string | undefined
  storedStimulus: string
  newOutcome: string | undefined
  newNote: string | undefined
  secondQuery: boolean
}

function loadRows(): Array<{
  file: string
  terminal: string
  version: string
  runId: string
  observation: { outcome: string; note?: string }
  query: StoredQuery | null
}> {
  const rows = []
  for (const dir of ["probes-apps", "probes-mux"] as const) {
    for (const name of readdirSync(join(CONTENT, dir)).filter((entry) => entry.endsWith(".json"))) {
      const file = `${dir}/${name}`
      const data = JSON.parse(readFileSync(join(CONTENT, dir, name), "utf8")) as {
        schemaVersion?: number
        runId?: string
        target?: { id?: string; version?: string }
        observations?: Array<{ featureId: string; outcome: string; note?: string }>
        rawReplies?: Record<string, string>
      }
      if (data.schemaVersion !== 2) continue
      const observation = data.observations?.find((item) => item.featureId === "device.decrqss")
      if (!observation) continue
      const raw = data.rawReplies?.["device.decrqss"]
      let query: StoredQuery | null = null
      if (typeof raw === "string" && raw.startsWith("{")) {
        const parsed = JSON.parse(raw) as { queries?: StoredQuery[] }
        query = parsed.queries?.[0] ?? null
      }
      rows.push({
        file,
        terminal: data.target?.id ?? "unknown",
        version: data.target?.version ?? "unknown",
        runId: data.runId ?? name,
        observation,
        query,
      })
    }
  }
  return rows
}

async function regrade(
  query: StoredQuery,
): Promise<{ outcome: string | undefined; note: string | undefined; queries: string[] }> {
  const probe = deviceProbes.find((item) => item.id === "device.decrqss")
  if (!probe?.term) throw new Error("missing device.decrqss term callback")
  const queries: string[] = []
  const ctx = {
    queryWithSentinelOutcome: (sequence: string, pattern: RegExp) => {
      queries.push(sequence)
      if (sequence === SGR_QUERY) {
        return Promise.resolve({
          match: query.reason === "reply" ? pattern.exec(query.raw) : null,
          reason: query.reason,
          raw: query.raw,
          rawBase64: Buffer.from(query.raw).toString("base64"),
          ...(query.sentinel && { sentinel: query.sentinel }),
        })
      }
      if (sequence !== DECSTBM_QUERY) throw new Error(`unexpected query ${JSON.stringify(sequence)}`)
      const da1 = /\x1b\[\?[0-9;]*c/.exec(query.raw)
      if (da1) {
        return Promise.resolve({
          match: null,
          reason: "sentinel" as const,
          raw: da1[0],
          rawBase64: Buffer.from(da1[0]).toString("base64"),
          sentinel: query.sentinel ?? { atMs: 0, graceMs: 250 },
        })
      }
      return Promise.resolve({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" })
    },
  } as unknown as TermContext
  const result = await probe.term(ctx)
  return { outcome: result.observation?.outcome, note: result.observation?.note, queries }
}

describe("device.decrqss admitted-run regrade", () => {
  test("no decided SGR-stimulus row moves; only currently-inconclusive instances change", async () => {
    const instances: RowInstance[] = []
    for (const row of loadRows()) {
      const stimulus = row.query?.sequence ?? ""
      const sgrStimulus = stimulus.includes("$qm")
      if (!sgrStimulus || !row.query) {
        instances.push({
          file: row.file,
          terminal: row.terminal,
          version: row.version,
          runId: row.runId,
          storedOutcome: row.observation.outcome,
          storedNote: row.observation.note,
          storedStimulus: stimulus || "(no query log)",
          newOutcome: row.observation.outcome,
          newNote: row.observation.note,
          secondQuery: false,
        })
        continue
      }
      const next = await regrade(row.query)
      instances.push({
        file: row.file,
        terminal: row.terminal,
        version: row.version,
        runId: row.runId,
        storedOutcome: row.observation.outcome,
        storedNote: row.observation.note,
        storedStimulus: stimulus,
        newOutcome: next.outcome,
        newNote: next.note,
        secondQuery: next.queries.includes(DECSTBM_QUERY),
      })
    }
    expect(instances.length).toBeGreaterThan(0)
    const decidedMoved = instances.filter(
      (row) =>
        (row.storedOutcome === "supported" || row.storedOutcome === "unsupported") &&
        row.newOutcome !== row.storedOutcome,
    )
    expect(decidedMoved, JSON.stringify(decidedMoved, null, 2)).toEqual([])
    const changed = instances.filter((row) => row.storedOutcome !== row.newOutcome || row.storedNote !== row.newNote)
    expect(
      changed.every((row) => row.storedOutcome === "inconclusive"),
      JSON.stringify(changed, null, 2),
    ).toBe(true)
    expect(changed.map((row) => row.runId).sort()).toEqual(
      [
        "a98b86e81a315d1b9eceecb746219dde",
        "a240ac80d66cf53d818ad3b9151f4791",
        "e40dd22ab0d8144583d5cb9b02e4487c",
        "ed1a16b871b927666bc8de7dc9912dc6",
      ].sort(),
    )
    expect(changed.every((row) => row.terminal === "wezterm")).toBe(true)
    expect(changed.every((row) => row.secondQuery)).toBe(true)
    expect(changed.every((row) => row.newOutcome === "inconclusive")).toBe(true)
  })
})
