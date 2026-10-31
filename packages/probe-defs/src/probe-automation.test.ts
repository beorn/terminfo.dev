import { describe, expect, test } from "vitest"
import { ALL_PROBES, type LibProbeSource, type TermProbeSource, type TerminalQueryOutcome } from "./index.ts"
import {
  HEADLESS_OBSERVABLE_REVIEW,
  REPLY_AFTER_SENTINEL_NOTE,
  REPLY_PATH_AUDIT_REVIEW,
  probe as defineProbe,
} from "./helpers.ts"
import { REPLY_PATH_AUDITS } from "./reply-path-audit.ts"

const OSC_SEMANTIC_MARK_CASES = [
  ["extensions.osc133-a", "\x1b]133;A\x07"],
  ["extensions.osc133-b", "\x1b]133;B\x07"],
  ["extensions.osc133-c", "\x1b]133;C\x07"],
  ["extensions.osc133-d", "\x1b]133;D;0\x07"],
  ["extensions.osc133-p", "\x1b]133;P;Cwd=/tmp\x07"],
  ["extensions.osc633-a", "\x1b]633;A\x07"],
  ["extensions.osc633-b", "\x1b]633;B\x07"],
  ["extensions.osc633-c", "\x1b]633;C\x07"],
  ["extensions.osc633-d", "\x1b]633;D;0\x07"],
  ["extensions.osc633-e", "\x1b]633;E;ls -la;nonce123\x07"],
  ["extensions.osc633-p", "\x1b]633;P;Cwd=/tmp\x07"],
] as const
const OSC_SEMANTIC_MARK_IDS = OSC_SEMANTIC_MARK_CASES.map(([id]) => id)

function probe(id: string) {
  const found = ALL_PROBES.find((p) => p.id === id)
  if (!found) throw new Error(`missing probe ${id}`)
  return found
}

function context(overrides: Partial<LibProbeSource>): LibProbeSource {
  return {
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
describe("audited native host recipe callers", () => {
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
  ] as const)(
    "%s retains its actual empty host query cause without changing its criterion",
    (id, recipe, missing, query) => {
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
        expect(result.hostRecipeCauses).toMatchObject([
          {
            recipe,
            cause:
              recipe === "color-request"
                ? { kind: "observed", missing, query }
                : recipe === "text-area-size"
                  ? // The harness declares pixel geometry (31551), so the empty CSI 14 t is the wrapper's: it drops the request.
                    { kind: "unimplemented", missing, artifactSha256: artifact, sourceCitation: expect.any(String) }
                  : { kind: "source-audited", missing, artifactSha256: artifact, sourceCitation: expect.any(String) },
          },
        ])
        const { hostRecipeCauses: _custody, ...criterion } = result
        expect(criterion).toEqual(
          definition.lib!(
            context({ feedCapture: () => "", ...(qualified && { queryWithSentinelOutcome: () => silence }) }),
          ),
        )
      }
    },
  )

  // A second native host (WezTerm) must never inherit another artifact's audited causes.
  test.each(["device.xtwinops-14", "extensions.osc52-read", "extensions.osc10-fg-color"])(
    "%s claims no host recipe cause for an unaudited native artifact",
    (id) => {
      const other = "f".repeat(64)
      const result = probe(id).lib!(
        context({
          runtimeIdentity: {
            ...nativeIdentity,
            loadedBinary: { path: "other.node", sha256: other },
            provenance: { ...nativeIdentity.provenance, sha256: other },
          },
          feedCapture: () => "",
        }),
      )
      expect(result.hostRecipeCauses).toBeUndefined()
    },
  )

  // WezTerm answers CSI 14 t from the pixels it was given (31551), so the audit lists only the recipe it leaves unanswered.
  test.each([
    "84da518e3f298a0ed75f186db6e39d87e99b8f0c8508dd7252ec0cafee77fe12",
    "78c05a7155ffb48b351de181cce13a5d996c3472f545f674dc34177fe27bae01",
    "0f56a805793d7d829daa617f1323aacff0d73fe868747b0d077c6af315e2aab8",
  ])("the WezTerm artifact %s cites its OSC 52 read and leaves CSI 14 t measured", (wezterm) => {
    const silent = (id: string) =>
      probe(id).lib!(
        context({
          runtimeIdentity: {
            ...nativeIdentity,
            loadedBinary: { path: "wezterm.node", sha256: wezterm },
            provenance: { ...nativeIdentity.provenance, sha256: wezterm },
          },
          feedCapture: () => "",
        }),
      )
    expect(silent("device.xtwinops-14").hostRecipeCauses).toBeUndefined()
    expect(silent("extensions.osc52-read").hostRecipeCauses).toMatchObject([
      { recipe: "clipboard-load", cause: { kind: "unimplemented", artifactSha256: wezterm } },
    ])
  })

  // The Alacritty addon rebuilt at the declared pixel geometry answers CSI 14 t (31628), so only its OSC 52 read is cited.
  test("the Alacritty artifact 5d818656 cites its OSC 52 read and leaves CSI 14 t measured", () => {
    const alacritty = "5d818656c9d58c8c68bec9f7bca1a55cc65ccf9fc078f9a3da0b872a28bf547a"
    const silent = (id: string) =>
      probe(id).lib!(
        context({
          runtimeIdentity: {
            ...nativeIdentity,
            loadedBinary: { path: "alacritty.node", sha256: alacritty },
            provenance: { ...nativeIdentity.provenance, sha256: alacritty },
          },
          feedCapture: () => "",
        }),
      )
    expect(silent("device.xtwinops-14").hostRecipeCauses).toBeUndefined()
    expect(silent("extensions.osc52-read").hostRecipeCauses).toMatchObject([
      { recipe: "clipboard-load", cause: { kind: "source-audited", artifactSha256: alacritty } },
    ])
  })

  // The Alacritty addon rebuilt at termless 0400d94a for underline_color forwarding (31379) leaves EventProxy unchanged.
  test.each([
    "11c87e7e7f23e6f224e9dc8c3296b0a91f5453a42038e5ad049aafa864f9bd50",
    "d280c3fd2129f42db0d7154d6e66f5582a67fa1faf1e82ab463b6b8286f126d0",
    "32d76284e5a3c7673fafbbc83a16717fa0a1c1811c7d659d982176a53ceb1aa9",
  ])("the Alacritty artifact %s cites its OSC 52 read and leaves CSI 14 t measured", (alacritty) => {
    const silent = (id: string) =>
      probe(id).lib!(
        context({
          runtimeIdentity: {
            ...nativeIdentity,
            loadedBinary: { path: "alacritty.node", sha256: alacritty },
            provenance: { ...nativeIdentity.provenance, sha256: alacritty },
          },
          feedCapture: () => "",
        }),
      )
    expect(silent("device.xtwinops-14").hostRecipeCauses).toBeUndefined()
    expect(silent("extensions.osc52-read").hostRecipeCauses).toMatchObject([
      { recipe: "clipboard-load", cause: { kind: "source-audited", artifactSha256: alacritty } },
    ])
  })
})

/**
 * @failure A cited missing reply path replaced a measured reply, or an unaudited artifact inherited the review.
 * @level l0
 * @consumer probe() reply-path audit hook (CTO 10c2da7b; parser-rejected grades Unsupported per CTO d9998884).
 * @testonly REPLY_PATH_AUDITS: exported so every audited cell runs through its own production probe.
 */
// CTO 10c2da7b condition 2: listed + zero reply → review; listed + one reply byte → measured; unlisted → measured.
// The audited cells run their real callbacks; no existing test reaches the hook with a listed artifact.
// CTO d5f41664 explicitly replaces query-capture emptiness with qualified clean-silence attribution.
// These real callbacks own the native host cause; generic sentinel classifier tests cannot pin it.
describe("qualified clipboard roundtrip", () => {
  const da1 = "\x1b[?1;2c"
  const frame = (data: string) => `\x1b]52;c;${btoa(data)}\x07`
  const cases = [
    { when: "clean sentinel silence", raw: da1, reason: "sentinel", sentinel: true, cause: true, failure: true },
    { when: "whole empty buffer", raw: "", reason: "timeout", sentinel: false, cause: true, failure: true },
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
      failure: true,
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
        expect(result.response, row.when).toBe(row.raw)
        if ("cause" in row && row.cause) {
          expect(result.hostRecipeCauses, row.when).toMatchObject([
            { recipe: "clipboard-load", cause: { kind: "source-audited", artifactSha256: artifact } },
          ])
        } else expect(result.hostRecipeCauses, row.when).toBeUndefined()
        if ("failure" in row && row.failure) {
          expect(result.tests, row.when).toContainEqual({
            id: "criterion",
            status: "test-failure",
            reason: "No OSC 52 c query response from the isolated backend",
          })
          expect(result.observation, row.when).toBeUndefined()
        } else {
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

describe("reply-path audit", () => {
  // #31692: data-derived cases cannot detect an omitted current-artifact OSC99 audit.
  test.each([
    ["5c38594a17329b24e826f785d3156d6e498490517835f12b0730eeab2fc63da7", "parser-rejected"],
    ["d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9", "parser-rejected"],
    ["77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7", "parser-rejected"],
    ["8872ab0fc56429489b52cd5d3b5a293032c3ec7dbbb71545d237945c3ef525f3", "parser-rejected"],
    ["f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96", "no-reply-path"],
  ])("OSC99 capability query has its own source audit for %s", (sha, kind) => {
    expect(REPLY_PATH_AUDITS.get(sha!)?.["extensions.osc99-kitty-notify"]).toMatchObject({
      query: "\x1b]99;",
      matches: "prefix",
      kind,
    })
  })
  const wasmReadbackQueries = [
    ["extensions.osc0-icon-title", "\x1b[20t", "parser-rejected"],
    ["extensions.osc52-clipboard", "\x1b]52;c;?\x07", "no-reply-path"],
    ["extensions.osc52-read", "\x1b]52;c;?\x07", "no-reply-path"],
    ["extensions.osc52-write", "\x1b]52;c;?\x07", "no-reply-path"],
    ["extensions.osc5522-clipboard", "\x1b[?5522$p", "no-reply-path"],
  ] as const
  // #31385: rebuilding cell readback must retain all applicable audits, including #31377's graphics prefixes.
  // The data-derived callback cases below cannot detect an omitted artifact or omitted row.
  test.each([
    {
      name: "native overline",
      digest: "d70f2f8adb5dfcb6a7d75d23e11a60ba3671844b930a3f66970a709f65ee1346",
      priors: [
        "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e",
        "17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3",
      ],
      core: "332b2aef",
    },
    {
      name: "native",
      digest: "8872ab0fc56429489b52cd5d3b5a293032c3ec7dbbb71545d237945c3ef525f3",
      priors: [
        "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e",
        "17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3",
      ],
      core: "332b2aef",
    },
    {
      name: "WASM",
      digest: "77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7",
      priors: ["7c43302dde147c6f7959b7bda7045ff375c71288da1af5667ffca2bf95beb2bf"],
      core: "5714ed07",
    },
  ])("the rebuilt $name artifact retains its prior Ghostty audit sets", ({ digest, priors, core }) => {
    const prior = Object.fromEntries(
      priors.flatMap((sha) => {
        const audits = REPLY_PATH_AUDITS.get(sha)
        if (!audits) throw new Error(`Missing required prior audit ${sha}`)
        return Object.entries(audits)
      }),
    )
    const rebuilt = REPLY_PATH_AUDITS.get(digest)
    expect(rebuilt).toBeDefined()
    expect(Object.keys(rebuilt!).sort()).toEqual(
      [
        ...Object.keys(prior),
        "extensions.osc99-kitty-notify",
        ...(digest.startsWith("77b69f9f") ? wasmReadbackQueries.map(([id]) => id) : []),
      ].sort(),
    )
    for (const [id, audit] of Object.entries(prior)) {
      expect(rebuilt![id]).toMatchObject({ query: audit.query, kind: audit.kind })
      expect(rebuilt![id]!.matches).toBe(audit.matches)
      expect(rebuilt![id]!.citation).toContain(core)
    }
  })

  // #31392, @cto 34bea86e: Ghostty WASM 5c38594a only adds viewport getters/exports to the d80a8110 facade, so every
  // d80a8110 row is rebound as its own data row with the same query, kind and matching, and the old rows stay.
  test("the rebuilt Ghostty WASM 5c38594a retains every d80a8110 audit", () => {
    const prior = REPLY_PATH_AUDITS.get("d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9")!
    const rebuilt = REPLY_PATH_AUDITS.get("5c38594a17329b24e826f785d3156d6e498490517835f12b0730eeab2fc63da7")!
    expect(rebuilt).toBeDefined()
    expect(rebuilt).not.toBe(prior)
    expect(Object.keys(rebuilt).sort()).toEqual(Object.keys(prior).sort())
    expect(Object.keys(rebuilt)).toHaveLength(49)
    for (const [id, audit] of Object.entries(rebuilt)) {
      expect(audit).toMatchObject({ query: prior[id]!.query, kind: prior[id]!.kind })
      expect(audit.matches).toBe(prior[id]!.matches)
      expect(audit.citation).toContain("5714ed07")
      expect(audit.citation).not.toContain("d80a8110")
    }
  })

  // #31735, @cto 863bef67: Ghostty WASM d80a8110 adds .size_report (.csi_18_t) copied from Termio.zig:540-546,
  // so device.xtwinops-18 leaves the no-reply-path audit table while all other 77b69f9f rows remain.
  test("the rebuilt Ghostty WASM d80a8110 retains all 77b69f9f audits except device.xtwinops-18", () => {
    const prior = REPLY_PATH_AUDITS.get("77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7")!
    const rebuilt = REPLY_PATH_AUDITS.get("d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9")!
    expect(rebuilt).toBeDefined()
    expect(rebuilt["device.xtwinops-18"]).toBeUndefined()
    expect(Object.keys(rebuilt).sort()).toEqual(
      Object.keys(prior)
        .filter((id) => id !== "device.xtwinops-18")
        .sort(),
    )
    for (const [id, audit] of Object.entries(rebuilt)) {
      expect(audit).toMatchObject({ query: prior[id]!.query, kind: prior[id]!.kind })
      expect(audit.matches).toBe(prior[id]!.matches)
      expect(audit.citation).toContain("5714ed07")
    }
  })
  const cells = [...REPLY_PATH_AUDITS].flatMap(([sha256, audits]) =>
    Object.entries(audits).map(([id, audit]) => ({ sha256, id, audit })),
  )
  const identity = (sha256: string): NonNullable<LibProbeSource["runtimeIdentity"]> => ({
    ...nativeIdentity,
    loadedBinary: { path: "audited.wasm", sha256 },
    provenance: { ...nativeIdentity.provenance, sha256 },
  })
  const run = (id: string, sha256: string, reply: (sequence: string) => string) => {
    const sent: string[] = []
    const result = probe(id).lib!(
      context({
        runtimeIdentity: identity(sha256),
        feedCapture(sequence) {
          sent.push(sequence)
          return reply(sequence)
        },
      }),
    )
    return { result, sent }
  }

  // #31377 AC1: explicit membership catches omitted audits that data-derived cases cannot see.
  // The current Rust/WASM captures execute these queries but lack the source-bound branch (CTO d6f8c7de).
  test.each([
    ["7c43302dde147c6f7959b7bda7045ff375c71288da1af5667ffca2bf95beb2bf", "extensions.kitty-graphics", false],
    ["7c43302dde147c6f7959b7bda7045ff375c71288da1af5667ffca2bf95beb2bf", "extensions.kitty-graphics.transmit", false],
    ["7c43302dde147c6f7959b7bda7045ff375c71288da1af5667ffca2bf95beb2bf", "extensions.kitty-graphics.display", false],
    ["7c43302dde147c6f7959b7bda7045ff375c71288da1af5667ffca2bf95beb2bf", "extensions.osc21-kitty-color", true],
    ["7c43302dde147c6f7959b7bda7045ff375c71288da1af5667ffca2bf95beb2bf", "extensions.sixel-geometry-report", true],
    ["f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96", "extensions.kitty-keyboard", false],
    [
      "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96",
      "extensions.kitty-keyboard.disambiguate",
      false,
    ],
    [
      "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96",
      "extensions.kitty-keyboard.report-events",
      false,
    ],
    [
      "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96",
      "extensions.kitty-keyboard.report-alternate",
      false,
    ],
    [
      "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96",
      "extensions.kitty-keyboard.report-all-keys",
      false,
    ],
    [
      "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96",
      "extensions.kitty-keyboard.report-text",
      false,
    ],
    ["f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96", "input.csi-u", false],
    ["f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96", "extensions.osc21-kitty-color", false],
    ["f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96", "extensions.sixel-geometry-report", false],
    ["f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96", "extensions.kitty-graphics", true],
    ["f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96", "extensions.kitty-graphics.transmit", true],
    ["f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96", "extensions.kitty-graphics.display", true],
  ] as const)("named query on %s selects its source-bound result: %s", (sha256, id, parserRejected) => {
    const { result, sent } = run(id, sha256, () => "")
    expect(sent.length).toBeGreaterThan(0)
    if (parserRejected) {
      expect(result).toMatchObject({ observation: { outcome: "unsupported", assertionType: "query_reply" } })
      expect(result.assertions).toEqual([expect.objectContaining({ kind: "negative", assertionType: "query_reply" })])
    } else {
      expect(result).toMatchObject({
        criterionBranch: REPLY_PATH_AUDIT_REVIEW,
        tests: [{ id: "review", status: "test-todo" }],
      })
      expect(result.observation).toBeUndefined()
    }
  })

  // Data-derived cases cannot catch a missing row; these five actual callback queries were omitted.
  test.each(wasmReadbackQueries)("WASM readback %s retains its own query and source kind", (id, query, kind) => {
    const digest = "77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7"
    expect(REPLY_PATH_AUDITS.get(digest)?.[id]).toMatchObject({ query, kind })
    const { result, sent } = run(id, digest, () => "")
    expect(sent).toContain(query)
    if (kind === "parser-rejected") {
      expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
    } else {
      expect(result.criterionBranch).toBe(REPLY_PATH_AUDIT_REVIEW)
      expect(result.tests).toMatchObject([{ id: "review", status: "test-todo" }])
      expect(result.observation).toBeUndefined()
    }
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
    expect(result).toMatchObject({
      criterionBranch: REPLY_PATH_AUDIT_REVIEW,
      tests: [{ id: "review", status: "test-todo" }],
    })
    expect(result.observation).toBeUndefined()
    expect(result.assertions ?? []).toEqual([])
  })

  // #31377 AC1: data-derived cases cannot detect an omitted fixed-query audit or its wrong source kind.
  test.each([
    ["extensions.osc21-kitty-color", "\x1b]21;foreground=?\x1b\\", false],
    ["extensions.sixel-geometry-report", "\x1b[?2;1;0S", true],
  ] as const)("native fixed query preserves its source distinction: %s", (id, query, parserRejected) => {
    const { result, sent } = run(id, "17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3", () => "")
    expect(sent).toEqual([query])
    if (parserRejected) {
      expect(result).toMatchObject({ observation: { outcome: "unsupported", assertionType: "query_reply" } })
      expect(result.assertions).toEqual([expect.objectContaining({ kind: "negative", assertionType: "query_reply" })])
    } else {
      expect(result).toMatchObject({
        criterionBranch: REPLY_PATH_AUDIT_REVIEW,
        tests: [{ id: "review", status: "test-todo" }],
      })
      expect(result.observation).toBeUndefined()
    }
  })

  // #31377, CTO 29be6ad0: actual graphics request bytes (including allocation nonces) must survive the review.
  // Data-derived cases cannot notice a missing graphics entry or prove that its generated bytes were retained.
  test.each(["extensions.kitty-graphics", "extensions.kitty-graphics.transmit", "extensions.kitty-graphics.display"])(
    "native graphics query retains a required review and its actual fed bytes: %s",
    (id) => {
      const { result, sent } = run(id, "17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3", () => "")
      expect(result).toMatchObject({
        criterionBranch: REPLY_PATH_AUDIT_REVIEW,
        tests: [{ id: "review", status: "test-todo" }],
      })
      const queries = sent.filter((text) => text.startsWith("\x1b_G"))
      expect(queries).toHaveLength(1)
      expect(JSON.parse(result.response!)).toMatchObject({
        replyPathAudit: { matches: "prefix", captures: 1, replyBytes: 0 },
        matchedQueries: queries,
        measuredResponse: "",
      })
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
      expect(result).toMatchObject({ criterionBranch: REPLY_PATH_AUDIT_REVIEW })
      expect(JSON.parse(result.response!)).toMatchObject({
        replyPathAudit: { captures: 1, replyBytes: 0 },
        matchedQueries: sent,
      })
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
    expect(result.tests).toEqual([expect.objectContaining({ id: "criterion", status: "test-failure" })])
  })

  // Existing exact rows must not acquire prefix semantics; the generic table sends only their canonical bytes.
  test.each(["\x1b[c", "\x1b[cX", "X\x1b[c"])("exact query audit keeps byte equality for %j", (query) => {
    const measured = {
      pass: false,
      response: "measured",
      observation: {
        outcome: "inconclusive" as const,
        assertionType: "query_reply" as const,
        reason: "no-response" as const,
      },
    }
    const definition = defineProbe(
      "device.primary-da",
      (ctx) => {
        ctx.feedCapture(query)
        return measured
      },
      null,
    )
    const result = definition.lib!(
      context({
        runtimeIdentity: identity("ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e"),
      }),
    )
    if (query === "\x1b[c") expect(result.criterionBranch).toBe(REPLY_PATH_AUDIT_REVIEW)
    else expect(result).toBe(measured)
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
  ] as const)("current native source contract: %s", (id, parserRejected) => {
    const { result } = run(id, "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e", () => "")
    if (parserRejected) {
      expect(result).toMatchObject({ observation: { outcome: "unsupported", assertionType: "query_reply" } })
      expect(result.assertions).toEqual([expect.objectContaining({ kind: "negative", assertionType: "query_reply" })])
    } else {
      expect(result).toMatchObject({
        criterionBranch: REPLY_PATH_AUDIT_REVIEW,
        tests: [{ id: "review", status: "test-todo" }],
      })
      expect(result.observation).toBeUndefined()
    }
  })

  // @cto fb6cfc2f: these source-negative decisions must still be reached when the current native
  // observer returns no colour replies. A seeded-only fixture would hide the actual early-return path.
  test.each([
    ["extensions.osc30001-color-stack-push", "\x1b]30001\x1b\\"],
    ["extensions.osc30101-color-stack-pop", "\x1b]30101\x1b\\"],
  ] as const)("native stack rejection survives missing colour controls: %s", (id, query) => {
    for (const sha of [
      "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e",
      "9a9505600721226b952ae9ac92552b42389aa6713872a9f4904528f425b7ecdf",
    ]) {
      const { result, sent } = run(id, sha, () => "")
      expect(sent).toContain(query)
      expect(result).toMatchObject({ observation: { outcome: "unsupported", assertionType: "query_reply" } })
    }
  })

  test("native OSC 0 retains the answered title arm while rejecting the necessary icon arm", () => {
    const sha = "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e"
    const { result } = run("extensions.osc0-icon-title", sha, (q) =>
      q === "\x1b[21t" ? "\x1b]losc0-icon-title\x07" : "",
    )
    expect(result).toMatchObject({ observation: { outcome: "unsupported", assertionType: "query_reply" } })
    expect(JSON.parse(result.response!)).toMatchObject({ measuredResponse: expect.stringContaining("osc0-icon-title") })
    const answerIcon = (q: string) => (q === "\x1b[20t" ? "\x1b]Losc0-icon-title\x07" : "")
    expect(run("extensions.osc0-icon-title", sha, answerIcon).result).toEqual(
      run("extensions.osc0-icon-title", "f".repeat(64), answerIcon).result,
    )
  })

  // @cto 52d43147: an unlisted artifact must keep the complete pre-attempt early result,
  // not acquire a source-negative grade merely because the probe now records its own attempt.
  test("an unlisted stack attempt preserves the early review except for its trace entry", () => {
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
          status: "test-todo",
          reason:
            "Library probe source offers no colour readback; required independent review of the retained raw state pending",
        },
      ],
    }
    const { result } = run(id, "f".repeat(64), () => "")
    const raw = JSON.parse(result.response!) as { query: string; originalRaw: string; trace: unknown[] }
    expect(raw.trace.pop()).toEqual({ write: stackQuery, response: "" })
    expect({ ...result, response: JSON.stringify(raw) }).toEqual(early)
    const listed = run(id, "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e", () => "").result
    const listedRaw = JSON.parse(listed.response!) as { measuredResponse: string }
    expect(listedRaw.measuredResponse).toBe(result.response)
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
      tests: [{ id: "review", status: "test-todo" }],
    })
    expect(result.observation).toBeUndefined()
    const raw = JSON.parse(result.response!) as { trace: unknown[] }
    expect(raw.trace.at(-1)).toEqual({ write: query, error: "Error: stack attempt failed" })
  })

  test("covers all eleven audited artifacts", () => {
    // Three Ghostty WASM artifacts at 5714ed07, five native artifacts at 332b2aef, and three vt100-rust builds.
    expect([...REPLY_PATH_AUDITS.keys()].sort()).toEqual([
      "0919421290792a0c8be173dd50ec7a39c0ef68b1e0633fd979da13f22478c1d3",
      "17d155feee5df8fa30266b9a354bbe66e39484d08218de5e03dc3bb2f199a0a3",
      "5c38594a17329b24e826f785d3156d6e498490517835f12b0730eeab2fc63da7",
      "77b69f9f22c4126359be864fcce97afad8f84615053e21d335ba6348a8d3e1d7",
      "7c43302dde147c6f7959b7bda7045ff375c71288da1af5667ffca2bf95beb2bf",
      "8872ab0fc56429489b52cd5d3b5a293032c3ec7dbbb71545d237945c3ef525f3",
      "9a9505600721226b952ae9ac92552b42389aa6713872a9f4904528f425b7ecdf",
      "ac12d6408c2049f1d720e9735d7eb69251d3eed868fc9ced58de98b3543f3e2e",
      "b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962",
      "d70f2f8adb5dfcb6a7d75d23e11a60ba3671844b930a3f66970a709f65ee1346",
      "d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9",
      "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96",
    ])
  })

  // @cto d9998884, f9d23c2a (#31372): the WASM build drops every DCS before src/terminal/dcs.zig, and it builds its
  // stream without an OSC allocator, so each colour query is rejected at the parser. The table test above accepts
  // either kind, so only this pin keeps the ruled kinds.
  test("ghostty-web 0.4.0 WASM: DCS queries have no reply path; colour queries are parser-rejected", () => {
    const ghostty = REPLY_PATH_AUDITS.get("7c43302dde147c6f7959b7bda7045ff375c71288da1af5667ffca2bf95beb2bf")!
    const dcs = Object.entries(ghostty).filter(([, audit]) => audit.query.startsWith("\x1bP"))
    expect(dcs.map(([id, audit]) => [id, audit.kind])).toEqual([
      ["device.decrqss", "no-reply-path"],
      ["device.xtgettcap", "no-reply-path"],
      ["device.xtgetxres", "no-reply-path"],
    ])
    for (const [, audit] of dcs) {
      expect(audit.citation).toContain("patch:586-588")
      expect(audit.citation).not.toContain("parses it")
    }
    for (const id of [
      "extensions.osc10-fg-color",
      "extensions.osc104-reset-palette",
      "extensions.osc11-bg-color",
      "extensions.osc110-reset-fg",
      "extensions.osc111-reset-bg",
      "extensions.osc112-reset-cursor",
      "extensions.osc113-reset-pointer-fg",
      "extensions.osc114-reset-pointer-bg",
      "extensions.osc12-cursor-color",
      "extensions.osc17-highlight-bg",
      "extensions.osc19-highlight-fg",
      "extensions.osc30001-color-stack-push",
      "extensions.osc30101-color-stack-pop",
      "extensions.osc4-palette",
      "extensions.osc5-special-color",
    ]) {
      const audit = ghostty[id]!
      expect(audit.kind, id).toBe("parser-rejected")
      expect(audit.citation, id).toContain(
        "patch:827 ResponseStream.init → ghostty 5714ed07 src/terminal/stream.zig:497-501",
      )
      expect(audit.citation, id).toContain("only under initAlloc (stream.zig:506-510)")
      expect(audit.citation, id).not.toContain("682-687")
    }
  })

  // #31371: the five vt100-rust cells #31375 and #31376 could not attribute graded test-failure in run d390b869 because the
  // table had no row for them; the table test below covers only rows that exist, so only this pin catches their absence.
  test("vt100 0.16.2 Rust parser: the clipboard and icon-title queries have no reply path", () => {
    const rust = "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96"
    for (const id of [
      "extensions.osc0-icon-title",
      "extensions.osc52-clipboard",
      "extensions.osc52-read",
      "extensions.osc52-write",
      "extensions.osc5522-clipboard",
    ]) {
      expect(REPLY_PATH_AUDITS.get(rust)?.[id]?.kind, id).toBe("no-reply-path")
      expect(run(id, rust, () => "").result, id).toMatchObject({
        criterionBranch: REPLY_PATH_AUDIT_REVIEW,
        tests: [{ id: "review", status: "test-todo" }],
      })
    }
  })

  test.each([
    "b9109b5918707746420833dfc2eab3ea5bc7feec5fa93bee4cd6e824e74d0962",
    "0919421290792a0c8be173dd50ec7a39c0ef68b1e0633fd979da13f22478c1d3",
  ])("vt100-rust %s lists the ruled twins and leaves a silent write not-tested", (sha) => {
    const old = "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96"
    const noReply = [
      "cursor.position-report",
      "device.decrpm",
      "device.decrqss",
      "device.dsr-996-color-scheme",
      "device.primary-da",
      "device.secondary-da",
      "device.status-report",
      "device.tertiary-da",
      "device.xtgettcap",
      "device.xtgetxres",
      "device.xtreportcolors",
      "device.xtversion",
      "device.xtwinops-14",
      "device.xtwinops-16",
      "device.xtwinops-18",
      "device.xtwinops-20",
      "device.xtwinops-21",
      "editing.decrqcra",
      "extensions.osc0-icon-title",
      "extensions.osc10-fg-color",
      "extensions.osc104-reset-palette",
      "extensions.osc11-bg-color",
      "extensions.osc110-reset-fg",
      "extensions.osc111-reset-bg",
      "extensions.osc112-reset-cursor",
      "extensions.osc113-reset-pointer-fg",
      "extensions.osc114-reset-pointer-bg",
      "extensions.osc12-cursor-color",
      "extensions.osc1337-capabilities",
      "extensions.osc1337-cellsize",
      "extensions.osc17-highlight-bg",
      "extensions.osc19-highlight-fg",
      "extensions.osc30001-color-stack-push",
      "extensions.osc30101-color-stack-pop",
      "extensions.osc4-palette",
      "extensions.osc5-special-color",
      "extensions.osc5522-clipboard",
      "extensions.osc701-locale",
      "extensions.osc702-version",
      "extensions.osc776-cell-size",
      "extensions.osc7770-font-size",
      "extensions.osc7777-font-window-size",
      "extensions.kitty-keyboard",
      "extensions.kitty-keyboard.disambiguate",
      "extensions.kitty-keyboard.report-all-keys",
      "extensions.kitty-keyboard.report-alternate",
      "extensions.kitty-keyboard.report-events",
      "extensions.kitty-keyboard.report-text",
      "extensions.osc21-kitty-color",
      "extensions.osc52-clipboard",
      "extensions.osc52-read",
      "extensions.osc99-kitty-notify",
      "extensions.sixel-da1",
      "extensions.sixel-geometry-report",
      "input.csi-u",
    ]
    const parserRejected = [
      "extensions.kitty-graphics",
      "extensions.kitty-graphics.display",
      "extensions.kitty-graphics.transmit",
    ]
    const rows = REPLY_PATH_AUDITS.get(sha)
    expect(Object.keys(rows ?? {}).sort()).toEqual([...noReply, ...parserRejected].sort())
    for (const id of noReply) expect(rows?.[id]?.kind, id).toBe("no-reply-path")
    for (const id of parserRejected) expect(rows?.[id]?.kind, id).toBe("parser-rejected")
    const readRows = ["extensions.osc52-clipboard", "extensions.osc52-read"]
    for (const id of [...noReply, ...parserRejected].filter((id) => !readRows.includes(id))) {
      expect(rows?.[id]?.citation, id).toContain("lib.rs:21-53")
      expect(rows?.[id]?.citation, id).not.toContain("artifactf309015f")
    }
    expect(rows?.["extensions.osc52-clipboard"]?.citation).toContain("lib.rs:50-52")
    expect(rows?.["extensions.osc52-read"]?.citation).toContain("lib.rs:50-52")
    expect(rows?.["extensions.osc52-write"]).toBeUndefined()
    expect(REPLY_PATH_AUDITS.get(old)?.["extensions.osc52-write"]?.kind).toBe("no-reply-path")
    expect(REPLY_PATH_AUDITS.get(old)?.["extensions.osc99-kitty-notify"]?.kind).toBe("no-reply-path")
    const silent = run("extensions.osc52-write", sha, () => "")
    expect(silent.result.notTested).toEqual({
      reason: "no-semantic-observable",
      noObservable: "clipboard write state",
    })
    expect(JSON.stringify(silent.result)).not.toContain("replyPathAudit")
    expect(run("extensions.osc52-write", old, () => "").result.criterionBranch).toBe(REPLY_PATH_AUDIT_REVIEW)
  })

  function writeWithClipboard(state: {
    writes: { selector: string; payload: string; text?: string; decodeError?: string }[]
    pasteSelector?: string
  }) {
    let fed = ""
    return probe("extensions.osc52-write").lib!({
      kind: "live",
      cols: 80,
      feed(text: string) {
        fed += text
      },
      feedCapture: () => "",
      getCell: () => {
        throw new Error("unused")
      },
      getClipboardState: () => {
        if (state.writes.some((write) => write.payload === "")) {
          const payload = /\x1b\]52;c;([A-Za-z0-9+/=]*)/.exec(fed)?.[1] ?? ""
          return {
            ...state,
            writes: state.writes.map((write) => (write.payload === "" ? { ...write, payload } : write)),
          }
        }
        return state
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

  test("osc52-write is unsupported when the engine callback retained no writes", () => {
    const result = writeWithClipboard({ writes: [] })
    expect(result.observation?.outcome).toBe("unsupported")
    expect(result.assertions?.[0]?.assertionType).toBe("query_reply")
    expect(result.assertions?.[0]?.kind).toBe("negative")
    expect(JSON.parse(result.response ?? "")).toEqual({ writes: [] })
    expect(result.note).toContain("engine copy_to_clipboard callback read via getClipboardState, no reply bytes")
  })

  test("osc52-write is inconclusive when the engine callback retained a different write", () => {
    const result = writeWithClipboard({ writes: [{ selector: "p", payload: "cHJpbWFyeQ==" }] })
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.assertions).toBeUndefined()
    expect(JSON.parse(result.response ?? "")).toEqual({ writes: [{ selector: "p", payload: "cHJpbWFyeQ==" }] })
    expect(result.note).toContain("p")
  })

  test.each(cells)("$id on $sha256", ({ sha256, id, audit }) => {
    const unlisted = run(id, "f".repeat(64), () => "")
    expect(JSON.stringify(unlisted.result)).not.toContain("replyPathAudit")

    const silent = run(id, sha256, () => "")
    const matched = silent.sent.filter((sequence) =>
      audit.matches === "prefix" ? sequence.startsWith(audit.query) : sequence === audit.query,
    )
    expect(matched.length).toBeGreaterThan(0)
    const state = JSON.parse(silent.result.response!)
    expect(state).toEqual({
      ...(audit.kind === "parser-rejected" && { rejection: "parser" }),
      replyPathAudit: {
        artifactSha256: sha256,
        featureId: id,
        ...audit,
        captures: matched.length,
        replyBytes: 0,
      },
      measuredResponse: unlisted.result.response ?? null,
      ...(audit.kind === "no-reply-path" && audit.matches === "prefix" && { matchedQueries: matched }),
    })
    if (audit.kind === "no-reply-path") {
      expect(silent.result).toMatchObject({
        criterionBranch: REPLY_PATH_AUDIT_REVIEW,
        tests: [{ id: "review", status: "test-todo" }],
      })
    } else {
      // @cto d9998884: a cited parser rejection on the live path is Unsupported, whatever the reply delivery.
      expect(silent.result).toMatchObject({
        pass: false,
        observation: { outcome: "unsupported", assertionType: "query_reply", note: "negative by source citation" },
        assertions: [{ assertionType: "query_reply", kind: "negative" }],
      })
      expect(silent.result).not.toHaveProperty("criterionBranch")
      expect(silent.result).not.toHaveProperty("tests")
      expect(probe(id).libAssertionType ?? "query_reply").toBe("query_reply")
    }

    const answer = (sequence: string) =>
      (audit.matches === "prefix" ? sequence.startsWith(audit.query) : sequence === audit.query) ? "\x1b" : ""
    expect(run(id, sha256, answer).result).toEqual(run(id, "f".repeat(64), answer).result)
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
    expect(result).toMatchObject({ pass: false, response: "", tests: [{ id: "criterion", status: "test-failure" }] })
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
        expect(result.tests).toMatchObject([{ id: "review", status: "test-todo" }])
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
          tests: [{ id: "review", status: "test-todo" }],
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
        expect(result).toMatchObject({ pass: false, tests: [{ id: "criterion", status: "test-failure" }] })
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
      expect(result).toMatchObject({ pass: false, response: "", tests: [{ status: "test-failure" }] })
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
      reason: "no-response",
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
      ["\x1b[?1;0;256S", "no-response"],
      ["\x1b[?2;0;640S", "invalid-reply"],
      ["\x1b[?2;0;0;480S", "insufficient-evidence"],
      ["", "no-response"],
    ] as const) {
      for (const result of [fromHeadless(raw), await fromTerminal(raw)]) {
        expect(result).toMatchObject({ pass: false, response: raw })
        if (raw === "") {
          expect(result.observation).toBeUndefined()
          expect(result.tests).toMatchObject([
            expect.objectContaining({ status: "test-failure", reason: "No Sixel geometry response for item 2" }),
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
      [null, null, null, null, null, null],
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
        { id: "review", status: "test-todo", reason: `Headless observable review required: ${unreported.note}` },
      ])
      expect(unreported.assertions).toBeUndefined()
      expect(JSON.parse(unreported.response ?? "")).toEqual({
        chars: [..."ALINKZ"],
        links: Array(6).fill({ reported: false }),
      })
      expect(unreported.note).toContain(runtimeIdentity ? "source-revision" : "runtime identity unavailable")
      if (runtimeIdentity) {
        expect(unreported.note).toContain(
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

  // These are the four retained runtime tuples from #31385, not a loaded-engine attestation.
  const absentOsc8Runtimes = [
    ...(["vt100", "vt220"] as const).map(
      (engine) =>
        [
          engine,
          {
            kind: "js",
            runtimeFormat: "js",
            engineVersion: "0.9.0",
            adapterVersion: "0.10.2",
            termlessRevision: "8b8664540f365fa0ba1d9b6400d3c4d1a160582c",
            resolvedPath: `vendor/vterm/packages/${engine}/src/index.ts`,
            integrity: {
              kind: "source",
              repository: "git@github.com:beorn/vterm.git",
              revision: "53a9eb9291b7880f4dc6a39a6802301049997a72",
              treeOid:
                engine === "vt100"
                  ? "5ffc7ad9ae120d0bf93c64b0fdc712eb40892896"
                  : "69366752918a6086c639123799cc3ac68d8083a0",
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
        adapterVersion: "0.10.2",
        termlessRevision: "2d97417328b7b1d086f9396b9a1731216ed134cc",
        resolvedPath: "vendor/termless/packages/libvterm/src/index.ts",
        integrity: {
          kind: "source",
          repository: "git@github.com:beorn/termless.git",
          revision: "2d97417328b7b1d086f9396b9a1731216ed134cc",
          treeOid: "d47c013290cf7a9cb1dae316fd77c66a11a2925a",
          cleanTree: true,
        },
        loadedBinary: {
          path: "vendor/termless/packages/libvterm/wasm/libvterm.wasm",
          sha256: "5937bd79139ee5856bcf1bd619cc44fcd2d750d3def3066a74956678cdaaaeb2",
        },
      },
    ],
    [
      "vt100-rust",
      {
        kind: "native",
        engineVersion: "0.16.2",
        adapterVersion: "0.10.2",
        termlessRevision: "2d97417328b7b1d086f9396b9a1731216ed134cc",
        loadedBinary: {
          path: "vendor/termless/packages/vt100-rust/termless-vt100-rust.node",
          sha256: "0919421290792a0c8be173dd50ec7a39c0ef68b1e0633fd979da13f22478c1d3",
        },
        provenance: {
          sha256: "0919421290792a0c8be173dd50ec7a39c0ef68b1e0633fd979da13f22478c1d3",
          sourceCommit: "6ffc0df79756fcc259d87131681641606540e512",
          buildHash: "7ab9ccc7744fbf5ae24c5ebb2748a144817e696f7f93959fa90a335d11646f68",
          toolchain:
            "rustc 1.94.0 (4a4ef493e 2026-03-02) (built from a source tarball); cargo 1.94.0 (85eff7c80 2026-01-15)",
          lockSha256: "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6",
        },
      },
    ],
  ] as const satisfies readonly (readonly [string, NonNullable<LibProbeSource["runtimeIdentity"]>])[]

  test.each(absentOsc8Runtimes)(
    "%s emits source-review assertions only for its audited OSC8 identity",
    (_engine, identity) => {
      const p = probe("extensions.osc8")
      if (!p.lib) throw new Error("OSC 8 needs headless callback")
      const unreported = linkedSource(Array(6).fill(undefined), false)
      const result = p.lib({ ...unreported, runtimeIdentity: identity })
      expect(result.criterionBranch).toBe("source-negative-review")
      expect(result.tests).toMatchObject([{ id: "review", status: "test-failure" }])
      expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
      expect(result.assertions).toMatchObject([
        { kind: "negative", assertionType: "buffer_state", observed: result.response },
      ])
      expect(JSON.parse(result.response ?? "")).toMatchObject({
        chars: [..."ALINKZ"],
        links: Array(6).fill({ reported: false }),
        runtimeIdentity: identity,
      })

      const foreignIdentities: NonNullable<LibProbeSource["runtimeIdentity"]>[] = [
        { ...identity, engineVersion: "unreviewed-version" },
      ]
      if (identity.kind === "js" && identity.integrity.kind === "source") {
        foreignIdentities.push(
          { ...identity, resolvedPath: "unreviewed/entry.ts" },
          { ...identity, integrity: { ...identity.integrity, repository: "unreviewed-repository" } },
          { ...identity, integrity: { ...identity.integrity, revision: "0".repeat(40) } },
          { ...identity, integrity: { ...identity.integrity, treeOid: "0".repeat(40) } },
          { ...identity, integrity: { ...identity.integrity, cleanTree: false } },
        )
      }
      if ("loadedBinary" in identity) {
        foreignIdentities.push(
          { ...identity, adapterVersion: "unreviewed-version" },
          { ...identity, termlessRevision: "0".repeat(40) },
          { ...identity, termlessRevision: "8b8664540f365fa0ba1d9b6400d3c4d1a160582c" },
          { ...identity, loadedBinary: { ...identity.loadedBinary, path: "unreviewed/binary" } },
          { ...identity, loadedBinary: { ...identity.loadedBinary, sha256: "0".repeat(64) } },
          {
            ...identity,
            loadedBinary: {
              ...identity.loadedBinary,
              sha256: "f309015f6094827922d9bc82cda53838f4094ac632251af90e83612f6f1c7e96",
            },
          },
        )
      }
      if (identity.kind === "native") {
        for (const key of ["sha256", "sourceCommit", "buildHash", "lockSha256"] as const) {
          foreignIdentities.push({ ...identity, provenance: { ...identity.provenance, [key]: "unreviewed" } })
        }
      }
      for (const runtimeIdentity of foreignIdentities) {
        const foreign = p.lib({ ...unreported, runtimeIdentity })
        expect(foreign.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
        expect(foreign.assertions).toBeUndefined()
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
        status: "test-todo",
        reason: "Cursor movement cannot verify OSC 8 link metadata or click behavior",
      }),
    ])
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
        expect.objectContaining({ status: "test-todo", reason: expect.any(String) }),
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
        status: "test-failure",
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
          expect.objectContaining({ status: "test-failure", reason: expect.any(String) }),
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
              status: "test-failure",
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
          if (raw === "") expect(result.tests).toMatchObject([{ status: "test-failure" }])
          else expect(result.observation?.outcome).toBe("inconclusive")
        }
      } else {
        expect(measuredSilence.observation).toBeUndefined()
        expect(measuredSilence.tests).toMatchObject([{ status: "test-failure" }])
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
          status: "test-todo",
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
          expect.objectContaining({ status: "test-failure", reason: "No complete OSC 52 c reply" }),
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
            status: "test-failure",
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
            status: "test-failure",
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
        status: "test-failure",
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
            status: "test-failure",
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
            status: "test-failure",
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
      expect(result.tests).toMatchObject([{ status: "test-failure" }])
    } else {
      expect(result.observation?.outcome).toBe("inconclusive")
      expect(result.assertions ?? []).toEqual([])
    }
  })

  test("viewport hold coverage names our missing actuator and readback without I/O", async () => {
    const p = probe("scrollback.viewport-hold-output")
    expect(p.lib).toBeTypeOf("function")
    expect(p.libAssertionType).toBe("buffer_state")
    if (!p.term) throw new Error("missing viewport coverage callback")
    const source = new Proxy(terminalSource({}), {
      get: () => {
        throw new Error("Viewport coverage must not perform I/O or inspect source state")
      },
    })
    const result = await p.term(source)
    expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
    expect(result.notTested?.noObservable).toMatch(/actuator.*readback/i)
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
            status: "test-failure",
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
        expect.objectContaining({ status: "test-failure", reason: expect.any(String) }),
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
        status: "test-failure",
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
  const declaredIds = [
    "extensions.kitty-graphics.animation",
    "extensions.kitty-graphics.unicode-placeholders",
    "extensions.sixel",
    "extensions.reflow",
    "extensions.semantic-prompts",
    "extensions.osc7-cwd",
    "extensions.osc-633-vscode",
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
        // missing observable so the recorder grades TEST TODO instead of a failed test
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
        expect(result.notTested, id).toEqual({
          reason: "no-semantic-observable",
          noObservable: "icon-name state",
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
        expect.objectContaining({ status: "test-todo", reason: expect.any(String) }),
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
  // Q17: a mode-state reply cannot substitute for the absent presentation-timing observer.
  test("modes.decsclm names missing presentation timing instead of attempting a mode-state criterion", () => {
    const p = probe("modes.decsclm")
    if (!p.lib) throw new Error("Missing headless DECSCLM callback")
    const seen: string[] = []
    const result = p.lib(
      context({
        feed: (text) => seen.push(text),
        feedCapture: (text) => {
          seen.push(text)
          return "\x1b[?4;1$y"
        },
      }),
    )
    expect(result.notTested).toMatchObject({
      reason: "no-semantic-observable",
      noObservable: expect.stringMatching(/presentation.*tim|scroll.*tim/i),
    })
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    expect(seen).toEqual([])
  })

  // Q17: enabled metadata cannot supply a host palette actuator or persistent unsolicited-event listener.
  // The native DECRPM recognition table below never exercises this library coverage boundary.
  test.each([true, false, null] as const)(
    "mode 2031 names missing palette-event observation despite metadata %s",
    (enabled) => {
      const p = probe("modes.color-scheme-reporting")
      if (!p.lib) throw new Error("Missing headless color-scheme callback")
      const seen: string[] = []
      const result = p.lib(context({ getMode: () => enabled as boolean, feed: (text) => seen.push(text) }))
      expect(result.notTested).toMatchObject({
        reason: "no-semantic-observable",
        noObservable: expect.stringMatching(/palette|color.scheme/i),
      })
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(seen).toEqual([])
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
    { name: "silent", seeded: "", setter: "", status: "test-todo" },
    { name: "wrong value", seeded: "\x1b]10;rgb:00/00/00\x07", setter: "", status: "test-failure" },
    { name: "wrong slot", seeded: "\x1b]11;rgb:aa/bb/cc\x07", setter: "", status: "test-failure" },
    { name: "partial", seeded: "\x1b]10;rgb:aa/bb/cc", setter: "", status: "test-failure" },
    { name: "extra", seeded: "extra\x1b]10;rgb:aa/bb/cc\x07", setter: "", status: "test-failure" },
    {
      name: "multiple",
      seeded: "\x1b]10;rgb:aa/bb/cc\x07\x1b]10;rgb:aa/bb/cc\x07",
      setter: "",
      status: "test-failure",
    },
    { name: "setter acknowledgement", seeded: "\x1b]10;rgb:aa/bb/cc\x07", setter: "ack", status: "test-failure" },
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
      expect(result.criterionBranch).toBe(status === "test-todo" ? "color-readback-review" : undefined)
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
      expect(result).toMatchObject({ pass: false, tests: [{ status: "test-failure" }] })
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
        expect.objectContaining({ status: "test-failure", reason: expect.stringContaining("failed: Error:") }),
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
      expect(fixture.foreground()).toBe(fixture.original)
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
      [2, "supported"],
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
            status: "test-failure",
            reason: "No DECRPM 2031 reply; update events were not tested",
          }),
        ])
      } else {
        expect(result.observation, `Ps ${ps}`).toMatchObject({ outcome, assertionType: "query_reply" })
      }
      if (ps === 4) {
        expect(result.assertions, "Ps 4").toMatchObject([
          { kind: "negative", expected: "DECRPM mode 2031 can be set", observed: "permanently reset (Ps 4)" },
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

  test("semantic prompt OSC consumption and CPR do not claim prompt integration", async () => {
    // Constant 1;2 CPR for every read must never qualify as a measured home / target / control sequence.
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      const result = await probe(id).term!(terminalSource({ queryCursorPosition: async () => ({ row: 1, col: 2 }) }))
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({
          status: "test-todo",
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
        expect.objectContaining({ status: "test-failure", reason: "No cursor reply after semantic prompt marker" }),
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
          status: "test-todo",
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
            status: "test-todo",
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
        status: "test-todo",
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
              status: "test-todo",
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
            status: "test-todo",
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
