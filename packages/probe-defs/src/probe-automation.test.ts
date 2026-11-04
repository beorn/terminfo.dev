import { createHash } from "node:crypto"
import { describe, expect, test } from "vitest"
import {
  ALL_PROBES,
  ASSERTION_TYPES,
  type LibProbeSource,
  type TermProbeSource,
  type TerminalQueryOutcome,
} from "./index.ts"
import {
  HEADLESS_OBSERVABLE_REVIEW,
  ADAPTER_SOURCE_AUDITS,
  SOURCE_NEGATIVE_REVIEW,
  REPLY_AFTER_SENTINEL_NOTE,
  NO_SAME_PATH_CONTROL,
} from "./helpers.ts"

const OSC_SEMANTIC_MARK_CASES = [
  ["extensions.osc133-a", "\x1b]133;A\x07"],
  ["extensions.osc133-b", "\x1b]133;B\x07"],
  ["extensions.osc133-c", "\x1b]133;C\x07"],
  ["extensions.osc133-d", "\x1b]133;D;0\x07"],
  ["extensions.osc133-p", "\x1b]133;P;Cwd=/tmp\x07"],
  ["extensions.osc633-a", "\x1b]633;A\x07"],
  ["extensions.osc633-b", "\x1b]633;B\x07"],
  ["extensions.osc633-c", "\x1b]633;C\x07"],
  ["extensions.osc633-e", "\x1b]633;E;ls -la;nonce123\x07"],
] as const
// osc633-d and osc633-p read their own command-end and Cwd reader routes (#32247); extensions-contract.test.ts
// covers them, so the generic marker-consumption loops here exclude them.
const OSC_SEMANTIC_MARK_IDS = OSC_SEMANTIC_MARK_CASES.map(([id]) => id)

function probe(id: string) {
  const found = ALL_PROBES.find((p) => p.id === id)
  if (!found) throw new Error(`missing probe ${id}`)
  return found
}

test("library declarations retain nonempty unique sets of existing assertion classes", () => {
  for (const definition of ALL_PROBES) {
    const declaration = definition.libAssertionType
    if (declaration === null || declaration === undefined) continue
    if (typeof declaration === "string") {
      expect(ASSERTION_TYPES, definition.id).toContain(declaration)
      continue
    }
    expect(typeof declaration.when, definition.id).toBe("function")
    for (const branch of [declaration.then, declaration.otherwise]) {
      expect(branch.length, definition.id).toBeGreaterThan(0)
      expect(new Set(branch).size, definition.id).toBe(branch.length)
      for (const assertionType of branch) expect(ASSERTION_TYPES, definition.id).toContain(assertionType)
    }
  }
})

function context(overrides: Partial<LibProbeSource>): LibProbeSource {
  return {
    backendName: "scripted-model",
    kind: "live",
    cols: 80,
    feed() {},
    feedCapture() {
      return ""
    },
    getCell() {
      return {
        char: "",
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        underlineColor: null,
        strikethrough: false,
        inverse: false,
        hidden: false,
        blink: false,
        overline: false,
        fg: null,
        bg: null,
        wide: false,
      }
    },
    getCursor() {
      return { x: 0, y: 0, visible: true, style: "block" }
    },
    getMode() {
      return false
    },
    getText() {
      return ""
    },
    getScrollback() {
      return { viewportOffset: 0, totalLines: 24, screenLines: 24 }
    },
    getTitle() {
      return ""
    },
    reset() {},
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "unknown",
      extensions: new Set(),
    },
    ...overrides,
  }
}

function terminalSource(overrides: Partial<TermProbeSource>): TermProbeSource {
  return {
    kind: "live",
    write() {},
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinel: async () => null,
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 80,
    rows: 24,
    ...overrides,
  }
}

/**
 * @failure A seeded colour reply was mistaken for the missing embedder-owned initial value.
 * @level l0
 * @consumer Library initial-colour callbacks and their required independent review.
 * @testonly none
 */
// H1-H4/H6: actual criterion callbacks must own both the query declaration and its missing-input cause.
// Parser/collector input fixtures cannot catch a production caller that never supplies either field.
const artifact = "e6e16113863355b77d0aa3b359bd40c7066fb144e005fbc324fecfa3f4869bea"
const nativeIdentity: NonNullable<LibProbeSource["runtimeIdentity"]> = {
  kind: "native",
  engineVersion: "0.26.0",
  adapterVersion: "fixture",
  termlessRevision: "2".repeat(40),
  loadedBinary: { path: "fixture.node", sha256: artifact },
  provenance: {
    sha256: artifact,
    sourceCommit: "3".repeat(40),
    buildHash: "b".repeat(64),
    toolchain: "fixture",
    lockSha256: "c".repeat(64),
  },
}
describe("native host recipe callers", () => {
  test.each([
    ["extensions.osc10-fg-color", "color-request", "foreground-rgb", "\x1b]10;?\x07"],
    ["extensions.osc11-bg-color", "color-request", "background-rgb", "\x1b]11;?\x07"],
    ["extensions.osc12-cursor-color", "color-request", "cursor-rgb", "\x1b]12;?\x07"],
    ["extensions.osc4-palette", "color-request", "palette-entry-rgb", "\x1b]4;0;?\x07"],
    ["extensions.osc110-reset-fg", "color-request", "foreground-rgb", "\x1b]10;?\x07"],
    ["extensions.osc111-reset-bg", "color-request", "background-rgb", "\x1b]11;?\x07"],
    ["extensions.osc112-reset-cursor", "color-request", "cursor-rgb", "\x1b]12;?\x07"],
    ["extensions.osc104-reset-palette", "color-request", "palette-entry-rgb", "\x1b]4;0;?\x07"],
    ["extensions.osc30001-color-stack-push", "color-request", "foreground-rgb", "\x1b]10;?\x07"],
    ["extensions.osc30101-color-stack-pop", "color-request", "foreground-rgb", "\x1b]10;?\x07"],
    ["device.xtwinops-14", "text-area-size", "pixel-geometry", "\x1b[14t"],
    ["extensions.osc52-clipboard", "clipboard-load", "clipboard-read-permission", "\x1b]52;c;?\x07"],
    ["extensions.osc52-write", "clipboard-load", "clipboard-read-permission", "\x1b]52;c;?\x07"],
    ["extensions.osc52-read", "clipboard-load", "clipboard-read-permission", "\x1b]52;c;?\x07"],
  ] as const)("%s retains its actual empty host query cause", (id, recipe, missing, query) => {
    for (const qualified of [false, true]) {
      const definition = probe(id)
      const captured: string[] = []
      const silence = {
        match: null,
        reason: "sentinel" as const,
        raw: "\x1b[?1;2c",
        rawBase64: "G1s/MTsyYw==",
        sentinel: { atMs: 0, graceMs: 250 },
      }
      const result = definition.lib!(
        context({
          ...(qualified && {
            queryWithSentinelOutcome(sequence: string) {
              captured.push(sequence)
              return silence
            },
          }),
          runtimeIdentity: nativeIdentity,
          feedCapture(sequence) {
            captured.push(sequence)
            return ""
          },
        }),
      )
      expect(captured).toContain(query)
      expect(definition.libHostRecipes).toContainEqual({ recipe, query, missing: [missing] })
      // The cause is what this run observed, never a source citation (#32246).
      expect(result.hostRecipeCauses).toMatchObject([{ recipe, cause: { kind: "observed", missing, query } }])
      const { hostRecipeCauses: _custody, ...criterion } = result
      // A colour reply the probe itself decides matches the identity-less run; an all-zero native capture has no
      // same-path control in this run and is the undecided record (@cto 9fad23d7, refined rule 4). The cause is kept.
      const bare = definition.lib!(
        context({ feedCapture: () => "", ...(qualified && { queryWithSentinelOutcome: () => silence }) }),
      )
      if (recipe === "color-request" && criterion.notTested === undefined) {
        expect(criterion).toEqual(bare)
      } else if (recipe === "color-request") {
        expect(criterion.notTested?.reason).toBe("no-semantic-observable")
        expect(criterion.observation).toBeUndefined()
      } else {
        expect(criterion.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
        expect(criterion.observation).toBeUndefined()
      }
    }
  })

  /**
   * @failure #32091: kitty's default read-clipboard-ask prompt held every OSC 52 read for a human, so osc52-read would
   * have published Unsupported for a host input the harness never supplied.
   * @consumer kitty extensions.osc52-write / osc52-read / osc52-clipboard lib arm
   */
  test("kitty's supplied read permission measures its OSC 52 cells and names the option, with no audited cause", () => {
    const kitty = "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886"
    const runtimeIdentity = {
      ...nativeIdentity,
      engineVersion: "0.49.2",
      loadedBinary: { path: "/fixture/kitty", sha256: kitty },
      provenance: { ...nativeIdentity.provenance, sha256: kitty },
    }
    const control = ["write-clipboard", "write-primary", "read-clipboard", "read-primary"]
    const kittyContext = () => {
      let stored = ""
      return context({
        runtimeIdentity,
        feed(text) {
          stored = /\x1b\]52;c;([A-Za-z0-9+/=]+)/.exec(text)?.[1] ?? stored
        },
        // kitty's legacy OSC 52 encoder answers a permitted read with the stored payload.
        feedCapture: (text) => (text === "\x1b]52;c;?\x07" ? `\x1b]52;c;${stored}\x1b\\` : ""),
        getClipboardState: () => ({ writes: [{ selector: "c", payload: stored }], control }),
      } as Partial<LibProbeSource>)
    }
    const write = probe("extensions.osc52-write").lib!(kittyContext())
    expect(write.observation?.outcome).toBe("supported")
    expect(write.hostRecipeCauses).toBeUndefined()
    for (const id of ["extensions.osc52-read", "extensions.osc52-clipboard"]) {
      const read = probe(id).lib!(kittyContext())
      expect(read.observation?.outcome, id).toBe("supported")
      expect(read.hostRecipeCauses, id).toBeUndefined()
      expect(read.note, id).toContain(`harness-supplied clipboard_control ${control.join(" ")}`)
      expect(read.note, id).toContain("read-clipboard-ask")
      expect(read.observation?.note, id).toContain(`harness-supplied clipboard_control ${control.join(" ")}`)
    }
  })

  // No per-artifact audit table decides a native host cause any more (#32246): any native artifact records the cause
  // it observed for an empty reply, keeps the criterion PROBE TODO, and records nothing once the host query answers.
  test.each([
    ["device.xtwinops-14", "text-area-size", "pixel-geometry", "\x1b[14t"],
    ["extensions.osc52-read", "clipboard-load", "clipboard-read-permission", "\x1b]52;c;?\x07"],
  ] as const)("%s records only an observed host cause on any native artifact", (id, recipe, missing, query) => {
    const other = "f".repeat(64)
    const run = (response: string) =>
      probe(id).lib!(
        context({
          runtimeIdentity: {
            ...nativeIdentity,
            loadedBinary: { path: "other.node", sha256: other },
            provenance: { ...nativeIdentity.provenance, sha256: other },
          },
          feedCapture: () => response,
        }),
      )
    const silent = run("")
    expect(silent.hostRecipeCauses).toEqual([{ recipe, cause: { kind: "observed", missing, query } }])
    expect(silent.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
    expect(silent.observation).toBeUndefined()
    expect(run("reply").hostRecipeCauses).toBeUndefined()
  })

  // #32246 P0 specimen: hourly run 2026-11-03T19-34-04-077Z draft 4aca132b refused WezTerm finalization because the
  // native fbb1ac47 addon (no audit-table row) left every OSC 52 recipe with causes []. Replaying its actual captures
  // (empty target reply, then the DA1 control reply) through the production callbacks must name the observed cause,
  // whatever the binary hash (@dev/4 RED 1178).
  const actualWezterm: NonNullable<LibProbeSource["runtimeIdentity"]> = {
    kind: "native",
    engineVersion: "0.1.0-fork.5",
    adapterVersion: "0.10.2",
    termlessRevision: "e896bb13424c1ee938ebcb62f7368fbdfed655d5",
    loadedBinary: {
      path: "vendor/termless/packages/wezterm/termless-wezterm.node",
      sha256: "fbb1ac47ff22bb7a526a8c8c861d5ad5c137bda770f25f31ad7c451f176c3c5f",
    },
    provenance: {
      sha256: "fbb1ac47ff22bb7a526a8c8c861d5ad5c137bda770f25f31ad7c451f176c3c5f",
      sourceCommit: "02e71e5a4643b63f3bd1f2f3c2cd928f3ae4b9bd",
      buildHash: "eafb9b670d1bf500f5234f3f7985c684c02d5f541a2ffc1e90dea92c85504895",
      toolchain: "rustc 1.94.0",
      lockSha256: "8eaeab733cced8d47feb223d773d5ae158b2e6af8c994f993d4071d9ba3231d4",
    },
  }
  test.each(["extensions.osc52-clipboard", "extensions.osc52-write", "extensions.osc52-read"])(
    "%s names the observed cause for the actual fbb1ac47 WezTerm silence",
    (id) => {
      const query = "\x1b]52;c;?\x07"
      const da1 = "\x1b[?65;4;6;18;22;52c"
      const result = probe(id).lib!(
        context({
          runtimeIdentity: actualWezterm,
          feedCapture: (sequence) => (sequence === "\x1b[c" ? da1 : ""),
          queryWithSentinelOutcome: (sequence) => ({
            match: null,
            reason: "sentinel" as const,
            raw: sequence === query ? da1 : "",
            rawBase64: "",
            sentinel: { atMs: 0, graceMs: 250 },
          }),
        }),
      )
      expect(result.hostRecipeCauses).toContainEqual({
        recipe: "clipboard-load",
        cause: { kind: "observed", missing: "clipboard-read-permission", query },
      })
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.criterionBranch).toBeUndefined()
    },
  )
})

/**
 * @failure A zero-byte reply on a loaded artifact is graded from a source citation instead of staying PROBE TODO, or a
 *   measured reply loses its observation (operator 2026-11-03, @cto 9fad23d7, #32246).
 * @level l0
 * @consumer probe() zero-reply hook (zeroReplyUndecided) over the real callbacks.
 */
// CTO d5f41664 explicitly replaces query-capture emptiness with qualified clean-silence attribution.
// These real callbacks own the native host cause; generic sentinel classifier tests cannot pin it.
describe("qualified clipboard roundtrip", () => {
  const da1 = "\x1b[?1;2c"
  const frame = (data: string) => `\x1b]52;c;${btoa(data)}\x07`
  const xtermIdentity = {
    kind: "js",
    runtimeFormat: "js",
    engineVersion: "6.0.0",
    adapterVersion: "0.10.2",
    termlessRevision: "84003d2c91610fe2743142675234a0fb3ec9cf1d",
    adapterSources: Object.entries(ADAPTER_SOURCE_AUDITS.xtermjs).map(([path, blobOid]) => ({ path, blobOid })),
    resolvedPath: "/fixture/@xterm/headless/lib-headless/xterm-headless.js",
    integrity: {
      kind: "registry",
      lockIntegrity: "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
    },
  } as const
  test("the qualified OSC 0 declaration inspects presence without I/O; clipboard declares query_reply", () => {
    const unavailable = () => {
      throw new Error("declaration performed I/O")
    }
    const source = context({
      runtimeIdentity: xtermIdentity,
      getIconLabel: unavailable,
      getTitle: unavailable,
      feed: unavailable,
      feedCapture: unavailable,
      queryWithSentinelOutcome: unavailable,
    })
    const declaration = probe("extensions.osc0-icon-title").libAssertionType
    if (declaration === null || typeof declaration !== "object") throw new Error("Missing qualified OSC 0")
    expect(declaration.when(source)).toBe(true)
    // No source audit qualifies the clipboard declarations any more (#32246): they declare the query reply alone.
    for (const id of ["extensions.osc52-clipboard", "extensions.osc52-write"]) {
      expect(probe(id).libAssertionType, id).toBe("query_reply")
    }
  })
  test.each(
    ["extensions.osc52-clipboard", "extensions.osc52-write"].flatMap((id) =>
      (["xtermjs", "vt100", "vt220"] as const).map((engine) => [id, engine] as const),
    ),
  )("%s grades no clean read negative from source on %s, while measured replies stay measured", (id, engine) => {
    const callback = probe(id).lib!
    const runtimeIdentity =
      engine === "xtermjs"
        ? xtermIdentity
        : {
            kind: "js" as const,
            runtimeFormat: "js" as const,
            engineVersion: "0.10.1",
            adapterVersion: "0.10.2",
            termlessRevision: "25089207e11420cf7a588987c1dc2683a45e8372",
            resolvedPath: `vendor/vterm/packages/${engine}/src/index.ts`,
            integrity: {
              kind: "source" as const,
              repository: "git@github.com:beorn/vterm.git",
              revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
              treeOid:
                engine === "vt100"
                  ? "b941dae48b25ae8825c394750bda5245c9d93dfa"
                  : "4205f8936ad1848d1029729f3ada888cd61759a8",
              cleanTree: true,
            },
            adapterSources: Object.entries(ADAPTER_SOURCE_AUDITS[engine]).map(([path, blobOid]) => ({ path, blobOid })),
          }
    const snapshots: string[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = callback(
        context({
          runtimeIdentity,
          getIconLabel: () => "",
          getCell: () => ({ char: "X" }) as ReturnType<LibProbeSource["getCell"]>,
          queryWithSentinelOutcome: () => ({
            raw: da1,
            rawBase64: Buffer.from(da1).toString("base64"),
            reason: "sentinel",
            match: null,
            sentinel: { atMs: 0, graceMs: 250 },
          }),
        }),
      )
      // No source audit turns a clean read negative into a source review any more (#32246): nothing here is graded.
      expect(result.criterionBranch).toBeUndefined()
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.observation?.outcome).not.toBe("supported")
      expect(result.tests).toEqual([
        {
          id: "criterion",
          status: "probe-todo",
          reason:
            "clipboard write unobservable: OSC 52 read is a sentinel negative on this engine and no clipboard-state witness is wired.",
        },
      ])
      snapshots.push(result.response!)
    }
    expect(snapshots[0]).toBe(snapshots[1])
    const written: string[] = []
    const positive = callback(
      context({
        runtimeIdentity,
        feed: (sequence) => written.push(sequence),
        getCell() {
          throw new Error("Measured clipboard replies must not use the source-only control")
        },
        queryWithSentinelOutcome(sequence, pattern) {
          expect(sequence).toBe("\x1b]52;c;?\x07")
          const payload = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(written.join(""))?.[1]
          if (!payload) throw new Error("Clipboard positive control received no write")
          const raw = `\x1b]52;c;${payload}\x07`
          return { raw, rawBase64: btoa(raw), reason: "reply", match: pattern.exec(raw) }
        },
      }),
    )
    expect(positive.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    const inert = callback(
      context({
        runtimeIdentity,
        getIconLabel: () => "",
        getCell: () => ({ char: " " }) as ReturnType<LibProbeSource["getCell"]>,
        queryWithSentinelOutcome: () => ({
          raw: da1,
          rawBase64: btoa(da1),
          reason: "sentinel",
          match: null,
          sentinel: { atMs: 0, graceMs: 250 },
        }),
      }),
    )
    expect(inert.observation?.outcome).not.toBe("supported")
    expect(inert.criterionBranch).not.toBe(SOURCE_NEGATIVE_REVIEW)
    for (const raw of ["\x1b]52;c;???\x07" + da1, "ZZZ" + da1, ""]) {
      const result = callback(
        context({
          runtimeIdentity,
          getIconLabel: () => "",
          queryWithSentinelOutcome: () => ({
            raw,
            rawBase64: Buffer.from(raw).toString("base64"),
            reason: raw === "" ? "timeout" : "sentinel",
            match: null,
            ...(raw !== "" && { sentinel: { atMs: 0, graceMs: 250 } }),
          }),
        }),
      )
      expect(result.criterionBranch).not.toBe(SOURCE_NEGATIVE_REVIEW)
      expect(result.observation?.outcome).not.toBe("unsupported")
    }
  })
  const cases = [
    { when: "clean sentinel silence", raw: da1, reason: "sentinel", sentinel: true, cause: true },
    { when: "whole empty buffer", raw: "", reason: "timeout", sentinel: false, cause: true },
    // Each pair has the same callback-visible bytes in both worlds. Neither world's cause is inferable.
    { when: "unmatched: empty query / junk plus DA1", raw: "ZZZ" + da1, reason: "sentinel", sentinel: true },
    { when: "unmatched: junk query / DA1", raw: "ZZZ" + da1, reason: "sentinel", sentinel: true },
    { when: "pending: empty query / junk", raw: "ZZZ", reason: "timeout", sentinel: false },
    { when: "pending: junk query / empty control", raw: "ZZZ", reason: "timeout", sentinel: false },
    { when: "reply: wrong nonce on control side", raw: frame("other-nonce") + da1, reason: "reply", sentinel: false },
    { when: "reply: wrong nonce on query side", raw: frame("other-nonce") + da1, reason: "reply", sentinel: false },
    { when: "answered: query holds DA1, control silent", raw: da1, reason: "timeout", sentinel: false },
    {
      when: "answered: empty query, control answers",
      raw: da1,
      reason: "sentinel",
      sentinel: true,
      cause: true,
    },
    { when: "DA1-shaped query then real DA1", raw: da1 + da1, reason: "sentinel", sentinel: true },
    { when: "DA1 followed by non-matching junk", raw: da1 + "ZZZ", reason: "sentinel", sentinel: true },
    { when: "malformed OSC52 reply", raw: "\x1b]52;c;???\x07" + da1, reason: "sentinel", sentinel: true },
  ] as const
  test.each(["extensions.osc52-clipboard", "extensions.osc52-write"])(
    "%s attributes only measured clean silence",
    (id) => {
      for (const row of cases) {
        const queries: string[] = []
        const result = probe(id).lib!(
          context({
            runtimeIdentity: nativeIdentity,
            feedCapture: () => {
              throw new Error("qualified roundtrip used bare capture")
            },
            queryWithSentinelOutcome(sequence, pattern): TerminalQueryOutcome {
              queries.push(sequence)
              return {
                raw: row.raw,
                rawBase64: Buffer.from(row.raw).toString("base64"),
                reason: row.reason,
                match: row.raw.match(pattern),
                ...(row.sentinel && { sentinel: { atMs: 0, graceMs: 250 } }),
              }
            },
          }),
        )
        expect(queries, row.when).toEqual(["\x1b]52;c;?\x07"])
        if ("cause" in row && row.cause) {
          // An empty host reply on a native artifact has no same-path control in this run: it keeps the capture and
          // the cause this run observed, and the criterion stays PROBE TODO (#32246, @cto 9fad23d7).
          expect(JSON.parse(result.response!), row.when).toEqual({ query: "\x1b]52;c;?\x07", response: row.raw })
          expect(result.hostRecipeCauses, row.when).toEqual([
            {
              recipe: "clipboard-load",
              cause: { kind: "observed", missing: "clipboard-read-permission", query: "\x1b]52;c;?\x07" },
            },
          ])
          expect(result.notTested, row.when).toEqual({
            reason: "no-semantic-observable",
            noObservable: NO_SAME_PATH_CONTROL,
          })
          expect(result.observation, row.when).toBeUndefined()
          expect(result.assertions, row.when).toBeUndefined()
        } else {
          expect(result.response, row.when).toBe(row.raw)
          expect(result.hostRecipeCauses, row.when).toBeUndefined()
          expect(result.observation, row.when).toMatchObject({
            outcome: "inconclusive",
            reason: row.reason === "reply" ? "insufficient-evidence" : "invalid-reply",
          })
        }
      }
    },
  )
  test.each(
    ["extensions.osc52-clipboard", "extensions.osc52-write"].flatMap((id) =>
      [false, true].map((after) => ({ id, after })),
    ),
  )("$id grades the actual written nonce and retains DA1 (reply after DA1: $after)", ({ id, after }) => {
    let encoded = ""
    let writes = 0
    let raw = ""
    const result = probe(id).lib!(
      context({
        runtimeIdentity: nativeIdentity,
        feed(text) {
          writes++
          encoded = /\x1b\]52;c;([^\x07]*)\x07/.exec(text)![1]!
        },
        feedCapture: () => {
          throw new Error("qualified roundtrip used bare capture")
        },
        queryWithSentinelOutcome(_sequence, pattern) {
          const reply = `\x1b]52;c;${encoded}\x07`
          raw = after ? da1 + reply : reply + da1
          return {
            raw,
            rawBase64: Buffer.from(raw).toString("base64"),
            reason: "reply",
            match: raw.match(pattern),
            ...(after && { sentinel: { atMs: 0, graceMs: 250 } }),
          }
        },
      }),
    )
    expect(writes).toBe(1)
    expect(atob(encoded)).toMatch(/^terminfo-osc52-/)
    expect(result.observation?.outcome).toBe("supported")
    expect(result.hostRecipeCauses).toBeUndefined()
    expect(result.response).toBe(raw)
  })
})

describe("zero-byte replies on a loaded artifact", () => {
  // A zero-byte reply on a loaded artifact has no same-path control in this run, so it stays PROBE TODO (#32246).
  const ZERO_REPLY_TODO = { reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL }
  const sourceIdentity = (treeOid: string, cleanTree = true): NonNullable<LibProbeSource["runtimeIdentity"]> => ({
    kind: "js",
    runtimeFormat: "js",
    engineVersion: "0.10.1",
    adapterVersion: "0.10.2",
    termlessRevision: "2d97417328b7b1d086f9396b9a1731216ed134cc",
    resolvedPath: `vendor/vterm/packages/${treeOid === "b941dae48b25ae8825c394750bda5245c9d93dfa" ? "vt100" : "vt220"}/src/index.ts`,
    integrity: {
      kind: "source",
      repository: "git@github.com:beorn/vterm.git",
      revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
      treeOid,
      cleanTree,
    },
  })
  const identity = (auditKey: string): NonNullable<LibProbeSource["runtimeIdentity"]> =>
    /^[0-9a-f]{40}$/.test(auditKey)
      ? sourceIdentity(auditKey)
      : {
          ...nativeIdentity,
          loadedBinary: { path: "audited.wasm", sha256: auditKey },
          provenance: { ...nativeIdentity.provenance, sha256: auditKey },
        }
  const run = (id: string, auditKey: string, reply: (sequence: string) => string) => {
    const sent: string[] = []
    const result = probe(id).lib!(
      context({
        runtimeIdentity: identity(auditKey),
        feedCapture(sequence) {
          sent.push(sequence)
          return reply(sequence)
        },
      }),
    )
    return { result, sent }
  }

  // A silent loaded binary is never a default negative and never a source citation: it records the zero-byte capture as
  // PROBE TODO, while a reply on the same binary stays observed (#32246).
  test("binary silence stays PROBE TODO with its capture while replies stay observed", () => {
    const sha = "f".repeat(64)
    const silent = run("device.secondary-da", sha, () => "")
    expect(silent.result.notTested).toEqual(ZERO_REPLY_TODO)
    expect(JSON.parse(silent.result.response!)).toMatchObject({ queries: silent.sent, replyBytes: 0 })
    expect(silent.result.observation).toBeUndefined()
    const observed = run("device.secondary-da", sha, () => "\x1b[>1;2;0c").result
    expect(observed.observation?.outcome).toBe("supported")
    expect(observed.notTested).toBeUndefined()
  })

  test.each([
    "extensions.kitty-keyboard",
    "extensions.kitty-keyboard.disambiguate",
    "extensions.kitty-keyboard.report-events",
    "extensions.kitty-keyboard.report-alternate",
    "extensions.kitty-keyboard.report-all-keys",
    "extensions.kitty-keyboard.report-text",
    "input.csi-u",
  ])("native readonly keyboard query retains required review: %s", (id) => {
    const { result, sent } = run(id, "17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3", () => "")
    expect(sent).toEqual(["\x1b[?u\x1b[c"])
    expect(result.notTested).toEqual(ZERO_REPLY_TODO)
    expect(result.observation).toBeUndefined()
    expect(result.assertions ?? []).toEqual([])
  })

  // #31377, CTO 29be6ad0: actual graphics request bytes (including allocation nonces) must survive the review.
  // Data-derived cases cannot notice a missing graphics entry or prove that its generated bytes were retained.
  test.each(["extensions.kitty-graphics", "extensions.kitty-graphics.transmit", "extensions.kitty-graphics.display"])(
    "native graphics query stays PROBE TODO with its actual fed bytes: %s",
    (id) => {
      const { result, sent } = run(id, "17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3", () => "")
      expect(result.notTested).toEqual(ZERO_REPLY_TODO)
      const queries = sent.filter((text) => text.startsWith("\x1b_G"))
      expect(queries).toHaveLength(1)
      expect(JSON.parse(result.response!)).toMatchObject({ queries: sent, replyBytes: 0, measuredResponse: "" })
      expect(result.observation).toBeUndefined()
    },
  )

  // CTO 29be6ad0: this member bypasses feedCapture; its raw bytes must decide review before sentinel stripping.
  test.each(["", "\x1b[?1;2c"])("native graphics sentinel member preserves raw reply %j", (raw) => {
    const sent: string[] = []
    const source = context({
      runtimeIdentity: identity("17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3"),
      queryWithSentinelOutcome(this: LibProbeSource, sequence) {
        expect(this).toBe(source)
        sent.push(sequence)
        return { match: null, reason: "timeout", raw, rawBase64: Buffer.from(raw).toString("base64") }
      },
    })
    const result = probe("extensions.kitty-graphics.transmit").lib!(source)
    expect(sent).toHaveLength(1)
    if (raw === "") {
      expect(result.notTested).toEqual(ZERO_REPLY_TODO)
      expect(JSON.parse(result.response!)).toMatchObject({ queries: sent, replyBytes: 0 })
    } else {
      expect(result.criterionBranch).toBeUndefined()
      expect(result.response).toBe(raw)
    }
  })

  // One nonempty allocation reply must veto review even when the subsequent placement capture is empty.
  test("native graphics does not review mixed nonempty and empty matched captures", () => {
    const { result, sent } = run(
      "extensions.kitty-graphics.display",
      "17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3",
      (sequence) => {
        if (!sequence.startsWith("\x1b_Ga=t,")) return ""
        const number = /,I=(\d+);/.exec(sequence)?.[1]
        expect(number).toBeDefined()
        return `\x1b_GI=${number},i=91;OK\x1b\\`
      },
    )
    expect(sent).toHaveLength(2)
    expect(result.criterionBranch).toBeUndefined()
    expect(result.response).toBe("")
    expect(result.tests).toEqual([expect.objectContaining({ id: "criterion", status: "probe-invalid" })])
  })

  // #31369, @cto fb6cfc2f: named current-native source limitations must reach the production callback.
  // The generic audit cases iterate only present entries, so they cannot catch a missing approved cell.
  test.each([
    ["cursor.position-report", false],
    ["device.decrpm", false],
    ["device.decrqss", false],
    ["device.dsr-996-color-scheme", false],
    ["device.primary-da", false],
    ["device.secondary-da", false],
    ["device.status-report", false],
    ["device.tertiary-da", false],
    ["device.xtgettcap", false],
    ["device.xtreportcolors", true],
    ["device.xtversion", false],
    ["device.xtwinops-14", false],
    ["device.xtwinops-16", false],
    ["device.xtwinops-18", false],
    ["device.xtwinops-20", true],
    ["device.xtwinops-21", false],
    ["editing.decrqcra", true],
    ["extensions.osc10-fg-color", false],
    ["extensions.osc11-bg-color", false],
    ["extensions.osc12-cursor-color", false],
    ["extensions.osc17-highlight-bg", false],
    ["extensions.osc19-highlight-fg", false],
    ["extensions.osc4-palette", false],
    ["extensions.osc5-special-color", false],
    ["extensions.sixel-da1", false],
    ["extensions.osc52-clipboard", false],
    ["extensions.osc52-read", false],
    ["extensions.osc52-write", false],
    ["extensions.osc5522-clipboard", false],
    ["extensions.osc0-icon-title", true],
  ] as const)("current native zero-byte reply stays PROBE TODO: %s", (id, _osc0) => {
    const { result } = run(id, "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e", () => "")
    // No source answer decides the cell (@cto 9fad23d7): the silent reply has no same-path control in this run.
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
    expect(result.criterionBranch).toBeUndefined()
    expect(result.observation).toBeUndefined()
  })

  // @cto fb6cfc2f: these source-negative decisions must still be reached when the current native
  // observer returns no colour replies. A seeded-only fixture would hide the actual early-return path.
  test.each([
    ["extensions.osc30001-color-stack-push", "\x1b]30001\x1b\\"],
    ["extensions.osc30101-color-stack-pop", "\x1b]30101\x1b\\"],
  ] as const)(
    "native stack attempt keeps its colour-readback review when colour controls are missing: %s",
    (id, query) => {
      for (const sha of [
        "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e",
        "9a9505600721226b952ae9ac92552b42389aa6713872a9f4904528f425b7ecdf",
      ]) {
        const { result, sent } = run(id, sha, () => "")
        expect(sent).toContain(query)
        // No source rejection decides the stack (#32246): the measured early colour-readback review stands.
        expect(result).toMatchObject({
          criterionBranch: "color-readback-review",
          tests: [{ id: "review", status: "probe-todo" }],
        })
        expect(result.observation).toBeUndefined()
      }
    },
  )

  // @failure OSC0 dropped per-query outcomes and left DA-only captures to the generic writer failure.
  // @level l0 @consumer Both registered OSC0 callbacks; producer evidence is covered by execution-results.
  // Real DA-only bytes from the current seven-engine capture reproduce the missing-target branch.
  test.each([
    ["lib", "sentinel"],
    ["term", "sentinel"],
    ["lib", "timeout"],
    ["term", "timeout"],
  ] as const)("OSC 0 names both missing targets and their distinct outcomes: %s/%s", async (route, titleReason) => {
    const outcome = (sequence: string): TerminalQueryOutcome => ({
      match: null,
      reason: sequence === "\x1b[20t" ? "sentinel" : titleReason,
      raw: sequence === "\x1b[20t" || titleReason === "sentinel" ? "\x1b[?1;2c" : "",
      rawBase64:
        sequence === "\x1b[20t" || titleReason === "sentinel" ? Buffer.from("\x1b[?1;2c").toString("base64") : "",
    })
    const definition = probe("extensions.osc0-icon-title")
    const result =
      route === "lib"
        ? definition.lib!(context({ queryWithSentinelOutcome: outcome }))
        : await definition.term!(terminalSource({ queryWithSentinelOutcome: async (sequence) => outcome(sequence) }))
    expect(result).toMatchObject({
      tests: [
        {
          id: "criterion",
          status: "probe-invalid",
          reason: expect.stringContaining("icon label (CSI 20 t): sentinel"),
        },
      ],
      replyFailureTestIds: ["criterion"],
    })
    expect(result.tests?.[0].reason).toContain(`window title (CSI 21 t): ${titleReason}`)
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  })

  test.each(["lib", "term"] as const)(
    "OSC 0 names only the missing target after the other replied: %s",
    async (route) => {
      const outcome = (sequence: string): TerminalQueryOutcome => ({
        match: sequence === "\x1b[20t" ? ["\x1b]Losc0-icon-title\x07", "osc0-icon-title"] : null,
        reason: sequence === "\x1b[20t" ? "reply" : "sentinel",
        raw: sequence === "\x1b[20t" ? "\x1b]Losc0-icon-title\x07" : "\x1b[?1;2c",
        rawBase64: "",
      })
      const definition = probe("extensions.osc0-icon-title")
      const result =
        route === "lib"
          ? definition.lib!(context({ queryWithSentinelOutcome: outcome }))
          : await definition.term!(terminalSource({ queryWithSentinelOutcome: async (sequence) => outcome(sequence) }))
      expect(result).toMatchObject({
        tests: [{ status: "probe-invalid", reason: expect.stringContaining("window title (CSI 21 t): sentinel") }],
      })
      expect(result.tests?.[0].reason).not.toContain("icon label (CSI 20 t):")
      expect(JSON.parse(result.response!)).toMatchObject({ iconLabel: "osc0-icon-title", windowTitle: null })
    },
  )

  test("OSC 0 without a query outcome names the synchronous capture boundary", () => {
    const result = probe("extensions.osc0-icon-title").lib!(context({ feedCapture: () => "\x1b[?1;2c" }))
    expect(result).toMatchObject({
      tests: [
        { status: "probe-invalid", reason: expect.stringContaining("icon label (CSI 20 t): feedCapture boundary") },
      ],
    })
    expect(result.tests?.[0].reason).toContain("window title (CSI 21 t): feedCapture boundary")
    expect(result.tests?.[0].reason).not.toContain("timeout")
  })

  test("native OSC 0 keeps the answered title arm measured and names the missing icon arm", () => {
    const sha = "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e"
    const answerTitle = (q: string) => (q === "\x1b[21t" ? "\x1b]losc0-icon-title\x07" : "")
    const { result } = run("extensions.osc0-icon-title", sha, answerTitle)
    // One arm replied, so the capture is not silent and no source answer replaces it (#32246).
    expect(result.notTested).toBeUndefined()
    expect(result.observation).toBeUndefined()
    expect(result.tests?.[0]?.reason).toContain("icon label (CSI 20 t)")
    expect(JSON.parse(result.response!)).toMatchObject({ windowTitle: "osc0-icon-title", iconLabel: null })
    expect(result).toEqual(run("extensions.osc0-icon-title", "f".repeat(64), answerTitle).result)
    const answerIcon = (q: string) => (q === "\x1b[20t" ? "\x1b]Losc0-icon-title\x07" : "")
    expect(run("extensions.osc0-icon-title", sha, answerIcon).result).toEqual(
      run("extensions.osc0-icon-title", "f".repeat(64), answerIcon).result,
    )
  })

  // @cto 52d43147: an unlisted artifact must keep the complete pre-attempt early result,
  // not acquire a source-negative grade merely because the probe now records its own attempt.
  test("a native stack attempt preserves the early review except for its trace entry", () => {
    const id = "extensions.osc30001-color-stack-push"
    const query = "\x1b]10;?\x07"
    const stackQuery = "\x1b]30001\x1b\\"
    const missing =
      "OSC 10 initial and seeded foreground queries answered nothing, so the colour-stack effect has no readback"
    const early = {
      pass: false,
      response: JSON.stringify({
        query,
        originalRaw: "",
        trace: [
          { write: query, response: "" },
          { write: "\x1b]10;rgb:aa/bb/cc\x07", response: "" },
          { write: query, response: "" },
          { write: "\x1b]110\x07", response: "" },
          { write: query, response: "" },
        ],
      }),
      note: missing,
      notTested: { reason: "no-semantic-observable", noObservable: missing },
      criterionBranch: "color-readback-review",
      tests: [
        {
          id: "review",
          status: "probe-todo",
          reason: `${missing}, so this run cannot decide it`,
        },
      ],
    }
    const { result } = run(id, "f".repeat(64), () => "")
    // The native artifact records the empty colour reply it observed; the criterion is the early review (#32246).
    const { hostRecipeCauses, ...criterion } = result
    expect(hostRecipeCauses).toEqual([
      { recipe: "color-request", cause: { kind: "observed", missing: "foreground-rgb", query } },
    ])
    const raw = JSON.parse(criterion.response!) as { query: string; originalRaw: string; trace: unknown[] }
    expect(raw.trace.pop()).toEqual({ write: stackQuery, response: "" })
    expect({ ...criterion, response: JSON.stringify(raw) }).toEqual(early)
    // No artifact is listed any more: the formerly audited binary reads exactly as any other.
    const listed = run(id, "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e", () => "").result
    expect(listed).toEqual(result)
  })

  test("a failed native stack attempt retains the early readback review and its trace error", () => {
    const query = "\x1b]30001\x1b\\"
    const { result } = run(
      "extensions.osc30001-color-stack-push",
      "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e",
      (sequence) => {
        if (sequence === query) throw new Error("stack attempt failed")
        return ""
      },
    )
    expect(result).toMatchObject({
      criterionBranch: "color-readback-review",
      tests: [{ id: "review", status: "probe-todo" }],
    })
    expect(result.observation).toBeUndefined()
    const raw = JSON.parse(result.response!) as { trace: unknown[] }
    expect(raw.trace.at(-1)).toEqual({ write: query, error: "Error: stack attempt failed" })
  })

  function writeWithClipboard(
    state: {
      writes: { selector: string; payload: string; text?: string; decodeError?: string }[]
      pasteSelector?: string
    },
    runtimeIdentity?: LibProbeSource["runtimeIdentity"],
  ) {
    const fedPayloads: string[] = []
    return probe("extensions.osc52-write").lib!({
      kind: "live",
      cols: 80,
      runtimeIdentity,
      feed(text: string) {
        const payload = /\x1b\]52;c;([A-Za-z0-9+/=]*)/.exec(text)?.[1]
        if (payload !== undefined) fedPayloads.push(payload)
      },
      feedCapture: () => "",
      getCell: () => {
        throw new Error("unused")
      },
      getClipboardState: () => {
        const [controlPayload, targetPayload] = fedPayloads
        return {
          ...state,
          writes: [
            ...(controlPayload === undefined ? [] : [{ selector: "c", payload: controlPayload }]),
            ...(targetPayload === undefined
              ? []
              : state.writes.map((write) => (write.payload === "" ? { ...write, payload: targetPayload } : write))),
          ],
        }
      },
    } as unknown as LibProbeSource)
  }

  test("osc52-write passes when the engine callback retained the encoded nonce", () => {
    const result = writeWithClipboard({
      writes: [{ selector: "c", payload: "", text: "decoded-note" }],
      pasteSelector: "c",
    })
    const expected = result.assertions?.[0]?.expected
    expect(result.observation?.outcome).toBe("supported")
    expect(result.assertions?.[0]).toMatchObject({
      assertionType: "query_reply",
      kind: "positive",
      observed: expected,
    })
    expect(JSON.parse(expected ?? "")).toMatchObject({ selector: "c" })
    expect(result.response).toBe(expected)
    expect(result.note).toContain("engine copy_to_clipboard callback read via getClipboardState, no reply bytes")
    expect(result.note).toContain("decoded-note")
  })

  test("osc52-write retains disagreement when no target writes follow the recorded control", () => {
    const native: LibProbeSource["runtimeIdentity"] = {
      kind: "native",
      engineVersion: "1.0",
      adapterVersion: "1.0",
      termlessRevision: "fixture",
      loadedBinary: { path: "fixture.node", sha256: "fixture" },
      provenance: {
        sha256: "fixture",
        sourceCommit: "fixture",
        buildHash: "fixture",
        toolchain: "fixture",
        lockSha256: "fixture",
      },
    }
    // The native host-input wrapper must preserve the observed disagreement, not replace it with no-control.
    for (const identity of [undefined, native]) {
      const result = writeWithClipboard({ writes: [] }, identity)
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.notTested).toEqual({
        reason: "no-semantic-observable",
        noObservable: "control OSC 52 c write recorded but the probe write was not; same-run observations disagree",
      })
      expect(JSON.parse(result.response ?? "")).toMatchObject({ writes: [] })
    }
  })

  test("osc52-write is inconclusive when the engine callback retained a different target write after the control", () => {
    const result = writeWithClipboard({ writes: [{ selector: "p", payload: "cHJpbWFyeQ==" }] })
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.assertions).toBeUndefined()
    expect(JSON.parse(result.response ?? "")).toEqual({ writes: [{ selector: "p", payload: "cHJpbWFyeQ==" }] })
    expect(result.note).toContain("p")
  })
})

describe("initial colour context review", () => {
  test.each([
    ["extensions.osc17-highlight-bg", "17"],
    ["extensions.osc19-highlight-fg", "19"],
  ])("keeps the unreviewed highlight query %s unchanged", (id, slot) => {
    const seen: string[] = []
    const result = probe(id).lib!(
      context({
        feedCapture(sequence) {
          seen.push(sequence)
          return ""
        },
      }),
    )
    expect(seen).toEqual([`\x1b]${slot};?\x07`])
    expect(result).toMatchObject({ pass: false, response: "", tests: [{ id: "criterion", status: "probe-invalid" }] })
    expect(result.criterionBranch).toBeUndefined()
  })

  const cases = [
    ["extensions.osc10-fg-color", "10", "110"],
    ["extensions.osc11-bg-color", "11", "111"],
    ["extensions.osc12-cursor-color", "12", "112"],
    ["extensions.osc4-palette", "4;0", "104;0"],
  ] as const

  const resetIds = {
    "110": "extensions.osc110-reset-fg",
    "111": "extensions.osc111-reset-bg",
    "112": "extensions.osc112-reset-cursor",
    "104;0": "extensions.osc104-reset-palette",
  }
  for (const [id, slot, resetCode] of cases) {
    const query = `\x1b]${slot};?\x07`
    const setter = `\x1b]${slot};rgb:aa/bb/cc\x07`
    const reset = `\x1b]${resetCode}\x07`
    const seeded = `\x1b]${slot};rgb:aaaa/bbbb/cccc\x1b\\`
    const callback = probe(id).lib
    if (!callback) throw new Error(`missing library callback ${id}`)
    const writes = [query, setter, query, reset, query]

    // C1: a qualified DA1 channel cannot establish an embedder-owned default value.
    // Existing positive-control cases omit the sentinel member and miss its early negative.
    test(`${slot}: qualified silence verifies a seed before initial/default review`, () => {
      for (const run of [callback, probe(resetIds[resetCode]).lib!]) {
        const seen: string[] = []
        let current = ""
        const result = run(
          context({
            queryWithSentinelOutcome(sequence) {
              expect(sequence).toBe(query)
              return {
                match: null,
                reason: "sentinel",
                raw: "\x1b[?1;2c",
                rawBase64: "G1s/MTsyYw==",
                sentinel: { atMs: 0, graceMs: 250 },
              }
            },
            feedCapture(sequence) {
              seen.push(sequence)
              if (sequence === setter) current = seeded
              if (sequence === reset) current = ""
              return sequence === query ? current : ""
            },
          }),
        )
        expect(result.criterionBranch).toBe("color-readback-review")
        expect(result.observation).toBeUndefined()
        expect(result.tests).toMatchObject([{ id: "review", status: "probe-todo" }])
        expect(seen).toEqual([setter, query, reset, query])
      }
    })

    test(`${slot}: a reset that leaves the verified seed is a measured negative`, () => {
      let current = ""
      const result = probe(resetIds[resetCode]).lib!(
        context({
          feedCapture(sequence) {
            if (sequence === setter) current = seeded
            return sequence === query ? current : ""
          },
        }),
      )
      expect(result).toMatchObject({
        observation: { outcome: "unsupported", assertionType: "query_reply" },
        assertions: [{ kind: "negative" }],
      })
      expect(result.criterionBranch).toBeUndefined()
    })

    test(`${slot}: missing initial value selects required review after a disposable positive control`, () => {
      for (const reply of [seeded, `\x1b]${slot};rgb:a/b/c\x07`]) {
        const replies = ["", "", reply, "", ""]
        const seen: string[] = []
        const result = callback(
          context({
            feedCapture(sequence) {
              expect(sequence).toBe(writes[seen.length])
              seen.push(sequence)
              return replies[seen.length - 1]!
            },
          }),
        )
        expect(seen).toEqual(writes)
        expect(result).toMatchObject({
          pass: false,
          criterionBranch: "color-readback-review",
          notTested: { noObservable: expect.stringContaining(`OSC ${slot}`) },
          tests: [{ id: "review", status: "probe-todo" }],
        })
        expect(result.notTested?.noObservable).toContain("embedder-owned")
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(JSON.parse(result.response!)).toEqual({
          query,
          initialRaw: "",
          controls: writes.slice(1).map((write, index) => ({ write, response: replies[index + 1] })),
        })
      }
    })

    test(`${slot}: failed controls retain criterion failure and all attempted bytes`, () => {
      const invalid = [
        ["", "", "", "", ""],
        ["", "", `\x1b]${slot};rgb:00/00/00\x07`, "", ""],
        ["", "", "\x1b]999;rgb:aa/bb/cc\x07", "", ""],
        ["", "", `extra${seeded}`, "", ""],
        ["", "", `${seeded}${seeded}`, "", ""],
        ["", "ack", seeded, "", ""],
        ["", "", seeded, "ack", ""],
        ["", "", seeded, "", seeded],
      ]
      for (const replies of invalid) {
        const seen: string[] = []
        const result = callback(
          context({
            feedCapture(sequence) {
              expect(sequence).toBe(writes[seen.length])
              seen.push(sequence)
              return replies[seen.length - 1]!
            },
          }),
        )
        expect(seen).toEqual(writes)
        expect(result).toMatchObject({ pass: false, tests: [{ id: "criterion", status: "probe-invalid" }] })
        expect(result.criterionBranch).toBeUndefined()
        expect(result.notTested).toBeUndefined()
        expect(JSON.parse(result.response!)).toMatchObject({
          controls: writes.slice(1).map((write, index) => ({ write, response: replies[index + 1] })),
        })
      }
    })

    test(`${slot}: nonempty initial replies and sentinel reads issue no setter`, () => {
      for (const raw of [seeded, `\x1b]${slot};broken\x07`]) {
        let count = 0
        const result = callback(
          context({
            feedCapture(sequence) {
              expect(sequence).toBe(query)
              expect(++count).toBe(1)
              return raw
            },
          }),
        )
        expect(result.response).toBe(raw)
        expect(result.pass).toBe(raw === seeded)
        expect(result.criterionBranch).toBeUndefined()
      }
      const result = callback(
        context({
          feedCapture() {
            throw new Error("sentinel source must not mutate colours")
          },
          queryWithSentinelOutcome(sequence) {
            expect(sequence).toBe(query)
            return { match: null, reason: "timeout", raw: "", rawBase64: "" }
          },
        }),
      )
      expect(result).toMatchObject({ pass: false, response: "", tests: [{ status: "probe-invalid" }] })
    })

    // C5: an observable original still needs cleanup if the setter mutates then throws.
    test(`${slot}: reset cleanup preserves an observed-original setter error`, () => {
      for (const cleanupFails of [false, true]) {
        const seen: string[] = []
        expect(() =>
          probe(resetIds[resetCode]).lib!(
            context({
              feedCapture: () => seeded,
              feed(sequence) {
                seen.push(sequence)
                if (sequence !== reset) throw new Error("original setter failed")
                if (cleanupFails) throw new Error("reset also failed")
              },
            }),
          ),
        ).toThrow("original setter failed")
        expect(seen).toHaveLength(2)
        expect(seen.at(-1)).toBe(reset)
      }
    })

    test(`${slot}: setter or control-read errors still attempt reset and propagate`, () => {
      for (const failAt of [1, 2]) {
        for (const cleanupFails of [false, true]) {
          const seen: string[] = []
          const failure = new Error("control read failed")
          const cleanup = new Error("reset cleanup failed")
          expect(() =>
            callback(
              context({
                feedCapture(sequence) {
                  const index = seen.length
                  seen.push(sequence)
                  if (cleanupFails && sequence === reset) throw cleanup
                  if (index === failAt) throw failure
                  return ""
                },
              }),
            ),
          ).toThrow(failure.message)
          expect(seen).toEqual([...writes.slice(0, failAt + 1), reset])
        }
      }
    })
  }
})

/**
 * @failure A color-register count, protocol failure, or DA1 responsiveness was reported as Sixel geometry.
 * @level l0
 * @consumer XTSMGRAPHICS item-2 callbacks in headless and real-terminal collectors.
 * @testonly none
 */
describe("Sixel geometry item-2 report", () => {
  const query = "\x1b[?2;1;0S"
  const geometry = probe("extensions.sixel-geometry-report")
  if (!geometry.lib || !geometry.term) throw new Error("Sixel geometry requires both callbacks")
  const headless = geometry.lib
  const terminal = geometry.term

  function fromHeadless(raw: string) {
    return headless(
      context({
        feedCapture(sequence) {
          expect(sequence).toBe(query)
          return raw
        },
      }),
    )
  }

  async function fromTerminal(raw: string, sentinelFirst = false) {
    return terminal(
      terminalSource({
        queryWithSentinelOutcome: async (sequence, pattern) => {
          expect(sequence).toBe(query)
          const match = sentinelFirst ? null : raw.match(pattern)
          return { match, reason: match ? "reply" : "sentinel", raw, rawBase64: Buffer.from(raw).toString("base64") }
        },
        queryCursorPosition: async () => {
          throw new Error("CPR cannot establish Sixel geometry")
        },
      }),
    )
  }

  test("binds a status-0 width and height reply as the exact query result", async () => {
    const raw = "\x1b[?2;0;640;480S"
    for (const result of [fromHeadless(raw), await fromTerminal(raw)]) {
      expect(result).toMatchObject({ pass: true, response: raw })
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions?.[0]).toMatchObject({ kind: "positive", observed: raw })
    }
    expect(geometry.termWrites).toBe("query")
  })

  test("a valid-looking frame after the DA1 sentinel cannot be promoted from raw bytes", async () => {
    const raw = "\x1b[?62;52;c\x1b[?2;0;640;480S"
    const result = await fromTerminal(raw, true)
    expect(result).toMatchObject({ pass: false, response: raw })
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "invalid-reply",
      assertionType: "query_reply",
    })
    expect(result.assertions).toBeUndefined()
  })

  test("a geometry frame before DA1 supports while preserving the full raw trace", async () => {
    const frame = "\x1b[?2;0;640;480S"
    const raw = `${frame}\x1b[?62;52;c`
    const result = await fromTerminal(raw)
    expect(result).toMatchObject({ pass: true, response: raw })
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "positive", observed: frame })
  })

  test("invalid Sixel replies retain query observations while silence records a named execution failure", async () => {
    for (const [raw, reason] of [
      ["\x1b[?2;3;0S", "insufficient-evidence"],
      ["\x1b[?1;0;256S", "invalid-reply"],
      ["\x1b[?2;0;640S", "invalid-reply"],
      ["\x1b[?2;0;0;480S", "insufficient-evidence"],
      ["", "no-response"],
    ] as const) {
      for (const result of [fromHeadless(raw), await fromTerminal(raw)]) {
        expect(result).toMatchObject({ pass: false, response: raw })
        if (raw === "") {
          expect(result.observation).toBeUndefined()
          expect(result.tests).toMatchObject([
            expect.objectContaining({ status: "probe-invalid", reason: "No Sixel geometry response for item 2" }),
          ])
        } else {
          expect(result.observation).toMatchObject({ outcome: "inconclusive", reason, assertionType: "query_reply" })
        }
        expect(result.assertions).toBeUndefined()
      }
    }
  })
})

/**
 * @failure OSC 8 consumption or a capability flag was mistaken for linked-cell metadata.
 * @level l0
 * @consumer Unified headless and application OSC 8 observation.
 * @testonly none
 */
describe("OSC 8 link metadata observation", () => {
  const uri = "https://example.com/osc8-proof"
  const positions = [null, uri, uri, uri, uri, null] as const

  function linkedSource(links: readonly (string | null | undefined)[], declared = true): LibProbeSource {
    const base = context({})
    return Object.assign(
      context({
        capabilities: {
          ...base.capabilities,
          osc8Hyperlinks: true,
          extensions: new Set(declared ? ["hyperlinks"] : []),
        },
        getCell(_row, col) {
          const link = links[col]
          return {
            ...base.getCell(0, col),
            char: "ALINKZ"[col] ?? "",
            ...(link !== undefined && { hyperlink: link }),
          }
        },
      }),
      declared ? { getHyperlinkAt: (_row: number, col: number) => links[col] } : {},
    )
  }

  test("four exact URI cells bracketed by unlinked controls establish support", () => {
    const p = probe("extensions.osc8")
    if (!p.lib) throw new Error("OSC 8 needs headless callback")
    const result = p.lib(linkedSource(positions))
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "positive" })
    // The headless batch admits parser-state conclusions only when the exact
    // assertion observation is the immutable raw response for this feature.
    expect(result.assertions?.[0]?.observed).toBe(result.response)
  })

  test("wrong URI or link leaking past close is unsupported with measured mismatch", () => {
    const p = probe("extensions.osc8")
    if (!p.lib) throw new Error("OSC 8 needs headless callback")
    for (const links of [
      [null, uri, "https://wrong.example", uri, uri, null],
      [null, uri, uri, uri, uri, uri],
    ]) {
      const result = p.lib(linkedSource(links))
      expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
      expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
      expect(result.assertions?.[0]?.observed).toBe(result.response)
      expect(result.criterionBranch).toBeUndefined()
    }
  })

  test("absent URI observer retains named coverage, but an invalid declared observer is an error", () => {
    const p = probe("extensions.osc8")
    if (!p.lib) throw new Error("OSC 8 needs headless callback")
    const identities: LibProbeSource["runtimeIdentity"][] = [
      undefined,
      {
        kind: "js",
        runtimeFormat: "js",
        engineVersion: "1.0",
        adapterVersion: "4.0",
        termlessRevision: "source-revision",
        resolvedPath: "packages/example/src/backend.ts",
        integrity: { kind: "registry", lockIntegrity: "sha512-example" },
      },
      {
        kind: "native",
        engineVersion: "1.0",
        adapterVersion: "4.0",
        termlessRevision: "source-revision",
        loadedBinary: { path: "packages/example/native/example.node", sha256: "binary-digest" },
        provenance: {
          sha256: "binary-digest",
          sourceCommit: "native-source",
          buildHash: "build",
          toolchain: "toolchain",
          lockSha256: "lock",
        },
      },
    ]
    for (const runtimeIdentity of identities) {
      const unreported = p.lib({ ...linkedSource(Array(6).fill(undefined), false), runtimeIdentity })
      expect(unreported.observation).toBeUndefined()
      expect(unreported.notTested).toMatchObject({
        reason: "no-semantic-observable",
        noObservable: expect.stringContaining("OSC 8 URI observer"),
      })
      expect(unreported.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
      expect(unreported.tests).toEqual([
        { id: "review", status: "probe-todo", reason: `${unreported.note}, so this run cannot decide it` },
      ])
      expect(unreported.assertions).toBeUndefined()
      expect(JSON.parse(unreported.response ?? "")).toEqual({
        chars: [..."ALINKZ"],
        links: Array(6).fill({ reported: false }),
      })
      expect(unreported.note).toContain(
        runtimeIdentity
          ? `Engine ${runtimeIdentity.engineVersion}, adapter ${runtimeIdentity.adapterVersion}`
          : "runtime identity unavailable",
      )
      if (runtimeIdentity) {
        expect(unreported.note).not.toContain(runtimeIdentity.termlessRevision)
        expect(unreported.note).not.toContain(
          runtimeIdentity.kind === "js" ? runtimeIdentity.resolvedPath : runtimeIdentity.loadedBinary.path,
        )
      }
    }
    // Coverage still requires its text fixture; broken rendering is an attempted failed check.
    const brokenFixture = linkedSource(Array(6).fill(undefined), false)
    brokenFixture.getCell = () => ({ ...context({}).getCell(0, 0), char: "?" })
    const malformed = p.lib(brokenFixture)
    expect(malformed.criterionBranch).toBeUndefined()
    expect(malformed.assertions).toBeUndefined()
    expect(() => p.lib?.(linkedSource(Array(6).fill(undefined), true))).toThrow(/declares OSC 8 metadata/i)
    const missingGetter = linkedSource(positions)
    delete missingGetter.getHyperlinkAt
    expect(() => p.lib?.(missingGetter)).toThrow(/declares OSC 8 metadata/i)
  })

  // AC3: the published feature flag does not declare metadata exposure.
  test("a true feature flag with no metadata extension stays unreported", () => {
    const p = probe("extensions.osc8")
    if (!p.lib) throw new Error("OSC 8 needs headless callback")
    const result = p.lib(linkedSource(Array(6).fill(null), false))
    expect(result.observation).toBeUndefined()
    expect(result.notTested?.noObservable).toContain("OSC 8 URI observer")
    expect(JSON.parse(result.response ?? "")).toMatchObject({ links: Array(6).fill({ reported: false }) })
  })

  // Adapter bytes are re-pinned; artifact tuples come from #31385, not a loaded-engine attestation.
  const absentOsc8Runtimes = [
    ...(["vt100", "vt220"] as const).map(
      (engine) =>
        [
          engine,
          {
            kind: "js",
            runtimeFormat: "js",
            engineVersion: "0.10.1",
            adapterSources:
              engine === "vt100"
                ? [
                    { path: "packages/vt100/src/index.ts", blobOid: "99833d737402f9d1d8e3e257e3a255d8aa1facc3" },
                    { path: "packages/vt100/src/backend.ts", blobOid: "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a" },
                  ]
                : [
                    { path: "packages/vt220/src/index.ts", blobOid: "601dd26eb7e753a5396ebdf72f1ef8ee2cc4355f" },
                    { path: "packages/vt220/src/backend.ts", blobOid: "7369e3710e36aa649372fd09011ecfdd6ba47c73" },
                  ],
            adapterVersion: "0.10.2",
            termlessRevision:
              engine === "vt220"
                ? "a871f0e580e1b02fb5dbb7ed854f6de623e7858e"
                : "8b8664540f365fa0ba1d9b6400d3c4d1a160582c",
            resolvedPath: `vendor/vterm/packages/${engine}/src/index.ts`,
            integrity: {
              kind: "source",
              repository: "git@github.com:beorn/vterm.git",
              revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
              treeOid:
                engine === "vt100"
                  ? "b941dae48b25ae8825c394750bda5245c9d93dfa"
                  : "4205f8936ad1848d1029729f3ada888cd61759a8",
              cleanTree: true,
            },
          },
        ] as const,
    ),
    [
      "libvterm",
      {
        kind: "js",
        runtimeFormat: "wasm",
        engineVersion: "0.3.3",
        adapterSources: [
          { path: "packages/libvterm/src/index.ts", blobOid: "2b4708b1081e701b99893ca055ded781dc46cf25" },
          { path: "packages/libvterm/src/backend.ts", blobOid: "eb513ccd443e30c7a869a8ba41f8126e1c0ddf00" },
          { path: "packages/libvterm/src/wasm-bindings.ts", blobOid: "2bbd4d5cf59b8d53db8f5c0329d2ed7853c43e45" },
          { path: "packages/libvterm/wasm/libvterm.js", blobOid: "1e784be87614ab924b96844009919b7c21ce150e" },
        ],
        adapterVersion: "0.10.2",
        termlessRevision: "f8d2aeb7a7a30f0215fd628bbbb1f1e5cd0a91be",
        resolvedPath: "vendor/termless/packages/libvterm/src/index.ts",
        integrity: {
          kind: "source",
          repository: "git@github.com:beorn/termless.git",
          revision: "f8d2aeb7a7a30f0215fd628bbbb1f1e5cd0a91be",
          treeOid: "ae0b11bb808b8c402c168869d7caa5a5f62566c2",
          cleanTree: true,
        },
        loadedBinary: {
          path: "vendor/termless/packages/libvterm/wasm/libvterm.wasm",
          sha256: "3d67045bb43c5e4081c70dc58088af8f735416c20df2d7843d765e5aad8ef62a",
        },
      },
    ],
    [
      "vt100-rust",
      {
        kind: "native",
        engineVersion: "0.16.2",
        adapterSources: [
          { path: "packages/vt100-rust/src/index.ts", blobOid: "3ddb74f3ae1f79bb356952103853232f69211268" },
          { path: "packages/vt100-rust/src/backend.ts", blobOid: "9b3477c0fedf8586430781e8f4d17019569af98b" },
        ],
        adapterVersion: "0.10.2",
        termlessRevision: "2d97417328b7b1d086f9396b9a1731216ed134cc",
        loadedBinary: {
          path: "vendor/termless/packages/vt100-rust/termless-vt100-rust.node",
          sha256: "84a5b6a3a40a7c16c6bae8b64534b730403df911498bb34bded68c3a17e2d408",
        },
        provenance: {
          sha256: "84a5b6a3a40a7c16c6bae8b64534b730403df911498bb34bded68c3a17e2d408",
          sourceCommit: "286fddf6632e43ccd62f9050be41ec7b2908e43e",
          buildHash: "30b232d295488042b0d6164e881e319dea8d7fae06ac766b3b568fd4832bf074",
          toolchain:
            "rustc 1.94.0 (4a4ef493e 2026-03-02) (built from a source tarball); cargo 1.94.0 (85eff7c80 2026-01-15)",
          lockSha256: "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6",
        },
      },
    ],
  ] as const satisfies readonly (readonly [string, NonNullable<LibProbeSource["runtimeIdentity"]>])[]

  // #31398: explicit callback checks catch omitted memberships; existing OSC8 cases never run highlight resets or OSC1.
  // #32246: the formerly audited identity no longer selects a source review; it reads exactly as any other identity.
  test.each(absentOsc8Runtimes)(
    "%s grades neither absent highlight reset from source at the formerly audited identity",
    (_engine, identity) => {
      for (const [id] of [
        ["extensions.osc117-reset-highlight-bg", 17, 117],
        ["extensions.osc119-reset-highlight-fg", 19, 119],
      ] as const) {
        const writes: string[] = []
        const source = context({
          runtimeIdentity: identity,
          feed: (bytes) => writes.push(bytes),
          getCell: () => ({ ...context({}).getCell(0, 0), char: "X" }),
        })
        const result = probe(id).lib!(source)
        expect(result.criterionBranch, id).toBeUndefined()
        expect(result.observation, id).toBeUndefined()
        expect(result.assertions, id).toBeUndefined()
        // The X-control write belonged to the deleted source review; the reset callback no longer feeds it.
        expect(writes, id).toEqual([])
        expect(
          probe(id).lib!({ ...source, runtimeIdentity: { ...identity, engineVersion: "unreviewed" } }),
          id,
        ).toEqual(result)
        expect(probe(id).lib!({ ...source, getCell: () => context({}).getCell(0, 0) }).assertions, id).toBeUndefined()
      }
    },
  )

  test.each(absentOsc8Runtimes)(
    "%s records OSC1 without an icon getter as PROBE TODO coverage at every identity",
    (engine, identity) => {
      let title = "before"
      const writes: string[] = []
      const source = context({
        runtimeIdentity: identity,
        getTitle: () => title,
        feed: (bytes) => {
          writes.push(bytes)
          title = "after"
        },
      })
      const result = probe("extensions.osc1-icon").lib!(source)
      expect(writes).toEqual(["\x1b]1;test-icon\x07"])
      expect(JSON.parse(result.response!)).toEqual({ before: "before", after: "after" })
      // #32246: no source audit tells intrinsic absence from a missing getter any more; both stay PROBE TODO.
      expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
      expect(result.criterionBranch).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      const foreign = probe("extensions.osc1-icon").lib!({
        ...source,
        runtimeIdentity: { ...identity, engineVersion: "unreviewed" },
      })
      expect(foreign.notTested).toMatchObject({ reason: "no-semantic-observable" })
      expect(foreign.criterionBranch).toBeUndefined()
    },
  )

  test.each(absentOsc8Runtimes)(
    "%s emits no source-review assertion for OSC8 at the formerly audited identity",
    (_engine, identity) => {
      const p = probe("extensions.osc8")
      if (!p.lib) throw new Error("OSC 8 needs headless callback")
      const unreported = linkedSource(Array(6).fill(undefined), false)
      const result = p.lib({ ...unreported, runtimeIdentity: identity })
      // #32246: the unreported links read as the headless-observable review at every identity, never a source negative.
      expect(result.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
      expect(result.assertions).toBeUndefined()
      expect(JSON.parse(result.response ?? "")).toMatchObject({
        chars: [..."ALINKZ"],
        links: Array(6).fill({ reported: false }),
      })
      expect(JSON.parse(result.response ?? "")).not.toHaveProperty("runtimeIdentity")

      const foreignIdentities: NonNullable<LibProbeSource["runtimeIdentity"]>[] = [
        { ...identity, engineVersion: "unreviewed-version" },
        { ...identity, adapterSources: undefined },
        { ...identity, adapterSources: identity.adapterSources.slice(1) },
        {
          ...identity,
          adapterSources: identity.adapterSources.map((source) => ({ ...source, blobOid: "0".repeat(40) })),
        },
      ]
      const provenanceIdentities: NonNullable<LibProbeSource["runtimeIdentity"]>[] = [
        { ...identity, termlessRevision: "0".repeat(40) },
      ]
      if (identity.kind === "js" && identity.runtimeFormat === "js" && identity.integrity.kind === "source") {
        foreignIdentities.push(
          { ...identity, integrity: { ...identity.integrity, repository: "unreviewed-repository" } },
          { ...identity, integrity: { ...identity.integrity, treeOid: "0".repeat(40) } },
          { ...identity, integrity: { ...identity.integrity, cleanTree: false } },
        )
      }
      if (identity.kind === "js") {
        provenanceIdentities.push({ ...identity, resolvedPath: "relocated/entry.ts" })
        if (identity.integrity.kind === "source") {
          provenanceIdentities.push({ ...identity, integrity: { ...identity.integrity, revision: "0".repeat(40) } })
          if (identity.runtimeFormat === "wasm") {
            provenanceIdentities.push({
              ...identity,
              integrity: {
                ...identity.integrity,
                repository: "relocated-wrapper",
                treeOid: "0".repeat(40),
                cleanTree: false,
              },
            })
          }
        }
      }
      if ("loadedBinary" in identity) {
        foreignIdentities.push(
          { ...identity, adapterVersion: "unreviewed-version" },
          { ...identity, loadedBinary: { ...identity.loadedBinary, sha256: "0".repeat(64) } },
          {
            ...identity,
            loadedBinary: {
              ...identity.loadedBinary,
              sha256: "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96",
            },
          },
        )
        provenanceIdentities.push({ ...identity, loadedBinary: { ...identity.loadedBinary, path: "relocated/binary" } })
      }
      if (identity.kind === "native") {
        for (const key of ["sha256", "sourceCommit", "buildHash", "lockSha256"] as const) {
          foreignIdentities.push({ ...identity, provenance: { ...identity.provenance, [key]: "unreviewed" } })
        }
      }
      for (const runtimeIdentity of provenanceIdentities) {
        expect(p.lib({ ...unreported, runtimeIdentity })).toEqual(result)
      }
      for (const runtimeIdentity of foreignIdentities) {
        const foreign = p.lib({ ...unreported, runtimeIdentity })
        expect(foreign.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
        expect(foreign.assertions).toBeUndefined()
        expect(foreign.response).toBe(result.response)
      }
      const broken = p.lib({
        ...unreported,
        runtimeIdentity: identity,
        getCell: () => ({ ...context({}).getCell(0, 0), char: "?" }),
      })
      expect(broken.criterionBranch).toBeUndefined()
      expect(broken.assertions).toBeUndefined()
      const observed = p.lib({ ...linkedSource(positions), runtimeIdentity: identity })
      expect(observed.observation?.outcome).toBe("supported")
      expect(observed.criterionBranch).toBeUndefined()
    },
  )

  test("application CPR consumption remains inconclusive", async () => {
    const p = probe("extensions.osc8")
    if (!p.term) throw new Error("OSC 8 needs application callback")
    const result = await p.term(terminalSource({ queryCursorPosition: async () => ({ row: 1, col: 7 }) }))
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    expect(result.tests).toMatchObject([
      expect.objectContaining({
        status: "probe-todo",
        reason: "Cursor movement cannot verify OSC 8 link metadata or click behavior",
      }),
    ])
  })
})

/**
 * @failure A formerly audited GhosttyNative OSC target is graded from a source citation instead of PROBE TODO (#32246).
 * @level l0
 * @consumer Library OSC callbacks at the formerly audited GhosttyNative identity.
 * @testonly none
 */
describe("GhosttyNative OSC targets without a readback oracle", () => {
  const identity = {
    kind: "native",
    engineVersion: "1.3.1",
    adapterSources: [
      { path: "packages/ghostty-native/src/index.ts", blobOid: "35c9e35a5d60625ce1135b65ff38ae9278495a18" },
      { path: "packages/ghostty-native/src/backend.ts", blobOid: "427b9d4782a9924135ff0c32e2406b117df9cf22" },
    ],
    adapterVersion: "0.10.2",
    termlessRevision: "8bd0516ad101cc088133beb20fa9e92f86250da8",
    loadedBinary: {
      path: "vendor/termless/packages/ghostty-native/termless-ghostty-native.node",
      sha256: "53f9a867cce594b4d50fb9508db9ce5d2d79fb4244a418548b7cb31fa50780d1",
    },
    provenance: {
      sha256: "53f9a867cce594b4d50fb9508db9ce5d2d79fb4244a418548b7cb31fa50780d1",
      sourceCommit: "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28",
      buildHash: "2d5e53cf4f0846e47cda8a45c513f44da5c699657edffe93886e6eba99f36bfd",
      toolchain: "zig 0.15.2",
      lockSha256: "3ec775507556db01d08055836b26183f629a9cbb0b5802a1566661e95988d74a",
    },
  } as const satisfies NonNullable<LibProbeSource["runtimeIdentity"]>

  // #32246 (operator 2026-11-03, @cto 9fad23d7): this artifact's former source review no longer decides anything. With a
  // rendered X control and a silent command the callback records PROBE TODO coverage, never a source branch or assertion.
  test.each([
    "extensions.osc1-icon",
    "extensions.osc176-app-id",
    "extensions.osc440-audio",
    "extensions.osc555-flash",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
    "extensions.osc3008-context",
  ])("%s records PROBE TODO coverage, never a source review, on GhosttyNative", (id) => {
    const result = probe(id).lib!(
      context({ runtimeIdentity: identity, getCell: () => ({ ...context({}).getCell(0, 0), char: "X" }) }),
    )
    // A coverage record, or (for a consumed semantic marker) a criterion PROBE TODO: either way nothing is graded.
    if (result.notTested === undefined) {
      expect(result.tests).toEqual([expect.objectContaining({ id: "criterion", status: "probe-todo" })])
    } else expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
    expect(result.criterionBranch).toBeUndefined()
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  })

  test.each(["extensions.osc22-pointer", "extensions.osc777-notify", "extensions.osc9-progress"])(
    "%s stays PROBE TODO with no assertion",
    (id) => {
      const result = probe(id).lib!(
        context({
          runtimeIdentity: identity,
          getCell: () => ({ ...context({}).getCell(0, 0), char: "X" }),
        }),
      )
      expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
      expect(result.criterionBranch).toBeUndefined()
      expect(result.assertions).toBeUndefined()
    },
  )
})

/**
 * @failure A formerly audited Alacritty OSC code is graded from a source citation instead of PROBE TODO (#32246), or a
 *   direct query route loses its observation.
 * @level l0
 * @consumer Library OSC callbacks at the formerly audited Alacritty identity.
 * @testonly none
 */
describe("Alacritty OSC targets without a readback oracle", () => {
  // Current Cell.hidden readback build receipt (#31901); fixture identity is not a loaded-engine attestation.
  const identity = {
    kind: "native",
    engineVersion: "0.26.0",
    adapterSources: [
      { path: "packages/alacritty/src/index.ts", blobOid: "b4154cbd6ef4a83ce2cbf3dcf26ff13d645efd05" },
      { path: "packages/alacritty/src/backend.ts", blobOid: "27b78b1264cd5d2ed72705ba36c9735b29e874c5" },
      { path: "packages/alacritty/native/src/lib.rs", blobOid: "1779ff4f042f7f285ab3d396da039408b492be10" },
      { path: "src/load-native.ts", blobOid: "34e142550085450ab02138184626716ad0d6b546" },
    ],
    adapterVersion: "0.10.2",
    termlessRevision: "2f73fc28027b7d483e504e08edc64d1837935816",
    loadedBinary: {
      path: "vendor/termless/packages/alacritty/termless-alacritty-native.node",
      sha256: "9839e138d9e6f13e84adc3022f67964f0451e2e6416294952e22286412994f61",
    },
    provenance: {
      sha256: "9839e138d9e6f13e84adc3022f67964f0451e2e6416294952e22286412994f61",
      sourceCommit: "2f73fc28027b7d483e504e08edc64d1837935816",
      buildHash: "343c00e0db2bed851505ada4645b7b667ab78a0485a4ca71f9eaa4e5d8dead39",
      toolchain:
        "rustc 1.94.0 (4a4ef493e 2026-03-02) (built from a source tarball); cargo 1.94.0 (85eff7c80 2026-01-15)",
      lockSha256: "1f89f2579b7d786a116d8fefb8267c4af076bd3a3893adcf14b00c4466740497",
    },
  } as const satisfies NonNullable<LibProbeSource["runtimeIdentity"]>

  // #32246 (operator 2026-11-03, @cto 9fad23d7): this artifact's former source review no longer decides anything. With a
  // rendered X control and a silent command the callback records PROBE TODO coverage, never a source branch or assertion.
  test.each([
    "extensions.osc9-progress",
    "extensions.osc22-pointer",
    "extensions.osc176-app-id",
    "extensions.osc440-audio",
    "extensions.osc555-flash",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
    "extensions.osc777-notify",
    "extensions.osc3008-context",
    "extensions.osc117-reset-highlight-bg",
    "extensions.osc119-reset-highlight-fg",
  ])("%s records PROBE TODO coverage, never a source review, on Alacritty", (id) => {
    const result = probe(id).lib!(
      context({ runtimeIdentity: identity, getCell: () => ({ ...context({}).getCell(0, 0), char: "X" }) }),
    )
    // A coverage record, or (for a consumed semantic marker) a criterion PROBE TODO: either way nothing is graded.
    if (result.notTested === undefined) {
      expect(result.tests).toEqual([expect.objectContaining({ id: "criterion", status: "probe-todo" })])
    } else expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
    expect(result.criterionBranch).toBeUndefined()
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  })

  test.each([
    ["extensions.osc17-highlight-bg", 17],
    ["extensions.osc19-highlight-fg", 19],
  ] as const)("%s retains its direct query route", (id, code) => {
    const silent = probe(id).lib!(context({ runtimeIdentity: identity }))
    expect(silent.criterionBranch).not.toBe("source-negative-review")
    expect(silent.assertions).toBeUndefined()
    const result = probe(id).lib!(
      context({
        runtimeIdentity: identity,
        feedCapture: () => `\x1b]${code};rgb:aa/bb/cc\x07`,
      }),
    )
    expect(result.criterionBranch).not.toBe("source-negative-review")
    expect(result.observation?.assertionType).toBe("query_reply")
    expect(result.observation?.outcome).toBe("supported")
  })

  test.each(["extensions.osc8", "extensions.osc7-cwd", "extensions.osc1337-cellsize"])(
    "%s stays outside this source audit",
    (id) => {
      const result = probe(id).lib!(
        context({
          runtimeIdentity: identity,
          getCell: (col) => ({ ...context({}).getCell(0, 0), char: id === "extensions.osc8" ? "ALINKZ"[col]! : "X" }),
        }),
      )
      expect(result.criterionBranch).not.toBe("source-negative-review")
      expect(result.assertions).toBeUndefined()
    },
  )
})

/**
 * @failure A formerly audited Wezterm OSC target is graded from a source citation instead of PROBE TODO (#32246), or a
 *   measured route loses its observation.
 * @level l0
 * @consumer Registered OSC library callbacks; native tuple, D-only and viewport precedence coverage.
 * @testonly none
 */
describe("Wezterm OSC targets without a readback oracle", () => {
  // Current rebuilt WezTerm tuple fixture; this does not attest a loaded native engine.
  const identity = {
    kind: "native",
    engineVersion: "0.1.0-fork.5",
    adapterSources: [
      { path: "packages/wezterm/src/index.ts", blobOid: "512606c5270ffd0cff55c1b70f5b3eda18a92df0" },
      { path: "packages/wezterm/src/backend.ts", blobOid: "42a196995a5f8845ab2e3bb6227192556c470071" },
      { path: "packages/wezterm/native/src/lib.rs", blobOid: "445f5484027aebbea01a641a96dd92dfea273693" },
      { path: "src/load-native.ts", blobOid: "34e142550085450ab02138184626716ad0d6b546" },
    ],
    adapterVersion: "0.10.2",
    termlessRevision: "83b22ab3f99ff3c2f3e43bcfce346c1374f540e1",
    loadedBinary: {
      path: "vendor/termless/packages/wezterm/termless-wezterm.node",
      sha256: "6722b331de7489c14cb599d939e5d2314f054220728f83c5c29f454e70273e47",
    },
    provenance: {
      sha256: "6722b331de7489c14cb599d939e5d2314f054220728f83c5c29f454e70273e47",
      sourceCommit: "83b22ab3f99ff3c2f3e43bcfce346c1374f540e1",
      buildHash: "94a2d6025d3dc9e62debb7cbe388b3ad5113394d0ab6746d6baa58475fbe9c56",
      toolchain:
        "rustc 1.94.0 (4a4ef493e 2026-03-02) (built from a source tarball); cargo 1.94.0 (85eff7c80 2026-01-15)",
      lockSha256: "8eaeab733cced8d47feb223d773d5ae158b2e6af8c994f993d4071d9ba3231d4",
    },
  } as const satisfies NonNullable<LibProbeSource["runtimeIdentity"]>

  // #32246 (operator 2026-11-03, @cto 9fad23d7): this artifact's former source review no longer decides anything. With a
  // rendered X control and a silent command the callback records PROBE TODO coverage, never a source branch or assertion.
  test.each([
    "extensions.osc22-pointer",
    "extensions.osc176-app-id",
    "extensions.osc440-audio",
    "extensions.osc555-flash",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
    "extensions.osc3008-context",
    "extensions.osc133-d",
    ...OSC_SEMANTIC_MARK_CASES.filter(([id]) => id.startsWith("extensions.osc633-")).map(([id]) => id),
  ])("%s records PROBE TODO coverage, never a source review, on Wezterm", (id) => {
    const result = probe(id).lib!(
      context({ runtimeIdentity: identity, getCell: () => ({ ...context({}).getCell(0, 0), char: "X" }) }),
    )
    // A coverage record, or (for a consumed semantic marker) a criterion PROBE TODO: either way nothing is graded.
    if (result.notTested === undefined) {
      expect(result.tests).toEqual([expect.objectContaining({ id: "criterion", status: "probe-todo" })])
    } else expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
    expect(result.criterionBranch).toBeUndefined()
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  })

  test("handled 133 members, progress, notifications and OSC1/7 keep their existing routes", () => {
    const ids = [
      "extensions.osc133-a",
      "extensions.osc133-b",
      "extensions.osc133-c",
      "extensions.osc133-p",
      "extensions.osc9-progress",
      "extensions.osc777-notify",
      "extensions.notifications",
      "extensions.osc1-icon",
      "extensions.osc7-cwd",
    ]
    for (const id of ids) {
      let x = 0
      const result = probe(id).lib!(
        context({
          runtimeIdentity: identity,
          feed: (bytes) => {
            x = bytes.endsWith("X") ? 1 : 0
          },
          getCursor: () => ({ x, y: 0, visible: true, style: "block" }),
          getCell: () => ({ ...context({}).getCell(0, 0), char: "X" }),
        }),
      )
      expect(result.criterionBranch).not.toBe("source-negative-review")
      expect(result.assertions).toBeUndefined()
      if (id.startsWith("extensions.osc133-")) {
        expect(result.criterionBranch).toBe("semantic-prompt-source-review")
        expect(result.tests).toMatchObject([{ id: "review", status: "probe-todo" }])
      }
    }
  })

  test("qualified OSC720 identity preserves a moving viewport and rejects contradictory declarations", () => {
    let offset = 1
    const source = context({
      runtimeIdentity: identity,
      feed: (bytes) => {
        if (bytes.includes("\x1b]720")) offset = 0
      },
      getScrollback: () => ({ viewportOffset: offset, totalLines: 4, screenLines: 3 }),
      scrollViewport: (delta) => {
        offset = Math.max(0, Math.min(1, offset + delta))
      },
      reset: () => {
        offset = 1
      },
    })
    const callback = probe("extensions.osc720-scroll-up").lib!
    expect(callback(source).observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    const contradictory = callback({
      ...source,
      capabilities: { ...source.capabilities, productViewport: { available: false, reason: "Absent fixture" } },
    })
    expect(contradictory.note).toBe("Product viewport declared absent but scroll control is present")
    expect(contradictory.assertions).toBeUndefined()
    expect(contradictory.criterionBranch).toBeUndefined()
  })
})

/**
 * @failure Reflow wrapping masquerades as resize support; ignored OSC sequences and misplaced OSC 66 baselines become false positives.
 * @level l0
 * @consumer Unified app and headless probe definitions.
 * @testonly none
 */
describe("Kitty protocol detection", () => {
  test("reflow declaration does not claim resize-time behavior without a controlled resize", async () => {
    const p = probe("extensions.reflow")
    if (!p.term || !p.lib) throw new Error("Reflow needs both callbacks")
    for (const declared of [true, false]) {
      const writes: string[] = []
      const headless = p.lib(
        context({
          capabilities: { ...context({}).capabilities, reflow: declared },
          feed(sequence) {
            writes.push(sequence)
          },
        }),
      )
      const terminal = await p.term(
        terminalSource({
          write(sequence) {
            writes.push(sequence)
          },
          queryWithSentinel: async () => {
            throw new Error("Reflow must not query size without a resize oracle")
          },
          queryCursorPosition: async () => {
            throw new Error("Reflow must not grade wrapping as resize reflow")
          },
        }),
      )
      expect(writes).toEqual([])
      // A declaration is not a measurement: the headless arm records coverage with the named
      // observable (@cto 2026-10-22, 30695-inconclusive-mapping-ruling), while the application arm
      // keeps its inconclusive observation. Neither callback performs a controlled resize.
      expect(headless.pass).toBe(false)
      expect(headless.observation).toBeUndefined()
      expect(headless.notTested).toMatchObject({ reason: "no-semantic-observable" })
      expect(headless.note).toMatch(/controlled resize|readback/i)
      expect(terminal.pass).toBe(false)
      expect(terminal.observation).toBeUndefined()
      expect(terminal.assertions).toBeUndefined()
      expect(terminal.tests).toMatchObject([
        expect.objectContaining({ status: "probe-todo", reason: expect.any(String) }),
      ])
      expect(terminal.note).toMatch(/controlled resize|readback/i)
      expect(headless.response).toContain(String(declared))
    }
  })

  test("OSC 66 measures width and scale rather than treating consumption as support", async () => {
    const p = probe("extensions.osc66-text-sizing")
    if (!p.term || !p.lib) throw new Error("OSC 66 needs both probe methods")
    // CPR 1→3→5 captured from Kitty 0.46.2; ignored OSC leaves all three at 1.
    for (const [positions, expected] of [
      [[1, 1, 1], false],
      [[1, 3, 5], true],
      [[1, 3, 3], false],
    ] as const) {
      const written: string[] = []
      let index = 0
      const term = await p.term(
        terminalSource({
          write(text) {
            written.push(text)
          },
          queryCursorPosition: async () => ({ row: 1, col: positions[index++] ?? 1 }),
        }),
      )
      expect(term.pass).toBe(expected)
      expect(term.observation).toMatchObject({
        outcome: expected ? "supported" : "unsupported",
        assertionType: "query_reply",
      })
      expect(written).toContain("\x1b]66;w=2; \x07")
      expect(written).toContain("\x1b]66;s=2; \x07")
      index = 0
      const headless = p.lib(
        context({
          getCursor() {
            return { x: (positions[index++] ?? 1) - 1, y: 0, visible: true, style: "block" }
          },
        }),
      )
      expect(headless.pass).toBe(expected)
      expect(headless.observation).toMatchObject({
        outcome: expected ? "supported" : "unsupported",
        assertionType: "buffer_state",
      })
    }
    const missingWrites: string[] = []
    let missingQueries = 0
    const missing = await p.term(
      terminalSource({
        write(sequence) {
          missingWrites.push(sequence)
        },
        queryCursorPosition: async () => {
          missingQueries++
          return null
        },
      }),
    )
    expect(missingWrites).toEqual(["\x1b[1;1H\x1b[2K\r"])
    expect(missingQueries).toBe(1)
    expect(missing.observation).toBeUndefined()
    expect(missing.assertions).toBeUndefined()
    expect(missing.tests).toMatchObject([
      expect.objectContaining({
        status: "probe-invalid",
        reason: "no parsable cursor position reply; the public projection returned null and retained no bytes",
      }),
    ])
  })

  test("OSC 66 requires a measured home cursor before either protocol write", async () => {
    const p = probe("extensions.osc66-text-sizing")
    if (!p.term || !p.lib) throw new Error("OSC 66 needs both callbacks")
    for (const baseline of [
      { row: 1, col: 2 },
      { row: 2, col: 1 },
    ]) {
      const writes: string[] = []
      let queries = 0
      const terminal = await p.term(
        terminalSource({
          write(sequence) {
            writes.push(sequence)
          },
          queryCursorPosition: async () => {
            queries++
            return baseline
          },
        }),
      )
      expect(queries).toBe(1)
      expect(writes).toEqual(["\x1b[1;1H\x1b[2K\r"])
      expect(terminal.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
      expect(terminal.response).toContain(JSON.stringify(baseline))
      expect(terminal.assertions ?? []).toEqual([])
      const fed: string[] = []
      const headless = p.lib(
        context({
          feed(sequence) {
            fed.push(sequence)
          },
          getCursor() {
            return { x: baseline.col - 1, y: baseline.row - 1, visible: true, style: "block" }
          },
        }),
      )
      expect(fed).toEqual(["\x1b[1;1H\x1b[2K\r"])
      expect(headless.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
      expect(headless.response).toContain(JSON.stringify({ row: baseline.row - 1, col: baseline.col - 1 }))
      expect(headless.assertions ?? []).toEqual([])
    }
  })

  test.each([
    [0, false, "unsupported", undefined, "not recognized (Ps 0)"],
    [1, true, "supported", undefined, "set (Ps 1)"],
    [2, true, "supported", undefined, "reset (Ps 2)"],
    [3, true, "supported", undefined, "permanently set (Ps 3)"],
    [4, false, "unsupported", undefined, "permanently reset (Ps 4)"],
    [null, false, "inconclusive", "no-response", undefined],
  ] as const)("OSC 5522 Ps %s decides protocol detection on both arms", async (ps, pass, outcome, reason, reading) => {
    const p = probe("extensions.osc5522-clipboard")
    if (!p.term || !p.lib) throw new Error("OSC 5522 needs both probe methods")
    const response = ps === null ? "" : `\x1b[?5522;${ps}$y`
    const sentinel = "\x1b[?1;2c"
    const queries: string[] = []
    const headless = p.lib(
      context({
        feedCapture() {
          throw new Error("The installed headless outcome owns its full reply window")
        },
        queryWithSentinelOutcome(sequence, pattern) {
          queries.push(sequence)
          return {
            match: response.match(pattern),
            reason: ps === null ? "sentinel" : "reply",
            raw: response + sentinel,
            rawBase64: btoa(response + sentinel),
          }
        },
      }),
    )
    const term = await p.term(
      terminalSource({
        queryMode: async () => {
          throw new Error("OSC 5522 must retain the Ps, not its folded mode")
        },
        queryWithSentinel: async (sequence, pattern) => {
          queries.push(sequence)
          return sequence === "\x1b[?5522$p" ? response.match(pattern) : null
        },
        queryWithSentinelOutcome: async (sequence, pattern) => {
          queries.push(sequence)
          return {
            match: sequence === "\x1b[?5522$p" ? response.match(pattern) : null,
            reason: ps === null ? "timeout" : "reply",
            raw: response,
            rawBase64: btoa(response),
          }
        },
      }),
    )
    expect(queries).toEqual(["\x1b[?5522$p", "\x1b[?5522$p"])
    for (const result of [headless, term]) {
      expect(result.pass).toBe(pass)
      if (ps === null) {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({ status: "probe-invalid", reason: expect.any(String) }),
        ])
      } else {
        expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
        expect(result.observation?.reason).toBe(reason)
      }
      expect(result.response).toBe(result === headless ? response + sentinel : reading)
      expect(result.assertions?.[0]?.observed).toBe(ps === null ? undefined : reading)
      if (ps !== null) expect(result.assertions?.[0]?.kind).toBe(pass ? "positive" : "negative")
    }
  })

  // AC4: missing DECRQM readback is a prerequisite gap; target silence on a working path remains failure.
  // Existing Ps fixtures cover target replies, but never query the prerequisite after qualified silence.
  test.each(["vt100", "vt220"] as const)(
    "OSC 5522 grades no %s DECRQM source rejection and keeps measured replies",
    (engine) => {
      const runtimeIdentity = {
        kind: "js" as const,
        runtimeFormat: "js" as const,
        engineVersion: "0.10.1",
        adapterVersion: "0.10.2",
        termlessRevision: "25089207e11420cf7a588987c1dc2683a45e8372",
        resolvedPath: `vendor/vterm/packages/${engine}/src/index.ts`,
        integrity: {
          kind: "source" as const,
          repository: "git@github.com:beorn/vterm.git",
          revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
          treeOid:
            engine === "vt100"
              ? "b941dae48b25ae8825c394750bda5245c9d93dfa"
              : "4205f8936ad1848d1029729f3ada888cd61759a8",
          cleanTree: true,
        },
        adapterSources: Object.entries(ADAPTER_SOURCE_AUDITS[engine]).map(([path, blobOid]) => ({ path, blobOid })),
      }
      const da1 = engine === "vt100" ? "\x1b[?1;2c" : "\x1b[?62;1;2;6;7;8;9c"
      const run = (identity: LibProbeSource["runtimeIdentity"], detector = da1, sibling = da1) => {
        const queries: string[] = []
        const result = probe("extensions.osc5522-clipboard").lib!(
          context({
            runtimeIdentity: identity,
            queryWithSentinelOutcome(sequence, pattern) {
              queries.push(sequence)
              const raw = sequence === "\x1b[?5522$p" ? detector : sibling
              const match = raw.match(pattern)
              return {
                raw,
                rawBase64: btoa(raw),
                match,
                reason: match ? "reply" : "sentinel",
                sentinel: { atMs: 1, graceMs: 250 },
              }
            },
          }),
        )
        return { result, queries }
      }
      const { result, queries } = run(runtimeIdentity)
      expect(queries).toHaveLength(15)
      // #32246: no DECRQM source rejection decides the cell; the formerly audited identity reads as any other.
      expect(result.criterionBranch).toBeUndefined()
      expect(result.tests?.[0]).toMatchObject({ id: "criterion", status: "probe-todo" })
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      for (const identity of [
        undefined,
        { ...runtimeIdentity, termlessRevision: "0".repeat(40) },
        { ...runtimeIdentity, integrity: { ...runtimeIdentity.integrity, revision: "0".repeat(40) } },
        { ...runtimeIdentity, integrity: { ...runtimeIdentity.integrity, treeOid: "0".repeat(40) } },
        { ...runtimeIdentity, integrity: { ...runtimeIdentity.integrity, cleanTree: false } },
        {
          ...runtimeIdentity,
          adapterSources: runtimeIdentity.adapterSources.map((source) => ({ ...source, blobOid: "0".repeat(40) })),
        },
      ]) {
        expect(run(identity).result).toEqual(result)
      }
      for (const raw of [
        "\x1b[?7;1$y" + da1,
        "\x1b[?7;9$y" + da1,
        "\x1b[?7;4$" + da1,
        da1 + "\x1b[?7;0$y",
        "\x1b[?999;1$y" + da1,
      ]) {
        expect(run(runtimeIdentity, da1, raw).result.criterionBranch).not.toBe(SOURCE_NEGATIVE_REVIEW)
      }
      expect(run(runtimeIdentity, "\x1b[?5522;1$y" + da1).result.observation?.outcome).toBe("supported")
      expect(run(runtimeIdentity, "\x1b[?5522;4$y" + da1).result.observation?.outcome).toBe("unsupported")
      expect(run(runtimeIdentity, da1 + "\x1b[?5522;0$y").result.observation?.outcome).toBe("inconclusive")
    },
  )

  test("OSC 5522 names only a measured missing DECRPM prerequisite", () => {
    const p = probe("extensions.osc5522-clipboard")
    const da1 = "\x1b[?1;2c"
    for (const [control, qualified, expected] of [
      [da1, true, "probe-todo"],
      ["\x1b[?7;1$y" + da1, true, "probe-invalid"],
      ["\x1b[?7;0$y" + da1, true, "probe-invalid"],
      [da1, false, "probe-invalid"],
      ["junk" + da1, true, "probe-invalid"],
    ] as const) {
      const queries: string[] = []
      const result = p.lib!(
        context({
          queryWithSentinelOutcome(sequence, pattern) {
            queries.push(sequence)
            const raw = sequence === "\x1b[?5522$p" ? da1 : control
            const match = raw.match(pattern)
            return {
              raw,
              rawBase64: btoa(raw),
              match,
              reason: match ? "reply" : qualified ? "sentinel" : "timeout",
              ...(qualified && { sentinel: { atMs: 1, graceMs: 250 } }),
            }
          },
        }),
      )
      expect(result.tests?.[0]?.status).toBe(expected)
      expect(queries[0]).toBe("\x1b[?5522$p")
      if (qualified) expect(queries[1]).toBe("\x1b[?7$p")
      else expect(queries).toHaveLength(1)
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      if (expected === "probe-todo") {
        expect(result.tests?.[0]?.reason).toBe(
          "OSC5522 detection prerequisite unmet: no complete DECRPM reply from same-run sibling queries; protocol recognition cannot be observed.",
        )
        expect(JSON.parse(result.response!)).toMatchObject({
          detection: da1,
          decrpmSiblings: expect.arrayContaining([
            { mode: 7, raw: da1 },
            { mode: 2031, raw: da1 },
          ]),
        })
      } else if (qualified) {
        expect(JSON.parse(result.response!)).toEqual({ detection: da1, decrpmSiblings: [{ mode: 7, raw: control }] })
      } else expect(result.response).toBe(da1)
    }

    // AC4: any current library sibling can answer while DECAWM stays silent.
    // The older 2026/2031 fixtures missed library modes added during composition.
    for (const [id, mode] of [
      ["modes.synchronized-output", 2026],
      ["modes.color-scheme-reporting", 2031],
      ["modes.alt-scroll-1007", 1007],
      ["modes.decsclm", 4],
    ] as const) {
      // The current sibling criterion checks set/reset replies AND adapter state.
      let enabled = false
      const ctx = context({
        feed(sequence) {
          if (sequence === `\x1b[?${mode}h`) enabled = true
          if (sequence === `\x1b[?${mode}l`) enabled = false
        },
        getMode: (name) => (name === "insertMode" ? false : enabled),
        feedCapture: (sequence) => (sequence === `\x1b[?${mode}$p` ? `\x1b[?${mode};${enabled ? 1 : 2}$y` : ""),
        queryWithSentinelOutcome(sequence, pattern) {
          const raw = sequence === `\x1b[?${mode}$p` ? `\x1b[?${mode};${enabled ? 1 : 2}$y${da1}` : da1
          const match = raw.match(pattern)
          return {
            raw,
            rawBase64: btoa(raw),
            match,
            reason: match ? "reply" : "sentinel",
            sentinel: { atMs: 1, graceMs: 250 },
          }
        },
      })
      expect(probe(id).lib!(ctx).observation?.outcome).toBe("supported")
      const target = p.lib!(ctx)
      expect(target.tests?.[0]?.status).toBe("probe-invalid")
      expect(JSON.parse(target.response!)).toMatchObject({
        detection: da1,
        decrpmSiblings: expect.arrayContaining([{ mode, raw: `\x1b[?${mode};2$y${da1}` }]),
      })
      expect(target.observation).toBeUndefined()
      expect(target.assertions).toBeUndefined()
    }
  })

  // Q16: retained bytes outside the matching reply window must never become a detector negative.
  // Happy-path Ps fixtures do not distinguish a valid target negative from a late frame in raw evidence.
  test.each([
    ["malformed", "\x1b[?5522;9$y"],
    ["unmatched", "\x1b[?5523;4$y"],
    ["partial", "\x1b[?5522;4$"],
    ["unordered late Ps0", "\x1b[?1;2c\x1b[?5522;0$y"],
    ["unordered late Ps1", "\x1b[?1;2c\x1b[?5522;1$y"],
    ["unordered late Ps4", "\x1b[?1;2c\x1b[?5522;4$y"],
  ] as const)("OSC 5522 %s evidence stays nonnegative on both arms", async (_name, raw) => {
    const p = probe("extensions.osc5522-clipboard")
    if (!p.lib || !p.term) throw new Error("OSC 5522 needs both probe methods")
    const outcome = (pattern: RegExp) => ({
      match: raw.match(pattern),
      reason: "reply" as const,
      raw,
      rawBase64: btoa(raw),
    })
    const headless = p.lib(
      context({
        queryWithSentinelOutcome: (_sequence, pattern) => outcome(pattern),
      }),
    )
    const term = await p.term(
      terminalSource({
        queryWithSentinel: async (_sequence, pattern) => raw.match(pattern),
        queryWithSentinelOutcome: async (_sequence, pattern) => outcome(pattern),
      }),
    )
    const plainCapture = p.lib(context({ feedCapture: () => raw }))
    for (const result of [headless, plainCapture, term]) {
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
    }
    expect(headless.response).toBe(raw)
  })

  // Amended Q16: measured ordering admits a complete frame by the shared DECRPM criterion.
  // The earlier positive-only case missed the distinct Ps0 inconclusive and Ps4 negative branches.
  test.each([
    [0, "inconclusive", null],
    [1, "supported", "positive"],
    [2, "supported", "positive"],
    [3, "supported", "positive"],
    [4, "unsupported", "negative"],
  ] as const)(
    "OSC 5522 measured-late Ps%s grades its content with the ordering note",
    async (ps, outcomeName, kind) => {
      const p = probe("extensions.osc5522-clipboard")
      if (!p.lib || !p.term) throw new Error("OSC 5522 needs both probe methods")
      const raw = `\x1b[?1;2c\x1b[?5522;${ps}$y`
      const outcome = (pattern: RegExp) => ({
        match: raw.match(pattern),
        reason: "reply" as const,
        raw,
        rawBase64: btoa(raw),
        sentinel: { atMs: 1, graceMs: 20 },
      })
      const headless = p.lib(context({ queryWithSentinelOutcome: (_sequence, pattern) => outcome(pattern) }))
      const term = await p.term(
        terminalSource({ queryWithSentinelOutcome: async (_sequence, pattern) => outcome(pattern) }),
      )
      for (const result of [headless, term]) {
        expect(result.observation).toMatchObject({
          outcome: outcomeName,
          assertionType: "query_reply",
          note: REPLY_AFTER_SENTINEL_NOTE,
        })
        expect(result.pass).toBe(kind === "positive")
        if (kind === null) {
          expect(result.observation?.reason).toBe("insufficient-evidence")
          expect(result.assertions).toBeUndefined()
        } else {
          expect(result.assertions).toMatchObject([{ kind }])
        }
      }
      expect(headless.response).toBe(raw)
    },
  )

  // OSC 52 previously passed on any substring or on unrelated CPR, and left live clipboard writes behind.
  // No existing protocol test covers these three callbacks or the collector's no-clipboard policy.
  test("OSC 52 requires a complete nonce roundtrip in headless mode and never touches a live clipboard", async () => {
    for (const id of ["extensions.osc52-clipboard", "extensions.osc52-write", "extensions.osc52-read"]) {
      const p = probe(id)
      if (!p.lib || !p.term) throw new Error(`${id} needs both callbacks`)

      const sent: string[] = []
      const headless = p.lib(
        context({
          feed(text) {
            sent.push(text)
          },
          feedCapture(text) {
            expect(text).toBe("\x1b]52;c;?\x07")
            const encoded = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(sent.join(""))?.[1]
            if (!encoded) throw new Error("Probe never sent a clipboard nonce")
            return `\x1b]52;c;${encoded}\x1b\\`
          },
        }),
      )
      expect(headless.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })

      for (const reply of [
        "\x1b[1;1R", // Unrelated CPR cannot prove a clipboard write.
        "\x1b]52;c;d3Jvbmc=\x07", // A valid but different clipboard value is not the nonce.
        "\x1b]52;p;d3Jvbmc=\x07", // The primary selection is not c.
        "\x1b]52;c;not-base64!\x07",
        "\x1b]52;c;d3Jvbmc=\x1b", // ESC alone is not a complete ST.
        "",
      ]) {
        const result = p.lib(context({ feedCapture: () => reply }))
        if (reply === "") {
          expect(result.observation, `${id}: ${JSON.stringify(reply)}`).toBeUndefined()
          expect(result.assertions).toBeUndefined()
          expect(result.tests).toMatchObject([
            expect.objectContaining({
              status: "probe-invalid",
              reason: expect.stringContaining("No OSC 52 c query response"),
            }),
          ])
        } else {
          expect(result.observation?.outcome, `${id}: ${JSON.stringify(reply)}`).toBe("inconclusive")
        }
        expect(result.pass).toBe(false)
      }

      // Only the read claim may consume a proven reply path's measured silence.
      const da1 = "\x1b[?1;2c"
      const sentinel = { atMs: 9, graceMs: 250 }
      const measuredSilence = p.lib(
        context({
          queryWithSentinelOutcome(sequence) {
            expect(sequence).toBe("\x1b]52;c;?\x07")
            return { reason: "sentinel", match: null, raw: da1, rawBase64: btoa(da1), sentinel }
          },
        }),
      )
      if (id === "extensions.osc52-read") {
        expect(measuredSilence.observation).toMatchObject({ outcome: "unsupported", note: "negative by sentinel" })
        expect(measuredSilence.assertions).toMatchObject([{ kind: "negative" }])
        expect(measuredSilence.response).toBe(da1)

        const seeded: string[] = []
        const positive = p.lib(
          context({
            feed: (text) => seeded.push(text),
            feedCapture() {
              throw new Error("A qualified query outcome must not be replaced by another capture")
            },
            queryWithSentinelOutcome(sequence, pattern) {
              expect(sequence).toBe("\x1b]52;c;?\x07")
              const encoded = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(seeded.join(""))?.[1]
              if (!encoded) throw new Error("Read probe never seeded its isolated clipboard")
              const raw = `\x1b]52;c;${encoded}\x1b\\`
              return { reason: "reply", match: pattern.exec(raw), raw, rawBase64: btoa(raw) }
            },
          }),
        )
        expect(positive.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })

        for (const [raw, reason, facts] of [
          [da1, "timeout", sentinel], // A DA1-shaped capture alone is not a measured sentinel.
          [da1, "sentinel", undefined],
          [`x${da1}`, "sentinel", sentinel],
          [`${da1}\x1b]52;c;`, "sentinel", sentinel],
          ["\x1b]52;c;d3Jvbmc=\x07", "reply", undefined],
          ["\x1b]52;p;d3Jvbmc=\x07", "sentinel", sentinel],
          ["\x1b]52;c;not-base64!\x07", "sentinel", sentinel],
          ["\x1b]52;c;Zh==\x07", "reply", undefined], // Decodes, but is not canonical base64.
          ["\x1b]52;c;d3Jvbmc=\x1b", "sentinel", sentinel],
          ["", "timeout", undefined],
        ] as const) {
          const result = p.lib(
            context({
              feedCapture() {
                throw new Error("Do not rescue an unqualified query outcome with a second capture")
              },
              queryWithSentinelOutcome: () => ({ reason, match: null, raw, rawBase64: btoa(raw), sentinel: facts }),
            }),
          )
          expect(result.response).toBe(raw)
          expect(result.observation?.outcome).not.toBe("unsupported")
          expect(result.pass).toBe(false)
          if (raw === "") expect(result.tests).toMatchObject([{ status: "probe-invalid" }])
          else expect(result.observation?.outcome).toBe("inconclusive")
        }
      } else {
        expect(measuredSilence.observation).toBeUndefined()
        expect(measuredSilence.assertions).toBeUndefined()
        expect(measuredSilence.response).toBe(da1)
        expect(measuredSilence.tests).toEqual([
          {
            id: "criterion",
            status: "probe-todo",
            reason:
              "clipboard write unobservable: OSC 52 read is a sentinel negative on this engine and no clipboard-state witness is wired.",
          },
        ])
      }

      const liveWrites: string[] = []
      const live = await p.term(
        terminalSource({
          write(text) {
            liveWrites.push(text)
          },
          queryCursorPosition: async () => {
            throw new Error("OSC 52 live policy must not query")
          },
          queryWithSentinel: async () => {
            throw new Error("OSC 52 live policy must not read clipboard")
          },
          queryWithSentinelOutcome: async () => {
            throw new Error("OSC 52 live policy must not read clipboard")
          },
        }),
      )
      expect(liveWrites, id).toEqual([])
      expect(live.observation).toBeUndefined()
      expect(live.assertions).toBeUndefined()
      expect(live.tests).toMatchObject([
        expect.objectContaining({
          status: "probe-todo",
          reason: "Collector policy: no owned disposable clipboard with verified restoration; OSC 52 was not sent",
        }),
      ])
      expect(live.note).toMatch(/collector|owned clipboard/i)
    }
  })

  // An owned fixture measures write and read independently; an echoed OSC frame alone cannot prove a write.
  test("owned live OSC 52 tests independent clipboard state and complete canonical query replies", async () => {
    const written: string[] = []
    let clipboard = "baseline"
    const fixture = {
      readText: async () => clipboard,
      writeText: async (text: string) => {
        clipboard = text
      },
    }
    const withClipboardFixture: NonNullable<TermProbeSource["withClipboardFixture"]> = async (work) => work(fixture)
    const queryOutcome = async (sequence: string) => {
      expect(sequence).toBe("\x1b]52;c;?\x07")
      const frame = `\x1b]52;c;${btoa(clipboard)}\x1b\\`
      return {
        match: [frame, btoa(clipboard)],
        reason: "reply" as const,
        raw: frame,
        rawBase64: Buffer.from(frame).toString("base64"),
      }
    }
    for (const id of ["extensions.osc52-write", "extensions.osc52-read", "extensions.osc52-clipboard"]) {
      written.length = 0
      clipboard = "baseline"
      const p = probe(id)
      if (!p.term) throw new Error(`${id} needs a live callback`)
      const result = await p.term(
        terminalSource({
          withClipboardFixture,
          write(text) {
            written.push(text)
            const match = /\x1b\]52;c;([^\x07\x1b]*)\x07/.exec(text)
            if (match) clipboard = atob(match[1] ?? "")
          },
          queryOutcome,
        }),
      )
      expect(result.observation, id).toMatchObject({
        outcome: "supported",
        assertionType: id === "extensions.osc52-write" ? "clipboard" : "query_reply",
      })
      expect(clipboard, id).not.toBe("baseline")
      expect(
        written.some((value) => value.startsWith("\x1b]52;c;")),
        id,
      ).toBe(id !== "extensions.osc52-read")
    }
    const read = probe("extensions.osc52-read")
    if (!read.term) throw new Error("read callback missing")
    for (const raw of ["\x1b[1;1R", "\x1b]52;p;d3Jvbmc=\x07", "\x1b]52;c;bad!\x07", "\x1b]52;c;d3Jvbmc=\x1b", ""]) {
      const result = await read.term(
        terminalSource({
          withClipboardFixture,
          queryOutcome: async () => ({
            match: null,
            reason: "timeout",
            raw,
            rawBase64: Buffer.from(raw).toString("base64"),
          }),
        }),
      )
      if (raw === "") {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({ status: "probe-invalid", reason: "No complete OSC 52 c reply" }),
        ])
      } else {
        expect(result.observation?.outcome, JSON.stringify(raw)).toBe("inconclusive")
      }
    }
    const uncorrelated = await read.term(
      terminalSource({
        withClipboardFixture,
        queryOutcome: async () => {
          const raw = `\x1b]52;c;${btoa(clipboard)}\x07`
          return { match: null, reason: "timeout", raw, rawBase64: Buffer.from(raw).toString("base64") }
        },
      }),
    )
    expect(uncorrelated.observation).toEqual({
      outcome: "inconclusive",
      assertionType: "query_reply",
      reason: "invalid-reply",
      note: "No complete OSC 52 c reply",
    })
    expect(uncorrelated.assertions).toBeUndefined()
    expect(uncorrelated.tests).toBeUndefined()
    let captured = false
    const prompt = await read.term(
      terminalSource({
        withClipboardFixture,
        queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
        capture: async (request) => {
          captured = true
          expect(request).toEqual({ role: "target", label: "Clipboard query after no response" })
          return { ...request, capturedAt: 1, ref: `sha256:${"a".repeat(64)}` }
        },
      }),
    )
    expect(captured).toBe(true)
    expect(prompt.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
      screenshotRef: `sha256:${"a".repeat(64)}`,
    })
  })

  // The detection step (CSI ? u + DA1) is unmutating: an absent protocol returns before any push, so nothing is
  // popped. A push that is attempted and then fails must still be popped before the probe returns.
  test("Kitty keyboard probes detect protocol support before pushing, and pop only a push they made", async () => {
    const cases = [
      ["extensions.kitty-keyboard", 1],
      ["extensions.kitty-keyboard.disambiguate", 1],
      ["extensions.kitty-keyboard.report-events", 3],
      ["extensions.kitty-keyboard.report-alternate", 5],
      ["extensions.kitty-keyboard.report-all-keys", 9],
      ["extensions.kitty-keyboard.report-text", 25],
      ["input.csi-u", 1],
    ] as const

    for (const [id, flags] of cases) {
      const p = probe(id)
      if (!p.term) throw new Error(`${id} needs a TTY callback`)

      // DA1-only detection: unsupported, no push, no pop.
      {
        const writes: string[] = []
        const absentCtx = terminalSource({
          write(text) {
            writes.push(text)
          },
          queryWithSentinelOutcome: async (sequence) => {
            writes.push(sequence)
            const raw = "\x1b[?1;2c"
            return { match: null, reason: "sentinel", raw, rawBase64: btoa(raw) }
          },
        })
        const result = await p.term(absentCtx)
        expect(result.observation?.outcome, `${id}: absent`).toBe("unsupported")
        expect(writes, `${id}: absent`).toEqual(["\x1b[?u"])
      }

      // Flags answered: explicit push write, then the flag query, then pop even if the query throws.
      for (const outcome of ["reply", "error"] as const) {
        const writes: string[] = []
        let queryCall = 0
        const failure = new Error(`${id}: query failed`)
        const ctx = terminalSource({
          write(text) {
            writes.push(text)
          },
          queryWithSentinelOutcome: async (sequence) => {
            writes.push(sequence)
            queryCall++
            if (queryCall === 1) {
              const raw = "\x1b[?1u"
              return { match: [raw, "1"], reason: "reply", raw, rawBase64: btoa(raw) }
            }
            if (outcome === "error") throw failure
            const raw = "\x1b[?31u"
            return { match: [raw, "31"], reason: "reply", raw, rawBase64: btoa(raw) }
          },
        })

        if (outcome === "error") await expect(p.term(ctx)).rejects.toBe(failure)
        else expect((await p.term(ctx)).pass, `${id}: ${outcome}`).toBe(true)
        expect(writes, `${id}: ${outcome}`).toEqual(["\x1b[?u", `\x1b[>${flags}u`, "\x1b[?u", "\x1b[<u"])
      }
    }
  })

  test("Kitty probes pop only a push they actually wrote", async () => {
    const p = probe("extensions.kitty-keyboard")
    if (!p.term || !p.lib) throw new Error("missing keyboard callbacks")
    const lib = p.lib

    // Termless: the push feed throws before it is written -> no pop.
    {
      const feeds: string[] = []
      expect(() =>
        lib(
          context({
            feedCapture: () => "\x1b[?1u",
            feed(sequence) {
              feeds.push(sequence)
              if (sequence.startsWith("\x1b[>")) throw new Error("push failed")
            },
          }),
        ),
      ).toThrow(/push failed/)
      expect(feeds, "termless push failure").not.toContain("\x1b[<u")
    }

    // Termless: the push is written, then the flag query throws -> pop.
    {
      const feeds: string[] = []
      let captureCall = 0
      expect(() =>
        lib(
          context({
            feed(sequence) {
              feeds.push(sequence)
            },
            feedCapture() {
              captureCall++
              if (captureCall === 1) return "\x1b[?1u"
              throw new Error("query failed")
            },
          }),
        ),
      ).toThrow(/query failed/)
      expect(feeds, "termless post-push failure").toContain("\x1b[>1u")
      expect(feeds, "termless post-push failure").toContain("\x1b[<u")
    }

    // Term: the push write throws -> no pop; the push write succeeds then the flag query throws -> pop.
    for (const mode of ["push-write-throws", "query-throws"] as const) {
      const writes: string[] = []
      let queryCall = 0
      const ctx = terminalSource({
        write(sequence) {
          writes.push(sequence)
          if (mode === "push-write-throws" && sequence.startsWith("\x1b[>")) throw new Error("push failed")
        },
        queryWithSentinelOutcome: async () => {
          queryCall++
          if (queryCall === 1) {
            const raw = "\x1b[?1u"
            return { match: [raw, "1"], reason: "reply", raw, rawBase64: btoa(raw) }
          }
          throw new Error("query failed")
        },
      })
      if (mode === "push-write-throws") {
        await expect(p.term(ctx)).rejects.toThrow(/push failed/)
        expect(writes, `${mode} term`).not.toContain("\x1b[<u")
      } else {
        await expect(p.term(ctx)).rejects.toThrow(/query failed/)
        expect(writes, `${mode} term`).toContain("\x1b[>1u")
        expect(writes, `${mode} term`).toContain("\x1b[<u")
      }
    }
  })

  test("Kitty protocol detection reads flags, DA1-only negatives, and transport controls without a push", async () => {
    const p = probe("extensions.kitty-keyboard.report-text")
    if (!p.lib || !p.term) throw new Error("missing keyboard callbacks")

    const detections = [
      ["\x1b[?25u\x1b[?62;4c", "supported"], // flags + DA1
      ["\x1b[?25u", "supported"], // flags only, the no-DA1 control
      ["\x1b[?1;2c", "unsupported"], // DA1 only, the documented negative
      ["", "inconclusive"], // neither reply
      ["\x1b[?62;", "inconclusive"], // truncated DA1 is not a reply
      ["\x1b[?1;2c\x1b[?25u", "inconclusive"], // DA1 before flags, ambiguous ordering
      ["\x1b[?;u\x1b[?1;2c", "inconclusive"], // malformed flags (empty params) with DA1
      ["\x1b[?1;2u\x1b[?1;2c", "inconclusive"], // malformed flags (extra params) with DA1
      ["\x1b[?1:2u\x1b[?1;2c", "inconclusive"], // malformed flags (colon params) before DA1 — not the digits-only shape
      ["\x1b[?12", "inconclusive"], // truncated flags, no terminator
      ["\x1b[?12\x1b[?1;2c", "inconclusive"], // truncated flags before DA1
      ["\x00\x1b[?1;2c", "inconclusive"], // residual byte before an otherwise complete DA1
      ["\x1b[?1;2c\x07", "inconclusive"], // residual byte after an otherwise complete DA1
      ["\x1b[?1;2c\x1b[?1;2c", "inconclusive"], // duplicate DA1 — residual bytes around the first reply
    ] as const

    for (const [raw, outcome] of detections) {
      const captures: string[] = []
      const feeds: string[] = []
      const result = p.lib(
        context({
          feed(sequence) {
            feeds.push(sequence)
          },
          feedCapture(sequence) {
            captures.push(sequence)
            return raw
          },
        }),
      )
      if (raw === "") {
        expect(result.observation, `termless ${JSON.stringify(raw)}`).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "probe-invalid",
            reason: expect.stringContaining("No answer to the Kitty keyboard flags query"),
          }),
        ])
      } else {
        expect(result.observation?.outcome, `termless ${JSON.stringify(raw)}`).toBe(outcome)
      }
      expect(captures[0], `termless ${JSON.stringify(raw)}`).toBe("\x1b[?u\x1b[c")
      if (outcome !== "supported") {
        expect(captures, `termless ${JSON.stringify(raw)} query count`).toHaveLength(1)
        expect(feeds, `termless ${JSON.stringify(raw)} push count`).toEqual([])
      } else {
        expect(captures, `termless ${JSON.stringify(raw)}`).toEqual(["\x1b[?u\x1b[c", "\x1b[?u"])
        expect(feeds, `termless ${JSON.stringify(raw)}`).toEqual(["\x1b[>25u", "\x1b[<u"])
      }
    }

    for (const [raw, outcome] of detections) {
      const writes: string[] = []
      const result = await p.term(
        terminalSource({
          write(text) {
            writes.push(text)
          },
          queryWithSentinelOutcome: async (sequence, pattern) => {
            writes.push(sequence)
            const match = raw.match(pattern)
            const sentinel = /\x1b\[\?[0-9;]+c/.test(raw) && !match
            return {
              match: match ? [...match] : null,
              reason: match ? "reply" : sentinel ? "sentinel" : "timeout",
              raw,
              rawBase64: btoa(raw),
            }
          },
        }),
      )
      if (raw === "") {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.response).toBe("")
        expect(result.tests).toEqual([
          {
            id: "criterion",
            status: "probe-invalid",
            reason: "No answer to the Kitty keyboard flags query or the DA1 follow-up; no support conclusion",
          },
        ])
      } else {
        expect(result.observation, `term ${JSON.stringify(raw)}`).toMatchObject({
          outcome,
          assertionType: "query_reply",
        })
      }
      expect(writes[0], `term ${JSON.stringify(raw)}`).toBe("\x1b[?u")
      if (outcome !== "supported") {
        expect(writes, `term ${JSON.stringify(raw)} push/pop`).toEqual(["\x1b[?u"])
      } else {
        expect(writes, `term ${JSON.stringify(raw)}`).toEqual(["\x1b[?u", "\x1b[>25u", "\x1b[?u", "\x1b[<u"])
      }
    }
  })

  test("keyboard queries distinguish acknowledged flags from missing replies", async () => {
    const p = probe("extensions.kitty-keyboard.report-text")
    if (!p.term) throw new Error("missing keyboard callback")
    for (const [flags, outcome] of [
      [25, "supported"],
      [9, "unsupported"],
    ] as const) {
      const raw = `\x1b[?${flags}u`
      const writes: string[] = []
      const result = await p.term(
        terminalSource({
          write(sequence) {
            writes.push(sequence)
          },
          queryWithSentinelOutcome: async (_sequence, pattern) => ({
            match: raw.match(pattern),
            reason: "reply",
            raw,
            rawBase64: btoa(raw),
          }),
        }),
      )
      const push = writes.find((sequence) => sequence.startsWith("\x1b[>"))
      expect(Number(/\x1b\[>(\d+)u/.exec(push ?? "")?.[1]) & 24).toBe(24) // Associated text requires all-keys mode too.
      expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
      expect(result.assertions?.[0]?.observed).toContain(String(flags))
    }
    const timeout = await p.term(terminalSource({}))
    expect(timeout.observation).toBeUndefined()
    expect(timeout.assertions).toBeUndefined()
    expect(timeout.tests).toMatchObject([
      expect.objectContaining({
        status: "probe-invalid",
        reason: expect.stringContaining("No answer to the Kitty keyboard flags query"),
      }),
    ])
  })

  test("CSI-u recognition requires acknowledged flags, not a responsive cursor", async () => {
    const p = probe("input.csi-u")
    if (!p.term || !p.lib) throw new Error("CSI-u needs both callbacks")
    for (const [raw, outcome] of [
      ["\x1b[?1u", "supported"],
      ["\x1b[?0u", "unsupported"],
      ["", "inconclusive"],
    ] as const) {
      const result = await p.term(
        terminalSource({
          queryWithSentinelOutcome: async (_sequence, pattern) => ({
            match: raw.match(pattern),
            reason: raw ? "reply" : "sentinel",
            raw,
            rawBase64: btoa(raw),
          }),
        }),
      )
      if (raw === "") {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "probe-invalid",
            reason: expect.stringContaining("No answer to the Kitty keyboard flags query"),
          }),
        ])
      } else {
        expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
        expect(p.lib(context({ feedCapture: () => raw })).observation?.outcome).toBe(outcome)
      }
    }
  })

  test("notification detection tests the echoed query identifier and advertised title payload", async () => {
    const p = probe("extensions.osc99-kitty-notify")
    if (!p.term) throw new Error("missing notification callback")
    for (const [replyKind, outcome] of [
      ["valid", "supported"],
      ["wrong-id", "inconclusive"],
      ["missing-title", "inconclusive"],
      ["silence", "inconclusive"],
    ] as const) {
      const result = await p.term(
        terminalSource({
          write: () => {
            throw new Error("Support detection must not display a notification")
          },
          queryWithSentinelOutcome: async (sequence, pattern) => {
            const id = /\x1b\]99;i=([^:;]+):p=\?;/.exec(sequence)?.[1]
            if (!id) throw new Error("Missing notification capability query")
            const raw =
              replyKind === "silence"
                ? ""
                : `\x1b]99;i=${replyKind === "wrong-id" ? "unrelated" : id}:p=?;p=${replyKind === "missing-title" ? "body" : "title,body"}:o=always\x1b\\`
            return { match: raw.match(pattern), reason: "sentinel", raw, rawBase64: btoa(raw) }
          },
        }),
      )
      if (replyKind === "silence") {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "probe-invalid",
            reason: "No matching notification query reply; OS display was not tested",
          }),
        ])
      } else {
        expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
      }
      if (outcome === "supported") expect(result.assertions?.[0]?.observed).toContain("title,body")
    }
  })

  // #31692: the term-only test could not catch the missing real library arm or fallback silence.
  test.each([
    "valid",
    "wrong-id",
    "missing-title",
    "duplicate-p",
    "garbage",
    "timeout",
    "qualified-silence",
    "fallback-silence",
    "fallback-valid",
  ] as const)("notification library query preserves its criterion for %s", (replyKind) => {
    const p = probe("extensions.osc99-kitty-notify")
    if (!p.lib) throw new Error("missing notification library callback")
    const sent: string[] = []
    let observed = ""
    const exchange = (sequence: string, pattern: RegExp) => {
      sent.push(sequence)
      const id = /\x1b\]99;i=([^:;]+):p=\?;/.exec(sequence)?.[1]
      if (!id) throw new Error("Missing notification capability query")
      const empty = replyKind === "timeout" || replyKind === "fallback-silence"
      const payload =
        replyKind === "missing-title" ? "p=body" : replyKind === "duplicate-p" ? "p=title:p=body" : "p=title,body"
      observed = empty
        ? ""
        : replyKind === "qualified-silence"
          ? "\x1b[?1;2c"
          : replyKind === "garbage"
            ? "unrelated bytes"
            : `\x1b]99;i=${replyKind === "wrong-id" ? "unrelated" : id}:p=?;${payload}\x1b\\`
      return {
        raw: observed,
        rawBase64: btoa(observed),
        match: observed.match(pattern),
        reason: replyKind === "timeout" ? ("timeout" as const) : ("sentinel" as const),
        ...(replyKind === "qualified-silence" && { sentinel: { atMs: 1, graceMs: 250 } }),
      }
    }
    const source = context({
      feed: () => {
        throw new Error("Capability query must not display a notification")
      },
    })
    if (replyKind.startsWith("fallback-")) {
      source.feedCapture = (sequence) => {
        return exchange(sequence, /never/).raw
      }
    } else source.queryWithSentinelOutcome = exchange
    const result = p.lib(source)
    expect(sent).toHaveLength(1)
    expect(p.libAssertionType).toBe("query_reply")
    if (replyKind === "valid" || replyKind === "fallback-valid") {
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed }])
      expect(result.response).toBe(observed)
    } else if (replyKind === "qualified-silence") {
      expect(result.observation?.outcome).toBe("unsupported")
      expect(result.assertions).toMatchObject([{ kind: "negative" }])
    } else if (replyKind === "timeout") {
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.tests).toMatchObject([{ status: "probe-invalid" }])
    } else {
      expect(result.observation?.outcome).toBe("inconclusive")
      expect(result.assertions ?? []).toEqual([])
    }
  })

  test("viewport hold names the missing app input route before writing or capturing", async () => {
    const p = probe("scrollback.viewport-hold-output")
    expect(p.libAssertionType).toBe("buffer_state")
    expect(p.termAssertionType).toBe("screenshot")
    expect(p.termNeedsGeometry).toBe(true)
    expect(p.termNeedsDisposable).toBe(true)
    if (!p.term) throw new Error("missing viewport application callback")
    const source = terminalSource({
      write: () => {
        throw new Error("viewport wrote without an input route")
      },
      capture: async () => {
        throw new Error("viewport captured without an input route")
      },
    })
    const result = await p.term(source)
    expect(result.notTested?.noObservable).toBe("viewport input and pixel capture unavailable")
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  })

  test("OSC 21 validates the requested foreground reply and never falls back to cursor consumption", async () => {
    const p = probe("extensions.osc21-kitty-color")
    if (!p.term || !p.lib) throw new Error("OSC 21 needs both callbacks")
    // The protocol explicitly permits an empty value for a dynamic/undefined color.
    for (const [body, outcome] of [
      ["foreground=rgb:ff/00/00", "supported"],
      ["foreground=", "supported"],
      ["background=rgb:ff/00/00", "inconclusive"],
      ["foreground=garbage", "inconclusive"],
      [null, "inconclusive"],
    ] as const) {
      const raw = body === null ? "" : `\x1b]21;${body}\x1b\\`
      const result = await p.term(
        terminalSource({
          queryWithSentinelOutcome: async (_sequence, pattern) => ({
            match: raw.match(pattern),
            reason: raw ? "reply" : "sentinel",
            raw,
            rawBase64: btoa(raw),
          }),
        }),
      )
      if (body === null) {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "probe-invalid",
            reason: "No OSC 21 reply; color rendering was not tested",
          }),
        ])
      } else {
        expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
        expect(p.lib(context({ feedCapture: () => raw })).observation?.outcome).toBe(outcome)
      }
    }
  })

  test("graphics upload and placement require their own acknowledgements and clean up only the allocated image", async () => {
    for (const kind of ["transmit", "display"]) {
      const p = probe(`extensions.kitty-graphics.${kind}`)
      if (!p.term || !p.lib) throw new Error("missing graphics callback")
      const silent = await p.term(terminalSource({}))
      expect(silent.pass).toBe(false) // A normal CPR must not turn an ignored APC into support.
      expect(silent.observation).toBeUndefined()
      expect(silent.assertions).toBeUndefined()
      expect(silent.tests).toMatchObject([
        expect.objectContaining({ status: "probe-invalid", reason: expect.any(String) }),
      ])
      for (const outcome of ["accepted", "rejected", "wrong-id"] as const) {
        const writes: string[] = []
        const responseTo = (sequence: string): string => {
          if (sequence.includes("a=t,")) {
            const number = /,I=(\d+)/.exec(sequence)?.[1]
            if (!number) throw new Error("Upload must request a fresh image rather than overwrite a fixed image ID")
            return `\x1b_Gi=745,I=${outcome === "wrong-id" ? "0" : number};${outcome === "rejected" ? "EINVAL:invalid image" : "OK"}\x1b\\`
          }
          if (sequence.includes("a=p,")) return "\x1b_Gi=745;OK\x1b\\"
          throw new Error(`Unexpected graphics request ${JSON.stringify(sequence)}`)
        }
        const result = await p.term(
          terminalSource({
            write: (sequence) => {
              writes.push(sequence)
            },
            queryWithSentinelOutcome: async (sequence, pattern) => {
              const raw = responseTo(sequence)
              return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
            },
          }),
        )
        expect(result.observation).toMatchObject({
          outcome: outcome === "accepted" ? "supported" : "inconclusive",
          assertionType: "query_reply",
        })
        if (outcome === "accepted") expect(writes.join("")).toContain("a=d,d=I,i=745")
        else expect(writes).toEqual([]) // No acknowledged ownership; never delete an unrelated image.
        expect(p.lib(context({ feedCapture: responseTo })).observation?.outcome).toBe(result.observation?.outcome)
      }
    }
    const display = probe("extensions.kitty-graphics.display")
    if (!display.term) throw new Error("missing display callback")
    const writes: string[] = []
    const failure = new Error("placement query failed")
    await expect(
      display.term(
        terminalSource({
          write: (sequence) => {
            writes.push(sequence)
          },
          queryWithSentinelOutcome: async (sequence, pattern) => {
            if (sequence.includes("a=p,")) throw failure
            const number = /,I=(\d+)/.exec(sequence)?.[1]
            const raw = `\x1b_Gi=745,I=${number};OK\x1b\\`
            return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
          },
        }),
      ),
    ).rejects.toBe(failure)
    expect(writes.join("")).toContain("a=d,d=I,i=745")
  })

  test("graphics detection uses the protocol query and never infers pixels from cursor movement", async () => {
    const p = probe("extensions.kitty-graphics")
    if (!p.term) throw new Error("missing graphics callback")
    const result = await p.term(
      terminalSource({
        queryWithSentinelOutcome: async (sequence, pattern) => {
          expect(sequence).toContain("a=q")
          const id = /(?:G|,)i=(\d+)/.exec(sequence)?.[1]
          expect(id).toBeDefined()
          const raw = `\x1b_Gi=${id};OK\x1b\\`
          return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
        },
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    const silent = await p.term(terminalSource({ queryCursorPosition: async () => ({ row: 9, col: 9 }) }))
    expect(silent.observation).toBeUndefined()
    expect(silent.assertions).toBeUndefined()
    expect(silent.tests).toMatchObject([
      expect.objectContaining({
        status: "probe-invalid",
        reason: "No matching graphics query reply; image rendering was not tested",
      }),
    ])
  })
})

/**
 * @failure Declared capabilities, title-only changes, and CPR responsiveness became full graphics, notification, icon, CWD, or shell-integration support claims.
 * @level l0
 * @consumer Headless and application extension callbacks.
 * @testonly none
 */
describe("extensions without a complete behavior oracle", () => {
  // O3: an audited source-negative identity must never override an actual CWD reader.
  test("OSC7 metadata readback wins over the xtermjs source audit and restores the baseline", () => {
    const runtimeIdentity = {
      kind: "js",
      runtimeFormat: "js",
      engineVersion: "6.0.0",
      adapterVersion: "0.10.2",
      termlessRevision: "9f0d4a5cbbeb2b7d9263ef7e07699df16a1cafc7",
      adapterSources: [
        { path: "packages/xtermjs/src/index.ts", blobOid: "550e10110ec2baaf326d2958319b03ee8208feba" },
        { path: "packages/xtermjs/src/backend.ts", blobOid: "72dc827b2026af7736de722f7ff986a04f3fe883" },
      ],
      resolvedPath: "/fixture/@xterm/headless/lib-headless/xterm-headless.js",
      integrity: {
        kind: "registry",
        lockIntegrity:
          "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
      },
    } as const
    let cwd = "file://localhost/original"
    const result = probe("extensions.osc7-cwd").lib!(
      context({
        runtimeIdentity,
        getCwd: () => cwd,
        feed: (bytes) => {
          const match = /^\x1b\](?:7;|633;P;Cwd=)(.*)\x07$/.exec(bytes)
          if (!match) throw new Error(`Unexpected OSC7 fixture write: ${JSON.stringify(bytes)}`)
          cwd = match[1]!
        },
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: result.response }])
    expect(JSON.parse(result.response!)).toMatchObject({
      before: "file://localhost/original",
      first: "file://localhost/terminfo-cwd-A",
      second: "file://localhost/terminfo-cwd-B",
      restored: "file://localhost/original",
    })
    expect(cwd).toBe("file://localhost/original")
    expect(result.criterionBranch).toBeUndefined()
  })

  const declaredIds = [
    "extensions.kitty-graphics.animation",
    "extensions.kitty-graphics.unicode-placeholders",
    "extensions.sixel",
    "extensions.reflow",
    "extensions.osc7-cwd",
    "extensions.notifications",
    "extensions.iterm2-images",
  ] as const
  // The two kitty pixel rows left this list with their pixel arms: they now read a capture and
  // compare frames, so "no readback oracle" is no longer true of them.
  const noOracleAppIds = [
    "extensions.sixel",
    "extensions.semantic-prompts",
    "extensions.osc-633-vscode",
    "extensions.osc7-cwd",
    "extensions.notifications",
    "extensions.iterm2-images",
    "extensions.osc1-icon",
  ] as const

  test("true and false declarations remain diagnostics, never support conclusions", () => {
    for (const declared of [true, false]) {
      const base = context({})
      const capabilities = {
        ...base.capabilities,
        kittyGraphics: declared,
        sixel: declared,
        reflow: declared,
        semanticPrompts: declared,
        extensions: new Set(declared ? ["osc7", "osc9", "iterm2Images"] : []),
      }
      for (const id of declaredIds) {
        const callback = probe(id).lib
        if (!callback) throw new Error(`${id} needs a headless callback`)
        const result = callback(context({ capabilities }))
        expect(result.pass, id).toBe(false)
        // An engine declaration is coverage, not an attempted measurement: the arm names the
        // missing observable so the recorder grades PROBE TODO instead of a failed test
        // (@cto 2026-10-22, 30695-inconclusive-mapping-ruling).
        expect(result.observation, id).toBeUndefined()
        expect(result.notTested, id).toMatchObject({ reason: "no-semantic-observable" })
        expect(result.notTested?.noObservable, id).toBe(result.note)
        const recorded = JSON.parse(result.response ?? "null") as Record<string, boolean>
        expect(Object.values(recorded), id).toContain(declared)
        expect(result.assertions ?? [], id).toEqual([])
      }
    }
  })

  test("a title change cannot establish icon-name support", () => {
    for (const id of ["extensions.osc1-icon"]) {
      const callback = probe(id).lib
      if (!callback) throw new Error(`${id} needs a headless callback`)
      for (const after of ["original", "test-icon My Title"]) {
        let fed = false
        const result = callback(
          context({
            feed() {
              fed = true
            },
            getTitle() {
              return fed ? after : "original"
            },
          }),
        )
        expect(result.pass, id).toBe(false)
        expect(result.observation, id).toBeUndefined()
        // A former source-review site (#32246): no same-path control reads the icon name in this run.
        expect(result.notTested, id).toEqual({
          reason: "no-semantic-observable",
          noObservable: NO_SAME_PATH_CONTROL,
        })
        expect(JSON.parse(result.response ?? "null"), id).toEqual({ before: "original", after })
        expect(result.assertions ?? [], id).toEqual([])
      }
    }
  })

  test("application probes without a readback oracle do not mutate the terminal", async () => {
    for (const id of noOracleAppIds) {
      const callback = probe(id).term
      if (!callback) throw new Error(`${id} needs an application callback`)
      const writes: string[] = []
      const result = await callback(
        terminalSource({
          write(sequence) {
            writes.push(sequence)
          },
          queryCursorPosition: async () => {
            throw new Error(`${id} must not use CPR as its oracle`)
          },
        }),
      )
      expect(writes, id).toEqual([])
      expect(result.pass, id).toBe(false)
      expect(result.observation, id).toBeUndefined()
      expect(result.assertions, id).toBeUndefined()
      expect(result.tests, id).toMatchObject([
        expect.objectContaining({ status: "probe-todo", reason: expect.any(String) }),
      ])
      expect(result.assertions ?? [], id).toEqual([])
    }
  })
})

/**
 * @failure Charset probes promoted a literal, blank, or arbitrary glyph without a measured ASCII fixture and exact target cells.
 * @level l0
 * @consumer Headless charset probe observations.
 * @testonly none
 */
describe("headless charset cell evidence", () => {
  const cases = [
    {
      id: "charsets.dec-special",
      minCols: 3,
      before: [..."qqq"],
      after: [..."q─q"],
      ignored: [..."qqq"],
      wrong: [..."q☃q"],
      trigger: "\x1b(0q",
      targetCol: 1,
      required: ["\x1b(0", "\x1b(B"],
    },
    {
      id: "charsets.utf8",
      minCols: 5,
      before: [..."Axy?Z"],
      after: ["A", "é", "世", "", "Z"],
      ignored: ["A", "x", "y", "?", "Z"],
      wrong: ["A", "é", "?", "", "Z"],
      trigger: "世",
      targetCol: 1,
      required: ["é", "世"],
    },
    {
      id: "charsets.g0-g1-switching",
      minCols: 5,
      before: [..."AlllZ"],
      after: [..."Al┌lZ"],
      ignored: [..."AlllZ"],
      wrong: [..."Al☃lZ"],
      trigger: "\x0e",
      targetCol: 1,
      required: ["\x1b(B", "\x1b)0", "\x0e", "\x0f", "\x1b)B"],
    },
    {
      id: "charsets.dec-line-drawing",
      minCols: 7,
      before: [..."jklmqxj"],
      after: [..."┘┐┌└─│j"],
      ignored: [..."jklmqxj"],
      wrong: [..."☃┐┌└─│j"],
      trigger: "\x1b(0jklmqx",
      targetCol: 0,
      required: ["\x1b(0", "\x1b(B"],
    },
  ] as const

  test("valid controls bind exact glyph support and ignored-target negatives to raw cells", () => {
    for (const item of cases) {
      const callback = probe(item.id).lib
      if (!callback) throw new Error(`${item.id} needs a headless callback`)
      for (const [after, outcome] of [
        [item.after, "supported"],
        [item.ignored, "unsupported"],
        [item.wrong, "unsupported"],
      ] as const) {
        const writes: string[] = []
        let applied = false
        let cursorX = 0
        let cursorY = 0
        const base = context({})
        const result = callback(
          context({
            feed(bytes) {
              writes.push(bytes)
              const cup = /^\x1b\[(\d+);(\d+)H$/.exec(bytes)
              if (cup) {
                cursorY = Number(cup[1]) - 1
                cursorX = Number(cup[2]) - 1
              }
              if (bytes.includes(item.trigger)) applied = true
            },
            getCursor() {
              return { x: cursorX, y: cursorY, visible: true, style: "block" }
            },
            getCell(row, col) {
              return { ...base.getCell(row, col), char: (applied ? after : item.before)[col] ?? "" }
            },
          }),
        )
        expect(result.observation, item.id).toMatchObject({ outcome, assertionType: "buffer_state" })
        expect(JSON.parse(result.response ?? "null"), item.id).toMatchObject({
          // The kind reads a GRID: one string[] per compared row, one entry per compared column.
          before: [item.before],
          after: [after],
          setup:
            item.id === "charsets.utf8"
              ? [
                  { x: 1, y: 0 },
                  { x: 2, y: 0 },
                ]
              : [{ x: item.targetCol, y: 0 }],
        })
        expect(result.assertions, item.id).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
        expect(result.assertions?.[0]?.observed, item.id).toBe(result.response)
        for (const bytes of item.required) expect(writes.join(""), item.id).toContain(bytes)
        if (item.id !== "charsets.utf8") expect(writes.at(-1), item.id).toBe("\x0f\x1b(B\x1b)B")
      }
    }
  })

  test("bad seed or broken ASCII control is inconclusive, and narrow geometry writes nothing", () => {
    for (const item of cases) {
      const callback = probe(item.id).lib
      if (!callback) throw new Error(`${item.id} needs a headless callback`)
      for (const badPhase of ["before", "after"] as const) {
        let applied = false
        let cursorX = 0
        const base = context({})
        const result = callback(
          context({
            feed(bytes) {
              const cup = /^\x1b\[1;(\d+)H$/.exec(bytes)
              if (cup) cursorX = Number(cup[1]) - 1
              if (bytes.includes(item.trigger)) applied = true
            },
            getCursor() {
              return { x: cursorX, y: 0, visible: true, style: "block" }
            },
            getCell(row, col) {
              const values: string[] = applied ? [...item.after] : [...item.before]
              if (badPhase === "before" && !applied) values[0] = "!"
              if (badPhase === "after" && applied) values[item.id === "charsets.dec-line-drawing" ? 6 : 0] = "!"
              return { ...base.getCell(row, col), char: values[col] ?? "" }
            },
          }),
        )
        expect(result.observation, `${item.id} ${badPhase}`).toMatchObject({
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "buffer_state",
        })
        expect(result.assertions ?? [], item.id).toEqual([])
      }
      const writes: string[] = []
      const narrow = callback(
        context({
          cols: item.minCols - 1,
          feed(bytes) {
            writes.push(bytes)
          },
        }),
      )
      expect(writes, item.id).toEqual([])
      expect(narrow.observation, item.id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "buffer_state",
      })
      expect(JSON.parse(narrow.response ?? "null"), item.id).toMatchObject({ cols: item.minCols - 1 })
    }
    const switching = probe("charsets.g0-g1-switching").lib
    if (!switching) throw new Error("G0/G1 needs a headless callback")
    const writes: string[] = []
    const base = context({})
    let cursorX = 0
    expect(() =>
      switching(
        context({
          feed(bytes) {
            writes.push(bytes)
            if (bytes === "\x1b[1;2H") cursorX = 1
            if (bytes.includes("\x0e")) throw new Error("fixture feed failed")
          },
          getCursor() {
            return { x: cursorX, y: 0, visible: true, style: "block" }
          },
          getCell(row, col) {
            return { ...base.getCell(row, col), char: "AlllZ"[col] ?? "" }
          },
        }),
      ),
    ).toThrow("fixture feed failed")
    expect(writes.at(-1)).toBe("\x0f\x1b(B\x1b)B")
  })

  test("ignored target CUP stops before charset bytes instead of blaming the charset", () => {
    for (const item of cases) {
      const callback = probe(item.id).lib
      if (!callback) throw new Error(`${item.id} needs a headless callback`)
      const writes: string[] = []
      const base = context({})
      const wrongX = item.targetCol === 0 ? 1 : 0
      const result = callback(
        context({
          feed(bytes) {
            writes.push(bytes)
          },
          getCursor() {
            return { x: wrongX, y: 0, visible: true, style: "block" }
          },
          getCell(row, col) {
            return { ...base.getCell(row, col), char: item.before[col] ?? "" }
          },
        }),
      )
      expect(result.observation, item.id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "buffer_state",
      })
      expect(JSON.parse(result.response ?? "null"), item.id).toMatchObject({ setup: [{ x: wrongX, y: 0 }] })
      expect(result.assertions ?? [], item.id).toEqual([])
      expect(writes.join(""), item.id).not.toContain(item.trigger)
    }

    const utf8 = probe("charsets.utf8").lib
    if (!utf8) throw new Error("UTF-8 needs a headless callback")
    const writes: string[] = []
    const base = context({})
    let cursorX = 0
    const second = utf8(
      context({
        feed(bytes) {
          writes.push(bytes)
          if (bytes === "\x1b[1;2H") cursorX = 1
          if (bytes === "\x1b[1;3H") cursorX = 1 // second CUP ignored
        },
        getCursor() {
          return { x: cursorX, y: 0, visible: true, style: "block" }
        },
        getCell(row, col) {
          return { ...base.getCell(row, col), char: "Axy?Z"[col] ?? "" }
        },
      }),
    )
    expect(second.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(JSON.parse(second.response ?? "null")).toMatchObject({
      setup: [
        { x: 1, y: 0 },
        { x: 1, y: 0 },
      ],
    })
    expect(writes.join("")).toContain("é")
    expect(writes.join("")).not.toContain("世")
    expect(second.assertions ?? []).toEqual([])
  })
})

describe("partial probe automation candidates", () => {
  // S8: state recognition is measurable while the independent presentation facet remains unmeasured.
  test("modes.decsclm measures mode state and names unmeasured smooth-scroll presentation", () => {
    const p = probe("modes.decsclm")
    if (!p.lib) throw new Error("Missing headless DECSCLM callback")
    const seen: string[] = []
    let enabled = false
    const result = p.lib(
      context({
        feed: (text) => {
          seen.push(text)
          if (text === "\x1b[?4h") enabled = true
          if (text === "\x1b[?4l") enabled = false
        },
        getMode: (mode) => (mode === "insertMode" ? false : enabled),
        feedCapture: (text) => {
          seen.push(text)
          return enabled ? "\x1b[?4;1$y" : "\x1b[?4;2$y"
        },
      }),
    )
    expect(result.observation).toMatchObject({
      outcome: "supported",
      assertionType: "query_reply",
      note: expect.stringContaining("smooth-scroll presentation unmeasured in lib arm"),
    })
    expect(result.notTested).toBeUndefined()
    expect(result.assertions).toMatchObject([{ kind: "positive", assertionType: "query_reply" }])
    expect(seen).toEqual(["\x1b[?4h", "\x1b[?4$p", "\x1b[?4l", "\x1b[?4$p"])
  })

  // Mode metadata cannot substitute for the library arm's required DECRPM reply.
  // The recognition table covers answered queries; this case owns missing replies and cleanup.
  test.each([true, false, null] as const)(
    "mode 2031 retains missing DECRPM coverage despite metadata %s",
    (enabled) => {
      const p = probe("modes.color-scheme-reporting")
      if (!p.lib) throw new Error("Missing headless color-scheme callback")
      const seen: string[] = []
      const result = p.lib(
        context({
          getMode: () => enabled,
          feed: (text) => seen.push(text),
          feedCapture: (text) => {
            seen.push(text)
            return ""
          },
        }),
      )
      expect(result.notTested).toMatchObject({
        reason: "no-semantic-observable",
        noObservable: "DECRPM reply to CSI ? 2031 $ p",
      })
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(seen).toEqual(["\x1b[?2031h", "\x1b[?2031$p", "\x1b[?2031l", "\x1b[?2031$p"])
    },
  )

  test("device.dsr-996-color-scheme verifies the color-scheme response", () => {
    const p = probe("device.dsr-996-color-scheme")
    expect(p.lib).toBeTypeOf("function")

    const result = p.lib!(
      context({
        feedCapture(text) {
          expect(text).toBe("\x1b[?996n")
          return "\x1b[?997;1n"
        },
      }),
    )

    expect(result.pass).toBe(true)
    expect(result.response).toBe("\x1b[?997;1n")
  })

  test("OSC 113/114 reset probes require original, changed, and restored color replies", () => {
    const cases = [
      {
        id: "extensions.osc113-reset-pointer-fg",
        expected: "\x1b]13;?\x07",
        set: 13,
        original: "\x1b]13;rgb:1010/2020/3030\x1b\\",
        changed: "\x1b]13;rgb:aaaa/bbbb/cccc\x1b\\",
        reset: "\x1b]113\x07",
      },
      {
        id: "extensions.osc114-reset-pointer-bg",
        expected: "\x1b]14;?\x07",
        set: 14,
        original: "\x1b]14;rgb:1010/2020/3030\x1b\\",
        changed: "\x1b]14;rgb:aaaa/bbbb/cccc\x1b\\",
        reset: "\x1b]114\x07",
      },
    ]

    for (const c of cases) {
      const p = probe(c.id)
      // C4: OSC13/14 do not dispatch the native host-colour recipes; keep their criterion unchanged.
      // Reply-only assertions miss an accidental palette-input declaration from the shared reset factory.
      expect(p.libHostRecipes).toBeUndefined()
      expect(p.lib).toBeTypeOf("function")
      const feed: string[] = []
      const capture: string[] = []
      const replies = [c.original, c.changed, c.original]
      const result = p.lib!(
        context({
          feed(text) {
            feed.push(text)
          },
          feedCapture(text) {
            capture.push(text)
            return replies.shift() ?? ""
          },
        }),
      )
      expect(result.pass).toBe(true)
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive" }])
      expect(capture).toEqual([c.expected, c.expected, c.expected])
      expect(feed).toEqual([`\x1b]${c.set};rgb:aa/bb/cc\x07`, c.reset])
      expect(replies).toEqual([])
      // C4: unreadable pointer slots keep their old no-mutation path, with and without a sentinel.
      // The positive readback above cannot expose seed/reset writes made before a missing prerequisite.
      for (const qualified of [false, true]) {
        const calls: string[] = []
        const empty = p.lib!(
          context({
            runtimeIdentity: nativeIdentity,
            feed: (text) => {
              calls.push(text)
            },
            feedCapture: (text) => {
              calls.push(text)
              return ""
            },
            ...(qualified && {
              queryWithSentinelOutcome: (text: string) => {
                calls.push(text)
                return {
                  match: null,
                  reason: "sentinel" as const,
                  raw: "\x1b[?1;2c",
                  rawBase64: "G1s/MTsyYw==",
                  sentinel: { atMs: 0, graceMs: 250 },
                }
              },
            }),
          }),
        )
        expect(calls).toEqual([c.expected])
        expect(empty.hostRecipeCauses).toBeUndefined()
        expect(empty.criterionBranch).toBe(qualified ? undefined : "color-readback-review")
      }
    }
  })

  function colorStackFixture(
    failedQuery?: number,
    failedFeed?: "mutation" | "pop" | "restore",
    queryError: unknown = new Error("foreground query unavailable"),
    options: { initialEmpty?: boolean; stackWorks?: boolean } = {},
  ) {
    const original = "rgb:1010/2020/3030"
    let current: string | null = options.initialEmpty ? null : original
    const stack: Array<string | null> = []
    const writes: string[] = []
    let queries = 0
    let feedFailed = false
    const ctx: LibProbeSource = context({
      feed(sequence) {
        writes.push(sequence)
        const action = sequence.includes("]30101")
          ? "pop"
          : sequence.includes(`]10;${original}`)
            ? "restore"
            : sequence.includes("]10;")
              ? "mutation"
              : "push"
        if (!feedFailed && action === failedFeed) {
          feedFailed = true
          throw new Error(`${action} unavailable`)
        }
        if (sequence.includes("]110")) current = null
        else if (sequence.includes("]30001")) {
          if (options.stackWorks !== false) stack.push(current)
        } else if (sequence.includes("]30101")) {
          if (options.stackWorks !== false) current = stack.pop() ?? current
        } else current = /\x1b\]10;(rgb:[a-f\d/]+)/i.exec(sequence)?.[1] ?? current
      },
      feedCapture(sequence) {
        if (sequence !== "\x1b]10;?\x07") {
          ctx.feed(sequence)
          return ""
        }
        if (++queries === failedQuery) throw queryError
        return current === null ? "" : `\x1b]10;${current}\x1b\\`
      },
    })
    return { ctx, original, writes, foreground: () => current, stackDepth: () => stack.length }
  }

  // Requirement: a verified chosen current colour exposes the stack effect even without an embedder default.
  // Existing fixtures start with an observable original, so they miss the silent-initial early return.
  test.each([true, false])("measures a verified current-colour stack fixture (stack works: %s)", (stackWorks) => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const fixture = colorStackFixture(undefined, undefined, undefined, { initialEmpty: true, stackWorks })
      const result = probe(id).lib!(fixture.ctx)
      expect(result.observation).toMatchObject({
        outcome: stackWorks ? "supported" : "unsupported",
        assertionType: "query_reply",
      })
      expect(result.note).toContain("verified seeded current")
      expect(result.assertions).toMatchObject([{ kind: stackWorks ? "positive" : "negative" }])
      expect(result.criterionBranch).toBeUndefined()
      const raw = JSON.parse(result.response!) as {
        fixture: { name: string; color: string }
        trace: Array<{ write: string; response: string }>
      }
      expect(raw.fixture).toEqual({ name: "verified seeded current", color: "rgb:aa/bb/cc" })
      expect(raw.trace[0]).toEqual({ write: "\x1b]10;?\x07", response: "" })
      expect(raw.trace.at(-2)).toEqual({ write: "\x1b]110\x07", response: "" })
      expect(raw.trace.at(-1)).toEqual({ write: "\x1b]10;?\x07", response: "" })
      expect(fixture.foreground()).toBeNull()
      expect(fixture.stackDepth()).toBe(0)
    }
  })

  test.each([
    { name: "silent", seeded: "", setter: "", status: "probe-todo" },
    { name: "wrong value", seeded: "\x1b]10;rgb:00/00/00\x07", setter: "", status: "probe-invalid" },
    { name: "wrong slot", seeded: "\x1b]11;rgb:aa/bb/cc\x07", setter: "", status: "probe-invalid" },
    { name: "partial", seeded: "\x1b]10;rgb:aa/bb/cc", setter: "", status: "probe-invalid" },
    { name: "extra", seeded: "extra\x1b]10;rgb:aa/bb/cc\x07", setter: "", status: "probe-invalid" },
    {
      name: "multiple",
      seeded: "\x1b]10;rgb:aa/bb/cc\x07\x1b]10;rgb:aa/bb/cc\x07",
      setter: "",
      status: "probe-invalid",
    },
    { name: "setter acknowledgement", seeded: "\x1b]10;rgb:aa/bb/cc\x07", setter: "ack", status: "probe-invalid" },
  ])("does not infer a stack effect from $name setup", ({ seeded, setter, status }) => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const stackQuery = id === "extensions.osc30001-color-stack-push" ? "\x1b]30001\x1b\\" : "\x1b]30101\x1b\\"
      let queries = 0
      const seen: string[] = []
      const result = probe(id).lib!(
        context({
          feedCapture(sequence) {
            seen.push(sequence)
            if (sequence === "\x1b]10;?\x07") return ++queries === 2 ? seeded : ""
            if (sequence === "\x1b]10;rgb:aa/bb/cc\x07") return setter
            if (sequence === stackQuery) return ""
            expect(sequence).toBe("\x1b]110\x07")
            return ""
          },
        }),
      )
      expect(result).toMatchObject({ pass: false, tests: [{ status }] })
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.criterionBranch).toBe(status === "probe-todo" ? "color-readback-review" : undefined)
      expect(seen).toEqual([
        "\x1b]10;?\x07",
        "\x1b]10;rgb:aa/bb/cc\x07",
        "\x1b]10;?\x07",
        "\x1b]110\x07",
        "\x1b]10;?\x07",
        stackQuery,
      ])
      const raw = JSON.parse(result.response!) as { trace: unknown[] }
      expect(raw.trace.at(-1)).toEqual({ write: stackQuery, response: "" })
      expect(raw).toMatchObject({
        originalRaw: "",
        trace: expect.arrayContaining([
          { write: "\x1b]10;?\x07", response: "" },
          { write: "\x1b]10;?\x07", response: seeded },
        ]),
      })
    }
  })

  test.each([
    { name: "initial query", query: 1 },
    { name: "setter", setter: true },
    { name: "seed query", query: 2 },
    { name: "changed query", query: 3 },
    { name: "restored query", query: 4 },
    { name: "reset", reset: true },
    { name: "post-reset query", query: 5 },
    { name: "setter and reset", setter: true, reset: true },
    { name: "changed query and cleanup pop", query: 3, pop: true },
  ] as const)("preserves seeded stack $name failures and cleanup", (row) => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const fixture = colorStackFixture(undefined, undefined, undefined, { initialEmpty: true })
      const originalCapture = fixture.ctx.feedCapture.bind(fixture.ctx)
      const seen: string[] = []
      let queries = 0
      fixture.ctx.feedCapture = (sequence) => {
        seen.push(sequence)
        const response = originalCapture(sequence)
        if (sequence === "\x1b]10;?\x07" && ++queries === ("query" in row ? row.query : -1)) {
          throw new Error(`${row.name} primary`)
        }
        if ("setter" in row && sequence === "\x1b]10;rgb:aa/bb/cc\x07") throw new Error("setter primary")
        if ("reset" in row && sequence === "\x1b]110\x07") throw new Error("reset cleanup")
        if ("pop" in row && sequence === "\x1b]30101\x1b\\") throw new Error("pop cleanup")
        return response
      }
      const result = probe(id).lib!(fixture.ctx)
      expect(result).toMatchObject({ pass: false, tests: [{ status: "probe-invalid" }] })
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.note).toContain("failed: Error:")
      if (row.name === "initial query") {
        expect(fixture.writes).toEqual([])
        expect(result.response).toBeUndefined()
      } else {
        expect(seen.at(-2)).toBe("\x1b]110\x07")
        expect(seen.at(-1)).toBe("\x1b]10;?\x07")
        expect(fixture.foreground()).toBeNull()
        expect(result.response).toContain("trace")
      }
      if (row.name === "setter and reset") {
        expect(result.note).toContain("setter primary")
        expect(result.note).toContain("reset cleanup")
      }
    }
  })

  test("an unexpected seeded primary survives a reset failure and still attempts post-reset read", () => {
    const primary = "unexpected seeded setter failure"
    const fixture = colorStackFixture(undefined, undefined, undefined, { initialEmpty: true })
    const originalCapture = fixture.ctx.feedCapture.bind(fixture.ctx)
    const seen: string[] = []
    fixture.ctx.feedCapture = (sequence) => {
      seen.push(sequence)
      const response = originalCapture(sequence)
      if (sequence === "\x1b]10;rgb:aa/bb/cc\x07") throw primary
      if (sequence === "\x1b]110\x07") throw new Error("reset unavailable")
      return response
    }
    let caught: unknown
    try {
      probe("extensions.osc30001-color-stack-push").lib!(fixture.ctx)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    if (!(caught instanceof AggregateError)) throw new Error("expected primary and cleanup failures")
    expect(caught.errors).toContain(primary)
    expect(caught.message).toContain("reset unavailable")
    expect(seen.at(-1)).toBe("\x1b]10;?\x07")
    expect(fixture.foreground()).toBeNull()
  })

  test("OSC 30001/30101 probes verify color stack restore behavior", () => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const p = probe(id)
      expect(p.lib).toBeTypeOf("function")
      const fixture = colorStackFixture()
      const result = p.lib!(fixture.ctx)
      expect(result.pass).toBe(true)
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(fixture.foreground()).toBe(fixture.original)
      expect(fixture.stackDepth()).toBe(0)
    }
  })

  /**
   * @failure Operational color-stack failures lose their observing method or cleanup leaves a success/assertion behind.
   * @level l0
   * @consumer Headless collectors recording both unmarked OSC color-stack callbacks.
   * @testonly none
   */
  test.each([
    { action: "initial query", failedQuery: 1, assertionType: "query_reply" },
    { action: "foreground mutation", failedFeed: "mutation", assertionType: "query_reply" },
    { action: "query after mutation", failedQuery: 2, assertionType: "query_reply" },
    { action: "stack pop", failedFeed: "pop", assertionType: "query_reply" },
    { action: "query after pop", failedQuery: 3, assertionType: "query_reply" },
    { action: "cleanup restore", failedFeed: "restore", assertionType: "query_reply" },
    { action: "query and cleanup restore", failedQuery: 2, failedFeed: "restore", assertionType: "query_reply" },
    { action: "query and cleanup pop", failedQuery: 2, failedFeed: "pop", assertionType: "query_reply" },
  ] as const)("color-stack $action failures retain their method and named diagnostics", (row) => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const fixture = colorStackFixture(
        "failedQuery" in row ? row.failedQuery : undefined,
        "failedFeed" in row ? row.failedFeed : undefined,
      )
      const definition = probe(id)
      expect(definition.libAssertionType).toBeUndefined()
      const result = definition.lib!(fixture.ctx)
      expect(result.pass).toBe(false)
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({ status: "probe-invalid", reason: expect.stringContaining("failed: Error:") }),
      ])
      expect(result.note).toContain("Error:")
      expect(result.response).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      if ("failedQuery" in row) expect(result.note).toContain("foreground query unavailable")
      if ("failedFeed" in row) expect(result.note).toContain(`${row.failedFeed} unavailable`)
      if (row.action.startsWith("query and cleanup")) {
        expect(result.note).toContain("cleanup")
        expect(result.note).toContain("behavior")
      }
      // #31904: the fixtures set non-default foregrounds, so only a successful cleanup restore returns
      // the original; a failed one leaves a fixture colour behind and is the reported probe-invalid.
      if (row.action.includes("cleanup restore")) expect(fixture.foreground()).not.toBe(fixture.original)
      else expect(fixture.foreground()).toBe(fixture.original)
      if (row.action === "initial query") expect(fixture.writes).toEqual([])
      else expect(fixture.writes.at(-1)).toBe(`\x1b]10;${fixture.original}\x07`)
      if (row.action === "query and cleanup pop") {
        expect(fixture.writes.some((sequence) => sequence.includes("]30101"))).toBe(true)
      } else expect(fixture.stackDepth()).toBe(0)
    }
  })

  /**
   * @failure A cleanup error replaces an unexpected primary throw and is falsely graded.
   * @level l0
   * @consumer Headless collectors leaving unexpected callback throws ungraded.
   * @testonly none
   */
  test("unexpected color-stack throws remain ungraded and survive a cleanup failure", () => {
    const primary = "unexpected query adapter throw"
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const fixture = colorStackFixture(2, "restore", primary)
      let caught: unknown
      try {
        probe(id).lib!(fixture.ctx)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AggregateError)
      if (!(caught instanceof AggregateError)) throw new Error("expected both callback and cleanup failures")
      expect(caught.errors).toContain(primary)
      expect(caught.message).toContain(primary)
      expect(caught.message).toContain("restore unavailable")
      expect(fixture.writes.some((sequence) => sequence.includes("]30101"))).toBe(true)
      expect(fixture.writes.at(-1)).toBe(`\x1b]10;${fixture.original}\x07`)
    }
  })

  // #31904 R3a: the app arm runs the same two fixtures. A pop that resets to the starting foreground
  // passed both rows when the single fixture restored that colour; now neither row passes, and a
  // stale push snapshot is a push-only negative.
  test.each([
    ["reset-default", "extensions.osc30001-color-stack-push", "probe-todo"],
    ["reset-default", "extensions.osc30101-color-stack-pop", "probe-todo"],
    ["stale", "extensions.osc30001-color-stack-push", "unsupported"],
    ["stale", "extensions.osc30101-color-stack-pop", "supported"],
  ] as const)("a %s app colour stack grades %s %s", async (kind, id, outcome) => {
    const original = "rgb:1010/2020/3030"
    let current: string = original
    const stack: string[] = []
    const result = await probe(id).term!(
      terminalSource({
        write(sequence) {
          if (sequence.includes("]30001")) {
            if (kind !== "stale" || stack.length === 0) stack.push(current)
          } else if (sequence.includes("]30101")) {
            if (kind === "reset-default") {
              stack.pop()
              current = original
            } else current = stack.at(-1) ?? current
          } else {
            const set = /\x1b\]10;(rgb:[a-f\d/]+)(?:\x07|\x1b\\)/i.exec(sequence)
            if (set) current = set[1] ?? current
          }
        },
        queryWithSentinelOutcome: async (_sequence, pattern) => {
          const raw = `\x1b]10;${current}\x1b\\`
          return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
        },
      }),
    )
    if (outcome === "probe-todo") expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
    else expect(result.observation?.outcome).toBe(outcome)
    expect(current).toBe(original)
  })

  // A CPR after an ignored OSC is not a color-stack reply; the original foreground must survive errors too.
  test("Kitty color-stack probes require a changed and restored foreground without leaking probe color", async () => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      for (const [original, stackWorks] of [
        ["rgb:1010/2020/3030", true],
        ["rgb:1010/2020/3030", false],
        ["rgb:aaaa/bbbb/cccc", true],
      ] as const) {
        let current: string = original
        const stack: string[] = []
        const writes: string[] = []
        const result = await probe(id).term!(
          terminalSource({
            write(sequence) {
              writes.push(sequence)
              if (sequence.includes("]30001")) {
                if (stackWorks) stack.push(current)
              } else if (sequence.includes("]30101")) {
                if (stackWorks) current = stack.pop() ?? current
              } else {
                const set = /\x1b\]10;(rgb:[a-f\d/]+)(?:\x07|\x1b\\)/i.exec(sequence)
                if (set) current = set[1] ?? current
              }
            },
            queryWithSentinelOutcome: async (sequence, pattern) => {
              expect(sequence).toBe("\x1b]10;?\x07")
              const raw = `\x1b]10;${current}\x1b\\`
              return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
            },
          }),
        )
        expect(result.observation?.outcome).toBe(stackWorks ? "supported" : "unsupported")
        expect(current).toBe(original)
        expect(writes.some((sequence) => sequence.includes("]30001"))).toBe(true)
        expect(writes.some((sequence) => sequence.includes("]30101"))).toBe(true)
      }

      const writes: string[] = []
      let queries = 0
      await expect(
        probe(id).term!(
          terminalSource({
            write(sequence) {
              writes.push(sequence)
            },
            queryWithSentinelOutcome: async (_sequence, pattern) => {
              if (++queries === 2) throw new Error("query failed after color change")
              const raw = "\x1b]10;rgb:1010/2020/3030\x1b\\"
              return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
            },
          }),
        ),
      ).rejects.toThrow("query failed after color change")
      expect(writes.some((sequence) => sequence.includes("]30101"))).toBe(true)
      expect(writes.some((sequence) => sequence.includes("]10;rgb:1010/2020/3030"))).toBe(true)

      const noReplyWrites: string[] = []
      const noReply = await probe(id).term!(
        terminalSource({
          write: (sequence) => noReplyWrites.push(sequence),
          queryWithSentinelOutcome: async () => {
            const raw = "\x1b]10;rgb:1010/2020/3030\x1b\\"
            return { match: null, reason: "timeout", raw, rawBase64: btoa(raw) }
          },
        }),
      )
      expect(noReply.observation).toEqual({
        outcome: "inconclusive",
        assertionType: "query_reply",
        reason: "timeout",
        note: "No original OSC 10 foreground reply; color stack was not changed",
      })
      expect(noReply.response).toBe("\x1b]10;rgb:1010/2020/3030\x1b\\")
      expect(noReply.assertions).toBeUndefined()
      expect(noReply.tests).toBeUndefined()
      expect(noReplyWrites).toEqual([])
    }
  })

  test("mode 2031 requires its own DECRPM recognition, not a separate color-scheme query", async () => {
    const p = probe("modes.color-scheme-reporting")
    for (const [ps, outcome] of [
      [1, "supported"],
      [2, "unsupported"],
      [3, "supported"],
      [4, "unsupported"],
      [0, "unsupported"],
      [null, "inconclusive"],
    ] as const) {
      const result = await p.term!(
        terminalSource({
          queryMode: async () => {
            throw new Error("the 2031 arm reads Ps through queryWithSentinel, never the folded word (#30557)")
          },
          queryWithSentinel: async (sequence, pattern) => {
            if (sequence === "\x1b[?2031$p") return ps === null ? null : pattern.exec(`\x1b[?2031;${ps}$y`)
            return ["\x1b[?997;1n", "1"]
          },
        }),
      )
      if (ps === null) {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "probe-todo",
            reason: "no DECRPM reply",
          }),
        ])
      } else {
        expect(result.observation, `Ps ${ps}`).toMatchObject({ outcome, assertionType: "query_reply" })
      }
      if (ps === 4) {
        expect(result.assertions, "Ps 4").toMatchObject([
          {
            kind: "negative",
            expected: "DECRPM mode 2031 set or permanently set",
            observed: JSON.stringify({ snapshot: 4 }),
          },
        ])
      }
    }
  })

  test("DSR 996 accepts only complete 997 dark/light replies", async () => {
    const p = probe("device.dsr-996-color-scheme")
    for (const [raw, outcome] of [
      ["\x1b[?997;1n", "supported"],
      ["\x1b[?997;2n", "supported"],
      ["\x1b[?997;9n", "inconclusive"],
      ["\x1b[?997;1", "inconclusive"],
    ] as const) {
      const result = await p.term!(
        terminalSource({
          queryWithSentinelOutcome: async (sequence, pattern) => {
            expect(sequence).toBe("\x1b[?996n")
            return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
          },
        }),
      )
      expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
    }
  })

  // #32026: explicit callbacks catch all 26 marks, including the distinct OSC133;D subcode. Since #32246 none of them
  // may take a source-negative buffer-state arm at the formerly audited vterm identities.
  test.each([
    [
      "vt100",
      "b941dae48b25ae8825c394750bda5245c9d93dfa",
      "99833d737402f9d1d8e3e257e3a255d8aa1facc3",
      "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a",
    ],
    [
      "vt220",
      "4205f8936ad1848d1029729f3ada888cd61759a8",
      "601dd26eb7e753a5396ebdf72f1ef8ee2cc4355f",
      "7369e3710e36aa649372fd09011ecfdd6ba47c73",
    ],
  ])(
    "%s semantic marks grade nothing from source at the formerly audited identity",
    (engine, treeOid, indexBlob, backendBlob) => {
      const runtimeIdentity = {
        kind: "js",
        runtimeFormat: "js",
        engineVersion: "0.10.1",
        adapterVersion: "0.10.2",
        termlessRevision:
          engine === "vt220" ? "a871f0e580e1b02fb5dbb7ed854f6de623e7858e" : "2d97417328b7b1d086f9396b9a1731216ed134cc",
        resolvedPath: `vendor/vterm/packages/${engine}/src/index.ts`,
        integrity: {
          kind: "source",
          repository: "git@github.com:beorn/vterm.git",
          revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
          treeOid: treeOid!,
          cleanTree: true,
        },
        adapterSources: [
          { path: `packages/${engine}/src/index.ts`, blobOid: indexBlob! },
          { path: `packages/${engine}/src/backend.ts`, blobOid: backendBlob! },
        ],
      } satisfies NonNullable<LibProbeSource["runtimeIdentity"]>
      const cases = [
        ...OSC_SEMANTIC_MARK_CASES,
        ["extensions.semantic-prompts", "\x1b]133;A\x07"],
        ["extensions.osc-633-vscode", "\x1b]633;A\x07"],
      ] as const
      for (const [id, sequence] of cases) {
        const feeds: string[] = []
        const run = (identity: NonNullable<LibProbeSource["runtimeIdentity"]>, char = "X") =>
          probe(id!).lib!(
            context({
              runtimeIdentity: identity,
              feed: (text) => {
                feeds.push(text)
              },
              getCell: () => ({ ...context({}).getCell(0, 0), char }),
            }),
          )
        const result = run(runtimeIdentity)
        if ((OSC_SEMANTIC_MARK_IDS as readonly string[]).includes(id)) expect(feeds.join(""), id).toContain(sequence)
        // #32246: no semantic source audit decides the mark; the formerly audited identity reads as any other.
        expect(result.criterionBranch, id).not.toBe("source-negative-review")
        expect(result.observation, id).toBeUndefined()
        expect(result.assertions, id).toBeUndefined()
        expect(
          run({ ...runtimeIdentity, integrity: { ...runtimeIdentity.integrity, treeOid: "0".repeat(40) } }),
          id,
        ).toEqual(result)
        expect(run({ ...runtimeIdentity, adapterSources: [] }), id).toEqual(result)
      }
    },
  )

  test("semantic prompt OSC consumption and CPR do not claim prompt integration", async () => {
    // Constant 1;2 CPR for every read must never qualify as a measured home / target / control sequence.
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      const result = await probe(id).term!(terminalSource({ queryCursorPosition: async () => ({ row: 1, col: 2 }) }))
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({
          status: "probe-todo",
          reason: "Marker consumption was not confirmed; shell prompt integration was not observed",
        }),
      ])
    }
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      const result = await probe(id).term!(terminalSource({ queryCursorPosition: async () => null }))
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({ status: "probe-invalid", reason: "No cursor reply after semantic prompt marker" }),
      ])
    }
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      // Constant 1;1 CPR: target never advances from home, so consumption is false and no coverage is claimed.
      const result = await probe(id).term!(terminalSource({ queryCursorPosition: async () => ({ row: 1, col: 1 }) }))
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({
          status: "probe-todo",
          reason: "Marker consumption was not confirmed; shell prompt integration was not observed",
        }),
      ])
    }
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      // Consumed-but-unqualified: home 1;1 -> target 1;2 advances, but control stays 1;2 instead of returning to 1;1.
      const reads = [
        { row: 1, col: 1 },
        { row: 1, col: 2 },
        { row: 1, col: 2 },
      ]
      let read = 0
      const result = await probe(id).term!(terminalSource({ queryCursorPosition: async () => reads[read++] ?? null }))
      expect(read).toBe(3)
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result).toMatchObject({
        tests: [
          expect.objectContaining({
            status: "probe-todo",
            reason: "Marker was consumed; shell prompt integration was not observed",
          }),
        ],
      })
    }
    const noPromptMetadata = await probe("extensions.semantic-prompts").term!(
      terminalSource({ queryCursorPosition: async () => null }),
    )
    expect(noPromptMetadata.observation).toBeUndefined()
    expect(noPromptMetadata.tests).toEqual([
      {
        id: "criterion",
        status: "probe-todo",
        reason: "No shell prompt integration metadata or behavior readback for OSC 133",
      },
    ])
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      // Qualified cursor movement (0,0 -> 1,0 -> 0,0) with empty or non-X cell: consumed && keeps this inconclusive.
      for (const char of ["", "-"]) {
        const reads = [
          { x: 0, y: 0, visible: true, style: "block" as const },
          { x: 1, y: 0, visible: true, style: "block" as const },
          { x: 0, y: 0, visible: true, style: "block" as const },
        ]
        let read = 0
        const base = context({})
        const result = probe(id).lib!(
          context({
            getCursor: () => reads[read++] ?? reads[2]!,
            getCell(row, col) {
              return { ...base.getCell(row, col), char }
            },
          }),
        )
        expect(read, `${id} char=${JSON.stringify(char)}`).toBe(3)
        expect(result.notTested, `${id} char=${JSON.stringify(char)}`).toBeUndefined()
        expect(result.observation, `${id} char=${JSON.stringify(char)}`).toBeUndefined()
        expect(result, `${id} char=${JSON.stringify(char)}`).toMatchObject({
          tests: [
            expect.objectContaining({
              status: "probe-todo",
              reason: "Marker consumption was not confirmed; shell prompt integration was not observed",
            }),
          ],
        })
      }
    }
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      // Constant cursor (0,0) with cell.char === "X": consumed is true, but cursor motion is unqualified.
      const result = probe(id).lib!(context({ getCell: () => ({ ...context({}).getCell(0, 0), char: "X" }) }))
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result).toMatchObject({
        tests: [
          expect.objectContaining({
            status: "probe-todo",
            reason: "Marker was consumed; shell prompt integration was not observed",
          }),
        ],
      })
    }
  })

  test("semantic prompt app callbacks record named not-tested coverage for a measured home/target/control sequence", async () => {
    const marks = new Set<string>()
    for (const [id, sequence] of OSC_SEMANTIC_MARK_CASES) {
      const writes: string[] = []
      const reads = [
        { row: 1, col: 1 },
        { row: 1, col: 2 },
        { row: 1, col: 1 },
      ]
      let read = 0
      const result = await probe(id).term!(
        terminalSource({
          write: (data) => {
            writes.push(data)
          },
          queryCursorPosition: async () => reads[read++] ?? null,
        }),
      )
      expect(writes, id).toEqual(["\x1b[1;1H\x1b[2K", `${sequence}X`, "\x1b[1;1H"])
      expect(read, id).toBe(3)
      expect(result.observation, id).toBeUndefined()
      expect(result.assertions ?? [], id).toHaveLength(0)
      expect(result.notTested, id).toMatchObject({ reason: "no-semantic-observable" })
      expect((result.notTested?.noObservable ?? "").trim().length, id).toBeGreaterThan(0)
      expect(JSON.parse(result.response ?? "{}"), id).toEqual({
        home: reads[0],
        target: reads[1],
        control: reads[2],
      })
      marks.add(result.notTested!.noObservable)
    }
    expect(marks.size).toBe(OSC_SEMANTIC_MARK_IDS.length)
  })

  test("mintty and rxvt query probes verify typed OSC responses", () => {
    const cases = [
      ["extensions.osc7770-font-size", "\x1b]7770;?\x07", "\x1b]7770;12\x1b\\"],
      ["extensions.osc7777-font-window-size", "\x1b]7777;?\x07", "\x1b]7777;12\x1b\\"],
      ["extensions.osc701-locale", "\x1b]701;?\x07", "\x1b]701;en_US.UTF-8\x1b\\"],
      ["extensions.osc702-version", "\x1b]702;?\x07", "\x1b]702;vterm.js;vterm;0;2\x1b\\"],
      ["extensions.osc776-cell-size", "\x1b]776\x07", "\x1b]776;8;17;14\x1b\\"],
    ] as const

    for (const [id, expected, response] of cases) {
      const p = probe(id)
      expect(p.lib).toBeTypeOf("function")
      const result = p.lib!(
        context({
          feedCapture(text) {
            expect(text).toBe(expected)
            return response
          },
        }),
      )
      expect(result.pass).toBe(true)
    }
  })

  test("OSC 720 verifies scrollback viewport movement", () => {
    const p = probe("extensions.osc720-scroll-up")
    expect(p.lib).toBeTypeOf("function")

    // The reading must come from a channel the control can move, or the measurement is not qualified.
    let viewportOffset = 1
    const fed: string[] = []
    const result = p.lib!(
      context({
        feed(text) {
          fed.push(text)
          if (text.includes("\x1b]720")) viewportOffset = 0
        },
        getScrollback() {
          return { viewportOffset, totalLines: 4, screenLines: 3 }
        },
        scrollViewport(delta) {
          viewportOffset = Math.max(0, Math.min(1, viewportOffset + delta))
        },
        reset() {
          viewportOffset = 1
        },
      }),
    )

    expect(result.pass).toBe(true)
    expect(fed).toContain("\x1b]720\x07")
  })

  test("OSC 720 treats a control that changes only counts as inconclusive, never coverage", () => {
    const p = probe("extensions.osc720-scroll-up")
    expect(p.lib).toBeTypeOf("function")

    for (const mutation of ["total", "screen"] as const) {
      let scrollStep = 0
      const result = p.lib!(
        context({
          getScrollback() {
            const stepped = Math.min(scrollStep, 2)
            return {
              viewportOffset: 7,
              totalLines: mutation === "total" ? 31 + stepped : 31,
              screenLines: mutation === "screen" ? 24 + stepped : 24,
            }
          },
          scrollViewport() {
            scrollStep += 1
          },
          reset() {
            scrollStep = 0
          },
        }),
      )
      expect(result.notTested).toBeUndefined()
      expect(result.observation?.outcome).toBe("inconclusive")
      expect(result.observation?.reason).toBe("insufficient-evidence")
      expect(result.note).toContain("geometry")
      expect(result.response).toContain('"afterMinus"')
      expect(result.assertions).toBeUndefined()
    }
  })
})

// @failure #32053: a present OSC 777 reader graded Unsupported with no same-run control, so a stale or inert reader
// read as an engine that drops notify (@cto cd6b67d9, grading rule 2). These rows run without a Kitty binary.
// @level l1
// @consumer extensions.osc777-notify library callback
describe("OSC 777 raw reader grading", () => {
  /** A scripted engine: records each OSC 777 payload, optionally dropping the notify subcommand. */
  function osc777Source(record: "all" | "non-notify"): LibProbeSource {
    const payloads: string[] = []
    return context({
      feed(text) {
        for (const [, payload] of text.matchAll(/\x1b\]777;([^\x07]*)\x07/g)) {
          if (record === "all" || !payload!.startsWith("notify;")) payloads.push(payload!)
        }
      },
      getOsc777Payloads: () => [...payloads],
    })
  }
  const controlReason = `${NO_SAME_PATH_CONTROL}: OSC 777 control payload not recorded; this reader is not shown to observe the OSC 777 path`

  test("a correct reader grades Supported", () => {
    const result = probe("extensions.osc777-notify").lib!(osc777Source("all"))
    expect(result.notTested).toBeUndefined()
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  })

  test("a reader that records the control but drops notify grades Unsupported", () => {
    const result = probe("extensions.osc777-notify").lib!(osc777Source("non-notify"))
    expect(result.notTested).toBeUndefined()
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  })

  test.each([
    ["a stale fixed list", context({ getOsc777Payloads: () => ["notify;stale;notice"] })],
    ["an inert feed", { ...osc777Source("all"), feed() {} }],
  ])("%s stays PROBE TODO without a recorded control", (_label, source) => {
    const result = probe("extensions.osc777-notify").lib!(source)
    // The rendered not-tested reason is notTested.noObservable, so the specific reason must be on it.
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: controlReason })
    expect(result.note).toBe(controlReason)
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  })

  test("an absent reader keeps the grid-only PROBE TODO route", () => {
    const result = probe("extensions.osc777-notify").lib!(context({}))
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
    expect(result.note).toBe(NO_SAME_PATH_CONTROL)
    expect(result.observation).toBeUndefined()
  })
})

// @failure #32271: a present OSC 9;4 reader must show a same-run set control before any Unsupported, and a state-0 report
// is never "never reported" (@cto 3636f1ee). These rows run without any native engine.
// @level l1
// @consumer extensions.osc9-progress library callback
describe("OSC 9;4 progress reader grading", () => {
  type Report = { state: number; value: number | null } | null
  /** A scripted engine storing the last 9;4 report; `drop` names a state it never stores, `clear` how it stores 0. */
  function progressSource(options: { drop?: number; clearAs?: "zero" | "null" } = {}): LibProbeSource {
    let report: Report = null
    return context({
      feed(text) {
        for (const [, state, value] of text.matchAll(/\x1b\]9;4;(\d)(?:;(\d+))?\x07/g)) {
          const code = Number(state)
          if (code === options.drop) continue
          report =
            code === 0 && options.clearAs === "null"
              ? null
              : { state: code, value: value === undefined ? null : Number(value) }
        }
      },
      getProgress: () => report && { ...report },
    })
  }
  const controlReason = `${NO_SAME_PATH_CONTROL}: OSC 9;4;1;37 control did not read back as state 1, value 37; this reader is not shown to observe the OSC 9;4 path`

  test("a correct reader grades Supported", () => {
    const result = probe("extensions.osc9-progress").lib!(progressSource())
    expect(result.notTested).toBeUndefined()
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  })

  test.each([
    ["state 3 is never stored", progressSource({ drop: 3 })],
    ["a cleared report reads as never reported", progressSource({ clearAs: "null" })],
  ])("a reader whose control passes but %s grades Unsupported", (_label, source) => {
    const result = probe("extensions.osc9-progress").lib!(source)
    expect(result.notTested).toBeUndefined()
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  })

  test.each([
    ["a stale fixed report", context({ getProgress: () => ({ state: 0, value: null }) })],
    ["a stale report fixed at state 1, value 37", context({ getProgress: () => ({ state: 1, value: 37 }) })],
    ["an inert feed", { ...progressSource(), feed() {} }],
    ["a reader that drops the set control", progressSource({ drop: 1 })],
  ])("%s stays PROBE TODO without a recorded control", (_label, source) => {
    const result = probe("extensions.osc9-progress").lib!(source)
    // The rendered not-tested reason is notTested.noObservable, so the specific reason must be on it.
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: controlReason })
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  })

  test("an absent reader keeps the grid-only PROBE TODO route", () => {
    const result = probe("extensions.osc9-progress").lib!(context({}))
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
    expect(result.observation).toBeUndefined()
  })
})

// @failure #32272: Ghostty and WezTerm keep only parsed {title, body} toasts, so OSC 9 and OSC 777 arrive in one store
// with no code. A same-family set control is the feature itself and makes Unsupported unreachable, so each criterion
// needs a no-toast control and the other family's toast as its cross control (@cto 3cc4a3ae). These rows run without
// any native engine.
// @level l1
// @consumer extensions.notifications and extensions.osc777-notify library callbacks through getToasts
describe("parsed-toast store grading", () => {
  type Toast = { title: string | null; body: string }
  type Store = {
    /** Families the engine stores; the other is dropped. */
    families?: readonly ("9" | "777")[]
    /** The title the engine stores for OSC 9 (Ghostty "", WezTerm null). */
    osc9Title?: string | null
    /** Mangle the body of these families. */
    wrongBody?: readonly ("9" | "777")[]
    /** Append a toast on every feed, toast or not. */
    everyFeed?: boolean
  }
  /** A scripted engine with one parsed-toast store for both families. */
  function toastSource(store: Store = {}): LibProbeSource {
    const toasts: Toast[] = []
    const families = store.families ?? ["9", "777"]
    const body = (family: "9" | "777", value: string) =>
      store.wrongBody?.includes(family) ? `${value}-mangled` : value
    return context({
      feed(text) {
        const added = toasts.length
        for (const [, payload] of text.matchAll(/\x1b\]9;([^\x07]*)\x07/g)) {
          if (!payload!.startsWith("4;") && families.includes("9")) {
            toasts.push({ title: store.osc9Title === undefined ? "" : store.osc9Title, body: body("9", payload!) })
          }
        }
        for (const [, title, value] of text.matchAll(/\x1b\]777;notify;([^;\x07]*);([^\x07]*)\x07/g)) {
          if (families.includes("777")) toasts.push({ title: title!, body: body("777", value!) })
        }
        if (store.everyFeed && toasts.length === added) toasts.push({ title: null, body: "unrelated" })
      },
      getToasts: () => toasts.map((toast) => ({ ...toast })),
    })
  }
  const criteria = [
    { id: "extensions.notifications", label: "OSC 9", graded: "9", other: "777" },
    { id: "extensions.osc777-notify", label: "OSC 777", graded: "777", other: "9" },
  ] as const
  const noToastReason = (label: string) =>
    `${NO_SAME_PATH_CONTROL}: ${label} no-toast control changed the toast store; this reader is not shown to add only toasts`
  const crossReason = (label: string) =>
    `${NO_SAME_PATH_CONTROL}: ${label} cross control did not add exactly its own toast; this reader is not shown to observe toasts`

  describe.each(criteria)("$label", ({ id, label, graded, other }) => {
    test.each([
      ['a correct store with OSC 9 title ""', toastSource()],
      ["a correct store with OSC 9 title null", toastSource({ osc9Title: null })],
      ["a store that toasts only the graded family", toastSource({ families: [graded] })],
    ])("%s grades Supported", (_label, source) => {
      const result = probe(id).lib!(source)
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    })

    test.each([
      ["toasts only the other family", toastSource({ families: [other] })],
      ["mangles only the graded family's body", toastSource({ wrongBody: [graded] })],
    ])("a store that %s grades Unsupported", (_label, source) => {
      const result = probe(id).lib!(source)
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
    })

    test.each([
      ["never stores", toastSource({ families: [] }), crossReason(label)],
      ["mangles every body", toastSource({ wrongBody: ["9", "777"] }), crossReason(label)],
      ["is a stale fixed list", context({ getToasts: () => [{ title: "stale", body: "notice" }] }), crossReason(label)],
      ["appends on every feed", toastSource({ everyFeed: true }), noToastReason(label)],
    ])("a store that %s stays PROBE TODO", (_label, source, reason) => {
      const result = probe(id).lib!(source)
      // The rendered not-tested reason is notTested.noObservable, so the specific reason must be on it.
      expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: reason })
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
    })
  })

  test("an absent store keeps each criterion's no-reader route", () => {
    const notifications = probe("extensions.notifications").lib!(context({}))
    expect(notifications.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
    const osc777 = probe("extensions.osc777-notify").lib!(context({}))
    expect(osc777.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
    for (const result of [notifications, osc777]) expect(result.observation).toBeUndefined()
  })
})
