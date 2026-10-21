/** Collect private v2 headless runs from the same Termless adapters as the diagnostic suite. */
/* oxlint-disable typescript/no-deprecated -- Current Termless resolve() adapters expose TerminalBackend lifecycle; Emulator does not yet replace that loader. */

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { release, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { manifest, type TerminalBackend } from "@termless/core"
import {
  ALL_PROBES,
  initializeRunDraft,
  recordCollectionFailure,
  type RunDraft,
  type CapturedRunDraft,
} from "@terminfo/probe-defs"
import { parseRun } from "@terminfo/run-parser"
import { probeSuiteSnapshot } from "../admin/versions.ts"
import { saveDaemonProbeRun } from "../terminfo.dev/src/capture-writer.ts"
import { collectBatch, errorMessage } from "./headless-batch.ts"
import { owningCheckout } from "./termless-root.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
// Match the existing Linux full-probe HTTP budget for one engine.
const WORKER_TIMEOUT_MS = 120_000
const WORKER_STOP_GRACE_MS = 2_000

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function loadedBackend(value: unknown, specifier: string): TerminalBackend {
  if (
    !record(value) ||
    typeof value.init !== "function" ||
    typeof value.feed !== "function" ||
    typeof value.getCell !== "function" ||
    typeof value.reset !== "function" ||
    typeof value.destroy !== "function"
  ) {
    throw new Error(`${specifier} resolve() did not return a Termless backend`)
  }
  return value as unknown as TerminalBackend
}

export interface HeadlessCollection {
  directory: string
  requested: string[]
  runs: string[]
  failures: Array<{ backend: string; package: string; error: string }>
}

/**
 * A headless collection records the LIVE suite snapshot, not a stored declaration: this collector
 * legitimately runs on composed trees, and admission declares the manifest in the same commit as
 * the run it produced (27832 manifest direction (2)). A run whose suite is never admitted cannot be
 * cited, which is the correct outcome — not a collection-time failure.
 */
function trustedSuite() {
  const suite = probeSuiteSnapshot()
  const callbackIds = ALL_PROBES.filter((probe) => probe.termless !== null)
    .map((probe) => probe.id)
    .sort()
  if (callbackIds.join("\n") !== [...suite.probes.headless].sort().join("\n")) {
    throw new Error(`Headless callback membership differs from the live suite ${suite.probeHash}`)
  }
  return suite
}

/** The same collector runs in a fresh process for each engine: a native abort cannot hide another engine. */
async function collectOne(name: string, directory: string): Promise<string> {
  const { headlessRuntimeIdentity } = await import("./headless-identity.ts")
  const entry = manifest().backends[name]
  if (!entry || entry.type === "os") throw new Error(`Unknown or OS-only headless backend ${name}`)
  const suite = trustedSuite()
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  const sourcePaths = new Set([
    ...probeSuiteSnapshot().sourcePaths,
    "packages/run-parser/src",
    "packages/run-parser/package.json",
    "packages/probes/collect-headless.ts",
    "packages/probes/headless-batch.ts",
    "packages/probes/headless-identity.ts",
    "packages/admin/src/termless.ts",
    "packages/admin/versions.ts",
    "scripts/suite-manifest.ts",
    "packages/admin/suite-manifest.ts",
  ])
  const sourceDirty =
    execFileSync("git", ["status", "--porcelain", "--", ...sourcePaths], { cwd: ROOT, encoding: "utf8" })
      .toString()
      .trim().length > 0
  const draft = initializeRunDraft({
    runId: process.env.TERMINFO_CAPTURE_RUN_ID ?? randomUUID(),
    sourceRevision,
    manifest: suite,
    intendedContext: { kind: "headless", id: name, os: process.platform },
  })
  const draftPath = process.env.TERMINFO_DRAFT_PATH ?? join(directory, `${name}-${draft.runId}.draft.json`)
  const initialBytes = `${JSON.stringify(draft, null, 2)}\n`
  if (process.env.TERMINFO_DRAFT_PATH) {
    if (process.env.TERMINFO_DRAFT_PATH !== draftPath || readFileSync(draftPath, "utf8") !== initialBytes) {
      throw new Error("Delegated headless draft differs from initialized writer handoff")
    }
  } else writeFileSync(draftPath, initialBytes, { flag: "wx" })
  const checkpoint = () => writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`)
  let collectionStartedAt: string | undefined
  let backend: TerminalBackend | undefined
  try {
    if (name === "kitty" && !process.env.KITTY_BINARY) {
      throw new Error("Kitty requires KITTY_BINARY from a pinned Nix shell")
    }
    let adapterPath: string
    try {
      adapterPath = realpathSync(Bun.resolveSync(entry.package, import.meta.path))
    } catch (cause) {
      throw new Error(`${name} requires installed ${entry.package} in the owned source workspace`, { cause })
    }
    // The loaded adapter must belong to the checkout that tracks it; the call refuses otherwise.
    owningCheckout(adapterPath, entry.package)
    const mod: unknown = await import(pathToFileURL(adapterPath).href)
    if (!record(mod) || typeof mod.resolve !== "function") {
      throw new Error(`${entry.package} does not export resolve()`)
    }
    const resolveBackend = mod.resolve as () => Promise<unknown>
    collectionStartedAt = new Date().toISOString()
    draft.rawReplies["collector.collectionAttempt"] = JSON.stringify({
      startedAt: collectionStartedAt,
      ids: suite.probes.headless,
    })
    checkpoint()
    const loaded = loadedBackend(await resolveBackend(), entry.package)
    backend = loaded
    loaded.init({ cols: 80, rows: 24 })
    loaded.getCell(0, 0)
    const runtimeIdentity = await headlessRuntimeIdentity(name, entry.package, entry.type)
    backend = undefined
    loaded.destroy()
    const batch = await collectBatch(
      async () => loadedBackend(await resolveBackend(), entry.package),
      name,
      ALL_PROBES,
      draft,
      (progress) => {
        Object.assign(draft, {
          results: progress.results,
          rawReplies: { ...draft.rawReplies, ...progress.rawReplies },
          assertions: progress.assertions,
        })
        checkpoint()
      },
    )
    const run: CapturedRunDraft = {
      ...draft,
      target: {
        kind: "headless",
        id: name,
        version: runtimeIdentity.engineVersion,
        os: process.platform,
        osVersion: release(),
        outerTerminal: null,
        mux: null,
        config: "80x24 default Termless backend",
        permissions: null,
      },
      identity:
        sourceDirty ||
        (runtimeIdentity.kind === "js" &&
          runtimeIdentity.integrity.kind === "source" &&
          !runtimeIdentity.integrity.cleanTree)
          ? "unverified"
          : "verified",
      runtimeIdentity,
      suiteId: suite.probeHash,
      probeHash: suite.probeHash,
      sourceRevision: sourceDirty ? `${sourceRevision}+dirty` : sourceRevision,
      measuredAt: new Date().toISOString(),
      origin: { kind: "collector" },
      rawReplies: { ...draft.rawReplies, ...batch.rawReplies },
      assertions: batch.assertions,
      results: batch.results,
      screenshotRefs: [],
    }
    const path = join(directory, `${name}-${run.runId}.capture.json`)
    const bytes = `${JSON.stringify(run, null, 2)}\n`
    parseRun(path, bytes, suite.catalogIds, new Map([[suite.probeHash, suite]]), { mode: "capture" })
    writeFileSync(path, bytes, { flag: "wx" })
    return path
  } catch (error) {
    const diagnostic = errorMessage(error)
    if (collectionStartedAt) recordCollectionFailure(draft, collectionStartedAt, diagnostic, suite.probes.headless)
    else {
      draft.rawReplies["collector.prerequisite"] = diagnostic
      for (const result of draft.results) if (result.status === "test-todo") result.reason = diagnostic
    }
    checkpoint()
    throw error
  } finally {
    backend?.destroy()
  }
}

export async function collectHeadlessRuns(
  selectors: string[] = [],
  outputDirectory?: string,
  initializations?: ReadonlyMap<string, { draft: RunDraft; path: string }>,
): Promise<HeadlessCollection> {
  const backends = manifest().backends
  const osOnly = Object.entries(backends)
    .filter(([, value]) => value.type === "os")
    .map(([name]) => name)
  if (osOnly.join(",") !== "peekaboo") {
    throw new Error(`Expected peekaboo as the sole OS automation backend; found ${osOnly.join(", ")}`)
  }
  const headless = Object.keys(backends).filter((name) => backends[name]?.type !== "os")
  if (headless.length !== 11) throw new Error(`Expected 11 headless engines; found ${headless.length}`)
  const requested = selectors.length ? selectors : headless
  if (new Set(requested).size !== requested.length) throw new Error("Duplicate headless backend selector")
  const unknown = requested.filter((name) => !headless.includes(name))
  if (unknown.length) throw new Error(`Unknown headless backend selector(s): ${unknown.join(", ")}`)
  const suite = trustedSuite()
  const script = realpathSync(fileURLToPath(import.meta.url))
  if (!script.endsWith("/packages/probes/collect-headless.ts")) {
    throw new Error(`Packaged CLI has no local headless collector source at ${script}; install the source workspaces`)
  }
  const directory = outputDirectory ?? mkdtempSync(join(tmpdir(), "terminfo-headless-v3-"))
  mkdirSync(directory, { recursive: true })
  if (readdirSync(directory).length > 0) throw new Error(`Headless output directory is not empty: ${directory}`)
  const runs: string[] = []
  const failures: HeadlessCollection["failures"] = []

  for (const name of requested) {
    const entry = backends[name]
    if (!entry) throw new Error(`Manifest lost expected headless backend ${name}`)
    const stdoutPath = join(directory, `${name}.stdout.txt`)
    const stderrPath = join(directory, `${name}.stderr.txt`)
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
    const handed = initializations?.get(name)
    const delegated =
      handed?.draft ??
      initializeRunDraft({
        runId: randomUUID(),
        sourceRevision,
        manifest: suite,
        intendedContext: { kind: "headless", id: name, os: process.platform },
      })
    const draftPath = handed?.path ?? join(directory, `${name}-${delegated.runId}.draft.json`)
    if (handed) {
      if (readFileSync(draftPath, "utf8") !== `${JSON.stringify(delegated, null, 2)}\n`) {
        throw new Error(`Headless ${name} initial writer handoff differs`)
      }
    } else writeFileSync(draftPath, `${JSON.stringify(delegated, null, 2)}\n`, { flag: "wx" })
    const workerStartedAt = new Date().toISOString()
    const retainFailure = (diagnostic: string) => {
      const retained = JSON.parse(readFileSync(draftPath, "utf8")) as RunDraft
      if (
        retained.runId !== delegated.runId ||
        retained.probeHash !== suite.probeHash ||
        retained.sourceRevision !== sourceRevision
      ) {
        throw new Error(`Worker ${name} changed delegated run identity`)
      }
      if (!retained.rawReplies["collector.prerequisite"]) {
        recordCollectionFailure(retained, workerStartedAt, diagnostic, suite.probes.headless)
      }
      writeFileSync(draftPath, `${JSON.stringify(retained, null, 2)}\n`)
    }
    try {
      const child = Bun.spawn([process.execPath, script, "--one", name, directory], {
        cwd: ROOT,
        env: { ...process.env, TERMINFO_CAPTURE_RUN_ID: delegated.runId, TERMINFO_DRAFT_PATH: draftPath },
        stdout: "pipe",
        stderr: "pipe",
      })
      let exited = false
      let timedOut = false
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      const exit = child.exited.then((code) => {
        exited = true
        return code
      })
      const deadlineTimer = setTimeout(() => {
        if (exited) return
        timedOut = true
        child.kill("SIGTERM")
        forceTimer = setTimeout(() => {
          if (!exited) child.kill("SIGKILL")
        }, WORKER_STOP_GRACE_MS)
      }, WORKER_TIMEOUT_MS)
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        exit,
      ]).finally(() => {
        clearTimeout(deadlineTimer)
        if (forceTimer) clearTimeout(forceTimer)
      })
      writeFileSync(stdoutPath, stdout, { flag: "wx" })
      writeFileSync(stderrPath, stderr, { flag: "wx" })
      if (timedOut) {
        retainFailure(
          `Worker ${name} exceeded ${WORKER_TIMEOUT_MS}ms and exited ${exitCode}; stdout=${stdoutPath} stderr=${stderrPath}`,
        )
        failures.push({
          backend: name,
          package: entry.package,
          error: `Worker exceeded ${WORKER_TIMEOUT_MS}ms and exited ${exitCode}; stdout=${stdoutPath} stderr=${stderrPath}`,
        })
        continue
      }
      if (exitCode !== 0) {
        const lines = stderr
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
        const detail =
          lines.find((line) => line.includes("panicked at")) ??
          lines.find((line) => /^(?:Error|error):/.test(line)) ??
          lines.find((line) => line.startsWith("ENOENT:")) ??
          lines.at(-1) ??
          "no stderr"
        retainFailure(`Worker exited ${exitCode}: ${detail}; stderr=${stderrPath}`)
        failures.push({
          backend: name,
          package: entry.package,
          error: `Worker exited ${exitCode}: ${detail}; stderr=${stderrPath}`,
        })
        continue
      }
      const candidates = readdirSync(directory).filter(
        (file) => file.startsWith(`${name}-`) && file.endsWith(".capture.json"),
      )
      const [candidate] = candidates
      if (candidates.length !== 1 || !candidate) {
        throw new Error(
          `Worker exited 0 but wrote ${candidates.length} raw runs; stdout=${stdoutPath} stderr=${stderrPath}`,
        )
      }
      const path = join(directory, candidate)
      const parsed = parseRun(
        path,
        readFileSync(path, "utf8"),
        ALL_PROBES.map((probe) => probe.id),
        new Map([[suite.probeHash, suite]]),
        { mode: "capture" },
      )
      if (parsed.target.kind !== "headless" || parsed.target.id !== name) {
        throw new Error(`Worker wrote a run for ${parsed.target.id} instead of ${name}: ${path}`)
      }
      if (parsed.runId !== delegated.runId) throw new Error(`Worker ${name} changed runId during capture handoff`)
      const captured = JSON.parse(readFileSync(path, "utf8")) as CapturedRunDraft
      const finalPath = saveDaemonProbeRun(captured, directory)
      parseRun(
        finalPath,
        readFileSync(finalPath, "utf8"),
        suite.catalogIds ?? [],
        new Map([[suite.probeHash, suite]]),
        finalPath.endsWith(".draft.json") ? { mode: "capture" } : undefined,
      )
      runs.push(finalPath)
    } catch (error) {
      retainFailure(errorMessage(error))
      failures.push({ backend: name, package: entry.package, error: errorMessage(error) })
    }
  }

  const collection: HeadlessCollection = { directory, requested, runs, failures }
  writeFileSync(join(directory, "collection.json"), `${JSON.stringify(collection, null, 2)}\n`, { flag: "wx" })
  return collection
}

if (import.meta.main) {
  try {
    const [mode, name, directory] = process.argv.slice(2)
    if (mode !== "--one" || !name || !directory || process.argv.length !== 5) {
      throw new Error("Usage: bun packages/probes/collect-headless.ts --one BACKEND OUTPUT_DIRECTORY")
    }
    await collectOne(name, directory)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
