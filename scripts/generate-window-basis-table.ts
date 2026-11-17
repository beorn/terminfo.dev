/**
 * Generate the window-basis pre-seed table from the retained traces.
 *
 * A window-scoped owner basis may only admit a cell whose restore it can prove. Proving it needs
 * every write the cell makes to be namable as ONE attribute-changing sequence, and today the ledger
 * names a sequence only when the whole write is that sequence (@cto 69ad9f37 and 0.29.2 ruling point
 * 2). So the admission decision is derived here, from evidence, once — not guessed at run time, where
 * an unclassifiable write would be run-fatal and stop the run.
 *
 * The derivation reuses `classifyWrite`'s anchored grammar as the "exactly one sequence" test: it
 * matches a whole string, so a write that carries two sequences or trailing text does not match and
 * is unclassified. That is why this script adds no parser of its own.
 *
 * Its inputs are FROZEN (34682): the exact window-cell trace entries it reads live in
 * test-fixtures/window-basis/inputs.json, each with its source path, the revision it was read at, and
 * digests. Placing a new run into content/probes-apps changes nothing here; the table, and the suite
 * id it feeds, move only when someone deliberately re-freezes (`--freeze <revision>`), and then the
 * fixture and the table change together in one commit. A missing, corrupt or edited input throws.
 *
 * Run: bun scripts/generate-window-basis-table.ts [--check | --freeze <git revision>] [--inputs <file>]
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { TERM_FOOTPRINTS } from "../packages/probe-defs/src/term-footprints.ts"
import { WINDOW_BASIS_RULING_EXCLUSIONS } from "../packages/terminfo.dev/src/probes/window-basis-rulings.ts"
import {
  classifyWrite,
  attributeKey,
  type LedgerAttribute,
} from "../packages/terminfo.dev/src/probes/attribute-ledger.ts"
import { classifyWindowWrite } from "../packages/terminfo.dev/src/probes/window-basis-writes.ts"

const ROOT = join(import.meta.dir, "..")
const TRACES = "content/probes-apps"
/** `--inputs <file>` reads another frozen set, so a test can show an altered copy fails the check. */
const inputsAt = process.argv.indexOf("--inputs")
const FIXTURE =
  inputsAt >= 0 && process.argv[inputsAt + 1] !== undefined
    ? (process.argv[inputsAt + 1] as string)
    : join(ROOT, "test-fixtures", "window-basis", "inputs.json")
const OUT = join(ROOT, "packages", "terminfo.dev", "src", "probes", "window-basis-table.ts")

const windowCells = Object.entries(TERM_FOOTPRINTS)
  .filter(([, footprint]) => footprint === "window")
  .map(([id]) => id)
  .sort()

const TRACE_KEY_SUFFIX = /\.(trace|callLog|ledger|spillover|outerCommands|declarationCollision)$/

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex")

/** One trace entry exactly as its source file held it: the derivation parses `raw` and nothing else. */
interface FrozenEntry {
  readonly key: string
  readonly sha256: string
  readonly raw: string
}
interface FrozenSource {
  readonly path: string
  /** sha256 of the whole source file at `revision`, so each entry traces back to the run it came from. */
  readonly sha256: string
  readonly entries: readonly FrozenEntry[]
}
interface FrozenInputs {
  readonly schema: 1
  readonly revision: string
  readonly note: string
  readonly sources: readonly FrozenSource[]
}

/** The string writes an entry holds, or the reason it holds none: not JSON, or no writes array. */
function entryWrites(raw: string): string[] | { readonly unreadable: string } {
  let parsed: { writes?: unknown }
  try {
    parsed = JSON.parse(raw) as { writes?: unknown }
  } catch (error) {
    return { unreadable: `not JSON (${(error as Error).message})` }
  }
  if (!Array.isArray(parsed.writes)) return { unreadable: "no writes array" }
  return parsed.writes.filter((write): write is string => typeof write === "string")
}

/**
 * The deliberate re-freeze: read content/probes-apps as committed at `revision` and keep every
 * window-cell entry that carries writes, in file order — the same selection the generator made when
 * it read the directory live. A file that is not JSON holds no entry and is counted out loud.
 */
function freeze(revision: string): FrozenInputs {
  const git = (...args: string[]): Buffer => {
    const run = spawnSync("git", args, { cwd: ROOT, maxBuffer: 1 << 30 })
    if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`)
    return run.stdout
  }
  const commit = git("rev-parse", "--verify", `${revision}^{commit}`).toString().trim()
  const files = git("ls-tree", "--name-only", commit, `${TRACES}/`)
    .toString()
    .split("\n")
    .filter((path) => path.endsWith(".json"))
    .sort()
  const sources: FrozenSource[] = []
  let notJson = 0
  let notWrites = 0
  for (const path of files) {
    const bytes = git("show", `${commit}:${path}`)
    let data: { rawReplies?: Record<string, unknown> }
    try {
      data = JSON.parse(bytes.toString("utf8")) as { rawReplies?: Record<string, unknown> }
    } catch {
      notJson++
      continue
    }
    const entries: FrozenEntry[] = []
    for (const [key, raw] of Object.entries(data.rawReplies ?? {})) {
      if (!windowCells.includes(key.replace(TRACE_KEY_SUFFIX, "")) || typeof raw !== "string") continue
      if (!Array.isArray(entryWrites(raw))) {
        // Such an entry contributed nothing when the generator read the directory live, so freezing
        // keeps that selection; the count is printed below.
        notWrites++
        continue
      }
      entries.push({ key, sha256: sha256(raw), raw })
    }
    if (entries.length > 0) sources.push({ path, sha256: sha256(bytes), entries })
  }
  console.log(
    `froze ${sources.length} of ${files.length} trace files at ${commit}` +
      (notJson > 0 ? `; ${notJson} file(s) were not JSON and hold no entry` : "") +
      (notWrites > 0 ? `; ${notWrites} window-cell entr(ies) held no readable writes and were left out` : ""),
  )
  return {
    schema: 1,
    revision: commit,
    note: "Frozen inputs of scripts/generate-window-basis-table.ts (34682). Re-freeze only on purpose, together with the table, in one commit.",
    sources,
  }
}

/** Load the frozen inputs, refusing a missing file, a wrong shape, an unsorted list or an edited entry. */
function loadFrozen(): FrozenInputs {
  let text: string
  try {
    text = readFileSync(FIXTURE, "utf8")
  } catch (error) {
    throw new Error(`frozen inputs missing at ${FIXTURE}: ${(error as Error).message}`)
  }
  const inputs = JSON.parse(text) as FrozenInputs
  if (inputs.schema !== 1 || typeof inputs.revision !== "string" || !Array.isArray(inputs.sources)) {
    throw new Error(`${FIXTURE} is not schema 1 frozen inputs`)
  }
  const paths = inputs.sources.map((source) => source.path)
  if (paths.some((path, index) => index > 0 && path <= (paths[index - 1] as string))) {
    throw new Error(`${FIXTURE}: sources must be unique and sorted by path, the order the derivation reads them in`)
  }
  for (const source of inputs.sources) {
    for (const entry of source.entries) {
      if (sha256(entry.raw) !== entry.sha256) {
        throw new Error(
          `${FIXTURE}: ${source.path} ${entry.key} does not match its digest; re-freeze instead of editing`,
        )
      }
      if (!windowCells.includes(entry.key.replace(TRACE_KEY_SUFFIX, ""))) {
        throw new Error(`${FIXTURE}: ${source.path} ${entry.key} is not a window cell's entry`)
      }
      const read = entryWrites(entry.raw)
      if (!Array.isArray(read)) throw new Error(`${FIXTURE}: ${source.path} ${entry.key} is ${read.unreadable}`)
    }
  }
  return inputs
}

const freezeAt = process.argv.indexOf("--freeze")
if (freezeAt >= 0) {
  const revision = process.argv[freezeAt + 1]
  if (revision === undefined || revision.startsWith("--")) throw new Error("--freeze needs a git revision")
  mkdirSync(dirname(FIXTURE), { recursive: true })
  writeFileSync(FIXTURE, `${JSON.stringify(freeze(revision), null, 1)}\n`)
}
const frozen = loadFrozen()

/** Every write event the frozen traces hold for each cell, in file order. */
const writes = new Map<string, string[]>()
for (const source of frozen.sources) {
  for (const entry of source.entries) {
    const cell = entry.key.replace(TRACE_KEY_SUFFIX, "")
    const read = entryWrites(entry.raw)
    // loadFrozen already refused an unreadable entry; this only narrows the type.
    if (!Array.isArray(read)) throw new Error(`${FIXTURE}: ${source.path} ${entry.key} is ${read.unreadable}`)
    const list = writes.get(cell) ?? []
    list.push(...read)
    writes.set(cell, list)
  }
}

/** Render one attribute as the object literal the generated table stores. */
function renderAttribute(attribute: { readonly kind: string }): string {
  const fields = Object.entries(attribute).map(([k, v]) => k + ": " + JSON.stringify(v))
  return "{ " + fields.join(", ") + " }"
}

interface Admitted {
  readonly preSeed: readonly { readonly kind: string }[]
  /** The state each attribute's LAST write leaves behind, as the readback reports it. */
  readonly restoresTo: Readonly<Record<string, string>>
}

/**
 * The EXPECTED value a cell's cleanup write leaves, read off the write itself. `h` sets (1) and `l`
 * resets (2), which is what DECRPM answers with; the bare SGR reset form names the default-rendition
 * target. Naming it proves nothing on its own: the live pre-read and post-read still decide whether
 * the terminal was in that state and came back to it, and a missing or different reply refuses the
 * cell. A class whose final state this script cannot name from its last write is refused at
 * admission rather than guessed.
 */
function restoreTargetOf(write: string): string | undefined {
  const mode = /^\x1b\[\??[0-9;]+([hl])$/.exec(write)
  if (mode) return mode[1] === "h" ? "1" : "2"
  // The SGR reset form leaves the default rendition, and the target exists to name what the ledger
  // should see back (SGR0, DECRQSS `m`). A terminal that serialises the default differently, or that
  // was not in it to begin with, refuses at the live read; this line does not assert either. Any
  // other SGR write sets a rendition this script cannot name from the bytes, and is refused.
  if (/^\x1b\[(?:0)?m$/.test(write)) return "0"
  return undefined
}
const admitted = new Map<string, Admitted>()
const unclassifiable = new Map<string, string>()
const noTrace: string[] = []

for (const cell of windowCells) {
  if (WINDOW_BASIS_RULING_EXCLUSIONS[cell] !== undefined) continue
  const cellWrites = writes.get(cell) ?? []
  if (cellWrites.length === 0) {
    noTrace.push(cell)
    continue
  }
  const classified = cellWrites.map((write) => classifyWindowWrite(write))
  const refusedCount = classified.filter((entry) => "unclassified" in entry).length
  if (refusedCount > 0) {
    const first = classified.find((entry) => "unclassified" in entry)
    const reason = first !== undefined && "unclassified" in first ? first.unclassified : "unknown"
    // The counts carry the evidence and a specimen would only push the line past the formatter width,
    // so the sentence stays short and the generated file stays formatter-stable.
    unclassifiable.set(
      cell,
      `write not on a closed list: ${refusedCount} of ${cellWrites.length} retained writes refuse because ${reason}`,
    )
    continue
  }
  const attributes: LedgerAttribute[] = []
  for (const entry of classified) {
    if ("unclassified" in entry) continue
    for (const attribute of entry.attributes) {
      if (!attributes.some((existing) => attributeKey(existing) === attributeKey(attribute))) attributes.push(attribute)
    }
  }
  // What the cell's own cleanup leaves behind, per attribute. A probe resets to the DEFAULT, not to the
  // state it found, so a terminal that starts non-default would make pre differ from post and the ledger
  // would stop the whole run. Admission therefore carries the target, and the caller refuses the cell by
  // name before its first byte when the terminal is not in that state (@dev/brain e1b6910e1 review 1).
  const restoresTo: Record<string, string> = {}
  let derivable = true
  for (const entry of classified) {
    if ("unclassified" in entry) continue
    for (const sequence of entry.attributeSequences) {
      const target = restoreTargetOf(sequence)
      const inner = classifyWrite(sequence)
      if ("unclassified" in inner) {
        derivable = false
        break
      }
      for (const attribute of inner.attributes) {
        if (target === undefined) {
          unclassifiable.set(
            cell,
            `cleanup target not derivable: the cell's last write to ${attributeKey(attribute)} leaves a post-state this table cannot name from the bytes, so it cannot be read back and compared`,
          )
          admitted.delete(cell)
          derivable = false
          break
        }
        restoresTo[attributeKey(attribute)] = target
      }
      if (!derivable) break
    }
    if (!derivable) break
  }
  if (!derivable) continue
  admitted.set(cell, {
    preSeed: [...attributes].sort((a, b) => attributeKey(a).localeCompare(attributeKey(b))),
    restoresTo: Object.fromEntries(Object.entries(restoresTo).sort(([a], [b]) => a.localeCompare(b))),
  })
}

if (noTrace.length > 0) {
  // A cell with a `window` footprint and no retained write is not admitted, and the exclusion table
  // must say why in its own words rather than this generator inventing a reason for it.
  throw new Error(`window cells with no retained trace and no exclusion: ${noTrace.join(", ")}`)
}

const sortedAdmitted = [...admitted].sort(([a], [b]) => a.localeCompare(b))
const sortedUnclassifiable = [...unclassifiable].sort(([a], [b]) => a.localeCompare(b))

const lines = [
  "/**",
  " * GENERATED by scripts/generate-window-basis-table.ts — do not edit by hand.",
  " *",
  " * What a window-scoped owner basis may admit, derived from the retained traces in content/probes-apps.",
  " * `WINDOW_BASIS_PRE_SEED` lists the attributes to read before a cell's first write, and",
  " * `WINDOW_BASIS_RESTORE_TARGET` the state that cell's own cleanup leaves; a cell absent",
  " * from both maps here, and from window-basis-rulings.ts, is not admitted at all.",
  " * `WINDOW_BASIS_UNCLASSIFIABLE` names each cell whose retained writes still refuse @cto's closed",
  " * lists after tokenization, with the exact cause (@cto: no hand-written splitter, and a run-time",
  " * unclassifiable write is run-fatal, so the decision has to happen here).",
  " */",
  "",
  'import type { LedgerAttribute } from "./attribute-ledger.ts"',
  "",
  "export const WINDOW_BASIS_PRE_SEED: Readonly<Record<string, readonly LedgerAttribute[]>> = {",
  ...sortedAdmitted.map(
    ([cell, entry]) =>
      `  ${JSON.stringify(cell)}: [${entry.preSeed.map((attribute) => renderAttribute(attribute)).join(", ")}],`,
  ),
  "}",
  "",
  "export const WINDOW_BASIS_RESTORE_TARGET: Readonly<Record<string, Readonly<Record<string, string>>>> = {",
  ...sortedAdmitted.map(
    ([cell, entry]) =>
      `  ${JSON.stringify(cell)}: { ${Object.entries(entry.restoresTo)
        .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
        .join(", ")} },`,
  ),
  "}",
  "",
  "export const WINDOW_BASIS_UNCLASSIFIABLE: Readonly<Record<string, string>> = {",
  // Key and sentence on separate lines, which is the shape the formatter leaves for a long entry.
  ...sortedUnclassifiable.flatMap(([cell, reason]) => [`  ${JSON.stringify(cell)}:`, `    ${JSON.stringify(reason)},`]),
  "}",
  "",
]

/**
 * The committed table has to be formatter-stable: the repo formats every changed file, so a generator
 * that emits layouts the formatter reflows turns the drift test red on bytes nobody edited. The repo's
 * own formatter and config decide the layout here instead of a width guess in this script.
 */
function formatLikeRepo(source: string): string {
  const binary = join(ROOT, "node_modules", ".bin", "oxfmt")
  const run = spawnSync(binary, ["--stdin-filepath", "window-basis-table.ts", "-c", join(ROOT, ".oxfmtrc.json")], {
    input: source,
    encoding: "utf8",
  })
  if (run.error !== undefined) throw new Error(`oxfmt could not run from ${binary}: ${run.error.message}`)
  if (run.status !== 0) throw new Error(`oxfmt exited ${String(run.status)}: ${run.stderr}`)
  return run.stdout
}

const generated = formatLikeRepo(`${lines.join("\n")}\n`)
if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8")
  if (current !== generated) {
    console.error(`${OUT} is stale: run bun scripts/generate-window-basis-table.ts`)
    process.exit(1)
  }
  console.log(`${OUT} is current`)
} else {
  writeFileSync(OUT, generated)
  console.log(
    `admitted ${sortedAdmitted.length} of ${windowCells.length} window cells; ` +
      `excluded ${sortedUnclassifiable.length} with a named cause, ` +
      `${Object.keys(WINDOW_BASIS_RULING_EXCLUSIONS).length} by ruling`,
  )
}
