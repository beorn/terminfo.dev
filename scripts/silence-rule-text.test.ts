/**
 * @failure A query_reply row's criterion text and its silence grade drift apart again: the text says silence is
 *   inconclusive, PROBE INVALID or "silently consumes" while the recorder grades a fenced silence Unsupported, or the
 *   text claims Unsupported on a row whose callbacks never mark a fenced silence (#33165, @cto be3fb080 and f990c003).
 * @level l2
 * @consumer content/features.json `probe` text on every row whose term or library arm declares query_reply, read by
 *   the feature pages, beside the rule recordExecutedProbe applies from the row's `silence` field.
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

/** @cpo/term's default-rule wording (#33165 calls, 2026-11-10 13:50 PST). */
const DEFAULT_RULE = /device attributes answer with no (?:[\w-]+ )*reply before it is Unsupported/i

/**
 * Rows whose term or library callback, declared query_reply, does not mark a fenced silence, so the default sentence
 * would be false there. Pending a product decision (#33165 report); they say nothing about silence being Unsupported.
 * Seven of them (kitty-keyboard x6, input.csi-u) grade a DA1-only silence Unsupported by their own code, outside the
 * row rule; the reset/stack OSC rows fold silence to Untestable or PROBE TODO by their own controls; the sgr rows are
 * paint rows; cursor, text and modes rows read a cursor or DECRPM reply without the DA1 fence.
 */
const SILENCE_NOT_MARKED = [
  "cursor.cpl",
  "cursor.cuu-past-top",
  "cursor.horizontal-absolute",
  "cursor.hpa",
  "cursor.move.absolute",
  "cursor.move.back",
  "cursor.move.down",
  "cursor.move.forward",
  "cursor.move.home",
  "cursor.move.up",
  "cursor.next-line",
  "cursor.position-report",
  "cursor.vpa",
  "device.primary-da",
  "extensions.kitty-graphics.display",
  "extensions.kitty-graphics.transmit",
  "extensions.kitty-keyboard",
  "extensions.kitty-keyboard.disambiguate",
  "extensions.kitty-keyboard.report-all-keys",
  "extensions.kitty-keyboard.report-alternate",
  "extensions.kitty-keyboard.report-events",
  "extensions.kitty-keyboard.report-text",
  "extensions.osc0-icon-title",
  "extensions.osc104-reset-palette",
  "extensions.osc110-reset-fg",
  "extensions.osc111-reset-bg",
  "extensions.osc112-reset-cursor",
  "extensions.osc113-reset-pointer-fg",
  "extensions.osc114-reset-pointer-bg",
  "extensions.osc117-reset-highlight-bg",
  "extensions.osc119-reset-highlight-fg",
  "extensions.osc22-pointer",
  "extensions.osc30001-color-stack-push",
  "extensions.osc30101-color-stack-pop",
  "extensions.osc52-clipboard",
  "extensions.osc52-read",
  "extensions.osc52-write",
  "extensions.osc5522-clipboard",
  "extensions.osc66-text-sizing",
  "extensions.sixel-da1",
  "input.csi-u",
  "modes.alt-screen.enter",
  "modes.altscreen-1047",
  "modes.application-cursor",
  "modes.auto-wrap",
  "modes.bracketed-paste",
  "modes.color-scheme-reporting",
  "modes.deccolm",
  "modes.decsclm",
  "modes.mouse-all",
  "modes.mouse-sgr",
  "modes.mouse-tracking",
  "modes.reverse-video",
  "modes.synchronized-output",
  "sgr.blink",
  "sgr.bold",
  "sgr.faint",
  "sgr.hidden",
  "sgr.inverse",
  "sgr.italic",
  "sgr.overline",
  "sgr.strikethrough",
  "sgr.underline.curly",
  "sgr.underline.dashed",
  "sgr.underline.dotted",
  "sgr.underline.double",
  "sgr.underline.single",
  "text.cbt",
  "text.cht",
  "text.tbc",
  "unicode.grapheme-cursor",
]

/**
 * Marks a fenced silence, but its text says no reply is defined; adding the default sentence would bless that grade
 * against the text, which needs @cpo/term's written call (@cto be3fb080). Pending a decision (#33165 report).
 */
const TEXT_CONTRADICTS_MARK = ["extensions.osc7777-font-window-size"]

const declaresQueryReply = (declared: ProbeDefinition["termAssertionType"] | ProbeDefinition["libAssertionType"]) =>
  declared === "query_reply" ||
  (typeof declared === "object" &&
    declared !== null &&
    [...declared.then, ...declared.otherwise].includes("query_reply"))

const DA1 = "\x1b[?62;22c"
const fencedOutcome = () => ({
  match: null,
  reason: "sentinel" as const,
  raw: DA1,
  rawBase64: Buffer.from(DA1).toString("base64"),
  sentinel: { atMs: 3, graceMs: 250 },
})
const silentTerminal = (): TermProbeSource =>
  ({
    kind: "live",
    cols: 80,
    rows: 24,
    write() {},
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }),
    query: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinel: async () => null,
    queryWithSentinelOutcome: async () => fencedOutcome(),
    queryMode: async () => null,
  }) as unknown as TermProbeSource
const silentLibrary = (): LibProbeSource => ({
  ...inertLibProbeSource(),
  queryWithSentinelOutcome: () => fencedOutcome(),
})

/** Every query_reply arm of the row, run where every DA1-fenced query is a fenced silence, marks it. */
async function marksFencedSilence(probe: ProbeDefinition): Promise<boolean> {
  const results: Array<ProbeCallbackResult | undefined> = []
  if (probe.term && declaresQueryReply(probe.termAssertionType)) results.push(await probe.term(silentTerminal()))
  if (probe.lib && declaresQueryReply(probe.libAssertionType)) results.push(probe.lib(silentLibrary()))
  return results.length > 0 && results.every((result) => isFencedSilence(result?.observation))
}

const population = ALL_PROBES.filter(
  (probe) => declaresQueryReply(probe.termAssertionType) || declaresQueryReply(probe.libAssertionType),
)

describe("every query_reply row's criterion text states the silence rule the recorder applies", () => {
  test("the population is classified: every row either marks a fenced silence or is named as not marking one", async () => {
    expect(population.length).toBe(105)
    const unmarked: string[] = []
    for (const probe of population) if (!(await marksFencedSilence(probe))) unmarked.push(probe.id)
    expect(unmarked.sort()).toEqual(SILENCE_NOT_MARKED)
  })

  test.each(population.map((probe) => [probe.id, probe] as const))("%s", async (id, probe) => {
    const row = features[id]
    if (!row) throw new Error(`${id} declares query_reply but has no content/features.json row`)
    const silence = row.silence
    if (silence) {
      // A non-default rule: the text names the rule's reason, and never the default sentence.
      expect(row.probe, id).toContain(silence.reason)
      expect(row.probe, id).not.toMatch(DEFAULT_RULE)
      return
    }
    if (SILENCE_NOT_MARKED.includes(id) || TEXT_CONTRADICTS_MARK.includes(id)) {
      // The callbacks never grade a fenced silence Unsupported through the rule, so the text must not say they do.
      expect(row.probe, id).not.toMatch(DEFAULT_RULE)
      return
    }
    expect(await marksFencedSilence(probe), id).toBe(true)
    expect(row.probe, id).toMatch(DEFAULT_RULE)
    // The old contradicting phrases are gone from every default-rule row.
    expect(row.probe, id).not.toMatch(
      /silently consumes|missing (?:or malformed )?repl(?:y|ies)[^.]*(?:inconclusive|PROBE INVALID)/i,
    )
  })
})
