/**
 * #37761 (@cto 9de3bba2, e81def55): an observer-only switch is recorded beside a run, never in the configuration that
 * names its context. Run f2781665's five iTerm2 prompt-mark cells were read through iTerm2's API server; they publish
 * that in words, the iTerm2 page names the switch, and the context key stays the one without it.
 *
 * @failure The five iTerm2 prompt-mark cells publish with no word that an observer-only switch read them, the
 *   terminal page omits the switch, or a supplement row naming an unknown run, feature or empty note builds silently.
 * @level l1
 * @consumer terminfo.dev /terminals/iterm2 and the osc133 feature pages (content/run-observers.json, #37761)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import { initializeRunDraft, KNOWN_OBSERVERS, type ProbeResult, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import * as currentResults from "../docs/data/current-results.ts"
import { loadFullProbes } from "../docs/data/probes.data.ts"
import { loadRunObservers } from "../docs/data/run-observers.ts"
import { countContexts, projectResults, projectedContextKey } from "../docs/data/selected-results.ts"

const CONTENT_DIR = join(import.meta.dirname, "..", "content")
const RUN = "f2781665ede724094f5f4011fee465bd"
const CELLS = [
  "extensions.osc133-a",
  "extensions.osc133-b",
  "extensions.osc133-c",
  "extensions.osc133-d",
  "extensions.semantic-prompts",
]

function loadStoredRunF2781665() {
  const catalogIds = Object.keys(loadFeatures(CONTENT_DIR))
  const suitePath = join(CONTENT_DIR, "suites", "97fc3aa22091.json")
  const suite = parseSuiteManifest(suitePath, readFileSync(suitePath, "utf8"))
  const runPath = join(CONTENT_DIR, "probes-apps", `iterm2-3.6.11-macos-${RUN}.json`)
  const parsed = parseRun(runPath, readFileSync(runPath, "utf8"), catalogIds, new Map([[suite.probeHash, suite]]))
  const projection = projectResults([parsed], catalogIds, { currentProbeHash: suite.probeHash }, [])
  const spy = vi.spyOn(currentResults, "loadCurrentResults").mockReturnValue({ projection })
  try {
    return loadFullProbes()
  } finally {
    spy.mockRestore()
  }
}

describe("run f2781665's observer switch", () => {
  const data = loadStoredRunF2781665()
  const key = Object.keys(data.selectedByBackend).find((name) =>
    Object.values(data.selectedByBackend[name]!.selected.featureResults).some((cell) => cell.origin.runId === RUN),
  )

  it("is selected for one context, keyed without the switch", () => {
    expect(key, "run f2781665 still supplies a published cell").toBeDefined()
    expect(data.selectedByBackend[key!]!.selected.subject).toMatchObject({ id: "iterm2", config: null })
  })

  it("puts its note on each of the five cells it read, and on no other cell", () => {
    const { note } = loadRunObservers(join(import.meta.dirname, "..", "content"), new Set(CELLS))[RUN]!
    const noted = Object.entries(data.notes[key!] ?? {}).flatMap(([id, text]) => (text.includes(note) ? [id] : []))
    expect(noted.sort()).toEqual(
      CELLS.filter((id) => data.selectedByBackend[key!]!.selected.featureResults[id]?.origin.runId === RUN).sort(),
    )
    expect(noted.length).toBe(5)
  })

  it("names the switch for the page beside the run's configuration", () => {
    expect(data.observers).toEqual({ [RUN]: ["iterm2: EnableAPIServer true"] })
  })
})

describe("loadRunObservers refuses by name", () => {
  const write = (body: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "terminfo-run-observers-"))
    mkdirSync(join(dir, "probes-apps"))
    writeFileSync(join(dir, "probes-apps", `iterm2-3.6.11-macos-${RUN}.json`), "{}")
    writeFileSync(join(dir, "run-observers.json"), JSON.stringify(body))
    return dir
  }
  const row = { observers: ["iterm2: EnableAPIServer true"], featureIds: [CELLS[0]], note: "read through the API" }
  it.each([
    ["an unknown run", { ["0".repeat(32)]: row }, "is not a stored run"],
    [
      "an unknown feature",
      { [RUN]: { ...row, featureIds: ["extensions.nope"] } },
      "names unknown feature extensions.nope",
    ],
    ["no observers", { [RUN]: { ...row, observers: [] } }, "needs a non-empty observers list"],
    ["no note", { [RUN]: { ...row, note: " " } }, "needs a note"],
  ])("%s", (_label, body, message) => {
    const dir = write(body)
    try {
      expect(() => loadRunObservers(dir, new Set(CELLS))).toThrow(message)
    } finally {
      // raw-delete-allow: only this test's own mkdtemp fixture.
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("run-level observers field (#37780, @cto e81def55)", () => {
  const catalogIds = ["device.primary-da"]
  const manifest: ProbeSuiteManifest & { schemaVersion: 4 } = {
    schemaVersion: 4,
    probeHash: "a".repeat(12),
    adapterVersion: "0.1.0",
    catalogIds,
    catalogEntrySha256: { "device.primary-da": "b".repeat(64) },
    probes: { term: catalogIds, mux: [], lib: [] },
  }
  const suites = new Map([[manifest.probeHash, manifest]])
  const buildRun = (runId: string, observers?: unknown) => {
    const draft = initializeRunDraft({
      runId,
      sourceRevision: "c".repeat(40),
      manifest,
      source: { kind: "live" },
      intendedSubject: { kind: "term", id: "iterm2", version: "3.6.11" },
    })
    const results: ProbeResult[] = [
      {
        featureId: "device.primary-da",
        status: "supported",
        attempt: { scope: "probe", startedAt: "2026-11-25T00:00:00.000Z" },
        tests: [
          {
            id: "criterion",
            status: "supported",
            attempt: { scope: "probe", startedAt: "2026-11-25T00:00:00.000Z" },
            assertionRefs: [0],
            rawReplyRef: "device.primary-da",
          },
        ],
        assertionType: "query_reply",
        rawReplyRef: "device.primary-da",
      },
    ]
    return {
      ...draft,
      subject: {
        kind: "term" as const,
        id: "iterm2",
        version: "3.6.11",
        os: "macos",
        osVersion: "26.6.2",
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      ...(observers !== undefined ? { observers } : {}),
      identity: "verified" as const,
      measuredAt: "2026-11-25T00:00:01.000Z",
      origin: { kind: "collector" as const },
      rawReplies: {
        "device.primary-da": JSON.stringify({
          writes: [],
          queries: [
            {
              sequence: "\x1b[c",
              timeoutMs: 2000,
              reason: "reply",
              raw: "\x1b[?62;c",
              rawBase64: Buffer.from("\x1b[?62;c").toString("base64"),
              match: ["\x1b[?62;c"],
            },
          ],
          events: [],
        }),
      },
      assertions: [
        {
          featureId: "device.primary-da",
          kind: "positive" as const,
          assertionType: "query_reply" as const,
          rawReplyRef: "device.primary-da",
          expected: "DA1 reply",
          observed: "\x1b[?62;c",
        },
      ],
      results,
    }
  }

  it("validates known observer switches and keeps the same subject key as a run without them", () => {
    const withoutSwitch = parseRun("without.json", JSON.stringify(buildRun("1".repeat(32))), catalogIds, suites)
    const withSwitch = parseRun(
      "with.json",
      JSON.stringify(buildRun("2".repeat(32), ["iterm2: EnableAPIServer true"])),
      catalogIds,
      suites,
    )
    expect(withoutSwitch.observers).toBeUndefined()
    expect(withSwitch.observers).toEqual(["iterm2: EnableAPIServer true"])
    expect(withSwitch.subject.config).toBeNull()

    const counts = countContexts([withoutSwitch, withSwitch])
    expect(counts.get("term:iterm2")?.size).toBe(1)
    expect(projectedContextKey(withSwitch.subject, counts.get("term:iterm2")?.size ?? 0)).toBe(
      projectedContextKey(withoutSwitch.subject, counts.get("term:iterm2")?.size ?? 0),
    )

    const projected = projectResults(
      [withoutSwitch, withSwitch],
      catalogIds,
      { currentProbeHash: manifest.probeHash },
      [],
    )
    expect(Object.keys(projected.contexts)).toEqual(["term:iterm2"])
    expect(projected.history["term:iterm2"]?.find((run) => run.runId === "2".repeat(32))?.observers).toEqual([
      "iterm2: EnableAPIServer true",
    ])

    const spy = vi.spyOn(currentResults, "loadCurrentResults").mockReturnValue({ projection: projected })
    try {
      const full = loadFullProbes()
      expect(full.observers["2".repeat(32)]).toEqual(["iterm2: EnableAPIServer true"])
      expect(full.observers["1".repeat(32)]).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it.each([
    [
      "an unknown observer switch",
      ["iterm2: CustomFlag true"],
      `unknown observer switch "iterm2: CustomFlag true"; allowed: ${KNOWN_OBSERVERS.join(", ")}`,
    ],
    ["an empty observers list", [], "observers must be a non-empty list of switch names"],
    [
      "duplicate observer switches",
      ["iterm2: EnableAPIServer true", "iterm2: EnableAPIServer true"],
      "observers cannot contain duplicates",
    ],
  ])("refuses %s by name", (_label, observers, message) => {
    expect(() =>
      parseRun("invalid.json", JSON.stringify(buildRun("3".repeat(32), observers)), catalogIds, suites),
    ).toThrow(message)
  })
})
