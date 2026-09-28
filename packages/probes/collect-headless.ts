/** Collect private v2 headless runs from the same Termless adapters as the diagnostic suite. */
/* oxlint-disable typescript/no-deprecated -- Current Termless resolve() adapters expose TerminalBackend lifecycle; Emulator does not yet replace that loader. */

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { release, tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { manifest, type TerminalBackend } from "@termless/core"
import {
  ALL_PROBES,
  type Observation,
  type ProbeAssertion,
  type ProbeResult,
  type ProbeRun,
  type TermlessContext,
  type UngradedDiagnostic,
} from "@terminfo/probe-defs"
import { parseRun } from "../../docs/data/selected-results.ts"
import { checkCurrentSuiteManifest } from "../../scripts/suite-manifest.ts"
import { headlessRuntimeIdentity } from "./headless-identity.ts"

const ROOT = resolve(import.meta.dir, "../..")
let TERMLESS_ROOT: string
try {
  TERMLESS_ROOT = realpathSync(resolve(ROOT, "../termless"))
} catch (cause) {
  throw new Error(`Local headless v2 collection requires the owned Termless checkout beside ${ROOT}`, { cause })
}
const encoder = new TextEncoder()
const decoder = new TextDecoder()

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

function context(backend: TerminalBackend): TermlessContext {
  return {
    feed(text) {
      backend.feed(encoder.encode(text))
    },
    feedCapture(text) {
      let response = ""
      const previous = backend.onResponse
      backend.onResponse = (bytes) => {
        response += decoder.decode(bytes)
      }
      try {
        backend.feed(encoder.encode(text))
      } finally {
        backend.onResponse = previous
      }
      return response
    },
    getCell(row, col) {
      return backend.getCell(row, col) as ReturnType<TermlessContext["getCell"]>
    },
    getCursor() {
      return backend.getCursor()
    },
    getMode(mode) {
      return backend.getMode(mode as Parameters<TerminalBackend["getMode"]>[0])
    },
    getText() {
      return backend.getText()
    },
    getScrollback() {
      return backend.getScrollback()
    },
    getTitle() {
      return backend.getTitle()
    },
    reset() {
      backend.reset()
    },
    get capabilities() {
      return backend.capabilities as TermlessContext["capabilities"]
    },
  }
}

interface Batch {
  rawReplies: Record<string, string>
  observations: Observation[]
  assertions: ProbeAssertion[]
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A callback conclusion without its raw state cannot become a support claim. */
function recordResult(batch: Batch, id: string, result: ProbeResult): void {
  const explicit = result.observation
  if (!explicit) {
    batch.ungradedDiagnostics[id] = {
      kind: "legacy-callback",
      pass: result.pass,
      ...(result.note && { note: result.note }),
      ...(result.response !== undefined && { response: result.response }),
    }
    return
  }
  const conclusive = explicit.outcome === "supported" || explicit.outcome === "unsupported"
  const bound = result.response !== undefined && result.response.length > 0
  const expectedKind = explicit.outcome === "supported" ? "positive" : "negative"
  const validAssertions = (result.assertions ?? []).filter(
    (assertion) => assertion.kind === expectedKind && assertion.expected.length > 0 && assertion.observed.length > 0,
  )
  const bindingInvalid =
    !bound ||
    validAssertions.length === 0 ||
    (result.assertions ?? []).some((assertion) => assertion.kind !== expectedKind) ||
    (explicit.evidence === "parser-state" &&
      !validAssertions.some((assertion) => assertion.observed === result.response))
  if (
    (conclusive && bindingInvalid) ||
    ((explicit.outcome === "error" || explicit.outcome === "inconclusive") && !explicit.reason)
  ) {
    batch.observations.push({
      featureId: id,
      outcome: "error",
      reason: "collector-error",
      evidence: explicit.evidence,
      note: `Callback result lacks ${conclusive ? "matching raw state and assertion" : "an inconclusive/error reason"}`,
    })
    return
  }
  if (result.response !== undefined) batch.rawReplies[id] = result.response
  batch.observations.push({ featureId: id, ...explicit, ...(bound && { rawReplyRef: id }) })
  for (const assertion of result.assertions ?? []) {
    batch.assertions.push({ featureId: id, ...assertion, ...(bound && { rawReplyRef: id }) })
  }
}

function collectBatch(backend: TerminalBackend): Batch {
  const batch: Batch = { rawReplies: {}, observations: [], assertions: [], ungradedDiagnostics: {} }
  const ctx = context(backend)
  for (const probe of ALL_PROBES) {
    if (!probe.termless) continue
    try {
      backend.reset()
      recordResult(batch, probe.id, probe.termless(ctx))
    } catch (error) {
      const message = errorMessage(error)
      if (probe.termObservationEvidence) {
        batch.observations.push({
          featureId: probe.id,
          outcome: "error",
          reason: "collector-error",
          evidence: probe.termObservationEvidence,
          note: message,
        })
      } else {
        batch.ungradedDiagnostics[probe.id] = {
          kind: "collector-error",
          name: error instanceof Error ? error.name : "Error",
          message,
        }
      }
    }
  }
  return batch
}

export interface HeadlessCollection {
  directory: string
  runs: string[]
  failures: Array<{ backend: string; package: string; error: string }>
}

export async function collectHeadlessRuns(
  selectors: string[] = [],
  outputDirectory?: string,
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

  const suite = checkCurrentSuiteManifest()
  const callbackIds = ALL_PROBES.filter((probe) => probe.termless !== null)
    .map((probe) => probe.id)
    .sort()
  if (callbackIds.join("\n") !== [...suite.probes.headless].sort().join("\n")) {
    throw new Error(`Headless callback membership differs from trusted suite ${suite.probeHash}`)
  }
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  const collectorDirty =
    execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        "packages/probes/collect-headless.ts",
        "packages/probes/headless-identity.ts",
        "packages/admin/src/termless.ts",
      ],
      { cwd: ROOT, encoding: "utf8" },
    )
      .toString()
      .trim().length > 0
  const directory = outputDirectory ?? mkdtempSync(join(tmpdir(), "terminfo-headless-v2-"))
  mkdirSync(directory, { recursive: true })
  const runs: string[] = []
  const failures: HeadlessCollection["failures"] = []

  for (const name of requested) {
    const entry = backends[name]
    if (!entry) throw new Error(`Manifest lost expected headless backend ${name}`)
    let backend: TerminalBackend | undefined
    try {
      if (name === "kitty" && !process.env.KITTY_BINARY) {
        throw new Error("Kitty requires KITTY_BINARY from a pinned Nix shell")
      }
      const adapterPath = realpathSync(Bun.resolveSync(entry.package, import.meta.path))
      const adapterRelative = relative(TERMLESS_ROOT, adapterPath)
      if (adapterRelative.startsWith("../") || adapterRelative === ".." || adapterRelative.startsWith("/")) {
        throw new Error(`${entry.package} resolved outside owned Termless: ${adapterPath}`)
      }
      const mod: unknown = await import(pathToFileURL(adapterPath).href)
      if (!record(mod) || typeof mod.resolve !== "function") {
        throw new Error(`${entry.package} does not export resolve()`)
      }
      const resolveBackend = mod.resolve as () => Promise<unknown>
      const loaded = loadedBackend(await resolveBackend(), entry.package)
      backend = loaded
      loaded.init({ cols: 80, rows: 24 })
      loaded.getCell(0, 0)
      const runtimeIdentity = await headlessRuntimeIdentity(name, entry.package, entry.type)
      const batch = collectBatch(loaded)
      const run: ProbeRun = {
        schemaVersion: 2,
        runId: randomUUID(),
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
          collectorDirty ||
          (runtimeIdentity.kind === "js" &&
            runtimeIdentity.integrity.kind === "source" &&
            !runtimeIdentity.integrity.cleanTree)
            ? "unverified"
            : "verified",
        runtimeIdentity,
        suiteId: suite.probeHash,
        probeHash: suite.probeHash,
        suiteComplete: batch.observations.length === suite.probes.headless.length,
        sourceRevision,
        measuredAt: new Date().toISOString(),
        origin: { kind: "collector" },
        ...batch,
        screenshotRefs: [],
      }
      const path = join(directory, `${name}-${run.runId}.json`)
      const bytes = `${JSON.stringify(run, null, 2)}\n`
      parseRun(
        path,
        bytes,
        ALL_PROBES.map((probe) => probe.id),
        new Map([[suite.probeHash, suite]]),
      )
      writeFileSync(path, bytes, { flag: "wx" })
      runs.push(path)
    } catch (error) {
      failures.push({ backend: name, package: entry.package, error: errorMessage(error) })
    } finally {
      try {
        backend?.destroy()
      } catch (error) {
        failures.push({
          backend: name,
          package: entry.package,
          error: `Backend cleanup failed: ${errorMessage(error)}`,
        })
      }
    }
  }

  const collection: HeadlessCollection = { directory, runs, failures }
  writeFileSync(join(directory, "collection.json"), `${JSON.stringify(collection, null, 2)}\n`, { flag: "wx" })
  return collection
}
