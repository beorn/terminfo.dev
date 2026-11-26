/**
 * @failure A query_reply row's criterion text and its silence grade drift apart again: the text says silence is
 *   inconclusive, PROBE INVALID or "silently consumes" while the recorder grades a fenced silence Unsupported; or the
 *   text claims Unsupported on a row whose callbacks never mark a fenced silence; or a row leaves or joins the exemption
 *   list without anyone deciding it (#33165, @cto be3fb080, f990c003 and 767c9bcd).
 * @level l2
 * @consumer content/features.json `probe` text on every row whose term or library arm declares query_reply, read by
 *   the feature pages, beside the default rule recordExecutedProbe applies to a marked fenced silence.
 * @testonly none
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import {
  ALL_PROBES,
  isFencedSilence,
  type LibProbeSource,
  type ProbeCallbackResult,
  type ProbeDefinition,
  type TermProbeSource,
} from "@terminfo/probe-defs"
import { loadFeatures } from "@terminfo/catalog"
import { inertLibProbeSource } from "../packages/probe-defs/src/testing/group-harness.ts"

const features = loadFeatures(join(dirname(fileURLToPath(import.meta.url)), "..", "content"))

/**
 * @cpo/term's default-rule wording (#33165 calls, 2026-11-10 13:50 PST): "a device attributes answer with no ... reply
 * before it is Unsupported"; the Kitty keyboard rows say "reply" for the device attributes answer.
 */
const DEFAULT_RULE = /device attributes (?:answer|reply) with no (?:[\w-]+ )*reply before it is Unsupported/i

/**
 * query_reply rows that do not mark a fenced silence on every query_reply arm, so the default sentence would be false
 * there. They say nothing about silence (@cto 767c9bcd, #33200 @cto 87076838). Each reason is checked below:
 * - "da1-is-query": the feature query IS DA1 (`\x1b[c`), so DA1 cannot fence itself.
 * - "oracle-only": at least one query_reply arm uses CPR (`\x1b[6n`), capture, or OS clipboard readback purely as the
 *   measurement oracle, never as the feature under test; a silent oracle cannot grade the feature Unsupported.
 * - "own fold": every query_reply arm asks a DA1-fenced query and folds the silence by its own controls (subject
 *   posture, behavioural fallback, Untestable, PROBE TODO or not tested) instead of marking it.
 * - "paint row": an sgr row, decided by what is painted; its term arm declares screenshot.
 */
type ExemptReason = "da1-is-query" | "oracle-only" | "own fold" | "paint row"
const SILENCE_EXEMPT: Record<string, ExemptReason> = {
  "cursor.cpl": "oracle-only",
  "cursor.cuu-past-top": "oracle-only",
  "cursor.horizontal-absolute": "oracle-only",
  "cursor.hpa": "oracle-only",
  "cursor.move.absolute": "oracle-only",
  "cursor.move.back": "oracle-only",
  "cursor.move.down": "oracle-only",
  "cursor.move.forward": "oracle-only",
  "cursor.move.home": "oracle-only",
  "cursor.move.up": "oracle-only",
  "cursor.next-line": "oracle-only",
  "cursor.vpa": "oracle-only",
  "device.primary-da": "da1-is-query",
  "extensions.kitty-graphics.display": "own fold",
  "extensions.kitty-graphics.transmit": "own fold",
  "extensions.osc0-icon-title": "own fold",
  "extensions.osc104-reset-palette": "own fold",
  "extensions.osc110-reset-fg": "own fold",
  "extensions.osc111-reset-bg": "own fold",
  "extensions.osc112-reset-cursor": "own fold",
  "extensions.osc113-reset-pointer-fg": "own fold",
  "extensions.osc114-reset-pointer-bg": "own fold",
  "extensions.osc117-reset-highlight-bg": "own fold",
  "extensions.osc119-reset-highlight-fg": "own fold",
  "extensions.osc22-pointer": "oracle-only",
  "extensions.osc30001-color-stack-push": "own fold",
  "extensions.osc30101-color-stack-pop": "own fold",
  "extensions.osc52-clipboard": "own fold",
  "extensions.osc52-read": "own fold",
  "extensions.osc52-write": "oracle-only",
  "extensions.osc5522-clipboard": "own fold",
  "extensions.osc66-text-sizing": "oracle-only",
  "extensions.sixel-da1": "da1-is-query",
  "modes.alt-screen.enter": "own fold",
  "modes.altscreen-1047": "own fold",
  "modes.application-cursor": "own fold",
  "modes.auto-wrap": "own fold",
  "modes.bracketed-paste": "own fold",
  "modes.color-scheme-reporting": "own fold",
  "modes.deccolm": "own fold",
  "modes.decsclm": "own fold",
  "modes.mouse-all": "own fold",
  "modes.mouse-sgr": "own fold",
  "modes.mouse-tracking": "own fold",
  "modes.reverse-video": "own fold",
  "modes.synchronized-output": "own fold",
  "sgr.blink": "paint row",
  "sgr.bold": "paint row",
  "sgr.faint": "paint row",
  "sgr.hidden": "paint row",
  "sgr.inverse": "paint row",
  "sgr.italic": "paint row",
  "sgr.overline": "paint row",
  "sgr.strikethrough": "paint row",
  "sgr.underline.curly": "paint row",
  "sgr.underline.dashed": "paint row",
  "sgr.underline.dotted": "paint row",
  "sgr.underline.double": "paint row",
  "sgr.underline.single": "paint row",
  "text.cbt": "oracle-only",
  "text.cht": "oracle-only",
  "text.tbc": "oracle-only",
  "unicode.grapheme-cursor": "oracle-only",
}

const declaresQueryReply = (declared: ProbeDefinition["termAssertionType"] | ProbeDefinition["libAssertionType"]) =>
  declared === "query_reply" ||
  (typeof declared === "object" &&
    declared !== null &&
    [...declared.then, ...declared.otherwise].includes("query_reply"))

const DA1 = "\x1b[?62;22c"

/** One query_reply arm run where every DA1-fenced query is a fenced silence: did it mark, and how often did it ask? */
interface ArmSilence {
  marked: boolean
  fencedAsks: number
}

async function armSilences(probe: ProbeDefinition): Promise<ArmSilence[]> {
  let fencedAsks = 0
  const fencedOutcome = () => {
    fencedAsks++
    return {
      match: null,
      reason: "sentinel" as const,
      raw: DA1,
      rawBase64: Buffer.from(DA1).toString("base64"),
      sentinel: { atMs: 3, graceMs: 250 },
    }
  }
  let clipboard = "baseline"
  const terminal = {
    kind: "live",
    cols: 80,
    rows: 24,
    write(sequence: string) {
      const m = /\x1b\]52;c;([^\x07]+)\x07/.exec(sequence)
      if (m?.[1] && m[1] !== "?") clipboard = atob(m[1])
    },
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }),
    query: async () => null,
    // 34864: a DA1 asked alone is answered by the same DA1 the fenced outcomes carry (DECRQCRA's before/after controls,
    // #34664); every other plain query stays a silent timeout. It is no fenced ask, so fencedAsks does not count it.
    queryOutcome: async (sequence: string, pattern: RegExp) => {
      const match = sequence === "\x1b[c" ? pattern.exec(DA1) : null
      return match
        ? { match, reason: "reply", raw: DA1, rawBase64: Buffer.from(DA1).toString("base64") }
        : { match: null, reason: "timeout", raw: "", rawBase64: "" }
    },
    // queryWithSentinel sends DA1 as its fence (tty.ts:670), so count it as a fenced ask returning null on silence.
    queryWithSentinel: async () => {
      fencedAsks++
      return null
    },
    queryWithSentinelOutcome: async () => fencedOutcome(),
    queryMode: async () => null,
    withClipboardFixture: async <T>(
      work: (fixture: {
        baseline: string
        writeDeadlineMs: number
        writePollMs: number
        readText: () => Promise<string>
        writeText: (text: string) => Promise<void>
      }) => Promise<T>,
    ) =>
      work({
        baseline: "baseline",
        writeDeadlineMs: 10,
        writePollMs: 5,
        readText: async () => clipboard,
        writeText: async (text: string) => {
          clipboard = text
        },
      }),
  } as unknown as TermProbeSource
  // A library capture that ends with the DA1 request (Kitty keyboard detection) answers with DA1 alone.
  const library: LibProbeSource = {
    ...inertLibProbeSource(),
    feedCapture: (sequence: string) => {
      if (!sequence.endsWith("\x1b[c")) return ""
      fencedAsks++
      return DA1
    },
    queryWithSentinelOutcome: () => fencedOutcome(),
  }
  const arms: Array<() => Promise<ProbeCallbackResult | undefined> | ProbeCallbackResult | undefined> = []
  if (probe.term && declaresQueryReply(probe.termAssertionType)) arms.push(() => probe.term?.(terminal))
  if (probe.lib && declaresQueryReply(probe.libAssertionType)) arms.push(() => probe.lib?.(library))
  const out: ArmSilence[] = []
  for (const run of arms) {
    fencedAsks = 0
    const result = await run()
    out.push({ marked: isFencedSilence(result?.observation), fencedAsks })
  }
  return out
}

const marksFencedSilence = (arms: ArmSilence[]) => arms.length > 0 && arms.every((arm) => arm.marked)

const population = ALL_PROBES.filter(
  (probe) => declaresQueryReply(probe.termAssertionType) || declaresQueryReply(probe.libAssertionType),
)

describe("every query_reply row's criterion text states the silence rule the recorder applies", () => {
  test("the exemption list is exactly the rows that do not mark a fenced silence, each for its stated reason", async () => {
    expect(population.length).toBe(106)
    const unmarked: string[] = []
    const wrongReason: string[] = []
    for (const probe of population) {
      const arms = await armSilences(probe)
      if (marksFencedSilence(arms)) continue
      unmarked.push(probe.id)
      const reason = SILENCE_EXEMPT[probe.id]
      const holds =
        reason === "da1-is-query"
          ? arms.some((arm) => arm.fencedAsks === 0) &&
            (probe.id === "device.primary-da" || probe.id === "extensions.sixel-da1")
          : reason === "oracle-only"
            ? arms.some((arm) => arm.fencedAsks === 0)
            : reason === "own fold"
              ? arms.every((arm) => arm.fencedAsks > 0)
              : reason === "paint row"
                ? probe.id.startsWith("sgr.") && !declaresQueryReply(probe.termAssertionType)
                : false
      if (reason && !holds) wrongReason.push(`${probe.id} (${reason})`)
    }
    // A listed row that gains a fence and marks it, or a fenceless query_reply row missing from the list, fails here.
    expect(unmarked.sort()).toEqual(Object.keys(SILENCE_EXEMPT).sort())
    // A listed row whose reason stopped being true (a "no fence" row that now asks a fenced query on every arm) fails here.
    expect(wrongReason).toEqual([])
  })

  test.each(population.map((probe) => [probe.id, probe] as const))("%s", async (id, probe) => {
    const row = features[id]
    if (!row) throw new Error(`${id} declares query_reply but has no content/features.json row`)
    if (SILENCE_EXEMPT[id]) {
      // The callbacks never grade a fenced silence through the rule, so the text must not say they do.
      expect(row.probe, id).not.toMatch(DEFAULT_RULE)
      return
    }
    expect(marksFencedSilence(await armSilences(probe)), id).toBe(true)
    expect(row.probe, id).toMatch(DEFAULT_RULE)
    // The old contradicting phrases are gone from every default-rule row.
    expect(row.probe, id).not.toMatch(
      /silently consumes|no reply is defined|missing (?:or malformed )?repl(?:y|ies)[^.]*(?:inconclusive|PROBE INVALID)/i,
    )
  })
})
