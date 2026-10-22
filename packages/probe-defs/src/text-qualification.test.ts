/**
 * @failure A text observer is graded outside the context its recipe qualifies: a Linux run that
 *   recorded the macOS recipe is admitted, or a Windows Terminal run passes while its observer reads
 *   the console host's buffer (U+0001 where the terminal shows a glyph), so a host's verdict is
 *   published as the terminal's (#30720, @cto 5a737c28 and 79a35617).
 * @level l1
 * @consumer recordTextQualificationChecks (collector) and isConclusiveObservation (site), through
 *   admitsTextObservation and assessTextQualification.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  admitsTextObservation,
  assessTextQualification,
  TEXT_QUALIFICATION_SPEC,
  textQualificationFixtures,
  textQualificationRecipeFor,
} from "./text-qualification.ts"
import type { ProbeTarget, TextCellsObservationFrame, TextQualification, TextQualificationSpec } from "./types.ts"

const ROWS = 4
const COLS = 12
const target = (os: string, id: string, kind: ProbeTarget["kind"] = "app") => ({ kind, id, os })
const macos = target("macos", "iterm2")
const windowsTerminal = target("windows", "windows-terminal")

function witnesses(): { shapes: TextQualification["shapes"]; snapshots: Map<string, Uint8Array> } {
  const fixtures = textQualificationFixtures(ROWS, COLS)
  if (typeof fixtures === "string") throw new Error(fixtures)
  const snapshots = new Map<string, Uint8Array>()
  const frame = (rows: readonly string[], role: "control" | "target"): TextCellsObservationFrame => {
    const bytes = Buffer.from(rows.join("\n"), "utf8")
    const ref = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    snapshots.set(ref, bytes)
    return {
      kind: "text-cells",
      role,
      label: role,
      capturedAt: 1,
      ref,
      cellDigest: ref,
      frameDigest: ref,
      cellRectangle: { top: 1, left: 1, bottom: ROWS, right: COLS },
    }
  }
  const shapes = fixtures.map((fixture) => ({
    shape: fixture.shape,
    frames: [frame(fixture.controlRows, "control"), frame(fixture.targetRows, "target")],
  }))
  return { shapes, snapshots }
}

const ownership = (host: string, observerRow: string) => ({
  shape: "console-host-ownership" as const,
  ownership: { cell: { row: 1, col: 1 }, host, observerRow },
})

function run(
  runTarget: { kind: ProbeTarget["kind"]; id: string; os: string },
  recipe: string,
  extra: TextQualification["shapes"] = [],
  spec: TextQualificationSpec = TEXT_QUALIFICATION_SPEC,
) {
  const { shapes, snapshots } = witnesses()
  return {
    run: {
      runId: "r",
      target: runTarget,
      textQualificationSpec: spec,
      textQualification: {
        version: spec.version,
        recipe,
        grid: { rows: ROWS, cols: COLS },
        shapes: [...shapes, ...extra],
      },
    },
    snapshots,
  }
}

describe("text qualification recipes", () => {
  it("names one recipe per observer context and none elsewhere", () => {
    expect(textQualificationRecipeFor(macos)).toBe("macos-text-cells-v1")
    expect(textQualificationRecipeFor(target("macOS", "terminal-app"))).toBe("macos-text-cells-v1")
    expect(textQualificationRecipeFor(windowsTerminal)).toBe("windows-terminal-text-cells-v1")
    expect(textQualificationRecipeFor(target("windows", "alacritty"))).toBeUndefined()
    expect(textQualificationRecipeFor(target("linux", "kitty"))).toBeUndefined()
    expect(textQualificationRecipeFor(target("macos", "tmux", "mux"))).toBeUndefined()
  })

  it("admits only a declared, host-free text read in a recipe's context", () => {
    const claims = { textClaims: ["text.overwrite"] }
    const read = { featureId: "text.overwrite" }
    expect(admitsTextObservation({ target: windowsTerminal, ...claims }, read)).toBe(true)
    expect(admitsTextObservation({ target: macos, ...claims }, read)).toBe(true)
    expect(admitsTextObservation({ target: target("windows", "alacritty"), ...claims }, read)).toBe(false)
    expect(
      admitsTextObservation({ target: windowsTerminal, ...claims }, { ...read, host: { image: "OpenConsole.exe" } }),
    ).toBe(false)
    expect(admitsTextObservation({ target: windowsTerminal }, read)).toBe(false)
  })

  // @cto 79a35617: a non-macOS run recording macos-text-cells-v1 is not admitted, and its record does not qualify.
  it("neither admits nor qualifies a Linux run that recorded the macOS recipe", () => {
    const linux = target("linux", "kitty")
    const { run: recorded, snapshots } = run(linux, "macos-text-cells-v1")
    expect(
      admitsTextObservation({ target: linux, textClaims: ["text.overwrite"] }, { featureId: "text.overwrite" }),
    ).toBe(false)
    expect(assessTextQualification(recorded, snapshots)).toEqual({
      qualified: false,
      reason:
        "Run r: text qualification recipe macos-text-cells-v1 is not the recipe for this run's observer context (none)",
    })
  })

  it("qualifies a macOS run on the version-2 declaration and on the committed version-1 form", () => {
    const current = run(macos, "macos-text-cells-v1")
    expect(assessTextQualification(current.run, current.snapshots)).toEqual({ qualified: true })
    const committed = run(macos, "macos-text-cells-v1", [], { version: 1, recipe: "macos-text-cells-v1" })
    expect(assessTextQualification(committed.run, committed.snapshots)).toEqual({ qualified: true })
    const mixed = run(macos, "macos-text-cells-v1", [], { version: 1, recipe: "macos-text-cells-v1" })
    mixed.run.textQualification.version = 2
    expect(assessTextQualification(mixed.run, mixed.snapshots).qualified).toBe(false)
  })

  it("qualifies Windows Terminal only when the host holds U+0001 and the observer does not", () => {
    const recipe = "windows-terminal-text-cells-v1"
    const passed = run(windowsTerminal, recipe, [ownership("\u0001", "☺           ")])
    expect(assessTextQualification(passed.run, passed.snapshots)).toEqual({ qualified: true })
    const hostRead = run(windowsTerminal, recipe, [ownership("\u0001", "\u0001           ")])
    expect(assessTextQualification(hostRead.run, hostRead.snapshots).reason).toContain(
      "the observer read U+0001, so it reads the console host's buffer, not the terminal's",
    )
    const notWritten = run(windowsTerminal, recipe, [ownership(" ", "☺           ")])
    expect(assessTextQualification(notWritten.run, notWritten.snapshots).reason).toContain(
      "the console host holds U+0020 at the written cell, not U+0001",
    )
    const refused = run(windowsTerminal, recipe, [{ shape: "console-host-ownership", reason: "UIA refused" }])
    expect(assessTextQualification(refused.run, refused.snapshots).reason).toContain(
      "text qualification shape console-host-ownership: UIA refused",
    )
    const missing = run(windowsTerminal, recipe)
    expect(assessTextQualification(missing.run, missing.snapshots).reason).toContain(
      "missing text qualification shape console-host-ownership",
    )
  })

  it("refuses a Windows Terminal run that recorded the macOS recipe", () => {
    const { run: recorded, snapshots } = run(windowsTerminal, "macos-text-cells-v1")
    expect(assessTextQualification(recorded, snapshots).reason).toContain(
      "is not the recipe for this run's observer context (windows-terminal-text-cells-v1)",
    )
  })
})
