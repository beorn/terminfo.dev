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
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { RELEASE_1_CONTEXTS } from "./decisive-share.ts"
import {
  assertFrozenSuite,
  clipboardProfileFor,
  linuxLedger,
  preAdmissionRefusalOptions,
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

  it("names kitty/macos uncollectable (ships as measured, 27928), never a workflow dispatch", () => {
    // The workflow's matrix is terminal-app/iterm2/ghostty/alacritty only — there is no kitty job — and
    // hosted runners open no Kitty (no GPU, 27834). 27928 ruled it ships as measured at 31/52, so the
    // census must NAME that, not print a command that silently produces no run.
    const kitty = census().find((entry) => entry.id === "kitty" && entry.os === "macos")
    expect(kitty?.route).toBeNull()
    expect(kitty?.command).toBeNull()
    expect(kitty?.uncollectable).toMatch(/ships as measured \(27928\)/)
    for (const id of ["terminal-app", "iterm2", "ghostty", "alacritty"]) {
      expect(census().find((entry) => entry.id === id && entry.os === "macos")?.route).toBe("macos-hosted")
    }
  })

  it("names each context that produced no run, with its own reason", () => {
    const all = census()
    const uncovered = uncoveredContexts(all, [cleanRun()])
    expect(uncovered).toHaveLength(21)
    expect(uncovered.find((entry) => entry.context.id === "windows-terminal")?.reason).toMatch(
      /no owner and no hosted workflow/,
    )
    expect(uncovered.find((entry) => entry.context.id === "kitty")?.reason).toMatch(/linux-container/)
    // A produced run carries the os it was MEASURED on: an app its own, a headless engine the host's.
    const measured = all.map((entry) =>
      cleanRun({ target: { kind: entry.kind, id: entry.id, os: entry.kind === "headless" ? "linux" : entry.os } }),
    )
    expect(uncoveredContexts(all, measured)).toHaveLength(0)
  })

  it("credits an admitted headless engine run to its engine row, whatever host os it records (#27929 D7)", () => {
    // The census keys an engine row at os "unknown", while the run itself records the host it ran on
    // ("linux"), so a key of id/os matched no headless run and every engine row read "no run produced"
    // right after its run was admitted (rehearsed on 950882d4f34d, xtermjs 7866d892).
    const all = census()
    const headless = cleanRun({ target: { kind: "headless", id: "xtermjs", os: "linux" }, provenance: undefined })
    const uncovered = uncoveredContexts(all, [headless]).map((entry) => `${entry.context.kind}:${entry.context.id}`)
    expect(uncovered).not.toContain("headless:xtermjs")
    expect(uncovered).toContain("app:xterm")
    expect(uncovered).toHaveLength(21)
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

  // linuxLedger reads the whole committed corpus, which grows with every admitted run, so this row carries the
  // budget the corpus-reading consumer-selection rows use (CI took 5054 ms against the 5000 ms default).
  it("reads the five Linux invocations back from the committed runs in the corpus", () => {
    const ledger = linuxLedger(CONTENT)
    expect(Object.keys(ledger).sort()).toEqual(["alacritty", "ghostty", "kitty", "wezterm", "xterm"])
    // Every assertion here is a property of the READ-BACK, not of today's corpus: which run the site
    // selects changes as clean runs land (alacritty and wezterm linux moved from excluded to selected
    // while this change was in flight), so a test that pinned that would fail for a non-regression.
    for (const [id, row] of Object.entries(ledger)) {
      expect(row.version).not.toBe("")
      expect(row.file).toMatch(/^probes-apps\/.+-linux-.+\.json$/)
      expect(existsSync(join(CONTENT, row.file))).toBe(true)
      expect(["default", "allow", "deny-read"]).toContain(row.clipboardProfile)
      expect(["default", "baseline", "current"]).toContain(row.preset)
      // A row outside the site's selection must name why it is; a selected row carries no exclusion.
      if (row.selection === "newest-admitted") expect(row.exclusion).toBeTruthy()
      else expect(row.exclusion).toBeNull()
      if (id === "kitty") expect(row.preset).not.toBe("default")
    }
  }, 30_000)

  it("puts the read flags into the row's command", () => {
    const all = census()
    const kitty = all.find((entry) => entry.id === "kitty" && entry.os === "linux")
    expect(kitty?.command).toBe(
      "bash scripts/linux-container-run.sh --target kitty --preset current --clipboard-profile default <outdir>",
    )
    expect(kitty?.sourceRun).toMatch(/\(site-selected\)$/)
    const alacritty = all.find((entry) => entry.id === "alacritty" && entry.os === "linux")
    expect(alacritty?.sourceRun).toMatch(/\((?:site-selected|newest-admitted — the site excludes it: .+)\)$/)
  })
})

describe("release 1 collection refusal checks", () => {
  const options = { frozenSuiteId: "frozen01", admitted: false }

  it("refuses a dirty tree, and a linux app run with no provenance block", () => {
    const dirty = refusalForProducedRun(cleanRun({ provenance: { runtime: { cleanTree: false } } }), options)
    expect(dirty?.kind).toBe("dirty-tree")
    expect(dirty?.detail).toMatch(/native-provenance-dirty/)

    const unknown = refusalForProducedRun(cleanRun({ provenance: { runtime: {} } }), options)
    expect(unknown?.kind).toBe("dirty-tree")

    const missing = refusalForProducedRun(cleanRun({ provenance: undefined }), options)
    expect(missing?.kind).toBe("missing-provenance")
    expect(missing?.detail).toMatch(/native-provenance-missing/)
  })

  it("passes a headless or macOS run, which carries no provenance block by construction", () => {
    // `scripts/linux-container-run.sh` is the only collector that writes a provenance block, so a
    // headless row — or a macOS app row — has none. Only a LINUX APP run must carry one; gating on
    // `cleanTree === true` would refuse every headless run as `dirty-tree` (#27929 D6).
    expect(
      refusalForProducedRun(
        cleanRun({ target: { kind: "headless", id: "xtermjs", os: "linux" }, provenance: undefined }),
        { frozenSuiteId: "frozen01", admitted: true },
      ),
    ).toBeNull()

    expect(
      refusalForProducedRun(cleanRun({ target: { kind: "app", id: "kitty", os: "macos" }, provenance: undefined }), {
        frozenSuiteId: "frozen01",
        admitted: true,
      }),
    ).toBeNull()
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

  it("passes a clean, frozen run under the CLI admission options, so --admit reaches admit-run", () => {
    // The `--admit` call site is where admission HAPPENS, so it must classify with the admission
    // options. If it passed `admitted: false` the classifier would refuse every clean frozen run as
    // `unadmitted` before scripts/admit-run.ts could ever run, and the collection could admit nothing.
    // Bound to the exported call-site options so this can never drift from what the CLI actually passes.
    expect(refusalForProducedRun(cleanRun(), preAdmissionRefusalOptions("frozen01"))).toBeNull()
    expect(preAdmissionRefusalOptions("frozen01").frozenSuiteId).toBe("frozen01")
  })

  it("still refuses as unadmitted when a caller has not admitted the run", () => {
    // The other side of the same coin: the pre-admission options differ from `admitted: false` ONLY in
    // that they let a clean frozen run through; the unadmitted refusal must remain reachable by name.
    const beforeAdmission = refusalForProducedRun(cleanRun(), { frozenSuiteId: "frozen01", admitted: false })
    expect(beforeAdmission?.kind).toBe("unadmitted")
    expect(beforeAdmission?.detail).toMatch(/admit-run/)
  })
})

describe("release 1 frozen-suite pre-flight", () => {
  it("refuses a tree whose own suite is not the frozen suite", () => {
    expect(() => assertFrozenSuite("currentsuite", "frozen01")).toThrow(/not the frozen suite frozen01/)
    expect(() => assertFrozenSuite("frozen01", "frozen01")).not.toThrow()
  })
})
