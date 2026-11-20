/**
 * 34753: the probe daemon used to write nothing until a whole collection finished, so a client's own
 * header timer decided whether a long run was alive (34477 aborted at ~362 s, 34742 had to raise
 * undici's 300 s timers to 35 min). This owner streams one admitted response: real headers, then a
 * single newline every `PROBE_KEEPALIVE_INTERVAL_MS`, then the caller's final JSON body.
 *
 * The keepalive bytes are leading JSON whitespace (0x20 0x09 0x0a 0x0d), so the payload a client
 * parses and retains is unchanged; the client strips that transport prefix once, at its retention
 * boundary (@cto 34753-probe-streaming-go.md, condition 5).
 *
 * A response that closes before its body finishes aborts `signal`, which the collector must honour
 * by stopping the active operation rather than only abandoning the HTTP promise (condition 3).
 */
import type { ServerResponse } from "node:http"

/** A tenth of undici's default 300 s headers and body timers, so jitter cannot close the gap. */
export const PROBE_KEEPALIVE_INTERVAL_MS = 30_000

export type ProbeStream = {
  /** Aborts when the client leaves mid-collection; never aborts on a normal end. */
  readonly signal: AbortSignal
  /** Real headers plus the first body byte. Idempotent; a no-op once released or already gone. */
  admitted(): void
  /** Stops the keepalive. Safe on every exit path. */
  release(): void
}

function clientGone(runId: string): Error {
  const error = new Error(`Probe client closed its connection before run ${runId} finished`)
  error.name = "AbortError"
  return error
}

export function openProbeResponse(
  res: ServerResponse,
  runId: string,
  keepaliveMs: number = PROBE_KEEPALIVE_INTERVAL_MS,
): ProbeStream {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let released = false
  let started = false

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    released = true
  }
  const gone = (): void => {
    stop()
    if (!res.writableEnded) controller.abort(clientGone(runId))
  }
  res.on("close", gone)
  res.on("error", gone)
  // 34941: a response that is already gone can admit nothing. This is not `gone()`: that one keeps a
  // normally-ended response quiet, while this one must abort so the caller starts no collection at all.
  if (res.destroyed || res.writableEnded) {
    stop()
    controller.abort(clientGone(runId))
  }

  return {
    signal: controller.signal,
    admitted() {
      if (started || released || res.destroyed || res.writableEnded) return
      started = true
      // Headers go out now, not with the final body: undici's headers timer measures exactly this.
      res.flushHeaders()
      // The first body byte travels with the admission, so even a keepalive interval that never
      // ticks cannot leave the client counting from headers alone.
      res.write("\n")
      timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          stop()
          return
        }
        res.write("\n")
      }, keepaliveMs)
      timer.unref?.()
    },
    release: stop,
  }
}
