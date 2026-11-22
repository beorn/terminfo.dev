/**
 * Observer-only switches a stored run turned on, keyed by run id (#37761, @cto 9de3bba2 and e81def55).
 *
 * An observer-only switch changes nothing the terminal renders or sends to the application (iTerm2's EnableAPIServer
 * only lets the probe read prompt marks iTerm2 already holds), so it is never part of the configuration that names a
 * context. A run collected before the collector recorded `observers` itself gets them here, with the cells the switch
 * let the probe read and the note those cells publish. Stored run bytes are not edited.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsonStrict } from "@terminfo/run-parser"

export interface RunObservers {
  /** "<app id>: <switch> <value>", as the collector will record it. */
  readonly observers: readonly string[]
  /** The cells of this run the switch let the probe read; each publishes `note`. */
  readonly featureIds: readonly string[]
  readonly note: string
}

const RUN_DIRS = ["probes-apps", "probes-libs", "probes-mux"] as const

/** Loads content/run-observers.json loudly: a malformed row, an unknown run or an unknown feature fails the build. */
export function loadRunObservers(contentDir: string, featureIds: ReadonlySet<string>): Record<string, RunObservers> {
  const path = join(contentDir, "run-observers.json")
  if (!existsSync(path)) throw new Error(`run-observers.json not found at ${path}`)
  const raw = parseJsonStrict(path, readFileSync(path, "utf8"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${path}: expected an object keyed by run id`)
  const storedRuns = new Set(
    RUN_DIRS.flatMap((dir) =>
      existsSync(join(contentDir, dir))
        ? readdirSync(join(contentDir, dir)).flatMap((file) => /-([0-9a-f]{32})\.json$/u.exec(file)?.[1] ?? [])
        : [],
    ),
  )
  const rows: Record<string, RunObservers> = {}
  for (const [runId, row] of Object.entries(raw as Record<string, unknown>)) {
    if (!storedRuns.has(runId))
      throw new Error(`${path}: run ${runId} is not a stored run under ${RUN_DIRS.join(", ")}`)
    const { observers, featureIds: ids, note } = (row ?? {}) as Record<string, unknown>
    const strings = (value: unknown) =>
      Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v !== "")
    if (!strings(observers)) throw new Error(`${path}: run ${runId} needs a non-empty observers list`)
    if (!strings(ids)) throw new Error(`${path}: run ${runId} needs a non-empty featureIds list`)
    if (typeof note !== "string" || note.trim() === "") throw new Error(`${path}: run ${runId} needs a note`)
    for (const id of ids as string[])
      if (!featureIds.has(id)) throw new Error(`${path}: run ${runId} names unknown feature ${id}`)
    rows[runId] = { observers: observers as string[], featureIds: ids as string[], note }
  }
  return rows
}
