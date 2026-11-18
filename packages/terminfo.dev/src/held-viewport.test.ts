/**
 * @failure The held-viewport reader grades a window that moved some other way, crosses a TTY write into its
 *   bracket, observes an already-held view only after writing to it, or leaves the view held (or returns it
 *   twice) on a failure path (34645, @cto e1cfff79 items 1-4). No earlier test reads a held viewport at all.
 * @level l1
 * @consumer The history rows' held-viewport reader on hosted Alacritty (serve.ts installs it).
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import type { ObservationFrame, ViewportStep } from "@terminfo/probe-defs"
import { createHeldViewportReader, cropRows, uniqueRowShift, type HeldViewportGeometry } from "./held-viewport.ts"
import type { TTYTraceMark } from "./tty.ts"

const geometry: HeldViewportGeometry = {
  origin: { x: 2, y: 2 },
  cell: { width: 2, height: 2 },
  cols: 3,
  rows: 4,
  window: "window 7",
}
const WIDTH = 12
const HEIGHT = 14
const PAGE = 3

/** A window over a history of uniquely painted lines; `offset` is how many rows the view sits above the bottom. */
function terminalModel(options: { lines?: number; snapOnWrite?: boolean } = {}) {
  const lines = Array.from({ length: options.lines ?? 12 }, (_, index) => index + 1)
  const log: string[] = []
  const state = { offset: 0, dx: 0, dy: 0, started: 0, unsettled: 0, abandoned: false, refs: 0 }
  const render = () => {
    const rgba = new Uint8Array(WIDTH * HEIGHT * 4)
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const gx = x - geometry.origin.x - state.dx
        const gy = y - geometry.origin.y - state.dy
        const row = Math.floor(gy / geometry.cell.height)
        const col = Math.floor(gx / geometry.cell.width)
        const inside = gx >= 0 && gy >= 0 && row < geometry.rows && col < geometry.cols
        const line = inside ? lines[lines.length - geometry.rows - state.offset + row] : 0
        const at = (y * WIDTH + x) * 4
        // Each line paints a unique colour, and each column a different shade of it, so a sideways
        // move is visible too.
        rgba[at] = line ?? 0
        rgba[at + 1] = inside ? col * 40 + (gx % geometry.cell.width) : 0
        rgba[at + 2] = inside ? gy % geometry.cell.height : 0
        rgba[at + 3] = 255
      }
    }
    return { width: WIDTH, height: HEIGHT, rgba: Buffer.from(rgba) }
  }
  const press = async (step: ViewportStep) => {
    log.push(`press:${step}`)
    const most = lines.length - geometry.rows
    if (step === "pageUp") state.offset = Math.min(most, state.offset + PAGE)
    if (step === "pageDown") state.offset = Math.max(0, state.offset - PAGE)
    if (step === "top") state.offset = most
    if (step === "bottom") state.offset = 0
  }
  return {
    log,
    state,
    /** An observer TTY write: on a terminal that snaps to the bottom on output, it ends any hold. */
    write(text: string) {
      log.push(`write:${text}`)
      state.started++
      if (options.snapOnWrite) state.offset = 0
    },
    route: { route: "model route (alacritty 0.17.0 defaults)", press },
    captureRaw: async (label: string, _deadline = 0, role: "control" | "target" = "control") => {
      log.push(`capture:${label.split(": ")[1]}`)
      state.refs++
      const recorded = { kind: "png", role, ref: `sha256:frame-${state.refs}`, capturedAt: 1000 + state.refs, label }
      return { recorded: recorded as unknown as ObservationFrame, decoded: render() }
    },
    mark: (): TTYTraceMark | undefined => ({
      mode: "record",
      started: state.started,
      unsettled: state.unsettled,
      abandoned: state.abandoned,
    }),
  }
}

function reader(
  model: ReturnType<typeof terminalModel>,
  overrides: Partial<Parameters<typeof createHeldViewportReader>[0]> = {},
) {
  return createHeldViewportReader({
    featureId: "scrollback.accumulate",
    route: () => model.route,
    geometry: () => geometry,
    captureRaw: model.captureRaw,
    mark: model.mark,
    timeoutMs: 10_000,
    ...overrides,
  })
}

describe("held viewport reader", () => {
  it("reads a held page as a candidate bracketed by the same bottom reference, in order", async () => {
    const model = terminalModel()
    const reading = await reader(model)("pageUp", "after accumulate")
    expect(reading.status).toBe("candidate")
    if (reading.status !== "candidate") return
    expect(reading.candidate.shift).toBe(PAGE)
    expect(reading.candidate.qualified).toBe(false)
    expect(reading.candidate.b1.regionDigest).toBe(reading.candidate.b0.regionDigest)
    expect(reading.candidate.held[0].ref).toBe("sha256:frame-2")
    expect(reading.candidate.held[0].capturedAt).toBe(1002)
    // The frames the record stored: held crops are targets, so a grade can cite them (run-parser observations.ts).
    expect(reading.candidate.held.map((frame) => frame.recorded.role)).toEqual(["target", "target"])
    expect([reading.candidate.b0.recorded.role, reading.candidate.b1.recorded.role]).toEqual(["control", "control"])
    expect(reading.candidate.bracket.id).toBe("scrollback.accumulate:after accumulate:1")
    expect(model.log).toEqual([
      "capture:bottom reference before the hold",
      "press:pageUp",
      "capture:held crop 1",
      "capture:held crop 2",
      "press:bottom",
      "capture:bottom reference after the hold",
    ])
    expect(model.state.offset).toBe(0)
  })

  it("observes an already-held view with no observer write, even on a terminal that snaps back on output", async () => {
    const model = terminalModel({ snapOnWrite: true })
    const read = reader(model)
    const first = await read("pageUp", "reference")
    if (first.status !== "candidate") throw new Error(`expected a candidate, got ${JSON.stringify(first)}`)
    model.log.length = 0
    // The caller's trigger holds the view (an OSC 720 in the real row); the reader may not write after it.
    model.state.offset = 2
    const held = await read("already-held", "after trigger", first.candidate.b1)
    expect(held.status).toBe("candidate")
    if (held.status === "candidate") expect(held.candidate.shift).toBe(2)
    expect(model.log.filter((entry) => entry.startsWith("write:"))).toEqual([])
    expect(model.log.slice(0, 2)).toEqual(["capture:held crop 1", "capture:held crop 2"])
    expect(model.state.offset).toBe(0)
  })

  it("the snap-back terminal shows why: a write before the crops would end the hold", async () => {
    const model = terminalModel({ snapOnWrite: true })
    model.state.offset = 2
    model.write("\x1b[c")
    expect(model.state.offset).toBe(0)
  })

  it("refuses an already-held read before any step without a reference it recorded for this row", async () => {
    const model = terminalModel()
    const read = reader(model)
    const none = await read("already-held", "after trigger")
    expect(none).toMatchObject({ status: "unavailable", reason: "no-bound-reference", restored: "not-held" })
    const forged = await read("already-held", "after trigger", {
      ref: "sha256:made-up",
      capturedAt: 1,
      regionDigest: "sha256:made-up",
      regionRectangle: { x: 2, y: 2, width: 6, height: 8 },
      recorded: { ref: "sha256:made-up" } as unknown as ObservationFrame,
    })
    expect(forged).toMatchObject({ status: "unavailable", reason: "no-bound-reference" })
    expect(model.log).toEqual([])
  })

  it("returns a post that landed and then rejected to the bottom, once", async () => {
    const model = terminalModel()
    const read = reader(model, {
      route: () => ({
        route: model.route.route,
        press: async (step) => {
          await model.route.press(step)
          if (step === "pageUp") throw new Error("helper exited 1 after posting")
        },
      }),
    })
    const reading = await read("pageUp", "after accumulate")
    expect(reading).toMatchObject({ status: "unavailable", reason: "route-rejected", restored: "bottom-pressed" })
    expect(model.log.filter((entry) => entry === "press:bottom")).toHaveLength(1)
    expect(model.state.offset).toBe(0)
  })

  it("leaves the bottom to the wall when the row is abandoned inside the bracket", async () => {
    const model = terminalModel()
    const read = reader(model, {
      captureRaw: async (label, deadline, role) => {
        if (label.endsWith("held crop 2")) model.state.abandoned = true
        return model.captureRaw(label, deadline, role)
      },
    })
    const reading = await read("pageUp", "after accumulate")
    expect(reading).toMatchObject({ status: "unavailable", reason: "trace-abandoned", restored: "left-to-wall" })
    expect(model.log).not.toContain("press:bottom")
    expect(model.state.offset).toBe(PAGE)
  })

  it("names a TTY operation that started inside the bracket, and one still pending at the opening mark", async () => {
    const moved = terminalModel()
    const movedRead = reader(moved, {
      captureRaw: async (label, deadline, role) => {
        if (label.endsWith("held crop 1")) moved.write("\x1b[5n")
        return moved.captureRaw(label, deadline, role)
      },
    })
    expect(await movedRead("pageUp", "x")).toMatchObject({ reason: "trace-moved", restored: "bottom-pressed" })
    expect(moved.state.offset).toBe(0)
    const pending = terminalModel()
    pending.state.unsettled = 1
    expect(await reader(pending)("pageUp", "x")).toMatchObject({ reason: "trace-unsettled", restored: "not-held" })
    expect(pending.log).not.toContain("press:pageUp")
  })

  it("returns the bottom when a capture throws, and names a changed window", async () => {
    const failing = terminalModel()
    const read = reader(failing, {
      captureRaw: async (label, deadline, role) => {
        if (label.endsWith("held crop 1")) throw new Error("Darwin screenshot capture failed")
        return failing.captureRaw(label, deadline, role)
      },
    })
    expect(await read("pageUp", "x")).toMatchObject({
      reason: "capture-failed",
      detail: "Darwin screenshot capture failed",
      restored: "bottom-pressed",
    })
    const moved = terminalModel()
    const movedRead = reader(moved, {
      captureRaw: async (label, deadline, role) => {
        if (label.endsWith("held crop 1")) {
          throw new Error("Darwin owned window 7 identity or bounds changed during capture")
        }
        return moved.captureRaw(label, deadline, role)
      },
    })
    expect(await movedRead("pageUp", "x")).toMatchObject({ reason: "geometry-changed", restored: "bottom-pressed" })
  })

  it("rethrows a snapshot that throws after returning the bottom once", async () => {
    const model = terminalModel()
    let marks = 0
    const read = reader(model, {
      mark: () => {
        if (++marks === 3) throw new Error("trace snapshot failed")
        return model.mark()
      },
    })
    await expect(read("pageUp", "x")).rejects.toThrow("trace snapshot failed")
    expect(model.log.filter((entry) => entry === "press:bottom")).toHaveLength(1)
    expect(model.state.offset).toBe(0)
  })

  it("records a failing bottom step as restore-failed and never posts it twice", async () => {
    const model = terminalModel()
    const read = reader(model, {
      route: () => ({
        route: model.route.route,
        press: async (step) => {
          await model.route.press(step)
          if (step === "bottom") throw new Error("helper timed out")
        },
      }),
    })
    expect(await read("pageUp", "x")).toMatchObject({ reason: "route-rejected", restored: "restore-failed" })
    expect(model.log.filter((entry) => entry === "press:bottom")).toHaveLength(1)
  })

  it("refuses a bottom that did not come back to its reference", async () => {
    const model = terminalModel()
    const read = reader(model, {
      route: () => ({
        route: model.route.route,
        press: async (step) => {
          await model.route.press(step)
          // The view lands one row short of the bottom.
          if (step === "bottom") model.state.offset = 1
        },
      }),
    })
    expect(await read("pageUp", "x")).toMatchObject({ reason: "reference-mismatch", restored: "bottom-pressed" })
  })

  it("reports outside a live trace, and on replay, before taking any frame", async () => {
    const model = terminalModel()
    expect(await reader(model, { mark: () => undefined })("pageUp", "x")).toMatchObject({ reason: "no-trace-scope" })
    expect(
      await reader(model, { mark: () => ({ mode: "replay", started: 0, unsettled: 0, abandoned: false }) })(
        "pageUp",
        "x",
      ),
    ).toMatchObject({ reason: "replay" })
    expect(await reader(model, { route: () => undefined })("pageUp", "x")).toMatchObject({ reason: "route-missing" })
    expect(await reader(model, { geometry: () => undefined })("pageUp", "x")).toMatchObject({
      reason: "capture-failed",
    })
    expect(model.log).toEqual([])
  })
})

describe("movement falsifiers on a complete synthetic window, before cropping", () => {
  const rowsAt = (
    model: ReturnType<typeof terminalModel>,
    move: Partial<{ offset: number; dx: number; dy: number }>,
  ) => {
    Object.assign(model.state, { offset: 0, dx: 0, dy: 0 }, move)
    return model.captureRaw("x: frame").then((raw) => cropRows(raw.decoded, geometry).rows)
  }

  it("finds a shift only for a rigid whole-row move up the history", async () => {
    const model = terminalModel()
    const bottom = await rowsAt(model, {})
    expect(uniqueRowShift(bottom, await rowsAt(model, { offset: 2 }))).toBe(2)
    // Down: the view cannot sit below the bottom, so a frame moved down shows a blank band, never a shift.
    expect(uniqueRowShift(bottom, await rowsAt(model, { dy: geometry.cell.height }))).toBe("held row 0 is blank")
    expect(typeof uniqueRowShift(bottom, await rowsAt(model, { dx: 1 }))).toBe("string") // sideways
    expect(typeof uniqueRowShift(bottom, await rowsAt(model, { dy: -1 }))).toBe("string") // sub-cell
    expect(typeof uniqueRowShift(bottom, await rowsAt(model, { offset: 2, dx: 1 }))).toBe("string") // mixed
    expect(typeof uniqueRowShift(bottom, await rowsAt(model, { offset: 2, dy: -1 }))).toBe("string") // mixed
    expect(uniqueRowShift(bottom, bottom)).toBe("the held crop equals the bottom reference")
  })

  it("needs a full-height reference whose rows are all distinct", () => {
    expect(uniqueRowShift(["a", "b", "a", "c"], ["x", "a", "b", "a"])).toBe(
      "the bottom reference rows are not all distinct",
    )
  })
})
