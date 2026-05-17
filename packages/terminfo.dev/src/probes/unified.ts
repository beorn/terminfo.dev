/**
 * CLI probe adapter — wraps unified probe-defs with TermContext from tty.ts.
 *
 * Imports ALL_PROBES from @terminfo/probe-defs, creates a TermContext using
 * the tty.ts helpers (query, queryCursorPosition, measureRenderedWidth, queryMode),
 * and exports the same `Probe[]` interface the CLI expects.
 */

import { ALL_PROBES as PROBE_DEFS, type TermContext } from "@terminfo/probe-defs"
import { query, queryWithSentinel, queryCursorPosition, measureRenderedWidth, queryMode } from "../tty.ts"

export interface ProbeResult {
  pass: boolean
  note?: string
  response?: string
}

export interface Probe {
  id: string
  name: string
  run: () => Promise<ProbeResult>
}

/** Build a TermContext from the tty.ts helpers */
function createTermContext(): TermContext {
  return {
    write(text: string) {
      process.stdout.write(text)
    },
    async queryCursorPosition() {
      const result = await queryCursorPosition()
      if (!result) return null
      return { row: result[0], col: result[1] }
    },
    measureRenderedWidth,
    query,
    queryWithSentinel,
    queryMode,
    get cols() {
      return process.stdout.columns || 80
    },
  }
}

const ctx = createTermContext()

/** Convert probe-defs to the Probe interface the CLI expects */
export const ALL_PROBES: Probe[] = PROBE_DEFS.filter((p) => p.term !== null).map((p) => ({
  id: p.id,
  name: p.id, // CLI uses id as the display name; the old code had a separate name field
  async run() {
    return p.term!(ctx)
  },
}))
