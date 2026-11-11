/**
 * @failure  Two contexts measured with different probe suites, or a different app version, decide a cell
 *           together; two contexts that both recorded no suite hash or no app version join on the shared
 *           absence; a disagreement is counted as Supported; or a reopened cell is decided by a context
 *           that never had the ruling.
 * @level    l1
 * @consumer Site selection join: the multi-context counting rule (@cto d321729a, criterion c88ab98d).
 * @testonly none
 */
/**
 * The join that publishes one app's cells from every context measured with the same app version and
 * probe suite (@cto d321729a, 4eef35ea). The cases below are the four @cto named — agree, differ, one
 * undecided, an error in one — plus the two guards that keep history out of a live grade.
 */
import { describe, expect, it } from "vitest"
import {
  DIFFERS_BY_CONTEXT,
  joinContextCells,
  type ContextCellFacts,
  type ContextFacts,
} from "../docs/data/app-cells.ts"

const SAME = "suite-aaa"
const OTHER = "suite-bbb"
const cell = (status: ContextCellFacts["status"], over: Partial<ContextCellFacts> = {}): ContextCellFacts => ({
  status,
  version: "1.0.0",
  suite: SAME,
  runId: `${status}-run`,
  ...over,
})
const context = (key: string, cells: Record<string, ContextCellFacts | undefined>): ContextFacts => ({ key, cells })

describe("joinContextCells", () => {
  it("keeps one decided grade when every joined context agrees", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("supported", { runId: "r1" }) }),
      [context("second", { "sgr.blink": cell("supported", { runId: "r2" }) })],
      ["sgr.blink"],
    )
    expect(joined.cells["sgr.blink"]?.status).toBe("supported")
    expect(joined.cells["sgr.blink"]?.from.map((source) => source.runId)).toEqual(["r1", "r2"])
    expect(joined.contexts).toEqual(["primary", "second"])
  })

  it("reads differs-by-context and names both grades when two joined contexts disagree", () => {
    const joined = joinContextCells(
      context("primary", { "input.xtest-key": cell("supported", { runId: "r1" }) }),
      [context("second", { "input.xtest-key": cell("unsupported", { runId: "r2" }) })],
      ["input.xtest-key"],
    )
    expect(joined.cells["input.xtest-key"]?.status).toBe(DIFFERS_BY_CONTEXT)
    expect(joined.cells["input.xtest-key"]?.from.map((source) => source.status)).toEqual(["supported", "unsupported"])
    expect(joined.counts[DIFFERS_BY_CONTEXT]).toBe(1)
    expect(joined.counts.supported).toBe(0)
  })

  it("takes the decided grade when the other joined context only left it to do", () => {
    const joined = joinContextCells(
      context("primary", { "modes.focus-tracking": cell("probe-todo") }),
      [context("second", { "modes.focus-tracking": cell("supported", { runId: "r2" }) })],
      ["modes.focus-tracking"],
    )
    expect(joined.cells["modes.focus-tracking"]?.status).toBe("supported")
    expect(joined.cells["modes.focus-tracking"]?.from.map((source) => source.context)).toEqual(["second"])
  })

  it("reads Invalid and names the context that errored when nothing is decided", () => {
    const joined = joinContextCells(
      context("primary", { "scrollback.total-lines": cell("probe-todo") }),
      [context("second", { "scrollback.total-lines": cell("probe-invalid", { runId: "r2" }) })],
      ["scrollback.total-lines"],
    )
    expect(joined.cells["scrollback.total-lines"]?.status).toBe("probe-invalid")
    expect(joined.cells["scrollback.total-lines"]?.from).toEqual([
      { context: "second", status: "probe-invalid", runId: "r2" },
    ])
  })

  it("lets Conflicting outrank Invalid when nothing is decided", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.bg.bright": cell("probe-conflict", { runId: "r1" }) }),
      [context("second", { "sgr.bg.bright": cell("probe-invalid", { runId: "r2" }) })],
      ["sgr.bg.bright"],
    )
    expect(joined.cells["sgr.bg.bright"]?.status).toBe("probe-conflict")
    expect(joined.cells["sgr.bg.bright"]?.from.map((source) => source.context)).toEqual(["primary"])
  })

  it("never joins a context on another probe suite", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("unsupported", { runId: "r1" }) }),
      [context("other-suite", { "sgr.blink": cell("supported", { suite: OTHER, runId: "r2" }) })],
      ["sgr.blink"],
    )
    expect(joined.cells["sgr.blink"]?.status).toBe("unsupported")
    expect(joined.cells["sgr.blink"]?.from.map((source) => source.context)).toEqual(["primary"])
    expect(joined.contexts).toEqual(["primary"])
  })

  it("never joins a context that measured another app version", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.underline.color": cell("supported", { version: "1.4.0", runId: "r1" }) }),
      [context("older-app", { "sgr.underline.color": cell("unsupported", { version: "1.3.1", runId: "r2" }) })],
      ["sgr.underline.color"],
    )
    expect(joined.cells["sgr.underline.color"]?.status).toBe("supported")
    expect(joined.contexts).toEqual(["primary"])
  })

  it("keeps a reopened cell at To do even when a joined context has a decided grade", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("probe-todo", { reopened: true }) }),
      [context("second", { "sgr.blink": cell("supported", { runId: "r2" }) })],
      ["sgr.blink"],
    )
    expect(joined.cells["sgr.blink"]).toEqual({ status: "probe-todo", from: [] })
    expect(joined.counts["probe-todo"]).toBe(1)
  })

  it("never joins two contexts that both recorded no suite hash", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("probe-todo", { suite: null }) }),
      [context("second", { "sgr.blink": cell("supported", { suite: null, runId: "r2" }) })],
      ["sgr.blink"],
    )
    expect(joined.cells["sgr.blink"]).toEqual({ status: "probe-todo", from: [] })
    expect(joined.contexts).toEqual(["primary"])
  })

  it("never joins two contexts that both recorded no app version", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("supported", { version: null }) }),
      [context("second", { "sgr.blink": cell("unsupported", { version: null, runId: "r2" }) })],
      ["sgr.blink"],
    )
    expect(joined.cells["sgr.blink"]?.status).toBe("supported")
    expect(joined.cells["sgr.blink"]?.from.map((source) => source.context)).toEqual(["primary"])
  })

  it("counts one position per catalogue feature, never one per context", () => {
    const joined = joinContextCells(
      context("primary", { a: cell("supported"), b: cell("probe-todo"), c: undefined }),
      [context("second", { a: cell("supported"), b: cell("unsupported"), c: cell("supported") })],
      ["a", "b", "c"],
    )
    expect(Object.values(joined.counts).reduce((sum, count) => sum + count, 0)).toBe(3)
    expect(joined.counts).toMatchObject({ supported: 1, unsupported: 1, "probe-todo": 1 })
    expect(joined.cells.c).toEqual({ status: "probe-todo", from: [] })
  })
})
