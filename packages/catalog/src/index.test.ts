/**
 * @failure features.json and terminals.json could drift back into per-reader parses: 17 non-test files
 *   read features.json and 14 read terminals.json through their own JSON.parse, so a catalog shape change
 *   would land in one reader and be missed in the others, and a malformed entry would throw in one place
 *   and be silently accepted in another (@cto verdict 2026-10-12, read-side consolidation item 2).
 * @level l2
 * @consumer the `loadFeatures` and `loadTerminals` exports of @terminfo/catalog, imported by the docs/
 *   route generators and the scripts/ readers
 * @testonly none
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, test } from "vitest"
import { loadFeatures, loadTerminals } from "./index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const repoContent = join(here, "..", "..", "..", "content")

const scratch = mkdtempSync(join(tmpdir(), "terminfo-catalog-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function fixture(name: string, files: Record<string, unknown>): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), JSON.stringify(body))
  return dir
}

/**
 * A catalog is `Readonly<Record<string, T>>`, so reading one key is `T | undefined`. A key the live
 * catalog does not have is a failed expectation about the catalog, never a type to work around:
 * name it and fail.
 */
function required<T>(catalog: Readonly<Record<string, T>>, key: string): T {
  const entry = catalog[key]
  if (entry === undefined) throw new Error(`catalog has no entry "${key}"`)
  return entry
}

test("reads the live feature catalog: 273 entries, each with the five required fields", () => {
  const features = loadFeatures(repoContent)
  const ids = Object.keys(features)
  expect(ids.length).toBe(273)
  for (const id of ids) {
    const entry = required(features, id)
    expect(typeof entry.name).toBe("string")
    expect(entry.name.length).toBeGreaterThan(0)
    expect(entry.slug.length).toBeGreaterThan(0)
    expect(entry.body.length).toBeGreaterThan(0)
    expect(entry.probe.length).toBeGreaterThan(0)
    expect(entry.baseline.length).toBeGreaterThan(0)
  }
  expect(required(features, "sgr.bold").name).toBe("Bold (SGR 1)")
})

test("reads the live terminal catalog: 26 entries, each with the five required fields", () => {
  const terminals = loadTerminals(repoContent)
  expect(Object.keys(terminals).length).toBe(26)
  expect(required(terminals, "ghostty").label).toBe("Ghostty")
  expect(required(terminals, "ghostty").platforms).toEqual(["macos", "linux"])
  expect(required(terminals, "xterm").manifestBackend).toBeUndefined()
})

test("drops $-prefixed comment keys and keeps the entry order of the file", () => {
  const dir = fixture("comment", {
    "features.json": { $comment: "ignored", "a.one": { name: "A", slug: "a", body: "b", probe: "p", baseline: "x" } },
  })
  expect(Object.keys(loadFeatures(dir))).toEqual(["a.one"])
})

test("throws naming the file and the entry when a required field is missing or empty", () => {
  const dir = fixture("missing", {
    "features.json": { "a.one": { name: "", slug: "a", body: "b", probe: "p", baseline: "x" } },
  })
  expect(() => loadFeatures(dir)).toThrow(/features\.json.*a\.one.*"name"/)
})

test("throws when an optional field carries the wrong type", () => {
  const dir = fixture("badtype", {
    "terminals.json": { t1: { label: "T", slug: "t", url: "u", description: "d", body: "b", year: "1999" } },
  })
  expect(() => loadTerminals(dir)).toThrow(/t1.*"year"/)
})

test("throws when a required catalog file is absent", () => {
  const dir = fixture("empty", {})
  expect(() => loadFeatures(dir)).toThrow(/Missing required content catalog/)
})

test("refuses a relative content directory rather than guessing one", () => {
  expect(() => loadFeatures("content")).toThrow(/must be absolute/)
})

test("parses a directory once: the second call returns the same frozen object", () => {
  const first = loadFeatures(repoContent)
  expect(loadFeatures(repoContent)).toBe(first)
  expect(Object.isFrozen(first)).toBe(true)
})
