/**
 * @failure A region-readback kind row grades a correct terminal unsupported — or a wrong one supported — because its blank cells are compared against a single spelling and the fixture never meets a real parser.
 * @level l1
 * @consumer Region-readback kind rows (charsets, editing, erase, text) in the app/headless probe table.
 * @reach runs each kind row's parser arm on real xterm.js through the production headless context
 * @note the collector makes a FRESH backend per probe (`headless-batch.ts`:286), so a row's fixture
 * never inherits the previous row's terminal state and one row cannot mask another.
 * @testonly none
 */
import { createXtermBackend } from "@termless/xtermjs"
import {
  charsetReadbackRows,
  editingReadbackRows,
  eraseReadbackRows,
  regionReadbackProbes,
  textReadbackRows,
} from "@terminfo/probe-defs"
import { expect, test } from "vitest"
import { collectBatch } from "./headless-batch.ts"

/**
 * The four sequences xterm.js does NOT implement. Every other editing, erase and text kind row names
 * a sequence xterm.js DOES implement, so such a row that reads unsupported is the FIXTURE failing,
 * not the terminal — which is the shape must-fix 1 shipped: a blank spelled `" "` on one side only
 * graded 17 of these 24 rows unsupported against the four real backends @cto measured (@cto 28450
 * must-fix 1, 2026-10-12).
 */
const XTERM_ABSENT = ["editing.decfra", "editing.decera", "editing.decsera", "editing.deccra"]

test("every region-readback kind row grades its real xterm.js outcome", async () => {
  // Charsets joined this list under the 28450 row-61 review: its four kind rows carried the same
  // blank-cell and wide-follower shapes, but the barrel never exported them, so the must-fix-1
  // protection never reached them. They grade supported on xterm.js, measured here rather than assumed.
  const rows = [...charsetReadbackRows, ...editingReadbackRows, ...eraseReadbackRows, ...textReadbackRows]
  const batch = await collectBatch(async () => createXtermBackend(), "xtermjs", regionReadbackProbes(rows))
  const outcome = (id: string) => batch.observations.find((item) => item.featureId === id)?.outcome ?? `missing:${id}`
  // No row may be absent from the batch: a row with no observation is a fixture that never ran.
  expect(batch.observations.map((item) => item.featureId).toSorted()).toEqual(rows.map((row) => row.id).toSorted())
  expect(rows.map((row) => row.id).filter((id) => outcome(id) !== "supported")).toEqual(XTERM_ABSENT)
})
