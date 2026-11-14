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
 * Run: bun scripts/generate-window-basis-table.ts [--check]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TERM_FOOTPRINTS } from "../packages/probe-defs/src/term-footprints.ts"
import { WINDOW_BASIS_RULING_EXCLUSIONS } from "../packages/terminfo.dev/src/probes/window-basis-rulings.ts"
import { classifyWrite, touchedAttributes, attributeKey } from "../packages/terminfo.dev/src/probes/attribute-ledger.ts"

const ROOT = join(import.meta.dir, "..")
const TRACES = join(ROOT, "content", "probes-apps")
const OUT = join(ROOT, "packages", "terminfo.dev", "src", "probes", "window-basis-table.ts")

const windowCells = Object.entries(TERM_FOOTPRINTS)
  .filter(([, footprint]) => footprint === "window")
  .map(([id]) => id)
  .sort()

/** Every write event the retained traces hold for each cell, in file order. */
const writes = new Map<string, string[]>()
for (const file of readdirSync(TRACES).sort()) {
  if (!file.endsWith(".json")) continue
  let data: { rawReplies?: Record<string, unknown> }
  try {
    data = JSON.parse(readFileSync(join(TRACES, file), "utf8")) as { rawReplies?: Record<string, unknown> }
  } catch {
    continue
  }
  for (const [key, raw] of Object.entries(data.rawReplies ?? {})) {
    const cell = key.replace(/\.(trace|callLog|ledger|spillover|outerCommands|declarationCollision)$/, "")
    if (!windowCells.includes(cell) || typeof raw !== "string") continue
    let parsed: { writes?: unknown }
    try {
      parsed = JSON.parse(raw) as { writes?: unknown }
    } catch {
      continue
    }
    if (!Array.isArray(parsed.writes)) continue
    for (const write of parsed.writes) {
      if (typeof write !== "string") continue
      const list = writes.get(cell) ?? []
      list.push(write)
      writes.set(cell, list)
    }
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
 * The value a cell's cleanup write leaves, read off the write itself. `h` sets (1) and `l` resets (2),
 * which is what DECRPM answers with. Only mode writes can be read this way; a class whose final state
 * cannot be derived from its last write is refused at admission rather than guessed.
 */
function restoreTargetOf(write: string): string | undefined {
  const mode = /^\x1b\[\??[0-9;]+([hl])$/.exec(write)
  if (mode) return mode[1] === "h" ? "1" : "2"
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
  const { attributes, unclassified } = touchedAttributes(cellWrites)
  if (unclassified.length > 0) {
    // The counts carry the evidence and a specimen would only push the line past the formatter's width,
    // so the sentence stays short and the generated file stays formatter-stable.
    unclassifiable.set(
      cell,
      `write not classifiable until the tokenizer lands: ${unclassified.length} of ${cellWrites.length} retained writes are not one namable sequence`,
    )
    continue
  }
  // What the cell's own cleanup leaves behind, per attribute. A probe resets to the DEFAULT, not to the
  // state it found, so a terminal that starts non-default would make pre differ from post and the ledger
  // would stop the whole run. Admission therefore carries the target, and the caller refuses the cell by
  // name before its first byte when the terminal is not in that state (@dev/brain e1b6910e1 review 1).
  const restoresTo: Record<string, string> = {}
  let derivable = true
  for (const write of cellWrites) {
    const classification = classifyWrite(write)
    if ("unclassified" in classification) {
      derivable = false
      break
    }
    const target = restoreTargetOf(write)
    for (const attribute of classification.attributes) {
      if (target === undefined) {
        unclassifiable.set(
          cell,
          `cleanup target not derivable: the last write to ${attributeKey(attribute)} is not a mode set/reset, so the state it leaves cannot be read back and compared`,
        )
        admitted.delete(cell)
        derivable = false
        break
      }
      restoresTo[attributeKey(attribute)] = target
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
  " * `WINDOW_BASIS_UNCLASSIFIABLE` names each cell whose retained writes need the escape-sequence",
  " * tokenizer before they can be classified (@cto: no hand-written splitter, and a run-time",
  " * unclassifiable write is run-fatal, so the decision has to happen here).",
  " */",
  "",
  'import type { LedgerAttribute } from "./attribute-ledger.ts"',
  "",
  `export const WINDOW_BASIS_ADMITTED_COUNT = ${sortedAdmitted.length}`,
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

const generated = `${lines.join("\n")}`
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
      `excluded ${sortedUnclassifiable.length} needing the tokenizer, ` +
      `${Object.keys(WINDOW_BASIS_RULING_EXCLUSIONS).length} by ruling`,
  )
}
