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
