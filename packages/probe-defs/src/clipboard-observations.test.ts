/**
 * @failure OSC 52 write readback raced the terminal's processing of the same TTY stream.
 * @level l0
 * @consumer Owned live clipboard probe callbacks.
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { ALL_PROBES, type ClipboardFixture, type TermContext } from "./index.ts"

function writeProbe() {
  const probe = ALL_PROBES.find((item) => item.id === "extensions.osc52-write")
  if (!probe?.term) throw new Error("OSC 52 write callback is missing")
  return probe.term
}

function termContext(overrides: Partial<TermContext>): TermContext {
  return {
    write() {},
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinel: async () => null,
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 80,
    rows: 24,
    ...overrides,
  }
}

function writtenNonce(sequence: string): string {
  const match = /\x1b\]52;c;([^\x07]+)\x07/.exec(sequence)
  if (!match?.[1]) throw new Error("Expected OSC 52 write frame")
  return atob(match[1])
}

describe("live OSC 52 write ordering", () => {
  test("independent read follows a correlated TTY processing checkpoint", async () => {
    const events: string[] = []
    let clipboard = "baseline"
    let queued = ""
    const fixture: ClipboardFixture = {
      readText: async () => {
        events.push("independent-read")
        return clipboard
      },
      writeText: async (text) => {
        clipboard = text
      },
    }
    const result = await writeProbe()(
      termContext({
        write(sequence) {
          events.push("osc-write")
          queued = writtenNonce(sequence)
        },
        queryCursorPosition: async () => {
          events.push("cpr")
          clipboard = queued
          return { row: 1, col: 1 }
        },
        withClipboardFixture: async (work) => {
          try {
            return await work(fixture)
          } finally {
            clipboard = "baseline"
            events.push("restore")
          }
        },
      }),
    )
    expect(events).toEqual(["osc-write", "cpr", "independent-read", "restore"])
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "behavior" })
    expect(result.assertions?.[0]?.observed).toBe(queued)
    expect(clipboard).toBe("baseline")
  })

  test("a terminal that answers CPR but ignores OSC 52 remains inconclusive", async () => {
    const events: string[] = []
    const result = await writeProbe()(
      termContext({
        write(sequence) {
          writtenNonce(sequence)
          events.push("osc-write")
        },
        queryCursorPosition: async () => {
          events.push("cpr")
          return { row: 1, col: 1 }
        },
        withClipboardFixture: async (work) =>
          work({
            readText: async () => {
              events.push("independent-read")
              return "baseline"
            },
            writeText: async () => {},
          }),
      }),
    )
    expect(events).toEqual(["osc-write", "cpr", "independent-read"])
    expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions).toBeUndefined()
  })

  test("missing CPR cannot authorize a positive read and still restores the owned fixture", async () => {
    const events: string[] = []
    let clipboard = "baseline"
    const result = await writeProbe()(
      termContext({
        write(sequence) {
          clipboard = writtenNonce(sequence)
          events.push("osc-write")
        },
        queryCursorPosition: async () => {
          events.push("cpr-missing")
          return null
        },
        withClipboardFixture: async (work) => {
          try {
            return await work({
              readText: async () => {
                events.push("independent-read")
                return clipboard
              },
              writeText: async (text) => {
                clipboard = text
              },
            })
          } finally {
            clipboard = "baseline"
            events.push("restore")
          }
        },
      }),
    )
    expect(events).toEqual(["osc-write", "cpr-missing", "restore"])
    expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
    expect(result.assertions).toBeUndefined()
    expect(clipboard).toBe("baseline")
  })
})
