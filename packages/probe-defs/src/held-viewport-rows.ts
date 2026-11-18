import { notTestedResult } from "./helpers.ts"
import type {
  HeldViewportCandidate,
  HeldViewportFrame,
  HeldViewportReading,
  ObservationFrame,
  ProbeCallbackResult,
  ReadHeldViewport,
  ReadViewportReference,
  TermProbeSource,
} from "./types.ts"

/**
 * Hosted macOS Alacritty 0.17.0's default ScrollToTop / ScrollPageUp bindings, the first route whose endpoint
 * behaviour is bound (@cto 1154). owned-terminal.ts installs exactly this string.
 */
export const ALACRITTY_0_17_VIEWPORT_ROUTE =
  "hosted alacritty 0.17.0 default bindings (shift+Page_Up/Page_Down/Home/End), keys-only CGEvent"

/** The Linux xterm 411/412 route: its launch declares the two steps xterm leaves unbound (34632). */
export const XTERM_411_VIEWPORT_ROUTE =
  "xterm container launch viewport keys (XTerm*VT100.Translations #override Shift<Key>Home/End)"

/** Linux Alacritty 0.17.0's own default bindings, pressed through the container's XTEST adapter (34278). */
export const LINUX_ALACRITTY_0_17_VIEWPORT_ROUTE =
  "linux alacritty 0.17.0 default bindings (shift+Page_Up/Page_Down/Home/End), XTEST"

/**
 * The routes whose endpoint behaviour is bound, by exact identity (@cto 1154; the two Linux routes @cto a6ed9b08,
 * 34278). An endpoint claim on any other route, including one whose name merely resembles these, stays TODO.
 */
const ENDPOINT_BOUND_ROUTES: ReadonlySet<string> = new Set([
  ALACRITTY_0_17_VIEWPORT_ROUTE,
  XTERM_411_VIEWPORT_ROUTE,
  LINUX_ALACRITTY_0_17_VIEWPORT_ROUTE,
])

/** Rows the fixture needs: 10 lines of growth plus the empty-history line must stay below one screen. */
export const HELD_ROWS_MIN = 13
/** Lines of history a row writes beyond the empty-history line; at least this many retained is Supported. */
const GROWTH = 10
/** total-lines and ED3 take about 18 raw frames and 10 key posts; the 30 s default wall is too short for them. */
export const HELD_VIEWPORT_WALL_MS = 90_000

type Hold = Parameters<ReadHeldViewport>[0]

interface Reader {
  readonly read: ReadHeldViewport
  readonly reference: ReadViewportReference
  readonly route: string
}

/** The lines the fixture wrote, oldest first, and where the last ED3 cut history: the model a reference paints. */
class Fixture {
  readonly lines: string[] = []
  historyStart = 0
  private next = 0

  constructor(
    private readonly ctx: TermProbeSource,
    private readonly nonce: string,
  ) {}

  private line(tag: string) {
    const text = `${this.nonce}-${tag}${String(this.next++).padStart(3, "0")}`
    this.lines.push(text)
    return text
  }

  /** RIS, ED3, cursor hidden for every frame, then one full screen of unique lines and no scroll. */
  prepare() {
    this.ctx.write("\x1bc\x1b[3J\x1b[?25l\x1b[H")
    this.historyStart = 0
    for (let row = 0; row < this.ctx.rows; row++) this.ctx.write(`${row === 0 ? "" : "\r\n"}${this.line("s")}`)
  }

  /** One more line at the bottom: the top screen line moves into history. */
  displace(tag: string) {
    this.ctx.write(`\r\n${this.line(tag)}`)
  }

  /** ED3: the model forgets every line above the screen. */
  eraseHistory() {
    this.ctx.write("\x1b[3J")
    this.historyStart = this.lines.length - this.ctx.rows
  }

  /** Lines in history now, per the model. */
  get history() {
    return this.lines.length - this.ctx.rows - this.historyStart
  }

  /** The screen a view `shift` rows above the bottom shows, given `length` lines written (the model at a bracket). */
  view(length: number, shift: number) {
    return this.lines.slice(length - this.ctx.rows - shift, length - shift)
  }
}

interface Bracket {
  readonly name: string
  readonly reading: HeldViewportReading
  /** Lines written when the bracket ran: its reference is painted from the model at that point. */
  readonly length: number
  readonly history: number
}

type Qualified = { readonly candidate: HeldViewportCandidate; readonly reference: HeldViewportFrame }

/** The heldViewportReadTodo branch's replacement: the reader, when this source installed one. */
export function heldViewportReader(ctx: TermProbeSource): Reader | undefined {
  const read = ctx.readHeldViewport
  const reference = ctx.readViewportReference
  const route = ctx.viewportScroll?.route
  return read && reference && route !== undefined ? { read, reference, route } : undefined
}

const todo = (reason: string, state: object): ProbeCallbackResult => ({
  ...notTestedResult(reason, state),
  tests: [{ id: "criterion", status: "probe-todo", reason }],
})

function decided(
  outcome: "supported" | "unsupported",
  note: string,
  expected: string,
  evidence: readonly Qualified[],
  state: object,
): ProbeCallbackResult {
  // Two brackets at the same point share one painted reference, and an already-held read's b0 is the reference
  // it bound to: each frame is cited once.
  const byRef = new Map<string, ObservationFrame>()
  for (const { candidate, reference } of evidence) {
    for (const frame of [candidate.b0, ...candidate.held, candidate.b1, reference]) byRef.set(frame.ref, frame.recorded)
  }
  const frames = [...byRef.values()].sort((a, b) => a.capturedAt - b.capturedAt)
  const target = evidence.at(-1)?.candidate.held[0]
  // #34632: a decided screenshot has to cite the frame digests it decided on (run-parser's
  // requireCitedFrameDigests). The held crop and the observed reference it was compared against are exactly the two
  // frames this grade rests on, so they travel in the assertion's own evidence; the plain state alone left a
  // decided held row unreadable, and the whole run with it.
  const response = JSON.stringify({
    ...state,
    held: target?.ref,
    reference: evidence.at(-1)?.reference.ref,
  })
  return {
    pass: outcome === "supported",
    note,
    response,
    tests: [{ id: "criterion", status: outcome, assertionRefs: [0] }],
    observation: {
      outcome,
      assertionType: "screenshot",
      ...(target ? { screenshotRef: target.ref } : {}),
      frames,
      note,
    },
    assertions: [
      {
        assertionType: "screenshot",
        kind: outcome === "supported" ? "positive" : "negative",
        expected,
        observed: response,
      },
    ],
  }
}

/**
 * One held-viewport row: fixture writes, brackets, then the observed references painted at the bottom AFTER the
 * last bracket (painting can add history), and the row's own grade over what was seen. Every unmet check is a
 * named TODO, never a grade. The cursor is shown again on every exit.
 */
async function heldRow(
  ctx: TermProbeSource,
  reader: Reader,
  label: string,
  run: (
    fixture: Fixture,
    bracket: (name: string, hold: Hold, bottom?: HeldViewportFrame) => Promise<Bracket>,
  ) => Promise<(qualify: (bracket: Bracket) => Promise<Qualified | string>) => Promise<ProbeCallbackResult>>,
): Promise<ProbeCallbackResult> {
  if (!Number.isSafeInteger(ctx.rows) || ctx.rows < HELD_ROWS_MIN || !Number.isSafeInteger(ctx.cols) || ctx.cols < 12) {
    return todo(`held-viewport fixture needs at least ${HELD_ROWS_MIN}x12, measured ${ctx.rows}x${ctx.cols}`, {})
  }
  const fixture = new Fixture(ctx, Math.random().toString(36).slice(2, 6).padEnd(4, "0"))
  try {
    const bracket = async (name: string, hold: Hold, bottom?: HeldViewportFrame): Promise<Bracket> => ({
      name,
      reading: await reader.read(hold, `${label}: ${name}`, bottom),
      length: fixture.lines.length,
      history: fixture.history,
    })
    const grade = await run(fixture, bracket)
    const painted = new Map<string, HeldViewportFrame | string>()
    /** Paint the model's view for this bracket at the bottom, read it, and compare the held crop to it. */
    const qualify = async (seen: Bracket): Promise<Qualified | string> => {
      if (seen.reading.status !== "candidate") {
        return `${seen.name}: ${seen.reading.reason} (${seen.reading.detail}; restored ${seen.reading.restored})`
      }
      const { candidate } = seen.reading
      // The model can paint only lines this row wrote: a shift past them is not a view of this fixture, and a
      // negative slice start would paint a short reference from the end (@dev/18 638ae628 note 1).
      const above = seen.length - ctx.rows
      if (candidate.shift > above) {
        return `${seen.name}: the view moved ${candidate.shift} lines up, past the ${above} this row wrote above the screen`
      }
      const key = `${seen.length}:${candidate.shift}`
      let reference = painted.get(key)
      if (reference === undefined) {
        const view = fixture.view(seen.length, candidate.shift)
        ctx.write("\x1b[H\x1b[2J")
        view.forEach((text, row) => ctx.write(`\x1b[${row + 1};1H${text}`))
        const read = await reader.reference(`${label}: reference for ${seen.name} at ${candidate.shift}`)
        reference = read.status === "reference" ? read.frame : `reference read ${read.reason}: ${read.detail}`
        painted.set(key, reference)
      }
      if (typeof reference === "string") return `${seen.name}: ${reference}`
      if (JSON.stringify(reference.regionRectangle) !== JSON.stringify(candidate.held[0].regionRectangle)) {
        return `${seen.name}: the reference was read on another grid`
      }
      if (reference.regionDigest !== candidate.held[0].regionDigest) {
        return `${seen.name}: the held view at shift ${candidate.shift} is not the observed reference for those lines`
      }
      return { candidate, reference }
    }
    return await grade(qualify)
  } finally {
    ctx.write("\x1b[?25h")
  }
}

/**
 * An endpoint claim (empty history, a count, ED3's single line) needs the bound route, both routes landing on the
 * same s, and that s being every line the model wrote since the last proven-empty point: row 0 of the qualified
 * view is then the oldest line written, observed. Two routes agreeing on a smaller s prove nothing (@cto 1154).
 */
async function endpoint(
  reader: Reader,
  top: Bracket,
  page: Bracket,
  qualify: (bracket: Bracket) => Promise<Qualified | string>,
): Promise<{ s: number; evidence: Qualified[] } | string> {
  if (!ENDPOINT_BOUND_ROUTES.has(reader.route)) {
    return `endpoint behaviour is not bound for route "${reader.route}"`
  }
  const a = await qualify(top)
  if (typeof a === "string") return a
  const b = await qualify(page)
  if (typeof b === "string") return b
  if (a.candidate.shift !== b.candidate.shift) {
    return `top shows ${a.candidate.shift} lines and pageUp ${b.candidate.shift}: the routes disagree`
  }
  if (a.candidate.shift !== top.history) {
    return `both routes stop ${a.candidate.shift} lines up, but ${top.history} were written since the last empty point`
  }
  return { s: a.candidate.shift, evidence: [a, b] }
}

/** Prepare, displace one line, and prove history holds exactly that line through both routes. */
async function emptyHistory(
  fixture: Fixture,
  bracket: (name: string, hold: Hold) => Promise<Bracket>,
): Promise<[Bracket, Bracket]> {
  fixture.prepare()
  fixture.displace("p")
  return [await bracket("empty check, top", "top"), await bracket("empty check, pageUp", "pageUp")]
}

export function heldAccumulate(ctx: TermProbeSource, reader: Reader): Promise<ProbeCallbackResult> {
  return heldRow(ctx, reader, "scrollback.accumulate", async (fixture, bracket) => {
    fixture.prepare()
    for (let index = 0; index < GROWTH; index++) fixture.displace("g")
    const page = await bracket("after growth, pageUp", "pageUp")
    return async (qualify) => {
      const seen = await qualify(page)
      if (typeof seen === "string") return todo(seen, { page: page.reading })
      if (seen.candidate.shift < 2) {
        return todo(`pageUp shows ${seen.candidate.shift} line above the bottom; accumulation needs 2`, {
          page: page.reading,
        })
      }
      return decided(
        "supported",
        `A pageUp hold shows ${seen.candidate.shift} written lines above the bottom, equal to the observed reference`,
        "lines written past the bottom stay readable above it",
        [seen],
        { shift: seen.candidate.shift, route: reader.route },
      )
    }
  })
}

export function heldTotalLines(ctx: TermProbeSource, reader: Reader): Promise<ProbeCallbackResult> {
  return heldRow(ctx, reader, "scrollback.total-lines", async (fixture, bracket) => {
    const [emptyTop, emptyPage] = await emptyHistory(fixture, bracket)
    for (let index = 0; index < GROWTH; index++) fixture.displace("g")
    const top = await bracket("after growth, top", "top")
    const page = await bracket("after growth, pageUp", "pageUp")
    return async (qualify) => {
      const state = { emptyTop: emptyTop.reading, emptyPage: emptyPage.reading, top: top.reading, page: page.reading }
      const empty = await endpoint(reader, emptyTop, emptyPage, qualify)
      if (typeof empty === "string") return todo(`history not proved empty after preparation: ${empty}`, state)
      const full = await qualify(top)
      if (typeof full === "string") return todo(full, state)
      const growth = full.candidate.shift - 1
      if (growth >= GROWTH) {
        return decided(
          "supported",
          `top shows ${full.candidate.shift} lines: ${growth} retained beyond the empty-history line, observed`,
          `at least ${GROWTH} lines retained`,
          [...empty.evidence, full],
          { growth, route: reader.route },
        )
      }
      // A smaller count needs top to be the end of what was kept, and only content proves an endpoint here: the
      // oldest line written. A terminal that kept fewer stops on a line this fixture cannot tell from a transient
      // stop (@cto 1154), so 1-9 stays TODO until an endpoint observation exists.
      const counted = await endpoint(reader, top, page, qualify)
      return todo(
        `top shows ${full.candidate.shift} lines (${growth} beyond the empty-history line); a count below ${GROWTH} ` +
          `needs a proved endpoint: ${typeof counted === "string" ? counted : "the routes agree, but on fewer lines than were written"}`,
        state,
      )
    }
  })
}

export function heldEraseScrollback(ctx: TermProbeSource, reader: Reader): Promise<ProbeCallbackResult> {
  return heldRow(ctx, reader, "erase.screen.scrollback", async (fixture, bracket) => {
    const [emptyTop, emptyPage] = await emptyHistory(fixture, bracket)
    for (let index = 0; index < GROWTH; index++) fixture.displace("g")
    const control = await bracket("before ED3, pageUp", "pageUp")
    fixture.eraseHistory()
    fixture.displace("q")
    const top = await bracket("after ED3, top", "top")
    const page = await bracket("after ED3, pageUp", "pageUp")
    return async (qualify) => {
      const state = { control: control.reading, top: top.reading, page: page.reading }
      const empty = await endpoint(reader, emptyTop, emptyPage, qualify)
      if (typeof empty === "string") return todo(`history not proved empty after preparation: ${empty}`, state)
      const positive = await qualify(control)
      if (typeof positive === "string") return todo(`positive control: ${positive}`, state)
      if (positive.candidate.shift < 2) {
        return todo("positive control: history held fewer than 2 lines before ED3", state)
      }
      const after = await qualify(top)
      if (typeof after === "string") return todo(after, state)
      if (after.candidate.shift > 1) {
        // Pre-ED3 lines are seen above the bottom: that is content, and needs no endpoint.
        return decided(
          "unsupported",
          `after ED3, top still shows ${after.candidate.shift} lines, equal to the pre-ED3 history`,
          "ED3 erases the lines above the screen",
          [...empty.evidence, positive, after],
          { shift: after.candidate.shift, route: reader.route },
        )
      }
      const erased = await endpoint(reader, top, page, qualify)
      if (typeof erased === "string") return todo(`ED3 result not proved at the endpoint: ${erased}`, state)
      return decided(
        "supported",
        "after ED3 and one more line, both routes show exactly that one line of history",
        "ED3 erases the lines above the screen",
        [...empty.evidence, positive, ...erased.evidence],
        { route: reader.route },
      )
    }
  })
}

export function heldOsc720(ctx: TermProbeSource, reader: Reader): Promise<ProbeCallbackResult> {
  return heldRow(ctx, reader, "extensions.osc720-scroll-up", async (fixture, bracket) => {
    fixture.prepare()
    for (let index = 0; index < GROWTH; index++) fixture.displace("g")
    // The bottom reference is taken BEFORE the trigger; nothing is written after it until the held crops.
    const bottom = await reader.reference("extensions.osc720-scroll-up: bottom before OSC 720")
    if (bottom.status !== "reference") {
      return () => Promise.resolve(todo(`bottom reference before OSC 720: ${bottom.reason} (${bottom.detail})`, {}))
    }
    ctx.write("\x1b]720\x07")
    const held = await bracket("after OSC 720", "already-held", bottom.frame)
    return async (qualify) => {
      const seen = await qualify(held)
      // The smaller OSC 720 slice (@cto 1154): Supported from a qualified changed view, otherwise TODO.
      if (typeof seen === "string") return todo(`OSC 720: ${seen}`, { held: held.reading })
      return decided(
        "supported",
        `OSC 720 held the view ${seen.candidate.shift} lines above the bottom, equal to the observed reference`,
        "OSC 720 scrolls the viewport up",
        [seen],
        { shift: seen.candidate.shift, route: reader.route },
      )
    }
  })
}
