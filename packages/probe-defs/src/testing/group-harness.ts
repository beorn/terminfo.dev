/**
 * Shared group contract-test + re-grade fixture harness (#28453).
 *
 * One fixture, one expected-cells table, one re-grade invocation, so each of #28018's eight group
 * steps is "contract + focused test" with no per-group reinvention. Precedent: #28001's 41
 * fixture/control checks and scripts/decrqss-regrade.test.ts (the working re-grade model).
 *
 * @fakes @terminfo/probe-defs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  OBSERVATION_OUTCOMES,
  type ObservationOutcome,
  type ProbeDefinition,
  type ProbeResult,
  type TermContext,
  type TermlessContext,
  type TerminalQueryOutcome,
} from "../types.ts"

/** One capability's contract: the id, the outcome it must read when its controls hold, and its claim. */
export interface ContractRow {
  readonly id: string
  /** "decided" = a pass/fail is required; an explicit outcome = exactly that observation. */
  readonly expected: ObservationOutcome | "decided"
  /** The one-line claim the focused test binds (#27832: every contract row binds a focused test). */
  readonly claim: string
}

export type GroupContract = readonly ContractRow[]

/**
 * A group's whole contract - the named set 28454 reviews: the group `name`, its `rows`, and the
 * focused test files that bind them. The test set is NAMED, never globbed from the definition
 * filename: terminfo's focused tests are grouped by observation/geometry category, so a group has no
 * `<def-file>*.test.ts` (measured 2026-10-09, @dev/3 - there is no `sgr*.test.ts`; SGR's probes are
 * exercised by `readback.test.ts` and `helper-observations.test.ts`).
 */
export interface GroupContractSpec {
  readonly group: string
  readonly rows: GroupContract
  /** Repo-relative paths of the focused test files that bind this group's observations. Named, never a glob. */
  readonly tests: readonly string[]
}

/**
 * The re-grade command for a group: its NAMED focused tests, then the decisive-share read. terminfo.dev
 * runs Vitest, so the runner is `bunx --bun vitest run <paths>` - never Bun-native `bun test`.
 */
export function regradeCommand(spec: GroupContractSpec): string {
  return `cd vendor/terminfo.dev && bunx --bun vitest run ${spec.tests.join(" ")} && bun run decisive-share`
}

/**
 * A contract is reviewable only when its named tests exist: a named path that is absent is a silent
 * gap, not a passing contract. Returns the missing paths (empty = the named set is real).
 */
export function missingContractTests(spec: GroupContractSpec, root: string): string[] {
  return spec.tests.filter((path) => !existsSync(join(root, path))).sort()
}

/** One stored run row, schema-v2, reduced to what a re-grade needs. */
export interface GroupRow {
  readonly file: string
  readonly terminal: string
  readonly version: string
  readonly runId: string
  readonly observation: { readonly outcome: string; readonly note?: string }
  readonly rawReplies: Readonly<Record<string, string>>
}

/**
 * One content directory a fixture reads. A directory is REQUIRED unless it is explicitly declared
 * `optional`; a required directory that cannot be read is a loud fault, never an empty fixture
 * (2026-10-09 @dev/10 review: a blanket catch turned missing/unreadable dirs into a silent pass).
 */
export interface GroupRowsSource {
  readonly dir: string
  /** A directory the fixture may legitimately not have. Its absence is reported in `excluded`, never dropped. */
  readonly optional?: boolean
}

/** An optional source that was absent or unreadable, named with its queried path and cause. */
export interface GroupRowsExclusion {
  readonly dir: string
  readonly path: string
  readonly cause: string
}

/** The fixture read: the rows, plus every optional source that was excluded (empty = none were). */
export interface GroupRowsRead {
  readonly rows: GroupRow[]
  readonly excluded: readonly GroupRowsExclusion[]
}

/**
 * Part 1 - the fixture. Reads content/ rows once; a group names only its own ids. Required sources
 * MUST read (a failure throws with the queried path); optional sources are declared and any that was
 * skipped is returned in `excluded`, so a caller can never read a missing directory as an empty set.
 */
export function loadGroupRows(
  contentDir: string,
  sources: readonly GroupRowsSource[] = [{ dir: "probes-apps" }, { dir: "probes-mux" }],
): GroupRowsRead {
  const rows: GroupRow[] = []
  const excluded: GroupRowsExclusion[] = []
  for (const source of sources) {
    const path = join(contentDir, source.dir)
    let names: string[]
    try {
      names = readdirSync(path)
    } catch (error) {
      const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      if (source.optional === true) {
        excluded.push({ dir: source.dir, path, cause })
        continue
      }
      throw new Error(
        `loadGroupRows: required content directory ${source.dir} could not be read at ${path}: ${cause}`,
        {
          cause,
        },
      )
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const data = JSON.parse(readFileSync(join(contentDir, source.dir, name), "utf8")) as {
        schemaVersion?: number
        runId?: string
        target?: { id?: string; version?: string }
        observations?: Array<{ featureId: string; outcome: string; note?: string }>
        rawReplies?: Record<string, string>
      }
      if (data.schemaVersion !== 2) continue
      rows.push({
        file: `${source.dir}/${name}`,
        terminal: data.target?.id ?? "unknown",
        version: data.target?.version ?? "unknown",
        runId: data.runId ?? name,
        observation: { outcome: "unknown", note: undefined },
        rawReplies: data.rawReplies ?? {},
      })
    }
  }
  return { rows, excluded }
}

/** Contract coverage: every probe id has a contract row, and no contract row names an unknown id. */
export function contractGaps(
  probes: readonly ProbeDefinition[],
  contract: GroupContract,
): { readonly uncovered: string[]; readonly unknown: string[] } {
  const probeIds = new Set(probes.map((entry) => entry.id))
  const contractIds = new Set(contract.map((entry) => entry.id))
  return {
    uncovered: [...probeIds].filter((id) => !contractIds.has(id)).sort(),
    unknown: [...contractIds].filter((id) => !probeIds.has(id)).sort(),
  }
}

/**
 * Part 2 - the expected-cell check. A regraded observation satisfies a row when it is a known
 * outcome and, for a "decided" row, it is not `inconclusive`/`not-tested`.
 */
export function satisfiesContract(row: ContractRow, observation: ObservationOutcome | undefined): boolean {
  if (observation === undefined) return false
  if (!(OBSERVATION_OUTCOMES as readonly string[]).includes(observation)) return false
  return row.expected === "decided"
    ? observation === "supported" || observation === "unsupported"
    : observation === row.expected
}

/**
 * Part 3 - the re-grade invocation. A group supplies only the TermlessContext fields its headless
 * semantics need; the harness fills the inert remainder, so no group reinvents the whole fake.
 */
export interface HeadlessModel extends Partial<TermlessContext> {
  readonly cols: number
  feed(text: string): void
  getCell(row: number, col: number): ReturnType<TermlessContext["getCell"]>
  getCursor(): ReturnType<TermlessContext["getCursor"]>
}

export function headlessContext(model: HeadlessModel): TermlessContext {
  const getText = (): string => {
    const lines: string[] = []
    for (let row = 0; row < 24; row++) {
      let line = ""
      for (let col = 0; col < model.cols; col++) line += model.getCell(row, col).char || " "
      lines.push(line.replace(/\s+$/u, ""))
    }
    return lines.join("\n")
  }
  return {
    getHyperlinkAt: () => null,
    feedCapture: (text) => {
      model.feed(text)
      return getText()
    },
    getMode: () => false,
    getText,
    getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
    getTitle: () => "",
    reset: () => {},
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "6.0.0",
      extensions: new Set<string>(),
    },
    ...model,
    getCursor: model.getCursor,
    getCell: model.getCell,
    feed: model.feed,
    cols: model.cols,
  }
}

/** A stored query, the shape scripts/decrqss-regrade.test.ts replays. */
export interface StoredQuery {
  readonly sequence: string
  readonly match: string[] | null
  readonly reason: TerminalQueryOutcome["reason"]
  readonly raw: string
  readonly sentinel?: { readonly atMs: number; readonly graceMs: number }
}

/** Part 3 (query rows) - a TermContext whose queries replay stored raw, not a terminal. */
export function replayContext(
  bySequence: ReadonlyMap<string, StoredQuery>,
  defaults: Partial<TermContext> = {},
): TermContext {
  const outcome = (sequence: string, pattern: RegExp): TerminalQueryOutcome => {
    const stored = bySequence.get(sequence)
    if (stored === undefined) return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    return {
      match: stored.reason === "reply" ? pattern.exec(stored.raw) : null,
      reason: stored.reason,
      raw: stored.raw,
      rawBase64: Buffer.from(stored.raw).toString("base64"),
      ...(stored.sentinel !== undefined && { sentinel: stored.sentinel }),
    }
  }
  return {
    write: () => {},
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async (sequence, pattern) => outcome(sequence, pattern).match,
    queryWithSentinel: async (sequence, pattern) => outcome(sequence, pattern).match,
    queryOutcome: async (sequence, pattern) => outcome(sequence, pattern),
    queryWithSentinelOutcome: async (sequence, pattern) => outcome(sequence, pattern),
    queryMode: async () => null,
    cols: 80,
    rows: 24,
    ...defaults,
  }
}

export interface RegradeResult {
  readonly id: string
  readonly before: string | undefined
  readonly after: ObservationOutcome | undefined
  readonly moved: boolean
  readonly satisfies: boolean
}

/** Part 3 (runner) - re-grade one row through its probe and compare to the contract. */
export async function regradeRow(
  probe: ProbeDefinition,
  row: ContractRow,
  contexts: { readonly headless?: TermlessContext; readonly term?: TermContext },
): Promise<RegradeResult> {
  let result: ProbeResult | undefined
  if (probe.termless && contexts.headless !== undefined) result = probe.termless(contexts.headless)
  else if (probe.term && contexts.term !== undefined) result = await probe.term(contexts.term)
  const after = result?.observation?.outcome
  return {
    id: probe.id,
    before: undefined,
    after,
    moved: false,
    satisfies: satisfiesContract(row, after),
  }
}
