/**
 * @failure A region-readback kind row grades a correct terminal unsupported — or a wrong one supported — because its blank cells are compared against a single spelling and the fixture never meets a real parser; or a whole family drops out of this test because its kind table stopped being reachable from the barrel.
 * @level l1
 * @consumer Region-readback kind rows (charsets, editing, erase, scrollback, text) in the app/headless probe table.
 * @reach runs each kind row's parser arm on real xterm.js through the production headless context
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/
 * @note the collector makes a FRESH backend per probe (`headless-batch.ts`:286), so a row's fixture
 * never inherits the previous row's terminal state and one row cannot mask another.
 * @testonly none
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createXtermBackend } from "@termless/xtermjs"
import * as probeDefs from "@terminfo/probe-defs"
import type { RegionReadbackRow } from "@terminfo/probe-defs"
import { expect, test, vi } from "vitest"
import { collectBatch } from "./headless-batch.ts"
import { mapSnapshotToCells } from "../terminfo.dev/src/darwin-terminal-text.ts"
import { textCellsFrame } from "../terminfo.dev/src/serve.ts"

// App callbacks share a screen; the fresh headless backends below cannot expose this failure.
// Use the real parser and strict mapper so a previous Unicode probe cannot become an ASCII read.
test("an ASCII region fixture prepares its screen before reading a preceding Unicode probe", async () => {
  const backend = createXtermBackend()
  backend.init({ rows: 24, cols: 80 })
  const encode = (text: string) => new TextEncoder().encode(text)
  backend.feed(encode("\x1b[H👨‍👩‍👧"))
  const probe = probeDefs.ALL_PROBES.find((entry) => entry.id === "erase.character")
  if (!probe?.term) throw new Error("Missing erase.character app callback")
  const context: probeDefs.TermContext = {
    rows: 24,
    cols: 80,
    captureKind: "text-cells",
    write: (bytes) => backend.feed(encode(bytes)),
    cells: async (checkpoint) => {
      const lines = backend.getLines().map((row) => row.map((cell) => cell.char || " ").join(""))
      const mapped = mapSnapshotToCells(lines, 80, 24, 0)
      const read =
        typeof mapped === "string"
          ? { status: "refused" as const, reason: mapped }
          : { status: "read" as const, app: "iterm2" as const, cells: mapped }
      return textCellsFrame(checkpoint, read, Date.now()).frame
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    readInput: async () => null,
  }
  try {
    await expect(probe.term(context)).resolves.toMatchObject({
      observation: { outcome: "supported", evidence: "text" },
    })
  } finally {
    backend.destroy()
  }
})

/**
 * Every kind table the package EXPORTS, discovered rather than hand-typed. The list used to be
 * hand-typed, and that is exactly how must-fix 1's protection skipped a family: the barrel's own
 * comment said "every kind row" while its export list was one short, so four charsets rows never met
 * a real parser (@cto 28450 row-61 review).
 */
const KIND_TABLES: readonly (readonly [string, readonly RegionReadbackRow[]])[] = Object.entries(
  probeDefs as Record<string, unknown>,
).filter(
  (entry): entry is [string, readonly RegionReadbackRow[]] => /ReadbackRows$/.test(entry[0]) && Array.isArray(entry[1]),
)

/** Every row of every exported kind table, so the batch below is the whole kind and never a sample of it. */
const KIND_ROWS: readonly RegionReadbackRow[] = KIND_TABLES.flatMap(([, table]) => [...table])

/**
 * The four sequences xterm.js does NOT implement. Every other kind row names a sequence xterm.js DOES
 * implement, so such a row that reads unsupported is the FIXTURE failing, not the terminal — which is
 * the shape must-fix 1 shipped: a blank spelled `" "` on one side only graded 17 of these rows
 * unsupported against the four real backends @cto measured (@cto 28450 must-fix 1, 2026-10-12).
 * The declaring family is named in each id, so a future absent sequence says which family it is in.
 */
const XTERM_ABSENT = ["editing.decfra", "editing.decera", "editing.decsera", "editing.deccra"]

async function collectOrigin(origin: probeDefs.ProbeDefinition) {
  const progress = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const batch = await collectBatch(async () => createXtermBackend(), "xtermjs", [origin])
    expect(progress.mock.calls.map(([chunk]) => String(chunk))).toEqual(["headless xtermjs probe modes.origin\n"])
    return batch
  } finally {
    progress.mockRestore()
  }
}

// Origin support requires the addressing effect, not just DECRPM recognition. The existing
// kind population previously omitted this definition, so exercise its real registry boundary.
test("origin addressing measures its margin prerequisite and binds the real parser grid", async () => {
  const origin = probeDefs.ALL_PROBES.find((probe) => probe.id === "modes.origin")
  if (!origin) throw new Error("Missing modes.origin registry definition")
  const batch = await collectOrigin(origin)
  expect(batch.observations).toMatchObject([
    { featureId: origin.id, outcome: "supported", evidence: "parser-state", rawReplyRef: origin.id },
  ])
  expect(batch.assertions).toMatchObject([{ featureId: origin.id, kind: "positive", rawReplyRef: origin.id }])
  const raw = batch.rawReplies[origin.id]
  if (!raw) throw new Error("Missing modes.origin raw grid measurement")
  const measured = JSON.parse(raw) as { before: string[][]; after: string[][] }
  expect(measured.before.map((row: string[]) => row[0])).toEqual(["A", "U", "C", "D", "E", "", "Z"])
  expect(measured.after.map((row: string[]) => row[0])).toEqual(["A", "U", "X", "D", "E", "", "Z"])
})

// These remove one operation from the real fixture, rather than teaching a fake parser the answer.
// They independently guard against a false positive and against grading an unproved prerequisite.
test.each([
  { missing: "DECOM", outcome: "unsupported", before: ["A", "U", "C", "D", "E", "", "Z"] },
  { missing: "DECSTBM", outcome: "inconclusive", before: ["A", "U", "B", "C", "D", "E", "Z"] },
])("origin addressing with missing $missing is $outcome", async ({ missing, outcome, before }) => {
  const row = probeDefs.modesReadbackRows.find((item) => item.id === "modes.origin")
  if (!row) throw new Error("Missing modes.origin kind row")
  const changed = {
    ...row,
    seed: missing === "DECSTBM" ? row.seed.replace("\x1b[3;6r", "") : row.seed,
    steps: row.steps.map((step) => ({
      ...step,
      write: missing === "DECOM" ? step.write.replace("\x1b[?6h", "") : step.write,
    })),
  }
  const [probe] = probeDefs.regionReadbackProbes([changed])
  if (!probe) throw new Error("Missing derived origin negative-control probe")
  const batch = await collectOrigin(probe)
  expect(batch.observations).toMatchObject([{ featureId: row.id, outcome, rawReplyRef: row.id }])
  const raw = batch.rawReplies[row.id]
  if (!raw) throw new Error("Missing origin negative-control raw grid")
  const measured = JSON.parse(raw) as { before: string[][]; after?: string[][] }
  expect(measured.before.map((cells: string[]) => cells[0])).toEqual(before)
  if (missing === "DECOM") {
    expect(measured.after?.map((cells: string[]) => cells[0])).toEqual(["X", "U", "C", "D", "E", "", "Z"])
    expect(batch.assertions).toMatchObject([{ kind: "negative", rawReplyRef: row.id }])
  } else {
    expect(batch.assertions).toEqual([])
  }
})

test("every region-readback kind row grades its real xterm.js outcome", async () => {
  // The collector reports progress on stderr. Consume only that expected diagnostic;
  // any other output remains a failure rather than disappearing into a blanket mock.
  const progress = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const batch = await collectBatch(
      async () => createXtermBackend(),
      "xtermjs",
      probeDefs.regionReadbackProbes(KIND_ROWS),
    )
    expect(progress.mock.calls.map(([chunk]) => String(chunk))).toEqual(
      KIND_ROWS.map((row) => `headless xtermjs probe ${row.id}\n`),
    )
    const outcome = (id: string) => batch.observations.find((item) => item.featureId === id)?.outcome ?? `missing:${id}`
    // No row may be absent from the batch: a row with no observation is a fixture that never ran.
    expect(batch.observations.map((item) => item.featureId).toSorted()).toEqual(
      KIND_ROWS.map((row) => row.id).toSorted(),
    )
    expect(KIND_ROWS.map((row) => row.id).filter((id) => outcome(id) !== "supported")).toEqual(XTERM_ABSENT)
  } finally {
    progress.mockRestore()
  }
})

test("every kind table the probe-defs source declares is reachable here, so no family is left out", () => {
  // The authority is the SOURCE that declares the tables, not this file's own reference to them. A
  // table added by a family and never exported from the barrel is invisible to the test above, which
  // is a silent gap — the exact shape of the charsets omission. Reading a declared-but-absent src
  // tree throws (NO SILENT ERRORS) rather than reading as an empty, passing population.
  const srcRoot = fileURLToPath(new URL("../probe-defs/src", import.meta.url))
  const declared = readdirSync(srcRoot, { encoding: "utf8", recursive: true })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .flatMap((file) =>
      [...readFileSync(join(srcRoot, file), "utf8").matchAll(/^export const (\w+ReadbackRows)\b/gmu)].map(
        (match) => match[1],
      ),
    )
  expect(declared.length, "the probe-defs source declares at least one kind table").toBeGreaterThan(0)
  // Both directions: a declared table that is not exported silently narrows the batch above, and an
  // exported name with no declaration behind it is a stale export.
  expect(declared.toSorted()).toEqual(KIND_TABLES.map(([name]) => name).toSorted())
})
