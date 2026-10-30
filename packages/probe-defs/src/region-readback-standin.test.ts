/**
 * @failure A region row lands as a collector error because a cell it never compares holds the
 *   host's U+FFFD stand-in, so one probe's non-BMP glyph decides every row after it.
 * @level l1
 * @consumer captureRegionVerdict, the one region decision every cell-readback row runs.
 * @testonly none
 *
 * Measured 2026-10-18 on the hosted Windows arm: `text.wide.emoji-zwj` left a non-BMP glyph at row
 * 1, column 1, and the next 25 region rows each failed with "capture stability 1: the terminal
 * refused the text snapshot — row 1, column 1 holds U+FFFD". Clearing the screen before the read
 * did not cure it: both clears were emitted and the first error was still there. The refusal now
 * reaches only the cells the row compares, so this file poses the same leftover inside and outside
 * the row's own region — through the real text frame, not a stand-in for it.
 */
import { describe, expect, it } from "vitest"
import { textCellsFrame } from "../../terminfo.dev/src/serve.ts"
import { captureRegionVerdict, type RegionReadback } from "./region-readback.ts"
import type { CaptureRequest, TermProbeSource } from "./types.ts"

const spec: Omit<RegionReadback, "pixelGeometry"> = {
  region: { top: 2, left: 1, bottom: 2, right: 8 },
  sentinel: { row: 3, col: 1 },
  cursorRow: 4,
  seed: "\u001b[1;1Hseed",
  edit: "\u001b[1;3H\u001b[1P",
  expected: "\u001b[1;1Hexpected",
  timeoutMs: 100,
  pollMs: 1,
  minRows: 2,
  minCols: 9,
}

const WITNESS_WRITE = /\x1b\[3;1H([\s\S])/u

/**
 * The screen the hosted Windows arm held: the previous probe's stand-in at row 1, column 1, blanks
 * elsewhere. Writes never remove it — that is the measured fact the clear could not change — and
 * the only cell they move is the paint witness the probe parks at row 3, column 1.
 */
function poisonedSource(): { ctx: TermProbeSource; writes: string[]; requests: CaptureRequest[] } {
  const writes: string[] = []
  const requests: CaptureRequest[] = []
  const screen: string[][] = Array.from({ length: 24 }, () => Array.from(" ".repeat(80)))
  const firstRow = screen[0]
  if (firstRow === undefined) throw new Error("the fixture screen has no row 1")
  firstRow[0] = "\ufffd"
  const ctx: TermProbeSource = {
    kind: "live",
    rows: 24,
    cols: 80,
    captureKind: "text-cells",
    capture: async (request) => {
      requests.push(request)
      const rows = screen.map((row) => row.join(""))
      const read = {
        status: "read" as const,
        grid: {
          cols: 80,
          rows: 24,
          text: rows,
          attributes: rows.map((row) => Array.from(row, () => 7)),
        },
        bufferOwner: {
          image: "OpenConsole.exe" as const,
          pid: 4242,
          ppid: 100,
          executablePath: "C:\\Windows\\System32\\OpenConsole.exe",
          executableSha256: `sha256:${"a".repeat(64)}`,
        },
        standIns: [{ row: 1, column: 1, standIn: "U+FFFD" as const }],
      }
      return textCellsFrame(request, read, Date.now()).frame
    },
    write(sequence) {
      writes.push(sequence)
      const witness = WITNESS_WRITE.exec(sequence)
      if (witness?.[1] !== undefined) {
        const row = screen[2]
        if (row !== undefined) row[0] = witness[1]
      }
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    readInput: async () => null,
  }
  return { ctx, writes, requests }
}

describe("a stand-in outside the compared cells does not decide a region row", () => {
  it("measures its own region while the previous probe's leftover is still on screen", async () => {
    const { ctx, writes } = poisonedSource()
    const result = await captureRegionVerdict(ctx, "erase.character", spec)
    expect(result).not.toBeNull()
    expect(result?.observation?.note ?? "").not.toContain("refused the text snapshot")
    expect(result?.observation?.outcome).not.toBe("error")
    // The lifecycle opens with SGR reset and DECTCEM off. The extra clear this row once pinned is
    // reverted: it did not remove the stand-in on the arm, and the compared region is the cure.
    expect(writes.slice(0, 2)).toEqual(["\u001b[0m", "\u001b[?25l"])
    // The row's own clear is still written before its reads, and the leftover survives it here —
    // exactly the measured order, which is why a clear could never be the cure.
    expect(writes[2]).toBe("\u001b[2J\u001b[H")
  })

  it("still refuses by name when the compared region holds that same cell", async () => {
    const { ctx } = poisonedSource()
    await expect(
      captureRegionVerdict(ctx, "erase.character", { ...spec, region: { top: 1, left: 1, bottom: 1, right: 8 } }),
    ).rejects.toThrow(/row 1, column 1 holds U\+FFFD, the host's stand-in for a glyph longer than one UTF-16 unit/u)
  })
})
