import { PROBE_STATUSES } from "./types.ts"
import { createHash } from "node:crypto"
import type { NotTestedCoverageResult, ProbeTestInput } from "./types.ts"
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
  ObservationFrame,
  ProbeDefinition,
  ProbeCallbackResult,
  ExecutionOnlyProbeCallbackResult,
  TerminalQueryOutcome,
  LibProbeSource,
  TermProbeSource,
  UnhandledSequence,
} from "./types.ts"
import { evidenceRuntimeIdentity } from "./runtime-identity.ts"

/** Translate a screen row into the absolute buffer retained by the library source. */
export function activeScreenRow(ctx: LibProbeSource, row: number): number {
  const { totalLines, screenLines } = ctx.getScrollback()
  return Math.max(0, totalLines - screenLines) + row
}

export const ADAPTER_SOURCE_AUDITS = {
  ghosttyNativeH4: {
    "packages/ghostty-native/src/index.ts": "35c9e35a5d60625ce1135b65ff38ae9278495a18",
    "packages/ghostty-native/src/backend.ts": "d15e83634be3aa1bf2df9b58eb2f6376af800808",
  },
  kittyH4: {
    "packages/kitty/src/index.ts": "3f207f911646613cdc3d8b04f155f0686a96a077",
    "packages/kitty/src/backend.ts": "4cfc0a1707e4c92211c501cd27d8e1944ebe66db",
    "packages/kitty/build/bridge.py": "c78e427917d4e22453414db76c4d52509cc8b82f",
    "packages/kitty/build/layout.c": "f58c0e943ad60daf20d54360184e039e16ff3826",
    "packages/kitty/build/native-mode-layout.json": "20b976ba87de032248a787fcb8b5adc64c640f07",
    "packages/kitty/build/native-mode-layout.receipt.json": "1e1e450aa08538ffb2d7ba80d45015aae4d86921",
  },
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
  libvterm: {
    "packages/libvterm/src/index.ts": "2b4708b1081e701b99893ca055ded781dc46cf25",
    "packages/libvterm/src/backend.ts": "eb513ccd443e30c7a869a8ba41f8126e1c0ddf00",
    "packages/libvterm/src/wasm-bindings.ts": "2bbd4d5cf59b8d53db8f5c0329d2ed7853c43e45",
    "packages/libvterm/wasm/libvterm.js": "1e784be87614ab924b96844009919b7c21ce150e",
  },
  libvterm3b7c0232: {
    "packages/libvterm/src/index.ts": "2b4708b1081e701b99893ca055ded781dc46cf25",
    "packages/libvterm/src/backend.ts": "d6db3f41fb255cbb3822238432ad3c535757c697",
    "packages/libvterm/src/wasm-bindings.ts": "9ff9e59c30efe03ca0ee6ec18faf9521d045323b",
    "packages/libvterm/wasm/libvterm.js": "a57d8193c36702e3d9f72e446a0677f5d0e83e2a",
  },
  libvterm712298af: {
    "packages/libvterm/src/index.ts": "2b4708b1081e701b99893ca055ded781dc46cf25",
    "packages/libvterm/src/backend.ts": "f0431b2b3b1824d3028e7a039d55278d2cddc0e8",
    "packages/libvterm/src/wasm-bindings.ts": "55ddc684464e525e63cd523d2d6a638c4c6dbcd9",
    "packages/libvterm/wasm/libvterm.js": "d28bc97333d33129c7c9764a331a3d47f088f7b3",
  },
  libvtermR1: {
    "packages/libvterm/src/index.ts": "2b4708b1081e701b99893ca055ded781dc46cf25",
    "packages/libvterm/src/backend.ts": "fff111feabbcf729b6a071c33db2365b55706e7f",
    "packages/libvterm/src/wasm-bindings.ts": "8ddc939fc0e79737b59181a6b110c63e3fde63f1",
    "packages/libvterm/wasm/libvterm.js": "35ae07fbdb0fc67ee1a73477fe53ea6cff89a985",
    "src/terminal/key-mapping.ts": "a687ff18768ae42b315f689122bcef07244b036e",
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
  // Current Term/EventProxy/Processor cohort audited for OSC 7 and OSC 9 interface absence.
  alacritty23b6874c: {
    "packages/alacritty/src/index.ts": "b4154cbd6ef4a83ce2cbf3dcf26ff13d645efd05",
    "packages/alacritty/src/backend.ts": "fb86b6283d4ecaac4b97223bd6c9856c60aa7bbc",
    "packages/alacritty/native/src/lib.rs": "23b6874c921b03ab2ae99bfec61cd9f00b8cb5a8",
    "src/load-native.ts": "34e142550085450ab02138184626716ad0d6b546",
  },
  alacritty0110: {
    "packages/alacritty/src/index.ts": "b4154cbd6ef4a83ce2cbf3dcf26ff13d645efd05",
    "packages/alacritty/src/backend.ts": "9ee6e4044b2a084b7181552362b7ee76f234dc14",
    "packages/alacritty/native/src/lib.rs": "23b6874c921b03ab2ae99bfec61cd9f00b8cb5a8",
    "src/load-native.ts": "34e142550085450ab02138184626716ad0d6b546",
  },
  wezterm: {
    "packages/wezterm/src/index.ts": "512606c5270ffd0cff55c1b70f5b3eda18a92df0",
    "packages/wezterm/src/backend.ts": "4b376877280d09535bc67a6f99fc5d68b40529e3",
    "packages/wezterm/native/src/lib.rs": "69a9d1ebc4fd86d46c131a378a9d897cdd6824b3",
    "src/load-native.ts": "34e142550085450ab02138184626716ad0d6b546",
  },
  wezterm0110: {
    "packages/wezterm/src/index.ts": "512606c5270ffd0cff55c1b70f5b3eda18a92df0",
    "packages/wezterm/src/backend.ts": "e7b9d32395b3209ef48247c2e3d7f7f21cbd10a6",
    "packages/wezterm/native/src/lib.rs": "69a9d1ebc4fd86d46c131a378a9d897cdd6824b3",
    "src/load-native.ts": "34e142550085450ab02138184626716ad0d6b546",
  },
  vt100Rust: {
    "packages/vt100-rust/src/index.ts": "3ddb74f3ae1f79bb356952103853232f69211268",
    // Mouse-state binding (termless 286fddf6, #31295) changes the backend blob; parser and callbacks are unchanged.
    "packages/vt100-rust/src/backend.ts": "9b3477c0fedf8586430781e8f4d17019569af98b",
  },
  vt100RustDdabecd4: {
    "packages/vt100-rust/src/index.ts": "3ddb74f3ae1f79bb356952103853232f69211268",
    "packages/vt100-rust/src/backend.ts": "ddabecd4881be4f6b63f1c35f9c2265b53d35df4",
  },
  kitty: {
    "packages/kitty/src/index.ts": "3f207f911646613cdc3d8b04f155f0686a96a077",
    "packages/kitty/src/backend.ts": "88dd0f299e059457946b92edfc6eb324ac3c7e30",
    "packages/kitty/build/bridge.py": "95a46fee6da18621bf9293f5acddc18ff357d349",
    "packages/kitty/build/layout.c": "f58c0e943ad60daf20d54360184e039e16ff3826",
    "packages/kitty/build/native-mode-layout.json": "20b976ba87de032248a787fcb8b5adc64c640f07",
    "packages/kitty/build/native-mode-layout.receipt.json": "1e1e450aa08538ffb2d7ba80d45015aae4d86921",
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
export function decideStackOperation(
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
 * record (PROBE TODO, the review the ruling names), never a PROBE INVALID: nothing in the harness
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
    tests: [{ id: "criterion", status: "probe-invalid", reason }],
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
    if (!result.tests?.some((test) => test.id === id && test.status === "probe-invalid")) {
      throw new Error(
        `Callback ${featureId} reply marker ${id} must name a probe-invalid test; fix the callback builder use`,
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
      marked.has(test.id) && test.status === "probe-invalid" ? { ...test, reason: `${test.reason}; ${detail}` } : test,
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
      result.status === "probe-todo" &&
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

/** The one reason text a library's own unhandled report may print (@cto 2026-11-05 07:25 appendix, condition 6). */
export const UNHANDLED_SEQUENCE_REASON = "library reported this sequence as unhandled"

/** The handled OSC 2 the report's control uses; its title reader proves the library acted on it. */
export const UNHANDLED_OSC_CONTROL_TITLE = "terminfo-unhandled-report-control"

/**
 * True when a library result already carries a decided outcome. Only an undecided result may be
 * replaced by the unhandled report, so no Supported or Unsupported answer changes because of it
 * (@cto 2026-11-05 07:25 appendix, condition 5). A pass without an observation counts as decided.
 */
export function reportsDecidedOutcome(result: ProbeCallbackResult): boolean {
  const outcome = result.observation?.outcome
  return result.pass === true || outcome === "supported" || outcome === "unsupported" || outcome === "error"
}

/**
 * Case 1 consumer (@cto 2026-11-05 07:25 appendix): a library's own unhandled report decides a STATE cell
 * Unsupported only when the same run proves both controls on the same reader — a handled sequence adds no
 * entry and its own reader shows it applied, then the target adds its exact code or approved ordered list.
 * Anything else returns undefined, so the calling probe keeps its undecided branch; a source without the
 * member never reaches here, which keeps today's exact path (missing evidence, never a negative).
 *
 * Case 2 fallback (@cto 09:00 plan ruling R1): an engine that handles no OSC can never qualify the handled
 * OSC 2 control, so its own report could never decide an OSC cell. `fallback` may qualify an OSC target
 * with a handled non-OSC sequence — SGR 1 and bold — only in the same run that shows the OSC 2 control
 * added exactly one entry carrying `fallback.proves` while the title stayed unapplied: the engine reports
 * the OSC path and handles none of it. The fallback then reads its own baseline, so the control's entry is
 * never counted against the target's exact delta. A Case 1 engine whose title read answered never
 * reaches it, and every report length is compared exactly, so a bounded history that rolled decides
 * nothing rather than a wrong grade.
 */
export function unhandledSequenceVerdict(
  ctx: LibProbeSource,
  target: { readonly feed: string } & (
    | { readonly code: UnhandledSequence; readonly codes?: never }
    | { readonly codes: readonly UnhandledSequence[]; readonly code?: never }
  ),
  control: {
    readonly feed: string
    readonly applied: () => boolean
    readonly cleanup?: string
  },
  evidence: object,
  fallback?: {
    readonly proves: UnhandledSequence
    /** Called only when the primary control's own entry proves the engine handles none of this path. */
    readonly arm: () => { readonly feed: string; readonly applied: () => boolean; readonly cleanup?: string }
  },
): ProbeCallbackResult | undefined {
  const codes = target.code !== undefined ? [target.code] : target.codes
  const first = codes[0]
  if (first === undefined) return undefined
  const read = ctx.getUnhandledSequences?.bind(ctx)
  if (!read) return undefined
  const before = read()
  ctx.feed(control.feed)
  const afterControl = read()
  const controlApplied = control.applied()
  if (control.cleanup !== undefined) ctx.feed(control.cleanup)
  let qualifying: { readonly feed: string; readonly baseline: readonly UnhandledSequence[] } | undefined
  if (afterControl.length === before.length && controlApplied) {
    qualifying = { feed: control.feed, baseline: afterControl }
  } else if (
    fallback !== undefined &&
    first.kind === "osc" &&
    !controlApplied &&
    afterControl.length === before.length + 1
  ) {
    const proved = afterControl[before.length]
    if (proved !== undefined && proved.kind === fallback.proves.kind && proved.code === fallback.proves.code) {
      const fallbackControl = fallback.arm()
      const baseline = read()
      ctx.feed(fallbackControl.feed)
      const afterFallback = read()
      const fallbackHeld = afterFallback.length === baseline.length && fallbackControl.applied()
      if (fallbackControl.cleanup !== undefined) ctx.feed(fallbackControl.cleanup)
      if (fallbackHeld) qualifying = { feed: fallbackControl.feed, baseline: afterFallback }
    }
  }
  if (qualifying === undefined) return undefined
  ctx.feed(target.feed)
  const afterTarget = read()
  const added =
    afterTarget.length === qualifying.baseline.length + codes.length
      ? afterTarget.slice(qualifying.baseline.length)
      : []
  if (
    added.length !== codes.length ||
    codes.some((code, index) => {
      const actual = added[index]
      return actual === undefined || actual.kind !== code.kind || actual.code !== code.code
    })
  ) {
    return undefined
  }
  const label = codes
    .map((code) => `${code.kind === "osc" ? "OSC" : code.code.endsWith("m") ? "SGR" : "CSI"} ${code.code}`)
    .join(", ")
  return parserStateResult(
    false,
    `${label}: the library's own report carries this exact code, with both same-run controls qualified`,
    { evidence, unhandled: { control: qualifying.feed, target: target.code ?? target.codes, added } },
    UNHANDLED_SEQUENCE_REASON,
  )
}

/**
 * Two captures of the same screen can carry different `ref`s — that id names the encoded container,
 * whose text chunks differ between identical frames — while their pixels agree. `pixelsDigest` is the
 * pixel truth (29580); `ref` stays the fallback for frames that name no digest.
 */
export function sameFrame(left: ObservationFrame, right: ObservationFrame): boolean {
  if (left.pixelsDigest !== undefined && right.pixelsDigest !== undefined) {
    return left.pixelsDigest === right.pixelsDigest
  }
  return left.ref === right.ref
}

/** Channel-exact equality of two reported cell colors. */
export function sameRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

/**
 * The probe ran and retained raw state, but this environment exposes no applicable observable for
 * the claim. This is a coverage/applicability record, never a fifth measurement outcome.
 */
export function notTestedResult(noObservable: string, state: object): NotTestedCoverageResult {
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
 * control in this run showed the same observation path can report the state, so the cell stays PROBE TODO (rule 4).
 * Source code never decides it; a probe owner adds the same-path control per feature.
 */
export const NO_SAME_PATH_CONTROL =
  "Open: no control in this run showed that our test can read this feature, so the observations do not decide the result."

/**
 * A criterion this context has no observable for: the same coverage record and raw state as
 * notTestedResult, with the explicit branch naming its PROBE TODO row. The position stays
 * PROBE TODO with its named cause; nothing here grades support, delivery or
 * Untestable.
 */
export function reviewResult(branch: string, reason: string, noObservable: string, state: object): ProbeCallbackResult {
  return {
    ...notTestedResult(noObservable, state),
    criterionBranch: branch,
    tests: [{ id: "review", status: "probe-todo", reason }],
  }
}

/**
 * The headless arm of a criterion that needs OS-level input. An app context without an input
 * adapter keeps its plain coverage record.
 */
export function osInputReviewResult(
  noObservable: string,
  state: object,
  reason = "Library probe source injects no OS-level input, so this run cannot decide it",
): ProbeCallbackResult {
  return reviewResult("os-input-review", reason, noObservable, state)
}

/**
 * A headless colour criterion missing its initial readback. Reset/stack probes send no mutation
 * when that prerequisite is absent (#30547, @cto D-B). Initial-query probes require a disposable
 * set/query/reset control before selecting this branch. Never a sentinel negative (C10) and never
 * graded from a source read (C7); the caller names the missing observable.
 */
export function colorReadbackReviewResult(noObservable: string, state: object): ProbeCallbackResult {
  return reviewResult("color-readback-review", `${noObservable}, so this run cannot decide it`, noObservable, state)
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
        status: "probe-todo",
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
          status: "probe-todo",
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
    return { pass: false, response, tests: [{ id: "criterion", status: "probe-invalid", reason }] }
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
 * Read the terminal's SGR report, using the supplied owned visual oracle for valid nonvisual
 * results. Malformed replies and failed prerequisites retain failure. Silence returns null for
 * the caller's existing evidence path; missing readback is never a negative.
 */
export async function sgrReadbackDecision(
  ctx: TermProbeSource,
  id: string,
  sequence: string,
  readback: SgrReadback,
  setup?: { sequence: string; baseline: SgrReadback; readback: SgrReadback },
  independentCapture?: () => Promise<ProbeCallbackResult | null>,
): Promise<ProbeCallbackResult | null> {
  const observed: Record<string, string> = {}
  const captureReadback = async (reply: Record<string, string>, phase: "setup" | "visual") => {
    const captured = await independentCapture?.()
    if (!captured) return null
    const instrument =
      phase === "setup"
        ? `${id}: the independent capture oracle supplies this result because the terminal's SGR report did not establish setup`
        : `${id}: the independent capture oracle supplies the visual result`
    const retainedNote = `${instrument}; DECRQSS ${JSON.stringify(reply)}`
    const note = captured.note ? `${captured.note}; ${retainedNote}` : retainedNote
    const retained = { response: JSON.stringify({ ...reply, capture: captured.response }), note }
    if (captured.observation) {
      return {
        ...captured,
        ...retained,
        observation: {
          ...captured.observation,
          note: captured.observation.note ? `${captured.observation.note}; ${retainedNote}` : retainedNote,
        },
      }
    }
    return { ...captured, ...retained }
  }
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
            independentCapture
          ) {
            const captured = await captureReadback(observed, "setup")
            if (captured) return captured
          }
          const note = `${id}: ${phase} prerequisite was not established${qualified.note ? `: ${qualified.note}` : ""}`
          if (qualified.notTested) {
            return {
              ...qualified,
              notTested: { ...qualified.notTested, noObservable: note },
              response: JSON.stringify({ phase, ...observed }),
              note,
            }
          }
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
    const evaluated = evaluateSgrReadback(id, sequence, state, readback, setup !== undefined)
    const reply = { sgr: state.length === 0 ? "0" : state.join(";"), ...observed }
    const result = setup ? { ...evaluated, response: JSON.stringify(reply) } : evaluated
    // Invalid replies keep their failure; valid state reports do not decide a visual claim.
    if (
      ctx.capture &&
      independentCapture &&
      (result.notTested || result.observation?.outcome === "supported" || result.observation?.outcome === "unsupported")
    ) {
      const captured = await captureReadback(reply, "visual")
      if (captured) return captured
    }
    return result
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
      { id: "criterion", status: "probe-todo", reason: `SGR fixture needs at least 1x2, measured ${rows}x${cols}` },
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
        status: "probe-todo",
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
  note = "Control and target pixels captured; no same-run pixel check decides the visual effect",
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
      {
        id: "review",
        status: "probe-todo",
        reason: "Valid control and target capture; no same-run pixel check decides it",
      },
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

// Diagnostic prerequisites only: these checked public types do not expose the null attribute.
// A matching runtime version binds the audit; this table never decides a support result (#32329).
const SGR_ATTRIBUTE_READER_ABSENCE: Readonly<Record<string, string>> = {
  "vt100:0.10.1:dim": "vt100.js 0.10.1 public ScreenCell has no dim field",
  "vt100:0.10.1:italic": "vt100.js 0.10.1 public ScreenCell has no italic field",
  "vt100:0.10.1:strikethrough": "vt100.js 0.10.1 public ScreenCell has no strikethrough field",
  "vt220:0.10.1:dim": "vt220.js 0.10.1 public ScreenCell has no dim field",
  "vt220:0.10.1:italic": "vt220.js 0.10.1 public ScreenCell has no italic field",
  "vt220:0.10.1:strikethrough": "vt220.js 0.10.1 public ScreenCell has no strikethrough field",
  "alacritty:0.26.0:blink": "alacritty_terminal 0.26.0 public term::cell::Flags has no blink flag",
  "vt100-rust:0.16.2:blink": "vt100 0.16.2 public Cell has no blink reader",
  "vt100-rust:0.16.2:strikethrough": "vt100 0.16.2 public Cell has no strikethrough reader",
}

/**
 * The only SGR cells a library's own unhandled report may move (@cto 2026-11-05 07:25 appendix and
 * 07:38 addendum, Case 1; faint and italic added by the 09:00 Case 2 ruling R2): blink, faint, italic,
 * strikethrough and the four underline styles. Every other SGR cell keeps its own reader's path, so no
 * unnamed row can move.
 */
const UNHANDLED_CSI_CELLS: ReadonlySet<string> = new Set([
  "sgr.blink",
  "sgr.faint",
  "sgr.italic",
  "sgr.strikethrough",
  "sgr.underline.double",
  "sgr.underline.curly",
  "sgr.underline.dotted",
  "sgr.underline.dashed",
])

/**
 * The CSI arm's control (@cto 2026-11-05 07:37 status): SGR 1 must add no report entry while the same
 * cell reader shows bold applied, then the target must add exactly one entry carrying the code its own
 * sequence produces ("5m", "9m", "21m", "4:3m", "4:4m", "4:5m"). Anything else keeps the body's result.
 * sgr.underline-color-reset calls it directly for "59m" (@cto routes-32 section 1, 23:02 PST Nov 5 2026).
 */
export function withUnhandledSgrReport(
  id: string,
  sequence: string,
  body: (ctx: LibProbeSource) => ProbeCallbackResult,
): (ctx: LibProbeSource) => ProbeCallbackResult {
  return (ctx) => {
    const result = body(ctx)
    if (reportsDecidedOutcome(result)) return result
    const cursor = ctx.getCursor()
    return (
      unhandledSequenceVerdict(
        ctx,
        { feed: sequence, code: { kind: "csi", code: sequence.slice(2) } },
        {
          feed: "\x1b[0m\x1b[1mC",
          applied: () => ctx.getCell(cursor.y, cursor.x).bold === true,
          cleanup: "\x1b[0m",
        },
        { sequence, ...(result.response !== undefined && { body: result.response }) },
      ) ?? result
    )
  }
}

export function sgrProbe(
  id: string,
  sequence: string,
  check: (cell: ReturnType<LibProbeSource["getCell"]>) => boolean | null,
  noObservableWhen?: (cell: ReturnType<LibProbeSource["getCell"]>) => string | null,
  readback?: SgrReadback,
  sourceReviewReason?: string,
  capture?: SgrCapture,
): ProbeDefinition {
  const definition: ProbeDefinition = {
    id,
    termNeedsGeometry: true,
    termAssertionType: readback ? "query_reply" : null,
    lib(ctx) {
      const targetInput = sequence + "X"
      ctx.feed(targetInput)
      const cell = ctx.getCell(0, 0)
      if (cell.char === "X") {
        const noObservable = noObservableWhen?.(cell)
        if (noObservable) return notTestedResult(noObservable, cell)
      }
      const measured = cell.char === "X" && check(cell) === true
      if (sourceReviewReason !== undefined && cell.char === "X") {
        const underline = id.startsWith("sgr.underline.")
        const controlInput = `\x1b[0m${underline ? "\x1b[4m" : "\x1b[1m"}C\x1b[0m`
        ctx.feed(controlInput)
        const control = ctx.getCell(0, 1)
        const state = { ...cell, control, input: { target: targetInput, control: controlInput } }
        // A positive effect witnesses its own reader. A negative needs the same-run control,
        // and a nullable attribute is missing readback even when the control works (#32318).
        if (measured) return parserStateResult(true, `${id}: attribute applied to the rendered X cell`, state)
        if (check(cell) === null) {
          const field = id === "sgr.faint" ? "dim" : id.slice("sgr.".length)
          const prerequisite =
            SGR_ATTRIBUTE_READER_ABSENCE[`${ctx.backendName}:${ctx.runtimeIdentity?.engineVersion}:${field}`]
          const missingReader = `Open: our test could not read ${field} from the screen cells and found no qualified alternative in this run.${prerequisite ? ` ${prerequisite}.` : ""}`
          // The reply is used only after this same SGR m reader reports the bold control.
          // A facility-wide DECRQSS/DECSTBM answer does not qualify it (#32318).
          if (readback && ctx.queryWithSentinelOutcome) {
            const query = "\x1bP$qm\x1b\\"
            const pattern = /\x1bP1\$r([0-9;:]*)m\x1b\\/
            const readbackControlInput = "\x1b[0m\x1b[1m"
            ctx.feed(readbackControlInput)
            const controlReply = ctx.queryWithSentinelOutcome(query, pattern)
            const controlParameters = controlReply.match?.[1]
            if (
              controlParameters !== undefined &&
              sgrReadbackResult(id, "\x1b[1m", controlParameters.split(";"), { require: [1] }).observation?.outcome ===
                "supported"
            ) {
              const readbackTargetInput = `\x1b[0m${sequence}`
              ctx.feed(readbackTargetInput)
              const targetReply = ctx.queryWithSentinelOutcome(query, pattern)
              const targetParameters = targetReply.match?.[1]
              const evidence = {
                ...state,
                sgrReadback: {
                  controlInput: readbackControlInput,
                  targetInput: readbackTargetInput,
                  query,
                  control: controlReply.raw,
                  target: targetReply.raw,
                },
              }
              if (targetParameters !== undefined) {
                const result = evaluateSgrReadback(id, sequence, targetParameters.split(";"), readback, true)
                const response = JSON.stringify(evidence)
                result.response = response
                if (result.assertions) {
                  result.assertions = result.assertions.map((assertion) => ({ ...assertion, observed: response }))
                }
                return result
              }
              return notTestedResult(missingReader, evidence)
            }
            return notTestedResult(missingReader, {
              ...state,
              sgrReadback: { controlInput: readbackControlInput, query, control: controlReply.raw },
            })
          }
          return notTestedResult(missingReader, state)
        }
        const qualified = control.char === "C" && (underline ? control.underline === "single" : control.bold === true)
        if (!qualified) return notTestedResult(NO_SAME_PATH_CONTROL, state)
        if (underline) {
          // On/off readers normalize every enabled style to "single". A negative needs
          // another non-single style to read back as itself in this run (#32318).
          const style = id === "sgr.underline.double" ? "curly" : "double"
          const styleControlInput = `\x1b[0m\x1b[4:${style === "curly" ? 3 : 2}mD\x1b[0m`
          ctx.feed(styleControlInput)
          const styleControl = ctx.getCell(0, 2)
          const styleState = { ...state, styleControl, input: { ...state.input, styleControl: styleControlInput } }
          if (styleControl.char !== "D" || styleControl.underline !== style) {
            if (
              (id === "sgr.underline.curly" || id === "sgr.underline.dotted" || id === "sgr.underline.dashed") &&
              (ctx.backendName === "vt100" || ctx.backendName === "vt220") &&
              ctx.runtimeIdentity?.engineVersion === "0.13.1" &&
              cell.underline === false &&
              styleControl.char === "D" &&
              styleControl.underline === false
            ) {
              return parserStateResult(
                false,
                `${id}: the colon form left X plain with a qualified single underline control`,
                styleState,
                `${ctx.backendName} 0.13.1: ordinary SGR 4 sets the public underline flag; this colon form leaves it off and the cell has no style field`,
              )
            }
            return notTestedResult(
              style === "double" && styleControl.char === "D" && styleControl.underline === "single"
                ? "Open: our test tells underline styles apart by comparing with double underline, its control. On this library double underline read the same as plain underline, so this style cannot be judged yet."
                : `Open: our test compares underline styles with a ${style}-underline control, but that control did not read as ${style} underline, so this style cannot be judged yet.`,
              styleState,
            )
          }
          return parserStateResult(
            false,
            `${id}: attribute applied to the rendered X cell with qualified single and ${style} underline style readers`,
            styleState,
          )
        }
        return parserStateResult(
          false,
          `${id}: attribute applied to the rendered X cell with a qualified bold reader`,
          state,
        )
      }
      return parserStateResult(
        measured ? true : null,
        `${id}: attribute applied to the rendered X cell`,
        cell,
        cell.char !== "X"
          ? "No rendered X cell to evaluate"
          : measured || sourceReviewReason !== undefined
            ? undefined
            : "Cell readback cannot distinguish unsupported styling from unreported attributes or collapsed styles, so it cannot decide a negative",
        cell.char === "X" && !measured ? sourceReviewReason : undefined,
      )
    },
    async term(ctx) {
      const refusal = sgrPlainFixtureTooSmall(ctx)
      if (refusal) return refusal
      if (ctx.capture) {
        const refusal = sgrCaptureTooSmall(ctx, "SGR fixture")
        if (refusal) return refusal
      }
      const captureResult = async () => {
        if (!ctx.capture) return null
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
      if (readback) {
        const decided = await sgrReadbackDecision(
          ctx,
          id,
          sequence,
          readback,
          undefined,
          capture ? captureResult : undefined,
        )
        if (decided) return decided
      }
      const captured = await captureResult()
      if (captured) return captured
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
            status: "probe-todo",
            reason: `Cursor advance does not verify SGR styling${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
          },
        ],
      }
    },

    // A configured SGR readback may qualify the alternate reader when a cell field is absent.
    libAssertionType: {
      when: () => readback !== undefined,
      then: ["buffer_state", "query_reply"],
      otherwise: ["buffer_state"],
    },
  }
  const body = definition.lib
  return {
    ...definition,
    lib: body && UNHANDLED_CSI_CELLS.has(id) ? withUnhandledSgrReport(id, sequence, body) : body,
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
          tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
          tests: [{ id: "criterion", status: "probe-todo", reason: "no DECRPM reply" }],
        }
      }
      if (modeNum === 2026 && snapshot === 2 && ps === 2) {
        const reason =
          "synchronized-output set-state control unobservable: DECRPM reset reply after DECSET cannot establish enabled update; rendered effect unmeasured"
        return {
          pass: false,
          response,
          note: reason,
          tests: [{ id: "criterion", status: "probe-invalid", reason }],
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
 * graded by the same decrpmResult as the app arm, whenever the adapter delivers one.
 * Default callers retain getMode as context only. The six-mode requireReadback opt-in requires the
 * engine's set/reset reply pair and independently agreeing adapter reads; a binding gap stays TODO.
 * Only the eight stateReadback callers may use controlled public state or effect when that reply is absent.
 * The reply stays primary; the synchronized-output effect arm is scoped to Alacritty.
 */
export function headlessDecrpmArm(
  modeNum: number,
  modeName: string,
  options: { requireReadback?: true; stateReadback: true } | { requireReadback: true; stateReadback?: true },
): (ctx: LibProbeSource) => ProbeCallbackResult
export function headlessDecrpmArm(modeNum: number, modeName?: string): (ctx: LibProbeSource) => ProbeCallbackResult
export function headlessDecrpmArm(
  ...args:
    | [modeNum: number, modeName?: string]
    | [
        modeNum: number,
        modeName: string,
        options: { requireReadback?: true; stateReadback: true } | { requireReadback: true; stateReadback?: true },
      ]
): (ctx: LibProbeSource) => ProbeCallbackResult {
  const [modeNum, modeName] = args
  return (ctx) => {
    // Retain the existing reader's same-path DA1 control where the collector has proved delivery.
    // Transport responsiveness does not replace this criterion's own DECRPM reply.
    const capture = () =>
      ctx.queryWithSentinelOutcome?.(`\x1b[?${modeNum}$p`, decrpmReplyPattern(modeNum)).raw ??
      ctx.feedCapture(`\x1b[?${modeNum}$p`)
    if (args[2]?.requireReadback === true && modeName !== undefined) {
      // The strict overload requires a mode key; the name is display-only, never an engine selector.
      const key = modeName
      const insertBefore = modeNum === 4 ? ctx.getMode("insertMode") : undefined
      let resetSent = false
      try {
        ctx.feed(`\x1b[?${modeNum}h`)
        const insertAfter = modeNum === 4 ? ctx.getMode("insertMode") : undefined
        const setMode = ctx.getMode(key)
        const setReply = capture()
        ctx.feed(`\x1b[?${modeNum}l`)
        resetSent = true
        const resetMode = ctx.getMode(key)
        const resetReply = capture()
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
          if (args[2]?.stateReadback && (modeNum !== 2026 || ctx.backendName === "alacritty")) {
            return modeStateReadback(ctx, modeNum, key, state)
          }
          return osInputReviewResult(
            `DECRPM reply to CSI ? ${modeNum} $ p`,
            state,
            "Open: our test received no usable reply to the mode query (DECRPM), and this run has no qualified control for that reply, so it cannot tell whether the mode works.",
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
            tests: [{ id: "criterion", status: "probe-todo", reason }],
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
    const reply = capture()
    const state = modeName === undefined ? { reply } : { reply, mode }
    ctx.feed(`\x1b[?${modeNum}l`)
    const ps = decrpmPs(decrpmReplyPattern(modeNum).exec(reply)?.[1])
    if (ps === null) {
      if (args[2]?.stateReadback && modeName !== undefined) return modeStateReadback(ctx, modeNum, modeName, state)
      return osInputReviewResult(
        `DECRPM reply to CSI ? ${modeNum} $ p`,
        state,
        "Open: our test received no usable reply to the mode query (DECRPM), and this run has no qualified control for that reply, so it cannot tell whether the mode works.",
      )
    }
    return { ...decrpmResult(ps, modeNum), response: JSON.stringify(state) }
  }
}

/** The opted-in state criterion applies only after the existing DECRPM reader found no reply. */
function modeStateReadback(ctx: LibProbeSource, number: number, key: string, prior: object): ProbeCallbackResult {
  if (number === 2026 && ctx.backendName === "alacritty") {
    const expected = "synchronized output defers X until reset; ordinary and unknown-mode writes appear immediately"
    try {
      ctx.feed("\x1b[?2026l\x1b[1;1H\x1b[2KA")
      const ordinary = ctx.getCell(0, 0).char
      const initial = ctx.getCell(0, 1).char
      ctx.feed("\x1b[?2026hX")
      const during = ctx.getCell(0, 1).char
      ctx.feed("\x1b[?2026l")
      const after = ctx.getCell(0, 1).char
      ctx.feed("\x1b[?9999hY")
      const unknown = ctx.getCell(0, 2).char
      const qualified =
        ordinary === "A" && isBlank(initial) && after === "X" && unknown === "Y" && (isBlank(during) || during === "X")
      return parserStateResult(
        qualified ? isBlank(during) : null,
        expected,
        { prior, ordinary, initial, during, after, unknown },
        qualified
          ? "buffered effect measured; rendered tearing unmeasured"
          : "ordinary output, reset or unknown-mode control did not qualify",
      )
    } finally {
      ctx.feed("\x1b[?2026l")
    }
  }
  const otherKey =
    key === "applicationCursor"
      ? ctx.getMode("reverseVideo") === null
        ? "applicationKeypad"
        : "reverseVideo"
      : "applicationCursor"
  const otherBefore = ctx.getMode(otherKey)
  const encoding = number === 1005 || number === 1006
  const mouseBefore = encoding ? ctx.getMode("mouseTracking") : null
  const encoded: (number[] | null)[] = []
  const read = () => {
    if (!encoding) return ctx.getMode(key)
    const bytes = ctx.encodeMouse?.({ x: number === 1005 ? 95 : 1, y: 1, button: "left", action: "press" })
    encoded.push(bytes ? Array.from(bytes) : null)
    if (!bytes) return null
    const actual = Array.from(bytes).join(",")
    const enabled = number === 1005 ? "27,91,77,32,194,128,34" : "27,91,60,48,59,50,59,50,77"
    const disabled = number === 1005 ? "27,91,77,32,128,34" : "27,91,77,32,34,34"
    return actual === enabled ? true : actual === disabled ? false : null
  }
  try {
    if (encoding) ctx.feed("\x1b[?1000h")
    ctx.feed(`\x1b[?${number}l`)
    const initial = read()
    ctx.feed(`\x1b[?${number}h`)
    const set = read()
    const otherSet = ctx.getMode(otherKey)
    ctx.feed(`\x1b[?${number}l`)
    const reset = read()
    const otherReset = ctx.getMode(otherKey)
    ctx.feed("\x1b[?9999h")
    const unknown = read()
    const otherUnknown = ctx.getMode(otherKey)
    const state = {
      prior,
      initial,
      set,
      reset,
      unknown,
      otherKey,
      otherBefore,
      otherSet,
      otherReset,
      otherUnknown,
      ...(encoding && { encoded }),
    }
    const qualified =
      initial === false &&
      set === true &&
      reset === false &&
      unknown === false &&
      otherBefore !== null &&
      otherSet === otherBefore &&
      otherReset === otherBefore &&
      otherUnknown === otherBefore
    const facet = number === 1 ? "key encoding unmeasured" : "presentation unmeasured"
    const label = key === "applicationCursor" ? "cursor-keys" : key === "reverseVideo" ? "reverse-video" : key
    const note = qualified
      ? `${key} state measured; ${facet}`
      : initial !== false || set !== true || reset !== false || unknown !== false
        ? `Open: setting and resetting ${label} mode did not give the expected readings.`
        : otherBefore === null || otherSet === null || otherReset === null || otherUnknown === null
          ? key === "applicationCursor"
            ? "Open: cursor-keys mode set and reset as expected, but our adapter returns no on/off state for reverse video on this library, and reverse video is the second mode we use to show the two modes are independent."
            : `Open: ${label} mode set and reset as expected, but the second mode we use to show they are independent cannot be read here.`
          : `Open: the second mode changed while we set or reset ${label} mode, so this test cannot show they are independent.`
    return {
      ...parserStateResult(qualified ? true : null, `${key} state measured; ${facet}`, state, note),
      ...(!qualified && { tests: [{ id: "criterion", status: "probe-todo" as const, reason: note }] }),
    }
  } finally {
    ctx.feed(`\x1b[?${number}l`)
    if (encoding && mouseBefore === false) ctx.feed("\x1b[?1000l")
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
    tests: [{ id: "criterion", status: "probe-invalid", reason: `${name}: ${JSON.stringify(observed)}` }],
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
            status: "probe-invalid",
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
        status: "probe-todo",
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
export const UNTESTABLE_ONLY_REVIEW_BRANCHES: ReadonlySet<string> = new Set([HEADLESS_OBSERVABLE_REVIEW])

/** The one test id the Untestable route admits: the operator's Nov 4 16:55 declaration (@cto ruling 2026-11-04). */
export const DECLARED_UNTESTABLE_TEST = "declared-untestable"

/**
 * A library result the operator declared Untestable (Nov 4 16:55 PST: no library can show it). The calling probe writes
 * its reason once, in its own definition, and names any library exception there; this carries no source reference.
 */
export function declaredUntestableResult(reason: string, state: object): NotTestedCoverageResult {
  if (!reason.trim()) throw new Error("A declared Untestable result needs its reason")
  return {
    ...notTestedResult(reason, state),
    criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
    tests: [{ id: DECLARED_UNTESTABLE_TEST, status: "untestable", reason }],
  }
}

/** Shared declared-absent viewport branch; callers retain their actuator contradiction check. */
export function productViewportAbsenceResult(ctx: LibProbeSource, reason: string, state: object): ProbeCallbackResult {
  const version = ctx.runtimeIdentity?.engineVersion
  if (
    !(
      (ctx.backendName === "libvterm" && version === "0.3.3") ||
      (ctx.backendName === "wezterm" && version === "0.1.0-fork.5")
    )
  ) {
    return reviewResult(HEADLESS_OBSERVABLE_REVIEW, reason, "scrollback viewport scroll control", state)
  }
  return declaredUntestableResult(`${reason} Library version: ${version}.`, state)
}

/** The only admitted route to Untestable, used by finalizeProbeResult and the run reader alike. */
export function isDeclaredUntestable(result: {
  readonly criterionBranch?: string
  readonly reviewRef?: unknown
  readonly tests?: readonly {
    readonly id: string
    readonly status: string
    readonly reason?: string
    readonly reviewRef?: unknown
  }[]
}): boolean {
  const test = result.tests?.length === 1 ? result.tests[0] : undefined
  return (
    result.criterionBranch === HEADLESS_OBSERVABLE_REVIEW &&
    result.reviewRef === undefined &&
    test !== undefined &&
    test.id === DECLARED_UNTESTABLE_TEST &&
    test.status === "untestable" &&
    test.reviewRef === undefined &&
    typeof test.reason === "string" &&
    test.reason.trim().length > 0
  )
}

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
  libvtermR1: {
    engineVersion: "0.3.3",
    adapterVersion: "0.11.0",
    wasmSha256: "dc625308fc5fff78884820c696651f60d3e5cfd1c2c650797eabe84ff5855955",
  },
  libvterm3b7c0232: {
    engineVersion: "0.3.3",
    adapterVersion: "0.10.2",
    wasmSha256: "3b7c02322357c00adb8addea05240d1d348d901cf6d6300c10401eb62b945fe0",
  },
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
  const cohort = (["libvtermR1", "libvterm3b7c0232", "libvterm712298af", "libvterm"] as const).find((key) =>
    auditedAdapterSources(ctx.runtimeIdentity, key),
  )
  if (cohort === undefined) return undefined
  const artifact = LIBVTERM_HISTORY_ARTIFACTS[cohort]
  if (identity.engineVersion !== artifact.engineVersion || identity.adapterVersion !== artifact.adapterVersion) {
    return undefined
  }
  // No source review decides this cell any more (#32246): the adapter offers no history reader, so it stays PROBE TODO.
  return notTestedResult(`libvterm v${artifact.engineVersion} adapter exposes no retained scrollback history count`, {
    engineVersion: identity.engineVersion,
    adapterVersion: identity.adapterVersion,
  })
}

/** The collector's test row for a capture that reached an engine callback its adapter does not reproduce. */
export const HARNESS_INCOMPLETE_TEST = "harness"

/**
 * A library probe on any engine (native, wasm or pure JS) whose every reply capture returned zero bytes has no same-path control in
 * this run, so silence alone never grades it (@cto 9fad23d7, #32246): the cell is PROBE TODO. Observed buffers,
 * replies and callbacks that already carry a pass, a not-tested record or a PROBE TODO keep their measured result.
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
      measured.tests?.some((test) => test.status === "probe-todo")
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
  const cpr = /^(?:\x1b\[[0-9]+;[0-9]+R){2}$/.test(raw)
  if (!sentinel || (!cpr && (answer === null || answer.start > 0 || raw.slice(answer.end).trim() !== ""))) return null
  const silence =
    sentinel.graceMs === 0
      ? "no reply at control; no grace wait"
      : `no reply through the ${String(sentinel.graceMs)} ms window`
  const observed = `${cpr ? "CPR brackets" : "DA1"} answered at +${String(sentinel.atMs)}ms; ${silence}`
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
      status: "probe-todo",
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
  const failed = tests.find((test) => test.status === "probe-invalid")
  const pending = tests.find((test) => test.status === "probe-todo")
  const impossible = tests.find((test) => test.status === "untestable")
  let status: ProbeResult["status"]
  let reason = input.reason
  if (failed) {
    status = "probe-invalid"
    reason ??= failed.reason ?? "Required test failed after its attempt"
  } else if (pending || tests.length === 0) {
    status = "probe-todo"
    reason ??= pending?.reason ?? "Required feature implementation has not run"
  } else if (impossible && isDeclaredUntestable(input)) {
    // The one route to Untestable: the operator's Nov 4 16:55 declaration, written in the probe (@cto ruling 2026-11-04).
    status = "untestable"
    reason ??= impossible.reason
  } else if (impossible) {
    // Any other untestable test folds to PROBE TODO: source answers no longer grade (#32246).
    status = "probe-todo"
    reason ??= impossible.reason ?? "untestable without the operator's declaration"
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
      input.tests.some((test) => !["probe-todo", "probe-invalid"].includes(test.status) || !test.reason?.trim())
    ) {
      throw new Error(`Execution-only callback ${featureId} requires nonempty TODO/FAILURE tests with reasons`)
    }
  }
  const assertionRefs = input.assertions.flatMap((entry, index) => (entry.featureId === featureId ? [index] : []))
  const missingCapture = diagnostic?.kind === "collector-error" && diagnostic.name === "FrameUnavailable"
  const status = missingCapture
    ? "probe-todo"
    : diagnostic || observation?.outcome === "error"
      ? "probe-invalid"
      : observation?.outcome === "supported" || observation?.outcome === "unsupported"
        ? observation.outcome
        : coverage
          ? "probe-todo"
          : "probe-invalid"
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
                ? test.status === "probe-todo"
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
              attempt: test.status === "probe-todo" ? { scope: "none" } : attempt,
              assertionRefs: refs,
              ...(rawReplyRef && { rawReplyRef }),
              ...(test.reason && { reason: test.reason }),
            }
          })
        : [
            {
              id: "criterion",
              status,
              attempt: status === "probe-todo" ? { scope: "none" } : attempt,
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
    result.status === "probe-todo" && delegated.has(result.featureId)
      ? finalizeProbeResult({
          ...result,
          attempt,
          reason: diagnostic,
          tests: [
            ...result.tests.filter((test) => test.id !== "collection"),
            { id: "collection", status: "probe-invalid", attempt, reason: diagnostic },
          ],
        })
      : result,
  )
}

/** Only these own commands may use the existing measured-report criterion. */
const UNHANDLED_MODE_COMMANDS: Readonly<Record<string, string>> = {
  "modes.decsclm": "?4h",
  "input.pixel-mouse": "?1016h",
  "input.urxvt-mouse": "?1015h",
  "input.x10-mouse": "?9h",
  "input.button-event-mouse": "?1002h",
  "input.xtest-click": "?1000h",
  "input.xtest-wheel": "?1000h",
  "modes.bracketed-paste": "?2004h",
  "modes.focus-tracking": "?1004h",
  "modes.mouse-all": "?1003h",
  "modes.mouse-sgr": "?1006h",
  "modes.mouse-tracking": "?1000h",
  "modes.utf8-mouse-1005": "?1005h",
  "modes.alt-scroll-1007": "?1007h",
  "modes.synchronized-output": "?2026h",
  "modes.color-scheme-reporting": "?2031h",
  "modes.xtpushcolors": "#P",
  "modes.xtpopcolors": "#Q",
}

/** Retain decided observations; otherwise measure one exact target against a handled mode. */
export function withUnhandledModeReport(definition: ProbeDefinition): ProbeDefinition {
  const code = UNHANDLED_MODE_COMMANDS[definition.id]
  const original = definition.lib
  if (code === undefined || !original) return definition
  return {
    ...definition,
    // The prior arm can decide input_bytes/query_reply; this report observes buffer_state.
    libAssertionType: undefined,
    lib(ctx) {
      const prior = original(ctx)
      if (reportsDecidedOutcome(prior) || !ctx.getUnhandledSequences) return prior
      try {
        return (
          unhandledSequenceVerdict(
            ctx,
            { feed: "\x1b[" + code, code: { kind: "csi", code } },
            { feed: "\x1b[?7l", applied: () => ctx.getMode("autoWrap") === false, cleanup: "\x1b[?7h" },
            { ...(prior.response !== undefined && { body: prior.response }) },
          ) ?? prior
        )
      } finally {
        // Reset is outside the verdict's exact one-entry target window.
        if (code.startsWith("?")) ctx.feed("\x1b[" + code.slice(0, -1) + "l")
      }
    },
  }
}
