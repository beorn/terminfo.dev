/**
 * Public context label for a measured context key (#37631).
 *
 * Operator standing ruling: public pages show terminal name, version and OS only —
 * never `nice` flags, binary or `/nix/store` paths, permissions, mux or outer terminal names.
 */
import { displayOs } from "./display-version.ts"

const FIELDS = ["kind", "id", "os", "osVersion", "outerTerminal", "mux", "config", "permissions"] as const

/** A short, public OS label for a context key; an unparseable key is returned unchanged, never guessed at. */
export function contextLabel(key: string): string {
  const at = key.indexOf("@[")
  if (at < 0) return key
  let subject: unknown
  try {
    subject = JSON.parse(key.slice(at + 1))
  } catch {
    return key
  }
  if (!Array.isArray(subject)) return key
  const recorded = Object.fromEntries(FIELDS.map((field, index) => [field, subject[index] ?? null])) as Record<
    (typeof FIELDS)[number],
    string | null
  >
  const osName = recorded.os ? displayOs(recorded.os) : "OS not recorded"
  return recorded.osVersion ? `${osName} ${recorded.osVersion}` : osName
}

/**
 * The line under a joined cell's badge (rule 4): it names the public OS contexts the grade comes from,
 * unless every context of the app carries that same grade. Never leaks config paths, nice flags,
 * permissions, mux or outer terminal names.
 */
export function contextLine(
  grades: ReadonlyArray<{ readonly context: string; readonly status: string }> | undefined,
  contextCount: number,
  differs: boolean,
  word: (status: string) => string,
): string | undefined {
  if (!grades || grades.length === 0) return undefined
  const uniform = new Set(grades.map((grade) => grade.status)).size === 1
  if (uniform && contextCount > 0 && grades.length === contextCount) return undefined
  if (differs) {
    const entries = [...new Set(grades.map((grade) => `${contextLabel(grade.context)} — ${word(grade.status)}`))]
    return `Differs by context: ${entries.join(" · ")}`
  }
  const labels = [...new Set(grades.map((grade) => contextLabel(grade.context)))]
  return `Context: ${labels.join(" · ")}`
}
