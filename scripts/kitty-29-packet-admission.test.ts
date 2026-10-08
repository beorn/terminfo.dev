#!/usr/bin/env bun
/**
 * The reviewed Kitty interpretation packets are admitted, with their packet grades intact.
 *
 * The packets (#27917 leg, #15323 goal 3) replace the legacy automated Kitty rows with an
 * independently second-reviewed record per feature and clipboard profile. What this test pins is
 * the content the admission wrote, because that is the part a later change can silently undo: the
 * two non-supported packets must never be upgraded to `supported`, and no record may lose its
 * sources.
 *
 * It deliberately does NOT bind the site selection: these packets cite runs from pre-freeze suites
 * (014b255c9130, e150bdbfd817) that this tree cannot declare, so no run is loaded and no site row
 * moves until a compatible run is admitted.
 *
 * `text.basic` is HELD, not missing by oversight: its packet record is a presentation
 * (`presentsEvidence`), and a presentation must name a loaded raw run (selected-results.ts
 * "does not name a raw run"), which its unusable run cannot be. Re-adding that shape breaks the
 * reader by name, so the assertion below keeps it out until a run it can bind to is admitted.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { parseInterpretations } from "../docs/data/selected-results.ts"

const CONTENT = join(dirname(fileURLToPath(import.meta.url)), "..", "content")
const INTERPRETATIONS = join(CONTENT, "interpretations.json")

/** The 29 `interpretation-ready` members of turn362-kitty-work-kinds.json. */
const FEATURES = [
  "charsets.dec-line-drawing",
  "charsets.g0-g1-switching",
  "scrollback.alt-screen",
  "scrollback.decstbm",
  "scrollback.decstbm-reset",
  "scrollback.reverse-index",
  "scrollback.scroll-down",
  "scrollback.scroll-up",
  "scrollback.set-region",
  "sgr.bg.256",
  "sgr.bg.bright",
  "sgr.bg.default",
  "sgr.bg.standard",
  "sgr.bg.truecolor",
  "sgr.fg.256",
  "sgr.fg.bright",
  "sgr.fg.default",
  "sgr.fg.standard",
  "sgr.fg.truecolor",
  "sgr.reset",
  "sgr.selective-reset.bold",
  "sgr.selective-reset.inverse",
  "sgr.selective-reset.italic",
  "sgr.selective-reset.underline",
  "sgr.underline-color-indexed",
  "sgr.underline-color-reset",
  "text.basic",
  "text.overwrite",
  "text.reverse-index-scroll",
] as const

/** The one packet whose honest grade is "not separable at this font/size". */
const INCONCLUSIVE = "sgr.selective-reset.italic"
/** The one packet held back: presentation shape, and its run cannot load. */
const HELD = "text.basic"

type Row = Record<string, unknown>

function loadRows(): Row[] {
  const source = readFileSync(INTERPRETATIONS, "utf8")
  const catalog = Object.keys(JSON.parse(readFileSync(join(CONTENT, "features.json"), "utf8")) as Row).filter(
    (id) => !id.startsWith("$"),
  )
  expect(() => parseInterpretations("interpretations.json", source, catalog)).not.toThrow()
  return JSON.parse(source) as Row[]
}

function isAdmittedPacket(row: Row): boolean {
  const reviewer = row.reviewer
  const scope = row.scope as Row | undefined
  const target = scope?.target as Row | undefined
  return (
    typeof reviewer === "string" && reviewer.includes("@dev/luna4") && target?.kind === "app" && target?.id === "kitty"
  )
}

describe("the reviewed Kitty packets are admitted", () => {
  const admitted = loadRows().filter(isAdmittedPacket)

  test("every packet is present, once per clipboard profile", () => {
    expect(new Set(admitted.map((row) => row.featureId))).toEqual(new Set(FEATURES.filter((id) => id !== HELD)))
    expect(admitted).toHaveLength((FEATURES.length - 1) * 3)
    for (const row of admitted) {
      expect((row.sources as string[]).length).toBeGreaterThan(0)
      expect(row.supersedes).toEqual([])
    }
  })

  test("the grades are the packets' own, never upgraded", () => {
    const graded = admitted.filter((row) => row.observation !== undefined)
    expect(graded).toHaveLength(admitted.length)
    const supported = graded.filter((row) => (row.observation as Row).outcome === "supported")
    const inconclusive = graded.filter((row) => (row.observation as Row).outcome === "inconclusive")
    expect(supported).toHaveLength((FEATURES.length - 2) * 3)
    expect(new Set(inconclusive.map((row) => row.featureId))).toEqual(new Set([INCONCLUSIVE]))
    expect(inconclusive).toHaveLength(3)
  })

  test("the held packet is not admitted in the shape the reader refuses", () => {
    expect(admitted.some((row) => row.featureId === HELD)).toBe(false)
  })

  test("each record names the packet's own suite and version", () => {
    const suites = new Set<string>()
    for (const row of admitted) {
      const scope = row.scope as Row
      expect(scope.versions).toEqual(["0.49.2", "0.49.2"])
      for (const suite of scope.suites as string[]) suites.add(suite)
    }
    expect(suites).toEqual(new Set(["014b255c9130", "e150bdbfd817"]))
  })
})
