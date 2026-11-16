/**
 * @failure An older setup could be published as the app's current setup, a second font measured by the newest run
 *   could be retired for merely differing in `config`, or a group whose order cannot be decided could quietly retire
 *   something instead of being named.
 * @level l2
 * @consumer API v3 contexts and the full-scope preview (classifyProjectionSetups in docs/data/current-results.ts)
 * @source-grep two configs at one newest position, a mux context, unrelated revisions and a version-less run exist
 *   only in fixtures; the real corpus holds one shape at a time.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { classifySetups, type SetupContext } from "../docs/data/run-selection.ts"

/** Ancestry over one line of revisions, oldest first. */
function chain(...revisions: string[]): { isAncestor(ancestor: string, descendant: string): boolean } {
  const ancestors = new Map(revisions.map((revision, index) => [revision, new Set(revisions.slice(0, index + 1))]))
  return { isAncestor: (ancestor, descendant) => ancestors.get(descendant)?.has(ancestor) ?? false }
}

const OLD = "1".repeat(40)
const MID = "2".repeat(40)
const NEW = "3".repeat(40)
const OTHER = "4".repeat(40)

function setup(
  key: string,
  config: string,
  runs: ReadonlyArray<{ version: string | null; sourceRevision: string | null }>,
  overrides: Partial<SetupContext["subject"]> = {},
): SetupContext {
  return {
    key,
    subject: {
      kind: "term",
      id: "kitty",
      os: "linux",
      osVersion: "7.0.0-34-generic",
      outerTerminal: null,
      mux: null,
      permissions: null,
      ...overrides,
    },
    runs: runs.map((run, index) => ({ runId: `${key}-${config}-run-${index}`, ...run })),
  }
}

describe("classifySetups", () => {
  it("keeps two configs at the newest position current and retires only what is strictly behind", () => {
    const history = chain(OLD, MID, NEW)
    const { standings, undecidable } = classifySetups(
      [
        setup("term:kitty@nice", "nice", [{ version: "0.49.2", sourceRevision: NEW }]),
        setup("term:kitty@nice-dejavu", "nice dejavu", [{ version: "0.49.2", sourceRevision: NEW }]),
        setup("term:kitty@plain", "plain", [{ version: "0.49.2", sourceRevision: MID }]),
        setup("term:kitty@ancient", "ancient", [{ version: "0.49.2", sourceRevision: OLD }]),
      ],
      history,
    )
    expect(undecidable).toEqual([])
    expect(standings.get("term:kitty@nice")).toBe("current")
    expect(standings.get("term:kitty@nice-dejavu")).toBe("current")
    expect(standings.get("term:kitty@plain")).toBe("older setup")
    expect(standings.get("term:kitty@ancient")).toBe("older setup")
  })

  it("orders by app version before ancestry, so a newer version is current even from an older revision", () => {
    const history = chain(OLD, NEW)
    const { standings } = classifySetups(
      [
        setup("term:ghostty@1.4.0", "1.4.0", [{ version: "1.4.0", sourceRevision: OLD }]),
        setup("term:ghostty@1.3.1", "1.3.1", [{ version: "1.3.1", sourceRevision: NEW }]),
      ],
      history,
    )
    expect(standings.get("term:ghostty@1.4.0")).toBe("current")
    expect(standings.get("term:ghostty@1.3.1")).toBe("older setup")
  })

  it("never groups across a mux, so a mux context is classified in its own group", () => {
    const history = chain(OLD, NEW)
    const { standings } = classifySetups(
      [
        setup("term:kitty@nice", "nice", [{ version: "0.49.2", sourceRevision: NEW }]),
        setup("term:kitty@plain", "plain", [{ version: "0.49.2", sourceRevision: OLD }]),
        setup("term:kitty@tmux", "plain", [{ version: "0.49.2", sourceRevision: OLD }], { mux: "tmux-3.6" }),
      ],
      history,
    )
    expect(standings.get("term:kitty@nice")).toBe("current")
    expect(standings.get("term:kitty@plain")).toBe("older setup")
    expect(standings.get("term:kitty@tmux")).toBe("current")
  })

  it("retires nothing in a group whose revisions are unrelated, and names the group", () => {
    const history = chain(OLD, NEW)
    const { standings, undecidable } = classifySetups(
      [
        setup("term:kitty@plain", "plain", [{ version: "0.49.2", sourceRevision: MID }]),
        setup("term:kitty@other", "other", [{ version: "0.49.2", sourceRevision: OTHER }]),
      ],
      history,
    )
    expect(standings.get("term:kitty@plain")).toBe("current")
    expect(standings.get("term:kitty@other")).toBe("current")
    expect(undecidable).toHaveLength(1)
    expect(undecidable[0]).toContain("term:kitty")
    expect(undecidable[0]).toContain("unrelated source revisions")
  })

  it("retires nothing in a group where a run records no app version, and names the group", () => {
    const history = chain(OLD, NEW)
    const { standings, undecidable } = classifySetups(
      [
        setup("term:kitty@plain", "plain", [{ version: null, sourceRevision: OLD }]),
        setup("term:kitty@other", "other", [{ version: "0.49.2", sourceRevision: NEW }]),
      ],
      history,
    )
    expect(standings.get("term:kitty@plain")).toBe("current")
    expect(standings.get("term:kitty@other")).toBe("current")
    expect(undecidable).toHaveLength(1)
    expect(undecidable[0]).toContain("no app version")
  })

  it("classifies every context it is given, with no absence a reader could read as current", () => {
    const history = chain(OLD, NEW)
    const { standings } = classifySetups(
      [
        setup("term:kitty@nice", "nice", [{ version: "0.49.2", sourceRevision: NEW }]),
        setup("term:alacritty@plain", "plain", [{ version: "0.17.0", sourceRevision: OLD }]),
        setup("term:alacritty@nice", "nice", [{ version: "0.17.0", sourceRevision: NEW }]),
      ],
      history,
    )
    expect([...standings.keys()].sort()).toEqual(["term:alacritty@nice", "term:alacritty@plain", "term:kitty@nice"])
    expect(standings.get("term:alacritty@plain")).toBe("older setup")
  })
})
