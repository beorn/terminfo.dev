import {
  frameDigests,
  type ProbeDefinition,
  type ProbeCallbackResult,
  type LibProbeSource,
  type TermProbeSource,
  type ObservationFrame,
} from "./types.ts"
import {
  probe,
  parserStateResult,
  replyFailure,
  notTestedResult,
  productViewportAbsenceResult,
  tooSmall,
  validSize,
  HEADLESS_OBSERVABLE_REVIEW,
  libvtermHistoryReview,
} from "./helpers.ts"
import { regionReadbackProbes, type RegionReadbackRow } from "./region-readback-kind.ts"

/**
 * The measured readback for the scrollback rows the VIEWPORT can actually see, as one
 * region-readback kind table (@cto A2; 28450 slices B and C). Same three-frame shape as the editing
 * specs: seed, the sequence applied on top of it, and the frame it must leave. History-buffer cells
 * that leave the window lie in NO row's region; they stay named unavailable, never graded as a
 * terminal failure.
 *
 * Each row keeps the region WIDTH, the cursor row and the sentinel the hand-written spec measured,
 * and each declares its own mode reset, so nothing about the fixture is implied twice. `region` is a
 * top-left corner — its bottom and right derive from the grid, so a region can no longer disagree
 * with the cells it compares — and the MINIMUM GEOMETRY derives from the cursor row, the sentinel and
 * the region (the kind's `assertRegionReadbackShape`), because a hand-picked minimum was itself a
 * hiding place: reverse-index's explicit 7 was the only thing keeping a cursor-row-6 fixture inside a
 * need of 5.
 *
 * Two deliberate changes, both named in the diff that carries this table to @cto:
 *  - scroll-up's region is rows 1..5, not rows 2..4: its claim ("A and E stay") controls the rows
 *    just outside the scrolled band, and only a region that covers them lets BOTH arms check them.
 *  - the derived edit parks the cursor at the row's own cursorRow, which two of the hand-written
 *    edits declared but never reached.
 */
export const scrollbackReadbackRows: readonly RegionReadbackRow[] = [
  {
    id: "scrollback.scroll-up",
    textClaim: "characters",
    expected: "Interior-region SU shifts the measured middle and bottom rows up, clearing the region bottom",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HA\x1b[2;1HB\x1b[3;1HC\x1b[4;1HD\x1b[5;1HE\x1b[2;4r",
    before: [["A"], ["B"], ["C"], ["D"], ["E"]],
    steps: [{ write: "\x1b[2;1H" }, { write: "\x1b[S" }, { write: "\x1b[r" }],
    after: [["A"], ["C"], ["D"], [""], ["E"]],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 4, col: 0, char: "E" },
    ],
    cursorRow: 6,
    sentinel: { row: 7, col: 1 },
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    seedNote: "Interior-region SU seed or history was not established",
    controlNote: "Interior-region SU controls or output were not measured",
  },
  {
    id: "scrollback.reverse-index",
    textClaim: "characters",
    expected: "A blank row is inserted above the measured A marker, pushing it down one row",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HA\x1b[2;1HB\x1b[3;1HC",
    before: [["A"], ["B"], ["C"]],
    steps: [{ write: "\x1b[H" }, { write: "\x1bM" }],
    after: [[""], ["A"], ["B"]],
    controls: [],
    cursorRow: 6,
    sentinel: { row: 5, col: 1 },
    reset: "",
    seedNote: "Seed marker rows were not measured",
    controlNote: "Seed marker rows were lost or did not move together; cannot attribute a blank-row insertion",
  },
  {
    id: "scrollback.scroll-down",
    textClaim: "characters",
    expected: "A blank row is inserted above the measured LINE1 row, pushing the three measured lines down",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HLINE1\x1b[2;1HLINE2\x1b[3;1HLINE3",
    before: [
      ["L", "I", "N", "E", "1"],
      ["L", "I", "N", "E", "2"],
      ["L", "I", "N", "E", "3"],
      ["", "", "", "", ""],
    ],
    steps: [{ write: "\x1b[H" }, { write: "\x1b[T" }],
    after: [
      ["", "", "", "", ""],
      ["L", "I", "N", "E", "1"],
      ["L", "I", "N", "E", "2"],
      ["L", "I", "N", "E", "3"],
    ],
    controls: [],
    cursorRow: 5,
    sentinel: { row: 6, col: 1 },
    reset: "",
    seedNote: "Seed marker rows were not measured",
    controlNote: "Marker rows were lost or did not move together; cannot attribute a blank-row insertion",
  },
  {
    id: "scrollback.set-region",
    textClaim: "characters",
    expected: "DECSTBM sets the region: a marker on the requested top row scrolls out while the row above it stays",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HFIXED\x1b[4;1HS\x1b[5;1HA\x1b[6;1HB\x1b[7;1HC",
    before: [["F"], [""], [""], ["S"], ["A"], ["B"], ["C"]],
    steps: [{ write: "\x1b[5;10r" }, { write: "\x1b[10;1H" }, { write: "\n" }, { write: "\x1b[r" }],
    after: [["F"], [""], [""], ["S"], ["B"], ["C"], [""]],
    controls: [
      { row: 0, col: 0, char: "F" },
      { row: 3, col: 0, char: "S" },
    ],
    cursorRow: 11,
    sentinel: { row: 12, col: 1 },
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    seedNote: "Region-top markers were not measured",
    controlNote: "The row above the region moved with the region",
  },
  {
    // The claim is two-sided — ENTER the alt grid and LEAVE it — so the frame after ONE pass has to
    // witness both: main row 1 restored AND a live mark written on main row 2 after the leave (@cto
    // 2026-10-12, must-fix 1). A different marker inside the alt grid plus a live marker on main
    // separates the failures that a bare enter/leave could not:
    //  - ignoring 1049 leaves the alt marker on main row 2, so OK overwrites only its first two cells;
    //  - staying on the alt grid leaves main row 1 blank;
    //  - clearing main on exit leaves main row 1 blank too.
    // Each differs from `after`, and `after` differs from the seed frame, so no survivor reads supported.
    id: "scrollback.alt-screen",
    textClaim: "characters",
    expected: "ESC[?1049h swaps to a separate alt grid and ESC[?1049l restores the measured main grid",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HMAIN_SCREEN_MARKER",
    before: [
      ["M", "A", "I", "N", "_", "S", "C", "R", "E", "E", "N", "_", "M", "A", "R", "K", "E", "R"],
      ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ],
    steps: [
      { write: "\x1b[?1049h" },
      { write: "\x1b[2;1HALT_SCREEN_MARKER" },
      { write: "\x1b[?1049l" },
      { write: "\x1b[2;1HOK" },
    ],
    after: [
      ["M", "A", "I", "N", "_", "S", "C", "R", "E", "E", "N", "_", "M", "A", "R", "K", "E", "R"],
      ["O", "K", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ],
    // The frame a surface that IGNORES 1049 leaves: the alt marker stays on main row 2 and OK
    // overwrites only its first two cells. A measured negative, so it reads unsupported BY NAME.
    ignored: [
      ["M", "A", "I", "N", "_", "S", "C", "R", "E", "E", "N", "_", "M", "A", "R", "K", "E", "R"],
      ["O", "K", "T", "_", "S", "C", "R", "E", "E", "N", "_", "M", "A", "R", "K", "E", "R", ""],
    ],
    controls: [],
    cursorRow: 3,
    sentinel: { row: 4, col: 1 },
    reset: "\x1b[?1049l",
    cleanup: "\x1b[?1049l",
    seedNote: "Main-screen marker was not measured",
    controlNote: "The main grid changed while the alt grid was active",
  },
  {
    id: "scrollback.decstbm",
    textClaim: "characters",
    expected: "DECSTBM confines the scroll: the inner marker scrolls while the row above the region stays",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HFIXED\x1b[2;1HS\x1b[3;1HA\x1b[4;1HB\x1b[5;1HC",
    before: [["F"], ["S"], ["A"], ["B"], ["C"]],
    steps: [{ write: "\x1b[3;6r" }, { write: "\x1b[6;1H" }, { write: "\n" }, { write: "\x1b[r" }],
    after: [["F"], ["S"], ["B"], ["C"], [""]],
    controls: [
      { row: 0, col: 0, char: "F" },
      { row: 1, col: 0, char: "S" },
    ],
    cursorRow: 7,
    sentinel: { row: 8, col: 1 },
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    seedNote: "FIXED_TOP or the inner markers were not measured",
    controlNote: "FIXED_TOP outside the region moved with the region",
  },
  {
    id: "scrollback.decstbm-reset",
    textClaim: "characters",
    expected: "After ESC[r, RI at the screen top scrolls the full screen, shifting the measured markers down one row",
    region: { top: 1, left: 1 },
    seed: "\x1b[2;1HB\x1b[3;1HC\x1b[1;1H\x1bMA",
    before: [["A"], [""], ["B"], ["C"], [""], [""]],
    steps: [
      { write: "\x1b[4;6r" },
      {
        write: "\x1b[4;1H\x1bM",
        cursor: {
          x: 0,
          y: 3,
          note: "the inner RI moved the cursor instead of scrolling rows 4-6: the 4;6 region is not in force, so the reset cannot be read.",
        },
      },
      { write: "\x1b[r" },
      { write: "\x1b[1;1H\x1bM" },
    ],
    after: [[""], ["A"], [""], ["B"], [""], ["C"]],
    ignored: [["A"], [""], ["B"], [""], ["C"], [""]],
    controls: [],
    cursorRow: 7,
    sentinel: { row: 8, col: 1 },
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    seedNote: "RI at the screen top did not establish the measured seed, so the reset cannot be read.",
    controlNote: "The measured rows did not move as a full-screen reverse index, so the reset cannot be read",
  },
]

/** Hold is measured at an inward anchor; output readability is checked only back at bottom. */
function viewportHold(ctx: LibProbeSource): ProbeCallbackResult {
  type Reading = ReturnType<LibProbeSource["getScrollback"]>
  type Phase = "ordinary" | "synchronized"
  type PhaseResult = {
    outcome?: "hold" | "snap" | "bottom-relative" | "drift"
    note?: string
    missing?: string
    markerObserved?: boolean
    after?: Reading
    restored?: Reading
  }
  const state: {
    baseline: Partial<Record<Phase, { fresh: Reading; seeded?: Reading; lineCount?: number; feedObserved?: boolean }>>
    anchor: Partial<Record<Phase, Reading>>
    control: Partial<Record<Phase, { sign?: number; attempts: { delta: number; reading: Reading }[] }>>
    ordinary: PhaseResult
    synchronized: PhaseResult
    productViewport?: LibProbeSource["capabilities"]["productViewport"]
  } = { baseline: {}, anchor: {}, control: {}, ordinary: {}, synchronized: {} }
  const expected = "Viewport stays anchored during ordinary and synchronized output without keyboard input"
  const declared = ctx.capabilities.productViewport
  if (declared?.available === false) {
    state.productViewport = declared
    if (ctx.scrollViewport) {
      return parserStateResult(null, expected, state, "Product viewport declared absent but scroll control is present")
    }
    return productViewportAbsenceResult(ctx, declared.reason, state)
  }
  if (!ctx.scrollViewport) return notTestedResult("scrollback viewport scroll control", state)
  const scroll = ctx.scrollViewport.bind(ctx)
  const valid = (reading: Reading) =>
    validSize(reading.screenLines, 1) &&
    validSize(reading.totalLines, reading.screenLines) &&
    validSize(reading.viewportOffset, 0) &&
    reading.viewportOffset <= reading.totalLines - reading.screenLines
  const extents = (a: Reading, b: Reading) => a.totalLines === b.totalLines && a.screenLines === b.screenLines
  function phase(name: Phase): PhaseResult {
    ctx.reset()
    ctx.feed("\x1b[?1049l\x1b[?2026l")
    const fresh = ctx.getScrollback()
    const baseline = {
      fresh,
      lineCount: fresh.screenLines * 2,
      seeded: undefined as Reading | undefined,
      feedObserved: false,
    }
    state.baseline[name] = baseline
    if (!valid(fresh) || !validSize(ctx.cols, `viewport-${name}`.length) || !Number.isSafeInteger(baseline.lineCount)) {
      return { note: "invalid geometry or fresh scrollback readings" }
    }
    const lines = Array.from({ length: baseline.lineCount }, (_, index) => `hold-${index}`)
    const lastLine = lines.at(-1)
    if (lastLine === undefined || lastLine.length > ctx.cols) return { note: "numbered seed exceeds measured columns" }
    ctx.feed(lines.join("\r\n"))
    baseline.feedObserved = ctx.getText().includes(lastLine)
    const seeded = ctx.getScrollback()
    baseline.seeded = seeded
    // Order matters: ignored feeds are inconclusive; an observed feed without history names coverage.
    if (!baseline.feedObserved) return { note: "feed not observed" }
    if (!valid(seeded) || seeded.screenLines !== fresh.screenLines) {
      return { note: "invalid seeded geometry or readings" }
    }
    if (seeded.totalLines - seeded.screenLines < 1) return { missing: "scrollback history rows" }
    if (seeded.totalLines !== baseline.lineCount) {
      return { note: "exact seed retention not established (clipping or eviction)" }
    }
    if (seeded.viewportOffset !== seeded.totalLines - seeded.screenLines) {
      return { note: "seeded viewport is not at bottom" }
    }
    const control: { sign?: number; attempts: { delta: number; reading: Reading }[] } = { attempts: [] }
    state.control[name] = control
    let anchor: Reading | undefined
    for (const delta of [-1, 1]) {
      scroll(delta)
      const reading = ctx.getScrollback()
      control.attempts.push({ delta, reading })
      if (!extents(seeded, reading)) return { note: "viewport control changed extents" }
      if (!valid(reading)) return { note: "viewport control returned invalid position" }
      if (reading.viewportOffset < seeded.viewportOffset) {
        anchor = reading
        control.sign = delta
        break
      }
    }
    if (!anchor || control.sign === undefined) return { missing: "scrollback viewport state" }
    state.anchor[name] = anchor
    const marker = `viewport-${name}`
    const output = `\r\n${marker}`
    ctx.feed(name === "synchronized" ? `\x1b[?2026h${output}\x1b[?2026l` : output)
    const after = ctx.getScrollback()
    const result: PhaseResult = { after }
    if (!valid(after) || after.screenLines !== seeded.screenLines || after.totalLines !== seeded.totalLines + 1) {
      return { ...result, note: "output did not retain exactly one additional row at fixed geometry" }
    }
    const bottom = after.totalLines - after.screenLines
    result.outcome =
      after.viewportOffset === anchor.viewportOffset
        ? "hold"
        : after.viewportOffset === bottom
          ? "snap"
          : after.viewportOffset === anchor.viewportOffset + 1
            ? "bottom-relative"
            : "drift"
    // One added row can put bottom two steps beyond the anchor. Reverse the calibrated
    // direction by the actual distance, then qualify that restoration before reading text.
    scroll(-control.sign * (bottom - after.viewportOffset))
    const restored = ctx.getScrollback()
    result.restored = restored
    if (!valid(restored) || !extents(after, restored) || restored.viewportOffset !== bottom) {
      return { ...result, note: "return to bottom not established" }
    }
    result.markerObserved = ctx.getText().includes(marker)
    if (!result.markerObserved) return { ...result, note: "target marker not observed after verified return to bottom" }
    return result
  }
  let failed = false
  let primary: unknown
  try {
    state.ordinary = phase("ordinary")
    state.synchronized = phase("synchronized")
    const phases = ["ordinary", "synchronized"] as const
    const unqualified = phases.find((name) => state[name].note !== undefined)
    if (unqualified) return parserStateResult(null, expected, state, `${unqualified}: ${state[unqualified].note}`)
    const missing = phases.map((name) => state[name].missing).find((value) => value !== undefined)
    if (missing !== undefined) return notTestedResult(missing, state)
    const bottomRelative = phases.find((name) => state[name].outcome === "bottom-relative")
    if (bottomRelative) {
      const both = phases.every((name) => state[name].outcome === "bottom-relative")
      return parserStateResult(
        both ? false : null,
        expected,
        state,
        both
          ? "viewport kept its distance from bottom instead of its anchor"
          : `${bottomRelative}: bottom-relative viewport motion differed between phases`,
      )
    }
    const drift = phases.find((name) => state[name].outcome === "drift")
    if (drift) {
      return parserStateResult(
        null,
        expected,
        state,
        `${drift}: viewport partially drifted rather than holding or snapping to bottom`,
      )
    }
    const snap = phases.find((name) => state[name].outcome === "snap")
    return parserStateResult(
      !snap,
      expected,
      state,
      snap ? `${snap}: viewport snapped to the new bottom` : "Both phases held the qualified anchor",
    )
  } catch (error) {
    failed = true
    primary = error
    throw error
  } finally {
    try {
      ctx.reset()
    } catch (cleanup) {
      if (failed) {
        throw new AggregateError([primary, cleanup], "Viewport hold failed and disposable source reset also failed")
      }
      throw cleanup
    }
  }
}

/** Linux App viewport-hold-output: in-run wheel displacement calibration and constructed-tail restoration. */
async function viewportHoldApp(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  if (ctx.mux === "tmux" || ctx.mux === "screen") {
    return notTestedResult("multiplexer viewport hold retains the manual recipe", { mux: ctx.mux })
  }
  const capture = ctx.capture
  const input = ctx.input
  const readInput = ctx.readInput
  if (!capture || !input || !readInput) {
    return notTestedResult("viewport input and pixel capture unavailable", {
      capture: Boolean(capture),
      input: Boolean(input),
      readInput: Boolean(readInput),
    })
  }
  const geometry = tooSmall(ctx, 5, 8, "Viewport hold fixture")
  if (geometry) return geometry
  const maxCandidate = Math.min(ctx.rows, 12)
  const calLines = ctx.rows + maxCandidate + 1
  const maxAnchors = 3 * ctx.rows
  const down = 4 * ctx.rows + 2
  if (!Number.isSafeInteger(maxAnchors) || !Number.isSafeInteger(down) || !Number.isSafeInteger(calLines)) {
    return notTestedResult("wheel placement bound not established", { rows: ctx.rows })
  }
  const labelWidth = Math.max(
    `vh-cal-${calLines - 1}`.length,
    `vh-tail-${ctx.rows - 1}`.length,
    `vh-s-${maxAnchors - 1}`.length,
    "vh-s-out".length,
  )
  const width = tooSmall(ctx, 5, labelWidth, "Viewport hold fixture")
  if (width) return width
  const frames: ObservationFrame[] = []
  const calibration = {} as Record<string, unknown>
  const evidence = {
    calibration,
    notches: { up: 1, down },
    frames,
    Bref: undefined as ObservationFrame | undefined,
    ordinary: {} as Record<string, unknown>,
    synchronized: {} as Record<string, unknown>,
  }
  const todo = (reason: string) => notTestedResult(reason, evidence)
  const labelCells = { top: 1, left: 1, bottom: ctx.rows, right: labelWidth }
  const calGeometry = ctx.captureGeometry?.geometry
  const frame = async (label: string, role: "control" | "target" = "control") => {
    const result = await capture({
      role,
      label,
      ...(calGeometry ? { cells: labelCells, pixelGeometry: calGeometry } : {}),
    })
    const cellDigest = frameDigests(result).cells
    if (result.kind === "text-cells" || !result.pixelsDigest?.trim() || (calGeometry && !cellDigest?.trim())) {
      throw new Error(`Viewport capture ${label} has no complete pixel digest`)
    }
    frames.push(result)
    return result
  }
  const measuredDigest = (captured: ObservationFrame) =>
    calGeometry ? frameDigests(captured).cells : frameDigests(captured).whole
  const sameCells = (a: ObservationFrame, b: ObservationFrame) => {
    const da = measuredDigest(a)
    const db = measuredDigest(b)
    return Boolean(da && db && da === db)
  }
  let failed = false
  let primary: unknown
  let scrolled = false
  const moveDown = async () => {
    scrolled = false
    for (let notch = 0; notch < down; notch++) await input.injectClick(5)
  }
  const tail = Array.from({ length: ctx.rows }, (_, row) => `vh-tail-${row}`).join("\r\n")
  try {
    ctx.write("\x1b[?25l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[2J\x1b[3J\x1b[H")
    ctx.write(Array.from({ length: calLines }, (_, row) => `vh-cal-${row}`).join("\r\n"))
    if (!(await ctx.queryCursorPosition())) {
      return todo("no cursor-position reply after painting calibration seed")
    }
    calibration.maxCandidate = maxCandidate
    const calBottom = await frame("Viewport calibration bottom")
    calibration.calBottom = calBottom
    const calDelivery = await readInput(/^a/, 1000, () => input.injectKey("a"))
    calibration.delivery = calDelivery
    if (!calDelivery) return todo("viewport input delivery not observed")
    scrolled = true
    await input.injectClick(4)
    const calScrolled = await frame("Viewport calibration scrolled")
    calibration.calScrolled = calScrolled
    for (let notch = 0; notch < maxCandidate; notch++) await input.injectClick(4)
    const calTop = await frame("Viewport calibration top")
    calibration.calTop = calTop
    await moveDown()
    const calRestored = await frame("Viewport calibration restored")
    calibration.calRestored = calRestored
    if (!sameCells(calRestored, calBottom)) return todo("restoration to bottom not proven")
    const boundEstablished = !sameCells(calScrolled, calBottom) && !sameCells(calScrolled, calTop)
    calibration.boundEstablished = boundEstablished
    calibration.scrolledDigest = measuredDigest(calScrolled)
    calibration.topDigest = measuredDigest(calTop)
    if (!boundEstablished) {
      return todo("wheel placement bound not established")
    }
    const anchors = maxAnchors

    ctx.write("\x1b[2J\x1b[3J\x1b[H")
    ctx.write(tail)
    if (!(await ctx.queryCursorPosition())) {
      return todo("no cursor-position reply after painting constructed tail")
    }
    const reference = await frame("Viewport constructed bottom reference")
    evidence.Bref = reference
    let screenshot = reference
    let held = true
    for (const phase of ["ordinary", "synchronized"] as const) {
      const state = evidence[phase]
      const prefix = phase === "ordinary" ? "o" : "s"
      ctx.write("\r\n" + Array.from({ length: anchors }, (_, row) => `vh-${prefix}-${row}`).join("\r\n"))
      const bottom = await frame(`${phase} B0`)
      state.B0 = bottom
      if (sameCells(bottom, reference)) return todo("viewport seed not observed")
      const control = await readInput(/^a/, 1000, () => input.injectKey("a"))
      state.delivery = control
      if (!control) return todo("viewport input delivery not observed")
      scrolled = true
      await input.injectClick(4)
      const anchor = await frame(`${phase} U`)
      state.U = anchor
      if (sameCells(anchor, bottom) || sameCells(anchor, reference)) {
        return todo("viewport anchor placement not established")
      }
      state.anchorParse = await ctx.queryWithSentinelOutcome("\x1b[c", /\x1b\[\?[0-9;]*c/, 1000)
      const unchanged = await frame(`${phase} U prime`, "target")
      state.UPrime = unchanged
      if (!sameCells(unchanged, anchor)) {
        if (sameCells(unchanged, bottom)) {
          state.outcome = "witness-snapped"
          state.targetDigest = measuredDigest(unchanged)
          state.matchedReferenceDigest = measuredDigest(bottom)
          const reason = "a non-printing parse-witness query returned the scrolled viewport to the bottom"
          const response = JSON.stringify(evidence)
          return {
            pass: false,
            note: reason,
            response,
            observation: {
              outcome: "unsupported",
              assertionType: "screenshot",
              note: reason,
              frames,
              screenshotRef: unchanged.ref,
            },
            assertions: [
              {
                assertionType: "screenshot",
                kind: "negative",
                expected: "Both qualified viewport phases retain their earlier history anchor after output",
                observed: response,
                action: "scrollback.viewport-hold-output",
              },
            ],
          }
        }
        return todo("parse witness moved the viewport")
      }
      const output = `\r\nvh-${prefix}-out\r\n${tail}`
      ctx.write(phase === "ordinary" ? output : `\x1b[?2026h${output}\x1b[?2026l`)
      const parsed = await ctx.queryWithSentinelOutcome("\x1b[c", /\x1b\[\?[0-9;]*c/, 1000)
      state.outputParse = parsed
      if (!parsed.match) return todo("output parse not witnessed before the output frame")
      const after = await frame(`${phase} A`, "target")
      state.A = after
      const confirmed = await frame(`${phase} A confirmation`, "target")
      state.AConfirmed = confirmed
      if (!sameCells(after, confirmed)) return todo("output frame still changing")
      await moveDown()
      const arrived = await frame(`${phase} B1`)
      state.B1 = arrived
      if (!sameCells(arrived, reference)) return todo("restoration to bottom not proven")
      scrolled = true
      await input.injectClick(4)
      const relative = await frame(`${phase} R`)
      state.R = relative
      const candidates = { held: anchor, snapped: arrived, "bottom-relative": relative }
      const matches = Object.entries(candidates)
        .filter(([, candidate]) => sameCells(after, candidate))
        .map(([name]) => name)
      state.matches = matches
      // R moved away from bottom: a second witnessed restore precedes every subsequent seed.
      await moveDown()
      const restored = await frame(`${phase} final restoration`)
      state.restored = restored
      if (!sameCells(restored, reference)) return todo("restoration to bottom not proven")
      const matchedOutcome = matches[0] as keyof typeof candidates | undefined
      if (matches.length !== 1 || !matchedOutcome) return todo("ambiguous frame")
      const matchedCandidate = candidates[matchedOutcome]
      state.outcome = matchedOutcome
      state.targetDigest = measuredDigest(after)
      state.matchedReferenceDigest = measuredDigest(matchedCandidate)
      if (held || matchedOutcome !== "held") screenshot = after
      held &&= matchedOutcome === "held"
    }
    const response = JSON.stringify(evidence)
    return {
      pass: held,
      response,
      observation: {
        outcome: held ? "supported" : "unsupported",
        assertionType: "screenshot",
        frames,
        screenshotRef: screenshot.ref,
      },
      assertions: [
        {
          assertionType: "screenshot",
          kind: held ? "positive" : "negative",
          expected: "Both qualified viewport phases retain their earlier history anchor after output",
          observed: response,
          action: "scrollback.viewport-hold-output",
        },
      ],
    }
  } catch (error) {
    failed = true
    primary = error
    throw error
  } finally {
    const failures = failed ? [{ operation: "primary error", error: primary }] : []
    try {
      if (scrolled) await moveDown()
    } catch (cleanup) {
      failures.push({ operation: "wheel return", error: cleanup })
    }
    try {
      ctx.write("\x1b[?2026l\x1b[?25h")
    } catch (cleanup) {
      failures.push({ operation: "cursor restore", error: cleanup })
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map(({ error }) => error),
        `Viewport hold failed: ${failures.map(({ operation }) => operation).join(", ")}`,
      )
    }
    const failure = failures[0]
    if (failure) throw failure.error
  }
}

/**
 * An App history reader that has no reading this run, by name: its own per-run control failed, or
 * the app answered nothing. The App history probe records the reason and leaves the cell todo; any
 * other error from a reader stays an error.
 */
export class ScrollbackReadingUnavailable extends Error {
  override name = "ScrollbackReadingUnavailable"
}

/** The App reader uses the existing library history criteria, with same-path controls. */
async function appHistory(ctx: TermProbeSource, total: boolean): Promise<ProbeCallbackResult> {
  if (!ctx.getScrollback) return notTestedResult("owned scrollback history reader", {})
  try {
    return await appHistoryReadings(ctx, ctx.getScrollback, total)
  } catch (error) {
    if (!(error instanceof ScrollbackReadingUnavailable)) throw error
    return notTestedResult(`owned scrollback history reader has no reading: ${error.message}`, {})
  }
}

async function appHistoryReadings(
  ctx: TermProbeSource,
  read: NonNullable<TermProbeSource["getScrollback"]>,
  total: boolean,
): Promise<ProbeCallbackResult> {
  const refusal = tooSmall(ctx, 1, `line ${ctx.rows + 9}`.length, "Scrollback fixture")
  if (refusal) return refusal
  ctx.write("\x1b[0m\x1b[2J\x1b[H")
  if (!(await ctx.queryCursorPosition())) return replyFailure("No cursor reply to fence scrollback baseline output")
  const historyReset = ctx.resetScrollback ? await ctx.resetScrollback() : undefined
  const resetEvidence = historyReset !== undefined ? { historyReset } : {}
  const baseline = await read()
  if (!validSize(baseline.totalLines, 0)) {
    return notTestedResult("scrollback reader geometry differs from measured screen", {
      ...resetEvidence,
      baseline,
      rows: ctx.rows,
    })
  }
  if (historyReset !== undefined) {
    const screenRows = baseline.screenLines ?? ctx.rows
    const postResetHistory = baseline.totalLines - screenRows
    if (postResetHistory < 0) {
      return notTestedResult("scrollback reader geometry differs from measured screen", {
        ...resetEvidence,
        baseline,
        rows: ctx.rows,
      })
    }
    if (postResetHistory !== 0) {
      return notTestedResult(`owned history reset left ${postResetHistory} lines`, {
        ...resetEvidence,
        baseline,
        history: postResetHistory,
        rows: ctx.rows,
      })
    }
  }
  const requiredGrowth = total ? 10 : 1
  if (baseline.capacity !== undefined) {
    const screenRows = baseline.screenLines ?? ctx.rows
    const history = baseline.totalLines - screenRows
    if (!validSize(baseline.capacity, 0) || history < 0) {
      return notTestedResult("scrollback reader geometry differs from measured screen", {
        ...resetEvidence,
        baseline,
        rows: ctx.rows,
      })
    }
    if (history + requiredGrowth > baseline.capacity) {
      return notTestedResult(
        `history at ${history} of capacity ${baseline.capacity} before the test; growth of ${requiredGrowth} cannot be observed`,
        { ...resetEvidence, baseline, history, capacity: baseline.capacity, requiredGrowth, rows: ctx.rows },
      )
    }
  }
  for (let i = 0; i < ctx.rows - 1; i++) ctx.write("c\r\n")
  if (!(await ctx.queryCursorPosition())) return replyFailure("No cursor reply to fence no-overflow control")
  const control = await read()
  if (control.totalLines !== baseline.totalLines) {
    return notTestedResult("no-overflow output changed the retained history count", {
      ...resetEvidence,
      baseline,
      control,
    })
  }
  ctx.write("\x1b[H")
  const lineCount = ctx.rows + 10
  for (let i = 0; i < lineCount; i++) ctx.write(`line ${i}\r\n`)
  if (!(await ctx.queryCursorPosition())) return replyFailure("No cursor reply to fence scrollback overflow output")
  const scroll = await read()
  if (!validSize(scroll.totalLines, 0)) {
    return notTestedResult("scrollback reader geometry changed after overflow", {
      ...resetEvidence,
      baseline,
      control,
      scroll,
    })
  }
  if (scroll.totalLines === baseline.totalLines) {
    return notTestedResult(
      "retained history count did not change after the overflow lines; no same-path control shows this reader counts history",
      {
        ...resetEvidence,
        baseline,
        control,
        lineCount,
        scroll,
        rows: ctx.rows,
        geometrySource: "rows from run geometry",
      },
    )
  }
  return parserStateResult(
    total ? scroll.totalLines - baseline.totalLines >= lineCount - ctx.rows : scroll.totalLines > baseline.totalLines,
    total
      ? "Measured history grows by at least the overflow beyond the screen"
      : "Written lines increase measured scrollback history",
    {
      ...resetEvidence,
      baseline,
      control,
      lineCount,
      scroll,
      rows: ctx.rows,
      geometrySource: "rows from run geometry",
    },
  )
}

export const scrollbackProbes: ProbeDefinition[] = [
  {
    ...probe(
      "scrollback.accumulate",
      (ctx) => {
        const review = libvtermHistoryReview(ctx)
        if (review) return review
        const baseline = ctx.getScrollback()
        const rows = baseline.screenLines
        if (!validSize(rows, 1) || !validSize(ctx.cols, `line ${rows + 9}`.length)) {
          return {
            pass: false,
            tests: [{ id: "criterion", status: "probe-todo", reason: "insufficient-evidence" }],
          }
        }
        for (let i = 0; i < rows + 10; i++) ctx.feed(`line ${i}\r\n`)
        const scroll = ctx.getScrollback()
        if (scroll.totalLines === baseline.totalLines) {
          return notTestedResult(
            "retained history count did not change after the overflow lines; no same-path control shows this reader counts history",
            { baseline, scroll },
          )
        }
        return parserStateResult(
          scroll.totalLines > baseline.totalLines,
          "Written lines increase measured scrollback history",
          { baseline, scroll },
        )
      },
      async (ctx) => {
        if (ctx.getScrollback) return appHistory(ctx, false)
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 3, `line-${ctx.rows + 9}`.length, "Scrollback fixture")
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("TOP\r\nline-0\r\nline-1")
            const control = await capture({
              role: "control",
              label: "Before overflow: TOP marker on row 1 with two written lines",
            })
            // Start below row 1 so TOP scrolls off only when the screen actually scrolls; a home
            // here would overwrite TOP and make its disappearance no scrolling control.
            ctx.write("\x1b[2;1H")
            const lineCount = ctx.rows + 10
            for (let i = 0; i < lineCount; i++) ctx.write(`line-${i}\r\n`)
            const target = await capture({
              role: "target",
              label: `After writing ${lineCount} lines: TOP has scrolled off the top and row 1 shows an advanced line-N`,
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                lineCount,
                control: control.label,
                target: target.label,
              }),
              criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
              tests: [
                {
                  id: "review",
                  status: "probe-todo",
                  reason:
                    "A line numbering beyond the TOP control shows the viewport scrolled past one screen; whether the terminal retained those lines as scrollback history, and how many, is not readable from the screen",
                },
              ],
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                assertionType: "screenshot",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "A line numbering beyond the TOP control shows the viewport scrolled past one screen; whether the terminal retained those lines as scrollback history, and how many, is not readable from the screen",
              },
            }
          } finally {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
          }
        }
        const refusal = tooSmall(ctx, 1, `line-${ctx.rows + 9}`.length, "Scrollback fixture")
        if (refusal) return refusal
        const rows = ctx.rows
        ctx.write("\x1b[2J\x1b[H") // clear + home
        const lineCount = rows + 10
        for (let i = 0; i < lineCount; i++) {
          ctx.write(`line-${i}\n`)
        }
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
          tests: [
            { id: "review", status: "probe-todo", reason: "Cursor position does not measure scrollback history" },
          ],
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            assertionType: "query_reply",
            note: "Cursor position does not measure scrollback history",
          },
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "scrollback.total-lines",
      (ctx) => {
        const review = libvtermHistoryReview(ctx)
        if (review) return review
        const baseline = ctx.getScrollback()
        const rows = baseline.screenLines
        if (!validSize(rows, 1) || !validSize(ctx.cols, `line ${rows + 9}`.length)) {
          return {
            pass: false,
            tests: [{ id: "criterion", status: "probe-todo", reason: "insufficient-evidence" }],
          }
        }
        const lineCount = rows + 10
        for (let i = 0; i < lineCount; i++) ctx.feed(`line ${i}\r\n`)
        const scroll = ctx.getScrollback()
        if (scroll.totalLines === baseline.totalLines) {
          return notTestedResult(
            "retained history count did not change after the overflow lines; no same-path control shows this reader counts history",
            { baseline, lineCount, scroll },
          )
        }
        return parserStateResult(
          scroll.totalLines - baseline.totalLines >= lineCount - rows,
          "Measured history grows by at least the overflow beyond the screen",
          { baseline, lineCount, scroll },
        )
      },
      async (ctx) => {
        if (ctx.getScrollback) return appHistory(ctx, true)
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 5, `total-${ctx.rows + 9}`.length, "Scrollback fixture")
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("TOP")
            const control = await capture({
              role: "control",
              label: "Before overflow: TOP marker on row 1 with no history written",
            })
            // Start below row 1 so TOP is not overwritten before scrolling can be observed.
            ctx.write("\x1b[2;1H")
            const lineCount = ctx.rows + 10
            for (let i = 0; i < lineCount; i++) ctx.write(`total-${i}\n`)
            const target = await capture({
              role: "target",
              label: `After writing ${lineCount} lines: TOP has scrolled off, showing total lines exceeded one screen`,
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                lineCount,
                control: control.label,
                target: target.label,
              }),
              criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
              tests: [
                {
                  id: "review",
                  status: "probe-todo",
                  reason:
                    "The TOP control leaving the top of the screen after more lines than a screen can hold shows the viewport scrolled past its height; retained-history existence and count are not readable from the screen",
                },
              ],
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                assertionType: "screenshot",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "The TOP control leaving the top of the screen after more lines than a screen can hold shows the viewport scrolled past its height; retained-history existence and count are not readable from the screen",
              },
            }
          } finally {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
          }
        }
        const refusal = tooSmall(ctx, 5, `total-${ctx.rows + 9}`.length, "Scrollback fixture")
        if (refusal) return refusal
        ctx.write("\x1b[2J\x1b[H") // clear
        for (let i = 0; i < ctx.rows + 10; i++) ctx.write(`total-${i}\n`)
        ctx.write("\x1b[5;1H") // move to row 5
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
          tests: [
            { id: "review", status: "probe-todo", reason: "Cursor position does not measure total scrollback lines" },
          ],
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            assertionType: "query_reply",
            note: "Cursor position does not measure total scrollback lines",
          },
        }
      },
    ),
    termNeedsGeometry: true,
  },

  ...regionReadbackProbes(scrollbackReadbackRows),
  {
    // Measured spans: WezTerm 96.1 s, Alacritty 74.9 s, Ghostty 65.4 s, Kitty 54.3 s.
    // 180 s is the headroom past 96.1 s. The 30 s default stays for the rest of the suite (@cto 2f538d50).
    ...probe("scrollback.viewport-hold-output", viewportHold, viewportHoldApp, "screenshot"),
    libAssertionType: "buffer_state",
    termNeedsGeometry: true,
    termNeedsDisposable: true,
    wallMs: 180_000,
  },
]
