/**
 * @failure Erase and charset probes on a hosted Linux terminal fall to ungraded pixel capture while
 *   the terminal would answer DECRQCRA, so the 15 classic rows stay silent-inconclusive.
 * @level l1
 * @consumer Linux hosted app-mode decisions for the erase.* and charsets.* groups.
 * @testonly none
 */
import { expect, test } from "vitest"
import { charsetsProbes } from "./charsets.ts"
import { eraseProbes } from "./erase.ts"
import { SGR_CAPTURE_MIN_COLS, SGR_CAPTURE_MIN_ROWS } from "./helpers.ts"
import type { ProbeDefinition, ProbeResult, TermContext, TerminalQueryOutcome } from "./types.ts"

function timeout(): TerminalQueryOutcome {
  return { match: null, reason: "timeout", raw: "", rawBase64: "" }
}

/**
 * Effective new work: 10 erase rows plus 4 charset rows. erase.screen.scrollback already decides
 * from the 28452 XTEST wheel+capture path (supported/unsupported), so it is not in this table.
 */
const READBACK_IDS = [
  "erase.line.right",
  "erase.line.left",
  "erase.line.all",
  "erase.screen.below",
  "erase.screen.above",
  "erase.screen.all",
  "erase.character",
  "erase.selective",
  "erase.el-with-attrs",
  "erase.ed-scroll-region",
  "charsets.dec-special",
  "charsets.utf8",
  "charsets.g0-g1-switching",
  "charsets.dec-line-drawing",
] as const

function byId(id: string): ProbeDefinition {
  const probe = [...eraseProbes, ...charsetsProbes].find((value) => value.id === id)
  if (!probe?.term) throw new Error(`missing term callback for ${id}`)
  return probe
}

/**
 * A terminal that answers DECRQCRA `CSI ... * y` with the scripted checksums, or stays silent
 * when a slot is null. Capture is installed, so a probe that did not query would land on the
 * ungraded pixel path and could not decide.
 *
 * Scripted order matches the production readback: a capability probe, then expected-frame
 * checksum, seed checksum, then post-sequence checksum. Matching expected vs post
 * (`ffff`, `0000`, `ffff`, `0000`) is supported.
 */
function checksumContext(replies: ReadonlyArray<string | null>): { ctx: TermContext; queries: string[] } {
  const queries: string[] = []
  let index = 0
  const ctx = {
    rows: 24,
    cols: 80,
    capture: async ({ role, label }: { role: string; label: string }) => ({
      role,
      label,
      capturedAt: 1,
      ref: `frame-${role}`,
    }),
    write: () => {},
    queryCursorPosition: async () => ({ row: 1, col: 2 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => timeout(),
    async queryWithSentinelOutcome(sequence: string) {
      queries.push(sequence)
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      if (reply === null) return timeout()
      return { match: [`\x1bP1!~${reply}\x1b\\`, reply], reason: "reply", raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
  } as unknown as TermContext
  return { ctx, queries }
}

test("every erase and charset row in this slice queries DECRQCRA and decides from it", async () => {
  for (const id of READBACK_IDS) {
    const { ctx, queries } = checksumContext(["ffff", "0000", "ffff", "0000"])
    const result = (await byId(id).term!(ctx)) as ProbeResult
    expect(
      queries.some((sequence) => sequence.includes("*y")),
      `${id} must query DECRQCRA`,
    ).toBe(true)
    expect(result.observation, `${id} with matching expected/post checksums`).toMatchObject({
      outcome: "supported",
      evidence: "query",
    })
  }
})

test.each([...READBACK_IDS])("%s is unsupported when the post-sequence checksum still matches the seed", async (id) => {
  const { ctx } = checksumContext(["ffff", "0000", "ffff", "ffff"])
  const result = (await byId(id).term!(ctx)) as ProbeResult
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
})

test.each([...READBACK_IDS])("%s stays inconclusive, never negative, when DECRQCRA is silent", async (id) => {
  const { ctx } = checksumContext([null])
  const result = (await byId(id).term!(ctx)) as ProbeResult
  expect(result.pass).toBe(false)
  expect(result.observation?.outcome).not.toBe("unsupported")
})

test("the 3x34 SGR capture guard constants stay 3x34", () => {
  expect(SGR_CAPTURE_MIN_ROWS).toBe(3)
  expect(SGR_CAPTURE_MIN_COLS).toBe(34)
})
