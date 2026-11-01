/**
 * @failure OSC prefix echoes, capability flags, and later cursor replies were accepted as extension support.
 * @level l0
 * @consumer App and headless extension observations used by the unified selector.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import { deviceProbes, TERM_FEATURES_API_CITATIONS } from "./device.ts"
import { replayTermProbeSource } from "./testing/group-harness.ts"
import { ADAPTER_SOURCE_AUDITS, SOURCE_TREE_AUDITS } from "./helpers.ts"
import type { HeadlessRuntimeIdentity, TermProbeSource, LibProbeSource } from "./types.ts"

// Callback intent is distinct from producer formatting: malformed bytes must never opt into
// silence evidence. Existing reply qualification cases did not inspect that execution contract.
test.each([
  ["extensions.osc17-highlight-bg", "OSC", "\x1b]17;broken\x07"],
  ["extensions.sixel-da1", "DA1", "\x1b[?broken"],
  ["extensions.sixel-geometry-report", "Sixel geometry", "\x1b[?2;brokenS"],
] as const)("%s marks only an empty raw reply", async (id, kind, malformed) => {
  const definition = callback(id)
  for (const raw of ["", malformed, "unrelated output"]) {
    const query = async (_sequence: string, pattern: RegExp) => ({
      match: pattern.exec(raw),
      reason: "timeout" as const,
      raw,
      rawBase64: Buffer.from(raw).toString("base64"),
    })
    const results = [
      definition.lib!({ feedCapture: () => raw } as unknown as LibProbeSource),
      await definition.term!({ queryOutcome: query, queryWithSentinelOutcome: query } as unknown as TermProbeSource),
    ]
    for (const result of results) {
      expect(result.tests).toMatchObject([{ id: "criterion", status: "test-failure" }])
      expect(result.assertions).toBeUndefined()
      if (raw === "") {
        expect(result).toHaveProperty("replyFailureTestIds", ["criterion"])
      } else {
        expect(result).not.toHaveProperty("replyFailureTestIds")
        expect(result.tests?.[0]?.reason).toBe(`Malformed ${kind} reply: ${JSON.stringify(raw)}`)
        expect(result.observation?.reason).toBe("invalid-reply")
      }
    }
  }
})

function callback(id: string) {
  const definition = extensionsProbes.find((item) => item.id === id)
  if (!definition?.lib || !definition.term) throw new Error(`missing extension callback ${id}`)
  return definition
}

const xtermOscIdentity = {
  kind: "js",
  runtimeFormat: "js",
  engineVersion: "6.0.0",
  adapterVersion: "0.10.2",
  termlessRevision: "84003d2c91610fe2743142675234a0fb3ec9cf1d",
  adapterSources: [
    { path: "packages/xtermjs/src/index.ts", blobOid: "550e10110ec2baaf326d2958319b03ee8208feba" },
    { path: "packages/xtermjs/src/backend.ts", blobOid: "79bc4dc6a1060d073f12d59ecd6b941cadfe91dd" },
  ],
  resolvedPath: "node_modules/.bun/@xterm+headless@6.0.0/node_modules/@xterm/headless/lib-headless/xterm-headless.js",
  integrity: {
    kind: "registry",
    lockIntegrity: "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
  },
} as const

const auditedArtifacts: readonly HeadlessRuntimeIdentity[] = [
  {
    kind: "native",
    engineVersion: "0.26.0",
    adapterVersion: "0.10.2",
    termlessRevision: "824119c28b46bd701b222a91df0da860f0307950",
    loadedBinary: {
      path: "/relocated/alacritty.node",
      sha256: "21d4b43c1d4c401c5b9f8114de85b3e837605242363c322c2dcb37e4a42fba61",
    },
    provenance: {
      sha256: "21d4b43c1d4c401c5b9f8114de85b3e837605242363c322c2dcb37e4a42fba61",
      sourceCommit: "824119c28b46bd701b222a91df0da860f0307950",
      buildHash: "634c14c5258327eff925d20d24918098c9aee92c1e6291e0ca770d2677015171",
      lockSha256: "1f89f2579b7d786a116d8fefb8267c4af076bd3a3893adcf14b00c4466740497",
      toolchain: "retained build receipt",
    },
    adapterSources: [
      { path: "packages/alacritty/src/index.ts", blobOid: "b4154cbd6ef4a83ce2cbf3dcf26ff13d645efd05" },
      { path: "packages/alacritty/src/backend.ts", blobOid: "4210383129879c4e8756e6975674632cf69ecce9" },
      { path: "packages/alacritty/native/src/lib.rs", blobOid: "e4720590d652773f1e89caf2b5cb399ee9112e39" },
      { path: "src/load-native.ts", blobOid: "34e142550085450ab02138184626716ad0d6b546" },
    ],
  },
  {
    kind: "js",
    runtimeFormat: "wasm",
    engineVersion: "0.3.3",
    adapterVersion: "0.10.2",
    termlessRevision: "f736cce4",
    resolvedPath: "/relocated/libvterm/index.ts",
    integrity: {
      kind: "source",
      repository: "git@github.com:beorn/termless.git",
      revision: "f736cce4",
      treeOid: "changed-wrapper-tree",
      cleanTree: true,
    },
    loadedBinary: {
      path: "/relocated/libvterm.wasm",
      sha256: "7ebe1b994b58ca867dcd19e9cdeb10b8839b6c1f0dbdea024f875a9f57560a23",
    },
    adapterSources: [
      { path: "packages/libvterm/src/index.ts", blobOid: "2b4708b1081e701b99893ca055ded781dc46cf25" },
      { path: "packages/libvterm/src/backend.ts", blobOid: "caa5dc6c4ac4e3dac45977466919d2c1dcd3e851" },
      { path: "packages/libvterm/src/wasm-bindings.ts", blobOid: "2bbd4d5cf59b8d53db8f5c0329d2ed7853c43e45" },
      { path: "packages/libvterm/wasm/libvterm.js", blobOid: "1e784be87614ab924b96844009919b7c21ce150e" },
    ],
  },
]

// #32026: frozen engine and adapter tuples from retained captures. The existing two-artifact
// checks cover OSC8/alacritty440, so they miss absent rows/codes in this 30-cell source batch.
const absentOscBatch = [
  { engine: "libvterm", identity: auditedArtifacts[1]!, codes: [9, 22, 176, 3008, 440, 555, 666, 710, 777] },
  {
    engine: "ghostty",
    identity: {
      kind: "js",
      runtimeFormat: "wasm",
      engineVersion: "0.4.0",
      adapterVersion: "0.10.2",
      termlessRevision: "f736cce493439cf9d651297c2a920cb61fa05fb5",
      resolvedPath: "/fixture/ghostty/index.js",
      integrity: {
        kind: "source",
        repository: "git@github.com:beorn/termless.git",
        revision: "f736cce493439cf9d651297c2a920cb61fa05fb5",
        treeOid: "d5302357ba7d86ae224d0b72acefb045e2fe5d81",
        cleanTree: true,
      },
      loadedBinary: {
        path: "/fixture/ghostty.wasm",
        sha256: "1f23e13db5bda55ab54943461b83a5d642bf8d2050a452fbe7871927383dfe9f",
      },
      adapterSources: [
        { path: "packages/ghostty/src/index.ts", blobOid: "f4b9d9f3e13cc515b23abc739cab21bf971e8585" },
        { path: "packages/ghostty/src/backend.ts", blobOid: "7a917fe46b72d9870b898e71d440e7cb876b3fc1" },
      ],
    },
    codes: [176, 3008, 440, 555, 666, 710],
  },
  ...[
    {
      engine: "vt100Rust",
      engineVersion: "0.16.2",
      sha256: "dc3b24de6e91416f66b1953ce101991ef7e78602ce1b5d357f65832c9b96b326",
      sourceCommit: "27297cf2a4a4e21b41ca3aafc7bc87ac36086fdf",
      buildHash: "d5079c0f2a27be41c9a3f6b152d62da2bbf82fd189fdfb487b5a0c8b3ed8a654",
      lockSha256: "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6",
      adapterSources: [
        { path: "packages/vt100-rust/src/index.ts", blobOid: "3ddb74f3ae1f79bb356952103853232f69211268" },
        { path: "packages/vt100-rust/src/backend.ts", blobOid: "abbbfd01d9e6ac880e02b00d9acccdc9ec70bc63" },
      ],
      codes: [9, 22, 176, 3008, 440, 555, 666, 710, 777],
    },
    {
      engine: "kitty",
      engineVersion: "0.49.2",
      sha256: "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886",
      sourceCommit: "b2cb871254fbdac19a085188813c8dfb258b95cd",
      buildHash: "88e840e1b8e7f09edf3464ee33df8753fd5107838de15bccb6ea59e0dd6cc9c3",
      lockSha256: "282d1098337a5705a7c1d13188a74d2fe34565766619e8d6b21a48d5b67451be",
      adapterSources: [
        { path: "packages/kitty/src/index.ts", blobOid: "3f207f911646613cdc3d8b04f155f0686a96a077" },
        { path: "packages/kitty/src/backend.ts", blobOid: "5e98a200eab31eeef6505e81470d350637b5959c" },
        { path: "packages/kitty/build/bridge.py", blobOid: "02b4fb4c49975c4b9f9856385f1e6a5acd2492df" },
      ],
      codes: [176, 3008, 440, 555, 666, 710],
    },
  ].map(({ engine, engineVersion, sha256, sourceCommit, buildHash, lockSha256, adapterSources, codes }) => ({
    engine,
    codes,
    identity: {
      kind: "native" as const,
      engineVersion,
      adapterVersion: "0.10.2",
      termlessRevision: "f736cce493439cf9d651297c2a920cb61fa05fb5",
      loadedBinary: { path: "/fixture/native", sha256 },
      provenance: { sha256, sourceCommit, buildHash, lockSha256, toolchain: "retained build provenance" },
      adapterSources,
    },
  })),
] satisfies readonly { engine: string; identity: HeadlessRuntimeIdentity; codes: readonly number[] }[]

test.each(absentOscBatch)(
  "$engine source-negative OSC batch requires the exact engine, adapter and X control",
  ({ identity, codes }) => {
    const features: Record<number, string> = {
      9: "osc9-progress",
      22: "osc22-pointer",
      176: "osc176-app-id",
      3008: "osc3008-context",
      440: "osc440-audio",
      555: "osc555-flash",
      666: "osc666-termprop",
      710: "osc710-font-normal",
      777: "osc777-notify",
    }
    for (const code of codes) {
      const definition = callback(`extensions.${features[code]}`)
      const run = (runtimeIdentity: HeadlessRuntimeIdentity, char = "X") =>
        definition.lib!({
          runtimeIdentity,
          feed: () => undefined,
          getCell: () => ({ char }),
        } as unknown as LibProbeSource)
      const result = run(identity)
      // Keep every missing protocol row visible while retaining one identity-contract case per engine.
      expect.soft(result.criterionBranch, String(code)).toBe("source-negative-review")
      expect.soft(result.assertions, String(code)).toMatchObject([{ assertionType: "buffer_state", kind: "negative" }])
      expect(run(identity, "?").assertions, String(code)).toBeUndefined()
      expect(run({ ...identity, adapterSources: [] }).criterionBranch, String(code)).not.toBe("source-negative-review")
      expect(run({ ...identity, engineVersion: "wrong" }).criterionBranch, String(code)).not.toBe(
        "source-negative-review",
      )
    }
  },
)

// #32087: kitty's provenance.sourceCommit is kitty's own upstream commit, so a Termless pin move
// (termlessRevision) keeps the six kitty OSC reviews, while a different kitty binary does not.
test("kitty OSC source review survives a Termless revision move and lapses on a different binary", () => {
  const kitty = absentOscBatch.find((entry) => entry.engine === "kitty")!
  const identity = kitty.identity
  if (identity.kind !== "native") throw new Error("kitty fixture is not a native identity")
  const features: Record<number, string> = {
    176: "osc176-app-id",
    3008: "osc3008-context",
    440: "osc440-audio",
    555: "osc555-flash",
    666: "osc666-termprop",
    710: "osc710-font-normal",
  }
  const run = (runtimeIdentity: HeadlessRuntimeIdentity, code: number) =>
    callback(`extensions.${features[code]}`).lib!({
      runtimeIdentity,
      feed: () => undefined,
      getCell: () => ({ char: "X" }),
    } as unknown as LibProbeSource)
  const moved = { ...identity, termlessRevision: "d9d4505514a2f5a3fd0a0e1a3a0c2c5b7d8e9f01" }
  const otherBinary = "0".repeat(64)
  const rebuilt = {
    ...identity,
    loadedBinary: { ...identity.loadedBinary, sha256: otherBinary },
    provenance: { ...identity.provenance, sha256: otherBinary },
  }
  for (const code of kitty.codes) {
    expect(identity.provenance.sourceCommit).toBe("b2cb871254fbdac19a085188813c8dfb258b95cd")
    expect(run(moved, code).criterionBranch, String(code)).toBe("source-negative-review")
    expect(run(rebuilt, code).criterionBranch, String(code)).not.toBe("source-negative-review")
  }
})

test("TERM_FEATURES audit enumerates only files bound by the declared adapter sources", () => {
  for (const [engine, [, path]] of Object.entries(TERM_FEATURES_API_CITATIONS)) {
    const declared = ADAPTER_SOURCE_AUDITS[engine as keyof typeof ADAPTER_SOURCE_AUDITS]
    expect(Object.keys(declared), engine).toContain(path)
    expect((declared as Readonly<Record<string, string>>)[path], engine).toMatch(/^[a-f0-9]{40}$/)
  }
  for (const identity of auditedArtifacts) {
    const definition = deviceProbes.find((entry) => entry.id === "device.term-features")!
    for (const source of identity.adapterSources!) {
      const result = definition.lib!({
        runtimeIdentity: {
          ...identity,
          adapterSources: identity.adapterSources!.filter((entry) => entry.path !== source.path),
        },
      } as unknown as LibProbeSource)
      expect(result.criterionBranch, source.path).not.toBe("headless-observable-review")
    }
  }
})

test("OSC 8 missing-observer review excludes adapter locators and global revisions", () => {
  const identity = structuredClone(auditedArtifacts[1]!)
  identity.adapterSources = []
  const source = (runtimeIdentity: HeadlessRuntimeIdentity) =>
    ({
      runtimeIdentity,
      feed: () => undefined,
      getCell: (_row: number, col: number) => ({ char: "ALINKZ"[col] }),
      capabilities: { extensions: new Set() },
    }) as unknown as LibProbeSource
  const result = callback("extensions.osc8").lib!(source(identity))
  expect(result.criterionBranch).toBe("headless-observable-review")
  const relocated = structuredClone(identity)
  relocated.termlessRevision = "different-global-revision"
  if (relocated.kind === "js") relocated.resolvedPath = "/relocated/wrapper.ts"
  if (relocated.kind === "native" || relocated.runtimeFormat === "wasm") {
    relocated.loadedBinary.path = "/relocated/engine"
  }
  expect(callback("extensions.osc8").lib!(source(relocated))).toEqual(result)
})

test.each(auditedArtifacts)(
  "$kind source audits survive provenance moves but not engine/adapter changes",
  (identity) => {
    const definition = callback(identity.kind === "native" ? "extensions.osc440-audio" : "extensions.osc8")
    const source = (runtimeIdentity: HeadlessRuntimeIdentity): LibProbeSource =>
      ({
        runtimeIdentity,
        feed: () => undefined,
        getCell: (_row: number, col: number) => ({ char: identity.kind === "native" ? "X" : "ALINKZ"[col] }),
        capabilities: { extensions: new Set() },
      }) as unknown as LibProbeSource
    const result = definition.lib!(source(identity))
    expect(result.criterionBranch).toBe("source-negative-review")
    expect(result.response).not.toContain("runtimeIdentity")
    const moved = structuredClone(identity)
    moved.termlessRevision = "another-provenance-only-revision"
    if (moved.kind === "native" || moved.runtimeFormat === "wasm") moved.loadedBinary.path = "/another/location"
    if (moved.kind === "js") {
      moved.resolvedPath = "/another/wrapper.ts"
      if (moved.integrity.kind === "source") {
        moved.integrity.revision = "another-wrapper-revision"
        moved.integrity.treeOid = "another-wrapper-tree"
      }
    }
    expect(definition.lib!(source(moved))).toEqual(result)
    const changes: ((changed: HeadlessRuntimeIdentity) => void)[] = [
      (changed) => {
        changed.engineVersion = "foreign"
      },
      (changed) => {
        changed.adapterVersion = "foreign"
      },
      (changed) => {
        changed.adapterSources = undefined
      },
      (changed) => {
        changed.adapterSources = []
      },
      (changed) => {
        changed.adapterSources = changed.adapterSources!.slice(1)
      },
      (changed) => {
        changed.adapterSources = changed.adapterSources!.map((entry) => ({ ...entry, blobOid: "0".repeat(40) }))
      },
      (changed) => {
        if (changed.kind === "native" || changed.runtimeFormat === "wasm") changed.loadedBinary.sha256 = "0".repeat(64)
      },
    ]
    if (identity.kind === "native") {
      for (const field of ["sha256", "sourceCommit", "buildHash", "lockSha256"] as const) {
        changes.push((changed) => {
          if (changed.kind === "native") changed.provenance[field] = "foreign"
        })
      }
    }
    for (const change of changes) {
      const changed = structuredClone(identity)
      change(changed)
      expect(definition.lib!(source(changed)).criterionBranch).not.toBe("source-negative-review")
    }
    const termFeatures = deviceProbes.find((entry) => entry.id === "device.term-features")!
    const apiReview = termFeatures.lib!(source(identity))
    expect(apiReview.criterionBranch).toBe("headless-observable-review")
    expect(apiReview.response).not.toContain("runtimeIdentity")
    expect(termFeatures.lib!(source(moved))).toEqual(apiReview)
    expect(termFeatures.lib!(source({ ...identity, adapterSources: [] })).criterionBranch).not.toBe(
      "headless-observable-review",
    )
  },
)

// A consumed sentinel qualifies only the source-review evidence, never the audio, flash or font effect.
test.each([
  ["extensions.osc440-audio", "\x1b]440;bell.wav\x07", "vterm"],
  ["extensions.osc555-flash", "\x1b]555\x07", "vterm"],
  ["extensions.osc710-font-normal", "\x1b]710;monospace\x07", "vterm"],
  ["extensions.osc9-progress", "\x1b]9;4;1;50\x07", "vterm"],
  ["extensions.osc22-pointer", "\x1b]22;pointer\x07", "vterm"],
  ["extensions.osc176-app-id", "\x1b]176;terminfo-test\x07", "vterm"],
  ["extensions.osc666-termprop", "\x1b]666;test-prop=value\x07", "vterm"],
  ["extensions.osc777-notify", "\x1b]777;notify;test;body\x07", "vterm"],
  ["extensions.osc3008-context", "\x1b]3008;type=test\x07", "vterm"],
  ["extensions.osc9-progress", "\x1b]9;4;1;50\x07", "xtermjs"],
  ["extensions.osc22-pointer", "\x1b]22;pointer\x07", "xtermjs"],
  ["extensions.osc176-app-id", "\x1b]176;terminfo-test\x07", "xtermjs"],
  ["extensions.osc440-audio", "\x1b]440;bell.wav\x07", "xtermjs"],
  ["extensions.osc555-flash", "\x1b]555\x07", "xtermjs"],
  ["extensions.osc666-termprop", "\x1b]666;test-prop=value\x07", "xtermjs"],
  ["extensions.osc710-font-normal", "\x1b]710;monospace\x07", "xtermjs"],
  ["extensions.osc777-notify", "\x1b]777;notify;test;body\x07", "xtermjs"],
  ["extensions.osc3008-context", "\x1b]3008;type=test\x07", "xtermjs"],
  ["extensions.osc9-progress", "\x1b]9;4;1;50\x07", "vt100"],
  ["extensions.osc22-pointer", "\x1b]22;pointer\x07", "vt100"],
  ["extensions.osc176-app-id", "\x1b]176;terminfo-test\x07", "vt100"],
  ["extensions.osc440-audio", "\x1b]440;bell.wav\x07", "vt100"],
  ["extensions.osc555-flash", "\x1b]555\x07", "vt100"],
  ["extensions.osc666-termprop", "\x1b]666;test-prop=value\x07", "vt100"],
  ["extensions.osc710-font-normal", "\x1b]710;monospace\x07", "vt100"],
  ["extensions.osc777-notify", "\x1b]777;notify;test;body\x07", "vt100"],
  ["extensions.osc3008-context", "\x1b]3008;type=test\x07", "vt100"],
  ["extensions.osc9-progress", "\x1b]9;4;1;50\x07", "vt220"],
  ["extensions.osc22-pointer", "\x1b]22;pointer\x07", "vt220"],
  ["extensions.osc176-app-id", "\x1b]176;terminfo-test\x07", "vt220"],
  ["extensions.osc440-audio", "\x1b]440;bell.wav\x07", "vt220"],
  ["extensions.osc555-flash", "\x1b]555\x07", "vt220"],
  ["extensions.osc666-termprop", "\x1b]666;test-prop=value\x07", "vt220"],
  ["extensions.osc710-font-normal", "\x1b]710;monospace\x07", "vt220"],
  ["extensions.osc777-notify", "\x1b]777;notify;test;body\x07", "vt220"],
  ["extensions.osc3008-context", "\x1b]3008;type=test\x07", "vt220"],
])("%s retains an audited source-negative review only after its sentinel renders", (id, sequence, engine) => {
  // Collector-input fixtures rekeyed to 0.10.1 after the parser audit, not a loaded-engine attestation.
  const identity =
    engine === "xtermjs"
      ? xtermOscIdentity
      : ({
          kind: "js",
          runtimeFormat: "js",
          engineVersion: "0.10.1",
          adapterVersion: "0.10.2",
          termlessRevision: "2".repeat(40),
          adapterSources:
            engine === "vt100"
              ? [
                  { path: "packages/vt100/src/index.ts", blobOid: "99833d737402f9d1d8e3e257e3a255d8aa1facc3" },
                  { path: "packages/vt100/src/backend.ts", blobOid: "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a" },
                ]
              : engine === "vt220"
                ? [
                    { path: "packages/vt220/src/index.ts", blobOid: "601dd26eb7e753a5396ebdf72f1ef8ee2cc4355f" },
                    { path: "packages/vt220/src/backend.ts", blobOid: "7369e3710e36aa649372fd09011ecfdd6ba47c73" },
                  ]
                : [
                    { path: "packages/vterm/src/index.ts", blobOid: "cb5719799dcdd5ae24e6fcf0dcad9965035ce54c" },
                    { path: "packages/vterm/src/backend.ts", blobOid: "308a934578c044ae95feaa29299531d9aa9eb4f7" },
                  ],
          resolvedPath: `vendor/vterm/packages/${engine}/src/index.ts`,
          integrity: {
            kind: "source",
            repository: "git@github.com:beorn/vterm.git",
            revision: "bd3d32aea2f1994376a71adfc55b92705eedbd8c",
            treeOid:
              engine === "vt100"
                ? "1eaac257cf9ff8d8ece752c8e6edc04b9ddaa6cf"
                : engine === "vt220"
                  ? "d504616ae458b8b0fa9fa365034c30bd35f55ee8"
                  : "f10a184811894462b9ca7b65d6aab8ffd2fdd0bd",
            cleanTree: true,
          },
        } as const)
  const modes = [
    "pinned",
    "no-sentinel",
    "foreign",
    ...(engine === "vt220" ? ["wrong-package"] : []),
    ...(engine === "xtermjs"
      ? ["changed-lock", "wrong-version", "wrong-adapter"]
      : ["changed-source", "changed-tree", "wrong-version", "dirty"]),
  ]
  for (const mode of modes) {
    const writes: string[] = []
    const source = {
      runtimeIdentity: {
        ...identity,
        engineVersion: mode === "wrong-version" ? "6.0.1" : identity.engineVersion,
        adapterVersion: mode === "wrong-adapter" ? "foreign" : identity.adapterVersion,
        resolvedPath: mode === "foreign" ? "another-engine.ts" : identity.resolvedPath,
        integrity:
          identity.integrity.kind === "source"
            ? {
                ...identity.integrity,
                revision: mode === "changed-source" ? "3".repeat(40) : identity.integrity.revision,
                treeOid:
                  mode === "changed-tree"
                    ? "4".repeat(40)
                    : mode === "wrong-package"
                      ? "1eaac257cf9ff8d8ece752c8e6edc04b9ddaa6cf"
                      : identity.integrity.treeOid,
                cleanTree: mode !== "dirty",
              }
            : {
                ...identity.integrity,
                lockIntegrity: mode === "changed-lock" ? "foreign" : identity.integrity.lockIntegrity,
              },
      },
      feed: (bytes: string) => writes.push(bytes),
      getCell: () => ({ char: mode === "no-sentinel" ? " " : "X" }),
    } as unknown as LibProbeSource
    const result = callback(id).lib!(source)
    expect(result.observation?.outcome).not.toBe("supported")
    if (mode === "pinned" || mode === "foreign" || mode === "changed-source") {
      expect(writes.join("")).toContain(sequence + "X")
      expect(result.criterionBranch).toBe("source-negative-review")
      expect(result.tests).toMatchObject([
        {
          id: "review",
          status: "test-failure",
          reason: expect.stringContaining(engine === "xtermjs" ? "17a90b65" : "bd3d32ae"),
        },
      ])
      expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
      expect(JSON.parse(result.response!)).toMatchObject({
        fed: writes.join(""),
        sentinel: { char: "X" },
        engineState: null,
      })
      expect(result.assertions).toMatchObject([
        { kind: "negative", assertionType: "buffer_state", observed: result.response },
      ])
      if (engine === "xtermjs") {
        expect(JSON.parse(result.response!)).not.toHaveProperty("runtimeIdentity")
        expect(result.tests).toMatchObject([{ reason: expect.stringContaining("packages/xtermjs/src/backend.ts") }])
      }
      if (engine === "vterm" && id === "extensions.osc9-progress") {
        expect(result.tests).toMatchObject([
          { reason: expect.stringMatching(/notification sink.*no progress subcode or state interpretation/) },
        ])
        expect(result.tests?.[0]?.reason).not.toContain("no case 9")
      }
      if (engine === "vt100") {
        expect(result.tests?.[0]?.reason).toContain("screen.ts:504-520 handleOSC switch, cases 0/1/2 only")
        expect(result.tests?.[0]?.reason).not.toContain("notification sink")
        expect(result.tests?.[0]?.reason).not.toContain("3921-3923")
        if (id === "extensions.osc9-progress") expect(result.tests?.[0]?.reason).toContain("no case 9")
      }
      if (engine === "vt220") {
        expect(result.tests?.[0]?.reason).toContain(
          "screen.ts:703-718 handleOSC: no-semicolon return; cases 0/1/2 only",
        )
        expect(result.tests?.[0]?.reason).not.toContain("notification sink")
        expect(result.tests?.[0]?.reason).not.toContain("3921-3923")
        if (id === "extensions.osc9-progress") expect(result.tests?.[0]?.reason).toContain("no case 9")
      }
    } else {
      expect(result.criterionBranch, `${engine}: ${mode}`).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toBeUndefined()
      if (mode !== "no-sentinel") expect(writes).toEqual([])
    }
  }
})

// The initial/default query is silent; indexed painted cells are an independent palette witness.
function indexedPalette(
  options: {
    ignoresReset?: boolean
    ignoresSeed?: boolean
    resolvedAtPaint?: boolean
    collision?: boolean
    after?: "third" | "missing" | "contradiction"
    invalidDefault?: boolean
    invalidSeed?: boolean
    badGlyph?: "D" | "S" | "F"
    missingDefault?: boolean
    invalidFresh?: boolean
    fail?: "setter" | "getter" | "cleanup" | "getter+cleanup"
    sentinel?: boolean
    queryAfterSeed?: boolean
  } = {},
) {
  const original = options.collision ? { r: 170, g: 187, b: 204 } : { r: 29, g: 31, b: 33 }
  const seed = { r: 170, g: 187, b: 204 }
  let current = original
  let reset = false
  const cells = new Map<number, { char: string; fg: typeof original }>()
  const writes: string[] = []
  const feed = (bytes: string) => {
    writes.push(bytes)
    const painted = /\x1b\[1;(\d+)H\x1b\[38;5;0m([DSF])/.exec(bytes)
    if (painted) cells.set(Number(painted[1]) - 1, { char: painted[2]!, fg: current })
    if (bytes === "\x1b]4;0;rgb:aa/bb/cc\x07") {
      if (options.fail === "setter") throw new Error("palette setter failed")
      if (!options.ignoresSeed) current = seed
    }
    if (bytes === "\x1b]104;0\x07") {
      if (options.fail === "cleanup" || options.fail === "getter+cleanup") throw new Error("palette cleanup failed")
      reset = true
      if (!options.ignoresReset) current = original
      if (options.after === "third") current = { r: 7, g: 8, b: 9 }
      if (options.after === "contradiction") current = seed
    }
  }
  const source = {
    feed,
    feedCapture: (bytes: string) => {
      feed(bytes)
      return bytes === "\x1b]4;0;?\x07" && ((!reset && current === seed) || (reset && options.queryAfterSeed))
        ? "\x1b]4;0;rgb:aaaa/bbbb/cccc\x07"
        : ""
    },
    getCell: (_row: number, col: number) => {
      const cell = cells.get(col)
      if (cell?.char === "S" && !reset && (options.fail === "getter" || options.fail === "getter+cleanup")) {
        throw new Error("palette getter failed")
      }
      if (
        !cell ||
        (cell.char === "F" && options.after === "missing") ||
        (cell.char === "D" && options.missingDefault)
      ) {
        return { char: "", fg: null, bg: null }
      }
      const invalid =
        (cell.char === "D" && options.invalidDefault) ||
        (cell.char === "S" && !reset && options.invalidSeed) ||
        (cell.char === "F" && options.invalidFresh)
      const fg =
        options.after === "contradiction" && reset && cell.char === "S"
          ? original
          : options.resolvedAtPaint
            ? cell.fg
            : current
      return {
        ...cell,
        char: options.badGlyph === cell.char ? "?" : cell.char,
        fg: invalid ? { r: NaN, g: 0, b: 0 } : fg,
        bg: null,
      }
    },
  } as unknown as LibProbeSource
  if (options.sentinel) {
    source.queryWithSentinelOutcome = () => ({
      match: null,
      reason: "sentinel",
      raw: "\x1b[?1;2c",
      rawBase64: Buffer.from("\x1b[?1;2c").toString("base64"),
      sentinel: { atMs: 1, graceMs: 250 },
    })
  }
  return { source, writes }
}

test.each([
  [{}, "supported"],
  [{ resolvedAtPaint: true }, "supported"],
  [{ ignoresReset: true }, "unsupported"],
  [{ sentinel: true }, "supported"],
] as const)("OSC104 uses a freshly painted indexed cell to decide reset: %j", (options, outcome) => {
  const result = callback("extensions.osc104-reset-palette").lib!(indexedPalette(options).source)
  expect(result.observation).toMatchObject({ outcome, assertionType: "buffer_state" })
  expect(result.assertions).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
  const state = JSON.parse(result.response!)
  expect(state).toMatchObject({ cells: { before: { char: "D" }, seeded: { char: "S" }, fresh: { char: "F" } } })
  if ("sentinel" in options) {
    expect(state).toMatchObject({ initialSentinel: { raw: "\x1b[?1;2c", sentinel: { atMs: 1, graceMs: 250 } } })
  }
  if ("resolvedAtPaint" in options) expect(result.observation?.note).toContain("resolved at paint")
})

// #31955 (@cto 758ee3b5): the initial-query sentinel decides a host-slot reset only when the seeded control
// did not establish a live path, and every host slot keeps the control bytes beside its sentinel negative.
function silentHostSlot(code: 10 | 11 | 12, seeded: string, restored: string) {
  const replies = [seeded, restored]
  return {
    feed() {},
    feedCapture: (write: string) => (write === `\x1b]${code};?\x07` ? (replies.shift() ?? "") : ""),
    queryWithSentinelOutcome: () => ({
      match: null,
      reason: "sentinel",
      raw: "\x1b[?1;2c",
      rawBase64: Buffer.from("\x1b[?1;2c").toString("base64"),
      sentinel: { atMs: 1, graceMs: 250 },
    }),
  } as unknown as LibProbeSource
}

test.each([10, 11, 12] as const)("OSC %i reset reviews a verified control instead of the initial sentinel", (code) => {
  const source = silentHostSlot(code, `\x1b]${code};rgb:aaaa/bbbb/cccc\x07`, `\x1b]${code};rgb:1111/2222/3333\x07`)
  const result = callback(`extensions.osc${code + 100}-reset-${{ 10: "fg", 11: "bg", 12: "cursor" }[code]}`).lib!(
    source,
  )
  expect(result.observation?.note).not.toBe("negative by sentinel")
  expect(result.tests).toMatchObject([{ id: "review", status: "test-todo" }])
  expect(JSON.stringify(result)).toContain("reset produced neither the baseline nor the verified seed")
})

test.each([10, 11, 12] as const)("OSC %i reset sentinel negative carries the control bytes", (code) => {
  const source = silentHostSlot(code, "", "")
  const result = callback(`extensions.osc${code + 100}-reset-${{ 10: "fg", 11: "bg", 12: "cursor" }[code]}`).lib!(
    source,
  )
  expect(result.observation).toMatchObject({ outcome: "unsupported", note: "negative by sentinel" })
  expect(JSON.parse(result.assertions![0]!.note!)).toMatchObject({
    query: `\x1b]${code};?\x07`,
    originalRaw: "",
    controls: [
      { write: `\x1b]${code};rgb:aa/bb/cc\x07`, response: "" },
      { write: `\x1b]${code};?\x07`, response: "" },
      { write: `\x1b]${code + 100}\x07`, response: "" },
      { write: `\x1b]${code};?\x07`, response: "" },
    ],
  })
})

test("OSC104 keeps sentinel reply bytes and retains unqualified cell readings beside them", () => {
  const result = callback("extensions.osc104-reset-palette").lib!(
    indexedPalette({ sentinel: true, ignoresSeed: true }).source,
  )
  expect(result.response).toBe("\x1b[?1;2c")
  expect(result.observation).toMatchObject({ outcome: "unsupported", note: "negative by sentinel" })
  const state = JSON.parse(result.assertions![0]!.note!)
  expect(state).toMatchObject({
    cells: {
      before: { char: "D", fg: { r: 29, g: 31, b: 33 } },
      seeded: { char: "S", fg: { r: 29, g: 31, b: 33 } },
    },
    initialSentinel: { sentinel: { graceMs: 250 } },
  })
})

test.each([
  { collision: true },
  { ignoresSeed: true },
  { invalidDefault: true },
  { invalidSeed: true },
  { badGlyph: "D" },
  { badGlyph: "S" },
  { badGlyph: "F" },
  { missingDefault: true },
  { invalidFresh: true },
  { after: "third" },
  { after: "missing" },
  { after: "contradiction" },
  { queryAfterSeed: true },
] as const)("OSC104 cannot grade an unqualified or contradictory indexed reading: %j", (options) => {
  const result = callback("extensions.osc104-reset-palette").lib!(indexedPalette(options).source)
  expect(result.observation?.outcome).not.toBe("supported")
  expect(result.observation?.outcome).not.toBe("unsupported")
  expect(result.assertions).toBeUndefined()
  expect(result.response).toContain('"cells"')
  expect(result.criterionBranch).toBe("color-readback-review")
  expect(result.tests).toMatchObject([{ id: "review", status: "test-todo" }])
})

test.each(["setter", "getter", "cleanup", "getter+cleanup"] as const)(
  "OSC104 preserves operational %s errors and reset cleanup",
  (fail) => {
    const fixture = indexedPalette({ fail })
    expect(() => callback("extensions.osc104-reset-palette").lib!(fixture.source)).toThrow(
      fail === "getter+cleanup" ? AggregateError : /palette .* failed/,
    )
    expect(fixture.writes).toContain("\x1b]104;0\x07")
    if (fail === "getter+cleanup") {
      try {
        callback("extensions.osc104-reset-palette").lib!(indexedPalette({ fail }).source)
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError)
        expect((error as AggregateError).errors.map((cause: Error) => cause.message)).toEqual([
          "palette getter failed",
          "palette cleanup failed",
        ])
      }
    }
  },
)

test("OSC 10 needs a complete matching foreground-color reply in both collectors", async () => {
  const definition = callback("extensions.osc10-fg-color")
  const frame = "\x1b]10;rgb:ffff/0000/0000\x07"
  const headless = (raw: string) => definition.lib!({ feedCapture: () => raw } as unknown as LibProbeSource)
  const app = (raw: string) =>
    definition.term!({
      queryWithSentinelOutcome: async (_query: string, pattern: RegExp) => ({
        match: pattern.exec(raw),
        reason: pattern.test(raw) ? "reply" : "sentinel",
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
      }),
    } as unknown as TermProbeSource)
  for (const result of [headless(frame), await app(frame)]) {
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.response).toBe(frame)
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: frame }])
  }
  for (const result of [headless("\x1b]10;"), await app("\x1b]10;")]) {
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.assertions).toBeUndefined()
  }
})

test("a truecolor declaration without two calibrated RGB cell samples is inconclusive", () => {
  const definition = callback("extensions.truecolor")
  const result = definition.lib!({
    capabilities: { truecolor: true },
    feed: () => undefined,
    getCell: () => ({ char: "X", fg: null, bg: null }),
  } as unknown as LibProbeSource)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
  expect(result.assertions).toBeUndefined()
})

// #30701 (@cto ruling C): a framed fixture whose RGB targets read no color is a measured ignore while
// the SGR 31/34 controls are distinct, and has no observable when the controls show no color either.
test("extensions.truecolor grades unexposed RGB targets against the independent controls", () => {
  const definition = callback("extensions.truecolor")
  const run = (controls: readonly ({ r: number; g: number; b: number } | null)[]) =>
    definition.lib!({
      feed: () => undefined,
      getCell: (_row: number, col: number) => ({
        char: ["C", "A", "B", "X", "Y"][col] ?? "",
        fg: [null, ...controls, null, null][col] ?? null,
        bg: null,
      }),
    } as unknown as LibProbeSource)
  const ignored = run([
    { r: 128, g: 0, b: 0 },
    { r: 0, g: 0, b: 128 },
  ])
  expect(ignored.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  const monochrome = run([null, null])
  expect(monochrome.notTested).toBeUndefined()
  expect(monochrome.criterionBranch).toBe("source-negative-review")
  expect(monochrome.tests).toEqual([
    {
      id: "review",
      status: "test-failure",
      reason: expect.stringContaining("color controls"),
    },
  ])
  expect(monochrome.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(monochrome.assertions).toMatchObject([{ kind: "negative", assertionType: "buffer_state" }])
})

test("extensions.truecolor decides from the DECRQSS SGR report, the same oracle as sgr.fg.truecolor", async () => {
  const definition = callback("extensions.truecolor")
  const sgrQuery = "\x1bP$qm\x1b\\"
  const answering = (raw: string) =>
    replayTermProbeSource(new Map([[sgrQuery, { sequence: sgrQuery, match: null, reason: "reply", raw }]]))
  const supported = await definition.term!(answering("\x1bP1$r0;38;2;255;128;0m\x1b\\"))
  expect(supported.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  // The cell-storage claim is exactly what sgr.fg.truecolor decides, so a report without the
  // requested direct colour is a measured negative, not a cursor-consumption verdict.
  const unsupported = await definition.term!(answering("\x1bP1$r0m\x1b\\"))
  expect(unsupported.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  // This callback's legacy consumed response maps to TODO when its owned CPR is unavailable.
  const silent = await definition.term!(replayTermProbeSource(new Map()))
  expect(silent.observation).toBeUndefined()
  expect(silent.tests).toMatchObject([expect.objectContaining({ status: "test-todo", reason: expect.any(String) })])
})

test("a later DA1 reply does not establish an OSC 104 palette reset", () => {
  const definition = callback("extensions.osc104-reset-palette")
  const result = definition.lib!({
    feed: () => undefined,
    feedCapture: () => "\x1b[?1;2c",
  } as unknown as LibProbeSource)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.assertions).toBeUndefined()
})

const directReplies = [
  ["extensions.osc10-fg-color", "\x1b]10;rgb:ffff/0000/0000\x07"],
  ["extensions.osc11-bg-color", "\x1b]11;rgb:0000/ffff/0000\x07"],
  ["extensions.osc12-cursor-color", "\x1b]12;rgb:0000/0000/ffff\x07"],
  ["extensions.osc17-highlight-bg", "\x1b]17;rgb:ffff/ffff/0000\x07"],
  ["extensions.osc19-highlight-fg", "\x1b]19;rgb:ffff/0000/ffff\x07"],
  ["extensions.osc4-palette", "\x1b]4;0;rgb:ffff/0000/0000\x07"],
  ["extensions.osc5-special-color", "\x1b]5;0;rgb:ffff/0000/0000\x07"],
  ["extensions.osc1337-cellsize", "\x1b]1337;ReportCellSize=12;8\x07"],
  // 27915: iTerm2's newer height;width;scale form, as WezTerm 0-unstable-2026-09-17 sends it.
  ["extensions.osc1337-cellsize", "\x1b]1337;ReportCellSize=16.5;7.5;1.3\x1b\\"],
  // Vendor request contracts: iTerm2 feature reporting uses Capabilities (not RequestCapabilities),
  // and urxvt requests its version only when OSC 702's Pt is ?. These are independent wire expectations.
  ["extensions.osc1337-capabilities", "\x1b]1337;Capabilities=alpha\x07", "\x1b]1337;Capabilities\x07"],
  ["extensions.osc7770-font-size", "\x1b]7770;14\x07"],
  ["extensions.osc7777-font-window-size", "\x1b]7777;14\x07"],
  ["extensions.osc701-locale", "\x1b]701;en_US.UTF-8\x07"],
  ["extensions.osc702-version", "\x1b]702;rxvt-unicode;rxvt;9;31\x07", "\x1b]702;?\x07"],
  ["extensions.osc776-cell-size", "\x1b]776;8;16;2\x07"],
  ["extensions.sixel-da1", "\x1b[?1;4c"],
] as const

test.each(directReplies)("%s requires a complete, bound reply", async (id, frame, expectedQuery?: string) => {
  const definition = callback(id)
  const run = async (raw: string) => {
    const libraryWrites: string[] = []
    const terminalWrites: string[] = []
    const headless = definition.lib!({
      feedCapture: (sequence: string) => {
        libraryWrites.push(sequence)
        return raw
      },
    } as unknown as LibProbeSource)
    const query = async (sequence: string, pattern: RegExp) => {
      terminalWrites.push(sequence)
      return {
        match: pattern.exec(raw),
        reason: pattern.test(raw) ? ("reply" as const) : ("sentinel" as const),
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
      }
    }
    const app = await definition.term!({
      queryWithSentinelOutcome: query,
      queryOutcome: query,
    } as unknown as TermProbeSource)
    if (expectedQuery) {
      expect({ library: libraryWrites, terminal: terminalWrites }, `${id}: emitted requests`).toEqual({
        library: [expectedQuery],
        terminal: [expectedQuery],
      })
    }
    return [headless, app]
  }
  for (const result of await run(frame)) {
    expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.response, id).toBe(frame)
    expect(result.assertions, id).toMatchObject([{ kind: "positive", observed: frame }])
  }
  for (const result of await run(frame.slice(0, -1))) {
    expect(result.observation?.outcome, id).toBe("inconclusive")
    expect(result.assertions, id).toBeUndefined()
  }
  if (id === "extensions.osc776-cell-size") {
    for (const raw of ["\x1b]776;0;0;0\x1b\\", "\x1b]776;0;16;2\x07", "\x1b]776;8;0;2\x07"] as const) {
      for (const result of await run(raw)) {
        expect(result.pass, `${id}: ${raw}`).toBe(false)
        expect(result.response, `${id}: ${raw}`).toBe(raw)
        expect(result.observation, `${id}: ${raw}`).toMatchObject({
          outcome: "inconclusive",
          reason: "invalid-reply",
          assertionType: "query_reply",
        })
        expect(result.assertions, `${id}: ${raw}`).toBeUndefined()
      }
    }
    for (const result of await run("\x1b]776;8;16;0\x07")) {
      expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.response, id).toBe("\x1b]776;8;16;0\x07")
    }
  }
  if (id === "extensions.sixel-da1") {
    // Kitty 0.49.1 replies with a trailing empty DA1 parameter.
    for (const [raw, outcome] of [
      ["\x1b[?62;52;c", "unsupported"],
      ["\x1b[?62;4;52;c", "supported"],
    ] as const) {
      for (const result of await run(raw)) {
        expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
        expect(result.response).toBe(raw)
        expect(result.assertions).toMatchObject([
          { kind: outcome === "supported" ? "positive" : "negative", observed: raw },
        ])
      }
      for (const result of await run(raw.slice(0, -1))) {
        expect(result.observation?.outcome).toBe("inconclusive")
        expect(result.assertions).toBeUndefined()
      }
    }
  }
  if (frame.includes("rgb:")) {
    for (const payload of ["?", "red", "rgb:zz/00/00", "rgb:fffff/00/00"]) {
      for (const result of await run(frame.replace(/rgb:[^\x07]+/, payload))) {
        expect(result.observation?.outcome, `${id}: ${payload}`).toBe("inconclusive")
        expect(result.assertions, id).toBeUndefined()
      }
    }
  }
})

test("OSC 702 accepts complete 4-field vendor version frames and keeps query echoes, malformed, partial, and unmatched replies inconclusive", async () => {
  const definition = callback("extensions.osc702-version")
  const runBoth = async (raw: string) => {
    const query = (_sequence: string, pattern: RegExp) => ({
      match: pattern.exec(raw),
      reason: pattern.test(raw) ? ("reply" as const) : ("sentinel" as const),
      raw,
      rawBase64: Buffer.from(raw).toString("base64"),
    })
    const headlessCapture = definition.lib!({ feedCapture: () => raw } as unknown as LibProbeSource)
    const headlessSentinel = definition.lib!({ queryWithSentinelOutcome: query } as unknown as LibProbeSource)
    const terminal = await definition.term!({
      queryWithSentinelOutcome: async (seq: string, pat: RegExp) => query(seq, pat),
      queryOutcome: async (seq: string, pat: RegExp) => query(seq, pat),
    } as unknown as TermProbeSource)
    return [headlessCapture, headlessSentinel, terminal]
  }

  for (const raw of [
    "\x1b]702;rxvt-unicode;rxvt;9;31\x07",
    "\x1b]702;rxvt-unicode;urxvt;7;4\x1b\\",
    "\x1b]702;vterm.js;vterm;0;2\x1b\\",
  ] as const) {
    for (const result of await runBoth(raw)) {
      expect(result.pass, raw).toBe(true)
      expect(result.response, raw).toBe(raw)
      expect(result.observation, raw).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions, raw).toMatchObject([{ kind: "positive", observed: raw }])
    }
  }

  for (const raw of [
    "\x1b]702;?\x07",
    "\x1b]702;?\x1b\\",
    "\x1b]702;rxvt-1\x07",
    "\x1b]702;rxvt-unicode;rxvt\x07",
    "\x1b]702;rxvt-unicode;rxvt;9\x07",
    "\x1b]702;rxvt-unicode;rxvt;9;\x07",
    "\x1b]702;rxvt-unicode;rxvt;nine;31\x07",
    "\x1b]702;rxvt-unicode;rxvt;9;x\x07",
    "\x1b]702;;rxvt;9;31\x07",
    "\x1b]702;rxvt-unicode;;9;31\x07",
    "\x1b]702;rxvt-unicode;rxvt;9;31;extra\x07",
    "\x1b]702;rxvt-unicode;rxvt;9;31",
  ] as const) {
    for (const result of await runBoth(raw)) {
      expect(result.pass, raw).toBe(false)
      expect(result.response, raw).toBe(raw)
      expect(result.observation, raw).toMatchObject({
        outcome: "inconclusive",
        reason: "invalid-reply",
        assertionType: "query_reply",
      })
      expect(result.assertions, raw).toBeUndefined()
    }
  }

  for (const raw of ["\x1b]701;en_US.UTF-8\x07", "\x1b[?1;2c"] as const) {
    for (const result of await runBoth(raw)) {
      expect(result.pass, raw).toBe(false)
      expect(result.response, raw).toBe(raw)
      expect(result.observation, raw).toMatchObject({
        outcome: "inconclusive",
        reason: "invalid-reply",
        assertionType: "query_reply",
      })
      expect(result.assertions, raw).toBeUndefined()
    }
  }
})

test.each([
  ["extensions.osc104-reset-palette", "4;0"],
  ["extensions.osc110-reset-fg", "10"],
  ["extensions.osc111-reset-bg", "11"],
  ["extensions.osc112-reset-cursor", "12"],
  ["extensions.osc113-reset-pointer-fg", "13"],
  ["extensions.osc114-reset-pointer-bg", "14"],
] as const)("%s requires a changed color before a restored color can qualify", (id, code) => {
  const definition = callback(id)
  const color = (value: string) => `\x1b]${code};rgb:${value}\x07`
  const run = (replies: string[]) => {
    const feed: string[] = []
    const result = definition.lib!({
      feed: (sequence: string) => {
        feed.push(sequence)
      },
      feedCapture: () => replies.shift() ?? "",
    } as unknown as LibProbeSource)
    return { result, feed }
  }
  const original = color("00/00/00")
  const changed = color("aa/bb/cc")
  const restored = run([original, changed, original])
  expect(restored.result.observation, id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(restored.result.assertions, id).toMatchObject([{ kind: "positive" }])
  expect(restored.feed.length, id).toBe(2)
  const notRestored = run([original, changed, color("12/34/56")])
  expect(notRestored.result.observation, id).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  expect(notRestored.result.assertions, id).toMatchObject([{ kind: "negative" }])
  // 27932 / Terminal.app 1225b26b: query replies, SET is ignored, original rgb comes back.
  const setIgnored = run([original, original, original])
  expect(setIgnored.result.observation, id).toMatchObject({
    outcome: "unsupported",
    assertionType: "query_reply",
    note: "OSC set did not change the queried color",
  })
  expect(setIgnored.result.assertions, id).toMatchObject([{ kind: "negative" }])
  const noControl = run([original, "", original])
  expect(noControl.result.observation?.outcome, id).toBe("inconclusive")
  expect(noControl.result.assertions, id).toBeUndefined()
})

test.each(["extensions.osc710-font-normal", "extensions.osc2-title", "extensions.osc9-progress"] as const)(
  "app %s leaves state untouched when no effect readback exists",
  async (id) => {
    const definition = extensionsProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`missing app extension callback ${id}`)
    const writes: string[] = []
    const result = await definition.term({
      write: (bytes: string) => {
        writes.push(bytes)
      },
      queryCursorPosition: async () => {
        throw new Error("unmeasured CPR must not run")
      },
    } as unknown as TermProbeSource)
    expect(writes, id).toEqual([])
    expect(result.observation, id).toBeUndefined()
    expect(result.tests, id).toMatchObject([
      expect.objectContaining({ status: "test-todo", reason: expect.any(String) }),
    ])
    expect(result.assertions, id).toBeUndefined()
  },
)

// 27832: the reset features mutate and read back. The collector runs this exchange only with a
// verified disposable-ownership receipt; the callback itself grades the measured four legs.
const appResetProbes = [
  ["extensions.osc104-reset-palette", 4, 104, 0],
  ["extensions.osc110-reset-fg", 10, 110, undefined],
  ["extensions.osc111-reset-bg", 11, 111, undefined],
  ["extensions.osc112-reset-cursor", 12, 112, undefined],
  ["extensions.osc113-reset-pointer-fg", 13, 113, undefined],
  ["extensions.osc114-reset-pointer-bg", 14, 114, undefined],
] as const

// Direct state decides only after a distinct seed; query-only tests cannot detect a constant getter,
// cross-slot mutation, or missing retention of nullable engine defaults.
test.each([
  ["extensions.osc110-reset-fg", 10, 110, "fg"],
  ["extensions.osc111-reset-bg", 11, 111, "bg"],
  ["extensions.osc112-reset-cursor", 12, 112, "cursor"],
] as const)("%s qualifies only controlled direct default-color restoration", (id, setCode, resetCode, slot) => {
  type Colors = {
    fg: { r: number; g: number; b: number } | null
    bg: { r: number; g: number; b: number } | null
    cursor: { r: number; g: number; b: number } | null
  }
  const baseline: Colors = { fg: null, bg: { r: 1, g: 2, b: 3 }, cursor: { r: 4, g: 5, b: 6 } }
  const seed = { r: 170, g: 187, b: 204 }
  const seeded = { ...baseline, [slot]: seed }
  const writesExpected = [`\x1b]${setCode};rgb:aa/bb/cc\x07`, `\x1b]${resetCode}\x07`]
  const run = (readings: Array<Colors | Error>) => {
    const writes: string[] = []
    const result = callback(id).lib!({
      getDefaultColors() {
        const value = readings.shift()
        if (value instanceof Error) throw value
        if (!value) throw new Error("unexpected extra default-color read")
        return value
      },
      feed: (bytes: string) => {
        writes.push(bytes)
      },
      feedCapture: () => {
        throw new Error("direct default-color arm must not query")
      },
    } as unknown as LibProbeSource)
    return { result, writes }
  }
  const positive = run([baseline, seeded, baseline])
  expect(positive.result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(positive.writes).toEqual(writesExpected)
  const state = JSON.parse(positive.result.response!)
  expect(state).toMatchObject({ baseline, seeded, restored: baseline, writes: writesExpected, seed })
  expect(positive.result.assertions).toMatchObject([
    { kind: "positive", assertionType: "buffer_state", observed: positive.result.response },
  ])
  const unset = { fg: null, bg: null, cursor: null }
  const restoredUnset = run([unset, { ...unset, [slot]: seed }, unset])
  expect(restoredUnset.result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(JSON.parse(restoredUnset.result.response!)).toMatchObject({
    baseline: unset,
    restored: unset,
    writes: writesExpected,
  })
  const negative = run([baseline, seeded, seeded])
  expect(negative.result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(negative.result.assertions).toMatchObject([{ kind: "negative", observed: negative.result.response }])
  const other = slot === "fg" ? "bg" : "fg"
  for (const readings of [
    [baseline, baseline, baseline],
    [baseline, { ...seeded, [other]: seed }, baseline],
    [baseline, seeded, { ...baseline, [other]: seed }],
    [baseline, seeded, { ...baseline, [slot]: { r: 7, g: 8, b: 9 } }],
    [baseline, new Error("seed read failed"), baseline],
    [baseline, seeded, new Error("reset read failed")],
    [new Error("baseline read failed")],
    [
      { fg: null, bg: null, cursor: null },
      { fg: null, bg: null, cursor: null },
      { fg: null, bg: null, cursor: null },
    ],
  ]) {
    const expectedErrors = readings
      .filter((reading): reading is Error => reading instanceof Error)
      .map((error) => error.message)
    const expectedWrites = readings[0] instanceof Error ? [] : writesExpected
    const reviewed = run(readings)
    expect(reviewed.result.criterionBranch).toBe("color-readback-review")
    expect(reviewed.result.observation).toBeUndefined()
    expect(reviewed.result.assertions).toBeUndefined()
    expect(JSON.parse(reviewed.result.response!)).toMatchObject({ writes: expectedWrites, errors: expectedErrors })
  }
  const collision = { ...baseline, [slot]: seed }
  const distinct = { r: 18, g: 52, b: 86 }
  const collisionResult = run([collision, { ...collision, [slot]: distinct }, collision])
  expect(collisionResult.result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(collisionResult.writes).toEqual([`\x1b]${setCode};rgb:12/34/56\x07`, writesExpected[1]])
})

test.each([
  ["extensions.osc113-reset-pointer-fg", 13, 113],
  ["extensions.osc114-reset-pointer-bg", 14, 114],
] as const)(
  "%s routes empty initial pointer-color readback with getDefaultColors to source-negative-review without inventing slots or writes",
  (id, setCode, resetCode) => {
    const query = `\x1b]${setCode};?\x07`
    const defaultColors = { fg: null, bg: { r: 1, g: 2, b: 3 }, cursor: { r: 4, g: 5, b: 6 } }
    const writes: string[] = []
    const queries: string[] = []
    const result = callback(id).lib!({
      getDefaultColors: () => defaultColors,
      feed: (bytes: string) => {
        writes.push(bytes)
      },
      feedCapture: (bytes: string) => {
        queries.push(bytes)
        return ""
      },
    } as unknown as LibProbeSource)
    expect(queries).toEqual([query])
    expect(writes).toEqual([])
    expect(result.criterionBranch).toBe("source-negative-review")
    expect(result.notTested).toBeUndefined()
    expect(result.tests).toEqual([
      {
        id: "review",
        status: "test-failure",
        reason: `OSC ${setCode} initial colour readback is missing and OSC ${resetCode} reset was not observed; default-color readback reports only fg, bg, and cursor, so pointer-colour support requires source review`,
      },
    ])
    expect(result.observation).toEqual({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "buffer_state",
    })
    const expected = `OSC ${resetCode} restores the prior OSC ${setCode} color after a verified change`
    expect(result.assertions).toEqual([
      {
        assertionType: "buffer_state",
        kind: "negative",
        expected,
        observed: result.response,
      },
    ])
    expect(JSON.parse(result.response!)).toEqual({
      query,
      originalRaw: "",
      defaultColors,
    })

    expect(() =>
      callback(id).lib!({
        getDefaultColors: () => {
          throw new Error("default-color getter boom")
        },
        feed: () => {},
        feedCapture: () => "",
      } as unknown as LibProbeSource),
    ).toThrow("default-color getter boom")

    const withoutGetter = callback(id).lib!({
      feed: () => {},
      feedCapture: () => "",
    } as unknown as LibProbeSource)
    expect(withoutGetter.criterionBranch).toBe("color-readback-review")
  },
)

test.each(appResetProbes)(
  "app %s reads the colour, sets it, reads the change, resets, and reads the restoration",
  async (id, setCode, resetCode, index) => {
    const definition = callback(id)
    // The collector's gate is the disposable receipt; the declaration is what makes it apply.
    expect(definition.termNeedsDisposable, id).toBe(true)
    const indexPart = index === undefined ? "" : `${index};`
    const rgb = (hex: string) => `\x1b]${setCode};${indexPart}rgb:${hex}\x07`
    const run = async (replies: string[]) => {
      const writes: string[] = []
      const queue = [...replies]
      const exchange = async (_sequence: string, pattern: RegExp) => {
        const raw = queue.shift() ?? ""
        return {
          match: pattern.exec(raw),
          reason: pattern.test(raw) ? ("reply" as const) : ("sentinel" as const),
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
        }
      }
      const result = await definition.term!({
        write: (bytes: string) => {
          writes.push(bytes)
        },
        queryWithSentinelOutcome: exchange,
      } as unknown as TermProbeSource)
      return { result, writes }
    }
    const reset = `\x1b]${resetCode}${index === undefined ? "" : `;${index}`}\x07`
    const restored = await run([rgb("0000/0000/0000"), rgb("aa/bb/cc"), rgb("0000/0000/0000")])
    expect(restored.result.observation, id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(restored.result.assertions, id).toMatchObject([{ kind: "positive" }])
    expect(restored.writes, id).toEqual([`\x1b]${setCode};${indexPart}rgb:aa/bb/cc\x07`, reset])
    const notRestored = await run([rgb("0000/0000/0000"), rgb("aa/bb/cc"), rgb("12/34/56")])
    expect(notRestored.result.observation, id).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
    expect(notRestored.result.assertions, id).toMatchObject([{ kind: "negative" }])
    // 27932 specimen: Terminal.app answers OSC 13/14 queries and ignores SET (run 1225b26b).
    const setIgnored = await run([rgb("0000/0000/0000"), rgb("0000/0000/0000"), rgb("0000/0000/0000")])
    expect(setIgnored.result.observation, id).toMatchObject({
      outcome: "unsupported",
      assertionType: "query_reply",
      note: "OSC set did not change the queried color",
    })
    expect(setIgnored.result.assertions, id).toMatchObject([{ kind: "negative" }])
    const noControl = await run([rgb("0000/0000/0000"), ""])
    expect(noControl.result.observation?.outcome, id).toBe("inconclusive")
    expect(noControl.result.assertions, id).toBeUndefined()
    const noReply = await run([])
    expect(noReply.writes, id).toEqual([])
    expect(noReply.result.observation, id).toBeUndefined()
    expect(noReply.result.tests, id).toMatchObject([
      expect.objectContaining({ status: "test-failure", reason: expect.any(String) }),
    ])
  },
)

const appOnlyEffects = [
  "extensions.osc22-pointer",
  "extensions.osc777-notify",
  "extensions.osc666-termprop",
  "extensions.osc3008-context",
  "extensions.osc176-app-id",
  "extensions.osc555-flash",
  "extensions.osc440-audio",
] as const

test.each(appOnlyEffects)("%s cursor replies do not prove the advertised effect", async (id) => {
  const definition = extensionsProbes.find((item) => item.id === id)
  if (!definition?.term) throw new Error(`missing app-only extension callback ${id}`)

  const position = { row: 3, col: 1 }
  const run = (cursor: typeof position | null) =>
    definition.term!({
      write: () => undefined,
      queryCursorPosition: async () => cursor,
    } as unknown as TermProbeSource)

  const answered = await run(position)
  expect(answered.pass, id).toBe(false)
  expect(answered.response, id).toBe("3;1")
  expect(answered.observation, id).toBeUndefined()
  expect(answered.criterionBranch, id).toBe("headless-observable-review")
  expect(answered.notTested, id).toMatchObject({ reason: "no-semantic-observable" })
  expect(answered.tests, id).toContainEqual(
    expect.objectContaining({
      id: "review",
      status: "test-todo",
      reason: expect.stringMatching(/^Cursor response does not measure /),
    }),
  )
  expect(answered.assertions, id).toBeUndefined()

  const silent = await run(null)
  expect(silent.pass, id).toBe(false)
  expect(silent.response, id).toBeUndefined()
  expect(silent.observation, id).toBeUndefined()
  expect(silent.tests, id).toMatchObject([
    expect.objectContaining({ status: "test-failure", reason: expect.any(String) }),
  ])
  expect(silent.assertions, id).toBeUndefined()
})

test("a DA1 sentinel with no OSC reply is a measured negative; a late reply grades by the reply", async () => {
  const definition = callback("extensions.osc10-fg-color")
  const da1 = "\x1b[?1;2c"
  const frame = "\x1b]10;rgb:ffff/0000/0000\x07"
  const app = (raw: string, sentinel?: { atMs: number; graceMs: number }) =>
    definition.term!({
      queryWithSentinelOutcome: async (_query: string, pattern: RegExp) => ({
        match: pattern.exec(raw),
        reason: pattern.test(raw) ? "reply" : "sentinel",
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
        ...(sentinel && { sentinel }),
      }),
    } as unknown as TermProbeSource)

  const silent = await app(da1, { atMs: 7, graceMs: 250 })
  expect(silent.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "query_reply",
    note: "negative by sentinel",
  })
  expect(silent.assertions).toMatchObject([
    { kind: "negative", observed: "DA1 answered at +7ms; no reply through the 250 ms window" },
  ])

  const late = await app(da1 + frame, { atMs: 7, graceMs: 250 })
  expect(late.observation).toMatchObject({
    outcome: "supported",
    assertionType: "query_reply",
    note: "reply after sentinel",
  })
  expect(late.assertions).toMatchObject([{ kind: "positive", observed: frame }])

  // Without the measured ordering an engine or simulated capture carries, silence stays unknown; the
  // ordering note is the only thing the measurement adds to a reply the site already matched.
  const unmeasured = await app(da1)
  expect(unmeasured.observation?.outcome).toBe("inconclusive")
  expect(unmeasured.assertions).toBeUndefined()
  const unmeasuredLate = await app(da1 + frame)
  expect(unmeasuredLate.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(unmeasuredLate.observation?.note).toBeUndefined()

  // A partial frame after DA1 is the terminal answering badly, not a silent terminal.
  const partial = await app(da1 + "\x1b]10;", { atMs: 7, graceMs: 250 })
  expect(partial.observation?.outcome).toBe("inconclusive")
  expect(partial.assertions).toBeUndefined()
})

test("the unanswered-query choke point grades a measured sentinel and never a timeout", async () => {
  const definition = callback("extensions.osc21-kitty-color")
  const context = (reply: Record<string, unknown>) =>
    definition.term!({ queryWithSentinelOutcome: async () => reply } as unknown as TermProbeSource)

  const silent = await context({
    match: null,
    reason: "sentinel",
    raw: "\x1b[?1;2c",
    rawBase64: Buffer.from("\x1b[?1;2c").toString("base64"),
    sentinel: { atMs: 5, graceMs: 250 },
  })
  expect(silent.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "query_reply",
    note: "negative by sentinel",
  })
  expect(silent.assertions).toMatchObject([
    { kind: "negative", observed: "DA1 answered at +5ms; no reply through the 250 ms window" },
  ])

  // A timeout never answered DA1 at all, so it cannot be a sentinel negative.
  const timedOut = await context({ match: null, reason: "timeout", raw: "", rawBase64: "" })
  expect(timedOut.observation).toBeUndefined()
  expect(timedOut.tests).toMatchObject([
    expect.objectContaining({ status: "test-failure", reason: "No OSC 21 reply; color rendering was not tested" }),
  ])
  expect(timedOut.assertions).toBeUndefined()
})

// 27914: xterm answers the item-2 read with CSI ? 2 ; 3 S — the documented failure
// reply, which omits the value (ctlseqs: "XTSMGRAPHICS ... return failure status if
// the terminal is not configured to support the corresponding ... SIXEL feature").
// Demanding a third parameter graded that failure as a malformed geometry.
test("XTSMGRAPHICS failure is a documented status, not a malformed geometry", async () => {
  const definition = callback("extensions.sixel-geometry-report")
  const headless = (raw: string) => definition.lib!({ feedCapture: () => raw } as unknown as LibProbeSource)
  const app = (raw: string) =>
    definition.term!({
      queryWithSentinelOutcome: async (_query: string, pattern: RegExp) => ({
        match: pattern.exec(raw),
        reason: pattern.test(raw) ? "reply" : "sentinel",
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
      }),
    } as unknown as TermProbeSource)
  const failure = "\x1b[?2;3S"
  for (const result of [headless(failure), await app(failure)]) {
    expect(result.response).toBe(failure)
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      note: "Sixel geometry query reported protocol status 3 (failure; no graphics geometry is configured)",
    })
    expect(result.assertions).toBeUndefined()
  }
  const success = "\x1b[?2;0;800;528S"
  for (const result of [headless(success), await app(success)]) {
    expect(result.observation).toMatchObject({
      outcome: "supported",
      note: "Current Sixel geometry reported as 800×528 pixels",
    })
  }
  const malformed = headless("\x1b[?2;S")
  expect(malformed.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply" })
})

/**
 * 27915: kitty graphics control data is an unordered comma-separated key=value list. WezTerm answers an allocation
 * with `I=<number>,i=<id>` where kitty writes `i=<id>,I=<number>`; both are the same reply.
 */
function kittyTransfer(id: string, allocation: (imageNumber: number) => string) {
  const definition = callback(id)
  const answer = (sequence: string): string => {
    const imageNumber = /I=(\d+)/.exec(sequence)?.[1]
    if (imageNumber !== undefined) return allocation(Number(imageNumber))
    return /a=p,i=2,/.test(sequence) ? "\x1b_Gi=2;OK\x1b\\" : ""
  }
  const headless = () => definition.lib!({ feed: () => undefined, feedCapture: answer } as unknown as LibProbeSource)
  const app = () =>
    definition.term!({
      queryWithSentinelOutcome: async (sequence: string, pattern: RegExp) => {
        const raw = `${answer(sequence)}\x1b[?65;4;6;18;22;52c`
        return {
          match: pattern.exec(raw),
          reason: pattern.test(raw) ? ("reply" as const) : ("sentinel" as const),
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
        }
      },
      write: () => undefined,
    } as unknown as TermProbeSource)
  return { app, headless }
}

test.each([
  ["kitty's order", (imageNumber: number) => `\x1b_Gi=2,I=${imageNumber};OK\x1b\\`],
  ["WezTerm's order", (imageNumber: number) => `\x1b_GI=${imageNumber},i=2;OK\x1b\\`],
] as const)(
  "kitty transmit and display accept the allocation reply in %s, in both collectors",
  async (_order, reply) => {
    for (const id of ["extensions.kitty-graphics.transmit", "extensions.kitty-graphics.display"]) {
      const { app, headless } = kittyTransfer(id, reply)
      for (const result of [headless(), await app()]) {
        expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
        expect(result.assertions, id).toMatchObject([{ kind: "positive" }])
      }
    }
  },
)

test("a placement that is never acknowledged is a decisive negative about the acknowledgement, not display", async () => {
  // 27915: WezTerm acknowledges the transfer and places silently; DA1 answers and no a=p reply comes in the window.
  const definition = callback("extensions.kitty-graphics.display")
  const result = await definition.term!({
    queryWithSentinelOutcome: async (sequence: string, pattern: RegExp) => {
      const imageNumber = /I=(\d+)/.exec(sequence)?.[1]
      const raw = `${imageNumber === undefined ? "" : `\x1b_GI=${imageNumber},i=2;OK\x1b\\`}\x1b[?65;4;6;18;22;52c`
      const match = pattern.exec(raw)
      return {
        match,
        reason: match ? ("reply" as const) : ("sentinel" as const),
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
        ...(match ? {} : { sentinel: { atMs: 3, graceMs: 250 } }),
      }
    },
    write: () => undefined,
  } as unknown as TermProbeSource)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  expect(result.assertions).toMatchObject([{ kind: "negative", expected: expect.stringContaining("acknowledgement") }])
  expect(JSON.stringify(result)).not.toMatch(/does not display/u)
})

test("a kitty allocation reply that echoes another image number does not qualify", async () => {
  for (const id of ["extensions.kitty-graphics.transmit", "extensions.kitty-graphics.display"]) {
    const { app, headless } = kittyTransfer(id, (imageNumber) => `\x1b_GI=${imageNumber + 1},i=2;OK\x1b\\`)
    for (const result of [headless(), await app()]) {
      expect(result.observation?.outcome, id).not.toBe("supported")
      expect(result.assertions, id).toBeUndefined()
    }
  }
})

// 31377: the refusal specimen is retained run772ff2a6/suite9cc61ebe4417, including its DA1 window.
// A correlated refusal proves recognition but does not accept the canonical direct RGB query.
test.each([
  ["OK", "\x1b_Gi=31;OK\x1b\\", "supported", "OK"],
  ["retained vterm refusal", "\x1b_Gi=31;ENOTSUP\x1b\\\x1b[?62;4c", "unsupported", "ENOTSUP"],
  ["another printable error", "\x1b_Gi=31;EIO: image unavailable\x1b\\", "unsupported", "EIO: image unavailable"],
  ["wrong image ID", "\x1b_Gi=32;ENOTSUP\x1b\\", null, null],
  ["control byte", "\x1b_Gi=31;ENO\x00TSUP\x1b\\", null, null],
  ["non-ASCII message", "\x1b_Gi=31;E\u0100\x1b\\", null, null],
  ["partial frame", "\x1b_Gi=31;ENOTSUP", null, null],
  ["no reply", "", null, null],
] as const)("the canonical Kitty query grades %s consistently in both arms", async (_label, raw, outcome, message) => {
  const definition = callback("extensions.kitty-graphics")
  const query = (_sequence: string, pattern: RegExp) => ({
    match: pattern.exec(raw),
    reason: "sentinel" as const,
    raw,
    rawBase64: Buffer.from(raw).toString("base64"),
  })
  const results = [
    definition.lib!({ feedCapture: () => raw } as unknown as LibProbeSource),
    definition.lib!({ queryWithSentinelOutcome: query } as unknown as LibProbeSource),
    await definition.term!({
      queryWithSentinelOutcome: async (sequence: string, pattern: RegExp) => query(sequence, pattern),
    } as unknown as TermProbeSource),
  ]
  for (const result of results) {
    expect(result.response).toBe(raw)
    if (outcome === null) {
      expect(result.observation?.outcome).not.toBe("supported")
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.assertions).toBeUndefined()
    } else {
      expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
      expect(JSON.parse(result.assertions![0]!.note!)).toEqual({ protocolRecognized: true, message })
    }
  }
})

// The five captured-text wrappers must preserve malformed Unicode instead of throwing during encoding.
// Keyboard detection and image allocation must succeed first so their later wrappers are actually reached.
test.each([
  ["keyboard", "extensions.kitty-keyboard"],
  ["allocation", "extensions.kitty-graphics.transmit"],
  ["placement", "extensions.kitty-graphics.display"],
  ["foreground", "extensions.osc21-kitty-color"],
  ["query", "extensions.kitty-graphics"],
] as const)("captured-text normalization preserves malformed Unicode for %s", (kind, id) => {
  const raw = "\x1b_Gi=31;E\u0100\x1b\\"
  const writes: string[] = []
  const result = callback(id).lib!({
    feed: (sequence: string) => writes.push(sequence),
    feedCapture: (sequence: string) => {
      if (kind === "keyboard" && sequence === "\x1b[?u\x1b[c") return "\x1b[?1u\x1b[?62;4c"
      if (kind === "placement" && sequence.includes("a=t")) {
        const imageNumber = /I=(\d+)/.exec(sequence)?.[1]
        if (!imageNumber) throw new Error("placement fixture requires an image allocation request")
        return `\x1b_Gi=2,I=${imageNumber};OK\x1b\\`
      }
      return raw
    },
  } as unknown as LibProbeSource)
  expect(result.response).toBe(raw)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "query_reply" })
  expect(result.assertions).toBeUndefined()
  if (kind === "keyboard") expect(writes).toContain("\x1b[<u")
  if (kind === "placement") expect(writes).toContain("\x1b_Ga=d,d=I,i=2,q=2\x1b\\")
})

/**
 * A terminal that models one highlight-colour slot: OSC 17/19 set it, OSC 117/119 reset it to the
 * colour it held at run start, and a query reports it. `ignoresReset` models a terminal that consumes
 * the reset without restoring the slot.
 */
function highlightTerminal(
  setCode: number,
  resetCode: number,
  initial: string,
  ignoresReset = false,
  ignoresSet = false,
) {
  let colour = initial
  const writes: string[] = []
  const queries: string[] = []
  const ctx = {
    rows: 24,
    cols: 80,
    write: (bytes: string) => {
      writes.push(bytes)
      const set = new RegExp(`\\x1b\\]${setCode};rgb:([0-9a-f]{1,4}/[0-9a-f]{1,4}/[0-9a-f]{1,4})\\x07`, "i").exec(bytes)
      if (set?.[1] && !ignoresSet) colour = set[1]
      if (!ignoresReset && bytes === `\x1b]${resetCode}\x07`) colour = initial
    },
    queryWithSentinelOutcome: async (_sequence: string, pattern: RegExp) => {
      queries.push(_sequence)
      const raw = `\x1b]${setCode};rgb:${colour}\x07`
      return {
        match: pattern.exec(raw),
        reason: "reply" as const,
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
      }
    },
    queryCursorPosition: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" }),
    queryMode: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
  } as unknown as TermProbeSource
  const lib = {
    feed: ctx.write,
    feedCapture: (bytes: string) => {
      ctx.write(bytes)
      queries.push(bytes)
      return bytes === `\x1b]${setCode};?\x07` ? `\x1b]${setCode};rgb:${colour}\x07` : ""
    },
    getCell: () => ({ char: "X" }),
  } as unknown as LibProbeSource
  return { ctx, lib, writes, queries, colour: () => colour }
}

test.each([
  ["extensions.osc117-reset-highlight-bg", 17, 117],
  ["extensions.osc119-reset-highlight-fg", 19, 119],
] as const)("%s decides the reset against the initial colour it read first", async (id, setCode, resetCode) => {
  const definition = callback(id)
  // It mutates the slot, so the collector's disposable-receipt classification applies — the same one
  // the OSC 10-14 reset probes carry. A query-only arm would bypass the ownership admission.
  expect(definition.termWrites).toBeUndefined()
  expect(definition.termNeedsDisposable).toBe(true)
  const honest = highlightTerminal(setCode, resetCode, "1111/2222/3333")
  const supported = await definition.term!(honest.ctx)
  expect(supported.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  // The initial colour is asked for first, and the run leaves the slot as it found it.
  expect(honest.queries[0]).toBe(`\x1b]${setCode};?\x07`)
  expect(honest.colour()).toBe("1111/2222/3333")

  // A terminal that consumes the reset without restoring the slot is a measured negative.
  const ignoring = highlightTerminal(setCode, resetCode, "1111/2222/3333", true)
  const unsupported = await definition.term!(ignoring.ctx)
  expect(unsupported.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  // The honest terminal restores the slot with its own reset, which would hide a missing finally.
  // This one leaves the test colour behind unless the run restores what it found.
  expect(ignoring.colour()).toBe("1111/2222/3333")

  // No initial reading means nothing to compare a reset against: inconclusive, never a verdict.
  const silent = await definition.term!(replayTermProbeSource(new Map()))
  expect(silent.observation).toBeUndefined()
  expect(silent.tests).toMatchObject([expect.objectContaining({ status: "test-failure", reason: expect.any(String) })])

  // Preserve the actual read outcome at all three stages: nullable parsing alone
  // cannot distinguish silence from malformed or sentinel bytes, including after a set.
  for (const stage of [0, 1, 2]) {
    for (const raw of ["", "malformed", "\x1b[?1;2c"]) {
      const fixture = highlightTerminal(setCode, resetCode, "1111/2222/3333")
      let reads = 0
      const result = await definition.term!({
        ...fixture.ctx,
        queryWithSentinelOutcome: async (sequence, pattern) => {
          if (reads++ !== stage) return fixture.ctx.queryWithSentinelOutcome(sequence, pattern)
          return {
            raw,
            rawBase64: btoa(raw),
            match: pattern.exec(raw),
            reason: raw === "\x1b[?1;2c" ? "sentinel" : "timeout",
          }
        },
      })
      expect(result.observation).toBeUndefined()
      expect(result.note).toBeUndefined()
      expect(result.tests?.[0]?.reason).toContain(
        ["initial highlight colour is unknown", "known colour was not read back", "did not answer after"][stage]!,
      )
      if (raw === "") expect(result).toHaveProperty("replyFailureTestIds", ["criterion"])
      else expect(result).not.toHaveProperty("replyFailureTestIds")
      expect(fixture.colour()).toBe("1111/2222/3333")
      if (stage > 0) expect(fixture.writes.at(-1)).toBe(`\x1b]${setCode};rgb:1111/2222/3333\x07`)
    }
  }

  // A terminal that starts on the default test colour still needs an observed change: a fixed set
  // colour would let both readings agree while the reset was ignored.
  const collisionIgnoring = highlightTerminal(setCode, resetCode, "3030/6060/9090", true)
  const collisionUnsupported = await definition.term!(collisionIgnoring.ctx)
  expect(collisionUnsupported.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  expect(collisionIgnoring.colour()).toBe("3030/6060/9090")

  const collisionHonest = highlightTerminal(setCode, resetCode, "3030/6060/9090")
  const collisionSupported = await definition.term!(collisionHonest.ctx)
  expect(collisionSupported.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
})

test.each([
  ["extensions.osc117-reset-highlight-bg", 17, 117],
  ["extensions.osc119-reset-highlight-fg", 19, 119],
] as const)("%s grades the headless reset only after a distinct verified change", (id, setCode, resetCode) => {
  const definition = callback(id)
  expect(definition.libAssertionType).toBeUndefined() // #28801: measured reply and source-review routes differ.
  for (const ignoresReset of [false, true]) {
    const fixture = highlightTerminal(setCode, resetCode, "1111/2222/3333", ignoresReset)
    const result = definition.lib!(fixture.lib)
    expect(result.observation).toMatchObject({
      outcome: ignoresReset ? "unsupported" : "supported",
      assertionType: "query_reply",
    })
    expect(fixture.queries[0]).toBe(`\x1b]${setCode};?\x07`)
    expect(fixture.colour()).toBe("1111/2222/3333")
  }
  for (const fixture of [
    highlightTerminal(setCode, resetCode, ""),
    highlightTerminal(setCode, resetCode, "1111/2222/3333", false, true),
  ]) {
    const result = definition.lib!(fixture.lib)
    expect(result.observation?.outcome).not.toBe("supported")
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(result.tests ?? result.observation).toBeDefined()
  }
  const silent = highlightTerminal(setCode, resetCode, "")
  const result = definition.lib!({
    ...silent.lib,
    queryWithSentinelOutcome: () => ({
      match: null,
      reason: "sentinel",
      raw: "\x1b[?1;2c",
      rawBase64: btoa("\x1b[?1;2c"),
    }),
  })
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([{ id: "criterion", status: "test-failure", reason: expect.any(String) }])
})

// The retained xtermjs cells at suite2e6321bffd4d lack the initial highlight reply.
// Their existing prerequisite tests carry no audited identity; ordinary OSC review cases never enter this reset callback.
test.each([
  ["extensions.osc117-reset-highlight-bg", 17, 117],
  ["extensions.osc119-reset-highlight-fg", 19, 119],
] as const)(
  "%s reviews an audited silent highlight query without overriding real replies",
  (id, setCode, resetCode) => {
    const definition = callback(id)
    const query = `\x1b]${setCode};?\x07`
    for (const mode of [
      "pinned",
      "sentinel",
      "no-sentinel",
      "malformed",
      "vterm",
      "changed-lock",
      "wrong-version",
      "wrong-adapter",
    ] as const) {
      const calls: string[] = []
      const identity =
        mode === "vterm"
          ? geometryRuntime
          : {
              ...xtermOscIdentity,
              engineVersion: mode === "wrong-version" ? "6.0.1" : xtermOscIdentity.engineVersion,
              adapterVersion: mode === "wrong-adapter" ? "foreign" : xtermOscIdentity.adapterVersion,
              integrity: {
                ...xtermOscIdentity.integrity,
                lockIntegrity: mode === "changed-lock" ? "foreign" : xtermOscIdentity.integrity.lockIntegrity,
              },
            }
      const result = definition.lib!({
        runtimeIdentity: identity,
        feedCapture: (bytes: string) => {
          calls.push(bytes)
          return mode === "malformed" ? "unparsed colour reply" : ""
        },
        ...(mode === "sentinel" && {
          queryWithSentinelOutcome: (bytes: string) => {
            calls.push(bytes)
            return {
              match: null,
              reason: "sentinel",
              raw: "\x1b[?1;2c",
              rawBase64: btoa("\x1b[?1;2c"),
              sentinel: { atMs: 0, graceMs: 250 },
            }
          },
        }),
        feed: (bytes: string) => calls.push(bytes),
        getCell: () => ({ char: mode === "no-sentinel" ? " " : "X" }),
      } as unknown as LibProbeSource)
      expect(calls[0]).toBe(query)
      expect(result.observation?.outcome).not.toBe("supported")
      expect(result.observation?.outcome).not.toBe("unsupported")
      if (mode === "pinned" || mode === "sentinel") {
        expect(result.criterionBranch).toBe("source-negative-review")
        expect(result.observation).toMatchObject({
          outcome: "inconclusive",
          assertionType: "buffer_state",
        })
        expect(result.tests).toMatchObject([
          { id: "review", status: "test-failure", reason: expect.stringContaining("17a90b65") },
        ])
        expect(result.tests?.[0]?.reason).toContain(`no case ${setCode}/${resetCode}`)
        expect(result.assertions).toMatchObject([
          { kind: "negative", assertionType: "buffer_state", observed: result.response },
        ])
        const retained = JSON.parse(result.response!)
        expect(retained).toMatchObject({
          query,
          originalRaw: "",
          sentinel: { char: "X" },
          engineState: null,
          fed: calls[1],
        })
        expect(retained).toMatchObject({ fed: expect.stringContaining(`\x1b]${setCode};rgb:`) })
        expect(retained).not.toHaveProperty("runtimeIdentity")
        expect(retained).toMatchObject({ fed: expect.stringContaining(`\x1b]${resetCode}\x07X`) })
        if (mode === "sentinel") {
          expect(retained).toMatchObject({ initialSentinel: { reason: "sentinel", raw: "\x1b[?1;2c" } })
        }
      } else if (mode === "no-sentinel") {
        expect(result.observation).toMatchObject({
          outcome: "inconclusive",
          assertionType: "buffer_state",
          note: "No rendered X cell to evaluate",
        })
        expect(result.criterionBranch).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toBeUndefined()
      } else {
        expect(calls).toEqual([query])
        expect(result.observation).toBeUndefined()
        expect(result.tests).toMatchObject([
          {
            id: "criterion",
            status: "test-failure",
            reason: `OSC ${setCode} initial highlight colour was not read back, so OSC ${resetCode} cannot be compared with it`,
          },
        ])
        expect(result.assertions).toBeUndefined()
      }
    }
    // A measured colour wins over the static absence audit, including a genuine reset negative.
    for (const ignoresReset of [false, true]) {
      const fixture = highlightTerminal(setCode, resetCode, "1111/2222/3333", ignoresReset)
      const result = definition.lib!({ ...fixture.lib, runtimeIdentity: xtermOscIdentity })
      expect(result.criterionBranch).toBeUndefined()
      expect(result.observation).toMatchObject({
        outcome: ignoresReset ? "unsupported" : "supported",
        assertionType: "query_reply",
      })
      expect(fixture.queries[0]).toBe(query)
      expect(fixture.writes.some((bytes) => bytes.includes("\x1b[2K"))).toBe(false)
    }
  },
)

// Geometry audit re-pinned to bd3d32ae; original runb9697318 used source53a9eb92/tree617ae600.
// Q8 requires independent review of this context limit, never automatic Untestable.
const geometryRuntime = {
  kind: "js",
  adapterVersion: "0.10.2",
  termlessRevision: "8b8664540f365fa0ba1d9b6400d3c4d1a160582c",
  resolvedPath: "vendor/vterm/packages/vterm/src/index.ts",
  integrity: {
    kind: "source",
    repository: "git@github.com:beorn/vterm.git",
    revision: "bd3d32aea2f1994376a71adfc55b92705eedbd8c",
    treeOid: "f10a184811894462b9ca7b65d6aab8ffd2fdd0bd",
    cleanTree: true,
  },
  runtimeFormat: "js",
  engineVersion: "0.10.1",
} as const
const geometryReplies = [
  {
    id: "extensions.osc1337-cellsize",
    raw: "\u001b]1337;ReportCellSize=0;0\u001b\\\u001b[?62;4c",
    positive: "\u001b]1337;ReportCellSize=12;6\u001b\\",
  },
  {
    id: "extensions.osc776-cell-size",
    raw: "\u001b]776;0;0;0\u001b\\\u001b[?62;4c",
    positive: "\u001b]776;8;16;0\u001b\\",
  },
] as const

test.each(geometryReplies)("$id retains audited geometry limits for required review", ({ id, raw }) => {
  expect({
    resolvedPath: geometryRuntime.resolvedPath,
    runtimeFormat: geometryRuntime.runtimeFormat,
    engineVersion: geometryRuntime.engineVersion,
    repository: geometryRuntime.integrity.repository,
    treeOid: geometryRuntime.integrity.treeOid,
  }).toEqual(SOURCE_TREE_AUDITS.vterm)
  for (const sentinel of [false, true]) {
    const ctx = {
      feedCapture: () => raw,
      runtimeIdentity: geometryRuntime,
      ...(sentinel && {
        queryWithSentinelOutcome: () => ({
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
          reason: "sentinel",
          match: null,
        }),
      }),
    } as unknown as LibProbeSource
    const result = callback(id).lib!(ctx)
    expect(result.notTested?.reason).toBe("no-semantic-observable")
    expect(result.tests).toMatchObject([{ id: "review", status: "test-todo" }])
    expect(result.observation).toBeUndefined()
    const state = JSON.parse(result.response!)
    expect(state).toMatchObject({ raw })
    expect(state).not.toHaveProperty("runtimeIdentity")
  }
})

test.each(geometryReplies)("$id requires audited source and complete zero geometry", ({ id, raw, positive }) => {
  const identities = [
    undefined,
    { ...geometryRuntime, resolvedPath: "foreign/index.ts" },
    { ...geometryRuntime, runtimeFormat: "wasm" },
    ...[{ cleanTree: false }, { revision: "foreign" }, { treeOid: "foreign" }, { repository: "foreign" }].map(
      (change) => ({ ...geometryRuntime, integrity: { ...geometryRuntime.integrity, ...change } }),
    ),
  ]
  for (const runtimeIdentity of identities) {
    const ctx = { feedCapture: () => raw, runtimeIdentity } as unknown as LibProbeSource
    expect(callback(id).lib!(ctx).notTested).toBeUndefined()
  }
  for (const reply of ["", raw.slice(0, 4), "foreign", raw + "foreign", "foreign" + raw]) {
    const ctx = { feedCapture: () => reply, runtimeIdentity: geometryRuntime } as unknown as LibProbeSource
    expect(callback(id).lib!(ctx).notTested).toBeUndefined()
  }
  const ctx = { feedCapture: () => positive, runtimeIdentity: geometryRuntime } as unknown as LibProbeSource
  expect(callback(id).lib!(ctx).observation?.outcome).toBe("supported")
})

// The source failure precedes zero/positive/malformed geometry and cannot depend on the install path.
test.each(geometryReplies)("$id reports source tree drift before geometry grading", ({ id, raw, positive }) => {
  for (const overrides of [{}, { adapterVersion: "other" }]) {
    for (const cleanTree of [true, false]) {
      const runtimeIdentity = {
        ...geometryRuntime,
        ...overrides,
        integrity: { ...geometryRuntime.integrity, cleanTree, treeOid: "f".repeat(40) },
      }
      for (const reply of [raw, positive, "malformed"]) {
        const result = callback(id).lib!({ feedCapture: () => reply, runtimeIdentity } as unknown as LibProbeSource)
        expect(result.tests).toEqual([
          {
            id: "criterion",
            status: "test-failure",
            reason: `source identity drift: expected ${geometryRuntime.integrity.treeOid}, read ${"f".repeat(40)}`,
          },
        ])
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.notTested).toBeUndefined()
        expect(JSON.parse(result.response!)).toMatchObject({ raw: reply })
        expect(JSON.parse(result.response!)).not.toHaveProperty("runtimeIdentity")
      }
    }
  }
})

// Same repository/version has three distinct audited entry paths; siblings must not acquire vterm drift.
test.each(geometryReplies)("$id distinguishes sibling source entries", ({ id, raw }) => {
  const baseline = callback(id).lib!({ feedCapture: () => raw } as unknown as LibProbeSource)
  for (const [engine, treeOid] of [
    ["vt100", "1eaac257cf9ff8d8ece752c8e6edc04b9ddaa6cf"],
    ["vt220", "d504616ae458b8b0fa9fa365034c30bd35f55ee8"],
  ]) {
    const runtimeIdentity = {
      ...geometryRuntime,
      resolvedPath: `vendor/vterm/packages/${engine}/src/index.ts`,
      integrity: { ...geometryRuntime.integrity, treeOid },
    }
    expect(callback(id).lib!({ feedCapture: () => raw, runtimeIdentity } as unknown as LibProbeSource)).toEqual(
      baseline,
    )
    const changedVterm = { ...runtimeIdentity, resolvedPath: geometryRuntime.resolvedPath }
    expect(
      callback(id).lib!({ feedCapture: () => raw, runtimeIdentity: changedVterm } as unknown as LibProbeSource).tests,
    ).toMatchObject([
      {
        status: "test-failure",
        reason: `source identity drift: expected ${geometryRuntime.integrity.treeOid}, read ${treeOid}`,
      },
    ])
  }
})

// #31398: source-negative batch tests never drive the missing-icon-getter early return.
test.each([
  ["alacritty", auditedArtifacts[0]!, "ansi.rs:1349-1361"],
  ["ghostty", absentOscBatch.find((entry) => entry.engine === "ghostty")!.identity, "stream.zig:2017-2021"],
] as const)(
  "%s intrinsic OSC1 discard keeps the original stimulus and state for review",
  (_engine, identity, citation) => {
    const writes: string[] = []
    let title = "original"
    const source = {
      runtimeIdentity: identity,
      getTitle: () => title,
      feed: (bytes: string) => {
        writes.push(bytes)
        title = "after"
      },
    } as unknown as LibProbeSource
    const result = callback("extensions.osc1-icon").lib!(source)
    expect(writes).toEqual(["\x1b]1;test-icon\x07"])
    expect(JSON.parse(result.response!)).toEqual({ before: "original", after: "after" })
    expect(result.criterionBranch).toBe("source-negative-review")
    expect(result.tests).toMatchObject([
      { id: "review", status: "test-failure", reason: expect.stringContaining(citation) },
    ])
    expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
    expect(result.assertions).toMatchObject([{ kind: "negative", assertionType: "buffer_state" }])
    const foreign = callback("extensions.osc1-icon").lib!({
      ...source,
      runtimeIdentity: { ...identity, adapterSources: [] },
    })
    expect(foreign.notTested).toMatchObject({ reason: "no-semantic-observable" })
    expect(foreign.criterionBranch).toBeUndefined()
  },
)
