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
import {
  initializeRunDraft,
  textQualificationFixtures,
  TEXT_QUALIFICATION_SPEC,
  type CapturedRunDraft,
  type TextCellsObservationFrame,
} from "@terminfo/probe-defs"
import { recordTextQualificationChecks } from "./text-qualification.ts"
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

const consoleRead = (
  text: readonly string[],
  attributes: readonly (readonly number[])[],
  standIns: readonly { row: number; column: number; standIn: "U+FFFD" }[] = [],
) => ({
  status: "read" as const,
  grid: { cols: Math.max(...text.map((row) => row.length), 1), rows: text.length, text, attributes },
  bufferOwner: {
    image: "OpenConsole.exe" as const,
    pid: 4242,
    ppid: 100,
    executablePath: "C:\\Windows\\System32\\OpenConsole.exe",
    executableSha256: `sha256:${"a".repeat(64)}`,
  },
  standIns,
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

  it("measures its own rectangle past a stand-in outside it, and names that cell in the trace", () => {
    // The specimen from the 2026-10-18 Windows run: text.wide.emoji-zwj left the host's stand-in at
    // row 1, column 1, and the next 25 rows refused the whole window before cropping to their own
    // cells. The stand-in is still exactly what the host held, so it stays in the whole digest; it
    // is the READING that the rectangle withholds.
    const withStandIn = consoleRead(
      ["\ufffd ", "ab"],
      [
        [7, 7],
        [7, 7],
      ],
      [{ row: 1, column: 1, standIn: "U+FFFD" }],
    )
    const other = consoleRead(
      ["x ", "ab"],
      [
        [7, 7],
        [7, 7],
      ],
    )
    const cells = { top: 2, left: 1, bottom: 2, right: 2 }
    const measured = textCellsFrame({ ...checkpoint, cells }, withStandIn, 1)
    const replaced = textCellsFrame({ ...checkpoint, cells }, other, 1)
    expect(measured.frame.cellDigest).toBe(replaced.frame.cellDigest)
    // Nothing was dropped from the frame: the stand-in is in the whole digest as the host wrote it.
    expect(measured.frame.frameDigest).not.toBe(replaced.frame.frameDigest)
    expect(measured.frame.frameDigest).toBe(measured.frame.ref)
    // Compare against the digest of these exact bytes, not against another live read: a frame that
    // blanked or dropped the stand-in would still differ from the "x" read above, and only the
    // literal expectation below fails when the cell stops being U+FFFD.
    expect(measured.retained.toString("utf8")).toBe("\ufffd \nab\n#attributes\n7,7\n7,7")
    expect(measured.frame.frameDigest).toBe(sha(Buffer.from("\ufffd \nab\n#attributes\n7,7\n7,7")))
    expect(measured.trace.standIns).toEqual([{ row: 1, column: 1, standIn: "U+FFFD" }])
    expect(replaced.trace).not.toHaveProperty("standIns")
  })

  it("refuses a stand-in on the rectangle's last column, and names one a column past it", () => {
    // The inside row above still passes if the right edge is exclusive, because its stand-in sits at
    // the rectangle's first cell. These two cells pin the edge itself: column 4 of a rectangle that
    // ends at 4 is compared and refuses; column 4 of one that ends at 3 is named in the trace.
    const read = consoleRead(
      ["abc\ufffd", "efgh"],
      [
        [7, 7, 7, 7],
        [7, 7, 7, 7],
      ],
      [{ row: 1, column: 4, standIn: "U+FFFD" }],
    )
    expect(() => textCellsFrame({ ...checkpoint, cells: { top: 1, left: 2, bottom: 1, right: 4 } }, read, 1)).toThrow(
      /row 1, column 4 holds U\+FFFD/u,
    )
    const past = textCellsFrame({ ...checkpoint, cells: { top: 1, left: 2, bottom: 1, right: 3 } }, read, 1)
    expect(past.trace.standIns).toEqual([{ row: 1, column: 4, standIn: "U+FFFD" }])
  })

  it("refuses a stand-in inside the cells it compares, by name and position", () => {
    const read = consoleRead(
      ["\ufffd ", "ab"],
      [
        [7, 7],
        [7, 7],
      ],
      [{ row: 1, column: 1, standIn: "U+FFFD" }],
    )
    expect(() => textCellsFrame({ ...checkpoint, cells: { top: 1, left: 1, bottom: 1, right: 2 } }, read, 1)).toThrow(
      /after erase: the terminal refused the text snapshot — row 1, column 1 holds U\+FFFD, the host's stand-in for a glyph longer than one UTF-16 unit, and this checkpoint compares that cell/u,
    )
    // No named rectangle means the whole window is compared, so the same stand-in refuses there too.
    expect(() => textCellsFrame(checkpoint, read, 1)).toThrow(/row 1, column 1 holds U\+FFFD/u)
  })

  it("keeps an integrity refusal unscoped: bytes the host never wrote are not a stand-in", () => {
    // A NUL with no attribute is not content the host wrote; it is a clipped or stale read, and no
    // checkpoint rectangle moves that refusal off the read.
    const read = {
      status: "refused" as const,
      reason:
        "row 1, column 1 decodes as NUL with no attribute; the console writes a blank cell as U+0020 with the fill attribute, so this cell was never written",
    }
    expect(() => textCellsFrame({ ...checkpoint, cells: { top: 2, left: 1, bottom: 2, right: 1 } }, read, 1)).toThrow(
      /the terminal refused the text snapshot — row 1, column 1 decodes as NUL with no attribute/u,
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
    expect(windows.trace).toMatchObject({
      bufferOwner: {
        image: "OpenConsole.exe",
        pid: 4242,
        ppid: 100,
        executablePath: "C:\\Windows\\System32\\OpenConsole.exe",
        executableSha256: `sha256:${"a".repeat(64)}`,
      },
    })
    expect(windows.trace).not.toHaveProperty("droppedLines")
    // The label must say what the collector recorded: the host's image, the executable path and its
    // digest. A host whose executable cannot be resolved is refused before a frame exists, so no
    // "not recorded" arm survives here (30042).
    expect(windows.trace.source).toBe(
      `the console host's buffer (OpenConsole.exe); executable C:\\Windows\\System32\\OpenConsole.exe sha256:${"a".repeat(64)}`,
    )
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

// Current status must be fixed at execution. Historical-only qualification tests missed a live
// text Supported result whose mapping oracle was absent or attempted and broken.
it("records text qualification attempts before seal, distinguishing absent and broken oracles", () => {
  const featureId = "text.overwrite"
  const manifest = {
    probeHash: "text-suite",
    adapterVersion: "3",
    catalogIds: [featureId],
    probes: { app: [featureId], headless: [], mux: [] },
    textClaims: [featureId],
    textQualification: TEXT_QUALIFICATION_SPEC,
  }
  const base = initializeRunDraft({
    runId: "text-execution",
    sourceRevision: "a".repeat(40),
    manifest,
    intendedContext: { kind: "app", id: "iterm2" },
  })
  const run: CapturedRunDraft = {
    ...base,
    target: {
      kind: "app",
      id: "iterm2",
      version: "1",
      os: "macos",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    origin: { kind: "collector" },
    measuredAt: "2026-10-21T05:00:00.000Z",
  }
  const attempt = { scope: "probe" as const, startedAt: run.measuredAt }
  run.results[0] = {
    featureId,
    status: "supported",
    attempt,
    evidence: "text",
    checks: [{ id: "criterion", status: "supported", attempt }],
  }
  const fixtures = textQualificationFixtures(4, 12)
  if (typeof fixtures === "string") throw new Error(fixtures)
  const snapshots = new Map<string, Uint8Array>()
  const frame = (rows: readonly string[], role: "control" | "target"): TextCellsObservationFrame => {
    const captured = textCellsFrame({ role, label: role }, textRead(rows, 0), 1)
    snapshots.set(captured.frame.ref, captured.retained)
    return captured.frame as TextCellsObservationFrame
  }
  run.textQualification = {
    ...TEXT_QUALIFICATION_SPEC,
    grid: { rows: 4, cols: 12 },
    shapes: fixtures.map((fixture) => ({
      shape: fixture.shape,
      frames: [frame(fixture.controlRows, "control"), frame(fixture.targetRows, "target")],
    })),
  }
  const qualified = structuredClone(run)
  recordTextQualificationChecks(qualified, manifest, snapshots, attempt)
  expect(qualified.results[0]!.status).toBe("supported")
  expect(qualified.results[0]!.checks.find((check) => check.id === "text-qualification")?.attempt).toEqual(attempt)
  const unattempted = structuredClone(run)
  recordTextQualificationChecks(unattempted, manifest, snapshots)
  expect(unattempted.results[0]!.status).toBe("test-todo")
  expect(unattempted.results[0]!.checks.find((check) => check.id === "text-qualification")?.attempt).toEqual({
    scope: "none",
  })
  const corrupted = new Map(snapshots)
  corrupted.set(run.textQualification.shapes[0]!.frames![0]!.ref, Buffer.from("wrong grid"))
  recordTextQualificationChecks(run, manifest, corrupted, attempt)
  expect(run.results[0]!.status).toBe("test-failure")
  expect(run.results[0]!.checks.find((check) => check.id === "text-qualification")?.reason).toContain(
    "expected character grid",
  )
})
