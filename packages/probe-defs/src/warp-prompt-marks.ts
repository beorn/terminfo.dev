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
 */
import type {
  CaptureCells,
  CapturePixelGeometry,
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
const SHIFTED_MARK_ROW = 6
const RIGHT = 40

/**
 * Rows compared as the boundary band and as retained history. The history band is fixed at the block
 * above the target mark and is never widened with the mark's row: the shifted variant carries a
 * different band, and comparing two rectangles of different size would always differ.
 */
const band = (row: number): CaptureCells => ({ top: row - 1, left: 1, bottom: row + 1, right: RIGHT })
const retainedHistory = (): CaptureCells => ({ top: 1, left: 1, bottom: MARK_ROW - 2, right: RIGHT })

function geometryOf(ctx: TermProbeSource): CapturePixelGeometry | undefined {
  return ctx.captureGeometry?.geometry
}

async function readBand(
  capture: NonNullable<TermProbeSource["capture"]>,
  geometry: CapturePixelGeometry,
  label: string,
  cells: CaptureCells,
): Promise<ObservationFrame> {
  return capture({ role: "target", label, cells, pixelGeometry: geometry })
}

function digestOf(frame: ObservationFrame): string | undefined {
  return frame.kind === "text-cells" ? frame.cellDigest : frame.regionDigest
}

/** One variant: the fixed block, optionally carrying the mark and a trailing marker character. */
function writeVariant(ctx: TermProbeSource, row: number, bytes: string): void {
  ctx.write("\x1b[2J\x1b[1;1H")
  for (let line = 1; line <= BLOCK_ROWS; line++) {
    ctx.write("\x1b[" + line + ";1Hblock line " + line)
  }
  ctx.write("\x1b[" + row + ";1H" + bytes + "X")
}

interface VariantRead {
  label: string
  boundary: string | undefined
  history: string | undefined
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
    const boundary = await readBand(capture, geometry, label + " boundary", band(row))
    const across = await readBand(capture, geometry, label + " history", retainedHistory())
    return { label, boundary: digestOf(boundary), history: digestOf(across) }
  }

  writeVariant(ctx, MARK_ROW, spec.mark)
  const target = await read(spec.id + ": mark alone", MARK_ROW)
  const targetAgain = await read(spec.id + ": mark alone, second read", MARK_ROW)
  writeVariant(ctx, MARK_ROW, "")
  const omission = await read(spec.id + ": mark omitted", MARK_ROW)
  writeVariant(ctx, SHIFTED_MARK_ROW, spec.mark)
  const shifted = await read(spec.id + ": mark at another position", SHIFTED_MARK_ROW)

  const response = JSON.stringify({ target, targetAgain, omission, shifted })
  const targetStable = target.boundary === targetAgain.boundary && target.history === targetAgain.history
  const boundaryAppeared = target.boundary !== undefined && target.boundary !== omission.boundary
  const historyRetained = target.history !== undefined && target.history === omission.history
  const followedPosition =
    shifted.boundary !== undefined && shifted.boundary !== target.boundary && shifted.history === omission.history
  const open = (reason: string): ProbeCallbackResult => ({
    pass: false,
    response,
    tests: [{ id: "criterion", status: "probe-todo", reason: "inconclusive: " + reason }],
    observation: { outcome: "inconclusive", reason: "insufficient-evidence", assertionType: "screenshot" },
  })

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
    return open(spec.id + ": two reads of the same frame disagreed, so no comparison this run makes is stable")
  }
  if (!boundaryAppeared) {
    return open(spec.id + ": the mark left the boundary band unchanged, so this route exposes no registration to grade")
  }
  if (!historyRetained) {
    return open(spec.id + ": the block above the mark changed with it, so the effect is not attributable to the mark")
  }
  if (!followedPosition) {
    return open(
      spec.id + ": the boundary did not follow the mark to another position, so it is not that marker's boundary",
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
