/**
 * The version a reader sees (@cpo/term f16a5a52 Q3). A packager's unstable build version, `N-unstable-YYYY-MM-DD`
 * (WezTerm's Linux runs record `0-unstable-2026-11-08`), reads "dev snapshot YYYY-MM-DD"; any other version is
 * shown as stored. Only page text reads through here: the stored version is a measured fact and never changes, and
 * the public JSON keeps it raw. Client-safe, with no imports: the evidence cell imports it.
 */
const UNSTABLE_VERSION = /^\d+-unstable-(\d{4}-\d{2}-\d{2})$/
const measuredDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

/** Reader-facing measurement facts; the original timestamps and OS keys stay in the records. */
export function displayMeasuredDate(value: string): string {
  return measuredDate.format(new Date(value))
}

export function displayMeasuredRange(values: readonly string[]): string {
  const dates = values.map((value) => Date.parse(value))
  return measuredDate.formatRange(Math.min(...dates), Math.max(...dates))
}

export function displayOs(os?: string | null): string {
  return (
    ({ macos: "macOS", linux: "Linux", windows: "Windows" } as Record<string, string>)[os ?? ""] ??
    (os || "OS not recorded")
  )
}

export function displayVersion(version: string): string {
  const snapshot = UNSTABLE_VERSION.exec(version)?.[1]
  return snapshot === undefined ? version : `dev snapshot ${snapshot}`
}

/** The distinct versions some source runs print, each through displayVersion, in first-seen order. */
export function displayVersions(runs: Iterable<{ readonly subject: { readonly version: string } }>): string[] {
  return [...new Set(Array.from(runs, (run) => displayVersion(run.subject.version)))]
}
