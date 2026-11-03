import { PROBE_STATUSES } from "./types.ts"
import { createHash } from "node:crypto"
import type { ProbeTestInput } from "./types.ts"
import type {
  ProbeAttempt,
  Observation,
  NotTestedCoverage,
  ProbeAssertion,
  UngradedDiagnostic,
  ProbeResult,
  ProbeSuiteManifest,
  RunDraft,
  CollectorSelection,
  CollectorAttempt,
} from "./types.ts"
import type {
  AssertionType,
  ProbeDefinition,
  HeadlessRuntimeIdentity,
  ProbeCallbackResult,
  ExecutionOnlyProbeCallbackResult,
  TerminalQueryOutcome,
  LibProbeSource,
  TermProbeSource,
} from "./types.ts"
import { evidenceRuntimeIdentity } from "./runtime-identity.ts"

export const ADAPTER_SOURCE_AUDITS = {
  vt100: {
    "packages/vt100/src/index.ts": "99833d737402f9d1d8e3e257e3a255d8aa1facc3",
    "packages/vt100/src/backend.ts": "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a",
  },
  vt220: {
    "packages/vt220/src/index.ts": "601dd26eb7e753a5396ebdf72f1ef8ee2cc4355f",
    "packages/vt220/src/backend.ts": "7369e3710e36aa649372fd09011ecfdd6ba47c73",
  },
  vterm: {
    "packages/vterm/src/index.ts": "cb5719799dcdd5ae24e6fcf0dcad9965035ce54c",
    "packages/vterm/src/backend.ts": "5d27c551161fe41af00ac587bd9484d6becbbc7a",
  },
  xtermjs: {
    "packages/xtermjs/src/index.ts": "550e10110ec2baaf326d2958319b03ee8208feba",
    "packages/xtermjs/src/backend.ts": "72dc827b2026af7736de722f7ff986a04f3fe883",
  },
  ghostty: {
    "packages/ghostty/src/index.ts": "f4b9d9f3e13cc515b23abc739cab21bf971e8585",
    // Historical cohort retained for existing API/reply and source-review consumers.
    "packages/ghostty/src/backend.ts": "560146d5f929f31a8f973f809d97f91cf0e23fd6",
  },
  ghostty42e84af1: {
    "packages/ghostty/src/index.ts": "f4b9d9f3e13cc515b23abc739cab21bf971e8585",
    // Underline-colour ABI readback (termless 2f73fc28); current receipt and parser audits bind WASM 42e84af1.
    "packages/ghostty/src/backend.ts": "19d45e37b36c0d6fc8d69ae6215ece9db173351c",
  },
  libvterm: {
    "packages/libvterm/src/index.ts": "2b4708b1081e701b99893ca055ded781dc46cf25",
    "packages/libvterm/src/backend.ts": "eb513ccd443e30c7a869a8ba41f8126e1c0ddf00",
    "packages/libvterm/src/wasm-bindings.ts": "2bbd4d5cf59b8d53db8f5c0329d2ed7853c43e45",
    "packages/libvterm/wasm/libvterm.js": "1e784be87614ab924b96844009919b7c21ce150e",
  },
  libvterm712298af: {
    "packages/libvterm/src/index.ts": "2b4708b1081e701b99893ca055ded781dc46cf25",
    "packages/libvterm/src/backend.ts": "f0431b2b3b1824d3028e7a039d55278d2cddc0e8",
    "packages/libvterm/src/wasm-bindings.ts": "55ddc684464e525e63cd523d2d6a638c4c6dbcd9",
    "packages/libvterm/wasm/libvterm.js": "d28bc97333d33129c7c9764a331a3d47f088f7b3",
  },
  // Conceal forwarding changes the backend blob; exact native receipt and artifact audits bind the rebuilt Zig.
  ghosttyNative: {
    "packages/ghostty-native/src/index.ts": "35c9e35a5d60625ce1135b65ff38ae9278495a18",
    "packages/ghostty-native/src/backend.ts": "427b9d4782a9924135ff0c32e2406b117df9cf22",
  },
  ghosttyNative0effe403: {
    "packages/ghostty-native/src/index.ts": "35c9e35a5d60625ce1135b65ff38ae9278495a18",
    "packages/ghostty-native/src/backend.ts": "f403717f7c063d799c5de994b3ccc095edbcacd1",
  },
  ghosttyNative2d5e53cf: {
    "packages/ghostty-native/src/index.ts": "35c9e35a5d60625ce1135b65ff38ae9278495a18",
    "packages/ghostty-native/src/backend.ts": "f403717f7c063d799c5de994b3ccc095edbcacd1",
  },
  alacritty: {
    "packages/alacritty/src/index.ts": "b4154cbd6ef4a83ce2cbf3dcf26ff13d645efd05",
    // Cell.hidden readback (termless 2f73fc28, #31901) changes backend and native blobs; index and loader are unchanged.
    "packages/alacritty/src/backend.ts": "27b78b1264cd5d2ed72705ba36c9735b29e874c5",
    "packages/alacritty/native/src/lib.rs": "1779ff4f042f7f285ab3d396da039408b492be10",
    "src/load-native.ts": "34e142550085450ab02138184626716ad0d6b546",
  },
  wezterm: {
    "packages/wezterm/src/index.ts": "512606c5270ffd0cff55c1b70f5b3eda18a92df0",
    "packages/wezterm/src/backend.ts": "42a196995a5f8845ab2e3bb6227192556c470071",
    "packages/wezterm/native/src/lib.rs": "445f5484027aebbea01a641a96dd92dfea273693",
    "src/load-native.ts": "34e142550085450ab02138184626716ad0d6b546",
  },
  vt100Rust: {
    "packages/vt100-rust/src/index.ts": "3ddb74f3ae1f79bb356952103853232f69211268",
    // Mouse-state binding (termless 286fddf6, #31295) changes the backend blob; parser and callbacks are unchanged.
    "packages/vt100-rust/src/backend.ts": "9b3477c0fedf8586430781e8f4d17019569af98b",
  },
  kitty: {
    "packages/kitty/src/index.ts": "3f207f911646613cdc3d8b04f155f0686a96a077",
    "packages/kitty/src/backend.ts": "1b7367a9737d1292618ea34a1c451bf3273c3b35",
    "packages/kitty/build/bridge.py": "f9585e3ac10209eedd1bc8550bcb1a4a1b286f27",
    "packages/kitty/build/layout.c": "49c0beef4424190e89d2884eac5efe4da50e3630",
    "packages/kitty/build/native-mode-layout.json": "6bd0f2d5b6936f8f6298e4cb9ae4b228172a9502",
    "packages/kitty/build/native-mode-layout.receipt.json": "02899a0c97f70eeba38f5030de1ba7ef4665b6f6",
  },
} as const

export function auditedAdapterSources(
  identity: LibProbeSource["runtimeIdentity"],
  engine: keyof typeof ADAPTER_SOURCE_AUDITS,
): boolean {
  const expected = Object.entries(ADAPTER_SOURCE_AUDITS[engine])
  const sources = evidenceRuntimeIdentity(identity)?.adapterSources
  return (
    sources?.length === expected.length &&
    expected.every(([path, blobOid]) => sources.some((source) => source.path === path && source.blobOid === blobOid))
  )
}

/** What one push/pop stack fixture's final read shows (#31904). */
export type StackReading = "restored" | "earlier" | "persisted" | "other"

/**
 * Per-operation verdict over two stack fixtures (#31904, @cto 6e4f7300). The POP fixture (set A,
 * push, set B, pop) and the PUSH fixture (set A, set B, push, set C, pop) run in every arm, and each
 * row grades only its own operation:
 * - POP passes when its fixture restores the pushed non-default A and the PUSH fixture restored a
 *   saved state; PUSH passes when its fixture restores B, the state current at push time, and the
 *   POP fixture shows pop restores.
 * - PUSH alone is negative when an earlier state returns while the POP fixture shows pop restores:
 *   push saved no snapshot of the current state.
 * - Nothing restored in either fixture is the joint negative both rows carry: push then pop
 *   restored no earlier state. Any other combination, including fixtures that disagree, is null.
 */
export function stackVerdict(
  operation: "push" | "pop",
  pop: StackReading,
  push: StackReading,
): { pass: boolean | null; note?: string } {
  if (pop === "persisted" && push === "persisted") {
    return { pass: false, note: "push then pop restored no earlier state" }
  }
  if (operation === "pop") {
    return pop === "restored" && (push === "restored" || push === "earlier")
      ? { pass: true }
      : { pass: null, note: `POP fixture ${pop}, PUSH fixture ${push}: no pop-only observation` }
  }
  if (pop === "restored" && push === "restored") return { pass: true }
  if (pop === "restored" && push === "earlier") {
    return { pass: false, note: "an earlier state returned while pop restores: push saved no current snapshot" }
  }
  return { pass: null, note: `POP fixture ${pop}, PUSH fixture ${push}: no push-only observation` }
}

/**
 * A stack row's headless result. A null verdict observed neither operation, so it is a coverage
 * record (TEST TODO, the review the ruling names), never a TEST FAILURE: nothing in the harness
 * failed (@cto 19664c4c). A broken measurement keeps its own parserStateResult(null, ...) failure.
 */
export function stackStateResult(
  verdict: { pass: boolean | null; note?: string | undefined },
  expected: string,
  state: object,
  assertionType: AssertionType = "buffer_state",
): ProbeCallbackResult {
  if (verdict.pass === null) return notTestedResult(verdict.note ?? "no stack operation was observed", state)
  return parserStateResult(verdict.pass, expected, state, verdict.note, undefined, assertionType)
}

/** Mark an absent-reply failure without deciding producer absence from silence. */
export function replyFailure(reason: string): ExecutionOnlyProbeCallbackResult {
  return {
    pass: false,
    note: reason,
    tests: [{ id: "criterion", status: "test-failure", reason }],
    replyFailureTestIds: ["criterion"],
  }
}

/** An operational cleanup failure replaces reply intent on the object already being returned. */
export function cancelReplyFailure(result: ProbeCallbackResult): ProbeCallbackResult {
  const unmarked = result as { replyFailureTestIds?: readonly string[] }
  delete unmarked.replyFailureTestIds
  return result
}

/** Add completed producer evidence only where the callback explicitly requested it. */
export function withReplyFailureEvidence(
  featureId: string,
  result: ProbeCallbackResult,
  evidence:
    | {
        producer: "TTY"
        attempts: readonly {
          sequence: string
          received: string
          timeoutMs: number
          match: readonly string[] | null
          reason: TerminalQueryOutcome["reason"]
        }[]
      }
    | {
        producer: "headless"
        attempts: readonly { sequence: string; received: string; timeoutMs: null }[]
      },
): ProbeCallbackResult {
  if (!("replyFailureTestIds" in result) || !result.replyFailureTestIds?.length) return result
  const marked = new Set(result.replyFailureTestIds)
  for (const id of marked) {
    if (!result.tests?.some((test) => test.id === id && test.status === "test-failure")) {
      throw new Error(
        `Callback ${featureId} reply marker ${id} must name a test-failure test; fix the callback builder use`,
      )
    }
  }
  const entries =
    evidence.producer === "TTY"
      ? evidence.attempts.map((entry, index) => ({
          ...entry,
          prefix: `query ${index + 1}: `,
          state:
            entry.match !== null
              ? "matched"
              : entry.reason === "timeout"
                ? `timeout ${entry.timeoutMs} ms`
                : "no match",
        }))
      : evidence.attempts.map((entry) => ({
          ...entry,
          prefix: "",
          state: "synchronous feed and getCursor boundary; timeout not applicable",
        }))
  const detail = entries.length
    ? entries
        .map(
          (entry) =>
            `${entry.prefix}sent ${JSON.stringify(entry.sequence)}; received ${JSON.stringify(entry.received)}; ${entry.state}`,
        )
        .join(" | ")
    : evidence.producer === "TTY"
      ? "no completed TTY trace for this query"
      : "no headless capture recorded"
  return {
    ...result,
    tests: result.tests?.map((test) =>
      marked.has(test.id) && test.status === "test-failure" ? { ...test, reason: `${test.reason}; ${detail}` } : test,
    ) as ExecutionOnlyProbeCallbackResult["tests"],
  }
}

function collectorRecord(rawReplies: Record<string, string>, key: string): Record<string, unknown> | undefined {
  const raw = rawReplies[key]
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`Invalid ${key}: retained record is not JSON`, { cause })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${key}: expected a retained object`)
  }
  return value as Record<string, unknown>
}

export function collectorIds(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === "string" && id.length > 0)) {
    throw new Error(`Invalid ${key}: expected resolved probe ids`)
  }
  return [...value]
}

/** Absence is legacy evidence, never an inferred full selection. */
export function readCollectorSelection(rawReplies: Record<string, string>): CollectorSelection | undefined {
  const value = collectorRecord(rawReplies, "collector.selection")
  if (value === undefined) return undefined
  return { ids: collectorIds(value.ids, "collector.selection") }
}

/** Decode the retained start/outcome without manufacturing a time or a successful result. */
export function readCollectorAttempt(rawReplies: Record<string, string>): CollectorAttempt | undefined {
  const value = collectorRecord(rawReplies, "collector.collectionAttempt")
  if (value === undefined) return undefined
  const ids = collectorIds(value.ids, "collector.collectionAttempt")
  const result = value.result
  if (
    result !== undefined &&
    (typeof result !== "string" || !["started", "completed", "empty", "cancelled", "failed"].includes(result))
  ) {
    throw new Error("Invalid collector.collectionAttempt: unknown result")
  }
  if (
    (value.startedAt !== undefined &&
      (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)))) ||
    ((result === undefined || result === "started" || result === "completed") && value.startedAt === undefined)
  ) {
    throw new Error("Invalid collector.collectionAttempt: recorded start required for a started attempt")
  }
  if ((result === "failed" || result === "cancelled") && typeof value.error !== "string") {
    throw new Error("Invalid collector.collectionAttempt: original error required")
  }
  if (result !== "failed" && result !== "cancelled" && value.error !== undefined) {
    throw new Error("Invalid collector.collectionAttempt: error requires a failed or cancelled result")
  }
  if (
    value.hostInputs !== undefined &&
    (typeof value.hostInputs !== "object" ||
      value.hostInputs === null ||
      Array.isArray(value.hostInputs) ||
      !Object.values(value.hostInputs).every((entry) => typeof entry === "string"))
  ) {
    throw new Error("Invalid collector.collectionAttempt: invalid retained host inputs")
  }
  return { ...value, ids } as CollectorAttempt
}

const UNSTARTED_PROBE_REASON = "Required probe test has not started"
const UNSELECTED_PROBE_REASON = "Not selected for this collection; no test was attempted."

export function recordCollectorSelection(draft: RunDraft, ids: readonly string[]): void {
  draft.rawReplies["collector.selection"] = JSON.stringify({ ids })
  const selected = new Set(ids)
  for (const result of draft.results) {
    if (
      result.status === "test-todo" &&
      result.attempt.scope === "none" &&
      result.tests.length === 0 &&
      (result.reason === UNSTARTED_PROBE_REASON || result.reason === UNSELECTED_PROBE_REASON)
    ) {
      result.reason = selected.has(result.featureId) ? UNSTARTED_PROBE_REASON : UNSELECTED_PROBE_REASON
    }
  }
}

export function recordCollectorAttempt(draft: Pick<RunDraft, "rawReplies">, attempt: CollectorAttempt): void {
  draft.rawReplies["collector.collectionAttempt"] = JSON.stringify(attempt)
}

/** Host-cause citations bind the whole retained input record, including its collection outcome. */
export function collectorAttemptDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}

/** Keep the serialized state alongside the exact assertion that used it. */
export function parserStateResult(
  pass: boolean | null,
  expected: string,
  state: object,
  note?: string,
  sourceReviewReason?: string,
  assertionType: AssertionType = "buffer_state",
): ProbeCallbackResult {
  if (sourceReviewReason !== undefined && pass === true) {
    throw new Error("A positive parser state cannot require source review")
  }
  // A former source-negative verdict: source code never grades a probe (@cto 9fad23d7, #32246).
  if (sourceReviewReason !== undefined) return notTestedResult(NO_SAME_PATH_CONTROL, state)
  const response = JSON.stringify(state)
  const assertions: NonNullable<ProbeCallbackResult["assertions"]> | undefined =
    pass === null ? undefined : [{ assertionType, kind: pass ? "positive" : "negative", expected, observed: response }]
  return {
    pass: pass === true,
    response,
    ...(note && { note }),
    observation: {
      outcome: pass === null ? "inconclusive" : pass ? "supported" : "unsupported",
      ...(pass === null && { reason: "insufficient-evidence" as const }),
      assertionType,
      ...(note && { note }),
    },
    ...(assertions && { assertions }),
  }
}

/** Channel-exact equality of two reported cell colors. */
export function sameRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

/**
 * The probe ran and retained raw state, but this environment exposes no applicable observable for
 * the claim. This is a coverage/applicability record, never a fifth measurement outcome.
 */
export function notTestedResult(noObservable: string, state: object): ProbeCallbackResult {
  return {
    pass: false,
    response: JSON.stringify(state),
    note: noObservable,
    notTested: { reason: "no-semantic-observable", noObservable },
  }
}

export const SOURCE_NEGATIVE_REVIEW = "source-negative-review"
export const SEMANTIC_PROMPT_SOURCE_REVIEW = "semantic-prompt-source-review"
/**
 * The reason a former source-audit site records (@cto 9fad23d7, #32246): the probe ran and saw something, but no
 * control in this run showed the same observation path can report the state, so the cell stays TEST TODO (rule 4).
 * Source code never decides it; a probe owner adds the same-path control per feature.
 */
export const NO_SAME_PATH_CONTROL = "observation not decided: no same-path control in this run"

/**
 * A criterion this context has no observable for: the same coverage record and raw state as
 * notTestedResult, with the explicit branch selecting the existing review test. The position
 * stays TEST TODO with a required review pending; nothing here grades support, delivery or
 * Untestable.
 */
export function reviewResult(branch: string, reason: string, noObservable: string, state: object): ProbeCallbackResult {
  return {
    ...notTestedResult(noObservable, state),
    criterionBranch: branch,
    tests: [{ id: "review", status: "test-todo", reason }],
  }
}

/**
 * The headless arm of a criterion that needs OS-level input. An app context without an input
 * adapter keeps its plain coverage record.
 */
export function osInputReviewResult(
  noObservable: string,
  state: object,
  reason = "Library probe source injects no OS-level input; required independent review of the retained raw state pending",
): ProbeCallbackResult {
  return reviewResult("os-input-review", reason, noObservable, state)
}

/**
 * A headless colour criterion missing its initial readback. Reset/stack probes send no mutation
 * when that prerequisite is absent (#30547, @cto D-B). Initial-query probes require a disposable
 * set/query/reset control before selecting this branch. Never a sentinel negative (C10) and never
 * graded from a source read (C7); the reviewer names the missing observable from its source audit.
 */
export function colorReadbackReviewResult(noObservable: string, state: object): ProbeCallbackResult {
  return reviewResult(
    "color-readback-review",
    "Library probe source offers no colour readback; required independent review of the retained raw state pending",
    noObservable,
    state,
  )
}

/**
 * A row whose claim compares plainly written glyphs against a sequence of pixels assumes the
 * terminal decodes plain UTF-8 — a CONTEXT, measured once per run and never assumed (#28752). A
 * measured 8-bit (ISO-8859-1) decoding means the expected frame paints a different string from the
 * one the row claims, so the row cannot be decided in this context: it is inconclusive and NAMES
 * the cause. The run is NOT refused — a refusal is a new gate, and a named cause loses nothing.
 * The two named non-measurements — `silent` (no cursor report arrived) and `unusable` (one arrived
 * the measurement cannot read) — involve no measured decoding and claim none, so they leave the row
 * to its own oracle: a context that cannot answer this round trip already fails its geometry and
 * width reads by name (@dev/review2).
 */
export async function utf8DecodingRefusal(ctx: TermProbeSource, id: string): Promise<ProbeCallbackResult | null> {
  if (!ctx.utf8Decoding) return null
  if ((await ctx.utf8Decoding()) !== "8-bit") return null
  return {
    pass: false,
    criterionBranch: "utf8-prerequisite",
    tests: [
      {
        id: "utf8-context",
        status: "test-todo",
        reason: "Measured decoding is ISO-8859-1; correct the pinned locale and rerun this UTF-8 criterion",
      },
    ],
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
      note: `${id}: this run decodes plain-written UTF-8 as ISO-8859-1 (measured: the Neutral-width sample ë advanced the cursor two cells, not one), so the expected frame paints a different string from the one this row claims; the pinned locale is the context to correct, not a capability of this terminal`,
    },
  }
}

/** Selective erase must remove unprotected cells and retain a protected control. */
export function selectiveEraseResult(ctx: LibProbeSource, sequence: string, rectangular: boolean): ProbeCallbackResult {
  const expected = "DECSCA-protected P survives while selective erase clears ABCD"
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6) {
    return parserStateResult(null, expected, { cols: ctx.cols }, "Need six measured columns")
  }
  try {
    ctx.feed('\x1b[1;1H\x1b[1"qP\x1b[0"qABCDZ')
    const before = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col).char)
    if (before.join("") !== "PABCDZ") {
      return parserStateResult(null, expected, { before }, "Selective erase seed was not measured")
    }
    ctx.feed(sequence)
    const after = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col).char)
    if (after[0] !== "P") {
      // The DECSCA-protected P is the row's discriminator: an erase that takes it ignored the
      // protection the claim rests on, a measured negative (@chief 2026-10-11T22:58Z). Reporting
      // "cannot attribute" here would name the one shape the claim is about as unmeasured.
      return parserStateResult(
        false,
        expected,
        { before, after },
        "The DECSCA-protected P was erased: protection ignored",
      )
    }
    const outsideControl = !rectangular || after[5] === "Z"
    return parserStateResult(
      outsideControl ? after.slice(1, rectangular ? 5 : 6).every(isBlank) : null,
      expected,
      { before, after },
      outsideControl ? undefined : "Outside-rectangle control failed; cannot attribute selective erase",
    )
  } finally {
    ctx.feed('\x1b[0"q')
  }
}

/** CPR cannot establish changed cells, styling, or scrollback contents. */
export function unmeasuredCellResult(
  position: { row: number; col: number } | null,
  feature: string,
): ProbeCallbackResult {
  if (position) {
    const reason = `Cursor response does not measure ${feature}`
    return {
      ...reviewResult(HEADLESS_OBSERVABLE_REVIEW, reason, reason, { position }),
      response: `${position.row};${position.col}`,
    }
  }
  return replyFailure(
    `no parsable cursor position reply after ${feature}; the public projection returned null and retained no bytes`,
  )
}

/** Internal callback mapping for a nonnumeric width reading; numeric criteria stay with each probe. */
export function renderedWidthFailure(
  reading: unknown,
  probeId: string,
  stage: string,
  response: string,
): ProbeCallbackResult {
  const unknownKind = (kind: unknown): never => {
    throw new Error(`${probeId}: width transport: unknown kind ${String(kind)}`)
  }
  if (!reading || typeof reading !== "object" || Array.isArray(reading)) return unknownKind(undefined)
  const value = reading as Record<string, unknown>
  if (value.kind === "no-reply" && typeof value.step === "string" && value.step.length > 0) {
    return {
      pass: false,
      response,
      tests: [
        {
          id: "criterion",
          status: "test-todo",
          reason: `${stage} width: no cursor-position readback at ${value.step}`,
        },
      ],
    }
  }
  if (value.kind === "control-mismatch" || value.kind === "wrapped") {
    const observed = value.observed
    if (!observed || typeof observed !== "object" || Array.isArray(observed)) return unknownKind(value.kind)
    const position = observed as Record<string, unknown>
    if (
      typeof position.row !== "number" ||
      typeof position.col !== "number" ||
      !Number.isFinite(position.row) ||
      !Number.isFinite(position.col)
    ) {
      return unknownKind(value.kind)
    }
    if (value.kind === "control-mismatch" && (typeof value.step !== "string" || value.step.length === 0)) {
      return unknownKind(value.kind)
    }
    const reason = `${stage} width ${value.kind}${value.kind === "control-mismatch" ? ` at ${String(value.step)}` : ""}: observed ${position.row};${position.col}`
    return { pass: false, response, tests: [{ id: "criterion", status: "test-failure", reason }] }
  }
  return unknownKind(value.kind)
}

/**
 * SGR parameters a DECRQSS reply must carry (and, for a reset, must not), plus exact tokens.
 * `require`/`forbid` match a parameter's leading code; `requireTokens` distinguishes the
 * sub-parameter families that share a code, such as the underline styles under 4 (`4:3`).
 */
export interface SgrReadback {
  require: readonly number[]
  forbid?: readonly number[]
  requireTokens?: readonly string[]
}

/**
 * DECRQSS `$ q m` — the SGR parameter tokens the terminal itself reports as active, sub-parameters
 * preserved (`4:3`, `58:2:255:0:128`).
 * A complete `DCS 1 $ r <Ps> m ST` reply is parsed; a timeout, a DA1 sentinel, or a
 * `DCS 0 $ r ST` "request not recognized" reply all return null. A missing readback is
 * never a negative.
 */
export async function querySgrState(ctx: TermProbeSource): Promise<string[] | null> {
  const outcome = await ctx.queryWithSentinelOutcome("\x1bP$qm\x1b\\", /\x1bP1\$r([0-9;:]*)m\x1b\\/)
  if (outcome.reason !== "reply") return null
  const payload = outcome.match?.[1]
  if (payload === undefined) return null
  if (payload === "") return []
  return payload.split(";")
}

/** The leading code of a DECRQSS parameter token (`4:3` -> 4). */
function leadingSgrCode(token: string): number {
  return Number(token.split(":")[0])
}

/** The DECRPM reply to one DECRQM: `CSI ? Pd ; Ps $ y` for a DEC private mode, `CSI Pd ; Ps $ y` for an ANSI mode. */
export function decrpmReplyPattern(modeNumber: number, kind: "private" | "ansi" = "private"): RegExp {
  return new RegExp(`\\x1b\\[${kind === "private" ? "\\?" : ""}${modeNumber};([0-4])\\$y`)
}

/** A DECRPM Ps kept distinct (#30557): 0 not recognized, 1 set, 2 reset, 3 permanently set, 4 permanently reset. */
export type DecrpmPs = 0 | 1 | 2 | 3 | 4

/** The one reading of Ps for every DECRPM consumer; anything outside 0–4 is no readback. */
export function decrpmPs(ps: string | undefined): DecrpmPs | null {
  if (ps === undefined || ps === "") return null
  const status = Number(ps)
  return status === 0 || status === 1 || status === 2 || status === 3 || status === 4 ? status : null
}

/**
 * The fold over decrpmPs, 1/3 set, 2/4 reset, 0 not recognized, for tty.ts queryMode and the readers that only
 * save, restore or compare a prior state: the cursor-visibility and autowrap equality tests
 * (text-qualification.ts, capture-calibration.ts), the DECSCLM restore (modes.ts) and the DECAWM gate (text.ts).
 * No grader reads this word: it hides Ps 4 behind "reset", so a grader reads the Ps through queryDecrpm (#30557).
 */
export function decrpmStatus(ps: string | undefined): "set" | "reset" | "unknown" | null {
  const reading = decrpmPs(ps)
  if (reading === null) return null
  if (reading === 0) return "unknown"
  return reading === 1 || reading === 3 ? "set" : "reset"
}

/**
 * One DECRQM on the app arm, read by the shared parser with Ps kept distinct: `CSI ? Ps $ p` for a DEC private mode
 * (the same bytes queryMode folds), `CSI Ps $ p` for an ANSI mode such as IRM.
 */
export async function queryDecrpm(
  ctx: TermProbeSource,
  modeNum: number,
  kind: "private" | "ansi" = "private",
): Promise<DecrpmPs | null> {
  const query = kind === "private" ? `\x1b[?${modeNum}$p` : `\x1b[${modeNum}$p`
  const match = await ctx.queryWithSentinel(query, decrpmReplyPattern(modeNum, kind))
  return decrpmPs(match?.[1])
}

/**
 * DECRQSS `$ q SP q` — the terminal's own DECSCUSR cursor-style setting. A complete
 * `DCS 1 $ r <Ps> SP q ST` reply yields `<Ps>`; a timeout, a DA1 sentinel, or a `DCS 0 $ r ST`
 * "request not recognized" reply all return null. A missing readback is never a negative.
 */
export async function queryCursorStyle(ctx: TermProbeSource): Promise<number | null> {
  const outcome = await ctx.queryWithSentinelOutcome("\x1bP$q q\x1b\\", /\x1bP1\$r([0-9]+) q\x1b\\/)
  if (outcome.reason !== "reply") return null
  const payload = outcome.match?.[1]
  if (payload === undefined) return null
  const ps = Number(payload)
  return Number.isInteger(ps) ? ps : null
}

/**
 * Decide a DECSCUSR shape claim from the terminal's own DECRQSS report when it answers, and return
 * null when it stays silent so the caller keeps its existing (pixel) evidence path. A missing
 * readback is never a negative.
 */
export async function cursorStyleReadbackDecision(
  ctx: TermProbeSource,
  sequence: string,
  expected: number,
): Promise<ProbeCallbackResult | null> {
  ctx.write(sequence)
  try {
    const ps = await queryCursorStyle(ctx)
    if (ps === null) return null
    const pass = ps === expected
    return {
      pass,
      observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply" },
      assertions: [
        {
          assertionType: "query_reply" as const,
          kind: pass ? "positive" : "negative",
          expected: `DECRQSS reports cursor style ${expected} after ${sequence}`,
          observed: String(ps),
        },
      ],
    }
  } finally {
    ctx.write("\x1b[0 q")
  }
}

/**
 * The terminal's own DECRQSS report may spell a style as a colon sub-parameter of the code we
 * require: measured, kitty-0.49.2 reports SGR 21 (doubly underlined) as `4:2`, and `4:1` is the
 * single underline `4` spelled out. Fold those equivalences into the reported codes so the
 * terminal's chosen encoding cannot decide the claim.
 */
const SGR_CODE_ALIASES: Readonly<Record<string, number>> = { "4:1": 4, "4:2": 21 }

/**
 * Decide an SGR claim from the terminal own DECRQSS report. A style-qualified underline claim
 * needs its own style token in a valid reply. A collapsed or omitted style is coverage (PROBE
 * TODO), never a negative; malformed replies remain failed observations.
 */
export function sgrReadbackResult(
  id: string,
  sequence: string,
  state: readonly string[],
  readback: SgrReadback,
): ProbeCallbackResult {
  return evaluateSgrReadback(id, sequence, state, readback, false)
}

function evaluateSgrReadback(
  id: string,
  sequence: string,
  state: readonly string[],
  readback: SgrReadback,
  setupVerified: boolean,
): ProbeCallbackResult {
  // Extended-color operands are one parameter, never independent attributes. Keep the raw state
  // below, but compare equivalent legacy semicolon and colon reports as complete color tokens.
  const parameters: string[] = []
  let unmeasured: string | undefined
  const remaining = [...state]
  for (let token = remaining.shift(); token !== undefined; token = remaining.shift()) {
    const selector = leadingSgrCode(token)
    // Underline reports have one style subparameter, from 0 (off) through 5 (dashed).
    if (selector === 4 && token.includes(":") && !/^4:[0-5]$/.test(token)) {
      unmeasured = `DECRQSS underline parameter ${token} has an unqualified style or extra subparameters`
      break
    }
    if (![38, 48, 58].includes(selector)) {
      parameters.push(token)
      continue
    }
    let parts = token.split(":")
    if (parts.length === 1) {
      const mode = remaining.shift()
      const operands = mode === "2" ? 3 : mode === "5" ? 1 : 0
      parts = [token, ...(mode === undefined ? [] : [mode]), ...remaining.splice(0, operands)]
    }
    // The optional ISO color-space slot is omitted or zero in the equivalent RGB form.
    if (parts[1] === "2" && parts.length === 6 && (parts[2] === "" || parts[2] === "0")) parts.splice(2, 1)
    const values = parts.slice(2)
    const complete = (parts[1] === "2" && values.length === 3) || (parts[1] === "5" && values.length === 1)
    if (!complete || values.some((value) => !/^\d+$/.test(value) || Number(value) > 255)) {
      unmeasured = `DECRQSS color parameter ${parts.join(":")} is incomplete or has an unqualified encoding`
      break
    }
    if (parameters.some((parameter) => leadingSgrCode(parameter) === selector)) {
      unmeasured = `DECRQSS reports more than one color parameter for ${selector}`
      break
    }
    parameters.push(parts.map(Number).join(":"))
  }
  for (const expected of readback.requireTokens ?? []) {
    const selector = leadingSgrCode(expected)
    if (![38, 48, 58].includes(selector)) continue
    const actual = parameters.find((parameter) => leadingSgrCode(parameter) === selector)
    if (actual && actual.split(":")[1] !== expected.split(":")[1]) {
      unmeasured = `DECRQSS reports ${actual}, which cannot establish requested color representation ${expected}`
    }
  }
  const observed = state.length === 0 ? "0" : state.join(";")
  if (unmeasured) {
    return {
      pass: false,
      response: JSON.stringify({ sgr: observed }),
      note: unmeasured,
      observation: {
        outcome: "inconclusive",
        assertionType: "query_reply",
        reason: "insufficient-evidence",
        note: unmeasured,
      },
    }
  }
  // SGR 21 is double underline's legacy code; 4:2 is the same style in the colon form. A reply
  // that names none of the requested styles leaves the claim unobserved (@cto 37277973, option i).
  const underlineStyles = (readback.requireTokens ?? []).filter((token) => /^4:[1-5]$/.test(token))
  const doubleStyle = readback.require.includes(21)
  const styleReported =
    underlineStyles.some((token) => parameters.includes(token)) ||
    (doubleStyle && (parameters.includes("21") || parameters.includes("4:2")))
  if ((underlineStyles.length > 0 || doubleStyle) && !styleReported) {
    const wanted = [...underlineStyles, ...(doubleStyle ? ["21"] : [])].join(" or ")
    return notTestedResult(`DECRQSS reported ${observed} without the requested underline style ${wanted}`, {
      sgr: observed,
    })
  }
  const codes = parameters.flatMap((token) => {
    // Style zero explicitly disables underline; its leading 4 is not an active attribute.
    if (token === "4:0") return [24]
    const alias = SGR_CODE_ALIASES[token]
    return alias === undefined ? [leadingSgrCode(token)] : [leadingSgrCode(token), alias]
  })
  const required = readback.require.every((code) => codes.includes(code))
  const forbidden = readback.forbid?.some((code) => codes.includes(code)) ?? false
  const tokensRequired = readback.requireTokens?.every((token) => parameters.includes(token)) ?? true
  // A missing selector cannot distinguish an unsupported attribute from an unreported one.
  // A different value of that selector, a forbidden code, or this attempt's verified reset setup can.
  const absent =
    readback.require.some(
      (code) => !codes.includes(code) && !parameters.some((token) => leadingSgrCode(token) === code),
    ) ||
    (readback.requireTokens ?? []).some(
      (token) => !parameters.some((actual) => leadingSgrCode(actual) === leadingSgrCode(token)),
    )
  if (absent && !forbidden && !setupVerified) return notTestedResult(NO_SAME_PATH_CONTROL, { sgr: observed })
  const ok = required && !forbidden && tokensRequired
  const requiredCodes = [...readback.require.map(String), ...(readback.requireTokens ?? [])]
  // A forbid-only claim (reset.sgr, sgr.reset, sgr.fg.default, sgr.bg.default) requires nothing, so its
  // expected text names what it forbids instead of storing an empty token.
  const expected =
    requiredCodes.length > 0
      ? requiredCodes.join(";")
      : readback.forbid !== undefined && readback.forbid.length > 0
        ? `none of ${readback.forbid.join(";")}`
        : "0"
  return {
    pass: ok,
    response: JSON.stringify({ sgr: observed }),
    observation: ok
      ? { outcome: "supported", assertionType: "query_reply" }
      : { outcome: "unsupported", assertionType: "query_reply" },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: ok ? "positive" : "negative",
        expected: `${id}: DECRQSS reports ${expected} after ${sequence}`,
        observed,
      },
    ],
  }
}

/**
 * Decide an SGR claim from the terminal's own DECRQSS report when it answers, and return null when
 * it stays silent so the caller keeps its existing (capture or cursor) evidence path. A missing
 * readback is never a negative.
 */
export async function sgrReadbackDecision(
  ctx: TermProbeSource,
  id: string,
  sequence: string,
  readback: SgrReadback,
  setup?: { sequence: string; baseline: SgrReadback; readback: SgrReadback },
  independentSetup?: () => Promise<ProbeCallbackResult | null>,
): Promise<ProbeCallbackResult | null> {
  const observed: Record<string, string> = {}
  try {
    ctx.write("\x1b[0m")
    if (setup) {
      // A final neutral reply cannot prove a reset unless the same transaction first established
      // a neutral baseline and the requested setup. Keep all phases inside the cleanup lifetime.
      for (const [phase, bytes, criterion] of [
        ["baseline", "", setup.baseline],
        ["setup", setup.sequence, setup.readback],
      ] as const) {
        if (bytes) ctx.write(bytes)
        const state = await querySgrState(ctx)
        if (state === null) return null
        observed[phase] = state.join(";")
        const qualified = sgrReadbackResult(id, bytes, state, criterion)
        if (!qualified.pass) {
          if (
            phase === "setup" &&
            (qualified.observation?.outcome === "unsupported" || qualified.notTested !== undefined) &&
            independentSetup
          ) {
            const captured = await independentSetup()
            if (captured) {
              const instrument = `${id}: the independent capture oracle supplies this result because the terminal's SGR report did not establish setup`
              const note = captured.note ? `${captured.note}; ${instrument}` : instrument
              const retained = {
                response: JSON.stringify({ ...observed, capture: captured.response }),
                note,
              }
              if (captured.observation) {
                return {
                  ...captured,
                  ...retained,
                  observation: {
                    ...captured.observation,
                    note: captured.observation.note ? `${captured.observation.note}; ${instrument}` : instrument,
                  },
                }
              }
              return { ...captured, ...retained }
            }
          }
          const note = `${id}: ${phase} prerequisite was not established${qualified.note ? `: ${qualified.note}` : ""}`
          return {
            pass: false,
            response: JSON.stringify({ phase, ...observed }),
            note,
            observation: {
              outcome: "inconclusive",
              assertionType: "query_reply",
              reason: "insufficient-evidence",
              note,
            },
          }
        }
      }
    }
    ctx.write(sequence)
    const state = await querySgrState(ctx)
    if (state === null) return null
    const result = evaluateSgrReadback(id, sequence, state, readback, setup !== undefined)
    return setup
      ? { ...result, response: JSON.stringify({ sgr: state.length === 0 ? "0" : state.join(";"), ...observed }) }
      : result
  } finally {
    ctx.write("\x1b[0m")
  }
}

/**
 * SGR probe — feed SGR sequence + "X", verify cell attribute (termless) or cursor position (term).
 *
 * A capture fixture renders at row 3 column 3; a smaller measured terminal clamps CUP or
 * wraps/scrolls the sample, so the shared guard refuses before any bytes.
 *
 * Termless: positive cell state establishes parser support. Adapters may omit
 * attributes or collapse styles, so a mismatch cannot establish non-support.
 * Term: cursor advance only proves the sequence was consumed, not that its style rendered.
 */
export const SGR_CAPTURE_MIN_ROWS = 3
export const SGR_CAPTURE_MIN_COLS = 34

/**
 * The 1x2 floor the plain SGR fixture refuses BEFORE any bytes: the sequence plus the X sample need
 * two cells, and a terminal below that cannot answer the cursor read the fixture grades. A caller
 * whose arm writes before falling back (the DECRQSS readback) still calls this first, so the refusal
 * is never preceded by bytes of its own.
 */
export function sgrPlainFixtureTooSmall(ctx: TermProbeSource): ProbeCallbackResult | undefined {
  const { rows, cols } = ctx
  if (Number.isSafeInteger(rows) && Number.isSafeInteger(cols) && rows >= 1 && cols >= 2) return undefined
  return {
    pass: false,
    tests: [
      { id: "criterion", status: "test-todo", reason: `SGR fixture needs at least 1x2, measured ${rows}x${cols}` },
    ],
  }
}

/** Refuse an SGR capture fixture before any bytes when the measured geometry is too small. */
export function sgrCaptureTooSmall(ctx: TermProbeSource, feature = "SGR capture"): ProbeCallbackResult | undefined {
  if (!ctx.capture) return undefined
  const { rows, cols } = ctx
  if (
    Number.isSafeInteger(rows) &&
    Number.isSafeInteger(cols) &&
    rows >= SGR_CAPTURE_MIN_ROWS &&
    cols >= SGR_CAPTURE_MIN_COLS
  ) {
    return undefined
  }
  return {
    pass: false,
    tests: [
      {
        id: "criterion",
        status: "test-todo",
        reason: `${feature} needs at least ${SGR_CAPTURE_MIN_ROWS}x${SGR_CAPTURE_MIN_COLS}, measured ${rows}x${cols}`,
      },
    ],
  }
}

/** Render a control screen and a target screen and return both frames as inconclusive pixel evidence. */
export async function sgrCaptureFrames(
  ctx: TermProbeSource,
  control: string,
  target: string,
  targetLabel: string,
  meta: Record<string, unknown> = {},
  note = "Control and target pixels captured; visual interpretation requires review",
  controlLabel = `${targetLabel} control`,
): Promise<ProbeCallbackResult> {
  if (!ctx.capture) throw new Error(`${targetLabel}: SGR pixel capture requires a capture callback`)
  ctx.write(control)
  const controlFrame = await ctx.capture({ role: "control", label: controlLabel })
  ctx.write(target)
  const targetFrame = await ctx.capture({ role: "target", label: targetLabel })
  return {
    pass: false,
    response: JSON.stringify({ ...meta, control: controlFrame.label, target: targetFrame.label }),
    criterionBranch: "visual-review",
    tests: [
      { id: "capture", status: "supported", assertionRefs: [0] },
      { id: "review", status: "test-todo", reason: "Valid control and target capture; required visual review pending" },
    ],
    assertions: [
      {
        assertionType: "screenshot" as const,
        kind: "positive",
        expected: `${targetLabel} compared with ${controlLabel}`,
        observed: JSON.stringify({ control: controlFrame, target: targetFrame }),
      },
    ],
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "screenshot",
      screenshotRef: targetFrame.ref,
      frames: [controlFrame, targetFrame],
      note,
    },
  }
}

/** The SGR pixel fixture: the attribute's sequence and the text sample it styles at a 1-based row and column. */
export type SgrCaptureFixture = Readonly<{ sequence: string; sample: string; row: number; col: number }>

/** A probe-owned pixel capture, for an attribute one control/target pair cannot show (sgr.blink, #31812). */
export type SgrCapture = (ctx: TermProbeSource, fixture: SgrCaptureFixture) => Promise<ProbeCallbackResult>

export function sgrProbe(
  id: string,
  sequence: string,
  check: (cell: ReturnType<LibProbeSource["getCell"]>) => boolean | null,
  noObservableWhen?: (cell: ReturnType<LibProbeSource["getCell"]>) => string | null,
  readback?: SgrReadback,
  sourceReviewReason?: string,
  capture?: SgrCapture,
): ProbeDefinition {
  return {
    id,
    termNeedsGeometry: true,
    termAssertionType: readback ? "query_reply" : null,
    lib(ctx) {
      ctx.feed(sequence + "X")
      const cell = ctx.getCell(0, 0)
      if (cell.char === "X") {
        const noObservable = noObservableWhen?.(cell)
        if (noObservable) return notTestedResult(noObservable, cell)
      }
      const measured = cell.char === "X" && check(cell) === true
      return parserStateResult(
        measured ? true : null,
        `${id}: attribute applied to the rendered X cell`,
        cell,
        cell.char !== "X"
          ? "No rendered X cell to evaluate"
          : measured || sourceReviewReason !== undefined
            ? undefined
            : "Cell readback cannot distinguish unsupported styling from unreported attributes or collapsed styles; a negative needs rendering review",
        cell.char === "X" && !measured ? sourceReviewReason : undefined,
      )
    },
    async term(ctx) {
      const refusal = sgrPlainFixtureTooSmall(ctx)
      if (refusal) return refusal
      if (readback) {
        // The capture fixture guard refuses before any bytes on a measured small terminal, so the
        // readback must not emit its own sequences ahead of it.
        if (ctx.capture) {
          const refusal = sgrCaptureTooSmall(ctx, "SGR fixture")
          if (refusal) return refusal
        }
        const decided = await sgrReadbackDecision(ctx, id, sequence, readback)
        if (decided) return decided
      }
      if (ctx.capture) {
        const refusal = sgrCaptureTooSmall(ctx, "SGR fixture")
        if (refusal) return refusal
        const sample = "AaBb 0123456789 - terminal text"
        try {
          if (capture) return await capture(ctx, { sequence, sample, row: 3, col: 3 })
          return await sgrCaptureFrames(
            ctx,
            "\x1b[0m\x1b[2J\x1b[3;3H" + sample,
            "\x1b[0m\x1b[2J\x1b[3;3H" + sequence + sample,
            id,
            { sample, startRow: 3, startCol: 3, sampleCells: sample.length },
            undefined,
            "Unstyled text sample",
          )
        } finally {
          ctx.write("\x1b[0m")
        }
      }
      ctx.write("\x1b[1;1H\x1b[2K") // clear line
      ctx.write(sequence + "X\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) {
        return replyFailure(
          "no parsable cursor position reply; the public projection returned null and retained no bytes",
        )
      }
      // Cursor should be at col 2 (wrote 1 char "X")
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
        response: `${pos.row};${pos.col}`,
        tests: [
          {
            id: "criterion",
            status: "test-todo",
            reason: `Cursor advance does not verify SGR styling${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
          },
        ],
      }
    },

    libAssertionType: "buffer_state",
  }
}

/**
 * Cursor probe — move cursor, verify position.
 * Termless uses 0-based coordinates, term DSR uses 1-based.
 */
export function cursorProbe(
  id: string,
  setup: string,
  move: string,
  expected: { row: number; col: number },
  setupExpected?: { row: number; col: number },
): ProbeDefinition {
  const inconclusive = (
    origin: object | null,
    setupPosition: object | null,
    final: object | null,
    assertionType: AssertionType,
    reason: "no-response" | "insufficient-evidence",
    note: string,
  ): ProbeCallbackResult => ({
    pass: false,
    response: JSON.stringify({ origin, setup: setupPosition, final }),
    ...(reason === "no-response"
      ? replyFailure("no parsable cursor position reply; the public projection returned null and retained no bytes")
      : { observation: { outcome: "inconclusive", reason, assertionType, note } }),
    note,
  })
  return {
    id,
    termNeedsGeometry: true,
    termAssertionType: "query_reply",
    lib(ctx) {
      ctx.feed("\x1b[1;1H")
      const origin = ctx.getCursor()
      if (origin.x !== 0 || origin.y !== 0) {
        return inconclusive(
          origin,
          null,
          null,
          "buffer_state",
          "insufficient-evidence",
          `Cursor origin measured ${origin.y};${origin.x}, expected 0;0`,
        )
      }
      if (setup) ctx.feed(setup)
      const setupPosition = setup ? ctx.getCursor() : origin
      if (setup && !setupExpected) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "buffer_state",
          "insufficient-evidence",
          "Cursor setup has no expected position",
        )
      }
      const wantedSetup = setupExpected ?? { row: 0, col: 0 }
      if (setupPosition.x !== wantedSetup.col || setupPosition.y !== wantedSetup.row) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "buffer_state",
          "insufficient-evidence",
          `Cursor setup measured ${setupPosition.y};${setupPosition.x}, expected ${wantedSetup.row};${wantedSetup.col}`,
        )
      }
      ctx.feed(move)
      const final = ctx.getCursor()
      return parserStateResult(
        final.x === expected.col && final.y === expected.row,
        `cursor row=${expected.row}, col=${expected.col} (0-based) after ${JSON.stringify(move)}`,
        { origin, setup: setupPosition, final },
      )
    },
    async term(ctx) {
      const minRows = Math.max(1, expected.row + 1, (setupExpected?.row ?? 0) + 1)
      const minCols = Math.max(1, expected.col + 1, (setupExpected?.col ?? 0) + 1)
      if (ctx.rows < minRows || ctx.cols < minCols) {
        const note = `Cursor fixture needs at least ${minRows} rows and ${minCols} columns; measured ${ctx.rows}x${ctx.cols}`
        return {
          pass: false,
          note,
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        }
      }
      ctx.write("\x1b[1;1H")
      const origin = await ctx.queryCursorPosition()
      if (!origin) {
        return inconclusive(null, null, null, "query_reply", "no-response", "Cursor origin readback returned null")
      }
      if (origin.row !== 1 || origin.col !== 1) {
        return inconclusive(
          origin,
          null,
          null,
          "query_reply",
          "insufficient-evidence",
          `Cursor origin measured ${origin.row};${origin.col}, expected 1;1`,
        )
      }
      if (setup) ctx.write(setup)
      const setupPosition = setup ? await ctx.queryCursorPosition() : origin
      if (!setupPosition) {
        return inconclusive(origin, null, null, "query_reply", "no-response", "Cursor setup readback returned null")
      }
      if (setup && !setupExpected) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "query_reply",
          "insufficient-evidence",
          "Cursor setup has no expected position",
        )
      }
      const wantedSetup = setupExpected ?? { row: 0, col: 0 }
      if (setupPosition.row !== wantedSetup.row + 1 || setupPosition.col !== wantedSetup.col + 1) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "query_reply",
          "insufficient-evidence",
          `Cursor setup measured ${setupPosition.row};${setupPosition.col}, expected ${wantedSetup.row + 1};${wantedSetup.col + 1}`,
        )
      }
      ctx.write(move)
      const final = await ctx.queryCursorPosition()
      if (!final) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "query_reply",
          "no-response",
          "Cursor movement readback returned null",
        )
      }
      const response = JSON.stringify({ origin, setup: setupPosition, final })
      const pass = final.row === expected.row + 1 && final.col === expected.col + 1
      return {
        pass,
        response,
        ...(pass
          ? {}
          : { note: `Cursor measured ${final.row};${final.col}, expected ${expected.row + 1};${expected.col + 1}` }),
        observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply" },
        assertions: [
          {
            assertionType: "query_reply" as const,
            kind: pass ? "positive" : "negative",
            expected: `cursor row=${expected.row + 1}, col=${expected.col + 1} after ${JSON.stringify(move)}`,
            observed: response,
          },
        ],
      }
    },

    libAssertionType: "buffer_state",
  }
}

/**
 * DECRPM mode probe. Responsiveness after enabling a mode does not prove that mode,
 * and blindly disabling it could change a mode the user already had enabled.
 */
export function decrpmModeProbe(
  id: string,
  modeNum: number,
  termlessFn: ((ctx: LibProbeSource) => ProbeCallbackResult) | null,
  verifySet = false,
): ProbeDefinition {
  return {
    id,
    ...(verifySet ? { termNeedsDisposable: true as const } : { termWrites: "query" as const }),
    termAssertionType: "query_reply",
    lib: termlessFn && zeroReplyUndecided(termlessFn),
    async term(ctx) {
      if (!verifySet) return decrpmResult(await queryDecrpm(ctx, modeNum), modeNum)
      const snapshot = await queryDecrpm(ctx, modeNum)
      let ps = snapshot
      if (snapshot === 2) {
        try {
          ctx.write(`\x1b[?${modeNum}h`)
          ps = await queryDecrpm(ctx, modeNum)
        } finally {
          ctx.write(`\x1b[?${modeNum}l`)
        }
      }
      const response = JSON.stringify({ snapshot, ...(snapshot === 2 ? { afterSet: ps } : {}) })
      if (ps === null) {
        return {
          pass: false,
          response,
          note: "no DECRPM reply",
          tests: [{ id: "criterion", status: "test-todo", reason: "no DECRPM reply" }],
        }
      }
      if (modeNum === 2026 && snapshot === 2 && ps === 2) {
        const reason =
          "synchronized-output set-state control unobservable: DECRPM reset reply after DECSET cannot establish enabled update; rendered effect unmeasured"
        return {
          pass: false,
          response,
          note: reason,
          tests: [{ id: "criterion", status: "test-failure", reason }],
        }
      }
      const supported = ps === 1 || ps === 3
      const reading = decrpmReading(ps)
      // Preserve the existing tail for other modes, including DECSCLM.
      const facet =
        modeUnmeasuredFacet(modeNum) ??
        "presentation (tearing, scroll cadence, inverted frame) unmeasured; protocol measured"
      const note = `${snapshot === 2 && ps === 2 ? "recognized but DECSET refused (mode kept reset)" : `DECRPM mode ${modeNum}: ${reading}`}; ${facet}${modeNum === 2031 ? "; the separate CSI ? 996 n query is unmeasured here" : ""}`
      return {
        pass: supported,
        response,
        note,
        observation: { outcome: supported ? "supported" : "unsupported", assertionType: "query_reply", note },
        assertions: [
          {
            assertionType: "query_reply",
            kind: supported ? "positive" : "negative",
            expected: `DECRPM mode ${modeNum} set or permanently set`,
            observed: response,
          },
        ],
      }
    },
  }
}

/**
 * The headless arm of a DECRQM mode criterion (#30543): the engine's own DECRPM reply, read by the same parser and
 * graded by the same decrpmResult as the app arm, whenever the adapter delivers one; otherwise the review branch.
 * Default callers retain getMode as context only. The six-mode requireReadback opt-in requires the
 * engine's set/reset reply pair and independently agreeing adapter reads; a binding gap stays TODO.
 * The branch keys on the observed reply, never on an engine name.
 */
export function headlessDecrpmArm(
  modeNum: number,
  modeName: string,
  options: { requireReadback: true },
): (ctx: LibProbeSource) => ProbeCallbackResult
export function headlessDecrpmArm(modeNum: number, modeName?: string): (ctx: LibProbeSource) => ProbeCallbackResult
export function headlessDecrpmArm(
  ...args:
    | [modeNum: number, modeName?: string]
    | [modeNum: number, modeName: string, options: { requireReadback: true }]
): (ctx: LibProbeSource) => ProbeCallbackResult {
  const [modeNum, modeName] = args
  return (ctx) => {
    if (args.length === 3) {
      // The strict overload requires a mode key; the name is display-only, never an engine selector.
      const key = args[1]
      const insertBefore = modeNum === 4 ? ctx.getMode("insertMode") : undefined
      let resetSent = false
      try {
        ctx.feed(`\x1b[?${modeNum}h`)
        const insertAfter = modeNum === 4 ? ctx.getMode("insertMode") : undefined
        const setMode = ctx.getMode(key)
        const setReply = ctx.feedCapture(`\x1b[?${modeNum}$p`)
        ctx.feed(`\x1b[?${modeNum}l`)
        resetSent = true
        const resetMode = ctx.getMode(key)
        const resetReply = ctx.feedCapture(`\x1b[?${modeNum}$p`)
        const state = { setReply, resetReply, setMode, resetMode, insertBefore, insertAfter }
        const response = JSON.stringify(state)
        const setPs = decrpmPs(decrpmReplyPattern(modeNum).exec(setReply)?.[1])
        const resetPs = decrpmPs(decrpmReplyPattern(modeNum).exec(resetReply)?.[1])
        const facet =
          modeNum === 4
            ? "smooth-scroll presentation unmeasured in lib arm"
            : modeNum === 1007
              ? "wheel-to-cursor-key translation unmeasured; protocol measured"
              : modeUnmeasuredFacet(modeNum)
        const presentation = facet === undefined ? "" : `; ${facet}`
        if (modeNum === 4 && insertBefore !== null && insertAfter !== null && insertBefore !== insertAfter) {
          const note = `DEC private4 changed ANSI insertMode; engine conflation (#32002)${presentation}`
          return {
            pass: false,
            response,
            note,
            observation: { outcome: "unsupported", assertionType: "buffer_state", note },
            assertions: [
              {
                assertionType: "buffer_state",
                kind: "negative",
                expected: "DEC private4 leaves ANSI insertMode unchanged",
                observed: response,
              },
            ],
          }
        }
        if (setPs === 0 || setPs === 2 || setPs === 4) {
          const note = `DECRPM mode ${modeNum} after DECSET: ${decrpmReading(setPs)}${presentation}`
          return {
            pass: false,
            response,
            note,
            observation: { outcome: "unsupported", assertionType: "query_reply", note },
            assertions: [
              {
                assertionType: "query_reply",
                kind: "negative",
                expected: `DECRPM mode ${modeNum} set after DECSET`,
                observed: setReply,
              },
            ],
          }
        }
        if (setPs === null) {
          return osInputReviewResult(
            `DECRPM reply to CSI ? ${modeNum} $ p`,
            state,
            "The adapter delivered no DECRPM reply from the engine; required independent review of the retained raw state pending",
          )
        }
        const insertBindingGap = modeNum === 4 && (insertBefore === null || insertAfter === null)
        const bindingGap = setMode !== true || resetMode !== false
        if (bindingGap || insertBindingGap || setPs !== 1 || resetPs !== 2) {
          const reason = insertBindingGap
            ? `adapter binding ${ctx.backendName} insertMode`
            : bindingGap
              ? `adapter binding ${ctx.backendName} ${key}`
              : `DECRPM mode ${modeNum}: set Ps ${setPs}, reset Ps ${resetPs}`
          return {
            pass: false,
            response,
            note: reason + presentation,
            observation: {
              outcome: "inconclusive",
              assertionType: "query_reply",
              reason: "insufficient-evidence",
              note: reason + presentation,
            },
            tests: [{ id: "criterion", status: "test-todo", reason }],
          }
        }
        const note = `DECRPM mode ${modeNum}: set/reset replies and getMode agree${presentation}`
        return {
          pass: true,
          response,
          note,
          observation: { outcome: "supported", assertionType: "query_reply", note },
          assertions: [
            {
              assertionType: "query_reply",
              kind: "positive",
              expected: `DECRPM mode ${modeNum} Ps1/Ps2 with agreeing getMode`,
              observed: response,
            },
          ],
        }
      } finally {
        if (!resetSent) ctx.feed(`\x1b[?${modeNum}l`)
      }
    }
    ctx.feed(`\x1b[?${modeNum}h`)
    // Read the adapter's mode view before the query. vt100 and vt220 used to run `CSI ? 1 $ p` as a DECCKM
    // reset, so a getMode read after the query reported the mode already reset; since #30558 they ignore a
    // query they do not have, and the order no longer changes the reading. Reading first still keeps the
    // context independent of how any engine treats an unknown query.
    const mode = modeName === undefined ? undefined : ctx.getMode(modeName)
    const reply = ctx.feedCapture(`\x1b[?${modeNum}$p`)
    const state = modeName === undefined ? { reply } : { reply, mode }
    ctx.feed(`\x1b[?${modeNum}l`)
    const ps = decrpmPs(decrpmReplyPattern(modeNum).exec(reply)?.[1])
    if (ps === null) {
      return osInputReviewResult(
        `DECRPM reply to CSI ? ${modeNum} $ p`,
        state,
        "The adapter delivered no DECRPM reply from the engine; required independent review of the retained raw state pending",
      )
    }
    return { ...decrpmResult(ps, modeNum), response: JSON.stringify(state) }
  }
}

function modeUnmeasuredFacet(modeNum: number): string | undefined {
  return modeNum === 2031
    ? "scheme-change report (CSI ? 997 ; Ps n, unsolicited) unmeasured; recognition measured"
    : modeNum === 5
      ? "presentation (inverted frame) unmeasured; protocol measured"
      : modeNum === 2026
        ? "presentation (tearing, scroll cadence) unmeasured; protocol measured"
        : undefined
}

const DECRPM_WORDS: Record<DecrpmPs, string> = {
  0: "not recognized",
  1: "set",
  2: "reset",
  3: "permanently set",
  4: "permanently reset",
}

/** A DECRPM reading as a cell stores it: the word and the numeric Ps, so a stored "reset" never hides a Ps 4 (#30557). */
export function decrpmReading(ps: DecrpmPs): string {
  return `${DECRPM_WORDS[ps]} (Ps ${ps})`
}

/**
 * The one grader of a DECRPM reading, shared by the app arm and the headless arm (#30557, @cto 254dd9cf):
 * Ps 1, 2 and 3 grade supported; Ps 4 grades unsupported, because the terminal says it knows the mode and
 * that the mode cannot be set (xterm.js answers exactly that for 1005). The three
 * protocol-only criteria below also grade an explicit Ps 0 as unsupported;
 * other modes retain their existing inconclusive Ps 0 result.
 */
export function decrpmResult(ps: DecrpmPs | null, modeNum: number): ProbeCallbackResult {
  if (ps === null) {
    return replyFailure("no usable DECRPM reply; the public projection returned null and retained no bytes")
  }
  const reading = decrpmReading(ps)
  // CTO 62ab5adc: modes 5, 2026 and 2031 grade protocol recognition; their named effects remain unmeasured.
  const unmeasuredFacet = modeUnmeasuredFacet(modeNum)
  if (ps === 0) {
    if (unmeasuredFacet) {
      const note = `DECRPM mode ${modeNum}: ${reading}; ${unmeasuredFacet}`
      return {
        pass: false,
        note,
        response: reading,
        observation: { outcome: "unsupported", assertionType: "query_reply", note },
        assertions: [
          {
            assertionType: "query_reply",
            kind: "negative",
            expected: `DECRPM mode ${modeNum} recognized (set or reset)`,
            observed: reading,
          },
        ],
      }
    }
    return {
      pass: false,
      note: `DECRPM mode ${modeNum}: not recognized; mode behavior unmeasured`,
      response: reading,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "query_reply",
        note: `DECRPM mode ${modeNum}: not recognized; mode behavior unmeasured`,
      },
    }
  }
  if (ps === 4) {
    const note = `DECRPM mode ${modeNum}: ${reading}; the terminal knows the mode and cannot set it${unmeasuredFacet ? `; ${unmeasuredFacet}` : ""}`
    return {
      pass: false,
      note,
      response: reading,
      observation: { outcome: "unsupported", assertionType: "query_reply", note },
      assertions: [
        {
          assertionType: "query_reply" as const,
          kind: "negative",
          expected: `DECRPM mode ${modeNum} can be set`,
          observed: reading,
        },
      ],
    }
  }
  const note = `DECRPM mode ${modeNum}: ${reading}${unmeasuredFacet ? `; ${unmeasuredFacet}` : ""}`
  return {
    pass: true,
    note,
    response: reading,
    observation: { outcome: "supported", assertionType: "query_reply", ...(unmeasuredFacet && { note }) },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: "positive",
        expected: `DECRPM mode ${modeNum} recognized (set or reset)`,
        observed: reading,
      },
    ],
  }
}

/**
 * The width a re-seeded `X` sweep proves from the engine's own cursor, or the named reason it proves
 * none (#31381, @cto cee6d003). The deciding observation is buffer state: no reply writer, no CPR.
 */
export type CellWidthSweep =
  | { kind: "width"; width: 80 | 132; cursor: { x: number; y: number } }
  | {
      kind: "unmeasured"
      reason: "autowrap off" | "133rd X did not wrap" | "width outside 80/132"
      cursor: { x: number; y: number }
    }

const CELL_WIDTH_SEED = "\x1b[0m\x1b[2J\x1b[H"

/**
 * Re-seed, then write 133 `X`s. The 133rd `X` is what separates the two admitted widths: at 80 the
 * cursor lands at row 1 col 53, at 132 the 133rd wraps and lands at row 1 col 1 — 132 is proven
 * exactly and never rounded up from `W >= 132`. A terminal that never wrapped reads row 0: col 79 or
 * 131 is the named `autowrap off` control (the cursor parks at the last column), col 132 or more is
 * `133rd X did not wrap` (at least 133 wide); every other reading is `width outside 80/132`. The
 * sweep decides from buffer state alone: no reply writer, no CPR.
 */
export function sweepCellWidth(ctx: Pick<LibProbeSource, "feed" | "getCursor">): CellWidthSweep {
  ctx.feed(CELL_WIDTH_SEED)
  ctx.feed("X".repeat(133))
  const cursor = ctx.getCursor()
  if (cursor.y === 1 && cursor.x === 53) return { kind: "width", width: 80, cursor }
  if (cursor.y === 1 && cursor.x === 1) return { kind: "width", width: 132, cursor }
  if (cursor.y === 0 && (cursor.x === 79 || cursor.x === 131)) {
    return { kind: "unmeasured", reason: "autowrap off", cursor }
  }
  if (cursor.y === 0 && cursor.x >= 132) return { kind: "unmeasured", reason: "133rd X did not wrap", cursor }
  return { kind: "unmeasured", reason: "width outside 80/132", cursor }
}

/** One DECCOLM measurement: both gate controls, the roundtrip, and the reply that only corroborates. */
export interface CellWidthTransitionReads {
  /** `?40` closed, mode 3 untouched: the baseline the transition is measured from. */
  initial: CellWidthSweep
  /** Gate control A: `?40` still closed and the mode set; the gate must hold the `initial` width. */
  gateBefore: CellWidthSweep
  /** `?40` opened, then the mode set in the direction the baseline implies. */
  enabled: CellWidthSweep
  /** After the mode was restored. */
  restored: CellWidthSweep
  /** Gate control B: `?40` closed again and the mode re-set; the gate must hold the `restored` width. */
  gateAfter: CellWidthSweep
  /** DECRPM `Ps` for mode 3; `null` when the engine answered nothing. */
  decrpm: DecrpmPs | null
  /** Columns an answering `18 t` reported for each phase; `null` = silent, which is not a datum. */
  reply18t: { initial: number | null; enabled: number | null; restored: number | null }
}

/** A named inconclusive: its typed test row carries the observed reading that named it. */
function cellWidthNamed(
  response: string,
  name: string,
  observed: object,
  assertions?: Array<Omit<ProbeAssertion, "featureId" | "rawReplyRef">>,
): ProbeCallbackResult {
  return {
    pass: false,
    response,
    observation: {
      outcome: "inconclusive",
      assertionType: "buffer_state",
      reason: "insufficient-evidence",
      note: name,
    },
    ...(assertions && { assertions }),
    tests: [{ id: "criterion", status: "test-failure", reason: `${name}: ${JSON.stringify(observed)}` }],
  }
}

/** The gate control's own assertion when ?40 closed did not hold the width (cee6d003). */
function gateNotHonoured(response: string, held: number, phase: string, sweep: { width: number }): ProbeCallbackResult {
  return cellWidthNamed(response, "gate not honoured", { [phase]: sweep }, [
    {
      assertionType: "buffer_state",
      kind: "negative",
      expected: `?40 closed holds the width at ${held} when mode 3 is set`,
      observed: response,
    },
  ])
}

/**
 * The DECCOLM decision (#31381, @cto cee6d003, 9e841266). The measured sweep decides: unchanged width
 * with ?40 held is Unsupported whatever DECRPM reads. Refusing Ps 0/4 readings remain in the note.
 * A silent `18 t` decides by width; an answering `18 t` disagreement is a named FAILURE.
 */
export function cellWidthTransition(reads: CellWidthTransitionReads): ProbeCallbackResult {
  const response = JSON.stringify(reads)
  const unmeasured = [reads.initial, reads.gateBefore, reads.enabled, reads.restored, reads.gateAfter].find(
    (sweep) => sweep.kind === "unmeasured",
  )
  if (unmeasured?.kind === "unmeasured") {
    const name =
      unmeasured === reads.initial && unmeasured.reason === "width outside 80/132"
        ? "initial width outside 80/132"
        : unmeasured.reason
    return cellWidthNamed(response, name, unmeasured)
  }
  if (
    reads.initial.kind !== "width" ||
    reads.enabled.kind !== "width" ||
    reads.restored.kind !== "width" ||
    reads.gateBefore.kind !== "width" ||
    reads.gateAfter.kind !== "width"
  ) {
    return cellWidthNamed(response, "width outside 80/132", reads)
  }
  const initial = reads.initial.width
  const target = initial === 80 ? 132 : 80
  if (reads.gateBefore.width !== initial) return gateNotHonoured(response, initial, "gateBefore", reads.gateBefore)
  if (reads.gateAfter.width !== reads.restored.width) {
    return gateNotHonoured(response, reads.restored.width, "gateAfter", reads.gateAfter)
  }
  const corroboration: ReadonlyArray<readonly [string, Extract<CellWidthSweep, { kind: "width" }>, number | null]> = [
    ["initial", reads.initial, reads.reply18t.initial],
    ["enabled", reads.enabled, reads.reply18t.enabled],
    ["restored", reads.restored, reads.reply18t.restored],
  ]
  for (const [phase, sweep, claimed] of corroboration) {
    if (claimed !== null && claimed !== sweep.width) {
      return {
        pass: false,
        response,
        tests: [
          {
            id: "criterion",
            status: "test-failure",
            reason: `18t/sweep disagreement W=${sweep.width} vs ${claimed} (${phase})`,
          },
        ],
      }
    }
  }
  const moved = reads.enabled.width === target && reads.restored.width === initial
  // The measured sweep decides support; retain a refusing DECRPM reading as corroboration.
  const decrpmNote =
    reads.decrpm === 0 || reads.decrpm === 4
      ? `DECRPM mode 3 reads ${decrpmReading(reads.decrpm)} while the sweep measured ${initial} -> ${reads.enabled.width} -> ${reads.restored.width}`
      : undefined
  const partialTransition =
    reads.enabled.width === target && reads.restored.width !== initial
      ? `set moved width to ${target}, reset did not restore ${initial}`
      : undefined
  return {
    pass: moved,
    response,
    observation: {
      outcome: moved ? "supported" : "unsupported",
      assertionType: "buffer_state",
      note: [
        `initial=${initial}, enabled=${reads.enabled.width}, restored=${reads.restored.width}`,
        decrpmNote,
        partialTransition,
      ]
        .filter((part) => part !== undefined)
        .join("; "),
    },
    assertions: [
      {
        assertionType: "buffer_state",
        kind: moved ? "positive" : "negative",
        expected: `DECCOLM changes measured columns ${initial} -> ${target} -> ${initial} with ?40 honoured`,
        observed: response,
      },
      ...(moved
        ? [
            {
              assertionType: "buffer_state",
              kind: "positive",
              expected: `?40 closed holds the width at ${initial} when mode 3 is set, before and after the transition`,
              observed: response,
            } as const,
          ]
        : []),
    ],
  }
}

/** Check if a cell character is blank (empty or space). */
export function isBlank(char: string): boolean {
  return char === "" || char === " "
}

export function validSize(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum
}

export function tooSmall(
  ctx: TermProbeSource,
  rows: number,
  cols: number,
  fixture = "Text fixture",
): ProbeCallbackResult | undefined {
  if (validSize(ctx.rows, rows) && validSize(ctx.cols, cols)) return undefined
  return {
    pass: false,
    tests: [
      {
        id: "criterion",
        status: "test-todo",
        reason: `${fixture} needs at least ${rows}x${cols}; measured ${ctx.rows}x${ctx.cols}`,
      },
    ],
  }
}

/**
 * Simple probe — for probes that need custom logic on both sides.
 */
export function probe(
  id: string,
  lib: ((ctx: LibProbeSource) => ProbeCallbackResult) | null,
  term: ((ctx: TermProbeSource) => Promise<ProbeCallbackResult>) | null,
  termAssertionType?: AssertionType | null,
): ProbeDefinition {
  return {
    id,
    lib: lib && zeroReplyUndecided(lib),
    term,
    ...(termAssertionType !== undefined ? { termAssertionType } : {}),
  }
}

export const REPLY_PATH_AUDIT_REVIEW = "reply-path-audit-review"
export const HEADLESS_OBSERVABLE_REVIEW = "headless-observable-review"
/** A reply-path gate carries no verdict, so it is not in this set: its kept answer decides (@cto de41833e). */
export const UNTESTABLE_ONLY_REVIEW_BRANCHES: ReadonlySet<string> = new Set([HEADLESS_OBSERVABLE_REVIEW])

/**
 * The branches whose review is a source-only negative: there is no event to assert, so a cell on one of these
 * carries neither an assertion type nor assertionRefs. A colour-readback cell is deliberately not in this set —
 * its branch records no observable channel, so the probe chooses a branch that carries an answer rather than
 * the reader admitting one that does not (@cto 32f3d0c1, 93c86660).
 */
export const SOURCE_ONLY_NEGATIVE_REVIEW_BRANCHES: ReadonlySet<string> = new Set([
  SOURCE_NEGATIVE_REVIEW,
  REPLY_PATH_AUDIT_REVIEW,
])

/**
 * The qualified WASM artifact per libvterm history cohort, keyed as in ADAPTER_SOURCE_AUDITS. A rebuilt adapter
 * adds a cohort here rather than editing a grading literal in the review, and each key names the review's own
 * source citation (31386/32220).
 */
const LIBVTERM_HISTORY_ARTIFACTS = {
  libvterm: {
    engineVersion: "0.3.3",
    adapterVersion: "0.10.2",
    wasmSha256: "3d67045bb43c5e4081c70dc58088af8f735416c20df2d7843d765e5aad8ef62a",
  },
  libvterm712298af: {
    engineVersion: "0.3.3",
    adapterVersion: "0.10.2",
    wasmSha256: "712298aff45c7c53a22dc028b13cb58dae1e984199b520bbbc0475ae64d83159",
  },
} as const satisfies Partial<
  Record<keyof typeof ADAPTER_SOURCE_AUDITS, { engineVersion: string; adapterVersion: string; wasmSha256: string }>
>

/** Exact source/API audit; an embedding application's history is a different subject. */
export function libvtermHistoryReview(ctx: LibProbeSource): ProbeCallbackResult | undefined {
  const identity = evidenceRuntimeIdentity(ctx.runtimeIdentity)
  if (!identity || identity.kind !== "js" || identity.runtimeFormat !== "wasm") return undefined
  const cohort = (["libvterm712298af", "libvterm"] as const).find((key) =>
    auditedAdapterSources(ctx.runtimeIdentity, key),
  )
  if (cohort === undefined) return undefined
  const artifact = LIBVTERM_HISTORY_ARTIFACTS[cohort]
  if (identity.engineVersion !== artifact.engineVersion || identity.adapterVersion !== artifact.adapterVersion) {
    return undefined
  }
  // No source review decides this cell any more (#32246): the adapter offers no history reader, so it stays TEST TODO.
  return notTestedResult(`libvterm v${artifact.engineVersion} adapter exposes no retained scrollback history count`, {
    engineVersion: identity.engineVersion,
    adapterVersion: identity.adapterVersion,
  })
}

/** The collector's test row for a capture that reached an engine callback its adapter does not reproduce. */
export const HARNESS_INCOMPLETE_TEST = "harness"

/**
 * A library probe on any engine (native, wasm or pure JS) whose every reply capture returned zero bytes has no same-path control in
 * this run, so silence alone never grades it (@cto 9fad23d7, #32246): the cell is TEST TODO. Observed buffers,
 * replies and callbacks that already carry a pass, a not-tested record or a TEST TODO keep their measured result.
 */
function zeroReplyUndecided(
  lib: (ctx: LibProbeSource) => ProbeCallbackResult,
): (ctx: LibProbeSource) => ProbeCallbackResult {
  return (ctx) => {
    const identity = ctx.runtimeIdentity
    if (identity === undefined) return lib(ctx)
    const captures: { text: string; reply: string }[] = []
    const recorded = new Proxy(ctx, {
      get(target, key): unknown {
        if (key === "queryWithSentinelOutcome") {
          const query = target.queryWithSentinelOutcome
          if (query === undefined) return undefined
          return (text: string, pattern: RegExp) => {
            const outcome = query.call(target, text, pattern)
            captures.push({ text, reply: outcome.raw })
            return outcome
          }
        }
        if (key !== "feedCapture") {
          const value: unknown = Reflect.get(target, key, target)
          return value
        }
        return (text: string) => {
          const reply = target.feedCapture(text)
          captures.push({ text, reply })
          return reply
        }
      },
    })
    const measured = lib(recorded)
    if (
      captures.length === 0 ||
      captures.some(({ reply }) => reply.length > 0) ||
      measured.pass ||
      measured.observation?.assertionType === "buffer_state" ||
      measured.notTested ||
      measured.tests?.some((test) => test.status === "test-todo")
    ) {
      return measured
    }
    const undecided = notTestedResult(NO_SAME_PATH_CONTROL, {
      queries: captures.map(({ text }) => text),
      replyBytes: 0,
      measuredResponse: measured.response ?? null,
    })
    // The observed host-recipe causes are measurements of this run; they stay with the undecided cell.
    return measured.hostRecipeCauses ? { ...undecided, hostRecipeCauses: measured.hostRecipeCauses } : undecided
  }
}

/** Feature support is independent of whether an observer can inspect link metadata. */
export function readHyperlinkMetadata(
  available: boolean,
  readLink: LibProbeSource["getHyperlinkAt"],
  row: number,
  col: number,
  backendName: string,
): string | null | undefined {
  if (!available) return undefined
  if (typeof readLink !== "function") {
    throw new Error(`${backendName} declares OSC 8 metadata but has no getHyperlinkAt method at ${row},${col}`)
  }
  const hyperlink = readLink(row, col)
  if (hyperlink !== null && typeof hyperlink !== "string") {
    throw new Error(`${backendName} declares OSC 8 metadata but returned an invalid value at ${row},${col}`)
  }
  return hyperlink
}

/** A complete DA1 answer, as the live collector has always matched it. */
const DA1_ANSWER = /\x1b\[\?[0-9;]+c/gu

/**
 * F1 (27832): which DA1 answer in a read is the sentinel's (#30559, @cto 86260f80 rule 1). The sentinel
 * is written after the query, so its answer is the LAST DA1-shaped answer in the read, and every byte
 * before it is the query's reply, even a reply shaped like a DA1 answer (Terminal.app answers DA3 that
 * way). Null until a DA1 answer has arrived. Every reader that asks which DA1 answer ends the query
 * asks here.
 */
export function sentinelAnswer(raw: string): { start: number; end: number } | null {
  let last: { start: number; end: number } | null = null
  for (const found of raw.matchAll(DA1_ANSWER)) last = { start: found.index, end: found.index + found[0].length }
  return last
}

/**
 * F1 (27832): a DA1 sentinel answered on time with nothing else said through the grace window is a
 * measured negative, not an unknown — the terminal was alive and did not answer the query. `sentinel`
 * carries the measured ordering (its arrival and the window that followed), which the negative cites
 * so a reader can tell it from an explicit negative reply without a new evidence member.
 *
 * Returns null when the collector measured no sentinel, when any byte precedes the sentinel's own
 * answer (a DA1-shaped reply included: the terminal said something, #30559), or when anything but
 * whitespace follows it (a partial frame is the site's own `invalid-reply`, not a silent terminal),
 * so the caller keeps its existing inconclusive grade.
 */
export function sentinelNegativeResult(
  raw: string,
  sentinel: { atMs: number; graceMs: number } | undefined,
  expected: string,
): ProbeCallbackResult | null {
  const answer = sentinelAnswer(raw)
  if (!sentinel || answer === null || answer.start > 0 || raw.slice(answer.end).trim() !== "") return null
  const observed = `DA1 answered at +${String(sentinel.atMs)}ms; no reply through the ${String(sentinel.graceMs)} ms window`
  return {
    pass: false,
    response: raw,
    observation: { outcome: "unsupported", assertionType: "query_reply", note: "negative by sentinel" },
    assertions: [{ assertionType: "query_reply" as const, kind: "negative", expected, observed }],
  }
}

/**
 * F4 (#30699): a hand-written probe's headless arm reads a bare capture, so on a proven engine a query
 * the terminal ignores looks the same as one the collector never delivered. Ask the sentinel member
 * first: an answered DA1 with no matching frame is the measured negative the criterion names, graded
 * exactly as live grades it. Every other outcome returns null and the probe keeps its own capture
 * reading, so an engine off the proven list is unchanged.
 */
export function sentinelSilenceResult(outcome: TerminalQueryOutcome, expected: string): ProbeCallbackResult | null {
  if (outcome.reason !== "sentinel") return null
  return sentinelNegativeResult(outcome.raw, outcome.sentinel, expected)
}

/** The ordering note a reply carries when it arrived after the DA1 sentinel rather than before it. */
export const REPLY_AFTER_SENTINEL_NOTE = "reply after sentinel"

/** The frame a query grader reads from an outcome: a reply's match, never bytes that arrived without one. */
export function replyFrame(outcome: TerminalQueryOutcome): string | null {
  return outcome.reason === "reply" ? (outcome.match?.[0] ?? null) : null
}

/** What the bytes read so far say about a query that carried a DA1 sentinel. */
export type SentinelRead =
  | { kind: "pending"; match: string[] | null }
  | { kind: "reply"; match: string[] }
  | { kind: "unmatched"; match: string[] | null }
  | { kind: "answered"; match: string[] | null }

/**
 * F1 (27832) has one reading rule for both collectors (#30554, @cto 452bc032 condition 3). Until a DA1
 * answer arrives the read is `pending`. The sentinel's answer is the last DA1-shaped one
 * (`sentinelAnswer`, #30559), and a frame ahead of it is a plain `reply` with no sentinel facts.
 * Bytes ahead of it that match nothing are `unmatched`: the terminal said something, so it was not
 * silent (@cto 67840412 R1). Only a DA1 answer with nothing before it is `answered`. Both of those
 * carry any frame that followed the answer. The live collector reads every chunk this way and decides
 * at the end of the grace window, on the whole read; the headless member reads its two captures once.
 */
export function readSentinelReply(buffer: string, pattern: RegExp): SentinelRead {
  const found = buffer.match(pattern)
  const match = found ? [...found] : null
  const answer = sentinelAnswer(buffer)
  if (!answer) return { kind: "pending", match }
  if (match && (found?.index ?? 0) < answer.start) return { kind: "reply", match }
  if (answer.start > 0) return { kind: "unmatched", match }
  return { kind: "answered", match }
}

/**
 * F1 (27832): how long the collector keeps reading after a DA1 sentinel before it calls a missing
 * reply a measured negative. Sized by measurement, once: re-run the sentinel-fired features on every
 * Release 1 terminal with a 1 s post-DA1 read and record any late reply and its delay, then
 * grace = max(250 ms, 2 x the largest observed delay). 250 ms is the floor until that measurement
 * lands; the issue names any terminal that answers late and the features it answers late for.
 */
const SENTINEL_GRACE_MS = 250

/**
 * The window is a measured value, so the one-time sizing pass may widen it without a code change:
 * TERMINFO_SENTINEL_GRACE_MS sets the post-DA1 read for that pass only. An unset or empty value is
 * the floor. Anything that is not a positive whole number of milliseconds falls back to the same
 * floor and says so on stderr: a typo here must never be silent, and a mistyped sizing value does
 * not justify refusing the pass (28385, 30255). The live and headless collectors read this one value
 * (#30554).
 */
export function sentinelGraceMs(
  raw: string | undefined = typeof process !== "undefined" ? process.env.TERMINFO_SENTINEL_GRACE_MS : undefined,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): number {
  if (raw === undefined || raw === "") return SENTINEL_GRACE_MS
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < 1) {
    warn(
      `TERMINFO_SENTINEL_GRACE_MS ${JSON.stringify(raw)} is not a positive whole number of milliseconds; ` +
        `using the ${SENTINEL_GRACE_MS} ms floor for this run`,
    )
    return SENTINEL_GRACE_MS
  }
  return value
}

/** Initialize actual work before preflight; a callback-only schedule cannot stand in for the catalogue. */
export function initializeRunDraft(input: {
  runId: string
  sourceRevision: string
  manifest: ProbeSuiteManifest & { schemaVersion: 4 }
  source: RunDraft["source"]
  intendedSubject: RunDraft["intendedSubject"]
}): RunDraft {
  if (input.manifest.schemaVersion !== 4) {
    throw new Error("Current run writer requires a schemaVersion 4 suite manifest")
  }
  assertCurrentSource(input.source)
  if (input.source.kind === "trace" && input.source.captureRunId === input.runId) {
    throw new Error("Trace source capture runId must differ from the assertion runId")
  }
  const ids = input.manifest.catalogIds
  if (!ids || ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(`Suite ${input.manifest.probeHash} requires a nonempty unique frozen catalogIds set`)
  }
  return {
    schemaVersion: 4,
    source: input.source.kind === "live" ? { kind: "live" } : { ...input.source, trace: { ...input.source.trace } },
    runId: input.runId,
    suiteId: input.manifest.probeHash,
    probeHash: input.manifest.probeHash,
    sourceRevision: input.sourceRevision,
    intendedSubject: { ...input.intendedSubject },
    results: ids.map((featureId) => ({
      featureId,
      status: "test-todo",
      attempt: { scope: "none" },
      tests: [],
      reason: UNSTARTED_PROBE_REASON,
    })),
    rawReplies: {},
    assertions: [],
    screenshotRefs: [],
  }
}

/** Fold only the tests still required by the frozen probe's explicitly selected criterion branch. */
export function finalizeProbeResult(input: Omit<ProbeResult, "status">): ProbeResult {
  // A probe result is graded from this run's observation alone; a stored source answer never decides it (#32246).
  if (input.reviewRef !== undefined || input.tests.some((test) => test.reviewRef !== undefined)) {
    throw new Error(`${input.featureId} carries a source-answer reference; source answers no longer grade (#32246)`)
  }
  const tests = input.tests
  const failed = tests.find((test) => test.status === "test-failure")
  const pending = tests.find((test) => test.status === "test-todo")
  const impossible = tests.find((test) => test.status === "untestable")
  let status: ProbeResult["status"]
  let reason = input.reason
  if (failed) {
    status = "test-failure"
    reason ??= failed.reason ?? "Required test failed after its attempt"
  } else if (pending || tests.length === 0) {
    status = "test-todo"
    reason ??= pending?.reason ?? "Required feature implementation has not run"
  } else if (impossible) {
    // There is no route to Untestable: its only route was a stored review, and source answers no longer grade (#32246).
    status = "test-todo"
    reason ??= impossible.reason ?? "no route to Untestable"
  } else {
    status = tests.some((test) => test.status === "unsupported") ? "unsupported" : "supported"
  }
  const stored = { ...input } as typeof input & { replyFailureTestIds?: unknown }
  delete stored.replyFailureTestIds
  return { ...stored, status, ...(reason === undefined ? {} : { reason }) }
}

function assertCurrentSource(source: unknown): asserts source is RunDraft["source"] {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
  const keys = (value: Record<string, unknown>, expected: string[]) =>
    Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key))
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
  if (!object(source)) throw new Error("Current run writer requires an explicit probe source")
  if (source.kind === "live" && keys(source, ["kind"])) return
  if (source.kind !== "trace") throw new Error("Current run writer requires exactly { kind: live } or a trace source")
  if (
    !keys(source, ["kind", "trace", "captureRunId", "captureSuiteId", "captureSourceRevision"]) ||
    !object(source.trace) ||
    !keys(source.trace, ["path", "sha256"]) ||
    !nonempty(source.trace.path) ||
    /^(?:[\\/]|[a-z]:)/i.test(source.trace.path) ||
    source.trace.path.split(/[\\/]/).includes("..") ||
    typeof source.trace.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(source.trace.sha256) ||
    !nonempty(source.captureRunId) ||
    !nonempty(source.captureSuiteId) ||
    typeof source.captureSourceRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(source.captureSourceRevision)
  ) {
    throw new Error(
      "Invalid trace probe source: require relative artifact path/SHA256 and capture run, suite and source revision",
    )
  }
}

/** Execute the declared callback's proposition once; readers consume this recorded result. */
export function recordExecutedProbe(input: {
  featureId: string
  attempt: Exclude<ProbeAttempt, { scope: "none" }>
  observation?: Observation
  diagnostic?: UngradedDiagnostic
  coverage?: NotTestedCoverage
  rawReplyRef?: string
  assertions: readonly ProbeAssertion[]
  tests?: ProbeTestInput[]
  criterionBranch?: string
}): ProbeResult {
  const { featureId, attempt, observation, diagnostic, coverage } = input
  if (!observation && !coverage && input.tests && !diagnostic) {
    if (
      input.tests.length === 0 ||
      input.tests.some((test) => !["test-todo", "test-failure"].includes(test.status) || !test.reason?.trim())
    ) {
      throw new Error(`Execution-only callback ${featureId} requires nonempty TODO/FAILURE tests with reasons`)
    }
  }
  const assertionRefs = input.assertions.flatMap((entry, index) => (entry.featureId === featureId ? [index] : []))
  const missingCapture = diagnostic?.kind === "collector-error" && diagnostic.name === "FrameUnavailable"
  const status = missingCapture
    ? "test-todo"
    : diagnostic || observation?.outcome === "error"
      ? "test-failure"
      : observation?.outcome === "supported" || observation?.outcome === "unsupported"
        ? observation.outcome
        : coverage
          ? "test-todo"
          : "test-failure"
  const diagnosticReason = diagnostic?.kind === "collector-error" ? diagnostic.message : diagnostic?.note
  // A reason the writer supplied outranks the writer default, which fires only when nothing else names the cause.
  // The generic observation word names nothing: a recorded test's own sentence reaches the row through
  // finalizeProbeResult instead (@cto 32ad122f; #32058, #32060).
  const writerDefault = !input.tests && !diagnostic && !coverage && observation?.outcome === "inconclusive"
  const genericYieldsToTests =
    input.tests !== undefined &&
    !diagnostic &&
    observation?.outcome === "inconclusive" &&
    observation.reason === "insufficient-evidence"
  const reason =
    diagnosticReason ??
    observation?.note ??
    coverage?.noObservable ??
    (writerDefault
      ? "writer default: inconclusive observation without test rows; callback defect"
      : genericYieldsToTests
        ? undefined
        : observation?.reason)
  const rawReplyRef = observation?.rawReplyRef ?? coverage?.rawReplyRef ?? input.rawReplyRef
  return finalizeProbeResult({
    featureId,
    attempt,
    tests:
      input.tests && !diagnostic && observation?.outcome !== "error"
        ? input.tests.map((test) => {
            if (!test.id || !PROBE_STATUSES.includes(test.status)) {
              throw new Error(`Invalid callback test for ${featureId}`)
            }
            const refs =
              test.assertionRefs === undefined
                ? test.status === "test-todo"
                  ? []
                  : assertionRefs
                : test.assertionRefs.map((index) => {
                    const globalIndex = assertionRefs[index]
                    if (globalIndex === undefined) {
                      throw new Error(`Callback test ${featureId}/${test.id} names an absent assertion`)
                    }
                    return globalIndex
                  })
            return {
              id: test.id,
              status: test.status,
              attempt: test.status === "test-todo" ? { scope: "none" } : attempt,
              assertionRefs: refs,
              ...(rawReplyRef && { rawReplyRef }),
              ...(test.reason && { reason: test.reason }),
            }
          })
        : [
            {
              id: "criterion",
              status,
              attempt: status === "test-todo" ? { scope: "none" } : attempt,
              assertionRefs,
              ...(rawReplyRef && { rawReplyRef }),
              ...(reason && { reason }),
            },
          ],
    ...(input.criterionBranch && { criterionBranch: input.criterionBranch }),
    ...(observation?.assertionType && { assertionType: observation.assertionType }),
    ...(rawReplyRef && { rawReplyRef }),
    ...(observation?.frames && { frames: observation.frames }),
    ...(observation?.screenshotRef && { screenshotRef: observation.screenshotRef }),
    ...(observation?.host && { host: observation.host }),
    ...(reason && { reason }),
  })
}

/** The execution owner records an aborted collection against affected unfinished features. */
export function recordCollectionFailure(
  draft: RunDraft,
  startedAt: string,
  diagnostic: string,
  delegatedIds: readonly string[],
): void {
  const delegated = new Set(delegatedIds)
  const diagnosticRef = "collector.failure"
  draft.rawReplies[diagnosticRef] = diagnostic
  const attempt = { scope: "collection" as const, startedAt, diagnosticRef }
  draft.results = draft.results.map((result) =>
    result.status === "test-todo" && delegated.has(result.featureId)
      ? finalizeProbeResult({
          ...result,
          attempt,
          reason: diagnostic,
          tests: [
            ...result.tests.filter((test) => test.id !== "collection"),
            { id: "collection", status: "test-failure", attempt, reason: diagnostic },
          ],
        })
      : result,
  )
}

/** The source citation for the loaded engine, or undefined when the exact source is not audited. */
function modeSourceKey(identity: HeadlessRuntimeIdentity | undefined): string | undefined {
  if (identity === undefined || !("resolvedPath" in identity)) return undefined
  const integrity = identity.integrity
  if (integrity.kind !== "source" || !integrity.cleanTree) return undefined
  return `${integrity.repository}@${integrity.revision}:${integrity.treeOid}:${identity.resolvedPath}`
}

// CTO c6b2d1e7 (#32099): rejected DECRQM does not prove its mode absent.
// Each complete dispatcher below establishes own-command absence at one exact source identity.
const MODE_COMMAND_SOURCE_AUDITS = new Map([
  [
    "git@github.com:beorn/vterm.git@9e99e4d23cdc606fca258b1863aa2be7ae79eed3:b941dae48b25ae8825c394750bda5245c9d93dfa:vendor/vterm/packages/vt100/src/index.ts",
    {
      engine: "vt100" as const,
      modes:
        "packages/vt100/src/screen.ts:524-690 complete input dispatcher; :360-391 DECSET/DECRST h/l complete cases 1,5,6,7,25,66",
      stack:
        "packages/vt100/src/screen.ts:638-654 intermediate-drop dispatcher; :251-358 complete handleCSI has no finals {,},P,Q; no fallback mutation",
    },
  ],
  [
    "git@github.com:beorn/vterm.git@9e99e4d23cdc606fca258b1863aa2be7ae79eed3:4205f8936ad1848d1029729f3ada888cd61759a8:vendor/vterm/packages/vt220/src/index.ts",
    {
      engine: "vt220" as const,
      modes:
        "packages/vt220/src/screen.ts:720-906 complete input dispatcher; :444-489 DECSET/DECRST h/l complete cases 1,5,6,7,25,66",
      stack:
        "packages/vt220/src/screen.ts:834-861 complete CSI dispatcher; :430-442 complete intermediate dispatcher accepts only !p and >c, no #{,#},#P,#Q or fallback mutation",
    },
  ],
])

const ABSENT_MODE_COMMANDS: Readonly<Record<string, number | readonly string[]>> = {
  "input.pixel-mouse": 1016,
  "input.urxvt-mouse": 1015,
  "input.x10-mouse": 9,
  "input.button-event-mouse": 1002,
  "input.xtest-click": 1000,
  "input.xtest-wheel": 1000,
  "modes.bracketed-paste": 2004,
  "modes.focus-tracking": 1004,
  "modes.mouse-all": 1003,
  "modes.mouse-sgr": 1006,
  "modes.mouse-tracking": 1000,
  "modes.utf8-mouse-1005": 1005,
  "modes.alt-scroll-1007": 1007,
  "modes.synchronized-output": 2026,
  "modes.color-scheme-reporting": 2031,
  "modes.xtpushsgr": ["\x1b[#{", "\x1b[#}"],
  "modes.xtpopsgr": ["\x1b[#{", "\x1b[#}"],
  "modes.xtpushcolors": ["\x1b[#P", "\x1b[#Q"],
  "modes.xtpopcolors": ["\x1b[#P", "\x1b[#Q"],
}

/** Preserve actual deciding replies; source negatives require the own command between measured Xs. */
function withModeSourceReview(definition: ProbeDefinition): ProbeDefinition {
  const command = ABSENT_MODE_COMMANDS[definition.id]
  const heldMode =
    definition.id === "modes.application-cursor" ? 1 : definition.id === "modes.reverse-video" ? 5 : undefined
  const original = definition.lib
  if (!original || (command === undefined && heldMode === undefined)) return definition
  return {
    ...definition,
    // Existing dynamic declaration: this arm may observe query_reply OR source-reviewed buffer_state.
    libAssertionType: undefined,
    lib(ctx) {
      const prior = original(ctx)
      if (
        prior.observation?.assertionType === "query_reply" ||
        prior.observation?.outcome === "supported" ||
        prior.observation?.outcome === "unsupported"
      ) {
        return prior
      }
      const identity = ctx.runtimeIdentity
      const key = modeSourceKey(identity)
      const audit = key === undefined ? undefined : MODE_COMMAND_SOURCE_AUDITS.get(key)
      const fallback = (reason: string, state: object = {}): ProbeCallbackResult => {
        const noObservable = `${prior.notTested?.noObservable ?? "Mode deciding observable unavailable"}; ${reason}`
        const result = reviewResult(
          prior.criterionBranch ?? HEADLESS_OBSERVABLE_REVIEW,
          `${prior.tests?.[0]?.reason ?? "Mode review required"}; ${reason}`,
          noObservable,
          { priorResponse: prior.response, ...state },
        )
        // Stack priors can have no test rows. Always emit the named TODO, retaining the original raw state.
        return Object.keys(state).length === 0 && prior.response !== undefined
          ? { ...result, response: prior.response }
          : result
      }
      if (!audit) {
        // Other loaded engines retain their original callback. Missing/changed source never gains an assertion.
        if (!identity) return prior
        if (!("resolvedPath" in identity)) return prior
        const integrity = identity.integrity
        const knownTree =
          integrity.kind === "source" &&
          ["b941dae48b25ae8825c394750bda5245c9d93dfa", "4205f8936ad1848d1029729f3ada888cd61759a8"].includes(
            integrity.treeOid,
          )
        if (!knownTree && !/(?:vt100|vt220)/.test(identity.resolvedPath)) return prior
        if (integrity.kind === "source" && !integrity.cleanTree) return fallback("Mode source identity is dirty")
        const sameSource =
          integrity.kind === "source" &&
          [...MODE_COMMAND_SOURCE_AUDITS.keys()].some((entry) =>
            entry.startsWith(`${integrity.repository}@${integrity.revision}:${integrity.treeOid}:`),
          )
        return fallback(
          sameSource
            ? `Mode source entry moved: ${identity.resolvedPath}`
            : `Mode source identity has foreign source: ${key ?? identity.resolvedPath}`,
        )
      }
      if (identity?.engineVersion !== "0.10.1") {
        return fallback(`Mode source engine version differs: ${identity?.engineVersion}; expected 0.10.1`)
      }
      if (!auditedAdapterSources(identity, audit.engine)) {
        return fallback("Mode source adapter source differs from the audited blobs; no qualified readback")
      }
      if (heldMode !== undefined) {
        if (heldMode !== 1 && audit.engine !== "vt100") return prior
        return fallback(
          `Held mode ${heldMode}: own DECSET/DECRST case stores state; adapter tool gap TEST TODO, no deciding mode observable`,
        )
      }
      if (command === undefined) return prior
      const commands = typeof command === "number" ? [`\x1b[?${command}h`, `\x1b[?${command}l`] : command
      const expected = `${definition.id} implements its own ${typeof command === "number" ? `DECSET/DECRST mode ${command}` : commands.join(" / ")} commands`
      const citation = `${key}; ${typeof command === "number" ? audit.modes : audit.stack}; absent own command ${typeof command === "number" ? command : JSON.stringify(commands)}; discriminator 27f3120a`
      const state = { commands, priorResponse: prior.response, citation }
      if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 4) {
        return fallback("Mode control geometry unavailable: fewer than four columns", state)
      }
      ctx.feed("\x1b[2J\x1b[1;1H")
      ctx.feed("X")
      for (const bytes of commands) ctx.feed(bytes)
      ctx.feed("X")
      const position = ctx.getCursor()
      if (position.y !== 0) {
        return fallback("Mode X control moved line; source negative unavailable", { ...state, position })
      }
      if (!Number.isSafeInteger(position.x) || position.x < 2 || position.x >= ctx.cols) {
        return fallback("Mode X control position missing or outside measured line", { ...state, position })
      }
      const line = Array.from({ length: position.x }, (_, col) => ctx.getCell(0, col).char).join("")
      if (!line.startsWith("X") || !line.endsWith("X")) {
        return fallback("Mode control missing first or last rendered X", { ...state, line, position })
      }
      const control = line === "XX" ? "consumed-without-effect" : "leaked-as-text"
      const reason = `${citation}; own commands ${control}: ${JSON.stringify(line)} between rendered X marks`
      return parserStateResult(false, expected, { ...state, line, position, control }, reason, reason)
    },
  }
}

export { modeSourceKey, withModeSourceReview }
