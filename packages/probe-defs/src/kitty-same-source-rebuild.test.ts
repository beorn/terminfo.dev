/**
 * @failure  A nixpkgs bump rebuilt kitty-official 0.49.2 from the same upstream source (binary sha256 bb65c2d5 ->
 *   30810637, termless eb72844) and termless 4707195 moved the layout/receipt blobs. The kitty audit keyed on the
 *   binary bytes, so all nine audited kitty-library rows (six OSC unhandled reports, three declared Untestable) fell to
 *   probe-todo from the 2026-11-13T08-49Z run on, with no change in what the engine's source does (@cto bef7054c,
 *   the vt100-rust shape of 90d6183a: engine and audited adapter identity survive build-only bumps).
 * @level    l1
 * @consumer kitty host-effect-h4 cohort (hasAuditedOscInterfaceAbsence) and the kitty D2-negative target
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { ALL_PROBES, isDeclaredUntestable } from "./index.ts"
import { inertLibProbeSource } from "./testing/group-harness.ts"
import type { HeadlessRuntimeIdentity, LibProbeSource, UnhandledSequence } from "./types.ts"

/** The kitty library identity the 2026-11-13T12-49-05Z remeasure run recorded (headless kitty-0.49.2 draft). */
const run1249 = {
  kind: "native",
  engineVersion: "0.49.2",
  adapterVersion: "0.11.0",
  termlessRevision: "1738b811aef1c70dfacf05be3e0e49faa19ae682",
  loadedBinary: {
    path: "/nix/store/4qhnq27h-kitty-official-binary-0.49.2/bin/kitty",
    sha256: "3081063706095bb788f2ff22ee32ba164420f951e35b596b4d663cb74f203f33",
  },
  provenance: {
    sha256: "3081063706095bb788f2ff22ee32ba164420f951e35b596b4d663cb74f203f33",
    sourceCommit: "b2cb871254fbdac19a085188813c8dfb258b95cd",
    buildHash: "0".repeat(64),
    toolchain: "recorded Nix binary",
    lockSha256: "01f99a311f8683aaea319d7fb164b25c4bd9e8e4ac03f9030c78cfb489d0a27c",
  },
  adapterSources: [
    { path: "packages/kitty/src/index.ts", blobOid: "3f207f911646613cdc3d8b04f155f0686a96a077" },
    { path: "packages/kitty/src/backend.ts", blobOid: "f8c227b927b805a3415efcc64968577848115033" },
    { path: "packages/kitty/build/bridge.py", blobOid: "473d25a335c4e739f915a254625607f617ed9d1e" },
    { path: "packages/kitty/build/layout.c", blobOid: "f58c0e943ad60daf20d54360184e039e16ff3826" },
    { path: "packages/kitty/build/native-mode-layout.json", blobOid: "b131e26069edf2129b4ff70aa2ce88c154dea811" },
    {
      path: "packages/kitty/build/native-mode-layout.receipt.json",
      blobOid: "3e2dfd878a701eba5430a31948bc26a372ebdcfc",
    },
  ],
} satisfies HeadlessRuntimeIdentity

/** The 2026-11-13T21-49-03Z run at termless 3da7fd0e: the 34034 bridge and layout, and another re-patched binary (34051). */
const run2149 = {
  ...run1249,
  termlessRevision: "3da7fd0efaade8268c8940ae93e92fc2f74bf58e",
  loadedBinary: {
    path: "/nix/store/6dp446p5-kitty-official-binary-0.49.2/bin/kitty",
    sha256: "cd8e986533e83b7d1fb0621d110fa41be45655353a14662ff3e04351fc41ae83",
  },
  provenance: {
    ...run1249.provenance,
    sha256: "cd8e986533e83b7d1fb0621d110fa41be45655353a14662ff3e04351fc41ae83",
  },
  adapterSources: run1249.adapterSources.map((entry) =>
    entry.path.endsWith("bridge.py")
      ? { ...entry, blobOid: "94e5f97e5933625355b5c988721027f684f9f204" }
      : entry.path.endsWith("native-mode-layout.json")
        ? { ...entry, blobOid: "37594baca0cbd3ebf847478a47db999d937506ba" }
        : entry.path.endsWith("native-mode-layout.receipt.json")
          ? { ...entry, blobOid: "189dd4fdd9780f841756928e237490f75dfbb947" }
          : entry,
  ),
} satisfies HeadlessRuntimeIdentity

const otherBinary = "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886"
const identities = {
  "the 12:49Z run": run1249,
  "the 21:49Z run (termless 3da7fd0e)": run2149,
  "the same source and adapter with other binary bytes": {
    ...run1249,
    loadedBinary: { ...run1249.loadedBinary, sha256: otherBinary },
    provenance: { ...run1249.provenance, sha256: otherBinary },
  },
} as const
const refused = {
  "another source commit": { ...run1249, provenance: { ...run1249.provenance, sourceCommit: "1".repeat(40) } },
  "an unaudited adapter blob": {
    ...run1249,
    adapterSources: run1249.adapterSources.map((entry) =>
      entry.path.endsWith("bridge.py") ? { ...entry, blobOid: "2".repeat(40) } : entry,
    ),
  },
  "another engine version": { ...run1249, engineVersion: "0.50.0" },
} as const

/** A kitty library that reports `code` unhandled when fed, sets the OSC 2 title and bolds on SGR 1 (both controls). */
function kittyLibrary(runtimeIdentity: HeadlessRuntimeIdentity, code: UnhandledSequence): LibProbeSource {
  const report: UnhandledSequence[] = []
  let title = ""
  let bold = false
  const base = inertLibProbeSource()
  const pattern =
    code.kind === "osc" ? new RegExp(`\\x1b\\]${code.code}(?=;|\\x07|\\x1b)`) : new RegExp(`\\x1b\\[9${code.code}`)
  return {
    ...base,
    backendName: "kitty",
    runtimeIdentity,
    getUnhandledSequences: () => report.slice(),
    getTitle: () => title,
    getCell: () => ({ ...base.getCell(0, 0), bold }),
    feed: (text) => {
      const titleSet = /\x1b\]2;([^\x07]*)\x07/.exec(text)
      if (titleSet) title = titleSet[1] ?? ""
      if (text.includes("\x1b[0m")) bold = false
      if (text.includes("\x1b[1m")) bold = true
      if (pattern.test(text)) report.push(code)
    },
  }
}

const probe = (id: string) => ALL_PROBES.find((entry) => entry.id === id)!

describe("kitty library audit survives a same-source rebuild (@cto bef7054c)", () => {
  test.each(Object.entries(identities))("%s: osc176 reported unhandled decides Unsupported", (_, identity) => {
    const result = probe("extensions.osc176-app-id").lib!(kittyLibrary(identity, { kind: "osc", code: "176" }))
    expect(result.observation?.outcome).toBe("unsupported")
  })

  test.each(Object.entries(identities))("%s: osc3008 keeps its Untestable declaration", (_, identity) => {
    const result = probe("extensions.osc3008-context").lib!(kittyLibrary(identity, { kind: "osc", code: "3008" }))
    expect(isDeclaredUntestable(result)).toBe(true)
  })

  test.each(Object.entries(refused))("%s: neither route decides", (_, identity) => {
    const osc176 = probe("extensions.osc176-app-id").lib!(kittyLibrary(identity, { kind: "osc", code: "176" }))
    expect(osc176.observation?.outcome).not.toBe("unsupported")
    const osc3008 = probe("extensions.osc3008-context").lib!(kittyLibrary(identity, { kind: "osc", code: "3008" }))
    expect(isDeclaredUntestable(osc3008)).toBe(false)
  })
})
