/**
 * @failure A group capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so a group step reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 SGR group (child 28019); the first adopter of the 28453 harness.
 * @testonly none
 */
import { expect, test } from "vitest"
import { sgrProbes } from "./sgr.ts"
import {
  contractGaps,
  headlessContext,
  regradeRow,
  type GroupContract,
  type HeadlessModel,
} from "./testing/group-harness.ts"

/** The 32 SGR capabilities of 28018's SGR row; ids drawn from sgr.ts, claims are the contract. */
const SGR_CONTRACT: GroupContract = [
  { id: "sgr.bold", expected: "decided", claim: "SGR 1 selects the bold attribute" },
  { id: "sgr.faint", expected: "decided", claim: "SGR 2 selects the faint attribute" },
  { id: "sgr.italic", expected: "decided", claim: "SGR 3 selects the italic attribute" },
  { id: "sgr.underline.single", expected: "decided", claim: "SGR 4 selects a single underline" },
  { id: "sgr.blink", expected: "decided", claim: "SGR 5 selects the blink attribute" },
  { id: "sgr.inverse", expected: "decided", claim: "SGR 7 selects inverse video" },
  { id: "sgr.hidden", expected: "decided", claim: "SGR 8 selects the hidden attribute" },
  { id: "sgr.strikethrough", expected: "decided", claim: "SGR 9 selects strikethrough" },
  { id: "sgr.overline", expected: "decided", claim: "SGR 53 selects overline" },
  { id: "sgr.reset", expected: "decided", claim: "SGR 0 clears every attribute" },
  { id: "sgr.fg.standard", expected: "decided", claim: "SGR 30-37 selects a standard foreground" },
  { id: "sgr.fg.bright", expected: "decided", claim: "SGR 90-97 selects a bright foreground" },
  { id: "sgr.fg.256", expected: "decided", claim: "SGR 38;5 selects a 256-colour foreground" },
  { id: "sgr.fg.truecolor", expected: "decided", claim: "SGR 38;2 selects a truecolor foreground" },
  { id: "sgr.fg.default", expected: "decided", claim: "SGR 39 restores the default foreground" },
  { id: "sgr.bg.standard", expected: "decided", claim: "SGR 40-47 selects a standard background" },
  { id: "sgr.bg.bright", expected: "decided", claim: "SGR 100-107 selects a bright background" },
  { id: "sgr.bg.256", expected: "decided", claim: "SGR 48;5 selects a 256-colour background" },
  { id: "sgr.bg.truecolor", expected: "decided", claim: "SGR 48;2 selects a truecolor background" },
  { id: "sgr.bg.default", expected: "decided", claim: "SGR 49 restores the default background" },
  { id: "sgr.underline.double", expected: "decided", claim: "SGR 21 selects a double underline" },
  { id: "sgr.underline.curly", expected: "decided", claim: "SGR 4:3 selects a curly underline" },
  { id: "sgr.underline.dotted", expected: "decided", claim: "SGR 4:4 selects a dotted underline" },
  { id: "sgr.underline.dashed", expected: "decided", claim: "SGR 4:5 selects a dashed underline" },
  { id: "sgr.underline.color", expected: "decided", claim: "SGR 58 selects an underline colour" },
  { id: "sgr.underline-color-indexed", expected: "decided", claim: "SGR 58;5 selects an indexed underline colour" },
  { id: "sgr.underline-color-rgb", expected: "decided", claim: "SGR 58;2 selects an RGB underline colour" },
  { id: "sgr.underline-color-reset", expected: "decided", claim: "SGR 59 resets the underline colour" },
  { id: "sgr.selective-reset.bold", expected: "decided", claim: "SGR 22 clears bold and faint only" },
  { id: "sgr.selective-reset.italic", expected: "decided", claim: "SGR 23 clears italic only" },
  { id: "sgr.selective-reset.underline", expected: "decided", claim: "SGR 24 clears underline only" },
  { id: "sgr.selective-reset.inverse", expected: "decided", claim: "SGR 27 clears inverse only" },
]

function inertModel(cols = 40): HeadlessModel {
  return {
    cols,
    feed: () => {},
    getCell: () => ({
      char: " ",
      bold: false,
      dim: false,
      italic: false,
      underline: null,
      strikethrough: false,
      inverse: false,
      hidden: false,
      blink: false,
      fg: null,
      bg: null,
      wide: false,
    }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
  }
}

test("the SGR contract covers every SGR capability and names none unknown", () => {
  const gaps = contractGaps(sgrProbes, SGR_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(sgrProbes).toHaveLength(32)
  expect(SGR_CONTRACT).toHaveLength(32)
})

test("every SGR capability is re-gradable through the harness and is deterministic", async () => {
  for (const row of SGR_CONTRACT) {
    const probe = sgrProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing SGR probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.termless !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { headless: headlessContext(inertModel()) })
    const second = await regradeRow(probe, row, { headless: headlessContext(inertModel()) })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
  }
})
