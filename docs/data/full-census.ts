/**
 * The expected context register of the full-scope project, derived from the catalog.
 *
 * The register is not a second target list: an app or mux context is a non-historical catalog row
 * with its declared platforms, and a headless context is one engine named by any row's
 * `headlessBackends`. Adding a terminal to the catalog therefore adds its context here, and no
 * hand-maintained list can drift from the catalog the runs are measured against.
 *
 * The display key is `terminal/platform` for apps and muxes, and `engine/headless` for an engine:
 * an engine's adapter is the context, not the OS it happens to run on this week.
 */
import { loadTerminals } from "@terminfo/catalog"

export type ContextKind = "app" | "mux" | "headless"

export interface CensusContext {
  /** Stable display key: `kitty/linux`, `tmux/macos`, `libvterm/headless`. */
  context: string
  terminalId: string
  /** The catalog platform for an app or mux, and `headless` for an engine. */
  os: string
  kind: ContextKind
}

export interface ContextCensus {
  contexts: readonly CensusContext[]
  /** The engine ids the catalog names, in name order. */
  engines: readonly string[]
  /** Rows skipped because the catalog marks them historical. */
  historical: readonly string[]
}

const PLATFORM_ORDER = ["linux", "macos", "windows"] as const

/** Derive every expected context from the catalog, refusing a row whose declaration is unusable. */
export function fullContextCensus(contentDir: string): ContextCensus {
  const terminals = loadTerminals(contentDir)
  const contexts: CensusContext[] = []
  const historical: string[] = []
  const engines = new Set<string>()

  for (const [id, row] of Object.entries(terminals)) {
    const backends = row.headlessBackends ?? []
    if (!Array.isArray(backends) || backends.some((engine) => typeof engine !== "string" || !engine)) {
      throw new Error(`${id}: headlessBackends must name engines`)
    }
    for (const engine of backends) engines.add(engine)
    if (row.historical === true) {
      historical.push(id)
      continue
    }
    if (row.kind === "headless") continue
    if (row.kind !== "app" && row.kind !== "mux") {
      throw new Error(`${id}: kind "${String(row.kind)}" is not an app, mux or headless context`)
    }
    const platforms = row.platforms ?? []
    if (platforms.length === 0) {
      throw new Error(`${id}: a ${row.kind} context needs at least one declared platform`)
    }
    const ordered = [...platforms].sort(
      (left, right) =>
        PLATFORM_ORDER.indexOf(left as (typeof PLATFORM_ORDER)[number]) -
          PLATFORM_ORDER.indexOf(right as (typeof PLATFORM_ORDER)[number]) || left.localeCompare(right),
    )
    for (const platform of ordered) {
      contexts.push({ context: `${id}/${platform}`, terminalId: id, os: platform, kind: row.kind })
    }
  }

  const engineIds = [...engines].sort()
  for (const engine of engineIds) {
    contexts.push({ context: `${engine}/headless`, terminalId: engine, os: "headless", kind: "headless" })
  }

  return { contexts, engines: engineIds, historical }
}
