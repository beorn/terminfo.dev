/**
 * @failure Four DEC mode app probes mutate terminal state or treat CPR responsiveness as mode recognition.
 * @level l1
 * @consumer Owned app mode observations and reviewed support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { modesProbes } from "./modes.ts"
import type { TermContext } from "./types.ts"

const modes = [
  { id: "modes.alt-scroll-1007", number: 1007 },
  { id: "modes.utf8-mouse-1005", number: 1005 },
  { id: "modes.deccolm", number: 3 },
  { id: "modes.decsclm", number: 4 },
] as const

test.each(modes)("$id uses one DECRPM query without changing the terminal", async ({ id, number }) => {
  const definition = modesProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)

  for (const state of ["unknown", null, "set", "reset"] as const) {
    const queried: number[] = []
    const unexpected = (operation: string): never => {
      throw new Error(`${id}: unexpected ${operation} for ${state}`)
    }
    const context: TermContext = {
      cols: 80,
      rows: 24,
      write: () => unexpected("write"),
      queryCursorPosition: async () => unexpected("CPR"),
      measureRenderedWidth: async () => unexpected("width query"),
      query: async () => unexpected("raw query"),
      queryWithSentinel: async () => unexpected("sentinel query"),
      queryOutcome: async () => unexpected("query outcome"),
      queryWithSentinelOutcome: async () => unexpected("sentinel outcome"),
      queryMode: async (mode) => {
        queried.push(mode)
        return state
      },
    }

    const result = await definition.term(context)
    expect(queried, `${id}: ${state}`).toEqual([number])
    if (state === null) {
      expect(result.pass).toBe(false)
      expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response", evidence: "query" })
      expect(result.assertions ?? []).toEqual([])
    } else {
      const recognized = state !== "unknown"
      expect(result.pass).toBe(recognized)
      expect(result.observation).toMatchObject({ outcome: recognized ? "supported" : "unsupported", evidence: "query" })
      expect(result.assertions).toMatchObject([{ kind: recognized ? "positive" : "negative", observed: state }])
    }
  }
  expect(definition.termWrites).toBe("query")
  expect(definition.termObservationEvidence).toBe("query")
})
