import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ProbeResult, TermContext } from "@terminfo/probe-defs"
import type { TTYTraceEvent } from "../../packages/terminfo.dev/src/tty.ts"
import { createCallLog, withCallLog } from "./call-log.ts"

const specimens = new Set(["device.tertiary-da", "erase.screen.scrollback", "sgr.bold", "extensions.font-ligatures"])

export async function observeSpikeB(
  featureId: string,
  callback: (context: TermContext) => Promise<ProbeResult>,
  context: TermContext,
  events: TTYTraceEvent[],
): Promise<ProbeResult> {
  const runId = process.env.TERMINFO_CAPTURE_RUN_ID
  const modeCode = runId?.match(/^30923([abc])[0-9a-f]{26}$/)?.[1]
  const mode =
    modeCode === "a" ? "selection" : modeCode === "b" ? "baseline" : modeCode === "c" ? "decorated" : undefined
  if (!mode || !specimens.has(featureId)) return callback(context)
  const captureDirectory = process.env.TERMINFO_CAPTURE_DIRECTORY
  if (!captureDirectory) throw new Error("Spike B needs the existing Linux launcher's TERMINFO_CAPTURE_DIRECTORY")
  const directory = join(dirname(captureDirectory), "spike-b")
  mkdirSync(directory, { recursive: true })
  const log = createCallLog()
  const recorded = mode === "decorated" ? withCallLog(context, { mode: "record", log }) : undefined
  const startedAt = Date.now()
  const startedMonotonic = performance.now()
  const firstEvent = events.length
  let result: ProbeResult | undefined
  let failure: { name: string; message: string } | undefined
  try {
    result = await callback(recorded?.context ?? context)
    recorded?.finish()
    return result
  } catch (error) {
    failure =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "ThrownValue", message: String(error) }
    throw error
  } finally {
    const finishedAt = Date.now()
    const finishedMonotonic = performance.now()
    writeFileSync(
      join(directory, `${featureId}.json`),
      JSON.stringify(
        {
          version: 1,
          runId,
          mode,
          featureId,
          pid: process.pid,
          startedAt,
          finishedAt,
          startedMonotonic,
          finishedMonotonic,
          firstEvent,
          nextEvent: events.length,
          events: events.slice(firstEvent),
          ...(recorded ? { log } : {}),
          ...(failure ? { failure } : { result }),
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    )
  }
}
