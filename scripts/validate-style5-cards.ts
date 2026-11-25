/**
 * Build-time and test validator for Style 5 measured result cards (#38269, card-style5-rule-0010.md).
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

/**
 * Validate a Style 5 measured card model. Returns an empty list when valid, or violation messages naming `where`.
 */
export function validateMeasuredCard(model: CardModel, where: string): string[] {
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
    if (wc < 3 || wc > 6) {
      violations.push(`${where}: verdict ${JSON.stringify(model.verdict.text)} has ${wc} words (required 3–6)`)
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
