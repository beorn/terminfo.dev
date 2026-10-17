/**
 * @failure A text frame's whole-screen digest is taken over a cropped rectangle, its attributes are
 *   dropped from a digest, or its ref names bytes the artifact directory does not hold — so two
 *   frames are compared over different cells and a refused read is graded as an empty screen.
 * @level l1
 * @consumer collectProbeRun's text-snapshot adapter, the one place a text frame is built.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { textCellsFrame } from "./serve.ts"

const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const checkpoint = { role: "target" as const, label: "after erase" }

const textRead = (text: readonly string[], droppedLines = 2) => ({
  status: "read" as const,
  app: "iterm2" as const,
  cells: {
    cols: Math.max(...text.map((row) => row.length), 1),
    rows: text.length,
    text,
    paddedRows: [],
    droppedLines,
  },
})

const consoleRead = (text: readonly string[], attributes: readonly (readonly number[])[]) => ({
  status: "read" as const,
  grid: { cols: Math.max(...text.map((row) => row.length), 1), rows: text.length, text, attributes },
  bufferOwner: { image: "OpenConsole.exe" as const, pid: 4242, ppid: 100 },
})

describe("textCellsFrame — one screen, one rectangle, one set of bytes", () => {
  it("digests the whole screen as the frame ref and the named rectangle as the cell digest", () => {
    const read = textRead(["abcdef", "ghijkl", "mnopqr"])
    const whole = textCellsFrame(checkpoint, read, 7)
    const part = textCellsFrame({ ...checkpoint, cells: { top: 2, left: 2, bottom: 3, right: 4 } }, read, 8)

    // The whole visible rect is both digests at once: nothing was cropped, so they name one read.
    expect(whole.frame.cellDigest).toBe(whole.frame.frameDigest)
    // A sub-rectangle is the only case where they differ, and the frame digest still sees the screen.
    expect(part.frame.cellDigest).not.toBe(part.frame.frameDigest)
    expect(part.frame.frameDigest).toBe(whole.frame.frameDigest)
    expect(part.frame.cellRectangle).toEqual({ top: 2, left: 2, bottom: 3, right: 4 })
  })

  it("puts attributes into the frame digest and into the cell digest of the rectangle they cover", () => {
    const text = ["ab", "cd"]
    const same = textCellsFrame(
      checkpoint,
      consoleRead(text, [
        [7, 7],
        [7, 7],
      ]),
      1,
    )
    const changed = textCellsFrame(
      checkpoint,
      consoleRead(text, [
        [7, 9],
        [7, 7],
      ]),
      1,
    )
    expect(changed.frame.frameDigest).not.toBe(same.frame.frameDigest)
    expect(changed.frame.cellDigest).not.toBe(same.frame.cellDigest)

    // An attribute under the rectangle changes its cell digest; one outside it does not, but still
    // moves the frame digest, because the frame is the whole screen.
    const cells = { top: 1, left: 1, bottom: 1, right: 2 }
    const inside = (attributes: readonly (readonly number[])[]) =>
      textCellsFrame({ ...checkpoint, cells }, consoleRead(text, attributes), 1)
    expect(
      inside([
        [7, 9],
        [7, 7],
      ]).frame.cellDigest,
    ).not.toBe(
      inside([
        [7, 7],
        [7, 7],
      ]).frame.cellDigest,
    )
    expect(
      inside([
        [7, 7],
        [7, 9],
      ]).frame.cellDigest,
    ).toBe(
      inside([
        [7, 7],
        [7, 7],
      ]).frame.cellDigest,
    )
    expect(
      inside([
        [7, 7],
        [7, 9],
      ]).frame.frameDigest,
    ).not.toBe(
      inside([
        [7, 7],
        [7, 7],
      ]).frame.frameDigest,
    )
  })

  it("hashes the retained bytes, so the artifact is exactly the snapshot the ref names", () => {
    // Attributes are part of the retained bytes, so a ref taken over the characters alone would
    // name an artifact the directory does not hold.
    const result = textCellsFrame(
      checkpoint,
      consoleRead(
        ["ab", "cd "],
        [
          [7, 7],
          [7, 7],
        ],
      ),
      4,
    )
    expect(result.frame.ref).toBe(sha(result.retained))
    expect(result.frame.frameDigest).toBe(result.frame.ref)
    expect(result.retained.toString("utf8")).toBe("ab\ncd \n#attributes\n7,7\n7,7")
    expect(result.trace.retained).toBe(`${result.frame.ref.slice("sha256:".length)}.txt`)
  })

  it("carries the macOS dropped and padded counts, and the console host that owns the buffer", () => {
    const mac = textCellsFrame(checkpoint, textRead(["ab", "cd "], 5), 1)
    expect(mac.trace).toMatchObject({ droppedLines: 5, paddedRows: [], source: "the terminal's own text snapshot" })
    const windows = textCellsFrame(checkpoint, consoleRead(["ab"], [[7, 7]]), 1)
    expect(windows.trace).toMatchObject({ bufferOwner: { image: "OpenConsole.exe", pid: 4242, ppid: 100 } })
    expect(windows.trace).not.toHaveProperty("droppedLines")
  })

  it("throws naming the checkpoint when the terminal refused the read", () => {
    expect(() => textCellsFrame(checkpoint, { status: "refused", reason: "iTerm2 is not frontmost" }, 1)).toThrow(
      /after erase: the terminal refused the text snapshot — iTerm2 is not frontmost/u,
    )
  })

  it("refuses a rectangle the read does not cover before any bytes are returned for retention", () => {
    expect(() =>
      textCellsFrame({ ...checkpoint, cells: { top: 1, left: 1, bottom: 4, right: 2 } }, textRead(["ab"]), 1),
    ).toThrow(/asks for rows 1-4 and columns 1-2 of a 1x2 text read/u)
  })
})
