/**
 * The name a page gives one measured context, from the projection's own context key.
 *
 * A context key is `kind:id` for an app measured once, and `kind:id@[...]` for an app measured more than
 * once, where the array is the recorded physical subject. The reader needs the machine, the launch
 * profile and the permissions, because those are what a "differs by context" cell is differing over
 * (@cto d321729a) — not the storage format.
 */
const FIELDS = ["kind", "id", "os", "osVersion", "outerTerminal", "mux", "config", "permissions"] as const

function launchName(config: string): string {
  const stripped = config.replace(/\/nix\/store\/[a-z0-9]{32}-/g, "")
  const [binary] = stripped.split(/\s+/)
  const options = stripped.slice(binary?.length ?? 0).trim()
  const base = binary?.split("/").pop() ?? binary ?? ""
  return options ? `${base} ${options.length > 40 ? `${options.slice(0, 40)}…` : options}` : base
}

/** A short, human name for a context key; an unparseable key is returned unchanged, never guessed at. */
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
  const parts = [`${recorded.os ?? "?"} ${recorded.osVersion ?? ""}`.trim()]
  if (recorded.config) parts.push(launchName(recorded.config))
  else parts.push("default profile")
  // An empty permissions field names nothing about the grade, so it prints nothing (#37341).
  if (recorded.permissions) parts.push(`perms ${recorded.permissions}`)
  if (recorded.mux) parts.push(`mux ${recorded.mux}`)
  if (recorded.outerTerminal) parts.push(`outer ${recorded.outerTerminal}`)
  return parts.join(" · ")
}

/**
 * The line under a joined cell's badge (rule 4): it names the contexts the grade comes from, unless every context of
 * the app carries that same grade. A "Context:" line never repeats the grade the badge already shows; a "Differs by
 * context:" line says each context's grade, because that difference is what the line is for (#37341).
 * Extracted from ResultEvidenceCell.vue so the rule has a reader a test can call (as evidence-status.ts is).
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
  return differs
    ? `Differs by context: ${grades.map((grade) => `${contextLabel(grade.context)} — ${word(grade.status)}`).join(" · ")}`
    : `Context: ${grades.map((grade) => contextLabel(grade.context)).join(" · ")}`
}
