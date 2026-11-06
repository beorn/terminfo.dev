/**
 * @failure A library result the operator declared Untestable (Nov 4 16:55) still reads PROBE TODO, or an undeclared
 *   untestable test reaches Untestable through the finalizer.
 * @level l1
 * @consumer finalizeProbeResult and the seven declared probes' library arms, read by the headless collector.
 * @reach Runs each declared probe's library callback against a minimal context and folds it.
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import {
  DECLARED_UNTESTABLE_TEST,
  HEADLESS_OBSERVABLE_REVIEW,
  declaredUntestableResult,
  isDeclaredUntestable,
  recordExecutedProbe,
  parserStateResult,
} from "./helpers.ts"
import { ALL_PROBES } from "./index.ts"
import { withD2LibraryObservation } from "./extensions.ts"
import { libProbeSource } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import type { HeadlessRuntimeIdentity, LibProbeSource, NotTestedCoverageResult, ProbeCallbackResult } from "./types.ts"

const attempt = { scope: "probe", startedAt: "2026-11-05T01:00:00.000Z" } as const

const fold = (featureId: string, result: ProbeCallbackResult) =>
  recordExecutedProbe({
    featureId,
    attempt,
    assertions: [],
    ...(result.notTested ? { coverage: { featureId, rawReplyRef: featureId, ...result.notTested } } : {}),
    ...(result.tests ? { tests: result.tests } : {}),
    ...(result.criterionBranch ? { criterionBranch: result.criterionBranch } : {}),
  })

const library = (backendName = "alacritty"): LibProbeSource =>
  ({
    backendName,
    cols: 80,
    rows: 24,
    capabilities: { kittyGraphics: true, sixel: true, extensions: new Set(["iterm2Images"]) },
    feed: () => {},
    getText: () => "",
    getCell: () => ({ char: "X" }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    reset: () => {},
  }) as unknown as LibProbeSource

// @failure The operator's Nov 5 pass-through declaration stays TODO, loses its exact reason,
// or leaks onto an unreviewed engine. Earlier declarations cover none of these eighteen cells.
// @level l1
// @consumer ALL_PROBES library callbacks through the shipping result finalizer; no test-only seam.
describe("six pass-through OSC declarations", () => {
  const ids = [
    "extensions.osc176-app-id",
    "extensions.osc3008-context",
    "extensions.osc440-audio",
    "extensions.osc555-flash",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
  ] as const
  const reason =
    "Untestable: the library hands this command to the app, as it does any OSC it does not handle itself, and does nothing with it."
  // Engine identities from the 20:34 natural run, also measured directly by CTO at 21:01.
  const subjects = [
    [
      "xterm",
      {
        kind: "js",
        runtimeFormat: "js",
        engineVersion: "6.0.0",
        integrity: {
          kind: "registry",
          lockIntegrity:
            "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
        },
      },
    ],
    [
      "vterm",
      {
        kind: "js",
        runtimeFormat: "js",
        engineVersion: "0.13.1",
        integrity: {
          kind: "source",
          repository: "git@github.com:beorn/vterm.git",
          treeOid: "3d58d29a8265aafd928e0736dde6723e2bac2007",
          cleanTree: true,
        },
      },
    ],
    [
      "libvterm",
      {
        kind: "js",
        runtimeFormat: "wasm",
        engineVersion: "0.3.3",
        loadedBinary: {
          path: "libvterm.wasm",
          sha256: "3b7c02322357c00adb8addea05240d1d348d901cf6d6300c10401eb62b945fe0",
        },
        integrity: {
          kind: "source",
          repository: "git@github.com:beorn/termless.git",
          treeOid: "0d42787b5be964b449d39295b47084edfcf3cdc7",
          cleanTree: true,
        },
      },
    ],
  ] as const
  const source = (backend: string, identity: unknown) =>
    ({
      ...library(backend),
      runtimeIdentity: identity,
      feedCapture: () => "",
      getTitle: () => "",
      getMode: () => null,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
    }) as LibProbeSource

  test.each(subjects)(
    "%s finalizes exactly the six declarations even with a generic numeric report",
    (backend, identity) => {
      for (const id of ids) {
        const lib = ALL_PROBES.find((probe) => probe.id === id)!.lib!
        for (const getUnhandledSequences of [undefined, () => []]) {
          const result = lib({ ...source(backend, identity), getUnhandledSequences })
          expect(fold(id, result), id).toMatchObject({ status: "untestable", reason })
          expect(isDeclaredUntestable(result), id).toBe(true)
          expect(result.observation, id).toBeUndefined()
          expect(result.assertions, id).toBeUndefined()
        }
      }
    },
  )

  test.each(subjects)(
    "%s keeps unreviewed identities and other features on their existing path",
    (backend, identity) => {
      for (const id of ids) {
        const lib = ALL_PROBES.find((probe) => probe.id === id)!.lib!
        for (const unknown of [undefined, { ...identity, engineVersion: "unreviewed" }]) {
          expect(isDeclaredUntestable(lib(source(backend, unknown))), id).toBe(false)
        }
      }
      const notify = ALL_PROBES.find((probe) => probe.id === "extensions.osc777-notify")!.lib!
      expect(isDeclaredUntestable(notify(source(backend, identity)))).toBe(false)
    },
  )

  test.each(subjects)("%s preserves a decided result and never declares another backend", (backend, identity) => {
    const decided: ProbeCallbackResult = {
      pass: true,
      observation: { outcome: "supported", assertionType: "buffer_state" },
    }
    const definition = ALL_PROBES.find((probe) => probe.id === ids[0])!
    const wrapped = withD2LibraryObservation({ ...definition, lib: () => decided })
    expect(wrapped.lib!(source(backend, identity))).toBe(decided)
    const prior: ProbeCallbackResult = {
      pass: false,
      notTested: { reason: "no-semantic-observable", noObservable: "prior undecided result" },
    }
    const other = withD2LibraryObservation({ ...definition, lib: () => prior })
    expect(other.lib!(source("other-library", identity))).toBe(prior)
  })
})

describe("H-4 exact host-effect declarations", () => {
  const ghosttyIdentity = {
    kind: "native",
    engineVersion: "1.3.1",
    adapterVersion: "0.11.0",
    termlessRevision: "10dbfe015d27357bac7f2337e2a828a5afe0ad97",
    loadedBinary: {
      path: "termless-ghostty-native.node",
      sha256: "263e32f284d2399fda5e99df5bea125ed6248979516d309b15f3fd7dbbe836dd",
    },
    provenance: {
      sha256: "263e32f284d2399fda5e99df5bea125ed6248979516d309b15f3fd7dbbe836dd",
      sourceCommit: "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28",
      buildHash: "a4404e07f3746b45a9a813fd0cda0aa4156e5753b75f1ecda66722abd4d68d1a",
      toolchain: "zig 0.15.2",
      lockSha256: "3ec775507556db01d08055836b26183f629a9cbb0b5802a1566661e95988d74a",
    },
    adapterSources: [
      { path: "packages/ghostty-native/src/index.ts", blobOid: "35c9e35a5d60625ce1135b65ff38ae9278495a18" },
      { path: "packages/ghostty-native/src/backend.ts", blobOid: "d15e83634be3aa1bf2df9b58eb2f6376af800808" },
    ],
  } satisfies HeadlessRuntimeIdentity
  const kittyIdentity = {
    kind: "native",
    engineVersion: "0.49.2",
    adapterVersion: "0.11.0",
    termlessRevision: "10dbfe015d27357bac7f2337e2a828a5afe0ad97",
    loadedBinary: {
      path: "/nix/store/kitty/bin/kitty",
      sha256: "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886",
    },
    provenance: {
      sha256: "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886",
      sourceCommit: "b2cb871254fbdac19a085188813c8dfb258b95cd",
      buildHash: "e7292713c85f982a965986a1fc6f762088fe5e16778b87405aaded96d7f4014e",
      toolchain: "recorded Nix binary",
      lockSha256: "af40f83f49b3a4c6cd6946fbd7ac49232f3767de4693a6b4545b44d233386eef",
    },
    adapterSources: [
      { path: "packages/kitty/src/index.ts", blobOid: "3f207f911646613cdc3d8b04f155f0686a96a077" },
      { path: "packages/kitty/src/backend.ts", blobOid: "4cfc0a1707e4c92211c501cd27d8e1944ebe66db" },
      { path: "packages/kitty/build/bridge.py", blobOid: "c78e427917d4e22453414db76c4d52509cc8b82f" },
      { path: "packages/kitty/build/layout.c", blobOid: "f58c0e943ad60daf20d54360184e039e16ff3826" },
      { path: "packages/kitty/build/native-mode-layout.json", blobOid: "20b976ba87de032248a787fcb8b5adc64c640f07" },
      {
        path: "packages/kitty/build/native-mode-layout.receipt.json",
        blobOid: "1e1e450aa08538ffb2d7ba80d45015aae4d86921",
      },
    ],
  } satisfies HeadlessRuntimeIdentity
  const ids = [
    "extensions.osc176-app-id",
    "extensions.osc3008-context",
    "extensions.osc440-audio",
    "extensions.osc555-flash",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
  ]

  // @failure A reviewed no-observable cell stays TODO, or an unaudited identity inherits its declaration.
  // @level l1
  // @consumer Registered callbacks through the result finalizer; the generic Kitty report is not a payload store.
  test.each([
    ["ghostty-native", ghosttyIdentity, ids, /Ghostty.*no.*(state|report|route)/i],
    ["kitty", kittyIdentity, ["extensions.osc3008-context"], /hands.*(text|payload).*bridge.*(not keep|drops)/i],
  ] as const)("%s retains only its exact declaration", (backendName, runtimeIdentity, targets, reason) => {
    for (const id of targets) {
      const definition = ALL_PROBES.find((entry) => entry.id === id)!
      const source = {
        ...library(backendName),
        runtimeIdentity,
        getTitle: () => "",
        feedCapture: () => "",
        ...(backendName === "kitty" ? { getUnhandledSequences: () => [] } : {}),
      }
      const result = definition.lib!(source)
      expect(isDeclaredUntestable(result), `${backendName}:${id}`).toBe(true)
      expect(fold(id, result)).toMatchObject({ status: "untestable", reason: expect.stringMatching(reason) })
      expect(result.observation).toBeUndefined()
      for (const changed of [
        { ...runtimeIdentity, loadedBinary: { ...runtimeIdentity.loadedBinary, sha256: "0".repeat(64) } },
        {
          ...runtimeIdentity,
          adapterSources: runtimeIdentity.adapterSources.map((entry, index) =>
            index === 1 ? { ...entry, blobOid: "0".repeat(40) } : entry,
          ),
        },
      ]) {
        const fallback = definition.lib!({ ...source, runtimeIdentity: changed })
        expect(isDeclaredUntestable(fallback), `${backendName}:${id}:changed identity`).toBe(false)
        expect(fold(id, fallback).status).toBe("probe-todo")
      }
    }
  })
})

describe("WezTerm D2 audited interface absence", () => {
  const identity = {
    kind: "native",
    adapterVersion: "0.10.2",
    termlessRevision: "f540232e22ba0ccb4005dba5ba2d8de10cb129c5",
    engineVersion: "0.1.0-fork.5",
    loadedBinary: {
      path: "termless-wezterm.node",
      sha256: "4753e20984ab7e15ea7ef8d4ddf9bd11237f79146087939e9c37771aaadbf186",
    },
    provenance: {
      sha256: "4753e20984ab7e15ea7ef8d4ddf9bd11237f79146087939e9c37771aaadbf186",
      sourceCommit: "f8f48853438f5fb6c43abbbb081162506d14f167",
      lockSha256: "69f92e2bb6cf16b891ba30b213958c34e17c84ee57fa96b42e02e7e477218d58",
      buildHash: "b490366abcd4d04090a9d45b2f9d8e298408d3c38f3d195d1744d0e487fb443f",
      toolchain: "audited native fixture",
    },
    adapterSources: [
      { path: "packages/wezterm/src/index.ts", blobOid: "512606c5270ffd0cff55c1b70f5b3eda18a92df0" },
      { path: "packages/wezterm/src/backend.ts", blobOid: "4b376877280d09535bc67a6f99fc5d68b40529e3" },
      { path: "packages/wezterm/native/src/lib.rs", blobOid: "69a9d1ebc4fd86d46c131a378a9d897cdd6824b3" },
      { path: "src/load-native.ts", blobOid: "34e142550085450ab02138184626716ad0d6b546" },
    ],
  } satisfies HeadlessRuntimeIdentity
  const source = (extra: Partial<LibProbeSource> = {}): LibProbeSource => {
    let parsedMarker = false
    return {
      ...library("wezterm"),
      runtimeIdentity: identity,
      feedCapture: () => "",
      getTitle: () => "",
      // Existing DECSSCLS parser-consumption control passes; presentation speed remains unobserved.
      feed: (sequence) => {
        parsedMarker = sequence.includes("\x1b[9 pQ")
      },
      getText: () => (parsedMarker ? "Q" : ""),
      getCursor: () => ({ x: parsedMarker ? 1 : 0, y: 0, visible: true, style: null }),
      getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
      ...extra,
    }
  }
  const targets = [
    ["extensions.osc113-reset-pointer-fg", /empty handler.*public palette.*query reply.*PaletteChanged/],
    ["extensions.osc114-reset-pointer-bg", /empty handler.*public palette.*query reply.*PaletteChanged/],
    ["extensions.osc22-pointer", /no handler.*opt-in log.*off/],
    ["modes.decsscls", /no handler.*opt-in log.*off/],
    ["extensions.osc176-app-id", /OSC 176.*no host route/],
    ["extensions.osc3008-context", /OSC 3008.*no host route/],
    ["extensions.osc440-audio", /OSC 440.*no host route/],
    ["extensions.osc555-flash", /OSC 555.*no host route/],
    ["extensions.osc666-termprop", /OSC 666.*no host route/],
    ["extensions.osc710-font-normal", /OSC 710.*no host route/],
  ] as const

  // @failure The exact approved WezTerm cohort retains TODO or invents an observation.
  // @level l1
  // @consumer Shipping library callbacks and result finalizer, using audited native fixtures only.
  test.each(targets)("%s declares its specific public-interface absence", (id, reason) => {
    const result = ALL_PROBES.find((probe) => probe.id === id)!.lib!(source())
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(fold(id, result)).toMatchObject({ status: "untestable", reason: expect.stringMatching(reason) })
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  })

  test("the public 0.11.0 adapter retains the ten audited interface absences", () => {
    const runtimeIdentity = {
      ...identity,
      adapterVersion: "0.11.0",
      termlessRevision: "10dbfe015d27357bac7f2337e2a828a5afe0ad97",
      adapterSources: identity.adapterSources.map((entry) =>
        entry.path === "packages/wezterm/src/backend.ts"
          ? { ...entry, blobOid: "e7b9d32395b3209ef48247c2e3d7f7f21cbd10a6" }
          : entry,
      ),
    }
    for (const [id, reason] of targets) {
      const result = ALL_PROBES.find((probe) => probe.id === id)!.lib!(source({ runtimeIdentity }))
      expect(fold(id, result), id).toMatchObject({ status: "untestable", reason: expect.stringMatching(reason) })
    }
  })

  test("unqualified runtime identities keep the ten cells TODO", () => {
    for (const runtimeIdentity of [
      undefined,
      { ...identity, engineVersion: "0.1.0-fork.6" },
      { ...identity, loadedBinary: { ...identity.loadedBinary, sha256: "0".repeat(64) } },
      { ...identity, provenance: { ...identity.provenance, sourceCommit: "0".repeat(40) } },
      { ...identity, provenance: { ...identity.provenance, lockSha256: "0".repeat(64) } },
      {
        ...identity,
        adapterSources: identity.adapterSources.map((entry, i) =>
          i === 1 ? { ...entry, blobOid: "0".repeat(40) } : entry,
        ),
      },
    ]) {
      for (const [id] of targets) {
        const result = ALL_PROBES.find((probe) => probe.id === id)!.lib!(source({ runtimeIdentity }))
        expect(fold(id, result).status, id).toBe("probe-todo")
      }
    }
  })

  test("real reports and decided results retain their original result", () => {
    for (const [id] of targets) {
      const definition = ALL_PROBES.find((probe) => probe.id === id)!
      expect(isDeclaredUntestable(definition.lib!(source({ getUnhandledSequences: () => [] })))).toBe(false)
      const decided = parserStateResult(true, "retained original reader result", { value: "fixture" })
      expect(withD2LibraryObservation({ ...definition, lib: () => decided }).lib!(source())).toBe(decided)
    }
  })

  test("the WezTerm identity cannot declare absences on another backend", () => {
    for (const [id] of targets) {
      const result = ALL_PROBES.find((probe) => probe.id === id)!.lib!(source({ backendName: "unlisted" }))
      expect(fold(id, result).status, id).toBe("probe-todo")
    }
  })
})

// The operator's Nov 4 16:55 decision, part A: each feature's reason, written once in its own probe.
const declared = [
  ["extensions.kitty-graphics.unicode-placeholders", /Unicode placeholder rendering/],
  ["extensions.kitty-graphics.animation", /timed animation playback/],
  ["extensions.iterm2-images", /rendered image pixels/],
  ["extensions.font-ligatures", /shapes no glyphs/],
  ["device.term-features", /no application child/],
  ["extensions.sixel", /rendered pixels/],
] as const

test.each(declared)("%s library arm reads Untestable with its declared reason", (id, reason) => {
  const definition = ALL_PROBES.find((probe) => probe.id === id)
  if (!definition?.lib) throw new Error(`missing library arm ${id}`)
  const result = definition.lib(library()) as ProbeCallbackResult
  expect(isDeclaredUntestable(result)).toBe(true)
  expect(result.tests).toEqual([
    { id: DECLARED_UNTESTABLE_TEST, status: "untestable", reason: expect.stringMatching(reason) },
  ])
  const folded = fold(id, result)
  expect(folded.status).toBe("untestable")
  expect(folded.reason).toMatch(reason)
})

// The exceptions named inside their probes stay as they are: vterm's stored Sixel payload keeps its review, and
// XTEST key injection is declared only for the five libraries with no public key encoder (CTO 47010d76).
test("vterm's Sixel storage arm and the encoder-exporting XTEST arms are not declared and stay PROBE TODO", () => {
  const sixel = ALL_PROBES.find((probe) => probe.id === "extensions.sixel")!.lib!
  const stored = sixel({ ...library("vterm"), getSixelImages: () => [] } as unknown as LibProbeSource)
  expect(isDeclaredUntestable(stored)).toBe(false)
  expect(fold("extensions.sixel", stored).status).toBe("probe-todo")
  const xtest = ALL_PROBES.find((probe) => probe.id === "input.xtest-key")!.lib!
  for (const backendName of ["libvterm", "vterm"]) {
    const result = xtest(library(backendName)) as ProbeCallbackResult
    expect(isDeclaredUntestable(result)).toBe(false)
    expect(fold("input.xtest-key", result).status).toBe("probe-todo")
  }
  expect(isDeclaredUntestable(xtest(library("vt100")) as ProbeCallbackResult)).toBe(true)
})

test("the declared helper needs a reason and folds only in its exact form", () => {
  expect(() => declaredUntestableResult(" ", {})).toThrow(/reason/)
  const helper = declaredUntestableResult("fixture reason", { state: 1 })
  expect(fold("alpha", helper)).toMatchObject({ status: "untestable", reason: "fixture reason" })
  const variants: NotTestedCoverageResult[] = [
    // An untestable test that is not the declared one.
    { ...helper, tests: [{ id: "review", status: "untestable", reason: "fixture reason" }] },
    // The declared test on another branch, or with no branch.
    { ...helper, criterionBranch: "os-input-review" },
    { ...helper, criterionBranch: undefined },
    // The declared test beside another test.
    { ...helper, tests: [...helper.tests!, { id: "extra", status: "untestable", reason: "x" }] },
  ]
  for (const variant of variants) {
    expect(isDeclaredUntestable(variant)).toBe(false)
    expect(fold("alpha", variant).status).toBe("probe-todo")
  }
  expect(isDeclaredUntestable({ criterionBranch: HEADLESS_OBSERVABLE_REVIEW, tests: [] })).toBe(false)
})

// Operator decision B: absence is qualified by the audited public source, not a
// missing adapter method. These identities are from the unchanged 2167 captures.
describe("audited OSC interface absence", () => {
  const vtIdentity = (backend: "vt100" | "vt220", treeOid?: string, engineVersion = "0.10.1") => ({
    kind: "js" as const,
    runtimeFormat: "js" as const,
    adapterVersion: "0.10.2",
    termlessRevision: "ce3e783b6536df0cc4e0a11d4567f1cdd96bafee",
    engineVersion,
    resolvedPath: `vendor/vterm/packages/${backend}/src/index.ts`,
    integrity: {
      kind: "source" as const,
      repository: "git@github.com:beorn/vterm.git",
      revision: "5e17657b7806e88b3370b86dc000e26b3d3c7301",
      treeOid:
        treeOid ??
        (backend === "vt100" ? "c7c4dd7c37882a37ae336490eb42ef784c0b7045" : "4c946bbce73a95093ed16bab183b17032c622e21"),
      cleanTree: true,
    },
  })
  const vt100 = vtIdentity("vt100")
  const vt100Release = vtIdentity("vt100", "72b03cdc69980e98fe83eb9ecd51a5b01bbc4ccb", "0.11.0")
  const vt220Release = vtIdentity("vt220", "6b22dcb3365f8ee2045c5cdb5fc0b4f41990ee1d", "0.11.0")
  // R6: ignored-command numbers expose neither completed CWD metadata nor ordered notification payloads.
  const vt100IgnoredReport = vtIdentity("vt100", "2a2536134a2a45982cfd27f892fe71e5078a8730", "0.13.0")
  const vt220IgnoredReport = vtIdentity("vt220", "96b1a890bf64164af924b48e7d84d3d5f6e91617", "0.13.0")
  const current = [
    ["vt100", vtIdentity("vt100", "5486c34f7fc6bbd10284ea68a504eec2c38a061f", "0.12.0")],
    ["vt220", vtIdentity("vt220", "dee664e0e0554a5465a0c78cf760f437a360b0f2", "0.12.0")],
    ["vt100", vt100IgnoredReport],
    ["vt220", vt220IgnoredReport],
    // DEC1 re-audit at the final 0.13.1 package trees: reports add no CWD or notification interface.
    ["vt100", vtIdentity("vt100", "d0e3d3fe4e893b70bd3f7d95725b4e10c1f6d99d", "0.13.1")],
    ["vt220", vtIdentity("vt220", "5162719d063ab59d2905d588df3e127d38b110d1", "0.13.1")],
  ] as const
  const readerSubjects = [["vt100", vt100], ...current] as const
  const alacritty = {
    kind: "native" as const,
    engineVersion: "0.26.0",
    adapterVersion: "0.10.2",
    termlessRevision: "ce3e783b6536df0cc4e0a11d4567f1cdd96bafee",
    loadedBinary: {
      path: "vendor/termless/packages/alacritty/termless-alacritty-native.node",
      sha256: "5f5e89db7fae602482e561f0b8625965f56ae2a91337b0de28f05147412941cd",
    },
    provenance: {
      sha256: "5f5e89db7fae602482e561f0b8625965f56ae2a91337b0de28f05147412941cd",
      sourceCommit: "6e497eb0310dd6747dfce240fc241e12c07d0615",
      buildHash: "74a0537bebf3369d2348621e76ecd180b3c04002ced3a34faa9485d11ed29a74",
      toolchain:
        "rustc 1.94.0 (4a4ef493e 2026-03-02) (built from a source tarball); cargo 1.94.0 (85eff7c80 2026-01-15)",
      lockSha256: "1f89f2579b7d786a116d8fefb8267c4af076bd3a3893adcf14b00c4466740497",
    },
    adapterSources: [
      { path: "packages/alacritty/src/index.ts", blobOid: "b4154cbd6ef4a83ce2cbf3dcf26ff13d645efd05" },
      { path: "packages/alacritty/src/backend.ts", blobOid: "fb86b6283d4ecaac4b97223bd6c9856c60aa7bbc" },
      { path: "packages/alacritty/native/src/lib.rs", blobOid: "23b6874c921b03ab2ae99bfec61cd9f00b8cb5a8" },
      { path: "src/load-native.ts", blobOid: "34e142550085450ab02138184626716ad0d6b546" },
    ],
  } satisfies HeadlessRuntimeIdentity
  // Operator D2's independently reviewed literal23; four unclear Alacritty rows are excluded.
  const alacrittyD2 = [
    "extensions.osc777-notify",
    "extensions.osc133-a",
    "extensions.osc133-b",
    "extensions.osc133-c",
    "extensions.osc133-d",
    "extensions.osc133-p",
    "extensions.semantic-prompts",
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.osc-633-vscode",
    "extensions.osc113-reset-pointer-fg",
    "extensions.osc114-reset-pointer-bg",
    "extensions.osc117-reset-highlight-bg",
    "extensions.osc119-reset-highlight-fg",
    "extensions.osc176-app-id",
    "extensions.osc3008-context",
    "extensions.osc440-audio",
    "extensions.osc555-flash",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
  ] as const
  const d2Source = (extra: Partial<LibProbeSource> = {}): LibProbeSource => ({
    ...library("alacritty"),
    runtimeIdentity: alacritty,
    feedCapture: () => "",
    getTitle: () => "",
    getMode: () => null,
    getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
    ...extra,
  })

  // @failure The approved exact-version absence cohort stays TODO or bypasses the declaration finalizer.
  // @level l1
  // @consumer ALL_PROBES library callbacks folded by the shipping result finalizer
  test("Alacritty D2 folds the literal23 audited interface absences to Untestable", () => {
    for (const id of alacrittyD2) {
      const result = ALL_PROBES.find((probe) => probe.id === id)!.lib!(d2Source())
      expect(isDeclaredUntestable(result), id).toBe(true)
      expect(fold(id, result), id).toMatchObject({
        status: "untestable",
        reason: expect.stringMatching(/alacritty.*0\.26\.0/i),
      })
      expect(result.observation, id).toBeUndefined()
      expect(result.assertions, id).toBeUndefined()
    }
  })

  // @failure An absence declaration leaks to an unknown profile, unclear cell or available public reader.
  // @level l1
  // @consumer The conditional declaration route used by the headless collector
  test("Alacritty D2 preserves unknown identities, four unclear cells and public readers", () => {
    const notify = ALL_PROBES.find((probe) => probe.id === "extensions.osc777-notify")!.lib!
    for (const extra of [
      { runtimeIdentity: undefined },
      { backendName: "kitty" },
      { runtimeIdentity: { ...alacritty, engineVersion: "0.26.1" } },
      { runtimeIdentity: { ...alacritty, provenance: { ...alacritty.provenance, lockSha256: "0".repeat(64) } } },
      { getUnhandledSequences: () => [] },
      { getOsc777Payloads: () => [] },
      { getToasts: () => [] },
    ] satisfies Partial<LibProbeSource>[]) {
      expect(isDeclaredUntestable(notify(d2Source(extra)))).toBe(false)
    }
    for (const id of ["sgr.blink", "extensions.osc22-pointer", "extensions.osc1-icon", "modes.decsscls"]) {
      expect(isDeclaredUntestable(ALL_PROBES.find((probe) => probe.id === id)!.lib!(d2Source())), id).toBe(false)
    }
    const semantic = ALL_PROBES.find((probe) => probe.id === "extensions.osc133-a")!.lib!
    expect(isDeclaredUntestable(semantic(d2Source({ getSemanticMarks: () => [] })))).toBe(false)
    expect(() =>
      notify(
        d2Source({
          getOsc777Payloads: () => {
            throw new Error("reader failed")
          },
        }),
      ),
    ).toThrow("reader failed")
  })

  const alacritty0110 = {
    ...alacritty,
    adapterVersion: "0.11.0",
    adapterSources: alacritty.adapterSources.map((source) =>
      source.path === "packages/alacritty/src/backend.ts"
        ? { ...source, blobOid: "9ee6e4044b2a084b7181552362b7ee76f234dc14" }
        : source,
    ),
  }
  // NR-D adds CSI extent, progress state and prompt-click state to the existing audited route.
  // The literal23 table above cannot prove these newly ruled cells or their reader precedence.
  test.each([
    ["editing.decsace", /CSI/],
    ["extensions.osc9-progress", /OSC 9/],
    ["input.kitty-click-events", /Termless/],
  ] as const)("NR-D %s declares only the audited Alacritty interface", (id, reason) => {
    const definition = ALL_PROBES.find((probe) => probe.id === id)!
    for (const runtimeIdentity of [alacritty, alacritty0110]) {
      const result = definition.lib!(d2Source({ runtimeIdentity }))
      expect(isDeclaredUntestable(result)).toBe(true)
      expect(fold(id, result)).toMatchObject({ status: "untestable", reason: expect.stringMatching(reason) })
    }
    for (const extra of [
      { runtimeIdentity: undefined },
      { runtimeIdentity: { ...alacritty, engineVersion: "unreviewed" } },
      { backendName: "other-library" },
      { getUnhandledSequences: () => [] },
    ] satisfies Partial<LibProbeSource>[]) {
      expect(isDeclaredUntestable(definition.lib!(d2Source(extra)))).toBe(false)
    }
    const decided = parserStateResult(true, "existing decided result", { value: true })
    expect(withD2LibraryObservation({ ...definition, lib: () => decided }).lib!(d2Source())).toBe(decided)
    if (id === "extensions.osc9-progress") {
      expect(isDeclaredUntestable(definition.lib!(d2Source({ getProgress: () => null })))).toBe(false)
    }
  })

  // A generic all-zero DECRQM responder must not establish an engine negative.
  // Existing input tests measure encoder bytes, not this same-reader control.
  test.each([
    ["controlled negative", true, 0, 0, "unsupported"],
    ["constant-zero control", false, 0, 0, "probe-todo"],
    ["recognized unknown", true, 1, 0, "probe-todo"],
    ["recognized target", true, 0, 1, "probe-todo"],
  ] as const)("NR-D pixel mouse: %s", (_label, controlled, unknown, target, outcome) => {
    let sgr = false
    const writes: string[] = []
    const source = d2Source({
      feed(sequence) {
        writes.push(sequence)
        if (sequence === "\x1b[?1006h") sgr = true
        if (sequence === "\x1b[?1006l") sgr = false
      },
      feedCapture(sequence) {
        writes.push(sequence)
        const mode = /^\x1b\[\?(\d+)\$p$/.exec(sequence)?.[1]
        if (!mode) return ""
        const ps = mode === "1006" ? (controlled ? (sgr ? 1 : 2) : 0) : mode === "9999" ? unknown : target
        return `\x1b[?${mode};${ps}$y`
      },
    })
    const result = ALL_PROBES.find((probe) => probe.id === "input.pixel-mouse")!.lib!(source)
    if (outcome === "unsupported") {
      expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
      expect(result.assertions?.[0]?.kind).toBe("negative")
    } else {
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.notTested).toBeDefined()
    }
    expect(writes).toContain("\x1b[?1006$p")
    expect(writes).toContain("\x1b[?9999$p")
    expect(writes.filter((write) => write === "\x1b[?1016$p")).toHaveLength(2)
    expect(writes.at(-1)).toBe("\x1b[?1006;1016l")
  })
  // The starting-colour exception needs this probe's seed, not only an audited identity.
  // Existing D2 and generic colour cases do not combine those two facts.
  test("Alacritty starting-colour declarations require an audited identity and verified seed", () => {
    const stale = {
      ...alacritty,
      adapterSources: alacritty.adapterSources.map((source) =>
        source.path === "packages/alacritty/native/src/lib.rs" ? { ...source, blobOid: "0".repeat(40) } : source,
      ),
    }
    for (const [id, slot, resetCode] of [
      ["extensions.osc10-fg-color", "10", "110"],
      ["extensions.osc11-bg-color", "11", "111"],
      ["extensions.osc12-cursor-color", "12", "112"],
      ["extensions.osc4-palette", "4;0", "104;0"],
    ] as const) {
      for (const scenario of [
        { label: "audited", identity: alacritty, seed: true },
        { label: "public", identity: alacritty0110, seed: true },
        { label: "stale", identity: stale, seed: true },
        { label: "failed seed", identity: alacritty, seed: false },
        { label: "initial positive", identity: alacritty, seed: true, initial: true },
        { label: "other backend", identity: alacritty, seed: true, backend: "ghostty-native" },
      ]) {
        const query = `\x1b]${slot};?\x07`,
          setter = `\x1b]${slot};rgb:aa/bb/cc\x07`
        const reply = `\x1b]${slot};rgb:aaaa/bbbb/cccc\x07`,
          reset = `\x1b]${resetCode}\x07`
        let seeded = false
        const result = ALL_PROBES.find((probe) => probe.id === id)!.lib!(
          d2Source({
            backendName: "backend" in scenario ? scenario.backend : "alacritty",
            runtimeIdentity: scenario.identity,
            feedCapture(sequence) {
              if (sequence === setter) seeded = scenario.seed
              if (sequence === reset) seeded = false
              return sequence === query && (("initial" in scenario && scenario.initial) || seeded) ? reply : ""
            },
          }),
        )
        const declared = scenario.label === "audited" || scenario.label === "public"
        expect(isDeclaredUntestable(result), `${id}: ${scenario.label}`).toBe(declared)
        if (declared) {
          expect(fold(id, result).status).toBe("untestable")
          expect(result.hostRecipeCauses).toMatchObject([
            { recipe: "color-request", cause: { kind: "observed", query } },
          ])
        }
        if ("initial" in scenario && scenario.initial) expect(result.pass).toBe(true)
      }
    }
  })
  const run = (backend: string, runtimeIdentity?: HeadlessRuntimeIdentity, extra: Partial<LibProbeSource> = {}) => {
    const definition = ALL_PROBES.find((probe) => probe.id === "extensions.notifications")!
    return definition.lib!({ ...library(backend), runtimeIdentity, ...extra })
  }

  test.each([
    ["vt100", vt100],
    ["vt100", vtIdentity("vt100", "8e082c695f238ec87dd22a496b836e5b1ef56458")],
    ["vt220", vtIdentity("vt220")],
    ["vt100", vt100Release],
    ["vt220", vt220Release],
    ...current,
    ["alacritty", alacritty],
    ["alacritty", alacritty0110],
  ] as const)("%s's audited source declares notification absence without a measured assertion", (backend, identity) => {
    let feeds = 0
    const result = run(backend, identity, {
      feed: () => {
        feeds++
      },
    })
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(fold("extensions.notifications", result)).toMatchObject({
      status: "untestable",
      reason: expect.stringMatching(/OSC 9/),
    })
    expect(result.note?.toLowerCase()).toContain(backend)
    expect(JSON.parse(result.response!)).toMatchObject({
      backend,
      runtimeIdentity: { engineVersion: identity.engineVersion },
    })
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    expect(feeds).toBe(0)
  })

  // Every variant names a different way a familiar name can cease to identify
  // the audited API. The existing global Alacritty cohort is historical.
  const unknown: [string, string, HeadlessRuntimeIdentity | undefined][] = [
    ["no measured identity", "vt100", undefined],
    ["unlisted backend", "unlisted", undefined],
    ["a new version", "vt100", { ...vt100, engineVersion: "0.10.2" }],
    ["old version with the new VT100 tree", "vt100", { ...vt100Release, engineVersion: "0.10.1" }],
    ["old version with the new VT220 tree", "vt220", { ...vt220Release, engineVersion: "0.10.1" }],
    ["new version with an old VT100 tree", "vt100", { ...vt100, engineVersion: "0.11.0" }],
    ["new version with an old VT220 tree", "vt220", { ...vtIdentity("vt220"), engineVersion: "0.11.0" }],
    ["0.12 with the 0.11 VT100 tree", "vt100", { ...vt100Release, engineVersion: "0.12.0" }],
    ["0.12 with the 0.11 VT220 tree", "vt220", { ...vt220Release, engineVersion: "0.12.0" }],
    [
      "0.13 with the 0.12 VT100 tree",
      "vt100",
      vtIdentity("vt100", "5486c34f7fc6bbd10284ea68a504eec2c38a061f", "0.13.0"),
    ],
    [
      "0.13 with the 0.12 VT220 tree",
      "vt220",
      vtIdentity("vt220", "dee664e0e0554a5465a0c78cf760f437a360b0f2", "0.13.0"),
    ],
    ["0.12 with the 0.13 VT100 tree", "vt100", { ...vt100IgnoredReport, engineVersion: "0.12.0" }],
    ["0.12 with the 0.13 VT220 tree", "vt220", { ...vt220IgnoredReport, engineVersion: "0.12.0" }],
    ["0.13.1 with the 0.13 VT100 tree", "vt100", { ...vt100IgnoredReport, engineVersion: "0.13.1" }],
    ["0.13.1 with the 0.13 VT220 tree", "vt220", { ...vt220IgnoredReport, engineVersion: "0.13.1" }],
    ...current.flatMap(([backend, identity]): [string, string, HeadlessRuntimeIdentity][] => [
      [`0.11 with the ${identity.engineVersion} ${backend} tree`, backend, { ...identity, engineVersion: "0.11.0" }],
      [
        `a dirty ${identity.engineVersion} ${backend} tree`,
        backend,
        { ...identity, integrity: { ...identity.integrity, cleanTree: false } },
      ],
      [
        `another repository with the ${identity.engineVersion} ${backend} tree`,
        backend,
        { ...identity, integrity: { ...identity.integrity, repository: "https://example.invalid/vterm.git" } },
      ],
    ]),
    ["a changed tree", "vt100", { ...vt100, integrity: { ...vt100.integrity, treeOid: "0".repeat(40) } }],
    ["a dirty tree", "vt100", { ...vt100, integrity: { ...vt100.integrity, cleanTree: false } }],
    [
      "another repository",
      "vt100",
      { ...vt100, integrity: { ...vt100.integrity, repository: "https://example.invalid/vterm.git" } },
    ],
    ["a registry package", "vt100", { ...vt100, integrity: { kind: "registry", lockIntegrity: "unreviewed" } }],
    [
      "a changed lock",
      "alacritty",
      { ...alacritty, provenance: { ...alacritty.provenance, lockSha256: "0".repeat(64) } },
    ],
    [
      "a changed native source",
      "alacritty",
      { ...alacritty, provenance: { ...alacritty.provenance, sourceCommit: "0".repeat(40) } },
    ],
    [
      "a changed adapter blob",
      "alacritty",
      {
        ...alacritty,
        adapterSources: alacritty.adapterSources.map((s, i) => (i === 1 ? { ...s, blobOid: "0".repeat(40) } : s)),
      },
    ],
    ["a missing source", "alacritty", { ...alacritty, adapterSources: alacritty.adapterSources.slice(1) }],
    [
      "an extra source",
      "alacritty",
      { ...alacritty, adapterSources: [...alacritty.adapterSources, { path: "extra.ts", blobOid: "0".repeat(40) }] },
    ],
    [
      "the historical Alacritty cohort",
      "alacritty",
      {
        ...alacritty,
        adapterSources: alacritty.adapterSources.map((s, i) =>
          i === 1
            ? { ...s, blobOid: "27b78b1264cd5d2ed72705ba36c9735b29e874c5" }
            : i === 2
              ? { ...s, blobOid: "1779ff4f042f7f285ab3d396da039408b492be10" }
              : s,
        ),
      },
    ],
  ]
  test.each(unknown)("%s keeps the missing-reader TODO", (_label, backend, identity) => {
    const result = run(backend, identity)
    expect(isDeclaredUntestable(result)).toBe(false)
    expect(fold("extensions.notifications", result).status).toBe("probe-todo")
  })

  test.each(readerSubjects)("%s's raw and toast readers win over the source declaration", (backend, identity) => {
    for (const enabled of [true, false]) {
      const values: string[] = []
      const result = run(backend, identity, {
        feed(text) {
          if (enabled && text === "\x1b]9;terminfo-notification-A\x07") values.push("terminfo-notification-A")
          if (enabled && text === "\x1b]9;terminfo-notification-B\x07") values.push("terminfo-notification-B")
        },
        getNotifications: () => [...values],
      })
      expect(isDeclaredUntestable(result)).toBe(false)
      if (enabled) expect(result.observation?.outcome).toBe("supported")
      else expect(result.observation?.outcome).not.toBe("supported")
    }
    expect(() =>
      run(backend, identity, {
        getNotifications: () => {
          throw new Error("reader failed")
        },
      }),
    ).toThrow("reader failed")
    expect(() =>
      run(backend, identity, {
        getToasts: () => {
          throw new Error("toast reader failed")
        },
      }),
    ).toThrow("toast reader failed")
  })

  test.each(readerSubjects)("%s's OSC 7 audited interface absence folds to Untestable", (backend, identity) => {
    const definition = ALL_PROBES.find((probe) => probe.id === "extensions.osc7-cwd")!
    const result = definition.lib!({ ...library(backend), runtimeIdentity: identity })
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(fold(definition.id, result)).toMatchObject({
      status: "untestable",
      reason: expect.stringMatching(/OSC 7/),
    })
    expect(fold(definition.id, result).reason).toContain(identity.engineVersion)
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    const evidenceIdentity = (JSON.parse(result.response!) as { runtimeIdentity: Record<string, unknown> })
      .runtimeIdentity
    expect(evidenceIdentity).not.toHaveProperty("resolvedPath")
    expect(evidenceIdentity).not.toHaveProperty("termlessRevision")
    expect(evidenceIdentity.integrity).not.toHaveProperty("revision")
  })

  test.each(readerSubjects)("%s's supplied Cwd reader wins over the audited absence", (_backend, identity) => {
    const definition = ALL_PROBES.find((probe) => probe.id === "extensions.osc7-cwd")!
    const result = definition.lib!({ ...libProbeSource(createSemanticSurface()), runtimeIdentity: identity })
    expect(isDeclaredUntestable(result)).toBe(false)
    expect(result.observation?.outcome).toBe("supported")
    expect(() =>
      definition.lib!({
        ...libProbeSource(createSemanticSurface()),
        runtimeIdentity: identity,
        getCwd: () => {
          throw new Error("Cwd reader failed")
        },
      }),
    ).toThrow("Cwd reader failed")
  })
})

// AC3: exact-version public API has no speed state; silence never establishes absence.
// The existing mode tests lack the two DEC0.13.1 declaration boundaries.
test.each([
  ["vt100", "0.13.1", true],
  ["vt100", "0.13.0", false],
  ["vt100", "0.13.2", false],
  ["vt100", undefined, false],
  ["vt220", "0.13.1", true],
  ["vt220", "0.13.0", false],
  ["vt220", "0.13.2", false],
  ["libvterm", "0.13.1", false],
] as const)("DECSSCLS declaration is exact %s/%s", (backendName, engineVersion, declared) => {
  const definition = ALL_PROBES.find((entry) => entry.id === "modes.decsscls")!
  let measured = false
  const ctx = {
    ...library(backendName),
    runtimeIdentity: engineVersion ? { kind: "js", runtimeFormat: "js", engineVersion } : undefined,
    getText: () => (measured ? "Q" : ""),
    getTitle: () => "",
    getCursor: () => ({ x: measured ? 1 : 0, y: 0, visible: true, style: null }),
    getScrollback: () => ({ totalLines: 24, screenLines: 24, viewportOffset: 0 }),
    feed: (sequence: string) => {
      measured = sequence.includes("\x1b[9 pQ")
    },
  } as unknown as LibProbeSource
  const result = definition.lib!(ctx)
  expect(isDeclaredUntestable(result)).toBe(declared)
  expect(fold(definition.id, result).status).toBe(declared ? "untestable" : "probe-todo")
  if (declared) {
    expect(result.tests?.[0]?.reason).toBe(
      `${backendName === "vt100" ? "VT100.js" : "VT220.js"} 0.13.1 exposes no scroll-speed state or presentation-speed observer through its public Screen API.`,
    )
  }
})
