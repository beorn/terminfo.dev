import type { LibProbeSource, ProbeDefinition, ProbeCallbackResult, TerminalQueryOutcome } from "./types.ts"
import {
  REPLY_AFTER_SENTINEL_NOTE,
  parserStateResult,
  probe,
  notTestedResult,
  replyFrame,
  reviewResult,
  HEADLESS_OBSERVABLE_REVIEW,
  sentinelAnswer,
  sentinelNegativeResult,
  sentinelSilenceResult,
} from "./helpers.ts"
import { nativeHostRecipeResult } from "./native-host-audit.ts"

// The individual integrated APIs return parser/readback backends, not a terminal-owned application child.
// These citations were read at this Termless pin; runtime identity alone is not the source audit.
const TERM_FEATURES_API_REVISION = "07628619c7b5b5f74de1536df16dab0bc62676b6"
const TERM_FEATURES_API_CITATIONS: Readonly<Record<string, readonly [string, string]>> = {
  "vendor/vterm/packages/vterm/src/index.ts": [
    "vterm",
    "packages/vterm/src/backend.ts:63 createVtermBackend integrates the vterm Screen as a TerminalBackend with no application-child environment API",
  ],
  "vendor/vterm/packages/vt220/src/index.ts": [
    "vt220",
    "packages/vt220/src/backend.ts:39 createVt220Backend integrates the vt220 Screen as a TerminalBackend with no application-child environment API",
  ],
  "vendor/vterm/packages/vt100/src/index.ts": [
    "vt100",
    "packages/vt100/src/backend.ts:42 createVt100Backend integrates the vt100 Screen as a TerminalBackend with no application-child environment API",
  ],
  "vendor/termless/packages/vt100-rust/termless-vt100-rust.node": [
    "vt100-rust",
    "packages/vt100-rust/src/backend.ts:174 createVt100RustBackend returns TerminalBackend",
  ],
  "vendor/termless/packages/wezterm/termless-wezterm.node": [
    "wezterm",
    "packages/wezterm/src/backend.ts:197 createWeztermBackend returns TerminalBackend",
  ],
  "vendor/termless/packages/alacritty/termless-alacritty-native.node": [
    "alacritty",
    "packages/alacritty/src/backend.ts:151 createAlacrittyBackend returns TerminalBackend",
  ],
  "vendor/termless/packages/ghostty-native/termless-ghostty-native.node": [
    "ghostty-native",
    "packages/ghostty-native/src/backend.ts:217 createGhosttyNativeBackend returns TerminalBackend",
  ],
  "vendor/termless/packages/libvterm/src/index.ts": [
    "libvterm",
    "packages/libvterm/src/backend.ts:168 createLibvtermBackend returns the parser/readback LegacyBackend",
  ],
}

function termFeaturesLibraryReview(ctx: LibProbeSource): ProbeCallbackResult {
  const identity = ctx.runtimeIdentity
  if (!identity || identity.termlessRevision !== TERM_FEATURES_API_REVISION) {
    return notTestedResult("TERM_FEATURES: no pinned engine API source audit at this runtime", {})
  }
  const entry = identity.kind === "native" ? identity.loadedBinary.path : identity.resolvedPath
  let citation = TERM_FEATURES_API_CITATIONS[entry]
  if (
    identity.kind === "js" &&
    identity.integrity.kind === "registry" &&
    identity.engineVersion === "6.0.0" &&
    identity.resolvedPath.endsWith("/@xterm/headless/lib-headless/xterm-headless.js")
  ) {
    citation = [
      "xtermjs",
      "packages/xtermjs/src/backend.ts:145 createXtermBackend integrates @xterm/headless as an in-process TerminalBackend",
    ]
  } else if (
    identity.kind === "js" &&
    identity.runtimeFormat === "wasm" &&
    identity.engineVersion === "0.4.0" &&
    identity.resolvedPath.endsWith("/ghostty-web/dist/ghostty-web.js")
  ) {
    citation = [
      "ghostty",
      "packages/ghostty/src/backend.ts:249 createGhosttyBackend returns TerminalBackend over the ghostty-web core",
    ]
  } else if (
    identity.kind === "native" &&
    identity.loadedBinary.sha256 === "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886"
  ) {
    citation = [
      "kitty",
      "packages/kitty/src/backend.ts:250-315 createKittyBackend exposes parser/readback via +runpy bridge; that helper subprocess is not a terminal-owned application child",
    ]
  }
  if (!citation) return notTestedResult("TERM_FEATURES: no engine-specific API source citation at this runtime", {})
  const note =
    "TERM_FEATURES is a terminal program's child-environment export; this library API spawns no application child process"
  return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
    audit: {
      engine: citation[0],
      engineVersion: identity.engineVersion,
      sourceCitation: `${citation[1]}; Termless@${TERM_FEATURES_API_REVISION} src/terminal/types.ts:275-320 TerminalBackend has no application-child environment API`,
      apiRevision: TERM_FEATURES_API_REVISION,
      runtimeIdentity: identity,
    },
  })
}

/** These patterns match complete answers to the specific query, not arbitrary consumed output. */
interface DeviceReply {
  id: string
  query: string
  valid: RegExp
  malformed: RegExp
  expected: string
  refusal?: RegExp
  /**
   * A refusal of the single setting or name this probe's contract asks is the measured answer,
   * not a partial one. Set only where the contract names exactly one subject (27914: XTGETXRES
   * termName); the default leaves a refusal inconclusive.
   */
  refusalDecisive?: boolean
  /** A complete, well-formed answer to this query whose payload is not the expected one. */
  contradicts?: RegExp
  note?: (frame: string) => string | undefined
  direct?: boolean
}

function deviceReplyResult(
  spec: DeviceReply,
  raw: string,
  matchedFrame: string | null,
  reason: TerminalQueryOutcome["reason"],
  sentinel?: { atMs: number; graceMs: number },
): ProbeCallbackResult {
  // F1 (27832): a frame that lands after the sentinel's DA1 answer is a late reply, graded by the frame
  // and recorded as late. Only when `sentinel` carries the measured ordering is that certain, so a
  // frame arriving after DA1 without the measurement keeps its null.
  const da1At = sentinelAnswer(raw)?.start ?? -1
  if (matchedFrame && da1At !== -1 && raw.indexOf(matchedFrame) > da1At && !sentinel) matchedFrame = null
  const ordered = { ...(sentinel && { note: REPLY_AFTER_SENTINEL_NOTE }) }
  const valid = matchedFrame ? spec.valid.exec(matchedFrame) : null
  if (valid?.[0]) {
    const note = spec.note?.(valid[0])
    const composed = [note, ordered.note].filter((part): part is string => part !== undefined).join("; ")
    return {
      pass: true,
      response: raw,
      ...(composed && { note: composed }),
      observation: { outcome: "supported", assertionType: "query_reply", ...(composed && { note: composed }) },
      assertions: [
        { assertionType: "query_reply" as const, kind: "positive", expected: spec.expected, observed: valid[0] },
      ],
    }
  }
  const refusal = matchedFrame ? spec.refusal?.exec(matchedFrame) : null
  if (refusal?.[0]) {
    if (spec.refusalDecisive) {
      const decisiveNote = ["Requested name refused; the contract asks exactly one name", ordered.note]
        .filter((part): part is string => part !== undefined)
        .join("; ")
      return {
        pass: false,
        response: raw,
        note: decisiveNote,
        observation: { outcome: "unsupported", assertionType: "query_reply", note: decisiveNote },
        assertions: [
          { assertionType: "query_reply" as const, kind: "negative", expected: spec.expected, observed: refusal[0] },
        ],
      }
    }
    const refusalNote = ["Requested setting or name refused; other settings or names unmeasured", ordered.note]
      .filter((part): part is string => part !== undefined)
      .join("; ")
    return {
      pass: false,
      response: raw,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "query_reply",
        note: refusalNote,
      },
    }
  }
  // A complete, surfaced answer whose payload contradicts the expectation is a measured negative.
  // matchedFrame is never a frame that arrived after the DA1 sentinel, so late output cannot be graded.
  const contradiction = matchedFrame ? (spec.contradicts?.exec(matchedFrame) ?? null) : null
  if (contradiction?.[0]) {
    return {
      pass: false,
      response: raw,
      ...(ordered.note && { note: ordered.note }),
      observation: { outcome: "unsupported", assertionType: "query_reply", ...ordered },
      assertions: [
        {
          assertionType: "query_reply" as const,
          kind: "negative",
          expected: spec.expected,
          observed: contradiction[0],
        },
      ],
    }
  }
  const silent = sentinelNegativeResult(raw, sentinel, spec.expected)
  if (silent) return silent
  // Raw bytes remain available for diagnostics.
  const hasCompleteUnmatchedFrame =
    spec.valid.test(raw) || spec.refusal?.test(raw) === true || spec.contradicts?.test(raw) === true
  const missingReason =
    !hasCompleteUnmatchedFrame && spec.malformed.test(raw)
      ? "invalid-reply"
      : reason === "timeout"
        ? "timeout"
        : "no-response"
  if (raw.length === 0) {
    return { pass: false, response: raw, tests: [{ id: "criterion", status: "test-failure", reason: missingReason }] }
  }
  return {
    pass: false,
    response: raw,
    observation: { outcome: "inconclusive", reason: missingReason, assertionType: "query_reply" },
  }
}

/** Every complete answer shape this query accepts: the expected frame, a refusal, or a contradiction. */
function answerPattern(spec: DeviceReply): RegExp {
  const sources = [spec.valid.source, spec.refusal?.source, spec.contradicts?.source].filter(
    (source): source is string => source !== undefined,
  )
  return new RegExp(sources.join("|"), spec.valid.flags)
}

/**
 * Live's grading of one query outcome. A library probe source on a proven reply path offers the same
 * outcome through `queryWithSentinelOutcome` (#30554), so both arms grade through here; a library
 * probe source without that member keeps its capture-only reading.
 */
function deviceOutcomeResult(spec: DeviceReply, outcome: TerminalQueryOutcome): ProbeCallbackResult {
  return deviceReplyResult(spec, outcome.raw, replyFrame(outcome), outcome.reason, outcome.sentinel)
}

function deviceQuery(spec: DeviceReply): ProbeDefinition {
  const responsePattern = answerPattern(spec)
  const hostPixels = spec.query === "\x1b[14t"
  const definition = probe(
    spec.id,
    (ctx) => {
      // DA1 cannot be its own sentinel, so primary DA1 keeps the capture, as live keeps its direct query.
      const outcome = !spec.direct ? ctx.queryWithSentinelOutcome?.(spec.query, responsePattern) : undefined
      const raw = outcome ? outcome.raw : ctx.feedCapture(spec.query)
      const result = outcome
        ? deviceOutcomeResult(spec, outcome)
        : deviceReplyResult(spec, raw, responsePattern.exec(raw)?.[0] ?? null, "sentinel")
      const identity = ctx.runtimeIdentity
      const zeroGeometry =
        (spec.id === "device.xtwinops-14" && /^\x1b\[4;0;0t(?:\x1b\[\?[0-9]+(?:;[0-9]+)*c)?$/.test(raw)) ||
        (spec.id === "device.xtwinops-16" && /^\x1b\[6;0;0t(?:\x1b\[\?[0-9]+(?:;[0-9]+)*c)?$/.test(raw))
      if (
        zeroGeometry &&
        result.observation?.outcome === "inconclusive" &&
        identity?.kind === "js" &&
        identity.runtimeFormat === "js" &&
        identity.resolvedPath === "vendor/vterm/packages/vterm/src/index.ts" &&
        identity.integrity.kind === "source" &&
        identity.integrity.cleanTree &&
        identity.integrity.repository === "git@github.com:beorn/vterm.git" &&
        identity.integrity.revision === "1cfc325f3aedd4617e437ee76e6a03fc2cc16438" &&
        identity.integrity.treeOid === "2ee13d2cb894e86ee9575dd6945f42028df44966"
      ) {
        return reviewResult(
          "headless-geometry-review",
          "Required independent review of the audited headless context and retained zero geometry reply pending",
          "Audited vterm headless subject has no font or window pixel geometry",
          {
            query: spec.query,
            raw,
            runtimeIdentity: identity,
            sourceCitation:
              "vterm screen.ts at 1cfc325f: ScreenOptions has no physical font/window metrics; XTWINOPS14/16 deliberately report unknown zero dimensions (#30575)",
          },
        )
      }
      return hostPixels
        ? nativeHostRecipeResult(
            ctx,
            result,
            "text-area-size",
            "pixel-geometry",
            spec.query,
            outcome ? sentinelSilenceResult(outcome, spec.expected) !== null : raw === "",
          )
        : result
    },
    async (ctx) => {
      // Primary DA1 answers its own direct query; all other device queries use DA1 as a sentinel.
      const outcome = spec.direct
        ? await ctx.queryOutcome(spec.query, responsePattern)
        : await ctx.queryWithSentinelOutcome(spec.query, responsePattern)
      return deviceOutcomeResult(spec, outcome)
    },
    "query_reply",
  )
  return {
    ...definition,
    termWrites: "query",
    libAssertionType: "query_reply",
    ...(hostPixels && {
      libHostRecipes: [{ recipe: "text-area-size" as const, query: spec.query, missing: ["pixel-geometry" as const] }],
    }),
  }
}

const DECRQSS_SGR: DeviceReply = {
  id: "device.decrqss",
  query: "\x1bP$qm\x1b\\",
  valid: /\x1bP1\$r[0-9:;]*m\x1b\\/,
  refusal: /\x1bP0\$r\x1b\\/,
  malformed: /\x1bP[01]\$r/,
  expected: "complete DECRQSS status 1 SGR parameters ending m and ST",
}

const DECRQSS_DECSTBM: DeviceReply = {
  id: "device.decrqss",
  query: "\x1bP$qr\x1b\\",
  valid: /\x1bP1\$r[0-9]+;[0-9]+r\x1b\\/,
  refusal: /\x1bP0\$r\x1b\\/,
  malformed: /\x1bP[01]\$r/,
  expected: "complete DECRQSS status 1 DECSTBM margins ending r and ST",
}

const DECRQSS_DECSCL: DeviceReply = {
  id: "device.decrqss",
  query: '\x1bP$q"p\x1b\\',
  valid: /\x1bP1\$r[0-9]+;[0-9]+"p\x1b\\/,
  refusal: /\x1bP0\$r\x1b\\/,
  malformed: /\x1bP[01]\$r/,
  expected: 'complete DECRQSS status 1 DECSCL conformance parameters ending "p and ST',
}

/**
 * Exact loaded WASM artifacts whose source implements neither CSI 22 ; 0 t (push) nor CSI 23 ; 0 t (pop)
 * (#31735, @cto 863bef67). A black-box push/pop round trip that observes { original: "pushed-title",
 * changed: "new-title", restored: "new-title" } cannot separate a broken push from a broken pop on an
 * unaudited engine, but when the loaded artifact's source implements neither operation and holds no title
 * stack, both device.xtwinops-22 and device.xtwinops-23 are decided Unsupported by source citation.
 */
const TITLE_STACK_UNIMPLEMENTED_AUDITS: ReadonlyMap<string, string> = new Map([
  [
    "d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9",
    "ghostty 5714ed07a1012573261b7b7e3ed2add9c1504496 src/terminal/stream.zig:1825-1843 dispatches .title_push and .title_pop; src/termio/stream_handler.zig:343-346 has .title_push, .title_pop => {} // Unimplemented, and termless vendor/ghostty-web/ghostty-wasm-api.patch keeps .title_push and .title_pop as no-ops",
  ],
  [
    "5937bd79139ee5856bcf1bd619cc44fcd2d750d3def3066a74956678cdaaaeb2",
    "libvterm 0.3.3 src/state.c:978 on_csi has no case 0x74 ('t') and VTermState holds no title stack, so neither CSI 22;0t nor CSI 23;0t is implemented",
  ],
])

function titleStackHeadless(ctx: LibProbeSource, expected: string): ProbeCallbackResult {
  ctx.feed("\x1b]2;pushed-title\x07")
  const original = ctx.getTitle()
  ctx.feed("\x1b[22;0t")
  ctx.feed("\x1b]2;new-title\x07")
  const changed = ctx.getTitle()
  ctx.feed("\x1b[23;0t")
  const restored = ctx.getTitle()
  if (original === "pushed-title" && changed === "new-title" && restored === "pushed-title") {
    return parserStateResult(true, expected, { original, changed, restored })
  }
  const identity = ctx.runtimeIdentity
  const artifactSha256 = identity !== undefined && "loadedBinary" in identity ? identity.loadedBinary.sha256 : undefined
  const sourceCitation =
    original === "pushed-title" && changed === "new-title" && restored === "new-title" && artifactSha256 !== undefined
      ? TITLE_STACK_UNIMPLEMENTED_AUDITS.get(artifactSha256)
      : undefined
  if (sourceCitation !== undefined && artifactSha256 !== undefined) {
    return parserStateResult(
      false,
      expected,
      { original, changed, restored, artifactSha256, sourceCitation },
      "negative by source citation",
    )
  }
  return parserStateResult(
    null,
    expected,
    { original, changed, restored },
    original !== "pushed-title" || changed !== "new-title"
      ? "Title setup was not observable"
      : "Title push/pop did not restore the old title; the failing operation is unknown",
  )
}

function refusedFrame(spec: DeviceReply, matchedFrame: string | null): boolean {
  return Boolean(matchedFrame && spec.refusal?.exec(matchedFrame)?.[0])
}

/** An earlier selector refusal proves DECRQSS speaks; later silence is never a facility-wide F1 negative. */
function decrqssAfterRefusal(
  spec: DeviceReply,
  second: TerminalQueryOutcome,
  refused: string,
  retainedRefusals = "",
): ProbeCallbackResult {
  const setting = spec === DECRQSS_DECSTBM ? "DECSTBM" : "DECSCL"
  if (second.raw.length === 0) {
    return {
      pass: false,
      response: second.raw,
      tests: [
        {
          id: "criterion",
          status: "test-failure",
          reason: `${refused}; ${setting} unanswered; DECRQSS facility still speaks`,
        },
      ],
    }
  }
  const secondFrame = replyFrame(second)
  const graded = deviceReplyResult(spec, second.raw, secondFrame, second.reason, second.sentinel)
  if (graded.observation?.outcome === "supported") {
    const note = [refused, graded.observation.note].filter(Boolean).join("; ")
    return {
      pass: true,
      response: retainedRefusals + second.raw,
      note,
      observation: { ...graded.observation, note },
      assertions: graded.assertions,
    }
  }
  if (refusedFrame(spec, secondFrame)) {
    const da1At = sentinelAnswer(second.raw)?.start ?? -1
    const late =
      Boolean(second.sentinel) && secondFrame !== null && da1At !== -1 && second.raw.indexOf(secondFrame) > da1At
    const note = [`${refused}; ${setting} refused`, late ? REPLY_AFTER_SENTINEL_NOTE : undefined]
      .filter((part): part is string => part !== undefined)
      .join("; ")
    return {
      pass: false,
      response: second.raw,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "query_reply",
        note,
      },
    }
  }
  const hasCompleteUnmatchedFrame = spec.valid.test(second.raw) || spec.refusal?.test(second.raw) === true
  const reason =
    !hasCompleteUnmatchedFrame && spec.malformed.test(second.raw)
      ? "invalid-reply"
      : second.reason === "timeout"
        ? "timeout"
        : "insufficient-evidence"
  return {
    pass: false,
    response: second.raw,
    observation: {
      outcome: "inconclusive",
      reason,
      assertionType: "query_reply",
      note: `${refused}; ${setting} unanswered; DECRQSS facility still speaks`,
    },
  }
}

function decrqssFacilityProbe(): ProbeDefinition {
  const sgrPattern = answerPattern(DECRQSS_SGR)
  const decstbmPattern = answerPattern(DECRQSS_DECSTBM)
  const decsclPattern = answerPattern(DECRQSS_DECSCL)
  const definition = probe(
    "device.decrqss",
    (ctx) => {
      // Sample the facility in order, advancing only after a complete selector refusal.
      if (ctx.queryWithSentinelOutcome) {
        const sgr = ctx.queryWithSentinelOutcome(DECRQSS_SGR.query, sgrPattern)
        if (!refusedFrame(DECRQSS_SGR, replyFrame(sgr))) return deviceOutcomeResult(DECRQSS_SGR, sgr)
        const second = ctx.queryWithSentinelOutcome(DECRQSS_DECSTBM.query, decstbmPattern)
        if (!refusedFrame(DECRQSS_DECSTBM, replyFrame(second))) {
          return decrqssAfterRefusal(DECRQSS_DECSTBM, second, "SGR refused")
        }
        return decrqssAfterRefusal(
          DECRQSS_DECSCL,
          ctx.queryWithSentinelOutcome(DECRQSS_DECSCL.query, decsclPattern),
          "SGR refused; DECSTBM refused",
          sgr.raw + second.raw,
        )
      }
      const raw = ctx.feedCapture(DECRQSS_SGR.query)
      return deviceReplyResult(DECRQSS_SGR, raw, sgrPattern.exec(raw)?.[0] ?? null, "sentinel")
    },
    async (ctx) => {
      const sgr = await ctx.queryWithSentinelOutcome(DECRQSS_SGR.query, sgrPattern)
      if (!refusedFrame(DECRQSS_SGR, replyFrame(sgr))) return deviceOutcomeResult(DECRQSS_SGR, sgr)
      const second = await ctx.queryWithSentinelOutcome(DECRQSS_DECSTBM.query, decstbmPattern)
      if (!refusedFrame(DECRQSS_DECSTBM, replyFrame(second))) {
        return decrqssAfterRefusal(DECRQSS_DECSTBM, second, "SGR refused")
      }
      return decrqssAfterRefusal(
        DECRQSS_DECSCL,
        await ctx.queryWithSentinelOutcome(DECRQSS_DECSCL.query, decsclPattern),
        "SGR refused; DECSTBM refused",
        sgr.raw + second.raw,
      )
    },
    "query_reply",
  )
  return { ...definition, termWrites: "query", libAssertionType: "query_reply" }
}

const iconLabelReply: DeviceReply = {
  id: "device.xtwinops-20",
  query: "\x1b[20t",
  valid: /\x1b\]Ltest-icon(?:\x07|\x1b\\)/,
  malformed: /\x1b\]L/,
  // A complete, terminated OSC L frame is a measured negative when its whole payload is not the
  // exact label; the payload class keeps the match on one frame so it cannot span a truncated starter.
  contradicts: /\x1b\]L[^\x07\x1b]*(?:\x07|\x1b\\)/,
  expected: "OSC 1 + CSI 20 t round trip returns the exact icon label",
}

const windowTitleReply: DeviceReply = {
  id: "device.xtwinops-21",
  query: "\x1b[21t",
  valid: /\x1b\]ltest-title(?:\x07|\x1b\\)/,
  malformed: /\x1b\]l/,
  expected: "CSI 21 t returns the exact window title set by OSC 2",
}

export const deviceProbes: ProbeDefinition[] = [
  deviceQuery({
    id: "device.primary-da",
    query: "\x1b[c",
    // Kitty includes a trailing empty parameter: CSI ? 62 ; 52 ; c.
    valid: /\x1b\[\?[0-9]+(?:;[0-9]+)*;?c/,
    malformed: /\x1b\[\?/,
    expected: "complete DA1 CSI ? numeric attributes c",
    direct: true, // DA1 is also the normal sentinel; it must be queried directly.
  }),
  deviceQuery({
    id: "device.status-report",
    query: "\x1b[5n",
    valid: /\x1b\[(?:0|3)n/,
    malformed: /\x1b\[[0-9]*n/,
    expected: "complete DSR 5 status 0 (ready) or 3 (malfunction)",
    note: (frame) => (frame === "\x1b[3n" ? "Terminal reports malfunction" : undefined),
  }),
  deviceQuery({
    id: "device.secondary-da",
    query: "\x1b[>c",
    valid: /\x1b\[>[0-9]+;[0-9]+;[0-9]+c/,
    malformed: /\x1b\[>/,
    expected: "complete DA2 CSI > three numeric fields c",
  }),
  deviceQuery({
    id: "device.tertiary-da",
    query: "\x1b[=c",
    valid: /\x1bP!\|[0-9A-Fa-f]{8}\x1b\\/,
    malformed: /\x1bP!\|/,
    expected: "complete DECRPTUI DCS !| followed by four hexadecimal pairs and ST",
  }),
  decrqssFacilityProbe(),
  deviceQuery({
    id: "device.xtgettcap",
    query: "\x1bP+q544e\x1b\\",
    valid: /\x1bP1\+r544e=(?:[0-9A-Fa-f]{2})+\x1b\\/i,
    refusal: /\x1bP0\+r\x1b\\/,
    malformed: /\x1bP[01]\+r/,
    expected: "complete XTGETTCAP status 1 for TN with even-length hex value and ST",
  }),
  deviceQuery({
    id: "device.decrpm",
    query: "\x1b[?7$p",
    valid: /\x1b\[\?7;[1-4]\$y/,
    refusal: /\x1b\[\?7;0\$y/,
    malformed: /\x1b\[\?[0-9]+;[0-9]*\$y|\x1b\[\?7(?:;|\$)/,
    expected: "complete DECRPM for DECAWM mode 7 with recognized state 1–4",
  }),
  deviceQuery({
    id: "device.xtversion",
    query: "\x1b[>0q",
    valid: /\x1bP>\|[\x20-\x7e]+\x1b\\/,
    malformed: /\x1bP>\|/,
    expected: "complete XTVERSION DCS >| printable name/version ST",
  }),
  probe(
    "device.term-features",
    termFeaturesLibraryReview,
    () => Promise.resolve(notTestedResult("terminal child environment", {})),
    null,
  ),

  // DSR ?996 — color-scheme query: CSI ? 996 n → CSI ? 997 ; Ps n
  {
    ...probe(
      "device.dsr-996-color-scheme",
      (ctx) => {
        if (ctx.queryWithSentinelOutcome) {
          const silence = sentinelSilenceResult(
            ctx.queryWithSentinelOutcome("\x1b[?996n", /\x1b\[\?997;([12])n/),
            "DSR ?996 yields complete DSR ?997;1n or ?997;2n",
          )
          if (silence) return silence
        }
        const response = ctx.feedCapture("\x1b[?996n")
        const match = /\x1b\[\?997;([12])n/.exec(response)
        if (!match?.[0]) {
          return {
            pass: false,
            note: "No valid DSR ?997 color-scheme response",
            response,
            ...(response.length === 0
              ? {
                  tests: [
                    {
                      id: "criterion",
                      status: "test-failure",
                      reason: response.includes("\x1b[?997;") ? "invalid-reply" : "no-response",
                    },
                  ] as [{ id: string; status: "test-failure"; reason: string }],
                }
              : {
                  observation: {
                    outcome: "inconclusive",
                    assertionType: "query_reply",
                    reason: response.includes("\x1b[?997;") ? "invalid-reply" : "no-response",
                  },
                }),
          }
        }
        return {
          pass: true,
          note: match[1] === "1" ? "dark" : "light",
          response,
          observation: {
            outcome: "supported",
            assertionType: "query_reply",
            note: "Current scheme queried; unsolicited change events were not tested",
          },
          assertions: [
            {
              assertionType: "query_reply" as const,
              kind: "positive",
              expected: "DSR ?996 yields complete DSR ?997;1n or ?997;2n",
              observed: match[0],
            },
          ],
        }
      },
      async (ctx) => {
        const reply = await ctx.queryWithSentinelOutcome("\x1b[?996n", /\x1b\[\?997;([12])n/)
        const match = reply.match
        if (!match?.[0]) {
          const silent = sentinelNegativeResult(
            reply.raw,
            reply.sentinel,
            "DSR ?996 yields complete DSR ?997;1n or ?997;2n",
          )
          if (silent) return silent
          return {
            pass: false,
            note: "No valid DSR ?997 color-scheme response",
            response: reply.raw,
            ...(reply.raw.length === 0
              ? {
                  tests: [
                    {
                      id: "criterion",
                      status: "test-failure",
                      reason: reply.raw.includes("\x1b[?997;")
                        ? "invalid-reply"
                        : reply.reason === "timeout"
                          ? "timeout"
                          : "no-response",
                    },
                  ] as [{ id: string; status: "test-failure"; reason: string }],
                }
              : {
                  observation: {
                    outcome: "inconclusive",
                    assertionType: "query_reply",
                    reason: reply.raw.includes("\x1b[?997;")
                      ? "invalid-reply"
                      : reply.reason === "timeout"
                        ? "timeout"
                        : "no-response",
                  },
                }),
          }
        }
        return {
          pass: true,
          note: match[1] === "1" ? "dark" : "light",
          response: match[0],
          observation: {
            outcome: "supported",
            assertionType: "query_reply",
            note: "Current scheme queried; unsolicited change events were not tested",
          },
          assertions: [
            {
              assertionType: "query_reply" as const,
              kind: "positive",
              expected: "DSR ?996 yields complete DSR ?997;1n or ?997;2n",
              observed: match[0],
            },
          ],
        }
      },
      "query_reply",
    ),
    termWrites: "query",

    libAssertionType: "query_reply",
  },

  // XTWINOPS 14 — report text-area size in pixels: CSI 14 t → CSI 4 ; H ; W t
  deviceQuery({
    id: "device.xtwinops-14",
    query: "\x1b[14t",
    valid: /\x1b\[4;[1-9][0-9]*;[1-9][0-9]*t/,
    malformed: /\x1b\[4;/,
    expected: "CSI 14 t reports text-area pixels as CSI 4;positive-height;positive-width t",
  }),

  // XTWINOPS 16 — report cell size in pixels: CSI 16 t → CSI 6 ; H ; W t
  deviceQuery({
    id: "device.xtwinops-16",
    query: "\x1b[16t",
    valid: /\x1b\[6;[1-9][0-9]*;[1-9][0-9]*t/,
    malformed: /\x1b\[6;/,
    expected: "CSI 16 t returns a complete CSI 6;positive-height;positive-width t frame",
  }),

  // XTWINOPS 18 — report text area size in chars: CSI 18 t → CSI 8 ; rows ; cols t
  deviceQuery({
    id: "device.xtwinops-18",
    query: "\x1b[18t",
    valid: /\x1b\[8;[1-9][0-9]*;[1-9][0-9]*t/,
    malformed: /\x1b\[8;/,
    expected: "CSI 18 t returns a complete CSI 8;positive-rows;positive-columns t frame",
  }),

  // XTWINOPS 20 — report icon label: CSI 20 t → OSC L label ST
  // Set icon label via OSC 1, then query with CSI 20 t and verify response.
  {
    ...probe(
      "device.xtwinops-20",
      (ctx) => {
        ctx.feed("\x1b]1;test-icon\x07")
        if (ctx.queryWithSentinelOutcome) {
          return deviceOutcomeResult(
            iconLabelReply,
            ctx.queryWithSentinelOutcome(iconLabelReply.query, answerPattern(iconLabelReply)),
          )
        }
        const raw = ctx.feedCapture(iconLabelReply.query)
        return deviceReplyResult(iconLabelReply, raw, answerPattern(iconLabelReply).exec(raw)?.[0] ?? null, "sentinel")
      },
      async (ctx) => {
        ctx.write("\x1b]1;test-icon\x07")
        const reply = await ctx.queryWithSentinelOutcome(iconLabelReply.query, answerPattern(iconLabelReply))
        return deviceOutcomeResult(iconLabelReply, reply)
      },
    ),
    libAssertionType: "query_reply",
  },

  // XTWINOPS 21 — report window title: CSI 21 t → OSC l title ST
  // Set a known title via OSC 2, then query to verify it's reported back.
  {
    ...probe(
      "device.xtwinops-21",
      (ctx) => {
        ctx.feed("\x1b]2;test-title\x07")
        if (ctx.queryWithSentinelOutcome) {
          return deviceOutcomeResult(
            windowTitleReply,
            ctx.queryWithSentinelOutcome(windowTitleReply.query, windowTitleReply.valid),
          )
        }
        const raw = ctx.feedCapture(windowTitleReply.query)
        return deviceReplyResult(windowTitleReply, raw, windowTitleReply.valid.exec(raw)?.[0] ?? null, "sentinel")
      },
      async (ctx) => {
        ctx.write("\x1b]2;test-title\x07")
        const reply = await ctx.queryWithSentinelOutcome(windowTitleReply.query, windowTitleReply.valid)
        return deviceOutcomeResult(windowTitleReply, reply)
      },
    ),
    libAssertionType: "query_reply",
  },

  // XTWINOPS 22 — push title/icon stack: CSI 22 ; 0 t
  // A successful push/pop round trip establishes both operations; failure cannot identify either
  // unless the loaded artifact's source is audited to implement neither operation (#31735, @cto 863bef67).
  {
    ...probe(
      "device.xtwinops-22",
      (ctx) =>
        titleStackHeadless(ctx, "XTWINOPS 22 preserves the old title on its stack after a different title is set"),
      async (ctx) => {
        ctx.write("\x1b]2;pushed-title\x07")
        ctx.write("\x1b[22;0t") // push
        try {
          ctx.write("\x1b]2;new-title\x07") // overwrite
          const pos = await ctx.queryCursorPosition()
          const note = pos
            ? "Cursor answered after title push; title stack was not measured"
            : "No DSR response after title push"
          return {
            pass: false,
            note,
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: ctx.captureGeometryRefusal ? `Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : note,
              },
            ],
          }
        } finally {
          ctx.write("\x1b[23;0t")
        }
      },
    ),
    libAssertionType: "buffer_state",
  },

  // XTWINOPS 23 — pop title/icon stack: CSI 23 ; 0 t (no response, partial)
  {
    ...probe(
      "device.xtwinops-23",
      (ctx) => titleStackHeadless(ctx, "XTWINOPS 23 restores the title saved before a different title was set"),
      async (ctx) => {
        ctx.write("\x1b[22;0t") // push first so we have something to pop
        ctx.write("\x1b[23;0t")
        const pos = await ctx.queryCursorPosition()
        const note = pos
          ? "Cursor answered after title pop; restored title was not measured"
          : "No DSR response after title pop"
        return {
          pass: false,
          note,
          tests: [
            {
              id: "criterion",
              status: "test-todo",
              reason: ctx.captureGeometryRefusal ? `Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : note,
            },
          ],
        }
      },
    ),
    libAssertionType: "buffer_state",
  },

  // XTREPORTCOLORS — report palette-stack current entry and stored palette count.
  deviceQuery({
    id: "device.xtreportcolors",
    query: "\x1b[#R",
    // xterm's own reply carries a DEC-private `?` before the parameters (measured:
    // CSI ? 0 ; 1 # Q on xterm 411); kitty answers without it (CSI 0 ; 0 # Q).
    // The `?` is part of the reference implementation's reply, so the matcher accepts
    // it rather than grading xterm's own extension as an invalid reply.
    valid: /\x1b\[\??[0-9]+;[0-9]+#Q/,
    malformed: /\x1b\[\??[0-9;]*#|#Q/,
    expected: "CSI # R reports palette-stack entry and stored count as CSI [optional ?] entry;count # Q",
  }),

  // XTGETXRES — query xterm resource value: DCS + Q Pt ST → DCS response
  // Added in xterm; documented in patches 401/402 (2025).
  deviceQuery({
    id: "device.xtgetxres",
    // "termName" is encoded as two hex digits per character, per XTGETXRES.
    query: "\x1bP+Q7465726d4e616d65\x1b\\",
    valid: /\x1bP1\+R7465726d4e616d65=(?:[0-9A-Fa-f]{2})+\x1b\\/i,
    refusal: /\x1bP0\+R7465726d4e616d65\x1b\\/i,
    // The contract asks exactly one name, so a status-0 refusal is this probe's measured answer.
    refusalDecisive: true,
    // The name is hex-encoded, so a terminal may echo it in either case; valid and
    // refusal are already case-insensitive, and a case-sensitive malformed pattern
    // graded the same frame no-response instead of invalid-reply.
    malformed: /\x1bP[01]\+R/i,
    expected: "XTGETXRES returns a complete status-1 termName resource value",
  }),
]
