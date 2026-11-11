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
  parts.push(recorded.permissions ? `perms ${recorded.permissions}` : "no permissions")
  if (recorded.mux) parts.push(`mux ${recorded.mux}`)
  if (recorded.outerTerminal) parts.push(`outer ${recorded.outerTerminal}`)
  return parts.join(" · ")
}
