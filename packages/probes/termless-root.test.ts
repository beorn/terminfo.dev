/**
 * @failure A declared Termless checkout is ignored, a declaration that points nowhere is swallowed,
 *   or the refusal does not say where it looked.
 * @level l1
 * @consumer packages/probes/collect-headless.ts, packages/probes/headless-identity.ts
 * @reach tmpdir fixtures only
 * @testonly none
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { resolveTermlessRoot, TERMLESS_ROOT_ENV } from "./termless-root.ts"

let fixture: string
let saved: string | undefined

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "termless-root-"))
  saved = process.env[TERMLESS_ROOT_ENV]
  delete process.env[TERMLESS_ROOT_ENV]
})

afterEach(() => {
  if (saved === undefined) delete process.env[TERMLESS_ROOT_ENV]
  else process.env[TERMLESS_ROOT_ENV] = saved
  rmSync(fixture, { recursive: true, force: true })
})

function directory(name: string): string {
  const path = join(fixture, name)
  mkdirSync(path, { recursive: true })
  return realpathSync(path)
}

function warnings() {
  const lines: string[] = []
  return { lines, warn: (line: string) => lines.push(line) }
}

test("a declared checkout wins over the sibling path", () => {
  const root = directory("repo")
  directory("termless")
  const declared = directory("elsewhere/termless")
  process.env[TERMLESS_ROOT_ENV] = declared
  const { lines, warn } = warnings()

  expect(resolveTermlessRoot({ root, warn })).toBe(declared)
  expect(lines).toEqual([])
})

test("the sibling checkout works with nothing declared", () => {
  const root = directory("repo")
  const sibling = directory("termless")
  const { lines, warn } = warnings()

  expect(resolveTermlessRoot({ root, warn })).toBe(sibling)
  expect(lines).toEqual([])
})

test("a declared path that is absent warns by name and falls back to the sibling", () => {
  const root = directory("repo")
  const sibling = directory("termless")
  const missing = join(fixture, "typo", "termless")
  process.env[TERMLESS_ROOT_ENV] = missing
  const { lines, warn } = warnings()

  expect(resolveTermlessRoot({ root, warn })).toBe(sibling)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain(TERMLESS_ROOT_ENV)
  expect(lines[0]).toContain(missing)
  expect(lines[0]).toContain(sibling)
})

test("a declared path that is a file rather than a checkout warns and falls back", () => {
  const root = directory("repo")
  const sibling = directory("termless")
  const file = join(fixture, "not-a-checkout")
  writeFileSync(file, "")
  process.env[TERMLESS_ROOT_ENV] = file
  const { lines, warn } = warnings()

  expect(resolveTermlessRoot({ root, warn })).toBe(sibling)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain(file)
})

test("an empty declaration is the same as none and stays silent", () => {
  const root = directory("repo")
  const sibling = directory("termless")
  process.env[TERMLESS_ROOT_ENV] = "   "
  const { lines, warn } = warnings()

  expect(resolveTermlessRoot({ root, warn })).toBe(sibling)
  expect(lines).toEqual([])
})

test("a declared symlink resolves to the checkout it points at", () => {
  const root = directory("repo")
  const target = directory("real/termless")
  const link = join(fixture, "linked-termless")
  symlinkSync(target, link)
  process.env[TERMLESS_ROOT_ENV] = link
  const { lines, warn } = warnings()

  expect(resolveTermlessRoot({ root, warn })).toBe(target)
  expect(lines).toEqual([])
})

test("nothing anywhere refuses loudly, naming every location and the variable", () => {
  const root = directory("repo")
  const sibling = join(realpathSync(root), "..", "termless")

  expect(() => resolveTermlessRoot({ root, warn: () => {} })).toThrow(TERMLESS_ROOT_ENV)
  expect(() => resolveTermlessRoot({ root, warn: () => {} })).toThrow(sibling)
})
