/** Internal first-family execution; provenance and retained checks are finalized by its runner. */
import { createXtermBackend } from "@termless/xtermjs"
import { eraseProbes } from "../probe-defs/src/erase.ts"
import type { LibProbeSource, ProbeCallbackResult } from "@terminfo/probe-defs"
import { createCallLog, withCallLog, type CallLog } from "viprobe"
import { createLibProbeSource } from "./headless-batch.ts"
import { HEADLESS_TERMINAL } from "./headless-terminal.ts"

type EraseRecord = { featureId: string; result: ProbeCallbackResult }
type EraseHost = { open(featureId: string, geometry: typeof HEADLESS_TERMINAL): LibProbeSource; close(): void }

function liveHost(): EraseHost {
  let backend: ReturnType<typeof createXtermBackend> | undefined
  return {
    open(_featureId, geometry) {
      if (backend) throw new Error("Erase host already owns an open backend")
      backend = createXtermBackend()
      backend.init(geometry)
      return createLibProbeSource(backend, undefined, undefined, undefined)
    },
    close() {
      if (!backend) throw new Error("Erase host has no open backend to close")
      backend.destroy()
      backend = undefined
    },
  }
}

function execute(host: EraseHost): EraseRecord[] {
  return eraseProbes.map((probe) => {
    if (!probe.lib) throw new Error("Erase callback missing: " + probe.id)
    const source = host.open(probe.id, HEADLESS_TERMINAL)
    try {
      source.reset()
      return { featureId: probe.id, result: probe.lib(source) }
    } finally {
      host.close()
    }
  })
}

export function captureEraseCalls(): { log: CallLog; results: EraseRecord[] } {
  const log = createCallLog()
  const session = withCallLog(liveHost(), { mode: "record", log })
  try {
    return { log, results: execute(session.context) }
  } finally {
    session.finish()
  }
}

export function replayEraseCalls(log: CallLog): EraseRecord[] {
  const session = withCallLog<EraseHost>(null, { mode: "replay", log })
  try {
    return execute(session.context)
  } finally {
    session.finish()
  }
}
