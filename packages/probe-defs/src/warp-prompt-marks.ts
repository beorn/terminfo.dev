/**
 * #34899 (@cto REVISE 1, r2 C1-C5): Warp's prompt-mark cells need a criterion per subject, never a
 * declaration. This sibling sits beside promptMarkAppResult and answers the same rows from frames:
 * each mark is written alone at a known position over a fixed block, with the same bytes minus the
 * mark as its omission control, and once more at a different position. A row is graded only when the
 * frame shows that marker's own boundary, the earlier block is retained, and the boundary follows the
 * mark when its position changes. Every other outcome stays open naming the control that failed.
 *
 * An unchanged frame names an inert reader: that is a measured negative for this route, never a
 * finding about the terminal (C1).
 *
 * #34899 AC4b (@cto 171e1def): after those ten target reads the arm reads three role "control" pairs.
 * Two negative controls write bytes that are not a prompt mark in the mark's place; a Supported also
 * needs both to leave the frame as the omission read left it, and neither can grant one. The
 * overlay-visibility control rewrites rows 1-2 and 5 with no mark: rows 1-2 unchanged while row 5
 * changes shows an overlay over rows 1-2 on a live capture. It moves no grade and is not criterion W
 * §1's prompt-mark positive control, which this route cannot run.
 */
import type {
  CaptureCells,
  CapturePixelGeometry,
  CaptureRectangle,
  ObservationFrame,
  ProbeCallbackResult,
  TermProbeSource,
} from "./types.ts"

export type WarpMarkKind =
  | "prompt-start"
  | "command-start"
  | "output-start"
  | "secondary-prompt"
  | "command-finished"
  | "text"
  | "properties"

export interface WarpMarkSpec {
  /** The probe id, so the result names the row that asked. */
  id: string
  /** The exact bytes of one mark, with no trailing text. */
  mark: string
  kind: WarpMarkKind
}

/** The fixed block every variant writes: one line per row, so any boundary is attributable to the mark. */
const BLOCK_ROWS = 8
const MARK_ROW = 4
// #34949 (@dev/12's peer REVISE): band(r) spans r-1..r+1, so a moved mark one row below the first (6)
// shared row 5 with band(4), and a reader painting every boundary at that fixed row passed BOTH
// comparisons. Seven gives band(7) = rows 6-8, disjoint from band(4) = rows 3-5 and still inside the
// eight-row block, so no fixed row can sit in both comparisons.
const SHIFTED_MARK_ROW = 7
const RIGHT = 40

/**
 * Rows compared as the boundary band and as retained history. The history band is fixed at the block
 * above the target mark and is never widened with the mark's row: the shifted variant carries a
 * different band, and comparing two rectangles of different size would always differ. The two
 * boundary bands are DISJOINT (#34949): otherwise a fixed row inside their shared neighbourhood
 * satisfies the appeared and the followed comparisons at once.
 */
const band = (row: number): CaptureCells => ({ top: row - 1, left: 1, bottom: row + 1, right: RIGHT })
const retainedHistory = (): CaptureCells => ({ top: 1, left: 1, bottom: MARK_ROW - 2, right: RIGHT })

/**
 * The rectangle as the reason names it (#34899 AC4, @dev/11's read of run 44398257551): the run records
 * both rectangles it compared, so a reader can tell whether to chase the terminal or the arm without
 * reading this file. Naming a region can only change reason text and the recorded response, never a
 * status: the four comparisons below are unchanged.
 */
const describeRect = (cells: CaptureCells): string =>
  "rows " + String(cells.top) + "-" + String(cells.bottom) + ", cols " + String(cells.left) + "-" + String(cells.right)

function geometryOf(ctx: TermProbeSource): CapturePixelGeometry | undefined {
  return ctx.captureGeometry?.geometry
}

async function readBand(
  capture: NonNullable<TermProbeSource["capture"]>,
  geometry: CapturePixelGeometry,
  role: ObservationFrame["role"],
  label: string,
  cells: CaptureCells,
): Promise<ObservationFrame> {
  return capture({ role, label, cells, pixelGeometry: geometry })
}

function digestOf(frame: ObservationFrame): string | undefined {
  return frame.kind === "text-cells" ? frame.cellDigest : frame.regionDigest
}

const blockLine = (line: number): string => "block line " + line

/** One variant: the fixed block, optionally carrying the mark and a trailing marker character. */
function writeVariant(
  ctx: TermProbeSource,
  row: number,
  bytes: string,
  lineText: (line: number) => string = blockLine,
): void {
  ctx.write("\x1b[2J\x1b[1;1H")
  for (let line = 1; line <= BLOCK_ROWS; line++) {
    ctx.write("\x1b[" + line + ";1H" + lineText(line))
  }
  ctx.write("\x1b[" + row + ";1H" + bytes + "X")
}

/**
 * #34899 AC4b negative controls (criterion W §2, @cto r1 item 2): bytes written IN PLACE of the mark,
 * over the same block with the same trailing X. The SGR is the reset form on purpose: a visible SGR
 * restyles the X, and the band would then differ for the style rather than for any registration.
 */
const UNKNOWN_OSC = "\x1b]1337;probe\x07"
const SGR_ONLY = "\x1b[0m"

/**
 * The overlay-visibility control's layout: the omission layout with the retained-history rows and the
 * last boundary row rewritten. Rows 1-2 that stay unchanged are covered by an overlay; row 5, inside
 * the boundary band, must change, or the capture is not following the grid at all.
 */
const OVERLAY_LIVE_ROW = MARK_ROW + 1
function overlayCheckLine(line: number): string {
  const history = retainedHistory()
  const rewritten = (line >= history.top && line <= history.bottom) || line === OVERLAY_LIVE_ROW
  return rewritten ? "chrome check " + line : blockLine(line)
}

interface VariantRead {
  label: string
  boundary: string | undefined
  history: string | undefined
}

/** One control frame as AC4b cites it: by label, ref and the digest of its cols 1-40 crop. */
interface ControlRead {
  label: string
  ref: string
  regionDigest: string | undefined
  regionRectangle: CaptureRectangle | undefined
}

interface ControlPair {
  boundary: ControlRead
  history: ControlRead
}

function cite(frame: ObservationFrame): ControlRead {
  return { label: frame.label, ref: frame.ref, regionDigest: digestOf(frame), regionRectangle: frame.regionRectangle }
}

/**
 * One mark's differential: the same block with the mark, without it, and with the mark moved.
 * The response carries every digest so a reader can re-derive each comparison.
 */
export async function warpPromptMarkAppResult(
  ctx: TermProbeSource,
  spec: WarpMarkSpec,
  fallback: () => Promise<ProbeCallbackResult>,
): Promise<ProbeCallbackResult> {
  const geometry = geometryOf(ctx)
  if (!ctx.capture || geometry === undefined) {
    const result = await fallback()
    const base = result.note ?? result.tests?.[0]?.reason ?? spec.id + ": no decision"
    return {
      pass: result.pass,
      response: result.response,
      tests: [
        {
          id: "criterion",
          status: "probe-todo",
          reason: base + "; no pixel capture adapter is installed, so this arm has no frame to grade the mark from",
        },
      ],
    }
  }
  const capture = ctx.capture

  const read = async (label: string, row: number): Promise<VariantRead> => {
    const boundary = await readBand(capture, geometry, "target", label + " boundary", band(row))
    const across = await readBand(capture, geometry, "target", label + " history", retainedHistory())
    return { label, boundary: digestOf(boundary), history: digestOf(across) }
  }
  const readControl = async (label: string): Promise<ControlPair> => {
    const boundary = await readBand(capture, geometry, "control", label + " boundary", band(MARK_ROW))
    const history = await readBand(capture, geometry, "control", label + " history", retainedHistory())
    return { boundary: cite(boundary), history: cite(history) }
  }

  writeVariant(ctx, MARK_ROW, spec.mark)
  const target = await read(spec.id + ": mark alone", MARK_ROW)
  const targetAgain = await read(spec.id + ": mark alone, second read", MARK_ROW)
  writeVariant(ctx, MARK_ROW, "")
  const omission = await read(spec.id + ": mark omitted", MARK_ROW)
  // #34949 (@cto fixed-position finding): the moved mark is compared with the SAME band holding the
  // SAME fixed text, never with the band it occupied before. Two crops of different rows carry
  // different block lines, so their digests differ whatever the mark did - which is how a boundary
  // painted at a fixed row graded Supported.
  writeVariant(ctx, SHIFTED_MARK_ROW, "")
  const shiftedOmission = await read(spec.id + ": mark omitted at the moved position", SHIFTED_MARK_ROW)
  writeVariant(ctx, SHIFTED_MARK_ROW, spec.mark)
  const shifted = await read(spec.id + ": mark at another position", SHIFTED_MARK_ROW)
  // #34899 AC4b: the controls come AFTER the ten target reads, so those keep their order and timing,
  // and before the D/E/P return, so every row records them. Each is compared with the omission read,
  // on crops inside cols 1-40 only: the whole-window digest changes between reads of one screen.
  writeVariant(ctx, MARK_ROW, "", overlayCheckLine)
  const overlay = await readControl(spec.id + ": overlay-visibility control, rows 1-2 and 5 rewritten, no mark")
  writeVariant(ctx, MARK_ROW, UNKNOWN_OSC)
  const unknownOsc = await readControl(spec.id + ": unknown OSC 1337 in place of the mark")
  writeVariant(ctx, MARK_ROW, SGR_ONLY)
  const sgrOnly = await readControl(spec.id + ": SGR reset in place of the mark")

  /** What a control changed against the omission read; undefined when it left both crops as they were. */
  const changedAgainstOmission = (control: ControlPair): string | undefined => {
    const differs = (read: ControlRead, omitted: string | undefined): boolean =>
      read.regionDigest === undefined || read.regionDigest !== omitted
    const changed = [
      differs(control.boundary, omission.boundary)
        ? "the boundary band (" + describeRect(band(MARK_ROW)) + ")"
        : undefined,
      differs(control.history, omission.history)
        ? "the retained history (" + describeRect(retainedHistory()) + ")"
        : undefined,
    ].filter((named) => named !== undefined)
    return changed.length === 0 ? undefined : changed.join(" and ")
  }
  const overlayHistoryKept =
    overlay.history.regionDigest !== undefined && overlay.history.regionDigest === omission.history
  const overlayLive = overlay.boundary.regionDigest !== undefined && overlay.boundary.regionDigest !== omission.boundary
  const overlayPassed = overlayHistoryKept && overlayLive
  const unknownOscChanged = changedAgainstOmission(unknownOsc)
  const sgrOnlyChanged = changedAgainstOmission(sgrOnly)
  const negatives = [
    { name: "the unknown-OSC control (ESC ] 1337 ; probe BEL in place of the mark)", changed: unknownOscChanged },
    { name: "the SGR-only control (ESC [ 0 m in place of the mark)", changed: sgrOnlyChanged },
  ]

  const rectangles = {
    boundary: describeRect(band(MARK_ROW)),
    history: describeRect(retainedHistory()),
    shiftedBoundary: describeRect(band(SHIFTED_MARK_ROW)),
  }
  const controls = {
    overlayVisibility: { kind: "overlay-visibility", passed: overlayPassed, ...overlay },
    unknownOsc: {
      kind: "unknown-osc",
      bytes: "ESC ] 1337 ; probe BEL",
      unchanged: unknownOscChanged === undefined,
      ...unknownOsc,
    },
    sgrOnly: { kind: "sgr-only", bytes: "ESC [ 0 m", unchanged: sgrOnlyChanged === undefined, ...sgrOnly },
  }
  const response = JSON.stringify({ rectangles, target, targetAgain, omission, shiftedOmission, shifted, controls })
  const targetStable = target.boundary === targetAgain.boundary && target.history === targetAgain.history
  const boundaryAppeared = target.boundary !== undefined && target.boundary !== omission.boundary
  const historyRetained = target.history !== undefined && target.history === omission.history
  const followedPosition =
    shifted.boundary !== undefined &&
    shiftedOmission.boundary !== undefined &&
    shifted.boundary !== shiftedOmission.boundary &&
    shifted.history === omission.history
  const open = (reason: string): ProbeCallbackResult => ({
    pass: false,
    response,
    tests: [{ id: "criterion", status: "probe-todo", reason: "inconclusive: " + reason }],
    observation: { outcome: "inconclusive", reason: "insufficient-evidence", assertionType: "screenshot" },
  })
  // @cto 171e1def item 1: every open reason of the seven positional rows says W §1 stays unmet and why,
  // and cites the overlay-visibility control by digest. It is text only: no grade follows from it.
  const overlayFailures = [
    overlayHistoryKept ? undefined : "rows 1-2 followed the new grid text",
    overlayLive
      ? undefined
      : "rows 3-5 stayed unchanged when row 5 was rewritten, so the capture is not following the grid",
  ].filter((named) => named !== undefined)
  const overlayNote = overlayPassed
    ? "the overlay-visibility control held (rows 1-2 " +
      String(overlay.history.regionDigest) +
      " unchanged under new grid text, rows 3-5 " +
      String(overlay.boundary.regionDigest) +
      " changed with row 5)"
    : "the overlay-visibility control failed (" +
      overlayFailures.join("; ") +
      "), so this frame shows no overlay over rows 1-2"
  const openPositional = (reason: string): ProbeCallbackResult =>
    open(
      reason +
        "; foreign-mark observability stays a named PROBE TODO: criterion W §1's prompt-mark positive control stays unmet in this route: the collector is the single command Warp runs, and TermProbeSource cannot run a shell command; " +
        overlayNote,
    )

  if (spec.kind === "command-finished" || spec.kind === "text" || spec.kind === "properties") {
    const missing =
      spec.kind === "command-finished"
        ? "the command completion with its exact numeric status, 0 and 17 in one run"
        : spec.kind === "text"
          ? "the command text read FROM the mark"
          : "the working directory moved by an OSC 7 control"
    return open(
      spec.id +
        ": this arm reads frames, and " +
        spec.kind +
        " needs " +
        missing +
        "; the differential below is recorded and nothing is graded from it",
    )
  }
  if (!targetStable) {
    const disagreed = [
      target.boundary !== targetAgain.boundary ? "the boundary band (" + describeRect(band(MARK_ROW)) + ")" : undefined,
      target.history !== targetAgain.history
        ? "the retained history (" + describeRect(retainedHistory()) + ")"
        : undefined,
    ]
      .filter((named) => named !== undefined)
      .join(" and ")
    return openPositional(
      spec.id +
        ": two reads of the same frame disagreed in " +
        disagreed +
        ", so no comparison this run makes is stable",
    )
  }
  if (!boundaryAppeared) {
    return openPositional(
      spec.id +
        ": the mark left the boundary band unchanged (" +
        describeRect(band(MARK_ROW)) +
        "), so this route exposes no registration to grade",
    )
  }
  if (!historyRetained) {
    return openPositional(
      spec.id +
        ": the block above the mark changed with it (" +
        describeRect(retainedHistory()) +
        "), so the effect is not attributable to the mark",
    )
  }
  if (!followedPosition) {
    const sameBand = shifted.boundary === shiftedOmission.boundary
    return openPositional(
      spec.id +
        ": the boundary did not follow the mark to another position (" +
        describeRect(band(SHIFTED_MARK_ROW)) +
        ")" +
        (sameBand
          ? ", where the same rows with the same block text were unchanged by the mark"
          : " and no omission read is available to compare it with") +
        ", so it is not that marker's boundary",
    )
  }
  // A negative control can only block a Supported (criterion W §2, @cto r1 item 2): bytes that are not
  // a prompt mark changed the frame too, so the region is not specific to the mark.
  const changedNegatives = negatives.filter((control) => control.changed !== undefined)
  if (changedNegatives.length > 0) {
    return openPositional(
      spec.id +
        ": " +
        changedNegatives.map((control) => control.name + " also changed " + control.changed).join(", and ") +
        " against the omission read, so the region is not specific to the mark",
    )
  }
  return {
    pass: true,
    response,
    tests: [
      {
        id: "criterion",
        status: "supported",
        reason:
          spec.id +
          ": the mark's boundary appeared with the mark, stayed absent without it, and followed it to another position while the block above stayed unchanged",
      },
    ],
    observation: {
      outcome: "supported",
      assertionType: "screenshot",
      note:
        spec.id +
        ": a new boundary appears at the mark's own position and moves with the mark; the earlier block is retained",
    },
  }
}
