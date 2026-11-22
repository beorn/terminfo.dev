/**
 * #37761 (@cto 9de3bba2, e81def55): an observer-only switch is recorded beside a run, never in the configuration that
 * names its context. Run f2781665's five iTerm2 prompt-mark cells were read through iTerm2's API server; they publish
 * that in words, the iTerm2 page names the switch, and the context key stays the one without it.
 *
 * @failure The five iTerm2 prompt-mark cells publish with no word that an observer-only switch read them, the
 *   terminal page omits the switch, or a supplement row naming an unknown run, feature or empty note builds silently.
 * @level l1
 * @consumer terminfo.dev /terminals/iterm2 and the osc133 feature pages (content/run-observers.json, #37761)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadFullProbes } from "../docs/data/probes.data.ts"
import { loadRunObservers } from "../docs/data/run-observers.ts"

const RUN = "f2781665ede724094f5f4011fee465bd"
const CELLS = [
  "extensions.osc133-a",
  "extensions.osc133-b",
  "extensions.osc133-c",
  "extensions.osc133-d",
  "extensions.semantic-prompts",
]

describe("run f2781665's observer switch", () => {
  const data = loadFullProbes()
  const key = Object.keys(data.selectedByBackend).find((name) =>
    Object.values(data.selectedByBackend[name]!.selected.featureResults).some((cell) => cell.origin.runId === RUN),
  )

  it("is selected for one context, keyed without the switch", () => {
    expect(key, "run f2781665 still supplies a published cell").toBeDefined()
    expect(data.selectedByBackend[key!]!.selected.subject).toMatchObject({ id: "iterm2", config: null })
  })

  it("puts its note on each of the five cells it read, and on no other cell", () => {
    const { note } = loadRunObservers(join(import.meta.dirname, "..", "content"), new Set(CELLS))[RUN]!
    const noted = Object.entries(data.notes[key!] ?? {}).flatMap(([id, text]) => (text.includes(note) ? [id] : []))
    expect(noted.sort()).toEqual(
      CELLS.filter((id) => data.selectedByBackend[key!]!.selected.featureResults[id]?.origin.runId === RUN).sort(),
    )
    expect(noted.length).toBe(5)
  })

  it("names the switch for the page beside the run's configuration", () => {
    expect(data.observers).toEqual({ [RUN]: ["iterm2: EnableAPIServer true"] })
  })
})

describe("loadRunObservers refuses by name", () => {
  const write = (body: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "terminfo-run-observers-"))
    mkdirSync(join(dir, "probes-apps"))
    writeFileSync(join(dir, "probes-apps", `iterm2-3.6.11-macos-${RUN}.json`), "{}")
    writeFileSync(join(dir, "run-observers.json"), JSON.stringify(body))
    return dir
  }
  const row = { observers: ["iterm2: EnableAPIServer true"], featureIds: [CELLS[0]], note: "read through the API" }
  it.each([
    ["an unknown run", { ["0".repeat(32)]: row }, "is not a stored run"],
    [
      "an unknown feature",
      { [RUN]: { ...row, featureIds: ["extensions.nope"] } },
      "names unknown feature extensions.nope",
    ],
    ["no observers", { [RUN]: { ...row, observers: [] } }, "needs a non-empty observers list"],
    ["no note", { [RUN]: { ...row, note: " " } }, "needs a note"],
  ])("%s", (_label, body, message) => {
    const dir = write(body)
    try {
      expect(() => loadRunObservers(dir, new Set(CELLS))).toThrow(message)
    } finally {
      // raw-delete-allow: only this test's own mkdtemp fixture.
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
