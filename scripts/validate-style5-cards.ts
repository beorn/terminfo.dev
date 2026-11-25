/**
 * Build-time and test validator for Style 5 result cards (#38269, card-style5-rule-0010.md, style5-review-0200.md).
 * Kept strictly outside docs/.vitepress/theme/ so forbidden-string patterns never enter client JS bundles.
 */
import { countVerdictWords, type CardModel } from "../docs/.vitepress/theme/card-explain.ts"

const FORBIDDEN_CARD_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "PROBE TODO", pattern: /\bPROBE TODO\b/i },
  { name: "PROBE INVALID", pattern: /\bPROBE INVALID\b/i },
  { name: "PROBE CONFLICT", pattern: /\bPROBE CONFLICT\b/i },
  { name: "probe-todo", pattern: /\bprobe-todo\b/i },
  { name: "probe-invalid", pattern: /\bprobe-invalid\b/i },
  { name: "probe-conflict", pattern: /\bprobe-conflict\b/i },
  { name: "NOT MEASURED", pattern: /\bNOT MEASURED\b/i },
  { name: "not stored by this run", pattern: /not stored by this run/i },
  { name: "not reviewed for publication", pattern: /not reviewed for publication/i },
  { name: "nix store path", pattern: /\/nix\/store\/[a-z0-9]{10,}/i },
  { name: "raw JSON object", pattern: /^\s*\{[\s\S]*"[\w-]+":/ },
]

const FORBIDDEN_METHOD_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "text snapshot method prose", pattern: /\bfrom the terminal's own text snapshot\b/i },
  { name: "console host method prose", pattern: /\bfrom the console host's buffer\b/i },
  { name: "pixel method disclaimer", pattern: /\bnot from its pixels\b/i },
  { name: "Read row method prose", pattern: /^Read rows?\b/i },
  { name: "Compared row method prose", pattern: /^Compared rows?\b/i },
  { name: "Checked screen method prose", pattern: /^Checked (?:rows?|the screen)\b/i },
  { name: "Sampled row method prose", pattern: /^Sampled rows?\b/i },
  { name: "Set title/cwd method prose", pattern: /^Set the (?:window title|working directory)\b/i },
  { name: "Read title/icon method prose", pattern: /^Read the (?:icon name|window title)\b/i },
  { name: "run-on multi-reply list", pattern: /^The terminal sent back \d+ replies:/i },
  { name: "prose reply instead of columns", pattern: /^The terminal sent back ESC \[/i },
]

const GENERIC_UNTESTABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /Could not be tested automatically here/i,
  /This terminal could not be tested for this feature/i,
  /cannot show whether the feature works/i,
]

function featureExpectsCprReply(featureId?: string): boolean {
  if (!featureId) return true
  return (
    featureId.startsWith("cursor.") ||
    featureId.startsWith("scroll.") ||
    featureId.startsWith("scrollback.") ||
    featureId.startsWith("editing.") ||
    featureId.startsWith("text.") ||
    featureId.startsWith("unicode.") ||
    featureId.startsWith("charsets.") ||
    featureId.startsWith("erase.") ||
    featureId.startsWith("reset.") ||
    featureId.startsWith("modes.") ||
    featureId === "extensions.osc66-text-sizing"
  )
}

export interface ValidateCardContext {
  readonly featureId?: string
  readonly assertionType?: string
}

/**
 * Validate a Style 5 measured card model. Returns an empty list when valid, or violation messages naming `where`.
 */
export function validateMeasuredCard(model: CardModel, where: string, ctx: ValidateCardContext = {}): string[] {
  const violations: string[] = []
  if (!model.measured) {
    violations.push(`${where}: expected measured=true on decided Supported/Unsupported card`)
    return violations
  }
  if (!model.expected || model.expected.words.trim().length === 0) {
    violations.push(`${where}: missing Expected words`)
  }
  if (!model.received || model.received.words.trim().length === 0) {
    violations.push(`${where}: missing Received text`)
  }
  if ((model.received as { codeMuted?: string } | undefined)?.codeMuted === "read directly") {
    violations.push(`${where}: fake bytes placeholder "read directly" is forbidden in Style 5`)
  }
  if (!model.verdict || model.verdict.text.trim().length === 0) {
    violations.push(`${where}: missing bottom verdict line`)
  } else {
    const wc = countVerdictWords(model.verdict.text)
    if (wc < 2 || wc > 6) {
      violations.push(`${where}: verdict ${JSON.stringify(model.verdict.text)} has ${wc} words (required 2–6)`)
    }
    if (
      model.received?.words &&
      model.verdict.text.trim().toLowerCase() === model.received.words.trim().toLowerCase()
    ) {
      violations.push(`${where}: verdict repeats Received verbatim (${JSON.stringify(model.verdict.text)})`)
    }
  }

  // Rule 8a: Reply families must show bytes | words in the row columns (never a sentence spanning both columns).
  if (model.replyFamily) {
    if (!model.expected?.code) {
      violations.push(`${where}: reply-family Expected must include bytes in the code column`)
    }
    if (!model.received?.code && model.received?.codeMuted !== "nothing") {
      violations.push(
        `${where}: reply-family Received must show bytes (or codeMuted="nothing") in columns, not a spanning sentence`,
      )
    }
  }

  // Rule 8b: Received must never be a fence, setup, or calibration reply.
  const recCode = model.received?.code ?? ""
  const recWords = model.received?.words ?? ""
  if (
    ctx.featureId &&
    !featureExpectsCprReply(ctx.featureId) &&
    (/\bESC \[ \d+;\d+ R\b/.test(recCode) || /\bESC \[ \d+;\d+ R\b/.test(recWords))
  ) {
    violations.push(`${where}: Received leaks cursor-position fence reply (${recCode || recWords})`)
  }
  if (ctx.assertionType === "input_bytes" && recCode) {
    if (/\bESC \[ [468];\d+;\d+ t\b/.test(recCode)) {
      violations.push(`${where}: input_bytes Received leaks window/cell/grid size setup reply (${recCode})`)
    }
    if (/\bESC \[ \??\d+;\d+ \$ y\b/.test(recCode)) {
      violations.push(`${where}: input_bytes Received leaks DECRQM setup reply (${recCode})`)
    }
  }
  if (/\b765[45]\b/.test(recCode) || /\b765[45]\b/.test(recWords)) {
    violations.push(`${where}: Received leaks 7654/7655 calibration command`)
  }

  // Rule 8c: Method descriptions never appear in Expected or Received.
  for (const [field, val] of [
    ["expected.words", model.expected?.words],
    ["received.words", model.received?.words],
  ] as const) {
    if (!val) continue
    for (const check of FORBIDDEN_METHOD_PATTERNS) {
      if (check.pattern.test(val)) {
        violations.push(`${where}: ${field} contains method/run-on prose (${check.name}): ${val.slice(0, 120)}`)
      }
    }
  }

  const fields: Array<[string, string | undefined]> = [
    ["expected.words", model.expected?.words],
    ["expected.code", model.expected?.code],
    ["received.words", model.received?.words],
    ["received.code", model.received?.code],
    ["verdict.text", model.verdict?.text],
    ...model.steps.flatMap((s): Array<[string, string | undefined]> => [
      [`step[${s.num}].code`, s.code],
      [`step[${s.num}].words`, s.words],
    ]),
  ]
  for (const [field, val] of fields) {
    if (!val) continue
    for (const check of FORBIDDEN_CARD_PATTERNS) {
      if (check.pattern.test(val)) {
        violations.push(`${where}: ${field} leaks forbidden text (${check.name}): ${val.slice(0, 100)}`)
      }
    }
  }
  return violations
}

/**
 * Rule 7: Every Untestable card must state a specific reason why it could not be tested automatically.
 */
export function validateUntestableCard(model: CardModel, where: string): string[] {
  const violations: string[] = []
  if (model.measured) {
    violations.push(`${where}: expected measured=false on Untestable card`)
    return violations
  }
  const text = model.closing.trim()
  if (text.length === 0 || text === "Not a no.") {
    violations.push(`${where}: Untestable card is missing a specific reason`)
    return violations
  }
  for (const pattern of GENERIC_UNTESTABLE_PATTERNS) {
    if (pattern.test(text)) {
      violations.push(`${where}: Untestable card uses generic placeholder reason: ${text}`)
    }
  }
  for (const check of FORBIDDEN_CARD_PATTERNS) {
    if (check.pattern.test(text)) {
      violations.push(`${where}: Untestable card leaks forbidden text (${check.name}): ${text.slice(0, 100)}`)
    }
  }
  return violations
}
