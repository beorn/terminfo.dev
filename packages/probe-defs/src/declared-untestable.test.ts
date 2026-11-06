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
  notTestedResult,
} from "./helpers.ts"
import { ALL_PROBES } from "./index.ts"
import { withD2LibraryObservation } from "./extensions.ts"
import { libProbeSource, inertLibProbeSource } from "./testing/group-harness.ts"
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

// @failure Phase 1 treats a generic OSC hook as support, or declares a report handoff without
// both same-run controls. The old H-1 tests covered only identity declarations, not the thirteen
// formerly Supported cells or report qualification. Typed-store contracts remain in headless-batch.
// @level l1
// @consumer ALL_PROBES library callbacks through the shipping result finalizer.
describe("app-job handoffs", () => {
  const hosts = [
    "extensions.osc176-app-id",
    "extensions.osc3008-context",
    "extensions.osc440-audio",
    "extensions.osc555-flash",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
  ] as const
  const metadata = [
    "extensions.notifications",
    "extensions.osc7-cwd",
    "extensions.osc777-notify",
    "extensions.osc633-p",
  ] as const
  const tapReason =
    "Untestable (passed to the app): this command is the app's job, and the library hands it to the app through a hook that receives every OSC command."
  const reportReason =
    "Untestable (passed to the app): this command is the app's job. The library reports that it does not handle it and hands its text to the app."
  // NR-H: the existing six-OSC cases do not cover these fourteen xterm.js cells.
  const xtermIds = [
    "editing.decsace",
    "extensions.osc9-progress",
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
  ] as const
  const csiReason =
    "Untestable: the library hands this command to the app through registerCsiHandler, as it does any CSI it does not handle itself, and does nothing with it."
  const nrHReason =
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
  const baseCell = libProbeSource(createSemanticSurface()).getCell(0, 0)
  const source = (backend: string, identity: unknown) =>
    ({
      ...inertLibProbeSource(),
      ...library(backend),
      runtimeIdentity: identity,
      feedCapture: () => "",
      getTitle: () => "",
      getCell: (row: number, col: number) => ({
        ...baseCell,
        char: ["abcdefgh", "ijklmnop"][row]?.[col] ?? " ",
        inverse: false,
      }),
      getMode: () => null,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
    }) as LibProbeSource

  // @failure NR-H stays TODO, leaks to another engine/version, or replaces a decided observation.
  // @level l1
  // @consumer Shipping probe callbacks and finalizer; the prior six-OSC set misses all NR-H cells.
  test.each(xtermIds)("xterm declares %s only at its reviewed identity", (id) => {
    const definition = ALL_PROBES.find((probe) => probe.id === id)!
    const identity = subjects[0][1]
    const result = definition.lib!(source("xterm", identity))
    expect(fold(id, result)).toMatchObject({
      status: "untestable",
      reason: id === "editing.decsace" ? csiReason : nrHReason,
    })
    expect(result.observation).toBeUndefined()
    for (const unknown of [undefined, { ...identity, engineVersion: "unreviewed" }]) {
      expect(isDeclaredUntestable(definition.lib!(source("xterm", unknown)))).toBe(false)
    }
    const decided: ProbeCallbackResult = {
      pass: true,
      observation: { outcome: "supported", assertionType: "buffer_state" },
    }
    expect(withD2LibraryObservation({ ...definition, lib: () => decided }).lib!(source("xterm", identity))).toBe(
      decided,
    )
    for (const [backend, otherIdentity] of subjects.slice(1)) {
      const other = definition.lib!(source(backend, otherIdentity))
      // Five pre-existing vterm D2 declarations remain; none gains the NR-H pass-through reason.
      expect(fold(id, other).reason).not.toBe(id === "editing.decsace" ? csiReason : nrHReason)
    }
  })

  const reporting = (
    backend: string,
    recordsMadeUp = true,
    appliesTitle = true,
    recordsTitle = false,
  ): LibProbeSource => {
    const report: { kind: "osc"; code: string }[] = []
    let title = ""
    let cwd: string | null = null
    const notifications: string[] = []
    const payloads: string[] = []
    return {
      ...source(backend, undefined),
      getTitle: () => title,
      getCwd: () => cwd,
      getNotifications: () => [...notifications],
      getOsc777Payloads: () => [...payloads],
      getUnhandledSequences: () => [...report],
      feed: (text) => {
        const osc = /\x1b\](\d+)(?:;([^\x07]*))?\x07/.exec(text)
        if (osc?.[1] === "7") cwd = osc[2] || null
        if (osc?.[1] === "633" && osc[2]?.startsWith("P;Cwd=")) cwd = osc[2].slice(6) || null
        if (osc?.[1] === "9") notifications.push(osc[2] ?? "")
        if (osc?.[1] === "777") payloads.push(osc[2] ?? "")
        if (osc?.[1] === "2") {
          if (appliesTitle) title = osc[2] ?? ""
          if (recordsTitle) report.push({ kind: "osc", code: "2" })
        } else if (osc?.[1] && (osc[1] !== "9999" || recordsMadeUp)) {
          report.push({ kind: "osc", code: osc[1] })
        }
      },
    }
  }

  test.each(["libvterm", "vt100-rust"])(
    "%s uses the run, not an engine declaration, for all ten app jobs",
    (backend) => {
      for (const id of [...hosts, ...metadata]) {
        const lib = ALL_PROBES.find((probe) => probe.id === id)!.lib!
        const result = lib(reporting(backend))
        expect(fold(id, result), id).toMatchObject({ status: "untestable", reason: reportReason })
        expect(isDeclaredUntestable(result), id).toBe(true)
        for (const ctx of [
          reporting(backend, false),
          reporting(backend, true, false),
          reporting(backend, true, true, true),
        ]) {
          const undecided = lib(ctx)
          expect(isDeclaredUntestable(undecided), id).toBe(false)
          expect(undecided.observation?.outcome, id).not.toBe("supported")
        }
      }
    },
  )

  test.each(subjects.slice(0, 2))("%s declares only its tap paths at exact engine identity", (backend, identity) => {
    const ids = [...hosts, ...(backend === "xterm" ? metadata : ["extensions.osc777-notify"])]
    for (const id of ids) {
      const lib = ALL_PROBES.find((probe) => probe.id === id)!.lib!
      expect(
        fold(id, lib({ ...reporting(backend), runtimeIdentity: source(backend, identity).runtimeIdentity })),
        id,
      ).toMatchObject({
        status: "untestable",
        reason: tapReason,
      })
      for (const changed of [undefined, { ...identity, engineVersion: "unreviewed" }]) {
        const result = lib({ ...reporting(backend), runtimeIdentity: source(backend, changed).runtimeIdentity })
        expect(isDeclaredUntestable(result), id).toBe(false)
        expect(result.observation?.outcome, id).not.toBe("supported")
      }
    }
  })

  // @failure Route 2's xterm writes stay Open, escape their identity, or replace another clipboard reader.
  // The ten app-job cases above omit OSC52 and do not protect its separate query/read route.
  // @level l1
  // @consumer Registered clipboard callbacks, existing identity predicate and shipping finalizer.
  test.each(["extensions.osc52-clipboard", "extensions.osc52-write"])(
    "xterm declares %s without changing other clipboard routes",
    (id) => {
      const definition = ALL_PROBES.find((probe) => probe.id === id)!
      const identity = subjects[0][1]
      const result = definition.lib!(source("xterm", identity))
      expect(fold(id, result)).toMatchObject({ status: "untestable", reason: tapReason })
      expect(result.observation).toBeUndefined()
      for (const unknown of [undefined, { ...identity, engineVersion: "unreviewed" }]) {
        expect(isDeclaredUntestable(definition.lib!(source("xterm", unknown)))).toBe(false)
      }
      const prior: ProbeCallbackResult = {
        pass: true,
        observation: { outcome: "supported", assertionType: "query_reply" },
      }
      const wrapped = withD2LibraryObservation({ ...definition, lib: () => prior })
      for (const [backend, otherIdentity] of subjects.slice(1)) {
        expect(wrapped.lib!(source(backend, otherIdentity))).toBe(prior)
      }
      const read = ALL_PROBES.find((probe) => probe.id === "extensions.osc52-read")!
      expect(withD2LibraryObservation({ ...read, lib: () => prior }).lib!(source("xterm", identity))).toBe(prior)
    },
  )

  test("the report verdict for library-job features stays in its existing home", () => {
    const id = "extensions.osc113-reset-pointer-fg"
    const result = ALL_PROBES.find((probe) => probe.id === id)!.lib!(reporting("libvterm"))
    expect(result.observation?.outcome).toBe("unsupported")
    expect(isDeclaredUntestable(result)).toBe(false)
  })

  test("an unlisted library keeps its prior path", () => {
    const prior: ProbeCallbackResult = {
      pass: false,
      notTested: { reason: "no-semantic-observable", noObservable: "prior undecided result" },
    }
    const definition = ALL_PROBES.find((probe) => probe.id === hosts[0])!
    const wrapped = withD2LibraryObservation({ ...definition, lib: () => prior })
    expect(wrapped.lib!(source("other-library", undefined))).toBe(prior)
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
  const ghosttyR3Identity = {
    ...ghosttyIdentity,
    termlessRevision: "1e61d17c546139386a9ab78abeaa753660d3e93c",
    loadedBinary: {
      ...ghosttyIdentity.loadedBinary,
      sha256: "bb0c0c6a34997fc4850756e095d1ae978fb9fa046d87eb91847d9e0e6bdfb207",
    },
    provenance: {
      ...ghosttyIdentity.provenance,
      sha256: "bb0c0c6a34997fc4850756e095d1ae978fb9fa046d87eb91847d9e0e6bdfb207",
      buildHash: "83a45eb6571bf3d44a3cf8d0b5fdd5b1941d742ca5e33fd2bf6f142f7d7451fb",
    },
    adapterSources: [
      { path: "packages/ghostty-native/src/index.ts", blobOid: "35c9e35a5d60625ce1135b65ff38ae9278495a18" },
      { path: "packages/ghostty-native/src/backend.ts", blobOid: "9bda39988b0af9c66fcc342ca477cf9daab2f5ac" },
    ],
  } satisfies HeadlessRuntimeIdentity
  const ghosttyR372efIdentity = {
    ...ghosttyR3Identity,
    termlessRevision: "dfa25540d38b2a098189810e015d8e3ebf5c8552",
    adapterSources: [
      { path: "packages/ghostty-native/src/index.ts", blobOid: "35c9e35a5d60625ce1135b65ff38ae9278495a18" },
      { path: "packages/ghostty-native/src/backend.ts", blobOid: "72ef06ecf72f2509c097aff3260914d098ff010a" },
    ],
  } satisfies HeadlessRuntimeIdentity
  // @failure A native build with library-forced graphics disabled stays TODO or an enabled build borrows its absence.
  // @level l1
  // @consumer The two registered native image callbacks and shipping result fold; older image cohorts omit native.
  test.each(["extensions.kitty-graphics.display", "extensions.kitty-graphics.transmit"])(
    "R3 native %s declares only the actual disabled library build",
    (id) => {
      const definition = ALL_PROBES.find((entry) => entry.id === id)!
      const source: LibProbeSource = {
        ...library("ghostty-native"),
        runtimeIdentity: ghosttyIdentity,
        capabilities: { ...library().capabilities, kittyGraphics: false },
        feedCapture: () => "",
      }
      expect(fold(id, definition.lib!(source))).toMatchObject({
        status: "untestable",
        reason: expect.stringMatching(/ghostty-vt.*forces oniguruma off.*kitty_graphics off/),
      })
      for (const extra of [
        { capabilities: { ...source.capabilities, kittyGraphics: true } },
        { runtimeIdentity: undefined },
        { backendName: "ghostty" },
        { runtimeIdentity: { ...ghosttyIdentity, engineVersion: "unreviewed" } },
        {
          runtimeIdentity: {
            ...ghosttyIdentity,
            provenance: { ...ghosttyIdentity.provenance, lockSha256: "0".repeat(64) },
          },
        },
      ]) {
        expect(isDeclaredUntestable(definition.lib!({ ...source, ...extra }))).toBe(false)
      }
      for (const outcome of ["supported", "unsupported"] as const) {
        const decided: ProbeCallbackResult = {
          pass: outcome === "supported",
          observation: { outcome, assertionType: "query_reply" },
        }
        expect(withD2LibraryObservation({ ...definition, lib: () => decided }).lib!(source)).toBe(decided)
      }
    },
  )

  // @failure NR-I's seven reviewed cells stay TODO or leak onto an unaudited engine.
  // @level l1
  // @consumer Registered library callbacks and the shipping finalizer; prior native cohorts omit these seven.
  test.each([
    "editing.decsace",
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.osc-633-vscode",
  ])("NR-I %s declares only the reviewed native engine and preserves observations", (id) => {
    const definition = ALL_PROBES.find((entry) => entry.id === id)!
    const source: LibProbeSource = {
      ...library("ghostty-native"),
      runtimeIdentity: ghosttyIdentity,
      feedCapture: () => "",
      getTitle: () => "",
      getMode: () => null,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
    }
    const result = definition.lib!(source)
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(fold(id, result)).toMatchObject({
      status: "untestable",
      reason: expect.stringContaining(
        "Untestable (no way): the library offers no reading or input our test could use for this feature:",
      ),
    })
    expect(fold(id, result).reason).toContain(id === "editing.decsace" ? "DECSACE" : "OSC 633")
    expect(result.observation).toBeUndefined()
    for (const runtimeIdentity of [
      undefined,
      { ...ghosttyIdentity, engineVersion: "unreviewed" },
      { ...ghosttyIdentity, provenance: { ...ghosttyIdentity.provenance, sourceCommit: "0".repeat(40) } },
      { ...ghosttyIdentity, provenance: { ...ghosttyIdentity.provenance, lockSha256: "0".repeat(64) } },
    ]) {
      expect(isDeclaredUntestable(definition.lib!({ ...source, runtimeIdentity }))).toBe(false)
    }
    const decided: ProbeCallbackResult = {
      pass: true,
      observation: { outcome: "supported", assertionType: "buffer_state" },
    }
    expect(withD2LibraryObservation({ ...definition, lib: () => decided }).lib!(source)).toBe(decided)
    const prior: ProbeCallbackResult = {
      pass: false,
      notTested: { reason: "no-semantic-observable", noObservable: "prior undecided result" },
    }
    const wrapped = withD2LibraryObservation({ ...definition, lib: () => prior })
    expect(wrapped.lib!({ ...source, backendName: "other-library" })).toBe(prior)
    expect(wrapped.lib!({ ...source, getUnhandledSequences: () => [] })).toBe(prior)
  })

  // @failure The seven app-request rows stay TODO, leak to another build, or replace an available reading.
  // @level l1
  // @consumer Registered library callbacks and finalizer; the original NR-I set contains none of these rows.
  test.each([
    "extensions.osc0-icon-title",
    "extensions.osc10-fg-color",
    "extensions.osc11-bg-color",
    "extensions.osc12-cursor-color",
    "device.primary-da",
    "device.xtwinops-14",
    "extensions.sixel-da1",
  ])("native app-request %s retains the ruled cause and existing readings", (id) => {
    const definition = ALL_PROBES.find((entry) => entry.id === id)!
    const source: LibProbeSource = {
      ...library("ghostty-native"),
      runtimeIdentity: ghosttyIdentity,
      feedCapture: () => "",
      getTitle: () => "",
    }
    const result = definition.lib!(source)
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(fold(id, result)).toMatchObject({
      status: "untestable",
      reason: expect.stringContaining(
        id === "extensions.osc0-icon-title" ? "Untestable (no way):" : "Untestable (app):",
      ),
    })
    expect(result.observation).toBeUndefined()
    for (const runtimeIdentity of [
      undefined,
      { ...ghosttyIdentity, engineVersion: "unreviewed" },
      { ...ghosttyIdentity, provenance: { ...ghosttyIdentity.provenance, sourceCommit: "0".repeat(40) } },
      { ...ghosttyIdentity, provenance: { ...ghosttyIdentity.provenance, lockSha256: "0".repeat(64) } },
    ]) {
      expect(isDeclaredUntestable(definition.lib!({ ...source, runtimeIdentity }))).toBe(false)
    }
    for (const outcome of ["supported", "unsupported"] as const) {
      const decided: ProbeCallbackResult = {
        pass: outcome === "supported",
        observation: { outcome, assertionType: "query_reply" },
      }
      expect(withD2LibraryObservation({ ...definition, lib: () => decided }).lib!(source)).toBe(decided)
    }
    const prior: ProbeCallbackResult = {
      pass: false,
      notTested: { reason: "no-semantic-observable", noObservable: "prior undecided result" },
    }
    const wrapped = withD2LibraryObservation({ ...definition, lib: () => prior })
    expect(wrapped.lib!({ ...source, backendName: "other-library" })).toBe(prior)
    expect(wrapped.lib!({ ...source, getUnhandledSequences: () => [] })).toBe(prior)
    if (id === "extensions.osc0-icon-title") {
      expect(wrapped.lib!({ ...source, getIconLabel: () => "" })).toBe(prior)
    }
    const colour = /osc(10|11|12)-/.exec(id)?.[1]
    if (colour) {
      const positive = definition.lib!({
        ...source,
        feedCapture: () => `\x1b]${colour};rgb:1111/2222/3333\x07`,
      })
      expect(positive.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(isDeclaredUntestable(positive)).toBe(false)
    }
  })

  // @failure The six mouse rows retain an adapter-shaped TODO instead of the reviewed library limitation.
  // @level l1
  // @consumer Registered callbacks and finalizer; prior declaration cohorts omit these mouse reports.
  test.each([
    "input.button-event-mouse",
    "input.pixel-mouse",
    "input.x10-mouse",
    "input.xtest-click",
    "input.xtest-wheel",
    "input.urxvt-mouse",
  ])("native mouse %s declares only the reviewed library and preserves decided results", (id) => {
    const definition = ALL_PROBES.find((entry) => entry.id === id)!
    const source: LibProbeSource = {
      ...library("ghostty-native"),
      runtimeIdentity: ghosttyIdentity,
      feedCapture: () => "",
      getMode: () => null,
    }
    const result = definition.lib!(source)
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(fold(id, result)).toMatchObject({
      status: "untestable",
      reason:
        "Untestable: Ghostty 1.3.1's library has no mouse encoder; only Surface writes a mouse report, and Surface is the app.",
    })
    expect(result.observation).toBeUndefined()
    for (const runtimeIdentity of [
      undefined,
      { ...ghosttyIdentity, engineVersion: "unreviewed" },
      { ...ghosttyIdentity, provenance: { ...ghosttyIdentity.provenance, sourceCommit: "0".repeat(40) } },
      { ...ghosttyIdentity, provenance: { ...ghosttyIdentity.provenance, lockSha256: "0".repeat(64) } },
    ]) {
      const fallback = definition.lib!({ ...source, runtimeIdentity })
      expect(isDeclaredUntestable(fallback)).toBe(false)
      expect(fold(id, fallback).status).toBe("probe-todo")
    }
    for (const outcome of ["supported", "unsupported"] as const) {
      const decided: ProbeCallbackResult = {
        pass: outcome === "supported",
        observation: { outcome, assertionType: "input_bytes" },
      }
      expect(withD2LibraryObservation({ ...definition, lib: () => decided }).lib!(source)).toBe(decided)
    }
    const prior: ProbeCallbackResult = {
      pass: false,
      notTested: { reason: "no-semantic-observable", noObservable: "prior undecided result" },
    }
    const wrapped = withD2LibraryObservation({ ...definition, lib: () => prior })
    expect(wrapped.lib!({ ...source, backendName: "other-library" })).toBe(prior)
    expect(wrapped.lib!({ ...source, getUnhandledSequences: () => [] })).toBe(prior)
  })

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
    ["ghostty-native", ghosttyR3Identity, ids, /Ghostty.*no.*(state|report|route)/i],
    ["ghostty-native", ghosttyR372efIdentity, ids, /Ghostty.*no.*(state|report|route)/i],
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
        ...(backendName === "ghostty-native"
          ? [
              {
                ...runtimeIdentity,
                adapterSources:
                  runtimeIdentity === ghosttyIdentity
                    ? ghosttyR3Identity.adapterSources
                    : ghosttyIdentity.adapterSources,
              },
            ]
          : []),
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

  // @cto routes-32 section 4: slice C, four no-way declarations at exact library identity.
  const ghosttyWebIdentity = {
    kind: "js",
    adapterVersion: "0.11.0",
    termlessRevision: "10dbfe015d27357bac7f2337e2a828a5afe0ad97",
    resolvedPath: "ghostty-web/dist/ghostty-web.js",
    integrity: {
      kind: "source",
      repository: "git@github.com:beorn/termless.git",
      revision: "10dbfe015d27357bac7f2337e2a828a5afe0ad97",
      treeOid: "5b2708cb4ee7b99b0a80c8970ec13c7ac673cbe4",
      cleanTree: true,
    },
    runtimeFormat: "wasm",
    engineVersion: "0.4.0",
    loadedBinary: {
      path: "ghostty-web/ghostty-vt.wasm",
      sha256: "aaf8ce18ad92e98b1233d85b5f71043aceccf3abbc75dea07e1c704cd3ae690a",
    },
  } as unknown as HeadlessRuntimeIdentity
  test.each([
    ["kitty", kittyIdentity, "input.kitty-click-events", /Window/],
    ["ghostty-native", ghosttyIdentity, "input.kitty-click-events", /Surface/],
    ["ghostty-native", ghosttyR3Identity, "input.kitty-click-events", /Surface/],
    ["ghostty-native", ghosttyR372efIdentity, "input.kitty-click-events", /Surface/],
    ["ghostty", ghosttyWebIdentity, "input.kitty-click-events", /WASM/],
    ["ghostty", ghosttyWebIdentity, "extensions.clipboard-paste", /paste encoder/],
  ] as const)("slice C: %s %s declares only at its exact identity", (backendName, runtimeIdentity, id, reason) => {
    const definition = ALL_PROBES.find((entry) => entry.id === id)!
    const source = { ...library(backendName), runtimeIdentity }
    const result = definition.lib!(source)
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(fold(id, result)).toMatchObject({ status: "untestable", reason: expect.stringMatching(reason) })
    const changed = { ...runtimeIdentity, engineVersion: "0.0.0" } as HeadlessRuntimeIdentity
    expect(isDeclaredUntestable(definition.lib!({ ...source, runtimeIdentity: changed }))).toBe(false)
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
    const blank = inertLibProbeSource().getCell(0, 0)
    return {
      ...library("wezterm"),
      runtimeIdentity: identity,
      feedCapture: () => "",
      getTitle: () => "",
      getCell: (row, col) => ({ ...blank, char: ["abcdefgh", "ijklmnop"][row]?.[col] ?? " " }),
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
    ["editing.decsace", /DECSACE.*no handler.*opt-in log.*off/],
    ["extensions.osc52-read", /OSC 52.*QuerySelection.*empty.*reply/],
    ["extensions.osc133-d", /OSC 133 D.*empty.*status/],
    ["extensions.semantic-prompts", /OSC 133 D.*complete.*cycle/],
    ["extensions.osc633-a", /OSC 633.*no handler.*opt-in log.*off/],
    ["extensions.osc633-b", /OSC 633.*no handler.*opt-in log.*off/],
    ["extensions.osc633-c", /OSC 633.*no handler.*opt-in log.*off/],
    ["extensions.osc633-d", /OSC 633.*no handler.*opt-in log.*off/],
    ["extensions.osc633-e", /OSC 633.*no handler.*opt-in log.*off/],
    ["extensions.osc-633-vscode", /OSC 633.*no handler.*opt-in log.*off/],
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

  test("the public 0.11.0 adapter retains the audited interface absences", () => {
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

  test("unqualified runtime identities retain their existing outcomes", () => {
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
        expect(fold(id, result).status, id).toBe(
          id === "extensions.osc52-read" && runtimeIdentity === undefined ? "probe-invalid" : "probe-todo",
        )
      }
    }
  })

  // @failure The rebuilt semantic-cell addon loses delivered absences or borrows the old binary's audit.
  // @level l1
  // @consumer Exact native identity qualification before shipping WezTerm D2 declarations.
  test("the semantic-cell build retains all twenty absences only with its coupled source audit", () => {
    const runtimeIdentity = {
      ...identity,
      loadedBinary: {
        ...identity.loadedBinary,
        sha256: "74adefb8d3579e58480130efa7672b6c3d2d9006aa2f897bde52791ccf7c1eeb",
      },
      provenance: {
        ...identity.provenance,
        sha256: "74adefb8d3579e58480130efa7672b6c3d2d9006aa2f897bde52791ccf7c1eeb",
        sourceCommit: "e4d7316cd1f187be48f3c44087e60dad0f785159",
        buildHash: "79d5c6fe69ff1f7804d83adbe458db199f1bb9b81a18c1b4ada22ac123390974",
      },
      adapterSources: identity.adapterSources.map((entry) => ({
        ...entry,
        blobOid:
          entry.path === "packages/wezterm/src/backend.ts"
            ? "a260d3df32acf13ee7aedfbd4eabfc99c69330b9"
            : entry.path === "packages/wezterm/native/src/lib.rs"
              ? "7040dba8959e01fb6fde625e426b6059a5ef65f3"
              : entry.blobOid,
      })),
    }
    for (const [id] of targets) {
      expect(
        isDeclaredUntestable(ALL_PROBES.find((probe) => probe.id === id)!.lib!(source({ runtimeIdentity }))),
        id,
      ).toBe(true)
      for (const mixed of [
        { ...runtimeIdentity, loadedBinary: identity.loadedBinary, provenance: identity.provenance },
        { ...runtimeIdentity, adapterSources: identity.adapterSources },
      ]) {
        expect(
          isDeclaredUntestable(ALL_PROBES.find((probe) => probe.id === id)!.lib!(source({ runtimeIdentity: mixed }))),
          id,
        ).toBe(false)
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

  // @failure Replacing an undecided read with a declaration drops its measured host cause and invalidates collection.
  // @level l1
  // @consumer The declaration callback metadata retained by the headless host-recipe recorder.
  test("an interface absence retains the measured empty-read host cause", () => {
    const definition = ALL_PROBES.find((probe) => probe.id === "extensions.osc52-read")!
    const result = definition.lib!(source())
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(result.hostRecipeCauses).toEqual([
      {
        recipe: "clipboard-load",
        cause: { kind: "observed", missing: "clipboard-read-permission", query: "\x1b]52;c;?\x07" },
      },
    ])
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
// XTEST key injection is declared only for the six libraries with no public key encoder (CTO 47010d76, #32428).
test("vterm's Sixel storage arm and the encoder-exporting XTEST arms are not declared and stay PROBE TODO", () => {
  const sixel = ALL_PROBES.find((probe) => probe.id === "extensions.sixel")!.lib!
  const stored = sixel({ ...library("vterm"), getSixelImages: () => [] } as unknown as LibProbeSource)
  expect(isDeclaredUntestable(stored)).toBe(false)
  expect(fold("extensions.sixel", stored).status).toBe("probe-todo")
  const xtest = ALL_PROBES.find((probe) => probe.id === "input.xtest-key")!.lib!
  for (const backendName of ["libvterm"]) {
    const result = xtest(library(backendName)) as ProbeCallbackResult
    expect(isDeclaredUntestable(result)).toBe(false)
    expect(fold("input.xtest-key", result).status).toBe("probe-todo")
  }
  for (const backendName of ["vt100", "vterm"]) {
    expect(isDeclaredUntestable(xtest(library(backendName)) as ProbeCallbackResult)).toBe(true)
  }
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

  // @failure A Kitty image cell is declared "no way" at the wrong identity, or a library that has a
  // public image path is declared instead of being routed to a reader (CTO 8be19f1f).
  // @level l1
  // @consumer ALL_PROBES library callbacks folded by the shipping result finalizer
  test("audited image and Ghostty web absences fold only at each exact identity", () => {
    const xterm = {
      kind: "js" as const,
      runtimeFormat: "js" as const,
      adapterVersion: "0.10.2",
      termlessRevision: "74672f85dc9fa58f8fd93b5e32e3e6c7487a5549",
      engineVersion: "6.0.0",
      integrity: {
        kind: "registry" as const,
        lockIntegrity:
          "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
      },
    }
    const subjects = [
      ["alacritty", d2Source(), /alacritty_terminal 0\.26\.0.*no public APC callback/i],
      [
        "vt100",
        {
          ...library("vt100"),
          feedCapture: () => "",
          getTitle: () => "",
          runtimeIdentity: vtIdentity("vt100", "d0e3d3fe4e893b70bd3f7d95725b4e10c1f6d99d", "0.13.1"),
        },
        /vt100\.js 0\.13\.1.*strict DEC VT100/i,
      ],
      [
        "vt220",
        {
          ...library("vt220"),
          feedCapture: () => "",
          getTitle: () => "",
          runtimeIdentity: vtIdentity("vt220", "5162719d063ab59d2905d588df3e127d38b110d1", "0.13.1"),
        },
        /vt220\.js 0\.13\.1.*sixel\/Kitty graphics deliberately absent/i,
      ],
      [
        "xterm",
        { ...library("xterm"), feedCapture: () => "", getTitle: () => "", runtimeIdentity: xterm },
        /@xterm\/headless 6\.0\.0.*APC, PM and SOS/i,
      ],
      [
        "ghostty",
        {
          ...library("ghostty"),
          feedCapture: () => "",
          getTitle: () => "",
          runtimeIdentity: {
            kind: "js" as const,
            runtimeFormat: "wasm" as const,
            adapterVersion: "0.10.2",
            termlessRevision: "2f73fc28027b7d483e504e08edc64d1837935816",
            engineVersion: "0.4.0",
            loadedBinary: {
              path: "vendor/termless/vendor/ghostty-web/ghostty-vt.wasm",
              sha256: "aaf8ce18ad92e98b1233d85b5f71043aceccf3abbc75dea07e1c704cd3ae690a",
            },
            integrity: {
              kind: "source" as const,
              repository: "git@github.com:beorn/termless.git",
              revision: "2f73fc28027b7d483e504e08edc64d1837935816",
              treeOid: "5b2708cb4ee7b99b0a80c8970ec13c7ac673cbe4",
              cleanTree: true,
            },
          },
        },
        /ghostty-web 0\.4\.0.*no public image store or APC callback/i,
      ],
    ] as const
    for (const [name, source, reason] of subjects) {
      for (const id of ["extensions.kitty-graphics.display", "extensions.kitty-graphics.transmit"]) {
        const label = name + ":" + id
        const result = ALL_PROBES.find((probe) => probe.id === id)!.lib!(source as LibProbeSource)
        expect(isDeclaredUntestable(result), label).toBe(true)
        expect(fold(id, result), label).toMatchObject({
          status: "untestable",
          reason: expect.stringMatching(reason),
        })
        expect(result.assertions, label).toBeUndefined()
      }
    }
    // NR-G: existing image rows cannot catch missing shell/icon/pointer/clipboard
    // declarations, an engine-cohort leak, or a declaration replacing an actual reader.
    const ghostty = subjects.find(([name]) => name === "ghostty")![1] as LibProbeSource
    const ghosttyIds = [
      "extensions.osc133-a",
      "extensions.osc133-b",
      "extensions.osc133-c",
      "extensions.osc133-d",
      "extensions.semantic-prompts",
      "extensions.osc0-icon-title",
      "extensions.osc1-icon",
      "extensions.osc22-pointer",
      "extensions.osc52-clipboard",
      "extensions.osc52-write",
    ]
    for (const id of ghosttyIds) {
      const definition = ALL_PROBES.find((entry) => entry.id === id)!
      const result = definition.lib!(ghostty)
      expect.soft(isDeclaredUntestable(result), id).toBe(true)
      expect.soft(fold(id, result), id).toMatchObject({
        status: "untestable",
        reason: expect.stringMatching(
          id === "extensions.osc52-write" ? /ghostty-web 0\.4\.0.*app/i : /ghostty-web 0\.4\.0/i,
        ),
      })
      const prior = notTestedResult("undecided existing callback", {})
      const wrapped = withD2LibraryObservation({ ...definition, lib: () => prior }).lib!
      const identity = ghostty.runtimeIdentity as Extract<HeadlessRuntimeIdentity, { kind: "js" }>
      if (identity.kind !== "js" || identity.runtimeFormat !== "wasm" || identity.integrity.kind !== "source") {
        throw new Error("Expected the existing Ghostty web audited source fixture")
      }
      for (const changed of [
        { runtimeIdentity: { ...identity, engineVersion: "0.4.1" } },
        { runtimeIdentity: { ...identity, loadedBinary: { ...identity.loadedBinary, sha256: "different" } } },
        { runtimeIdentity: { ...identity, integrity: { ...identity.integrity, treeOid: "different" } } },
        { runtimeIdentity: { ...identity, integrity: { ...identity.integrity, cleanTree: false } } },
        { backendName: "ghostty-native" },
      ]) {
        expect(wrapped({ ...ghostty, ...changed } as LibProbeSource), id).toBe(prior)
      }
      for (const pass of [true, false]) {
        const decided = parserStateResult(pass, "existing measured reader", { pass })
        expect(withD2LibraryObservation({ ...definition, lib: () => decided }).lib!(ghostty), id).toBe(decided)
      }
    }
    // The declaration follows the identity, not the backend name alone.
    const transmit = ALL_PROBES.find((probe) => probe.id === "extensions.kitty-graphics.transmit")!.lib!
    for (const extra of [
      { runtimeIdentity: { ...alacritty, engineVersion: "0.26.1" } },
      { runtimeIdentity: undefined },
      { backendName: "kitty" },
    ] satisfies Partial<LibProbeSource>[]) {
      expect(isDeclaredUntestable(transmit(d2Source(extra)))).toBe(false)
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
    // routes-16 rows 9 and 10 make DECSSCLS and blink declared at alacritty_terminal 0.26.0, so the
    // unclear set narrows to the two with no reviewed absence, and the new pair follows the identity.
    for (const id of ["extensions.osc22-pointer", "extensions.osc1-icon"]) {
      expect(isDeclaredUntestable(ALL_PROBES.find((probe) => probe.id === id)!.lib!(d2Source())), id).toBe(false)
    }
    const decsscls = ALL_PROBES.find((probe) => probe.id === "modes.decsscls")!.lib!
    const decssclsResult = decsscls(d2Source())
    expect(isDeclaredUntestable(decssclsResult)).toBe(true)
    expect(fold("modes.decsscls", decssclsResult)).toMatchObject({
      status: "untestable",
      reason: expect.stringMatching(/CSI 9 SP p \(DECSSCLS\) scroll-speed state.*this CSI has no handler/i),
    })
    for (const extra of [
      { runtimeIdentity: { ...alacritty, engineVersion: "0.26.1" } },
      { backendName: "kitty" },
      { runtimeIdentity: undefined },
    ] satisfies Partial<LibProbeSource>[]) {
      expect(isDeclaredUntestable(decsscls(d2Source(extra)))).toBe(false)
    }
    const blink = ALL_PROBES.find((probe) => probe.id === "sgr.blink")!.lib!
    expect(fold("sgr.blink", blink(d2Source()))).toMatchObject({
      status: "untestable",
      reason:
        "Alacritty alacritty_terminal 0.26.0 handles blink by writing a debug line and keeps no blink flag, so no public state, reply or typed event exists.",
    })
    expect(isDeclaredUntestable(blink(d2Source({ runtimeIdentity: { ...alacritty, engineVersion: "0.26.1" } })))).toBe(
      false,
    )
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
] as const)("DEC declarations are exact %s/%s", (backendName, engineVersion, declared) => {
  for (const id of ["modes.decsscls", "editing.decsace"]) {
    const definition = ALL_PROBES.find((entry) => entry.id === id)!
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
    // This DECSACE fixture has no measured frames; a version miss keeps that invalid criterion.
    expect(fold(definition.id, result).status).toBe(
      declared ? "untestable" : id === "editing.decsace" ? "probe-invalid" : "probe-todo",
    )
    if (declared && id === "modes.decsscls") {
      expect(result.tests?.[0]?.reason).toBe(
        `${backendName === "vt100" ? "VT100.js" : "VT220.js"} 0.13.1 exposes no scroll-speed state or presentation-speed observer through its public Screen API.`,
      )
    }
  }
})
