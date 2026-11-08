/**
 * @failure A text observer is graded outside the context its recipe qualifies: a Linux run that
 *   recorded the macOS recipe is admitted, or a Windows Terminal run passes while its observer reads
 *   the console host's buffer (U+0001 where the terminal shows a glyph), so a host's verdict is
 *   published as the terminal's (#30720, @cto 5a737c28 and 79a35617).
 * @level l1
 * @consumer recordTextQualificationTests (collector) and parseProbeResults (reader), through
 *   admitsTextObservation and assessTextQualification.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  admitsTextObservation,
  assessTextQualification,
  TEXT_QUALIFICATION_SPEC,
  textQualificationFixtures,
  textQualificationRecipeFor,
} from "./text-qualification.ts"
import type { ProbeSubject, TextCellsObservationFrame, TextQualification, TextQualificationSpec } from "./types.ts"

const ROWS = 4
const COLS = 12
const subject = (os: string, id: string, kind: ProbeSubject["kind"] = "term") => ({ kind, id, os })
const macos = subject("macos", "iterm2")
const windowsTerminal = subject("windows", "windows-terminal")

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
  runTarget: { kind: ProbeSubject["kind"]; id: string; os: string },
  recipe: string,
  extra: TextQualification["shapes"] = [],
  spec: TextQualificationSpec = TEXT_QUALIFICATION_SPEC,
) {
  const { shapes, snapshots } = witnesses()
  return {
    run: {
      runId: "r",
      subject: runTarget,
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
  it("keeps a retained version-1 suite's macOS qualification", () => {
    const retained = JSON.parse(
      readFileSync(new URL("../../../content/suites/00da53623456.json", import.meta.url), "utf8"),
    ) as { textQualification: TextQualificationSpec }
    expect(retained.textQualification).toEqual({ version: 1, recipe: "macos-text-cells-v1" })
    const recorded = run(macos, "macos-text-cells-v1", [], retained.textQualification)
    expect(assessTextQualification(recorded.run, recorded.snapshots)).toEqual({ qualified: true })
  })

  it.each([
    [1, "windows-terminal-text-cells-v1"],
    [2, "macos-text-cells-v1"],
    [3, "macos-text-cells-v1"],
  ])("retains version %s but refuses its unsupported recipe declaration", (version, recipe) => {
    const recorded = run(
      recipe === "windows-terminal-text-cells-v1" ? windowsTerminal : macos,
      recipe,
      [ownership("\u0001", "☺           ")],
      { version, recipe },
    )
    const assessment = assessTextQualification(recorded.run, recorded.snapshots)
    expect(assessment.qualified).toBe(false)
    expect(assessment.reason).toContain(`version ${version}`)
    expect(assessment.reason).toContain(recipe)
  })

  it("refuses the Windows recipe on a macOS subject", () => {
    const recorded = run(macos, "windows-terminal-text-cells-v1", [ownership("\u0001", "☺           ")])
    expect(assessTextQualification(recorded.run, recorded.snapshots).reason).toContain(
      "is not the recipe for this run's observer context",
    )
  })

  it("names one recipe per observer context and none elsewhere", () => {
    expect(textQualificationRecipeFor(macos)).toBe("iterm2-api-text-cells-v1")
    expect(textQualificationRecipeFor(subject("macOS", "terminal-app"))).toBe("macos-text-cells-v1")
    expect(textQualificationRecipeFor(windowsTerminal)).toBe("windows-terminal-text-cells-v1")
    expect(textQualificationRecipeFor(subject("windows", "alacritty"))).toBeUndefined()
    expect(textQualificationRecipeFor(subject("linux", "kitty"))).toBeUndefined()
    expect(textQualificationRecipeFor(subject("macos", "tmux", "mux"))).toBeUndefined()
  })

  it("qualifies the iTerm API recipe only on iTerm while retaining declared older macOS recipes", () => {
    const current = run(macos, "iterm2-api-text-cells-v1")
    expect(assessTextQualification(current.run, current.snapshots)).toEqual({ qualified: true })
    const old = run(macos, "macos-text-cells-v1")
    expect(assessTextQualification(old.run, old.snapshots)).toEqual({ qualified: true })
    const wrong = run(subject("macos", "terminal-app"), "iterm2-api-text-cells-v1")
    expect(assessTextQualification(wrong.run, wrong.snapshots).qualified).toBe(false)
  })

  it("admits only a declared, host-free text read in a recipe's context", () => {
    const claims = { textClaims: ["text.overwrite"] }
    const read = { featureId: "text.overwrite" }
    expect(admitsTextObservation({ subject: windowsTerminal, ...claims }, read)).toBe(true)
    expect(admitsTextObservation({ subject: macos, ...claims }, read)).toBe(true)
    expect(admitsTextObservation({ subject: subject("windows", "alacritty"), ...claims }, read)).toBe(false)
    expect(
      admitsTextObservation({ subject: windowsTerminal, ...claims }, { ...read, host: { image: "OpenConsole.exe" } }),
    ).toBe(false)
    expect(admitsTextObservation({ subject: windowsTerminal }, read)).toBe(false)
  })

  // @cto 79a35617: a non-macOS run recording macos-text-cells-v1 is not admitted, and its record does not qualify.
  it("neither admits nor qualifies a Linux run that recorded the macOS recipe", () => {
    const linux = subject("linux", "kitty")
    const { run: recorded, snapshots } = run(linux, "macos-text-cells-v1")
    expect(
      admitsTextObservation({ subject: linux, textClaims: ["text.overwrite"] }, { featureId: "text.overwrite" }),
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
