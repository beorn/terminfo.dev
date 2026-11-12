/**
 * Rows whose evidence is the OUTER terminal's own command record (33630, @cto ac738b73 / 5c25b17f).
 *
 * A multiplexer forwards bytes or drops them, and nothing inside its pane shows which. So on a mux subject these
 * rows do not grade the inner reply at all: the callback writes the row's target and the primary device attributes
 * request (DA1) as the window control, returns a criterion branch, and the collector's one outer command reader
 * decides from the outer terminal's trace — the control line present, and the target line present or absent inside
 * that invocation's window.
 *
 * The line shapes are the ones a direct outer kitty 0.49.2 run produced for each row
 * (`/hh/var/@dev2/33630/gate-table.md`), never a reading of terminal source. `editing.decrqcra` has no entry here:
 * that run found no line on either channel, so the reader refuses it by name and the row stays open.
 */
import type { OuterCommandRead, ProbeCallbackResult, ProbeDefinition } from "./types.ts"
import { parserStateResult } from "./helpers.ts"

/** The window control: a primary device attributes request, which the outer terminal reports in its trace. */
export const MUX_OUTER_ROW_CONTROL_WRITE = "\u001b[c"

export type MuxOuterRow = {
  /** The criterion branch the mux arm returns; the collector reads the outer record for exactly this branch. */
  branch: string
  /** The row's name in reason text, e.g. `OSC 701`. */
  label: string
  /** The target bytes the probe sends, verbatim, in the words the criterion uses. */
  write: string
}

export const MUX_OUTER_ROWS: Readonly<Record<string, MuxOuterRow>> = {
  "extensions.kitty-graphics": {
    branch: "kitty-graphics-mux-outer-command",
    label: "the Kitty graphics query",
    write: "\u001b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\u001b\\",
  },
  "extensions.osc701-locale": {
    branch: "osc701-mux-outer-command",
    label: "OSC 701",
    write: "\u001b]701;?\u0007",
  },
  "extensions.osc702-version": {
    branch: "osc702-mux-outer-command",
    label: "OSC 702",
    write: "\u001b]702;?\u0007",
  },
  "extensions.osc776-cell-size": {
    branch: "osc776-mux-outer-command",
    label: "OSC 776",
    write: "\u001b]776\u0007",
  },
  "extensions.osc7770-font-size": {
    branch: "osc7770-mux-outer-command",
    label: "OSC 7770",
    write: "\u001b]7770;?\u0007",
  },
}

/** The gate's finding for `editing.decrqcra`, in plain words: no line on either channel, so no reader can decide it. */
export const MUX_OUTER_DECRQ_UNREADABLE_BRANCH = "decrqcra-mux-outer-command-unreadable"
export const MUX_OUTER_DECRQ_UNREADABLE =
  "Open: the direct outer run that qualified the other rows sent this rectangle request and its device-attributes control, and the outer terminal reported neither a command line nor an error for it, so nothing in the outer terminal's trace separates a request the multiplexer dropped from one it forwarded. The row cannot be decided by the outer command record."

/** No record, a changed record or a missing control is never a grade: it is an invalid probe, named. */
export const MUX_OUTER_NO_RECORD =
  "No usable command record from the outer terminal, so what the multiplexer sent was not read."

function outerTrace(
  read: Extract<OuterCommandRead, { status: "measured" }>,
): { sha256: string; lines: number } | undefined {
  const trace = (read as { trace?: { sha256?: unknown; lines?: unknown } }).trace
  if (trace === undefined || typeof trace.sha256 !== "string" || typeof trace.lines !== "number") return undefined
  return { sha256: trace.sha256, lines: trace.lines }
}

/**
 * Grades the outer command reading alone. A target line means the multiplexer forwarded the row's bytes, which is
 * all this reader knows — whether the outer terminal applied the feature is not read here. Control present and no
 * target line is the criterion's Unsupported. Anything less than a measured window is probe-invalid by name.
 */
export function muxOuterRowGrade(row: MuxOuterRow) {
  return (read: OuterCommandRead): ProbeCallbackResult => {
    const state = { outerCommands: read }
    const open = (status: "probe-todo" | "probe-invalid", reason: string): ProbeCallbackResult => ({
      pass: false,
      response: JSON.stringify(state),
      criterionBranch: row.branch,
      tests: [{ id: "outer-command-record", status, reason }],
    })
    if (read.status !== "measured") return open("probe-invalid", `${MUX_OUTER_NO_RECORD} ${read.reason}`)
    const outer = `${read.outer.app} ${read.outer.version}`
    if (read.targetSent) {
      return open(
        "probe-todo",
        `${row.label} reached the outer terminal (${outer}); whether the outer terminal applied it was not read.`,
      )
    }
    const trace = outerTrace(read)
    if (trace === undefined) {
      return open("probe-invalid", `${MUX_OUTER_NO_RECORD} The record carries no trace digest for this window.`)
    }
    return {
      ...parserStateResult(
        false,
        `the outer terminal's command trace shows the control ${MUX_OUTER_ROW_CONTROL_WRITE} and ${row.label}`,
        state,
        `Unsupported: the multiplexer did not forward ${row.label}: the outer terminal's command trace shows the control ${MUX_OUTER_ROW_CONTROL_WRITE} and no ${row.label} in the same invocation window (${trace.lines} lines; trace sha256 ${trace.sha256}).`,
      ),
      criterionBranch: row.branch,
    }
  }
}

/** A mux arm for one row: send the target, send the window control, and let the collector read the outer record. */
export function withMuxOuterRows(
  rows: Readonly<Record<string, MuxOuterRow>>,
): (definition: ProbeDefinition) => ProbeDefinition {
  return (definition) => {
    const row = rows[definition.id]
    const term = definition.term
    if (row === undefined || typeof term !== "function") return definition
    return {
      ...definition,
      term: async (ctx) => {
        if (ctx.mux === undefined) return term(ctx)
        ctx.write(row.write)
        ctx.write(MUX_OUTER_ROW_CONTROL_WRITE)
        return {
          pass: false,
          criterionBranch: row.branch,
          tests: [
            {
              id: "outer-command-record",
              status: "probe-todo",
              reason: `Waiting for the outer terminal's command record for ${row.label}.`,
            },
          ],
        }
      },
      outerCommands: { branch: row.branch, grade: muxOuterRowGrade(row) },
    }
  }
}

/**
 * `editing.decrqcra` on a mux subject: the same bytes as every other run, and the gate's finding as the row's
 * reason. No outer command read is registered for it, because the qualified run showed the record cannot carry it.
 */
export function withMuxOuterUnreadableRow(
  featureId: string,
  write: string,
): (definition: ProbeDefinition) => ProbeDefinition {
  return (definition) => {
    const term = definition.term
    if (definition.id !== featureId || typeof term !== "function") return definition
    return {
      ...definition,
      term: async (ctx) => {
        if (ctx.mux === undefined) return term(ctx)
        ctx.write(write)
        ctx.write(MUX_OUTER_ROW_CONTROL_WRITE)
        return {
          pass: false,
          criterionBranch: MUX_OUTER_DECRQ_UNREADABLE_BRANCH,
          tests: [{ id: "outer-command-record", status: "probe-todo", reason: MUX_OUTER_DECRQ_UNREADABLE }],
        }
      },
    }
  }
}
