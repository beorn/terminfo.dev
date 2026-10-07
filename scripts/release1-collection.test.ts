/**
 * @failure The Release 1 re-collection would silently drop a context that has no route (Windows, or
 *   an engine the Termless manifest stops exporting), hand a row a launcher flag no committed run
 *   carries (kitty takes `--preset baseline|current`, never the launcher's default, and a clipboard
 *   override is not `default`), or admit a run collected from a dirty tree, on a suite that is not
 *   the frozen one, or never admitted at all — so a row would land on the bar from a collection that
 *   does not count, and the census would read complete while it is not.
 * @level l2
 * @consumer Release 1 final re-collection runner (scripts/release1-collection.ts)
 * @source-grep no real collection can run in a test and no fixture carries an admitted-run
 *   directory: the census (fed a fixture ledger), the flag read-back from the corpus, the three
 *   refusals and the frozen-suite pre-flight are the whole surface, and the engine count is asserted
 *   against the same eleven the collector asserts.
 * @testonly none
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { RELEASE_1_CONTEXTS } from "./decisive-share.ts"
import {
  assertFrozenSuite,
  clipboardProfileFor,
  linuxLedger,
  presetFor,
  release1Census,
  refusalForProducedRun,
  uncoveredContexts,
  type LinuxLedger,
  type ProducedRun,
} from "./release1-collection.ts"

/** One fixture Linux row: a committed run the census reads the launcher flags back from. */
const ledgerRow = (id: string, overrides: Partial<LinuxLedger[string]> = {}): LinuxLedger[string] => ({
  runId: `${id}-fixture`
    .replace(/[^a-z0-9]/g, "")
    .padEnd(32, "0")
    .slice(0, 32),
  file: `probes-apps/${id}-0.0.0-linux-fixture.json`,
  version: "0.0.0",
  preset: "default",
  clipboardProfile: "default",
  ids: null,
  selection: "site-selected",
  exclusion: null,
  ...overrides,
})

/**
 * A fixture ledger: the five Linux rows with the flags a committed run yields. The census takes the
 * ledger in rather than reading content, so the pure tests never touch the corpus.
 */
const LEDGER: LinuxLedger = {
  kitty: ledgerRow("kitty", { version: "0.49.2", preset: "current" }),
  ghostty: ledgerRow("ghostty", { version: "1.3.1" }),
  xterm: ledgerRow("xterm", { version: "411" }),
  alacritty: ledgerRow("alacritty", {
    version: "0.17.0",
    selection: "newest-admitted",
    exclusion: "identity-replies-mismatch",
  }),
  wezterm: ledgerRow("wezterm", {
    version: "0-unstable-2026-09-17",
    selection: "newest-admitted",
    exclusion: "identity-no-profile",
  }),
}

const census = (engineBackends: readonly string[] = ENGINE_BACKENDS) => release1Census(engineBackends, LEDGER)

/** The committed corpus this repository ships, as the CLI reads it. */
const CONTENT = join(dirname(fileURLToPath(import.meta.url)), "..", "content")

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
    const all = census()
    const apps = all.filter((entry) => entry.kind === "app")
    expect(apps.map((entry) => `${entry.id}/${entry.os}`).sort()).toEqual(
      RELEASE_1_CONTEXTS.map((context) => `${context.terminalId}/${context.os}`).sort(),
    )
    expect(all.filter((entry) => entry.kind === "headless")).toHaveLength(11)
    expect(all).toHaveLength(22)
  })

  it("refuses a manifest that is not the eleven engines the collector asserts", () => {
    expect(() => census(ENGINE_BACKENDS.slice(0, 10))).toThrow(/Expected 11 headless engines/)
    expect(() => census([...ENGINE_BACKENDS, "extra"])).toThrow(/Expected 11 headless engines/)
  })

  it("names every context that has no route instead of dropping it", () => {
    const all = census()
    const windows = all.find((entry) => entry.id === "windows-terminal")
    expect(windows?.route).toBeNull()
    expect(windows?.uncollectable).toMatch(/no owner and no hosted workflow/)
    for (const entry of all) {
      if (entry.route === null) expect(entry.uncollectable).not.toBeNull()
      else expect(entry.command).toBeTruthy()
    }
  })

  it("names each context that produced no run, with its own reason", () => {
    const all = census()
    const uncovered = uncoveredContexts(all, ["xterm/linux"])
    expect(uncovered).toHaveLength(21)
    expect(uncovered.find((entry) => entry.context.id === "windows-terminal")?.reason).toMatch(
      /no owner and no hosted workflow/,
    )
    expect(uncovered.find((entry) => entry.context.id === "kitty")?.reason).toMatch(/linux-container/)
    expect(
      uncoveredContexts(
        all,
        all.map((entry) => `${entry.id}/${entry.os}`),
      ),
    ).toHaveLength(0)
  })

  it("leaves a Linux row uncollectable, named, when no committed run can be read", () => {
    const all = release1Census(ENGINE_BACKENDS, { ...LEDGER, kitty: undefined as never })
    const kitty = all.find((entry) => entry.id === "kitty")
    expect(kitty?.route).toBe("linux-container")
    expect(kitty?.command).toBeNull()
    expect(kitty?.uncollectable).toMatch(/no committed run to read the launcher flags from/)
  })
})

describe("release 1 Linux launcher flags", () => {
  it("reads the clipboard profile back from the permissions the launcher wrote", () => {
    expect(clipboardProfileFor(null, "kitty/linux")).toBe("default")
    expect(clipboardProfileFor(undefined, "kitty/linux")).toBe("default")
    expect(clipboardProfileFor("clipboard: read=allow,write=allow", "kitty/linux")).toBe("allow")
    expect(clipboardProfileFor("clipboard: read=deny,write=allow", "kitty/linux")).toBe("deny-read")
    expect(() => clipboardProfileFor("clipboard: read=ask,write=allow; OSC52=not-run", "kitty/linux")).toThrow(
      /not one the launcher declares/,
    )
  })

  it("gives kitty a preset and every other target the only one the launcher accepts", () => {
    expect(presetFor("kitty", "0.49.2")).toBe("current")
    expect(presetFor("kitty", "0.46.2")).toBe("baseline")
    expect(() => presetFor("kitty", "")).toThrow(/records no version/)
    expect(presetFor("alacritty", "0.17.0")).toBe("default")
    expect(presetFor("xterm", "411")).toBe("default")
  })

  it("reads the five Linux invocations back from the committed runs in the corpus", () => {
    const ledger = linuxLedger(CONTENT)
    expect(Object.keys(ledger).sort()).toEqual(["alacritty", "ghostty", "kitty", "wezterm", "xterm"])
    expect(ledger.kitty?.preset).toBe("current")
    expect(ledger.kitty?.clipboardProfile).toBe("default")
    expect(ledger.kitty?.selection).toBe("site-selected")
    expect(ledger.xterm?.clipboardProfile).toBe("default")
    for (const id of ["alacritty", "wezterm"]) {
      const row = ledger[id]
      expect(row?.selection).toBe("newest-admitted")
      expect(row?.exclusion).toBeTruthy()
    }
  })

  it("puts the read flags into the row's command", () => {
    const all = census()
    const kitty = all.find((entry) => entry.id === "kitty" && entry.os === "linux")
    expect(kitty?.command).toBe(
      "bash scripts/linux-container-run.sh --target kitty --preset current --clipboard-profile default <outdir>",
    )
    expect(kitty?.sourceRun).toMatch(/site-selected/)
    const alacritty = all.find((entry) => entry.id === "alacritty" && entry.os === "linux")
    expect(alacritty?.sourceRun).toMatch(/newest-admitted — the site excludes it: identity-replies-mismatch/)
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
