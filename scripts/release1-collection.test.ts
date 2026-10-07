/**
 * @failure The Release 1 re-collection would silently drop a context that has no route (Windows, or
 *   an engine the Termless manifest stops exporting), or admit a run collected from a dirty tree, on
 *   a suite that is not the frozen one, or never admitted at all — so a row would land on the bar
 *   from a collection that does not count, and the census would read complete while it is not.
 * @level l2
 * @consumer Release 1 final re-collection runner (scripts/release1-collection.ts)
 * @source-grep no real collection can run in a test and no fixture carries an admitted-run
 *   directory: the census, the three refusals and the frozen-suite pre-flight are the whole surface,
 *   and the engine count is asserted against the same eleven the collector asserts.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { RELEASE_1_CONTEXTS } from "./decisive-share.ts"
import {
  assertFrozenSuite,
  release1Census,
  refusalForProducedRun,
  uncoveredContexts,
  type ProducedRun,
} from "./release1-collection.ts"

/** The Termless manifest's engine names, as a fixture: the census takes them in, it never guesses. */
const ENGINE_BACKENDS = [
  "alacritty",
  "ghostty",
  "ghostty-native",
  "kitty",
  "libvterm",
  "vt100",
  "vt100-rust",
  "vt220",
  "vterm",
  "wezterm",
  "xtermjs",
]

const cleanRun = (overrides: Partial<ProducedRun> = {}): ProducedRun => ({
  schemaVersion: 2,
  suiteId: "frozen01",
  target: { kind: "app", id: "xterm", os: "linux" },
  provenance: { runtime: { cleanTree: true } },
  ...overrides,
})

describe("release 1 collection census", () => {
  it("covers exactly the bar's desktop contexts plus the engine family", () => {
    const census = release1Census(ENGINE_BACKENDS)
    const apps = census.filter((entry) => entry.kind === "app")
    expect(apps.map((entry) => `${entry.id}/${entry.os}`).sort()).toEqual(
      RELEASE_1_CONTEXTS.map((context) => `${context.terminalId}/${context.os}`).sort(),
    )
    expect(census.filter((entry) => entry.kind === "headless")).toHaveLength(11)
    expect(census).toHaveLength(22)
  })

  it("refuses a manifest that is not the eleven engines the collector asserts", () => {
    expect(() => release1Census(ENGINE_BACKENDS.slice(0, 10))).toThrow(/Expected 11 headless engines/)
    expect(() => release1Census([...ENGINE_BACKENDS, "extra"])).toThrow(/Expected 11 headless engines/)
  })

  it("names every context that has no route instead of dropping it", () => {
    const census = release1Census(ENGINE_BACKENDS)
    const windows = census.find((entry) => entry.id === "windows-terminal")
    expect(windows?.route).toBeNull()
    expect(windows?.uncollectable).toMatch(/no owner and no hosted workflow/)
    for (const entry of census) {
      if (entry.route === null) expect(entry.uncollectable).not.toBeNull()
      else expect(entry.command).toBeTruthy()
    }
  })

  it("names each context that produced no run, with its own reason", () => {
    const census = release1Census(ENGINE_BACKENDS)
    const uncovered = uncoveredContexts(census, ["xterm/linux"])
    expect(uncovered).toHaveLength(21)
    expect(uncovered.find((entry) => entry.context.id === "windows-terminal")?.reason).toMatch(
      /no owner and no hosted workflow/,
    )
    expect(uncovered.find((entry) => entry.context.id === "kitty")?.reason).toMatch(/linux-container/)
    expect(
      uncoveredContexts(
        census,
        census.map((entry) => `${entry.id}/${entry.os}`),
      ),
    ).toHaveLength(0)
  })
})

describe("release 1 collection refusal checks", () => {
  const options = { frozenSuiteId: "frozen01", admitted: false }

  it("refuses a dirty tree, and a missing clean-tree proof is not clean", () => {
    const dirty = refusalForProducedRun(cleanRun({ provenance: { runtime: { cleanTree: false } } }), options)
    expect(dirty?.kind).toBe("dirty-tree")
    expect(dirty?.detail).toMatch(/native-provenance-dirty/)

    const unknown = refusalForProducedRun(cleanRun({ provenance: { runtime: {} } }), options)
    expect(unknown?.kind).toBe("dirty-tree")
  })

  it("refuses a run measured on a suite that is not the frozen one", () => {
    const stale = refusalForProducedRun(cleanRun({ suiteId: "oldersuite" }), options)
    expect(stale?.kind).toBe("suite-stale")
    expect(stale?.detail).toMatch(/not the frozen suite frozen01/)
  })

  it("refuses a run that was not admitted, and a non-schema-v2 document", () => {
    const unadmitted = refusalForProducedRun(cleanRun(), options)
    expect(unadmitted?.kind).toBe("unadmitted")
    const legacy = refusalForProducedRun(cleanRun({ schemaVersion: 1 }), {
      frozenSuiteId: "frozen01",
      admitted: true,
    })
    expect(legacy?.kind).toBe("unadmitted")
  })

  it("names the context in every refusal", () => {
    const refusal = refusalForProducedRun(cleanRun(), options)
    expect(refusal?.context).toBe("xterm/linux")
  })

  it("passes a clean, frozen, admitted run", () => {
    expect(refusalForProducedRun(cleanRun(), { frozenSuiteId: "frozen01", admitted: true })).toBeNull()
  })
})

describe("release 1 frozen-suite pre-flight", () => {
  it("refuses a tree whose own suite is not the frozen suite", () => {
    expect(() => assertFrozenSuite("currentsuite", "frozen01")).toThrow(/not the frozen suite frozen01/)
    expect(() => assertFrozenSuite("frozen01", "frozen01")).not.toThrow()
  })
})
