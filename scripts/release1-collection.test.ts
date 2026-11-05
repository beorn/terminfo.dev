/**
 * @failure The Release 1 re-collection would silently drop a context that has no route (Windows, or
 *   an engine the Termless manifest stops exporting), hand a row a launcher flag the launcher does
 *   not accept (kitty takes `--preset baseline|current`, never the launcher's default, and a
 *   clipboard override names a profile the launcher declares), or lose a private run's actual
 *   suite, source, delegated identity or collection attempt. Missing routes remain named.
 *   Collector output failures must retain the pass ledger and raw files already collected.
 * @level l2
 * @consumer Private collection census, custody and attempt reporting (scripts/release1-collection.ts)
 * @reach fs-walk vendor/terminfo.dev/content/** vendor/terminfo.dev/.github/workflows/**
 * @testonly none
 */
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import * as childProcesses from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { afterAll, describe, expect, it, vi } from "vitest"
import { parse, stringify } from "yaml"
import * as catalog from "@terminfo/catalog"
import { parseJsonStrict, parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import * as versions from "../packages/admin/versions.ts"
import * as headless from "../packages/probes/collect-headless.ts"
import { saveDaemonProbeRun } from "../packages/terminfo.dev/src/daemon-client.ts"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import {
  ENVIRONMENT_GROUP_IDS,
  initializeRunDraft,
  SOURCE_NEGATIVE_REVIEW,
  textQualificationFixtures,
  readCollectorSelection,
  readCollectorAttempt,
  type RunDraft,
  type CapturedRunDraft,
} from "@terminfo/probe-defs"
import {
  collectPass,
  ownedAppCommand,
  ownedAppRunsDirectory,
  readOwnedAppTransportProof,
  release1Census,
  type CollectionContext,
} from "./release1-collection.ts"

// Standalone checkouts have no superproject inputs; retain real hashing over private fixture bytes.
const fingerprintFixture = await vi.hoisted(async () => {
  const fs = await import("node:fs")
  const { join, resolve, dirname } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const { fileURLToPath } = await import("node:url")
  const directory = fs.mkdtempSync(join(tmpdir(), "collection-fingerprint-"))
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const files = Object.fromEntries(
    ["bun.lock", "flake.lock", "flake.nix"].map((name) => {
      const fixture = join(directory, name)
      fs.writeFileSync(fixture, `private collection fingerprint fixture: ${name}\n`)
      return [resolve(root, "../..", name), fixture]
    }),
  )
  return { directory, files }
})
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    readFileSync: ((
      path: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1],
    ) => {
      const input = typeof path === "string" ? (fingerprintFixture.files[path] ?? path) : path
      return options === undefined ? actual.readFileSync(input) : actual.readFileSync(input, options)
    }) as typeof actual.readFileSync,
  }
})
afterAll(() => rmSync(fingerprintFixture.directory, { recursive: true, force: true }))

// Replace only the external terminal process owner; parsing and classification remain real.
vi.mock("../packages/probes/collect-headless.ts", () => ({ collectHeadlessRuns: vi.fn() }))
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

/** The five Linux app rows the launcher serves, in the bar's order. */
const LINUX_APP_IDS = ["kitty", "ghostty", "wezterm", "alacritty", "xterm"] as const

const census = (engineBackends: readonly string[] = ENGINE_BACKENDS) => release1Census(engineBackends)

/** The committed corpus this repository ships, as the CLI reads it. */
const CONTENT = join(dirname(fileURLToPath(import.meta.url)), "..", "content")
// Recorded xterm.js identity only; current test runs start with explicit TODO results.
// No historical outcomes or inferred provenance are promoted into current measurements.
const specimen = {
  subject: {
    kind: "lib",
    id: "xtermjs",
    version: "6.0.0",
    os: "linux",
    osVersion: "7.0.0-34-generic",
    outerTerminal: null,
    mux: null,
    config: "80x24 default Termless backend",
    permissions: null,
  },
  measuredAt: "2026-10-11T00:54:25.889Z",
  runtimeIdentity: {
    kind: "js",
    adapterVersion: "0.10.2",
    termlessRevision: "4b39770c169ec393cfd6ec7f59110e91c9c9d0c5",
    resolvedPath: "node_modules/.bun/@xterm+headless@6.0.0/node_modules/@xterm/headless/lib-headless/xterm-headless.js",
    integrity: {
      kind: "registry",
      lockIntegrity: "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
    },
    runtimeFormat: "js",
    engineVersion: "6.0.0",
  },
} as const
const currentManifestPath = join(CONTENT, "suites", "4b01b0117e18.json")
const currentManifest = parseSuiteManifest(currentManifestPath, readFileSync(currentManifestPath, "utf8"))
if (currentManifest.schemaVersion !== 4 || !currentManifest.catalogIds) {
  throw new Error("Collection fixture requires the committed schema-4 catalogue")
}

/** The Termless manifest's engine names, as a fixture: the census takes them in, it never guesses. */
const ENGINE_BACKENDS = [
  "alacritty",
  "ghostty",
  "ghostty-native",
  "kitty",
  "libvterm",
  "vt100",
  "vt100-rust",
  "vt220",
  "vterm",
  "wezterm",
  "xtermjs",
]

// Refusal must precede filesystem effects; census and private-success cases never used repository output.
it("refuses repository output before creating any directory", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "collection-output-refusal-"))
  const repositoryScratch = join(dirname(CONTENT), basename(scratch))
  const output = join(repositoryScratch, "not-created")
  try {
    expect(existsSync(repositoryScratch)).toBe(false)
    await expect(collectPass(output)).rejects.toThrow(/output must be private, outside the source repository/)
    expect(existsSync(repositoryScratch)).toBe(false)
  } finally {
    // Only this fixture's unique scratch path; no source input is edited or removed.
    rmSync(repositoryScratch, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

// The census-only cases cannot prove that collection preserves its shared owner's resource error.
it("propagates an unsupported catalog kind from the census owner before dispatch", async () => {
  const terminals = { ...catalog.loadTerminals(CONTENT) }
  const kitty = terminals.kitty
  if (!kitty) throw new Error("The committed catalog fixture must contain kitty")
  terminals.kitty = { ...kitty }
  Reflect.set(terminals.kitty, "kind", "unsupported-fixture")
  const load = vi.spyOn(catalog, "loadTerminals").mockReturnValue(terminals)
  const directory = mkdtempSync(join(tmpdir(), "collection-unsupported-kind-"))
  const collector = vi.mocked(headless.collectHeadlessRuns)
  collector.mockClear()
  try {
    await expect(collectPass(directory)).rejects.toThrow(
      'kitty: kind "unsupported-fixture" is not a term, mux or lib subject',
    )
    expect(collector).not.toHaveBeenCalled()
  } finally {
    load.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

// The dispatch boundary must use the CURRENT in-memory suite, even when the corpus already
// declares the returned run's old suite. Projection parity does not cover this collection seam.
it.each([
  ["different", "none"],
  ["matching", "none"],
  ["matching", "rewrite"],
  ["matching", "remove"],
  ["matching", "blocked-hosted"],
  ["matching", "blocked-macos"],
  ["matching", "text-qualified"],
  ["matching", "text-missing"],
  ["matching", "text-modified"],
  ["matching", "selected"],
  ["matching", "hosted-selected"],
  ["matching", "hosted-one-os"],
  ["matching", "hosted-contexts"],
  ["matching", "hosted-census-one"],
  ["matching", "hosted-ref-main"],
  ["matching", "hosted-ref-tag"],
  ["matching", "hosted-ref-collision"],
  ["matching", "hosted-ref-lightweight-tag"],
  ["matching", "hosted-ref-missing"],
  ["matching", "hosted-ref-mismatch"],
  ["matching", "cohort-active-queued"],
  ["matching", "cohort-active-in_progress"],
  ["matching", "cohort-active-requested"],
  ["matching", "cohort-active-waiting"],
  ["matching", "cohort-active-pending"],
  ["matching", "cohort-active-pagination"],
  ["matching", "cohort-source-mismatch"],
  ["matching", "cohort-completed"],
  ["matching", "cohort-failed-watch"],
  ["matching", "cohort-failed-timing"],
  ["matching", "cohort-invalid-jobs"],
  ["matching", "cohort-wrong-run"],
  ["matching", "cohort-wrong-attempt"],
  ["matching", "cohort-wrong-source"],
  ["matching", "cohort-wrong-ref"],
  ["matching", "cohort-wrong-event"],
  ["matching", "cohort-wrong-workflow"],
  ["matching", "completed-collector-error"],
  ["matching", "empty-selection"],
  ["matching", "linux-prestart"],
  ["matching", "linux-poststart"],
  ["matching", "linux-poststart-capture"],
  ["matching", "linux-poststart-final"],
  ["matching", "linux-poststart-artifact"],
  ["matching", "macos-poststart"],
  ["matching", "macos-prestart"],
  ["matching", "macos-untrusted"],
  ["matching", "empty-probes"],
] as const)(
  "retains a private %s-suite foreign-attempt artifact after %s without current admission",
  async (suite, inputChange) => {
    const cohort = inputChange.startsWith("cohort-")
    const directory = mkdtempSync(join(tmpdir(), "terminfo-development-pass-"))
    const input = join(directory, "suite-input.ts")
    writeFileSync(input, "original private suite input")
    const original = join(directory, "original-current-run.json")
    const draft = initializeRunDraft({
      runId: "foreign-retained-attempt",
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirname(CONTENT), encoding: "utf8" }).trim(),
      manifest: { ...currentManifest, schemaVersion: 4 },
      source: { kind: "live" },
      intendedSubject: { kind: "lib", id: "xtermjs" },
    })
    Object.assign(draft, specimen, { identity: "unverified", origin: { kind: "collector" } })
    const raw = finalizeCollectedDraft(draft as CapturedRunDraft)
    const bytes = JSON.stringify(raw)
    writeFileSync(original, bytes)
    const originalBytes = readFileSync(original, "utf8")
    const sourceRef =
      inputChange === "hosted-ref-tag" || inputChange === "hosted-ref-lightweight-tag"
        ? "fixture-tag"
        : inputChange.startsWith("hosted-ref-") || cohort
          ? "main"
          : undefined
    const catalogSelection =
      inputChange === "hosted-census-one"
        ? vi
            .spyOn(catalog, "loadTerminals")
            .mockReturnValue(
              Object.fromEntries(
                Object.entries(catalog.loadTerminals(CONTENT)).map(([id, terminal]) => [
                  id,
                  id === "terminal-app" ? terminal : { ...terminal, historical: true },
                ]),
              ),
            )
        : undefined
    const textCase = inputChange.startsWith("text-")
    // A current writer snapshot supplies this synthetic tree; no historical declaration is enriched.
    const currentSnapshot = versions.probeSuiteSnapshot()
    const snapshot =
      suite !== "different"
        ? vi.spyOn(versions, "probeSuiteSnapshot").mockReturnValue({
            ...currentSnapshot,
            probeHash: raw.probeHash,
            sourcePaths: [relative(dirname(CONTENT), input)],
          })
        : undefined
    let completedDraftBytes: string | undefined
    const collector = vi
      .spyOn(headless, "collectHeadlessRuns")
      .mockImplementation(async (_selectors, output, initializations) => {
        if (!output) throw new Error("collection requires a private output directory")
        mkdirSync(output, { recursive: true })
        const raw = join(output, "xtermjs.json")
        writeFileSync(raw, bytes)
        if (inputChange === "completed-collector-error") {
          const handed = initializations?.get("xtermjs")
          if (!handed) throw new Error("Expected delegated headless draft")
          handed.draft.rawReplies["collector.collectionAttempt"] = JSON.stringify({
            ids: ["sgr.bold"],
            startedAt: "2026-10-29T07:01:02.000Z",
            result: "completed",
            hostInputs: { "pixel-geometry": "not-supplied" },
          })
          completedDraftBytes = JSON.stringify(handed.draft)
          writeFileSync(handed.path, completedDraftBytes)
        }
        // Use a private source canary: the failure must not delete or rewrite a real checkout input.
        if (inputChange === "remove") rmSync(input)
        if (inputChange === "rewrite") writeFileSync(input, "changed private suite input")
        if (inputChange === "blocked-hosted") writeFileSync(join(dirname(output), "hosted"), "private obstruction")
        if (inputChange === "blocked-macos") {
          mkdirSync(join(dirname(output), "hosted"))
          writeFileSync(join(dirname(output), "hosted", "macos"), "private obstruction")
        }
        return { directory: output, requested: ENGINE_BACKENDS, runs: [raw], failures: [] }
      })
    // The real launcher owns containers and receipts. Its process boundary is replaced here;
    // a failed Kitty launch and other malformed raw outputs must remain separate, retained failures.
    let actualRoutePath: string | undefined
    let actualRouteBytes: string | undefined
    let actualRouteRunId: string | undefined
    let launcherErrorPath: string | undefined
    let launcherErrorBytes: string | undefined
    const actualStartedAt = "2026-10-29T07:01:02.000Z"
    const actualError = "original Linux fixture collector failure"
    const macosContexts = ["ghostty", "cursor", "com.microsoft.VSCode", "cmux", "alacritty", "wezterm"]
    const hostedDrafts = new Map<string, { path: string; bytes: string }>()
    const launcher = vi.spyOn(childProcesses, "spawnSync").mockImplementation((command, args, options) => {
      if (!Array.isArray(args)) throw new Error("expected explicit Linux launcher argv")
      const stdio = options?.stdio
      const respond = (stdout: string, status = 0) => {
        if (Array.isArray(stdio) && typeof stdio[1] === "number") writeSync(stdio[1], stdout)
        return { pid: 1, output: [], stdout: "", stderr: "", status, signal: null }
      }
      if (inputChange === "linux-prestart" && command === "bash") return respond("prerequisite failed", 1)
      if (inputChange.startsWith("linux-poststart") && command === "bash") {
        const output = args.at(-1)
        if (typeof output !== "string") throw new Error("Expected Linux fixture output")
        const draftPath = join(dirname(dirname(output)), "term-alacritty-linux.draft.json")
        const draft = JSON.parse(readFileSync(draftPath, "utf8")) as RunDraft
        actualRouteRunId = draft.runId
        expect(options?.env?.TERMINFO_CAPTURE_RUN_ID).toBe(draft.runId)
        expect(options?.env?.TERMINFO_SOURCE_REVISION).toBe(draft.sourceRevision)
        expect(readCollectorSelection(draft.rawReplies)).toEqual({ ids: ["sgr.bold"] })
        draft.rawReplies["collector.collectionAttempt"] = JSON.stringify({
          ids: ["sgr.bold"],
          result: "failed",
          startedAt: actualStartedAt,
          error: actualError,
        })
        draft.rawReplies["collector.failure"] = actualError
        const raw = join(output, "fixture-run", "raw")
        mkdirSync(join(raw, "artifacts"), { recursive: true })
        actualRoutePath = join(
          raw,
          inputChange === "linux-poststart-capture"
            ? "v3-capture.json"
            : inputChange === "linux-poststart-final"
              ? "v3-run.json"
              : inputChange === "linux-poststart-artifact"
                ? `artifacts/${draft.runId}.draft.json`
                : "v3-run.draft.json",
        )
        actualRouteBytes = JSON.stringify(draft)
        writeFileSync(actualRoutePath, actualRouteBytes)
        if (inputChange === "linux-poststart-artifact") {
          // Failed HTTP captures retain the delegated producer draft beside their error response.
          launcherErrorPath = join(raw, "v3-capture.json")
          launcherErrorBytes = JSON.stringify({ name: "Error", error: actualError })
          writeFileSync(launcherErrorPath, launcherErrorBytes)
        }
        return respond("fixture collector started then failed", 17)
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") return respond(sourceRef ? "" : "fixture-collection\n", sourceRef ? 1 : 0)
        if (args[0] === "ls-remote") {
          const refs =
            inputChange === "hosted-ref-tag"
              ? [`${"f".repeat(40)}\trefs/tags/fixture-tag`, `${raw.sourceRevision}\trefs/tags/fixture-tag^{}`]
              : inputChange === "hosted-ref-lightweight-tag"
                ? [`${raw.sourceRevision}\trefs/tags/fixture-tag`]
                : inputChange === "hosted-ref-collision"
                  ? [`${"e".repeat(40)}\trefs/tags/main`, `${raw.sourceRevision}\trefs/heads/main`]
                  : inputChange === "hosted-ref-missing"
                    ? []
                    : [
                        `${inputChange === "hosted-ref-mismatch" || inputChange === "cohort-source-mismatch" ? "0".repeat(40) : raw.sourceRevision}\trefs/heads/${sourceRef ?? "fixture-collection"}`,
                      ]
          return respond(refs.filter((line) => args.includes(line.split("\t")[1])).join("\n") + "\n")
        }
        throw new Error(`unexpected Git command ${args.join(" ")}`)
      }
      if (command === "gh") {
        if (args[0] === "api") {
          expect(args).toContain("--paginate")
          expect(args).toContain("--slurp")
          const endpoint = args.find((argument) => String(argument).startsWith("repos/"))
          expect(endpoint).toContain("repos/beorn/terminfo.dev/actions/workflows/macos-measurement.yml/runs?")
          const query = new URLSearchParams(String(endpoint).split("?")[1])
          expect(query.get("branch")).toBe("main")
          expect(query.get("per_page")).toBe("100")
          expect(query.has("head_sha")).toBe(false)
          const status = query.get("status")
          const active =
            inputChange === `cohort-active-${status}` ||
            (inputChange === "cohort-active-pagination" && status === "pending")
          const pages = [
            { workflow_runs: [] },
            { workflow_runs: active ? [{ id: 8000, status, head_sha: "a".repeat(40) }] : [] },
          ]
          return respond(JSON.stringify(pages))
        }
        if (args[0] === "workflow") {
          return respond(
            `https://github.com/beorn/terminfo.dev/actions/runs/${args[2] === "macos-measurement.yml" ? "9001" : "9002"}\n`,
          )
        }
        const mac = args[2] === "9001"
        if (args[1] === "view") {
          const timing = args.includes("--attempt")
          if (timing && inputChange === "cohort-failed-timing") {
            if (Array.isArray(stdio) && typeof stdio[2] === "number") writeSync(stdio[2], "timing API unavailable")
            return respond("timing query failed", 1)
          }
          return respond(
            JSON.stringify({
              headSha:
                suite === "different" || (timing && inputChange === "cohort-wrong-source")
                  ? "0".repeat(40)
                  : raw.sourceRevision,
              headBranch: timing && inputChange === "cohort-wrong-ref" ? "other" : (sourceRef ?? "fixture-collection"),
              event: timing && inputChange === "cohort-wrong-event" ? "push" : "workflow_dispatch",
              workflowName:
                timing && inputChange === "cohort-wrong-workflow"
                  ? "other"
                  : mac
                    ? "macos-measurement"
                    : "windows-measurement",
              ...(cohort && {
                databaseId: timing && inputChange === "cohort-wrong-run" ? 9009 : 9001,
                attempt: timing && inputChange === "cohort-wrong-attempt" ? 3 : 2,
              }),
              ...(timing && {
                jobs: (inputChange === "cohort-invalid-jobs"
                  ? [
                      { startedAt: null, completedAt: "2026-11-05T03:22:00Z" },
                      { startedAt: "malformed", completedAt: "2026-11-05T03:22:00Z" },
                      { startedAt: "2026-11-05T03:22:01Z", completedAt: "2026-11-05T03:22:00Z" },
                      { startedAt: "2026-11-05T03:22:00Z", completedAt: "2026-11-05T03:22:00Z", conclusion: "skipped" },
                      { startedAt: "2026-11-05T03:17:16Z", completedAt: "0001-01-01T00:00:00Z" },
                      { startedAt: "2026-02-30T03:17:16Z", completedAt: "2026-03-02T03:22:00Z" },
                    ]
                  : [{ startedAt: "2026-11-05T03:17:16Z", completedAt: "2026-11-05T03:22:00Z" }]
                ).map((job, index) => ({
                  databaseId: 127025869216 + index,
                  name: `measure fixture ${index}`,
                  status: "completed",
                  conclusion: "failure",
                  ...job,
                })),
              }),
            }),
          )
        }
        if (args[1] === "watch") {
          return respond(
            "workflow fixture result",
            inputChange.startsWith("macos-") ||
              inputChange === "cohort-failed-watch" ||
              inputChange === "cohort-failed-timing"
              ? 1
              : mac
                ? 0
                : 1,
          )
        }
        if (args[1] === "download") {
          const artifacts = args[args.indexOf("--dir") + 1]
          if (typeof artifacts !== "string") throw new Error("expected hosted artifact output directory")
          for (const id of mac
            ? ["terminal-app", "iterm2", "ghostty", "alacritty", "wezterm", "cursor", "com.microsoft.VSCode", "cmux"]
            : ["windows-terminal", "alacritty"]) {
            const folder = join(artifacts, `${mac ? "macos" : "win32"}-${id}-${args[2]}-${cohort ? 2 : 1}`)
            mkdirSync(folder, { recursive: true })
            if (inputChange.startsWith("macos-") && macosContexts.includes(id)) {
              // The real six-context failure retained completed drafts after canonical output failed.
              // A job-start marker alone is deliberately insufficient evidence of a collector start.
              writeFileSync(join(folder, "job-start.json"), JSON.stringify({ phase: "job-start" }))
              if (inputChange !== "macos-prestart") {
                const draft = JSON.parse(
                  readFileSync(join(dirname(dirname(dirname(artifacts))), `term-${id}-macos.draft.json`), "utf8"),
                ) as RunDraft
                const delegatedRunId = draft.runId
                draft.rawReplies["collector.collectionAttempt"] = JSON.stringify({
                  ids: ["sgr.bold"],
                  startedAt: actualStartedAt,
                  result: "completed",
                })
                if (inputChange === "macos-untrusted") draft.runId = "another-delegated-run"
                const output = join(folder, "artifacts")
                mkdirSync(output)
                const path = join(output, `${delegatedRunId}.draft.json`)
                const bytes = JSON.stringify(draft)
                writeFileSync(path, bytes)
                hostedDrafts.set(id, { path, bytes })
                writeFileSync(join(folder, "collector-exit"), "1\n")
                writeFileSync(
                  join(folder, "collector.log"),
                  "phase=collector-invoked\nphase=collector-exited status=1\n",
                )
              }
            } else writeFileSync(join(folder, "run.json"), "{}")
            // 30035: exercise the actual development collection boundary, including its retained bytes.
            // The recipe itself is tested independently; this case proves the caller passes verified context.
            if (textCase && id === "terminal-app") {
              const fixtureRows = textQualificationFixtures(4, 12)
              if (typeof fixtureRows === "string") throw new Error(fixtureRows)
              const artifactsDirectory = join(folder, "artifacts")
              mkdirSync(artifactsDirectory)
              const refs = new Set<string>()
              let capturedAt = 0
              const frame = (rows: readonly string[], role: "control" | "target") => {
                const bytes = Buffer.from(rows.join("\n"), "utf8")
                const ref = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
                refs.add(ref)
                writeFileSync(join(artifactsDirectory, `${ref.slice(7)}.txt`), bytes)
                return {
                  kind: "text-cells",
                  role,
                  ref,
                  capturedAt: ++capturedAt,
                  label: role,
                  cellDigest: ref,
                  frameDigest: ref,
                  cellRectangle: { top: 1, left: 1, bottom: 4, right: 12 },
                }
              }
              const shapes = fixtureRows.map((entry) => ({
                shape: entry.shape,
                frames: [frame(entry.controlRows, "control"), frame(entry.targetRows, "target")],
              }))
              const frames = shapes[0]!.frames
              const featureId = "text.overwrite"
              const appRun = {
                ...raw,
                runId: "qualified-development-text",
                intendedSubject: { kind: "term", id },
                subject: {
                  kind: "term",
                  id,
                  version: "1.0.0",
                  os: "macos",
                  osVersion: null,
                  outerTerminal: null,
                  mux: null,
                  config: null,
                  permissions: null,
                },
                runtimeIdentity: undefined,
                provenance: undefined,
                identity: "unverified",
                origin: { kind: "collector" },
                rawReplies: { [featureId]: "retained comparison" },
                assertions: [
                  {
                    featureId,
                    kind: "positive",
                    assertionType: "buffer_state",
                    rawReplyRef: featureId,
                    expected: "characters",
                    observed: frames[1]!.ref,
                  },
                ],
                results: raw.results.map((result) =>
                  result.featureId === featureId
                    ? {
                        featureId,
                        status: "supported",
                        assertionType: "buffer_state",
                        attempt: { scope: "probe", startedAt: raw.measuredAt },
                        rawReplyRef: featureId,
                        frames,
                        tests: [
                          {
                            id: "text-qualification",
                            status: "supported",
                            attempt: { scope: "probe", startedAt: raw.measuredAt },
                          },
                          {
                            id: "criterion",
                            status: "supported",
                            attempt: { scope: "probe", startedAt: raw.measuredAt },
                            assertionRefs: [0],
                            rawReplyRef: featureId,
                          },
                        ],
                      }
                    : result,
                ),
                screenshotRefs: [],
                textSnapshotRefs: [...refs],
                textQualification: { version: 1, recipe: "macos-text-cells-v1", grid: { rows: 4, cols: 12 }, shapes },
              }
              writeFileSync(join(folder, "run.json"), JSON.stringify(appRun))
              const artifact = join(artifactsDirectory, `${[...refs][0]!.slice(7)}.txt`)
              if (inputChange === "text-missing") rmSync(artifact)
              if (inputChange === "text-modified") writeFileSync(artifact, "modified retained bytes")
            }
            writeFileSync(
              join(folder, "collector-bun.lock"),
              id === "terminal-app" && !textCase && !cohort ? "wrong lock" : readFileSync(join(CONTENT, "../bun.lock")),
            )
            writeFileSync(
              join(folder, "collector-build.json"),
              JSON.stringify({
                collectorRevision: raw.sourceRevision,
                probeHash: raw.probeHash,
                bundleSha256: createHash("sha256").update("fixture collector bundle").digest("hex"),
              }),
            )
            writeFileSync(join(folder, "collector-bundle.mjs"), "fixture collector bundle")
          }
          return respond("downloaded fixture artifacts")
        }
        throw new Error(`unexpected GitHub command ${args.join(" ")}`)
      }
      const output = args.at(-1)
      if (typeof output !== "string") throw new Error("expected private Linux output directory")
      const isKitty = args.includes("kitty")
      if (!isKitty) {
        const raw = join(output, "fixture-run", "raw")
        mkdirSync(raw, { recursive: true })
        writeFileSync(join(raw, "v2-run.json"), "{}")
      }
      if (Array.isArray(stdio) && typeof stdio[2] === "number") writeSync(stdio[2], "launcher fixture diagnostic")
      return { pid: 1, output: [], stdout: "", stderr: "", status: isKitty ? 17 : 0, signal: null }
    })
    try {
      // AC1: the existing full-census fixture otherwise hides ignored context/probe selections.
      const selection = cohort
        ? { contexts: ["terminal-app/macos"], ids: ["sgr.bold"] }
        : inputChange.startsWith("macos-")
          ? { contexts: macosContexts.map((id) => `${id}/macos`), ids: ["sgr.bold"] }
          : inputChange === "hosted-selected"
            ? { contexts: ["terminal-app/macos", "windows-terminal/windows"], ids: ["sgr.bold"] }
            : inputChange === "hosted-one-os"
              ? { contexts: ["com.microsoft.VSCode/macos"], ids: ["sgr.bold"] }
              : inputChange === "hosted-contexts" || inputChange.startsWith("hosted-ref-")
                ? { contexts: ["terminal-app/macos"] }
                : inputChange === "selected" || inputChange === "completed-collector-error"
                  ? { contexts: ["xtermjs/headless"], ids: ["sgr.bold"] }
                  : inputChange === "linux-prestart" || inputChange.startsWith("linux-poststart")
                    ? { contexts: ["alacritty/linux"], ids: ["sgr.bold"] }
                    : inputChange === "empty-selection"
                      ? { contexts: [], ids: [] }
                      : inputChange === "empty-probes"
                        ? { contexts: ["alacritty/linux"], ids: [] }
                        : undefined
      // Requirement: private release collection leaves corpus bytes untouched. The old admission
      // mocks could miss a direct corpus write, so compare the actual placement directories.
      const corpusSnapshot = () =>
        ["probes-apps", "probes-libs", "probes-mux", "artifacts", "suites"]
          .flatMap((dir) =>
            readdirSync(join(CONTENT, dir), { recursive: true, withFileTypes: true })
              .filter((entry) => entry.isFile())
              .map((entry) => {
                const path = join(entry.parentPath, entry.name)
                return [relative(CONTENT, path), createHash("sha256").update(readFileSync(path)).digest("hex")]
              }),
          )
          .sort((a, b) => a[0]!.localeCompare(b[0]!))
      const beforeCorpus = suite === "matching" && inputChange === "none" ? corpusSnapshot() : undefined
      const pass = cohort
        ? await collectPass(directory, { runner: "local" }, selection, sourceRef, { cohort: true })
        : await collectPass(directory, { runner: "local" }, selection, sourceRef)
      if (!cohort) {
        expect(Object.hasOwn(pass, "hosted")).toBe(false)
        expect(
          launcher.mock.calls.some(
            ([command, args]) => command === "gh" && (args?.[0] === "api" || args?.includes("--attempt")),
          ),
        ).toBe(false)
        for (const [command, args] of launcher.mock.calls) {
          if (command === "gh" && args?.[1] === "view")
            expect(args.at(-1)).toBe("headSha,headBranch,event,workflowName")
        }
      }
      if (cohort) {
        const ghCalls = launcher.mock.calls.filter(([command]) => command === "gh").map(([, args]) => args!)
        const dispatches = ghCalls.filter((args) => args[0] === "workflow")
        expect(pass.contexts).toHaveLength(1)
        expect(pass.complete).toBe(false)
        if (inputChange === "cohort-source-mismatch") {
          expect(ghCalls).toEqual([])
          expect(pass.contexts[0]?.error).toContain("not measured source")
          return
        }
        const preflight = ghCalls.filter((args) => args[0] === "api")
        expect(preflight).toHaveLength(5)
        expect(
          preflight
            .map((args) =>
              new URLSearchParams(
                String(args.find((argument) => String(argument).startsWith("repos/"))).split("?")[1],
              ).get("status"),
            )
            .sort(),
        ).toEqual(["in_progress", "pending", "queued", "requested", "waiting"])
        const hosted = pass.hosted?.[0]
        expect(hosted).toMatchObject({
          workflow: "macos-measurement",
          ref: "refs/heads/main",
          sourceRevision: raw.sourceRevision,
          checkedAt: expect.any(String),
        })
        expect(Number.isFinite(Date.parse(hosted!.checkedAt))).toBe(true)
        if (inputChange.startsWith("cohort-active-")) {
          expect(dispatches).toEqual([])
          expect(ghCalls.every((args) => args[0] === "api")).toBe(true)
          expect(hosted?.activeRuns).toEqual([
            {
              id: 8000,
              status:
                inputChange === "cohort-active-pagination" ? "pending" : inputChange.slice("cohort-active-".length),
              headSha: "a".repeat(40),
            },
          ])
          expect(hosted).not.toHaveProperty("runId")
          const row = pass.contexts[0]!
          expect(row.status).toBe("not-started")
          expect(row.reason ?? row.error).toMatch(/active.*macos-measurement.*refs\/heads\/main.*8000/)
          expect(row.reason ?? row.error).toContain(hosted!.checkedAt)
          const retained = JSON.parse(readFileSync(row.rawRun!, "utf8")) as RunDraft
          expect(readCollectorAttempt(retained.rawReplies)?.startedAt).toBeUndefined()
          expect(retained.subject).toBeUndefined()
          expect(retained.results.every((result) => result.status === "probe-todo")).toBe(true)
          return
        }
        expect(dispatches).toHaveLength(1)
        expect(dispatches[0]).toContain("cohort=true")
        expect(hosted).toMatchObject({ runId: "9001", attempt: 2, activeRuns: [] })
        const timing = ghCalls.filter((args) => args[1] === "view" && args.includes("--attempt"))
        expect(timing).toHaveLength(1)
        expect(timing[0]?.slice(0, 3)).toEqual(["run", "view", "9001"])
        expect(timing[0]?.[timing[0].indexOf("--attempt") + 1]).toBe("2")
        expect(timing[0]?.at(-1)).toContain("jobs")
        expect(ghCalls.findIndex((args) => args === timing[0])).toBeGreaterThan(
          ghCalls.findIndex((args) => args[1] === "watch"),
        )
        expect(ghCalls.findIndex((args) => args[1] === "download")).toBeGreaterThan(
          ghCalls.findIndex((args) => args === timing[0]),
        )
        expect(
          readFileSync(
            join(pass.directory, "hosted", "macos", "artifacts", "macos-terminal-app-9001-2", "run.json"),
            "utf8",
          ),
        ).toBe("{}")
        expect(hosted?.receiptPath).toBe(join(pass.directory, "hosted", "macos", "jobs.stdout.log"))
        if (inputChange === "cohort-failed-watch" || inputChange === "cohort-failed-timing") {
          expect(pass.errors).toContain(
            `macos-measurement exited 1; logs retained at ${join(pass.directory, "hosted", "macos")}`,
          )
          expect(readFileSync(join(pass.directory, "hosted", "macos", "watch.stdout.log"), "utf8")).toBe(
            "workflow fixture result",
          )
        }
        if (inputChange === "cohort-failed-timing" || inputChange.startsWith("cohort-wrong-")) {
          expect(hosted?.unavailable).toEqual(expect.any(String))
          expect(hosted).not.toHaveProperty("jobs")
          expect(pass.errors).toContain(hosted!.unavailable)
          if (inputChange === "cohort-failed-timing")
            expect(readFileSync(join(pass.directory, "hosted", "macos", "jobs.stderr.log"), "utf8")).toBe(
              "timing API unavailable",
            )
        } else if (inputChange === "cohort-invalid-jobs") {
          expect(hosted?.jobs).toHaveLength(6)
          expect(
            hosted?.jobs?.every((job) => job.executionSeconds === null && typeof job.unavailable === "string"),
          ).toBe(true)
        } else {
          expect(hosted?.jobs).toEqual([
            {
              id: 127025869216,
              name: "measure fixture 0",
              status: "completed",
              conclusion: "failure",
              executionSeconds: 284,
            },
          ])
          const receipt = JSON.parse(readFileSync(hosted!.receiptPath!, "utf8")) as {
            jobs: Array<{ startedAt: string }>
          }
          expect(receipt.jobs[0]?.startedAt).toBe("2026-11-05T03:17:16Z")
        }
        return
      }
      if (beforeCorpus) expect(corpusSnapshot()).toEqual(beforeCorpus)
      if (inputChange === "hosted-census-one") {
        const dispatches = launcher.mock.calls.filter(([command, args]) => command === "gh" && args?.[0] === "workflow")
        expect(dispatches).toHaveLength(1)
        expect(dispatches[0]?.[1]).toContain(
          `context_matrix=${JSON.stringify({ include: [{ id: "terminal-app", bundle: "/System/Applications/Utilities/Terminal.app" }] })}`,
        )
        expect(dispatches[0]?.[1]?.some((argument) => String(argument).startsWith("probe_ids="))).toBe(false)
        return
      }
      if (inputChange === "hosted-ref-mismatch" || inputChange === "hosted-ref-missing") {
        expect(
          launcher.mock.calls.filter(([command, args]) => command === "gh" && args?.[0] === "workflow"),
        ).toHaveLength(0)
        expect(pass.contexts[0]?.error ?? pass.contexts[0]?.reason).toContain("main")
        expect(pass.contexts[0]?.error ?? pass.contexts[0]?.reason).toContain(raw.sourceRevision)
        if (inputChange === "hosted-ref-missing") {
          expect(pass.contexts[0]?.error ?? pass.contexts[0]?.reason).toContain("no published revision")
        }
        return
      }
      if (inputChange.startsWith("macos-")) {
        expect(pass.contexts).toHaveLength(6)
        expect(pass.contexts.map((row) => row.status)).toEqual(
          Array(6).fill(inputChange === "macos-poststart" ? "failed" : "not-started"),
        )
        expect(headless.collectHeadlessRuns).not.toHaveBeenCalled()
        for (const row of pass.contexts) {
          const original = hostedDrafts.get(row.context.id)
          if (original) expect(readFileSync(original.path, "utf8")).toBe(original.bytes)
          if (inputChange === "macos-poststart") {
            expect(row.rawRun).toBe(original?.path)
            expect(row.error).toContain("exited 1")
            expect(row.error).toContain(join(row.directory!, "collector.log"))
            const retained = JSON.parse(readFileSync(row.rawRun!, "utf8")) as RunDraft
            expect(readCollectorAttempt(retained.rawReplies)?.startedAt).toBe(actualStartedAt)
            expect(retained.results.every((result) => result.status === "probe-todo")).toBe(true)
          }
          if (inputChange === "macos-untrusted") expect(row.reason).toContain("differs from delegated identity")
        }
        expect(pass.complete).toBe(false)
        return
      }
      if (selection && inputChange.startsWith("hosted-")) {
        // AC2: full-census fixtures pin omission, but cannot detect an ignored hosted subset.
        // Assert actual dispatch fields and original draft custody through the real coordinator.
        const calls = launcher.mock.calls.filter(([command, args]) => command === "gh" && args?.[0] === "workflow")
        const expectedOS = inputChange === "hosted-selected" ? ["macos", "windows"] : ["macos"]
        expect(calls).toHaveLength(expectedOS.length)
        expect(headless.collectHeadlessRuns).not.toHaveBeenCalled()
        expect(pass.selection).toEqual(selection)
        expect(pass.contexts.map((row) => `${row.context.id}/${row.context.os}`)).toEqual(selection.contexts)
        for (const os of expectedOS) {
          const contexts = pass.contexts.filter((row) => row.context.os === os)
          const ids = Object.fromEntries(
            contexts.map((row) => {
              const draft = JSON.parse(
                readFileSync(join(pass.directory, `term-${row.context.id}-${os}.draft.json`), "utf8"),
              ) as RunDraft
              const expectedIds = selection.ids ?? versions.probeSuiteSnapshot().probes.term
              expect(readCollectorSelection(draft.rawReplies)).toEqual({ ids: expectedIds })
              return [row.context.id, draft.runId]
            }),
          )
          const rows = contexts.map((row) =>
            os === "windows"
              ? { id: row.context.id }
              : {
                  id: row.context.id,
                  bundle:
                    row.context.id === "terminal-app"
                      ? "/System/Applications/Utilities/Terminal.app"
                      : "/Applications/Visual Studio Code.app",
                },
          )
          expect(launcher).toHaveBeenCalledWith(
            "gh",
            [
              "workflow",
              "run",
              `${os}-measurement.yml`,
              "--repo",
              "beorn/terminfo.dev",
              "--ref",
              `refs/${inputChange === "hosted-ref-tag" || inputChange === "hosted-ref-lightweight-tag" ? "tags" : "heads"}/${sourceRef ?? "fixture-collection"}`,
              "--field",
              `capture_run_ids=${JSON.stringify(ids)}`,
              "--field",
              `context_matrix=${JSON.stringify({ include: rows })}`,
              "--field",
              `probe_ids=${JSON.stringify(selection.ids ?? versions.probeSuiteSnapshot().probes.term)}`,
            ],
            expect.anything(),
          )
        }
        expect(pass.complete).toBe(false)
        expect(readFileSync(original, "utf8")).toBe(originalBytes)
        return
      }
      if (selection) {
        // AC1: a local-only selection must not start either hosted matrix.
        // Checking the headless argv alone missed these unrelated workflow dispatches.
        expect(
          vi
            .mocked(childProcesses.spawnSync)
            .mock.calls.filter(([command, args]) => command === "gh" && args?.[0] === "workflow"),
        ).toHaveLength(0)
        expect(
          pass.contexts.map((row) => `${row.context.id}/${row.context.os === "unknown" ? "headless" : row.context.os}`),
        ).toEqual(selection.contexts)
        expect(pass.selection).toEqual(selection)
        if (selection.contexts.length === 0 || inputChange === "empty-probes") {
          expect(pass.attempt?.result).toBe("empty")
          expect(headless.collectHeadlessRuns).not.toHaveBeenCalled()
          expect(childProcesses.spawnSync).not.toHaveBeenCalled()
          if (inputChange === "empty-probes") {
            const row = pass.contexts[0]
            if (!row?.rawRun) throw new Error("Expected retained empty context draft")
            const retained = JSON.parse(readFileSync(row.rawRun, "utf8")) as RunDraft
            expect(readCollectorSelection(retained.rawReplies)).toEqual({ ids: [] })
            expect(readCollectorAttempt(retained.rawReplies)).toEqual({ ids: [], result: "empty" })
          }
        } else if (inputChange === "linux-prestart" || inputChange.startsWith("linux-poststart")) {
          expect(headless.collectHeadlessRuns).not.toHaveBeenCalled()
          const selectedRow = pass.contexts[0]
          if (!selectedRow?.rawRun) throw new Error("Expected retained Linux context draft")
          if (inputChange.startsWith("linux-poststart")) expect(selectedRow.rawRun).toBe(actualRoutePath)
          const retained = JSON.parse(readFileSync(selectedRow.rawRun, "utf8")) as RunDraft
          expect(readCollectorSelection(retained.rawReplies)).toEqual({ ids: ["sgr.bold"] })
          expect(readCollectorAttempt(retained.rawReplies)).toMatchObject({ result: "failed", ids: ["sgr.bold"] })
          if (inputChange.startsWith("linux-poststart")) {
            if (!actualRoutePath || actualRouteBytes === undefined) {
              throw new Error("Expected original Linux route fixture")
            }
            expect(readFileSync(actualRoutePath, "utf8")).toBe(actualRouteBytes)
            if (launcherErrorPath && launcherErrorBytes) {
              expect(readFileSync(launcherErrorPath, "utf8")).toBe(launcherErrorBytes)
            }
            expect(readCollectorAttempt(retained.rawReplies)).toEqual({
              ids: ["sgr.bold"],
              result: "failed",
              startedAt: actualStartedAt,
              error: actualError,
            })
            expect(retained.runId).toBe(actualRouteRunId)
            expect(retained).not.toHaveProperty("subject")
            expect(retained).not.toHaveProperty("measuredAt")
            expect(pass.contexts[0]?.status).toBe("failed")
            expect(pass.contexts[0]?.error).toContain("exited 17")
          } else expect(readCollectorAttempt(retained.rawReplies)?.startedAt).toBeUndefined()
          expect(retained.results.every((row: { attempt: { scope: string } }) => row.attempt.scope === "none")).toBe(
            true,
          )
          const linuxCall = vi.mocked(childProcesses.spawnSync).mock.calls.find(([command]) => command === "bash")
          expect(linuxCall?.[1]).toEqual([
            "scripts/linux-container-run.sh",
            "--target",
            "alacritty",
            "--preset",
            "default",
            "--clipboard-profile",
            "default",
            "--ids",
            "sgr.bold",
            pass.contexts[0]?.directory,
          ])
        } else {
          expect(headless.collectHeadlessRuns).toHaveBeenCalledWith(["xtermjs"], expect.any(String), expect.any(Map), [
            "sgr.bold",
          ])
          const retained = JSON.parse(
            readFileSync(join(pass.directory, "first-pass", "xtermjs.draft.json"), "utf8"),
          ) as RunDraft
          expect(existsSync(join(pass.directory, "first-pass", "README.md"))).toBe(true)
          expect(existsSync(join(pass.directory, "lib-xtermjs-unknown.draft.json"))).toBe(false)
          expect(readCollectorSelection(retained.rawReplies)).toEqual({ ids: ["sgr.bold"] })
          // A downstream parser refusal belongs to the pass row, not the finished collector's record.
          // Existing error rows have no terminal attempt to preserve.
          if (inputChange === "completed-collector-error") {
            expect(readCollectorAttempt(retained.rawReplies)?.result).toBe("completed")
            expect(readFileSync(join(pass.directory, "first-pass", "xtermjs.draft.json"), "utf8")).toBe(
              completedDraftBytes,
            )
            expect(pass.contexts[0]?.error).toMatch(/Collector changed logical runId/)
            expect(pass.contexts[0]?.status).toBe("failed")
          }
        }
        return
      }
      expect(pass.contexts).toHaveLength(33)

      if (textCase) {
        const terminal = pass.contexts.find(
          (row) => row.context.kind === "term" && row.context.id === "terminal-app" && row.context.os === "macos",
        )
        expect(terminal?.status).toBe("not-started")
        expect(terminal?.error).toMatch(/Collector changed logical runId/)
      }
      const engine = pass.contexts.find((row) => row.context.kind === "lib" && row.context.id === "xtermjs")
      expect(engine?.status).toBe("not-started")
      expect(engine?.classification).toBeUndefined()
      expect(engine?.error).toMatch(
        suite === "different" ? /current run requires frozen catalogue membership/ : /Collector changed logical runId/,
      )

      expect(engine?.rawRun && readFileSync(engine.rawRun, "utf8")).toBe(bytes)
      expect(JSON.parse(readFileSync(join(pass.directory, "pass.json"), "utf8"))).toEqual(pass)
      if (suite === "matching" && inputChange === "none") {
        // Catalog scope and executed launcher/flake bytes must be reproducible from the private receipt.
        for (const path of [
          join(CONTENT, "features.json"),
          join(CONTENT, "../scripts/linux-container-run.sh"),
          join(CONTENT, "../../../flake.nix"),
        ]) {
          expect(pass.inputSha256[path], path).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"))
        }
      }
      if (inputChange === "rewrite" || inputChange === "remove") {
        expect(pass.errors.some((error) => error.includes(input) && /changed|ENOENT/.test(error))).toBe(true)
      }
      expect(collector).toHaveBeenCalledTimes(1)
      expect(launcher.mock.calls.filter(([command]) => command === "bash")).toHaveLength(7)
      // Both Linux mux rows run inside the Kitty container through the launcher's --mux arm.
      for (const id of ["tmux", "screen"]) {
        const row = pass.contexts.find(
          (entry) => entry.context.kind === "mux" && entry.context.id === id && entry.context.os === "linux",
        )
        const output = join(pass.directory, "linux", id)
        expect(launcher).toHaveBeenCalledWith(
          "bash",
          [
            "scripts/linux-container-run.sh",
            "--target",
            "kitty",
            "--preset",
            "current",
            "--clipboard-profile",
            "default",
            "--mux",
            id,
            output,
          ],
          expect.objectContaining({ env: expect.objectContaining({ TERMINFO_PROBE_HASH: pass.probeHash }) }),
        )
        // The fixture suite has no mux probes, so the launcher failure is the row error, not a probe-invalid.
        expect(row?.error).toMatch(new RegExp(`${id}/linux.*exited 17`))
      }
      for (const id of LINUX_APP_IDS) {
        const row = pass.contexts.find(
          (entry) => entry.context.kind === "term" && entry.context.id === id && entry.context.os === "linux",
        )
        const output = join(pass.directory, "linux", id)
        expect(launcher).toHaveBeenCalledWith(
          "bash",
          [
            "scripts/linux-container-run.sh",
            "--target",
            id,
            "--preset",
            id === "kitty" ? "current" : "default",
            "--clipboard-profile",
            "default",
            output,
          ],
          // 30657: the launcher's host readback refuses without the pass's suite and source revision.
          expect.objectContaining({
            env: expect.objectContaining({
              TERMINFO_PROBE_HASH: pass.probeHash,
              TERMINFO_SOURCE_REVISION: pass.sourceRevision,
            }),
          }),
        )
        // A launcher error or malformed file supplies no actual collector start or emitted result.
        expect(row?.status).toBe("not-started")
        expect(row?.error).toContain(`${id}/linux`)
        expect(readFileSync(join(output, "launcher.stderr.log"), "utf8")).toBe("launcher fixture diagnostic")
        if (id === "kitty") expect(row?.error).toMatch(/exited 17/)
        else expect(readFileSync(join(output, "fixture-run", "raw", "v2-run.json"), "utf8")).toBe("{}")
      }
      expect(readFileSync(original, "utf8")).toBe(originalBytes)
      if (inputChange === "blocked-hosted" || inputChange === "blocked-macos") {
        const affected = pass.contexts.filter(
          (row) =>
            row.context.route === "hosted-workflow" && (inputChange === "blocked-hosted" || row.context.os === "macos"),
        )
        expect(affected).toHaveLength(inputChange === "blocked-hosted" ? 12 : 9)
        expect(affected.every((row) => row.status === "not-started" && row.error?.includes("EEXIST"))).toBe(true)
        expect(launcher.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === "workflow")).toHaveLength(
          inputChange === "blocked-hosted" ? 0 : 1,
        )
        return
      }
      for (const os of ["macos", "windows"]) {
        const delegated = Object.fromEntries(
          pass.contexts
            .filter((row) => row.context.route === "hosted-workflow" && row.context.os === os)
            .map((row) => {
              const draftPath = join(
                pass.directory,
                `${row.context.kind}-${row.context.id}-${row.context.os}.draft.json`,
              )
              const initialized = JSON.parse(readFileSync(draftPath, "utf8")) as { runId: string }
              return [row.context.id, initialized.runId]
            }),
        )
        expect(launcher).toHaveBeenCalledWith(
          "gh",
          [
            "workflow",
            "run",
            `${os}-measurement.yml`,
            "--repo",
            "beorn/terminfo.dev",
            "--ref",
            "refs/heads/fixture-collection",
            "--field",
            `capture_run_ids=${JSON.stringify(delegated)}`,
            "--field",
            `context_matrix=${JSON.stringify(JSON.parse(parse(readFileSync(join(dirname(CONTENT), ".github", "workflows", `${os}-measurement.yml`), "utf8")).on.workflow_dispatch.inputs.context_matrix.default))}`,
          ],
          expect.anything(),
        )
        const hosted = pass.contexts.filter((row) => row.context.route === "hosted-workflow" && row.context.os === os)
        expect(hosted).toHaveLength(os === "macos" ? 9 : 3)
        if (suite === "different") expect(hosted.every((row) => row.error?.includes("source revision"))).toBe(true)
      }
      expect(launcher.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === "workflow")).toHaveLength(2)
      if (suite === "matching") {
        // Remote platforms must start independently before either wait can block the other dispatch.
        const dispatch = launcher.mock.calls.findLastIndex(
          ([command, args]) => command === "gh" && Array.isArray(args) && args[0] === "workflow",
        )
        const wait = launcher.mock.calls.findIndex(
          ([command, args]) => command === "gh" && Array.isArray(args) && args[1] === "watch",
        )
        expect(wait, "both platform workflows dispatch before waiting").toBeGreaterThan(dispatch)
        expect(launcher).toHaveBeenCalledWith(
          "gh",
          [
            "run",
            "download",
            "9002",
            "--repo",
            "beorn/terminfo.dev",
            "--dir",
            join(pass.directory, "hosted", "windows", "artifacts"),
          ],
          expect.anything(),
        )
        expect(pass.errors.some((error) => error.includes("windows-measurement") && error.includes("exited 1"))).toBe(
          true,
        )
        const mac = pass.contexts.find((row) => row.context.id === "terminal-app")
        if (!textCase) expect(mac?.error).toMatch(/dependency lock/)
        const windows = pass.contexts.find((row) => row.context.id === "windows-terminal")
        expect(windows?.rawRun && readFileSync(windows.rawRun, "utf8")).toBe("{}")
        expect(windows?.error).toMatch(/schemaVersion/)
      }
    } finally {
      catalogSelection?.mockRestore()
      collector.mockRestore()
      launcher.mockRestore()
      snapshot?.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

describe("release 1 collection census", () => {
  it("covers every catalog app/mux platform plus the engine family, with no missing or duplicate context", () => {
    const all = census()
    // full-census.test.ts owns membership. This boundary owns route coverage and the actual CLI.
    const contexts = all.map((entry) => `${entry.kind}:${entry.id}/${entry.os}`)
    expect(new Set(contexts).size).toBe(33)
    expect(all.filter((entry) => entry.kind === "term")).toHaveLength(18)
    expect(all.filter((entry) => entry.kind === "mux")).toHaveLength(4)
    expect(all.filter((entry) => entry.kind === "lib")).toHaveLength(11)
    expect(all).toHaveLength(33)
    // The CLI ledger must name the mux population as well; this is the real stdout boundary.
    const command = spawnSync(process.execPath, ["scripts/release1-collection.ts", "--plan"], {
      cwd: dirname(CONTENT),
      encoding: "utf8",
    })
    expect(command.status, command.stderr).toBe(0)
    expect(command.stdout.split("\n")[0]).toContain("18 app, 4 mux, 11 headless")
  }, 30_000)

  it("routes each Linux mux row through the Kitty container's --mux arm and keeps each macOS mux row detached", () => {
    for (const id of ["tmux", "screen"]) {
      const linux = census().find((entry) => entry.kind === "mux" && entry.id === id && entry.os === "linux")
      expect(linux?.route).toBe("linux-container")
      expect(linux?.command).toBe(
        `bash scripts/linux-container-run.sh --target kitty --preset current --clipboard-profile default --mux ${id} <outdir>`,
      )
      expect(linux?.uncollectable).toBeNull()
      const macos = census().find((entry) => entry.kind === "mux" && entry.id === id && entry.os === "macos")
      expect(macos?.route).toBe("mux")
    }
  })

  it("compares the manifest's engine set with the catalog's instead of a hardcoded count", () => {
    // The catalog is the authority on how many engines exist; a dropped or added engine still
    // shows up by name, which is the check that prevents silently publishing a different family
    // (28385, area 15).
    expect(() => census(ENGINE_BACKENDS.slice(0, 10))).toThrow(/Catalog\/Termless engine membership differs/s)
    expect(() => census([...ENGINE_BACKENDS, "extra"])).toThrow(/engine membership differs.*extra/s)
    expect(() => census([...ENGINE_BACKENDS.slice(0, -1), "not-in-catalog"])).toThrow(
      /engine membership differs.*not-in-catalog/s,
    )
    expect(census([...ENGINE_BACKENDS])).toHaveLength(33)
  })

  it("names every context that has no route instead of dropping it", () => {
    const all = census()
    const windows = all.find((entry) => entry.id === "windows-terminal")
    // Windows is collectable: windows-measurement.yml is a hosted workflow that produced an
    // admissible row at db5558cf8d6c (run 38074622083), so the old "no owner and no hosted
    // workflow yet" gap is gone and the row carries a route and its dispatch command.
    expect(windows?.route).toBe("hosted-workflow")
    expect(windows?.command).toMatch(
      /gh workflow run windows-measurement\.yml --repo beorn\/terminfo\.dev --ref <exact-source-ref>/,
    )
    expect(windows?.uncollectable).toBeNull()
    const alacrittyWin = all.find((entry) => entry.id === "alacritty" && entry.os === "windows")
    expect(alacrittyWin?.route).toBe("hosted-workflow")
    expect(alacrittyWin?.command).toMatch(/win32-alacritty-<run-id>-<attempt>/)
    expect(alacrittyWin?.uncollectable).toBeNull()
    for (const entry of all) {
      if (entry.route === null) expect(entry.uncollectable).not.toBeNull()
      else expect(entry.command).toBeTruthy()
    }
  })

  it("retains every missing app route as required work, never inventing a hosted dispatch", () => {
    // The workflow's matrix includes cmux, Warp and both editors alongside the existing five macOS apps and
    // windows-terminal/alacritty/wezterm on windows.
    // All remaining unresolved routes stay recorded as expected route work. kitty/macos is one of
    // them, with its own measured reason: the hosted runner has no usable OpenGL, so kitty opens no
    // window there (run 39302236007), and its owned codimac run was unadmitted for the missing
    // capture adapter. The reason is a fact, not a silent gap.
    const kitty = census().find((entry) => entry.id === "kitty" && entry.os === "macos")
    expect(kitty?.route).toBeNull()
    expect(kitty?.command).toBeNull()
    expect(kitty?.requires).toBeNull()
    expect(kitty?.sourceRun).toBe("39302236007")
    expect(kitty?.uncollectable).toMatch(/not measurable on the hosted runner.*39302236007/)
    const missing = census().filter((entry) => entry.route === null)
    expect(missing).toHaveLength(1)
    expect(missing.filter((entry) => entry.uncollectable?.includes("required route work"))).toHaveLength(0)
    for (const id of [
      "terminal-app",
      "iterm2",
      "ghostty",
      "alacritty",
      "wezterm",
      "cursor",
      "com.microsoft.VSCode",
      "warp",
      "cmux",
    ]) {
      expect(census().find((entry) => entry.id === id && entry.os === "macos")?.route).toBe("hosted-workflow")
    }
    for (const id of ["windows-terminal", "alacritty", "wezterm"]) {
      expect(census().find((entry) => entry.id === id && entry.os === "windows")?.route).toBe("hosted-workflow")
    }
  })
})

describe("release 1 Linux launcher flags", () => {
  it("puts the declared launcher flags into every Linux row's command", () => {
    const all = census()
    for (const id of LINUX_APP_IDS) {
      const row = all.find((entry) => entry.id === id && entry.os === "linux")
      expect(row?.route).toBe("linux-container")
      expect(row?.uncollectable).toBeNull()
      expect(row?.command).toBe(
        `bash scripts/linux-container-run.sh --target ${id} --preset ${id === "kitty" ? "current" : "default"} ` +
          `--clipboard-profile default <outdir>`,
      )
      // The live pass declares the invocation, so no committed run is named as this row's source.
      expect(row?.sourceRun).toBeNull()
    }
  })
})

// A census-only missing-route row cannot catch the CLI returning success.
it("fails collection by name and exit 1 for a required null route", () => {
  const directory = mkdtempSync(join(tmpdir(), "collection-required-route-"))
  const preload = join(directory, "external-owners.ts")
  const root = dirname(CONTENT)
  const macosWorkflowPath = join(root, ".github/workflows/macos-measurement.yml")
  const missingRoutePath = join(directory, "missing-cmux-workflow.yml")
  const workflow = parse(readFileSync(macosWorkflowPath, "utf8"))
  const matrix = JSON.parse(workflow.on.workflow_dispatch.inputs.context_matrix.default) as {
    include: Array<{ id: string }>
  }
  matrix.include = matrix.include.filter((row: { id: string }) => row.id !== "cmux")
  workflow.on.workflow_dispatch.inputs.context_matrix.default = JSON.stringify(matrix)
  writeFileSync(missingRoutePath, stringify(workflow))
  writeFileSync(
    preload,
    `
import { mock } from "bun:test";
const fs = await import("node:fs");
const readFingerprintFile = fs.readFileSync;
const fingerprintFiles = ${JSON.stringify({ ...fingerprintFixture.files, [macosWorkflowPath]: missingRoutePath })};
mock.module("node:fs", () => ({...fs, readFileSync: (path, ...args) => readFingerprintFile(typeof path === "string" ? fingerprintFiles[path] ?? path : path, ...args)}));
const processes = await import("node:child_process");
const readSourceGit = processes.spawnSync;
mock.module("node:child_process", () => ({...processes, spawnSync: (command, ...args) => command === "git" ? readSourceGit(command, ...args) : ({ status: 1, stdout: "", stderr: "fixture external dispatch refused", signal: null })}));
mock.module(${JSON.stringify(join(dirname(CONTENT), "packages/probes/collect-headless.ts"))}, () => ({collectHeadlessRuns: async (_selectors, directory) => ({directory, runs: [], failures: []})}));
`,
  )
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--preload",
        preload,
        "scripts/release1-collection.ts",
        "--collect",
        "--development",
        "--output",
        join(directory, "output"),
      ],
      { cwd: root, encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(1)
    // The explicit fixture omits cmux even though the real workflow supports it. Retain the
    // required-route refusal and the independent kitty measured-uncollectable refusal.
    expect(result.stdout).toMatch(/kitty\/macos: not-started.*not measurable on the hosted runner/)
    expect(result.stdout).toMatch(/cmux\/macos: not-started.*required route work/)
    const passName = readdirSync(join(directory, "output"))[0]!
    const pass = JSON.parse(readFileSync(join(directory, "output", passName, "pass.json"), "utf8")) as Awaited<
      ReturnType<typeof collectPass>
    >
    expect(
      pass.contexts.find(
        (row: { context: { id: string; os: string } }) => row.context.id === "kitty" && row.context.os === "macos",
      ),
    ).toMatchObject({ status: "not-started", error: expect.stringContaining("not measurable on the hosted runner") })
    expect(
      pass.contexts.find(
        (row: { context: { id: string; os: string } }) => row.context.id === "cmux" && row.context.os === "macos",
      ),
    ).toMatchObject({ status: "not-started", error: expect.stringContaining("required route work") })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

const ownedAppContext: CollectionContext = {
  id: "kitty",
  os: "macos",
  kind: "term",
  route: "local-owned-app",
  command: "bun packages/admin/src/index.ts probe app kitty --output <private-output>",
  requires: null,
  sourceRun: null,
  uncollectable: null,
}
const ownedAppRevision = "c".repeat(40)

// The local route must stay byte-identical to the argv it always ran; the ssh route hands the
// SAME probe arguments to the transport driver after its own transport flags, never a second probe.
it("starts an owned-app row locally with the probe argv it always ran", () => {
  const command = ownedAppCommand(ownedAppContext, "/private/kitty", { runner: "local" }, ownedAppRevision)
  expect(command.label).toBe("kitty/macos owned-app collection")
  expect(command.argv).toEqual([
    "bun",
    "packages/admin/src/index.ts",
    "probe",
    "term",
    "kitty",
    "--output",
    "/private/kitty",
  ])
})

it("hands the identical probe argv to the ssh transport with environment-owned configuration", () => {
  const command = ownedAppCommand(
    ownedAppContext,
    "/private/kitty",
    {
      runner: "ssh:fixture@fixture.invalid",
      stage: "/remote/stage",
      knownHosts: "/home/fixture/.ssh/known_hosts",
      removeStage: true,
    },
    ownedAppRevision,
  )
  expect(command.label).toBe("kitty/macos owned-app transport")
  expect(command.argv.slice(0, 13)).toEqual([
    "bun",
    "scripts/owned-app-remote-run.ts",
    "--transport",
    "ssh:fixture@fixture.invalid",
    "--stage",
    "/remote/stage",
    "--output",
    "/private/kitty",
    "--source-revision",
    ownedAppRevision,
    "--context",
    "kitty",
    "--known-hosts",
  ])
  expect(command.argv).toContain("--remove-stage")
  expect(command.argv.slice(command.argv.indexOf("--"))).toEqual([
    "--",
    "bun",
    "packages/admin/src/index.ts",
    "probe",
    "term",
    "kitty",
  ])
})

it("hands the ssh transport no stage when none is supplied, so the driver derives it on the host", () => {
  const command = ownedAppCommand(
    ownedAppContext,
    "/private/kitty",
    { runner: "ssh:fixture@fixture.invalid", knownHosts: "/home/fixture/.ssh/known_hosts" },
    ownedAppRevision,
  )
  expect(command.argv).not.toContain("--stage")
  expect(command.argv.slice(0, 8)).toEqual([
    "bun",
    "scripts/owned-app-remote-run.ts",
    "--transport",
    "ssh:fixture@fixture.invalid",
    "--output",
    "/private/kitty",
    "--source-revision",
    ownedAppRevision,
  ])
})

it("refuses an ssh transport with no known-hosts file rather than inventing trust", () => {
  expect(() =>
    ownedAppCommand(
      ownedAppContext,
      "/private/kitty",
      { runner: "ssh:fixture@fixture.invalid", stage: "/remote/stage" },
      ownedAppRevision,
    ),
  ).toThrow(/requires --owned-app-known-hosts/)
})

// The collector's own argv builder, through the real driver, to the files the collector reads next:
// one run JSON in <output>/transport and a receipt bound to the collected revision. The run JSON is
// a current producer fixture with explicit TODOs and its trusted frozen catalogue, parsed and classified
// here exactly as the collector classifies a run after transport.
it("runs the collector's ssh route through the driver and reads the run JSON it wrote", () => {
  const directory = mkdtempSync(join(tmpdir(), "transport-route-"))
  const code = join(directory, "code")
  const source = join(code, "vendor", "terminfo.dev")
  const shims = join(directory, "shims")
  const stage = join(directory, "remote", "stage")
  const knownHosts = join(directory, "known_hosts")
  const output = join(directory, "owned-app", "kitty")
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
    return result.stdout.trim()
  }
  const shim = (name: string, body: string): void => {
    writeFileSync(join(shims, name), body, { mode: 0o755 })
  }
  for (const path of [
    source,
    shims,
    output,
    join(code, "vendor", "silvery"),
    join(code, "vendor", "termless"),
    join(code, "node_modules"),
  ]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(source, "package.json"), '{"name":"terminfo.dev","private":true}\n')
  mkdirSync(join(source, "packages", "admin", "src"), { recursive: true })
  writeFileSync(join(source, "packages", "admin", "src", "index.ts"), "export const probe = 'fixture'\n")
  git(source, "init", "-q", "-b", "main")
  git(source, "config", "user.email", "fixture@example.invalid")
  git(source, "config", "user.name", "fixture")
  git(source, "add", "-A")
  git(source, "commit", "-q", "-m", "fixture source")
  const revision = git(source, "rev-parse", "HEAD")
  for (const entry of ["package.json", "bun.lock", "tsconfig.json"]) {
    writeFileSync(join(code, entry), `fixture ${entry}\n`)
  }
  writeFileSync(join(code, "vendor", "silvery", "index.ts"), "export const silvery = 'fixture'\n")
  writeFileSync(join(code, "vendor", "termless", "index.ts"), "export const termless = 'fixture'\n")
  writeFileSync(knownHosts, "fixture.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZpeHR1cmVrZXk=\n")
  shim(
    "ssh",
    [
      "#!/bin/sh",
      "verbose=0",
      'for a in "$@"; do [ "$a" = "-v" ] && verbose=1; done',
      'while [ "$1" = "-o" ] || [ "$1" = "-F" ] || [ "$1" = "-l" ]; do shift 2; done',
      'while [ "$1" = "-v" ]; do shift; done',
      '[ "$1" = "--" ] && shift',
      "shift",
      "[ \"$verbose\" = 1 ] && echo 'debug1: Server host key: ssh-ed25519 SHA256:fixtureRoute' >&2",
      'exec /bin/sh -c "$*"',
    ].join("\n"),
  )
  shim(
    "rsync",
    [
      "#!/bin/sh",
      'REAL_RSYNC="${REAL_RSYNC:-/usr/bin/rsync}"',
      'if [ "$1" = "--server" ]; then exec "$REAL_RSYNC" "$@"; fi',
      '"$REAL_RSYNC" "$@"',
    ].join("\n"),
  )
  shim(
    "bun",
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *identity.ts*) printf '%s' '{\"machineIdSha256\":\"aaaa\"}' ;;",
      "  --version) echo '1.2.3' ;;",
      "  *) out=''",
      '     while [ $# -gt 0 ]; do case "$1" in --output) shift; out="$1" ;; esac; shift; done',
      '     cp "$PRODUCER_RUN" "$out/kitty-current-todo.json" ;;',
      "esac",
    ].join("\n"),
  )
  shim("kitty", "#!/bin/sh\necho 'kitty 0.49.1'\n")
  const producerRun = join(directory, "producer-current.json")
  const producerDraft = initializeRunDraft({
    runId: "transport-kitty-current-todo",
    sourceRevision: revision,
    manifest: { ...currentManifest, schemaVersion: 4 },
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
  })
  producerDraft.subject = {
    kind: "term",
    id: "kitty",
    version: "0.48.2",
    os: "macos",
    osVersion: "26.6.2",
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  producerDraft.identity = "unverified"
  producerDraft.origin = { kind: "collector" }
  producerDraft.measuredAt = "2026-10-06T23:41:34.869Z"
  writeFileSync(producerRun, JSON.stringify(finalizeCollectedDraft(producerDraft as CapturedRunDraft)))
  const producerBytes = readFileSync(producerRun)
  try {
    const command = ownedAppCommand(
      ownedAppContext,
      output,
      { runner: "ssh:fixture@fixture.invalid", stage, knownHosts },
      revision,
    )
    // argv[0] is the `bun` token the collector resolves from PATH; here the runner is this process,
    // so only the driver path and its arguments are passed.
    const result = spawnSync(process.execPath, command.argv.slice(1), {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        PATH: `${shims}:/usr/bin:/bin`,
        OWNED_APP_TRANSPORT_SOURCE_ROOT: source,
        OWNED_APP_TRANSPORT_RESOURCE_ROOT: code,
        OWNED_APP_TRANSPORT_KITTY_PATH: join(shims, "kitty"),
        PRODUCER_RUN: producerRun,
        REAL_RSYNC: "/usr/bin/rsync",
      },
    })
    expect(result.status, result.stderr).toBe(0)
    // The collector's own selector names the directory, exactly where the real driver wrote.
    const transport = ownedAppRunsDirectory(output, "ssh:fixture@fixture.invalid")
    expect(ownedAppRunsDirectory(output, "local")).toBe(output)
    // Exactly what the collector's own read does: the receipt beside one run JSON.
    const proof = readOwnedAppTransportProof(join(transport, "transport-receipt.json"), revision)
    expect(proof.receiptSha256).toMatch(/^[a-f0-9]{64}$/)
    const runs = readdirSync(transport).filter((name) => name.endsWith(".json") && name !== "transport-receipt.json")
    expect(runs).toEqual(["kitty-current-todo.json"])

    // The transported bytes are the producer's bytes, and they parse and classify the way the
    // collector classifies a run after transport.
    const runPath = join(transport, "kitty-current-todo.json")
    const runBytes = readFileSync(runPath)
    expect(createHash("sha256").update(runBytes).digest("hex")).toBe(
      createHash("sha256").update(producerBytes).digest("hex"),
    )
    const raw = runBytes.toString("utf8")
    const probeHash = (JSON.parse(raw) as { probeHash: string }).probeHash
    const suitePath = join(CONTENT, "suites", `${probeHash.slice(0, 12)}.json`)
    const manifest = parseSuiteManifest(suitePath, readFileSync(suitePath, "utf8"))
    const catalogIds = Object.keys(catalog.loadFeatures(CONTENT))
    const run = parseRun(runPath, raw, catalogIds, new Map([[probeHash, manifest]]))
    expect(run.subject).toMatchObject({ kind: "term", id: "kitty", os: "macos" })
    expect(run.suiteComplete).toBe(true)
    expect(run.results?.every((result) => result.status === "probe-todo")).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)

it("records the host-written transport receipt as evidence and refuses anything else", () => {
  const directory = mkdtempSync(join(tmpdir(), "transport-proof-"))
  const path = join(directory, "transport-receipt.json")
  const receipt = {
    schemaVersion: 1,
    kind: "owned-app-transport",
    grants: "nothing",
    sourceRevision: ownedAppRevision,
    transport: "ssh:fixture@fixture.invalid",
    hostKeyFingerprint: "SHA256:fixture",
    resourceManifestSha256: "d".repeat(64),
    resourceFiles: 42,
    output: { directory: "/remote/stage/runs/cccccccccccc-kitty" },
  }
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`
  writeFileSync(path, bytes)
  try {
    expect(readOwnedAppTransportProof(path, ownedAppRevision)).toEqual({
      runner: "ssh:fixture@fixture.invalid",
      hostKeyFingerprint: "SHA256:fixture",
      resourceManifestSha256: "d".repeat(64),
      resourceFiles: 42,
      receiptSha256: createHash("sha256").update(bytes).digest("hex"),
      remoteOutput: "/remote/stage/runs/cccccccccccc-kitty",
    })
    writeFileSync(path, JSON.stringify({ ...receipt, kind: "linux-xvfb-container" }))
    expect(() => readOwnedAppTransportProof(path, ownedAppRevision)).toThrow(
      /not a schemaVersion 1 owned-app-transport record/,
    )
    // A receipt that claims authority is refused: this kind records, it never grants.
    writeFileSync(path, JSON.stringify({ ...receipt, grants: "mutate+readback" }))
    expect(() => readOwnedAppTransportProof(path, ownedAppRevision)).toThrow(/this kind grants nothing/)
    // A receipt for another revision cannot stand in for the bytes this pass measured.
    writeFileSync(path, JSON.stringify({ ...receipt, sourceRevision: "e".repeat(40) }))
    expect(() => readOwnedAppTransportProof(path, ownedAppRevision)).toThrow(/names source/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Requirement: private captures retain delegated identity and custody without a freeze pointer.
// The former final fixtures required candidate2 and could not exercise this private-only contract.
it.each([
  "matching",
  "producer-zero-review",
  "producer-pending",
  "linux-receipt",
  "source-negative-pending",
  "missing-collection-receipt",
  "foreign-run",
  "foreign-context",
] as const)("retains private delegated identity and custody: %s", async (fault) => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-pending-handoff-"))
  const measuredTarget = specimen.subject
  const measuredAt = specimen.measuredAt
  const launcher = vi.spyOn(childProcesses, "spawnSync").mockImplementation((command, args) => {
    if (
      fault === "linux-receipt" &&
      command === "bash" &&
      Array.isArray(args) &&
      args.includes("alacritty") &&
      !args.includes("--mux")
    ) {
      const output = String(args.at(-1))
      const draft = JSON.parse(
        readFileSync(join(dirname(dirname(output)), "term-alacritty-linux.draft.json"), "utf8"),
      ) as RunDraft
      const run = {
        ...draft,
        subject: { ...measuredTarget, kind: "term", id: "alacritty", os: "linux" },
        identity: "unverified",
        origin: { kind: "collector" },
        measuredAt,
      }
      const raw = join(output, "fixture-run", "raw")
      mkdirSync(raw, { recursive: true })
      const producer = saveDaemonProbeRun(run as never, raw)
      writeFileSync(join(raw, "v3-run.draft.json"), readFileSync(producer))
      const collector = { frozenRunnerSha256: "a".repeat(64), buildReceiptSha256: "b".repeat(64) }
      writeFileSync(
        join(raw, "host-measured.json"),
        JSON.stringify({
          runId: run.runId,
          runtime: { imageId: "fixture-image", imageTarSha256: "c".repeat(64) },
          runnerArtifact: collector,
          clipboardProfile: "fixture",
          sourceArtifact: {},
        }),
      )
      writeFileSync(
        join(raw, "container-receipt.json"),
        JSON.stringify({
          runId: run.runId,
          collector,
          executable: { path: "/fixture", sha256: "d".repeat(64) },
          invocation: { path: "/fixture", sha256: "e".repeat(64) },
          sourceArtifact: { sha256: "f".repeat(64) },
          probeRun: { runId: run.runId, sha256: createHash("sha256").update(readFileSync(producer)).digest("hex") },
          display: { glxinfo: "fixture", geometry: "80x24" },
          clipboardFixture: { runId: run.runId, profile: "fixture", sha256: "a".repeat(64) },
        }),
      )
      expect(existsSync(join(raw, "run-receipt.json"))).toBe(false)
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null }
    }
    if (
      fault === "source-negative-pending" &&
      command === "bash" &&
      Array.isArray(args) &&
      args.includes("alacritty") &&
      !args.includes("--mux")
    ) {
      const output = String(args.at(-1))
      const draft = JSON.parse(
        readFileSync(join(dirname(dirname(output)), "term-alacritty-linux.draft.json"), "utf8"),
      ) as RunDraft
      const appRun = {
        ...structuredClone(draft),
        subject: { ...measuredTarget, kind: "term", id: "alacritty", os: "linux" },
        identity: "unverified",
        origin: { kind: "collector" },
        measuredAt: specimen.measuredAt,
      }
      appRun.results[0]!.status = "probe-invalid"
      appRun.results[0]!.criterionBranch = SOURCE_NEGATIVE_REVIEW
      appRun.results[0]!.attempt = { scope: "probe", startedAt: measuredAt }
      appRun.results[0]!.reason = "Required source-negative review pending"
      appRun.results[0]!.tests = [
        {
          id: "review",
          status: "probe-invalid",
          attempt: { scope: "probe", startedAt: measuredAt },
          reason: "Required source-negative review pending",
        },
      ]
      const rawDir = join(output, "fixture-run", "raw")
      mkdirSync(rawDir, { recursive: true })
      writeFileSync(join(rawDir, "v3-run.draft.json"), JSON.stringify(appRun))
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null }
    }
    return {
      pid: 1,
      output: [],
      stdout: "",
      stderr: "fixture external route unavailable",
      status: 1,
      signal: null,
    }
  })
  let producerPath: string | undefined
  let producerBytes: string | undefined
  const collector = vi
    .spyOn(headless, "collectHeadlessRuns")
    .mockImplementation(async (_selectors, output, initializations) => {
      if (!output || !initializations) throw new Error("Expected initialized coordinator handoff")
      mkdirSync(output, { recursive: true })
      const handed = initializations.get("xtermjs")!
      const run = {
        ...structuredClone(handed.draft),
        runId: fault === "foreign-run" ? "foreign-logical-attempt" : handed.draft.runId,
        subject: { ...measuredTarget, kind: fault === "foreign-context" ? "term" : "lib" },
        identity: "unverified",
        origin: { kind: "collector" },
        measuredAt: specimen.measuredAt,
        ...(fault !== "foreign-context" && { runtimeIdentity: specimen.runtimeIdentity }),
      }
      if (fault === "source-negative-pending" || fault === "missing-collection-receipt") {
        run.results[0]!.status = "probe-invalid"
        run.results[0]!.criterionBranch = SOURCE_NEGATIVE_REVIEW
        run.results[0]!.attempt = { scope: "probe", startedAt: measuredAt }
        run.results[0]!.reason = "Required source-negative review pending"
        run.results[0]!.tests = [
          {
            id: "review",
            status: "probe-invalid",
            attempt: { scope: "probe", startedAt: measuredAt },
            reason: "Required source-negative review pending",
          },
        ]
      } else {
        run.results[0]!.tests = [
          { id: "review", status: "probe-todo", attempt: { scope: "none" }, reason: "Required review pending" },
        ]
      }
      if (fault === "producer-zero-review") {
        const attempt = { scope: "probe" as const, startedAt: specimen.measuredAt }
        const measured = run.results.filter((result) => !ENVIRONMENT_GROUP_IDS.includes(result.featureId as never))
        Object.assign(run, {
          rawReplies: Object.fromEntries(measured.map((result) => [result.featureId, '{"value":true}'])),
          assertions: measured.map(({ featureId }) => ({
            featureId,
            assertionType: "buffer_state",
            kind: "positive",
            rawReplyRef: featureId,
            expected: "value=true",
            observed: '{"value":true}',
          })),
          results: run.results.map((result) => {
            const index = measured.findIndex((entry) => entry.featureId === result.featureId)
            return index < 0
              ? result
              : {
                  featureId: result.featureId,
                  status: "supported",
                  assertionType: "buffer_state",
                  rawReplyRef: result.featureId,
                  attempt,
                  tests: [
                    {
                      id: "criterion",
                      status: "supported",
                      attempt,
                      assertionRefs: [index],
                      rawReplyRef: result.featureId,
                    },
                  ],
                }
          }),
        })
      }
      const path =
        fault.startsWith("producer-") || fault === "source-negative-pending" || fault === "missing-collection-receipt"
          ? saveDaemonProbeRun(run as never, output)
          : join(output, "pending.draft.json")
      if (
        !fault.startsWith("producer-") &&
        fault !== "source-negative-pending" &&
        fault !== "missing-collection-receipt"
      ) {
        writeFileSync(path, JSON.stringify(run))
      }
      if (fault.startsWith("producer-")) {
        producerPath = path
        producerBytes = readFileSync(path, "utf8")
        expect(() => saveDaemonProbeRun(run as never, output)).toThrow(/EEXIST/)
      }
      const collection = { directory: output, requested: ["xtermjs"], runs: [path], failures: [] }
      if (fault !== "missing-collection-receipt") {
        writeFileSync(join(output, "collection.json"), `${JSON.stringify(collection, null, 2)}\n`, { flag: "wx" })
      }
      return collection
    })
  try {
    const pass = await collectPass(directory, { runner: "local" })
    if (fault === "linux-receipt") {
      const linux = pass.contexts.find(
        (entry) => entry.context.kind === "term" && entry.context.id === "alacritty" && entry.context.os === "linux",
      )!
      // Requirement: private collection preserves Linux source/custody evidence without sealing.
      // The old final fixture observed only a synthesized receipt after freeze-gated sealing.
      expect(linux.status, linux.error).toBe("classified")
      const raw = dirname(linux.rawRun!)
      const retained = JSON.parse(readFileSync(linux.rawRun!, "utf8")) as CapturedRunDraft
      const hostPath = join(raw, "host-measured.json")
      const containerPath = join(raw, "container-receipt.json")
      const host = parseJsonStrict(hostPath, readFileSync(hostPath, "utf8"))
      const container = parseJsonStrict(containerPath, readFileSync(containerPath, "utf8"))
      if (
        host === null ||
        typeof host !== "object" ||
        Array.isArray(host) ||
        !("runId" in host) ||
        !("runtime" in host) ||
        !("runnerArtifact" in host)
      ) {
        throw new Error(`${hostPath}: expected host identity and runtime receipt fields`)
      }
      if (
        container === null ||
        typeof container !== "object" ||
        Array.isArray(container) ||
        !("collector" in container) ||
        !("runId" in container) ||
        !("executable" in container) ||
        !("invocation" in container) ||
        !("sourceArtifact" in container) ||
        !("probeRun" in container) ||
        !("clipboardFixture" in container)
      ) {
        throw new Error(`${containerPath}: expected container identity and custody receipt fields`)
      }
      expect(host.runId).toBe(retained.runId)
      expect(host.runtime).toEqual({ imageId: "fixture-image", imageTarSha256: "c".repeat(64) })
      expect(host.runnerArtifact).toEqual(container.collector)
      expect(container.runId).toBe(retained.runId)
      expect(container.executable).toEqual({ path: "/fixture", sha256: "d".repeat(64) })
      expect(container.invocation).toEqual({ path: "/fixture", sha256: "e".repeat(64) })
      expect(container.sourceArtifact).toEqual({ sha256: "f".repeat(64) })
      expect(container.probeRun).toEqual({
        runId: retained.runId,
        sha256: createHash("sha256").update(readFileSync(linux.rawRun!)).digest("hex"),
      })
      expect(container.clipboardFixture).toEqual({
        runId: retained.runId,
        profile: "fixture",
        sha256: "a".repeat(64),
      })
      expect(retained).not.toHaveProperty("sealedAt")
      expect(existsSync(join(raw, "run-receipt.json"))).toBe(false)
      return
    }
    const row = pass.contexts.find((entry) => entry.context.kind === "lib" && entry.context.id === "xtermjs")!
    if (fault === "producer-zero-review" || fault === "producer-pending") {
      // The coordinator preserves the producer bytes under their original path.
      // Earlier snapshot tests did not verify exclusive writes and stable custody.
      expect(row.status, row.error).toBe("classified")
      expect(row.rawRun).toBe(producerPath)
      expect(readFileSync(row.rawRun!, "utf8")).toBe(producerBytes)
      if (fault === "producer-pending") {
        const retained = JSON.parse(producerBytes!) as CapturedRunDraft
        expect(retained.results[0]!.tests[0]!.status).toBe("probe-todo")
      }
      const receipt = JSON.parse(readFileSync(join(dirname(row.rawRun!), "collection.json"), "utf8")) as Pick<
        Awaited<ReturnType<typeof headless.collectHeadlessRuns>>,
        "runs"
      >
      expect(receipt.runs).toEqual([producerPath])
      expect(row.summary).toBeDefined()
      expect(row.classification).toBeDefined()
      return
    }
    if (fault === "matching" || fault === "source-negative-pending") {
      expect(row.status, row.error).toBe("classified")
      if (fault === "source-negative-pending") {
        // #32038 (@cto a6dbdad3): pre-resolution headless drafts live under first-pass/<engine>.draft.json,
        // and the pass output set holds exactly one draft per measured engine — the file pass.json names.
        expect(existsSync(join(pass.directory, "first-pass", "xtermjs.draft.json"))).toBe(true)
        expect(existsSync(join(pass.directory, "first-pass", "README.md"))).toBe(true)
        expect(
          readdirSync(pass.directory).filter((name) => name.startsWith("lib-") && name.endsWith(".draft.json")),
        ).toEqual([])
        const libDrafts = readdirSync(join(pass.directory, "lib"))
          .filter((name) => name.endsWith(".draft.json"))
          .map((name) => join(pass.directory, "lib", name))
        expect(libDrafts).toEqual([row.rawRun])
        const collectionReceipt = JSON.parse(readFileSync(join(pass.directory, "lib", "collection.json"), "utf8")) as {
          runs: string[]
        }
        expect(collectionReceipt.runs).toEqual([row.rawRun])
        expect(collectionReceipt.runs.every((entry) => existsSync(entry))).toBe(true)
        const appRow = pass.contexts.find(
          (entry) => entry.context.kind === "term" && entry.context.id === "alacritty" && entry.context.os === "linux",
        )!
        expect(appRow.status, appRow.error).toBe("classified")
        const snapshots = readdirSync(dirname(appRow.rawRun!))
        expect(snapshots).toContain("v3-run.draft.json")
        expect(snapshots).toHaveLength(1)
        expect(appRow.rawRun).toBe(join(dirname(appRow.rawRun!), "v3-run.draft.json"))
      }
    } else if (fault === "missing-collection-receipt") {
      expect(row.status).toBe("not-started")
      expect(row.error).toMatch(/Missing headless collection receipt .*collection\.json/)
      expect(row.rawRun && existsSync(row.rawRun)).toBe(true)
    } else {
      expect(row.status).toBe("not-started")
      expect(row.error).toMatch(
        fault === "foreign-run" ? /changed logical runId/ : /expected current schema-4 lib:xtermjs context/,
      )
    }
    expect(pass.complete).toBe(false)
  } finally {
    collector.mockRestore()
    launcher.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
