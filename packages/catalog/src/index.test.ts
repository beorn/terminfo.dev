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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, test, vi } from "vitest"
import {
  FEATURE_ENTRY_PROSE_DENYLIST,
  boundFeatureEntry,
  loadFeatures,
  loadFeatureEntryHashes,
  loadTerminals,
  type FeatureRecord,
} from "./index.ts"

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
  const declarations = JSON.parse(readFileSync(join(repoContent, "terminals.json"), "utf8")) as Record<
    string,
    { kind?: string }
  >
  expect(required(declarations, "ghostty").kind).toBe("term")
  expect(required(declarations, "ghostty-native").kind).toBe("lib")
  const terminals = loadTerminals(repoContent)
  expect(Object.keys(terminals).length).toBe(26)
  expect(required(terminals, "ghostty").label).toBe("Ghostty")
  expect(required(terminals, "ghostty").platforms).toEqual(["macos", "linux"])
  expect(required(terminals, "xterm").manifestBackend).toBeUndefined()
  // Operator 2026-10-21: the headless Ghostty cores carry the library's name; "Ghostty" is the app only.
  expect(required(terminals, "ghostty-native").label).toBe("libghostty-vt (native)")
  expect(required(terminals, "ghostty").headlessLabel).toBe("libghostty-vt (WASM)")
})

test("refuses a headless label the entry does not measure itself, or one that is not a non-empty string", () => {
  const entry = { label: "T", slug: "t", url: "u", description: "d", body: "b", headlessBackends: ["core"] }
  const stray = fixture("headless-stray", { "terminals.json": { t1: { ...entry, headlessLabel: "X" } } })
  expect(() => loadTerminals(stray)).toThrow(/t1.*"headlessLabel".*does not list "t1"/)
  for (const [name, value] of [
    ["typed", 7],
    ["empty", ""],
    ["nulled", null],
  ] as const) {
    const own = { ...entry, headlessBackends: ["t1"], headlessLabel: value }
    const path = fixture(`headless-${name}`, { "terminals.json": { t1: own } })
    expect(() => loadTerminals(path)).toThrow(/t1.*"headlessLabel" that is not a non-empty string/)
  }
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

// AC frozen whole-entry identity: normalized FeatureRecord drops these unknown fields and misses their edits.
test("hashes whole raw entries canonically while keeping unrelated features independent", () => {
  const base = { name: "A", slug: "a", body: "b", probe: "p", baseline: "x", unknown: { z: null, a: [" x", "y"] } }
  const hashes = (name: string, first: unknown, second: unknown = base) =>
    loadFeatureEntryHashes(fixture(name, { "features.json": { "a.one": first, "b.two": second } }))
  const original = hashes("hash-original", base)
  expect(
    hashes("hash-reordered", {
      unknown: { a: [" x", "y"], z: null },
      baseline: "x",
      probe: "p",
      body: "b",
      slug: "a",
      name: "A",
    }),
  ).toEqual(original)
  for (const [name, unknown] of [
    ["null-absent", { a: [" x", "y"] }],
    ["array-order", { z: null, a: ["y", " x"] }],
    ["string-bytes", { z: null, a: ["x", "y"] }],
  ] as const) {
    const changed = hashes(name, { ...base, unknown })
    expect(changed["a.one"]).not.toBe(original["a.one"])
    expect(changed["b.two"]).toBe(original["b.two"])
  }
})

// Hash-cache availability is required; valid-cache fixtures cannot expose a missing cache entry.
test("names the missing catalogue entry hash cache instead of returning an empty spread", () => {
  const dir = fixture("missing-hash-cache", {
    "features.json": { "a.one": { name: "A", slug: "a", body: "b", probe: "p", baseline: "x" } },
  })
  loadFeatures(dir)
  const get = Map.prototype.get
  const spy = vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, key) {
    return key === dir + "#feature-entry-hashes" ? undefined : get.call(this, key)
  })
  try {
    expect(() => loadFeatureEntryHashes(dir)).toThrow("feature-entry-hashes")
  } finally {
    spy.mockRestore()
  }
})

// #32037 AC1/AC2/AC4 (@cto d45ebed6): existing whole-entry hash tests only exercise unknown-field mutations and
// key reordering, so they miss prose keys still entering loadFeatureEntryHashes or a new FeatureRecord key landing
// without an explicit bind/denylist decision.
test("enumerates FeatureRecord keys against FEATURE_ENTRY_PROSE_DENYLIST and omits only denylisted prose keys from hashes", () => {
  const decisions = {
    name: true,
    slug: true,
    body: false,
    probe: true,
    baseline: true,
    url: true,
    tags: true,
    sequence: true,
    group: true,
    tier1: true,
    probeStatus: true,
    probeStatusReason: true,
  } satisfies Record<keyof FeatureRecord, boolean>
  expect(FEATURE_ENTRY_PROSE_DENYLIST).toEqual(["body"])
  const denylisted = new Set<string>(FEATURE_ENTRY_PROSE_DENYLIST)
  for (const [key, bound] of Object.entries(decisions)) {
    expect(!denylisted.has(key), key).toBe(bound)
  }
  const base: Record<string, unknown> = {
    name: "Bold (SGR 1)",
    slug: "bold",
    body: "Original body prose.",
    probe: "Send ESC[1m",
    baseline: "ecma-48",
    url: "/features/sgr/bold",
    tags: ["sgr"],
    sequence: "CSI 1 m",
    group: "sgr",
    tier1: "included",
    probeStatus: "supported",
    probeStatusReason: "reviewed",
    unknown: { kept: 1 },
  }
  expect(Object.keys(boundFeatureEntry(base)).sort()).toEqual(
    Object.keys(base)
      .filter((key) => !denylisted.has(key))
      .sort(),
  )
  const hashes = (name: string, entry: Record<string, unknown>) =>
    loadFeatureEntryHashes(fixture(name, { "features.json": { "sgr.bold": entry } }))["sgr.bold"]
  const original = hashes("prose-denylist-base", base)
  for (const proseKey of FEATURE_ENTRY_PROSE_DENYLIST) {
    expect(hashes(`prose-changed-${proseKey}`, { ...base, [proseKey]: `edited-${proseKey}` }), proseKey).toBe(original)
  }
  for (const [boundKey, nextValue] of [
    ["name", "Bold Updated"],
    ["slug", "bold-updated"],
    ["probe", "Send ESC[1;2m"],
    ["baseline", "vt100"],
    ["url", "/features/sgr/bold-2"],
    ["tags", ["sgr", "style"]],
    ["sequence", "CSI 2 m"],
    ["group", "style"],
    ["tier1", "excluded"],
    ["probeStatus", "unsupported"],
    ["probeStatusReason", "updated reason"],
    ["unknown", { kept: 2 }],
  ] as const) {
    expect(hashes(`bound-changed-${boundKey}`, { ...base, [boundKey]: nextValue }), boundKey).not.toBe(original)
  }
})
