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
import {
  ALACRITTY_0_17_VIEWPORT_ROUTE,
  ALL_PROBES,
  type ObservationFrame,
  type ProbeCallbackResult,
  type TermProbeSource,
  type ViewportStep,
} from "@terminfo/probe-defs"
import { createHeldViewportReader, type HeldViewportGeometry } from "./held-viewport.ts"
import type { TTYTraceMark } from "./tty.ts"

const ROWS = 14
const COLS = 12
const geometry: HeldViewportGeometry = {
  origin: { x: 2, y: 2 },
  cell: { width: 2, height: 2 },
  cols: COLS,
  rows: ROWS,
  window: "window 7",
}
const WIDTH = geometry.origin.x * 2 + COLS * geometry.cell.width
const HEIGHT = geometry.origin.y * 2 + ROWS * geometry.cell.height

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
}

/** A text terminal for the fixture's escapes, painted as pixels a reader crops: one colour per line text. */
function terminal(behaviour: Behaviour = {}) {
  const keep = behaviour.keep ?? Number.POSITIVE_INFINITY
  let history: string[] = []
  let screen: string[] = Array.from({ length: ROWS }, () => "")
  let cursor = 0
  let offset = 0
  let refs = 0
  const trace = { started: 0, unsettled: 0, abandoned: false }
  const scroll = () => {
    const [top = "", ...rest] = screen
    history.push(top)
    if (history.length > keep) history = history.slice(history.length - keep)
    screen = [...rest, ""]
  }
  const write = (text: string) => {
    trace.started++
    const pattern = /\x1bc|\x1b\[3J|\x1b\[2J|\x1b\[\?25[lh]|\x1b\[(\d+);1H|\x1b\[H|\x1b\]720\x07|\r\n|[^\x1b\r]+/g
    for (const [token, row] of text.matchAll(pattern)) {
      if (token === "\x1bc") {
        screen = screen.map(() => "")
        cursor = 0
        offset = 0
      } else if (token === "\x1b[3J") {
        if (behaviour.ed3 ?? true) history = []
      } else if (token === "\x1b[2J") {
        screen = screen.map(() => "")
      } else if (token === "\x1b[H") {
        cursor = 0
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
    const most = history.length
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
  const route = { route: behaviour.route ?? ALACRITTY_0_17_VIEWPORT_ROUTE, press }
  const reader = createHeldViewportReader({
    featureId: "model",
    route: () => route,
    geometry: () => geometry,
    captureRaw: async (label, _deadline, role = "control") => {
      refs++
      const recorded = { kind: "png", role, ref: `sha256:frame-${refs}`, capturedAt: 1000 + refs, label }
      return { recorded: recorded as unknown as ObservationFrame, decoded: render() }
    },
    mark: (): TTYTraceMark => ({ mode: "record", ...trace }),
    timeoutMs: 60_000,
  })
  const ctx = {
    rows: ROWS,
    cols: COLS,
    write,
    viewportScroll: route,
    readHeldViewport: reader.read,
    readViewportReference: reader.reference,
  } as unknown as TermProbeSource
  return { ctx, view: () => ({ offset, history: history.length }) }
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

const status = (result: ProbeCallbackResult) => result.tests?.[0]?.status

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

describe("scrollback.accumulate", () => {
  it("is Supported when a pageUp hold shows the written lines, equal to their observed reference", async () => {
    const result = await grade("scrollback.accumulate")
    expect(status(result)).toBe("supported")
    citesItsFrames(result)
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

  it("claims no endpoint on a route whose bindings are not bound", async () => {
    const result = await grade("scrollback.total-lines", { route: "some other route" })
    expect(status(result)).toBe("probe-todo")
    expect(result.note).toMatch(/not bound/)
  })
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
