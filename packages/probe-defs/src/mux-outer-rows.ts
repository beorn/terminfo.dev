/**
 * Rows whose evidence is the OUTER terminal's own command record (33630, @cto ac738b73 / 5c25b17f).
 *
 * tmux forwards bytes or drops them, and nothing inside its pane shows which. So on a tmux subject these rows do not
 * grade the inner reply at all: the callback writes the row's target and then the shared title forwarding control,
 * returns a criterion branch, and the collector's one outer command reader decides from the outer terminal's trace —
 * the control line present, and the target line present or absent inside that invocation's window. tmux only: the
 * collector has no qualified outer command reader for any other mux, so every other subject (Screen included) keeps
 * the callback it had.
 *
 * The line shapes are the ones a direct outer kitty 0.49.2 run produced for each row
 * (`/hh/var/@dev2/33630/gate-table.md`), never a reading of terminal source. `editing.decrqcra` has no entry here:
 * that run found no line on either channel, so the reader refuses it by name and the row stays open.
 */
import { randomUUID } from "node:crypto"
import type { OuterCommandRead, ProbeCallbackResult, ProbeDefinition } from "./types.ts"
import { declaredUntestableResult, parserStateResult } from "./helpers.ts"

/**
 * The DA1 window control the gate's direct run qualified. `editing.decrqcra`'s arm still writes it, and the qualified
 * direct windows carry it. The five rows below use the shared title control instead: under a multiplexer tmux answers
 * DA1 inside the pane, so that line never reaches the outer record (@cto 60c52bf0).
 */
export const MUX_OUTER_ROW_CONTROL_WRITE = "\u001b[c"

/**
 * The one forwarding control both outer-record arms share: an OSC 2 title carrying this invocation's nonce. The
 * callback writes the row's target FIRST and this control second, so everything the multiplexer forwarded before the
 * control is already in the record and a missing target line is a real negative (@cto 33919 condition 3, 60c52bf0).
 * tmux forwards it only with `set-titles` on; under the default config its absence leaves these rows untestable
 * rather than probe-invalid.
 */
export const MUX_TITLE_CONTROL_WRITE = /^\u001b\]2;(tdv-title-[0-9a-f]{24})\u001b\\$/
export function muxTitleControlWrite(nonce: string): string {
  return `\u001b]2;tdv-title-${nonce}\u001b\\`
}
export function muxTitleControlNonce(): string {
  return randomUUID().replaceAll("-", "").slice(0, 24)
}

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

/**
 * The declared untestable reason for a run whose mux config forwards no title (the empty default tmux config): no
 * forwarding control can appear, so the record can never decide these rows there (@cto 60c52bf0, 33919 condition 2).
 */
export function muxOuterNoControlDefault(label: string): string {
  return `No forwarding control reaches the outer record under the default config, so what the multiplexer sent for ${label} was not read.`
}

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
 * target line is the criterion's Unsupported. An unmeasured window is declared untestable only when this run's config
 * forwards no title AND the missing forwarding control is why it was unread; every other unmeasured read is
 * probe-invalid with the reader's own reason.
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
    if (read.status !== "measured") {
      if (read.titlesForwarded === false && read.noForwardingControl === true) {
        return declaredUntestableResult(muxOuterNoControlDefault(row.label), state)
      }
      return open("probe-invalid", `${MUX_OUTER_NO_RECORD} ${read.reason}`)
    }
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
        `the outer terminal's command record shows the forwarding control arriving after the row's write and no ${row.label} line`,
        state,
        `Unsupported: the multiplexer did not forward ${row.label}: the outer terminal's command record shows the forwarding control arriving after the row's write and no ${row.label} line in that invocation's window (${trace.lines} lines; trace sha256 ${trace.sha256}).`,
      ),
      criterionBranch: row.branch,
    }
  }
}

/** A mux arm for one row: send the target, then the shared title control, and let the collector read the outer record. */
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
        if (ctx.mux !== "tmux") return term(ctx)
        ctx.write(row.write)
        ctx.write(muxTitleControlWrite(muxTitleControlNonce()))
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
 * `editing.decrqcra` on a tmux subject: the same bytes as every other run, and the gate's finding as the row's reason.
 * No outer command read is registered for it, because the qualified run showed the record cannot carry it. Every other
 * subject, Screen included, keeps the callback it had.
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
        if (ctx.mux !== "tmux") return term(ctx)
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
