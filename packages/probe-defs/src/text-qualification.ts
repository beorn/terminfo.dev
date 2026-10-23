import type { ProbeTarget, TextQualification, TextQualificationShape, TextQualificationSpec } from "./types.ts"

/** The mapping witnesses every recipe draws: paint a known grid, read it back, compare. */
const MAPPING_SHAPES = [
  "mid-line-gap",
  "trailing-gap",
  "soft-wrap",
  "prior-scrollback",
  "empty-last-row",
] as const satisfies readonly TextQualificationShape[]

/**
 * Each recipe, the observer context it qualifies, and the witnesses it requires. Assessment and
 * admission both read this one table, so a run is graded only by the recipe its own context names:
 * a Linux run that recorded the macOS recipe is neither admitted nor qualified.
 */
export const TEXT_QUALIFICATION_RECIPES = {
  "macos-text-cells-v1": { os: "macos", app: undefined, shapes: MAPPING_SHAPES },
  // Windows Terminal through UI Automation. The console host keeps its own copy of every cell, so
  // this recipe also proves, every run, that the observer reads the terminal's buffer (#30720).
  "windows-terminal-text-cells-v1": {
    os: "windows",
    app: "windows-terminal",
    shapes: [...MAPPING_SHAPES, "console-host-ownership"],
  },
} as const satisfies Record<string, { os: string; app: string | undefined; shapes: readonly TextQualificationShape[] }>

export type TextQualificationRecipe = keyof typeof TEXT_QUALIFICATION_RECIPES

/** This declaration describes retained witnesses, never a stored pass decision. */
export const TEXT_QUALIFICATION_SPEC = {
  version: 2,
  recipes: Object.keys(TEXT_QUALIFICATION_RECIPES) as TextQualificationRecipe[],
} as const satisfies TextQualificationSpec

export const TEXT_QUALIFICATION_SHAPES = [
  ...MAPPING_SHAPES,
  "console-host-ownership",
] as const satisfies readonly TextQualificationShape[]

/** The cell the ownership witness writes as U+0001, on its own cleared screen. */
export const TEXT_QUALIFICATION_OWNERSHIP_CELL = { row: 1, col: 1 } as const

/** The recipe for this run's observer context; undefined where no terminal-owned text observer exists. */
export function textQualificationRecipeFor(
  target: Pick<ProbeTarget, "kind" | "id" | "os">,
): TextQualificationRecipe | undefined {
  if (target.kind !== "app") return undefined
  const os = target.os?.toLowerCase()
  return (Object.keys(TEXT_QUALIFICATION_RECIPES) as TextQualificationRecipe[]).find((recipe) => {
    const context: { os: string; app: string | undefined } = TEXT_QUALIFICATION_RECIPES[recipe]
    return context.os === os && (context.app === undefined || context.app === target.id)
  })
}

/** A text observation is admitted when its run's context has a terminal-owned observer, the read
 * named no console host, and the suite declared the claim. Qualification is assessed separately. */
export function admitsTextObservation(
  run: { target: Pick<ProbeTarget, "kind" | "id" | "os">; textClaims?: readonly string[] },
  observation: { featureId: string; host?: unknown },
): boolean {
  return (
    textQualificationRecipeFor(run.target) !== undefined &&
    observation.host === undefined &&
    run.textClaims?.includes(observation.featureId) === true
  )
}

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
  run: {
    runId: string
    target: Pick<ProbeTarget, "kind" | "id" | "os">
    textQualification?: TextQualification
    textQualificationSpec?: TextQualificationSpec
  },
  snapshots?: ReadonlyMap<string, Uint8Array>,
): TextQualificationAssessment {
  const rejected = (reason: string): TextQualificationAssessment => ({
    qualified: false,
    reason: `Run ${run.runId}: ${reason}`,
  })
  const qualification = run.textQualification
  if (!qualification) return rejected("text qualification is absent")
  const declaration = run.textQualificationSpec
  const declared =
    declaration === undefined ? [] : declaration.version === 1 ? [declaration.recipe] : declaration.recipes
  const recipe = textQualificationRecipeFor(run.target)
  if (
    !declaration ||
    declaration.version !== qualification.version ||
    !declared.includes(qualification.recipe) ||
    !Object.hasOwn(TEXT_QUALIFICATION_RECIPES, qualification.recipe)
  ) {
    return rejected("text qualification version or recipe does not match the cited suite declaration and reader")
  }
  if (qualification.recipe !== recipe) {
    return rejected(
      `text qualification recipe ${qualification.recipe} is not the recipe for this run's observer context (${recipe ?? "none"})`,
    )
  }
  const required: readonly TextQualificationShape[] = TEXT_QUALIFICATION_RECIPES[recipe].shapes
  const { rows, cols } = qualification.grid
  const fixtures = textQualificationFixtures(rows, cols)
  if (typeof fixtures === "string") return rejected(fixtures)
  for (const fixture of fixtures.filter(({ shape }) => required.includes(shape))) {
    const witness = qualification.shapes.find(({ shape }) => shape === fixture.shape)
    if (!witness) return rejected(`missing text qualification shape ${fixture.shape}`)
    if (witness.reason !== undefined) return rejected(`text qualification shape ${fixture.shape}: ${witness.reason}`)
    if (witness.frames === undefined) return rejected(`text qualification shape ${fixture.shape} carries no frames`)
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
  if (required.includes("console-host-ownership")) {
    const witness = qualification.shapes.find(({ shape }) => shape === "console-host-ownership")
    if (!witness) return rejected("missing text qualification shape console-host-ownership")
    if (witness.reason !== undefined) {
      return rejected(`text qualification shape console-host-ownership: ${witness.reason}`)
    }
    const ownership = witness.ownership
    if (ownership === undefined) return rejected("text qualification shape console-host-ownership carries no witness")
    const { row, col } = TEXT_QUALIFICATION_OWNERSHIP_CELL
    if (ownership.cell.row !== row || ownership.cell.col !== col) {
      return rejected(
        `console-host-ownership witnessed row ${ownership.cell.row}, column ${ownership.cell.col}, not the written cell`,
      )
    }
    // The RAW row, before mapping: the mapping refuses U+0001 and its stand-in glyph alike.
    if (ownership.host !== "\u0001") {
      return rejected(
        `console-host-ownership: the console host holds ${codePoints(ownership.host)} at the written cell, not U+0001`,
      )
    }
    const observed = Array.from(ownership.observerRow)[col - 1]
    if (observed === undefined) {
      return rejected("console-host-ownership: the observer's row does not reach the written cell")
    }
    if (observed === "\u0001") {
      return rejected(
        "console-host-ownership: the observer read U+0001, so it reads the console host's buffer, not the terminal's",
      )
    }
  }
  return { qualified: true }
}

const codePoints = (text: string): string =>
  Array.from(
    text,
    (character) => `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
  ).join(" ") || "no character"
