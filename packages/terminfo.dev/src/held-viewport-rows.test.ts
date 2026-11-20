/**
 * @failure A history row grades from a held view that is not the lines it wrote, claims an endpoint (empty
 *   history, a retained count, ED3's single line) from routes that disagree or stop short of what was written,
 *   or calls an unchanged view an OSC 720 scroll (34645, @cto 1154 grader slice). No earlier test grades these
 *   rows from a held viewport at all: they returned TODO.
 * @level l1
 * @consumer scrollback.accumulate, scrollback.total-lines, erase.screen.scrollback and extensions.osc720-scroll-up
 *   on hosted Alacritty, through the real reader serve.ts installs.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import {
  ALACRITTY_0_17_VIEWPORT_ROUTE,
  ALL_PROBES,
  LINUX_ALACRITTY_0_17_VIEWPORT_ROUTE,
  XTERM_411_VIEWPORT_ROUTE,
  type ObservationFrame,
  type ProbeCallbackResult,
  type ProbeSuiteManifest,
  type TermProbeSource,
  type ViewportStep,
} from "@terminfo/probe-defs"
import { recordExecutedProbe } from "../../probe-defs/src/helpers.ts"
import { createHeldViewportReader, type HeldViewportGeometry } from "./held-viewport.ts"
import type { TTYTraceMark } from "./tty.ts"

const COLS = 12

interface Behaviour {
  /** Lines history keeps; Infinity keeps all. */
  readonly keep?: number
  /** ED3 erases history. */
  readonly ed3?: boolean
  /** Rows OSC 720 scrolls the view up; 0 ignores it. */
  readonly osc720?: number
  /** pageUp and top stop this many rows short of history (a transient stop). */
  readonly short?: Partial<Record<"pageUp" | "top", number>>
  readonly route?: string
  /** pageUp and top both stop at this offset when history is deeper: a stable intermediate stop. */
  readonly stall?: number
  /** The terminal ignores every viewport key. */
  readonly ignoreKeys?: boolean
  /**
   * ED2 pushes the screen's lines into history, as alacritty's clear_viewport does (default): painting a reference
   * adds history, which is why references are painted after the last bracket (@dev/18 638ae628 note 2).
   */
  readonly ed2PushesHistory?: boolean
  /** Lines already in history before the row runs, and kept through RIS (ED3 still erases them). */
  readonly leftover?: number
  /** Screen rows; 14 unless a case needs the 24-row example. */
  readonly rows?: number
  /** A held viewport preserves its content, snaps, or keeps its distance from the bottom when output scrolls. */
  readonly holdOutput?: "preserve" | "snap" | "follow"
  readonly synchronizedHoldOutput?: "preserve" | "snap" | "follow"
  /** A missing in-order status reply cannot prove that the output was parsed. */
  readonly witnessReply?: boolean
  readonly witnessError?: boolean
  readonly restoreError?: boolean
}

/** A text terminal for the fixture's escapes, painted as pixels a reader crops: one colour per line text. */
function terminal(behaviour: Behaviour = {}) {
  const events: { kind: "write" | "press" | "capture" | "query" | "mark"; value: string }[] = []
  const ROWS = behaviour.rows ?? 14
  const geometry: HeldViewportGeometry = {
    origin: { x: 2, y: 2 },
    cell: { width: 2, height: 2 },
    cols: COLS,
    rows: ROWS,
    window: "window 7",
  }
  const WIDTH = geometry.origin.x * 2 + COLS * geometry.cell.width
  const HEIGHT = geometry.origin.y * 2 + ROWS * geometry.cell.height
  const keep = behaviour.keep ?? Number.POSITIVE_INFINITY
  let history: string[] = Array.from({ length: behaviour.leftover ?? 0 }, (_, index) => `leftover-${index}`)
  let screen: string[] = Array.from({ length: ROWS }, () => "")
  let cursor = 0
  let offset = 0
  let refs = 0
  let synchronized = false
  const trace = { started: 0, unsettled: 0, abandoned: false }
  const scroll = () => {
    const [top = "", ...rest] = screen
    history.push(top)
    if (history.length > keep) history = history.slice(history.length - keep)
    screen = [...rest, ""]
    const output = synchronized ? (behaviour.synchronizedHoldOutput ?? behaviour.holdOutput) : behaviour.holdOutput
    if (offset > 0 && output === "preserve") offset = Math.min(history.length, offset + 1)
    if (offset > 0 && output === "snap") offset = 0
  }
  const write = (text: string) => {
    events.push({ kind: "write", value: text })
    trace.started++
    const pattern =
      /\x1bc|\x1b\[3J|\x1b\[2J|\x1b\[0m|\x1b\[\?2026[lh]|\x1b\[\?25[lh]|\x1b\[(\d+);1H|\x1b\[H|\x1b\]720\x07|\r\n|[^\x1b\r]+/g
    for (const [token, row] of text.matchAll(pattern)) {
      if (token === "\x1bc") {
        screen = screen.map(() => "")
        cursor = 0
        offset = 0
      } else if (token === "\x1b[3J") {
        if (behaviour.ed3 ?? true) history = []
      } else if (token === "\x1b[2J") {
        if (behaviour.ed2PushesHistory ?? true) {
          const last = screen.findLastIndex((text) => text !== "")
          for (const text of screen.slice(0, last + 1)) history.push(text)
          if (history.length > keep) history = history.slice(history.length - keep)
        }
        screen = screen.map(() => "")
      } else if (token === "\x1b[H") {
        cursor = 0
      } else if (token === "\x1b[?2026h") {
        synchronized = true
      } else if (token === "\x1b[?2026l") {
        synchronized = false
      } else if (row !== undefined) {
        cursor = Number(row) - 1
      } else if (token === "\x1b]720\x07") {
        offset = Math.min(history.length, offset + (behaviour.osc720 ?? 0))
      } else if (token === "\r\n") {
        if (cursor === ROWS - 1) scroll()
        else cursor++
      } else if (!token.startsWith("\x1b")) {
        screen[cursor] = token
      }
    }
  }
  const press = async (step: ViewportStep) => {
    if (behaviour.ignoreKeys) return
    const most = Math.min(history.length, behaviour.stall ?? Number.POSITIVE_INFINITY)
    if (step === "pageUp") offset = Math.max(0, Math.min(most - (behaviour.short?.pageUp ?? 0), offset + ROWS))
    if (step === "pageDown") offset = Math.max(0, offset - ROWS)
    if (step === "top") offset = Math.max(0, most - (behaviour.short?.top ?? 0))
    if (step === "bottom") offset = 0
  }
  const render = () => {
    const visible = [...history, ...screen].slice(history.length - offset, history.length - offset + ROWS)
    const rgba = new Uint8Array(WIDTH * HEIGHT * 4)
    visible.forEach((text, row) => {
      const tint = text ? createHash("sha256").update(text).digest() : Buffer.alloc(3)
      for (let col = 0; col < COLS; col++) {
        for (let dy = 0; dy < geometry.cell.height; dy++) {
          for (let dx = 0; dx < geometry.cell.width; dx++) {
            const x = geometry.origin.x + col * geometry.cell.width + dx
            const y = geometry.origin.y + row * geometry.cell.height + dy
            const at = (y * WIDTH + x) * 4
            rgba[at] = tint[0] ?? 0
            rgba[at + 1] = text ? ((tint[1] ?? 0) + col * 17) & 255 : 0
            rgba[at + 2] = tint[2] ?? 0
            rgba[at + 3] = 255
          }
        }
      }
    })
    return { width: WIDTH, height: HEIGHT, rgba: Buffer.from(rgba) }
  }
  let held = false
  const route = {
    route: behaviour.route ?? ALACRITTY_0_17_VIEWPORT_ROUTE,
    async press(step: ViewportStep) {
      events.push({ kind: "press", value: step })
      held = step !== "bottom"
      await press(step)
    },
    adoptHold() {
      held = true
    },
    async returnToBottom() {
      if (!held) return "not-held" as const
      if (behaviour.restoreError) throw new Error("owned viewport restoration failed")
      await route.press("bottom")
      return "bottom-pressed" as const
    },
  }
  const reader = createHeldViewportReader({
    featureId: "model",
    route: () => route,
    geometry: () => geometry,
    captureRaw: async (label, _deadline, role = "control") => {
      events.push({ kind: "capture", value: label })
      refs++
      const recorded: ObservationFrame = {
        kind: "pixels",
        role,
        ref: `sha256:${createHash("sha256").update(`frame-${refs}`).digest("hex")}`,
        capturedAt: 1000 + refs,
        label,
      }
      return { recorded, decoded: render() }
    },
    mark: (): TTYTraceMark => {
      events.push({ kind: "mark", value: "" })
      return { mode: "record", ...trace }
    },
    timeoutMs: 60_000,
  })
  const ctx = {
    rows: ROWS,
    cols: COLS,
    write,
    viewportScroll: route,
    readHeldViewport: reader.read,
    readViewportReference: reader.reference,
    queryCursorPosition: async () => {
      events.push({ kind: "query", value: "cursor status" })
      trace.started++
      if (behaviour.witnessError) throw new Error("processed-output query failed")
      return behaviour.witnessReply === false ? null : { row: ROWS, col: 1 }
    },
  } as unknown as TermProbeSource
  return { ctx, events, view: () => ({ offset, history: history.length }) }
}

async function grade(id: string, behaviour: Behaviour = {}): Promise<ProbeCallbackResult> {
  const definition = ALL_PROBES.find((entry) => entry.id === id)
  if (!definition?.term) throw new Error(`${id} has no app callback`)
  const model = terminal(behaviour)
  const result = await definition.term(model.ctx)
  // Every exit leaves the view at the bottom.
  expect(model.view().offset, `${id} left the view held`).toBe(0)
  return result
}

const status = (result: ProbeCallbackResult) =>
  result.tests?.[0]?.status ?? (result.notTested ? "probe-todo" : undefined)

describe.each([LINUX_ALACRITTY_0_17_VIEWPORT_ROUTE, XTERM_411_VIEWPORT_ROUTE])("viewport hold on %s", (route) => {
  // The accepted P2 contract requires one stimulus and its parsed-output witness before m0. Outcome-only
  // cases would also pass if extra writes entered the bracket or the witness happened before the stimulus.
  it("accounts for one stimulus and a processed witness before each zero-I/O bracket", async () => {
    const model = terminal({ route, holdOutput: "preserve" })
    const definition = ALL_PROBES.find((entry) => entry.id === "scrollback.viewport-hold-output")!
    const result = await definition.term!(model.ctx)
    expect(status(result)).toBe("supported")
    for (const phase of ["ordinary", "synchronized"]) {
      const first = model.events.findIndex(
        (event) => event.kind === "capture" && event.value.includes(`${phase}: held after output: held crop 1`),
      )
      expect(first).toBeGreaterThan(0)
      const open = model.events.findLastIndex((event, index) => index < first && event.kind === "mark")
      const close = model.events.findIndex((event, index) => index > first && event.kind === "mark")
      const hold = model.events.findLastIndex(
        (event, index) => index < open && event.kind === "press" && event.value === "pageUp",
      )
      const before = model.events.slice(hold + 1, open)
      const writes = before.filter((event) => event.kind === "write")
      expect(writes).toHaveLength(1)
      expect(writes[0]!.value.startsWith("\x1b[?2026h")).toBe(phase === "synchronized")
      expect(
        before.filter((event) => event.kind === "write" || event.kind === "query").map((event) => event.kind),
      ).toEqual(["write", "query"])
      expect(model.events.slice(open + 1, close).map((event) => event.kind)).toEqual(["capture", "capture"])
    }
  })
  it.each([
    ["preserve", "supported"],
    ["snap", "unsupported"],
    ["follow", "unsupported"],
  ] as const)("qualifies %s output through the real held reader", async (holdOutput, expected) => {
    const result = await grade("scrollback.viewport-hold-output", { route, holdOutput })
    expect(status(result)).toBe(expected)
    citesItsFrames(result)
    expect(roundTripViewport(result).results?.[0]?.status).toBe(expected)
    if (holdOutput === "follow") expect(result.note).toMatch(/view followed output by 1 rows?/)
  })

  it("does not call stable held crops Supported without the processed-output witness", async () => {
    const result = await grade("scrollback.viewport-hold-output", {
      route,
      holdOutput: "preserve",
      witnessReply: false,
    })
    expect(status(result)).toBe("probe-todo")
    expect(result.tests?.[0]?.reason ?? result.note).toMatch(/processed|witness|status.*reply/i)
  })

  it("also measures synchronized output after ordinary output preserves the held view", async () => {
    const result = await grade("scrollback.viewport-hold-output", {
      route,
      holdOutput: "preserve",
      synchronizedHoldOutput: "snap",
    })
    expect(status(result)).toBe("unsupported")
    expect(result.note).toMatch(/synchronized/i)
    citesItsFrames(result)
  })

  // The row's own finally must preserve a primary query error alongside a failed return, and must not let
  // cleanup failure turn into an apparently valid TODO. Core reader tests cannot reach this pre-m0 exit.
  it.each([false, true])(
    "keeps restoration failure loud after a missing or failed witness (failed query: %s)",
    async (witnessError) => {
      const model = terminal({ route, holdOutput: "preserve", witnessReply: false, witnessError, restoreError: true })
      const definition = ALL_PROBES.find((entry) => entry.id === "scrollback.viewport-hold-output")!
      const result = definition.term!(model.ctx)
      if (witnessError) {
        await expect(result).rejects.toMatchObject({
          name: "AggregateError",
          errors: [
            expect.objectContaining({ message: "processed-output query failed" }),
            expect.objectContaining({ message: "owned viewport restoration failed" }),
          ],
        })
      } else await expect(result).rejects.toThrow("owned viewport restoration failed")
    },
  )
})

/** The production record/parser boundary, replacing the deleted wheel fixture's independent roundtrip model. */
function roundTripViewport(result: ProbeCallbackResult) {
  const featureId = "scrollback.viewport-hold-output"
  const assertions = (result.assertions ?? []).map((entry) => ({ ...entry, featureId, rawReplyRef: featureId }))
  const recorded = recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: "2026-11-20T21:00:00.000Z" },
    rawReplyRef: featureId,
    observation: result.observation ? { ...result.observation, featureId, rawReplyRef: featureId } : undefined,
    assertions,
    tests: result.tests,
  })
  const suite = "b".repeat(64)
  const manifest: ProbeSuiteManifest = {
    schemaVersion: 4,
    probeHash: suite,
    adapterVersion: "3.3.1",
    generatedAt: "2026-11-20T21:00:00.000Z",
    catalogIds: [featureId],
    probes: { term: [featureId], lib: [], mux: [] },
  }
  const run = {
    schemaVersion: 4,
    source: { kind: "live" },
    runId: "viewport-model",
    suiteId: suite,
    probeHash: suite,
    sourceRevision: "4".repeat(40),
    intendedSubject: { kind: "term", id: "alacritty" },
    subject: {
      kind: "term",
      id: "alacritty",
      version: "0.17.0",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    measuredAt: "2026-11-20T21:01:00.000Z",
    origin: { kind: "collector" },
    sealedAt: "2026-11-20T21:02:00.000Z",
    rawReplies: {
      [featureId]: JSON.stringify({ writes: [], queries: [], events: [] }),
      ...(result.response ? { [`${featureId}.callbackResponse`]: result.response } : {}),
    },
    assertions,
    screenshotRefs: [...new Set((recorded.frames ?? []).map((frame) => frame.ref))],
    results: [recorded],
  }
  return parseRun("viewport-model.json", JSON.stringify(run), [featureId], new Map([[suite, manifest]]))
}

it.each(["tmux", "screen"] as const)("keeps %s viewport unmeasured before any write or capture", async (mux) => {
  const model = terminal({ route: XTERM_411_VIEWPORT_ROUTE, holdOutput: "preserve" })
  model.ctx.mux = mux
  const definition = ALL_PROBES.find((entry) => entry.id === "scrollback.viewport-hold-output")!
  const result = await definition.term!(model.ctx)
  expect(status(result)).toBe("probe-todo")
  expect(result.notTested?.noObservable).toBe("multiplexer viewport hold retains the manual recipe")
  expect(model.events).toEqual([])
})

/** The run-parser's pixel-frame rule: control and target frames, a target primary, targets strictly in order. */
function citesItsFrames(result: ProbeCallbackResult) {
  const frames = result.observation?.frames ?? []
  const targets = frames.filter((frame) => frame.role === "target")
  expect(frames.some((frame) => frame.role === "control")).toBe(true)
  expect(targets.length).toBeGreaterThan(0)
  expect(targets.map((frame) => frame.ref)).toContain(result.observation?.screenshotRef)
  const times = targets.map((frame) => frame.capturedAt)
  expect(times).toEqual([...times].sort((a, b) => a - b))
  expect(new Set(times).size).toBe(times.length)
  expect(new Set(frames.map((frame) => frame.ref)).size).toBe(frames.length)
}

describe("the 24-row example", () => {
  it.each([
    ["scrollback.accumulate", {}],
    ["scrollback.total-lines", {}],
    ["erase.screen.scrollback", {}],
    ["extensions.osc720-scroll-up", { osc720: 5 }],
  ] as const)("%s grades on a 24-row grid", async (id, behaviour) => {
    const result = await grade(id, { rows: 24, ...behaviour })
    expect(status(result)).toBe("supported")
    citesItsFrames(result)
  })
})

describe("viewport keys ignored", () => {
  it.each(["scrollback.accumulate", "scrollback.total-lines", "erase.screen.scrollback"])(
    "%s stays TODO: an unmoved view is no observation",
    async (id) => {
      expect(status(await grade(id, { ignoreKeys: true }))).toBe("probe-todo")
    },
  )
})

describe("observed references come after the last bracket", () => {
  it.each(["scrollback.total-lines", "erase.screen.scrollback"])(
    "%s grades the same whether ED2 pushes history or not",
    async (id) => {
      expect(status(await grade(id, { ed2PushesHistory: true }))).toBe("supported")
      expect(status(await grade(id, { ed2PushesHistory: false }))).toBe("supported")
    },
  )

  it("refuses a view that moved past the lines the row wrote, never painting a short reference", async () => {
    // ED3 ignored keeps 3 lines from before the row: pageUp shows 13, the row wrote 10 above the screen.
    const result = await grade("scrollback.accumulate", { ed3: false, leftover: 3 })
    expect(status(result)).toBe("probe-todo")
    expect(result.note).toMatch(/past the 10 this row wrote/)
  })
})

describe("scrollback.accumulate", () => {
  it("is Supported when a pageUp hold shows the written lines, equal to their observed reference", async () => {
    const result = await grade("scrollback.accumulate")
    expect(status(result)).toBe("supported")
    citesItsFrames(result)
  })

  // @failure A decided held row cited only its own state, so run-parser refused the artifact with "must cite the
  //   frame digest it decided on" and took the whole run with it; no live read had ever reached that branch.
  // @level l1
  // @consumer packages/run-parser requireCitedFrameDigests for a decided screenshot observation (#34632).
  it("cites the frame digests it decided on in the assertion's own evidence", async () => {
    const result = await grade("scrollback.accumulate")
    expect(status(result)).toBe("supported")
    const observed = String(result.assertions?.[0]?.observed ?? "")
    const refs = (result.observation?.frames ?? []).map((frame) => frame.ref)
    expect(refs.length).toBeGreaterThan(0)
    // The fixture's refs are synthetic (sha256:frame-N); the live adapter's are the digest the parser matches, and
    // the live run is what proves that form. Here the invariant is that the evidence cites the retained frames at all.
    expect(refs.some((ref) => observed.includes(ref))).toBe(true)
  })

  it("stays TODO when nothing moved: an unchanged view is never a negative", async () => {
    expect(status(await grade("scrollback.accumulate", { keep: 0 }))).toBe("probe-todo")
  })
})

describe("scrollback.total-lines", () => {
  it("is Supported when top shows every written line beyond the proved-empty one", async () => {
    const result = await grade("scrollback.total-lines")
    expect(status(result)).toBe("supported")
    expect(result.note).toMatch(/10 retained/)
    citesItsFrames(result)
  })

  it("stays TODO on a short history: fewer than 10 kept has no endpoint observation (@cto 1154)", async () => {
    const result = await grade("scrollback.total-lines", { keep: 5 })
    expect(status(result)).toBe("probe-todo")
    expect(result.note).toMatch(/needs a proved endpoint/)
  })

  it("stays TODO when the routes disagree on the empty-history line", async () => {
    // pageUp stops one row short of the one-line history: it never moved, so the routes disagree.
    const result = await grade("scrollback.total-lines", { short: { pageUp: 1 } })
    expect(status(result)).toBe("probe-todo")
  })

  it("stays TODO when both routes agree on a count short of what was written", async () => {
    // The one-line empty check passes; after growth top and pageUp both land 8 lines up out of 11. They agree,
    // and agreement is not an endpoint.
    const result = await grade("scrollback.total-lines", { stall: 8 })
    expect(status(result)).toBe("probe-todo")
    expect(result.note).toMatch(/needs a proved endpoint/)
  })

  it("claims no endpoint on a route whose bindings are not bound", async () => {
    const result = await grade("scrollback.total-lines", { route: "some other route" })
    expect(status(result)).toBe("probe-todo")
    expect(result.note).toMatch(/not bound/)
  })

  // 34278 (@cto a6ed9b08): the Linux xterm 411/412 route and the Linux Alacritty 0.17.0 route are bound by their
  // exact identity, with every endpoint predicate unchanged; a near-miss string is not the route.
  for (const route of [XTERM_411_VIEWPORT_ROUTE, LINUX_ALACRITTY_0_17_VIEWPORT_ROUTE]) {
    it(`binds the endpoint for the exact route "${route}"`, async () => {
      expect(status(await grade("scrollback.total-lines", { route }))).toBe("supported")
      expect(status(await grade("scrollback.total-lines", { route, stall: 8 }))).toBe("probe-todo")
      expect(status(await grade("scrollback.total-lines", { route, short: { pageUp: 1 } }))).toBe("probe-todo")
    })
    it(`claims no endpoint on a route that only resembles "${route}"`, async () => {
      const result = await grade("scrollback.total-lines", { route: `${route} (another build)` })
      expect(status(result)).toBe("probe-todo")
      expect(result.note).toMatch(/not bound/)
    })
  }
})

describe("erase.screen.scrollback", () => {
  it("is Supported when both routes show exactly the one line written after ED3", async () => {
    const result = await grade("erase.screen.scrollback")
    expect(status(result)).toBe("supported")
    citesItsFrames(result)
  })

  it("is Unsupported when top still shows the pre-ED3 lines", async () => {
    const result = await grade("erase.screen.scrollback", { ed3: false })
    expect(status(result)).toBe("unsupported")
    citesItsFrames(result)
  })

  it("stays TODO when both routes stop on the same transient offset where ED3's result would be (@cto 1154 falsifier)", async () => {
    // ED3 ignored, and top and pageUp both stall one line up: the view at s=1 is the same lines either way. The
    // positive control before ED3 (pageUp at s >= 2) is what refuses it.
    const result = await grade("erase.screen.scrollback", { ed3: false, stall: 1 })
    expect(status(result)).toBe("probe-todo")
    expect(result.note).toMatch(/positive control/)
  })

  it("stays TODO when top stops short after ED3 and the routes disagree", async () => {
    const result = await grade("erase.screen.scrollback", { short: { top: 1 } })
    expect(status(result)).toBe("probe-todo")
  })
})

describe("extensions.osc720-scroll-up", () => {
  it("is Supported from an already-held view bound to the reference taken before the trigger", async () => {
    const result = await grade("extensions.osc720-scroll-up", { osc720: 3 })
    expect(status(result)).toBe("supported")
    expect(result.note).toMatch(/3 lines above the bottom/)
    citesItsFrames(result)
  })

  it("stays TODO when OSC 720 moved nothing", async () => {
    expect(status(await grade("extensions.osc720-scroll-up", { osc720: 0 }))).toBe("probe-todo")
  })
})
