import type { TextQualification, TextQualificationShape } from "./types.ts"

/** This recipe describes retained mapping witnesses, never a stored pass decision. */
export const TEXT_QUALIFICATION_SPEC = { version: 1, recipe: "macos-text-cells-v1" } as const

export const TEXT_QUALIFICATION_SHAPES = [
  "mid-line-gap",
  "trailing-gap",
  "soft-wrap",
  "prior-scrollback",
  "empty-last-row",
] as const satisfies readonly TextQualificationShape[]

export interface TextQualificationFixture {
  shape: TextQualificationShape
  controlRows: string[]
  targetRows: string[]
  controlWrites: string
  targetWrites: string
}

/** Paints characters only. The collector owns mode measurement and the existing lifecycle reset. */
export function textQualificationFixtures(rows: number, cols: number): TextQualificationFixture[] | string {
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 4 ||
    cols < Math.max(12, String(rows + 1).length + 1)
  ) {
    return `Text qualification needs at least four rows and twelve columns; received ${rows}x${cols}`
  }
  const cup = (row: number, col = 1): string => `\x1b[${row};${col}H`
  const blank = " ".repeat(cols)
  const pad = (value: string): string => value.padEnd(cols, " ")
  const empty = (): string[] => Array.from({ length: rows }, () => blank)
  // CUP after the bottom-right character cancels pending wrap before another operation.
  const paint = (grid: readonly string[]): string => grid.map((line, index) => cup(index + 1) + line).join("") + cup(1)
  const filled = Array.from({ length: rows }, () => "C".repeat(cols))
  const mid = empty()
  mid[0] = pad("A       B")
  mid[rows - 1] = pad("Z")
  const trailing = empty()
  trailing[0] = pad("A")
  trailing[1] = pad("B")
  trailing[rows - 1] = pad("Z")
  const wrapped = empty()
  wrapped[0] = "W".repeat(cols)
  wrapped[1] = pad("XY")
  const history = (start: number): string[] => Array.from({ length: rows }, (_, index) => pad(`H${start + index}`))
  const initialHistory = history(0)
  const overflowWrites = `\r\nH${rows}\r\nH${rows + 1}`
  const historyWrites = paint(empty()) + initialHistory.map((_, index) => `H${index}`).join("\r\n")
  return [
    {
      shape: "mid-line-gap",
      controlRows: filled,
      targetRows: mid,
      controlWrites: paint(filled),
      targetWrites: paint(empty()) + cup(1) + "A" + cup(1, 9) + "B" + cup(rows) + "Z",
    },
    {
      shape: "trailing-gap",
      controlRows: filled,
      targetRows: trailing,
      controlWrites: paint(filled),
      targetWrites: paint(empty()) + cup(1) + "A" + cup(2) + "B" + cup(rows) + "Z",
    },
    {
      shape: "soft-wrap",
      controlRows: filled,
      targetRows: wrapped,
      controlWrites: paint(filled),
      targetWrites: paint(empty()) + "W".repeat(cols) + "XY",
    },
    {
      shape: "prior-scrollback",
      controlRows: initialHistory,
      targetRows: history(2),
      controlWrites: historyWrites,
      targetWrites: overflowWrites,
    },
    {
      shape: "empty-last-row",
      controlRows: history(2),
      targetRows: [...history(3).slice(0, -1), blank],
      controlWrites: historyWrites + overflowWrites,
      targetWrites: "\r\n",
    },
  ]
}

export interface TextQualificationAssessment {
  qualified: boolean
  reason?: string
}

/** Assess retained mapping witnesses. Execution records this check; history uses it only for historical grading. */
export function assessTextQualification(
  run: { runId: string; textQualification?: TextQualification; textQualificationSpec?: typeof TEXT_QUALIFICATION_SPEC },
  snapshots?: ReadonlyMap<string, Uint8Array>,
): TextQualificationAssessment {
  const rejected = (reason: string): TextQualificationAssessment => ({
    qualified: false,
    reason: `Run ${run.runId}: ${reason}`,
  })
  const qualification = run.textQualification
  if (!qualification) return rejected("text qualification is absent")
  const declaration = run.textQualificationSpec
  if (
    !declaration ||
    declaration.version !== qualification.version ||
    declaration.recipe !== qualification.recipe ||
    qualification.version !== TEXT_QUALIFICATION_SPEC.version ||
    qualification.recipe !== TEXT_QUALIFICATION_SPEC.recipe
  ) {
    return rejected("text qualification version or recipe does not match the cited suite declaration and reader")
  }
  const { rows, cols } = qualification.grid
  const fixtures = textQualificationFixtures(rows, cols)
  if (typeof fixtures === "string") return rejected(fixtures)
  for (const fixture of fixtures) {
    const witness = qualification.shapes.find(({ shape }) => shape === fixture.shape)
    if (!witness) return rejected(`missing text qualification shape ${fixture.shape}`)
    if (witness.reason !== undefined) return rejected(`text qualification shape ${fixture.shape}: ${witness.reason}`)
    if (
      witness.frames.length !== 2 ||
      witness.frames.filter((frame) => frame.role === "control").length !== 1 ||
      witness.frames.filter((frame) => frame.role === "target").length !== 1
    ) {
      return rejected(`text qualification shape ${fixture.shape} requires exactly one control and one target frame`)
    }
    for (const role of ["control", "target"] as const) {
      const frame = witness.frames.find((entry) => entry.role === role)
      if (!frame) return rejected(`text qualification shape ${fixture.shape} has no ${role}`)
      const rectangle = frame.cellRectangle
      if (
        rectangle.top !== 1 ||
        rectangle.left !== 1 ||
        rectangle.bottom !== rows ||
        rectangle.right !== cols ||
        frame.cellDigest !== frame.ref ||
        frame.frameDigest !== frame.ref
      ) {
        return rejected(`text qualification shape ${fixture.shape} ${role} is not the full retained grid`)
      }
      const bytes = snapshots?.get(frame.ref)
      if (!bytes) {
        return rejected(
          `text qualification shape ${fixture.shape} ${role} has no verified retained bytes for ${frame.ref}`,
        )
      }
      const expected = role === "control" ? fixture.controlRows : fixture.targetRows
      if (Buffer.from(bytes).toString("utf8") !== expected.join("\n")) {
        return rejected(`text qualification shape ${fixture.shape} ${role} does not match the expected character grid`)
      }
    }
  }
  return { qualified: true }
}
