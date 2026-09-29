/**
 * @failure A silent CSI 18 t reply invents 24 rows and scrollback measures the wrong grid.
 * @level l1
 * @consumer App scrollback callback on a measured owned terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { scrollbackProbes } from "./scrollback.ts"
import type { TermContext } from "./types.ts"

test("accumulate uses measured rows and does not infer 24 after CSI silence", async () => {
  const probe = scrollbackProbes.find((entry) => entry.id === "scrollback.accumulate")
  if (!probe?.term) throw new Error("missing scrollback.accumulate app callback")
  expect(probe.termNeedsGeometry).toBe(true)
  const writes: string[] = []
  const queries: string[] = []
  const context: TermContext = {
    rows: 37,
    cols: 61,
    write: (s) => writes.push(s),
    queryCursorPosition: async () => ({ row: 37, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async (s) => {
      queries.push(s)
      return null
    },
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  await probe.term(context)
  expect(queries).toEqual([])
  expect(writes.filter((s) => s.startsWith("line-"))).toHaveLength(47)
})

test("DECSTBM reset uses measured row count beyond 999 and declines a short grid before writes", async () => {
  const probe = scrollbackProbes.find((entry) => entry.id === "scrollback.decstbm-reset")
  if (!probe?.term) throw new Error("missing scrollback.decstbm-reset app callback")
  const writes: string[] = []
  const context: TermContext = {
    rows: 1200,
    cols: 61,
    write: (s) => writes.push(s),
    queryCursorPosition: async () => ({ row: 1200, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  await probe.term(context)
  expect(writes).toContain("\x1b[1200B")
  writes.length = 0
  const result = await probe.term({ ...context, rows: 9 })
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(writes).toEqual([])
})
