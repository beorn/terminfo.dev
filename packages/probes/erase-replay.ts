/** Internal first-family execution; provenance and retained checks are finalized by its runner. */
import type { TestContext } from "vitest"
import { withChecks, type RetainedCheck } from "./checks.ts"
import { createXtermBackend } from "@termless/xtermjs"
import { fileURLToPath } from "node:url"
import { readAdapterSources, verifyAdapterSources } from "./headless-identity.ts"
import { eraseProbes, createEraseProbes, eraseHistoryPredicates } from "../probe-defs/src/erase.ts"
import { gridMatch, cursorMatch } from "../probe-defs/src/region-readback-kind.ts"
import type { HeadlessRuntimeIdentity, LibProbeSource, ProbeCallbackResult } from "@terminfo/probe-defs"
import { createCallLog, withCallLog, type CallLog } from "viprobe"
import { createLibProbeSource } from "./headless-batch.ts"
import { HEADLESS_TERMINAL } from "./headless-terminal.ts"

type EraseRecord = {
  featureId: string
  startedAt: string
  result: ProbeCallbackResult
  checks: readonly RetainedCheck[]
}
type EraseHost = { open(featureId: string, geometry: typeof HEADLESS_TERMINAL): LibProbeSource; close(): void }

function liveHost(identity: HeadlessRuntimeIdentity): EraseHost {
  let backend: ReturnType<typeof createXtermBackend> | undefined
  return {
    open(_featureId, geometry) {
      if (backend) throw new Error("Erase host already owns an open backend")
      backend = createXtermBackend()
      backend.init(geometry)
      try {
        identity.adapterSources = readAdapterSources("xtermjs", backend)
        verifyAdapterSources("xtermjs", {
          identity,
          adapterPath: fileURLToPath(import.meta.resolve("@termless/xtermjs")),
          adapterPackage: "@termless/xtermjs",
          adapterType: "js",
        })
      } catch (error) {
        backend.destroy()
        backend = undefined
        throw error
      }
      return createLibProbeSource(backend, undefined, undefined, undefined)
    },
    close() {
      if (!backend) throw new Error("Erase host has no open backend to close")
      backend.destroy()
      backend = undefined
    },
  }
}

function matcher<Args extends unknown[]>(predicate: (...args: Args) => boolean, expected?: unknown) {
  return (...args: Args) => ({
    pass: predicate(...args),
    actual: args[0],
    expected: expected === undefined ? args[1] : expected,
    message: () => "Erase predicate did not match the retained observation",
  })
}

const matchers = {
  gridMatch: matcher(gridMatch),
  cursorMatch: matcher(cursorMatch),
  screenRows: matcher(eraseHistoryPredicates.screenRows, { integer: true, min: 1, max: 1000 }),
  history: matcher(eraseHistoryPredicates.history),
  geometry: matcher(eraseHistoryPredicates.geometry),
  erased: matcher(eraseHistoryPredicates.erased),
}

function execute(host: EraseHost, context: TestContext, mode: "record" | "replay"): EraseRecord[] {
  return eraseProbes.map((definition) => {
    const startedAt = new Date().toISOString()
    const source = host.open(definition.id, HEADLESS_TERMINAL)
    let result: ProbeCallbackResult
    let retained: readonly RetainedCheck[]
    try {
      const session = withChecks(context, { mode, matchers })
      try {
        const probe = createEraseProbes({
          grid: (kind, ...args) =>
            kind === "assertion" ? session.check("gridMatch", ...args) : session.precondition("gridMatch", ...args),
          cursor: (...args) => session.precondition("cursorMatch", ...args),
          history: {
            screenRows: (...args) => session.precondition("screenRows", ...args),
            history: (...args) => session.precondition("history", ...args),
            geometry: (...args) => session.precondition("geometry", ...args),
            erased: (...args) => session.check("erased", ...args),
          },
        }).find(({ id }) => id === definition.id)
        if (!probe?.lib) throw new Error("Erase callback missing: " + definition.id)
        source.reset()
        result = probe.lib(source)
      } finally {
        retained = session.finish()
      }
    } finally {
      host.close()
    }
    return { featureId: definition.id, startedAt, result, checks: retained }
  })
}

export function captureEraseCalls(
  context: TestContext,
  identity: HeadlessRuntimeIdentity,
): { log: CallLog; results: EraseRecord[] } {
  const log = createCallLog()
  const session = withCallLog(liveHost(identity), { mode: "record", log })
  try {
    return { log, results: execute(session.context, context, "record") }
  } finally {
    session.finish()
  }
}

export function replayEraseCalls(log: CallLog, context: TestContext): EraseRecord[] {
  const session = withCallLog<EraseHost>(null, { mode: "replay", log })
  try {
    return execute(session.context, context, "replay")
  } finally {
    session.finish()
  }
}
