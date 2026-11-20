/**
 * @failure The window-basis table drifts from the retained traces — a cell is admitted for a pre-seed
 *   or a restore target nobody derived, and the drift only shows up mid-run as a ledger refusal that
 *   stops everything (@dev/brain e1b6910e1 review 2). Or the table's inputs move with every placed
 *   run, so each placement turns main red and each regeneration moves the suite (34682).
 * @level l1
 * @consumer 34148 folds 2 and 3: the generated admission table.
 * @reach none
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { WINDOW_BASIS_PRE_SEED } from "./window-basis-table.ts"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const FROZEN = join(ROOT, "test-fixtures", "window-basis", "inputs.json")

interface Frozen {
  revision: string
  sources: Array<{ path: string; entries: Array<{ key: string; sha256: string; raw: string }> }>
}

const check = (...extra: string[]) =>
  spawnSync("bun", ["scripts/generate-window-basis-table.ts", "--check", ...extra], { cwd: ROOT, encoding: "utf8" })

/** Write an altered copy of the frozen inputs and return its path. */
function alteredCopy(alter: (frozen: Frozen) => void): string {
  const frozen = JSON.parse(readFileSync(FROZEN, "utf8")) as Frozen
  alter(frozen)
  const path = join(mkdtempSync(join(tmpdir(), "window-basis-")), "inputs.json")
  writeFileSync(path, JSON.stringify(frozen))
  return path
}

/** The first frozen entry for a cell the committed table admits. */
function admittedEntry(frozen: Frozen) {
  const admitted = new Set(Object.keys(WINDOW_BASIS_PRE_SEED))
  for (const source of frozen.sources) {
    for (const entry of source.entries) {
      if (admitted.has(entry.key.replace(/\.[A-Za-z]+$/, ""))) return entry
    }
  }
  throw new Error("no frozen entry for an admitted cell")
}

describe("window basis table (#34148)", () => {
  test("the committed table is what the generator produces from the frozen traces", () => {
    const run = check()
    expect(run.stderr, "run bun scripts/generate-window-basis-table.ts and commit the result").not.toContain("is stale")
    expect(run.status, "the generator's --check exits 0").toBe(0)
  }, 30_000)

  test("the frozen inputs name the revision they were read at, and every entry its digest (34682)", () => {
    const frozen = JSON.parse(readFileSync(FROZEN, "utf8")) as Frozen
    expect(frozen.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(frozen.sources.length).toBeGreaterThan(0)
    for (const source of frozen.sources) expect(source.path).toMatch(/^content\/probes-apps\/.+\.json$/)
  })

  test("an unchanged copy of the frozen inputs derives the same table", () => {
    expect(
      check(
        "--inputs",
        alteredCopy(() => {}),
      ).status,
    ).toBe(0)
  }, 30_000)

  test("an edited entry whose digest no longer matches is refused, never read (34682)", () => {
    const run = check(
      "--inputs",
      alteredCopy((frozen) => {
        const entry = admittedEntry(frozen)
        entry.raw = `${entry.raw} `
      }),
    )
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("does not match its digest")
  }, 30_000)

  test("a re-frozen write that refuses the closed lists changes the derivation, so the check fails (34682)", () => {
    const run = check(
      "--inputs",
      alteredCopy((frozen) => {
        const entry = admittedEntry(frozen)
        const parsed = JSON.parse(entry.raw) as { writes: string[] }
        parsed.writes.push("\u001b7")
        entry.raw = JSON.stringify(parsed)
        entry.sha256 = createHash("sha256").update(entry.raw).digest("hex")
      }),
    )
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("is stale")
  }, 30_000)

  test("missing frozen inputs throw by path", () => {
    const run = check("--inputs", join(mkdtempSync(join(tmpdir(), "window-basis-")), "absent.json"))
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("frozen inputs missing at")
  }, 30_000)
})
