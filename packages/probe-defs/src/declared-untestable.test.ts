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
} from "./helpers.ts"
import { ALL_PROBES } from "./index.ts"
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
