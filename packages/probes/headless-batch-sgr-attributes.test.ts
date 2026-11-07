/**
 * @failure An App SGR row credits a reply or any changed pixels without qualifying its
 * made-up/handled controls, mistakes a collapsed style for support, or attributes an outer
 * terminal's negative to a mux. Existing colour/reset and capture-presence tests do not
 * exercise the approved attribute decision or reply-first capture route.
 * @level l1
 * @consumer SGR attribute callbacks through execution recording and the native SGR finalizer.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import { sgrProbes, finalizeSgrResult } from "../probe-defs/src/sgr.ts"
import { recordExecutedProbe } from "../probe-defs/src/helpers.ts"
import type { CaptureRequest, ObservationFrame, TermProbeSource } from "../probe-defs/src/types.ts"

const sample = "AaBb 0123456789 - terminal text"
const geometry = { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 }
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
type Fault = "none" | "unknown" | "blind" | "ignored" | "single" | "inverse" | "hidden" | "unstable"

/** A tiny paint adapter, not a grader: independently supplied style failures change pixels.
 * The real callbacks own writes, geometry, control ordering, witnesses and result recording. */
async function measure(id: string, fault: Fault = "none", reply = true) {
  const probe = sgrProbes.find((entry) => entry.id === id)
  if (!probe?.term) throw new Error(`Missing App callback ${id}`)
  const frames: ObservationFrame[] = []
  const writes: string[] = []
  let sgr = "0"
  let painted = "blank"
  let sentinel = " "
  let count = 0
  const target = {
    "sgr.bold": "1",
    "sgr.inverse": "7",
    "sgr.hidden": "8",
    "sgr.overline": "53",
    "sgr.underline.single": "4",
    "sgr.underline.curly": "4:3",
  }[id]
  if (!target) throw new Error(`Undeclared fixture style ${id}`)
  const paint = (style: string) => {
    if (style === "99") return fault === "unknown" ? "unknown ink" : "plain"
    if (style === target) {
      if (fault === "ignored") return "plain"
      if (fault === "single") return "style:4"
      if (fault === "inverse") return "style:7"
      if (fault === "hidden") return "wrong hidden ink"
    }
    if (fault === "blind" && style === (id === "sgr.inverse" ? "4" : "7")) return "plain"
    return style === "0" ? "plain" : style === "8" ? "blank" : `style:${style}`
  }
  const ctx = {
    kind: "live",
    rows: 24,
    cols: 80,
    captureKind: "pixels",
    captureGeometry: { geometry, source: "measured by complete raster calibration" },
    write(value: string) {
      writes.push(value)
      for (const token of value.matchAll(/\x1b\[([0-9:;?]*)([A-Za-z])|([^\x1b]+)/g)) {
        if (token[2] === "m") sgr = token[1] || "0"
        if (token[2] === "J") painted = "blank"
        if (token[3]?.includes(sample)) painted = paint(sgr)
      }
      const witness = /\x1b\[1;1H([^\x1b])/.exec(value)
      if (witness) sentinel = witness[1]!
    },
    async queryWithSentinelOutcome(_sequence: string, pattern: RegExp) {
      const raw = reply ? `\x1bP1$r${sgr}m\x1b\\` : "\x1b[?1;2c"
      return { raw, match: pattern.exec(raw), reason: reply ? "reply" : "sentinel" }
    },
    async capture(request: CaptureRequest) {
      count += 1
      const cells = request.cells
      const digest = hash(cells?.top === 1 ? sentinel : painted + (fault === "unstable" ? count : ""))
      const frame: ObservationFrame = {
        role: request.role,
        label: request.label,
        capturedAt: count,
        ref: `sha256:${hash(`${digest}:${count}`)}`,
        kind: "pixels",
        regionDigest: digest,
        pixelsDigest: hash(`${digest}:outside cursor ${count}`),
        ...(cells && {
          regionRectangle: {
            x: (cells.left - 1) * 8,
            y: (cells.top - 1) * 16,
            width: (cells.right - cells.left + 1) * 8,
            height: (cells.bottom - cells.top + 1) * 16,
          },
        }),
      }
      frames.push(frame)
      return frame
    },
    async queryCursorPosition() {
      return { row: 1, col: 2 }
    },
  } as TermProbeSource
  const callback = await probe.term(ctx)
  const recorded = recordExecutedProbe({
    featureId: id,
    attempt: { scope: "probe", startedAt: "2026-11-07T05:00:00Z" },
    observation: callback.observation && { featureId: id, ...callback.observation },
    coverage: callback.notTested && { featureId: id, rawReplyRef: id, ...callback.notTested },
    assertions: (callback.assertions ?? []).map((entry) => ({ featureId: id, ...entry })),
    tests: callback.tests,
    rawReplyRef: id,
    criterionBranch: callback.criterionBranch,
  })
  return { callback, recorded, frames, writes }
}

// AC: ordered rules; existing presence-only tests cannot distinguish these pixel outcomes.
test.each([
  ["sgr.bold", "none", "supported", "target differs from plain"],
  ["sgr.bold", "unknown", "probe-invalid", "made-up"],
  ["sgr.bold", "blind", "probe-todo", "handled"],
  ["sgr.overline", "ignored", "unsupported", "drew nothing"],
  ["sgr.underline.curly", "single", "unsupported", "drawn as single underline"],
  ["sgr.bold", "inverse", "unsupported", "drawn as inverse"],
  ["sgr.hidden", "none", "supported", "blank"],
  ["sgr.hidden", "hidden", "probe-invalid", "hidden"],
  ["sgr.inverse", "none", "supported", "target differs from plain"],
  ["sgr.underline.single", "none", "supported", "target differs from plain"],
  ["sgr.bold", "unstable", "probe-todo", "stable"],
] as const)("%s with %s paint records %s", async (id, fault, status, reason) => {
  const { callback, recorded, frames, writes } = await measure(id, fault)
  expect(recorded.status).toBe(status)
  expect([recorded.reason, callback.note, callback.observation?.note].join(" ")).toContain(reason)
  if (status === "supported" || status === "unsupported") {
    expect(finalizeSgrResult(recorded, { kind: "term" }, frames).status).toBe(status)
    expect(writes.some((entry) => entry.includes("\x1b[99m"))).toBe(true)
    expect(frames.some((entry) => entry.role === "target" && entry.regionRectangle?.width === sample.length * 8)).toBe(
      true,
    )
  }
})

// AC: reply says set but pixels absent still reads Unsupported; silence uses the same kind.
test.each([true, false])("overline absence is measured after DECRQSS reply=%s", async (reply) => {
  const { recorded } = await measure("sgr.overline", "ignored", reply)
  expect(recorded.status).toBe("unsupported")
})

// AC: only mux negatives stay open, naming the real same-run outer terminal (or missing fact).
test("mux attribution preserves positives and non-mux negatives", async () => {
  const negative = await measure("sgr.overline", "ignored")
  const positive = await measure("sgr.bold")
  for (const outerTerminal of ["kitty", null]) {
    const result = finalizeSgrResult(negative.recorded, { kind: "mux", outerTerminal }, negative.frames)
    expect(result.status).toBe("probe-todo")
    expect(result.reason?.toLowerCase()).toContain(outerTerminal ?? "missing outer terminal")
    expect(finalizeSgrResult(positive.recorded, { kind: "mux", outerTerminal }, positive.frames).status).toBe(
      "supported",
    )
  }
  expect(finalizeSgrResult(negative.recorded, { kind: "term" }, negative.frames)).toEqual(negative.recorded)
  expect(finalizeSgrResult(negative.recorded, { kind: "lib" }, [])).toEqual(negative.recorded)
})
