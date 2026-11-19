/**
 * @failure A screenshot targets the wrong app, has scaled pixels, or loses the command evidence when no PNG appears.
 * @level l1
 * @consumer createDarwinCapture ownership, scale and attributed acquisition failures
 * @testonly none
 * @reach fs-walk <fixture-only: inspect only the owned temporary capture output directory>
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import * as captureCore from "./capture-core.ts"
import { censusDarwinWindows, createDarwinCapture, requireDarwinScale } from "./darwin-capture.ts"

import { readTerminalLaunchWindowId } from "./owned-terminal.ts"

const PNG_STUB = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])

// The converter owner runs magick inside capture-core, where a `command` stub cannot reach: these
// adapter cases stub the owner's two entry points instead. The owner's own processes are pinned by
// capture-core.test.ts and the real-ImageMagick case in linux-capture.test.ts (#34549).
beforeEach(() => {
  vi.spyOn(captureCore, "converterIdentity").mockResolvedValue("test converter")
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** The owner, answering a black frame of the given size and retaining the input bytes. */
function convertsTo(width: number, height: number) {
  return vi.spyOn(captureCore, "convertCapture").mockImplementation(async (input) => ({
    png: input.bytes,
    frame: { width, height, rgba: Buffer.alloc(width * height * 4) },
  }))
}
/** The capture target alone, as the selection tests read it. */
const selectDarwinWindow = (rows: unknown, appPid: number) => censusDarwinWindows(rows, appPid).selected.window

test("Darwin capture admits exactly one measured app window and scale one", () => {
  const own = { id: 7, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 80, height: 63 } }
  expect(selectDarwinWindow([own, { ...own, id: 8, ownerPid: 99 }], 41)).toEqual(own)
  expect(() => requireDarwinScale(own, { width: 80, height: 63 })).not.toThrow()
  for (const rows of [[], [{ ...own, ownerPid: 99 }], [own, { ...own, id: 8 }]]) {
    expect(() => selectDarwinWindow(rows, 41)).toThrow(/owned.*window/i)
  }
  expect(() => requireDarwinScale(own, { width: 160, height: 126 })).toThrow(/scale 1/)
})

// 30390: an app that keeps several layer-0 windows (cmux keeps two or three) measures its largest
// onscreen opaque one; an offscreen or fully transparent window and another app's window never compete.
test("Darwin capture selects the largest onscreen opaque layer-0 window among several owned windows", () => {
  const main = { id: 7, ownerPid: 41, layer: 0, bounds: { x: 12, y: 31, width: 1000, height: 677 } }
  const rows = [
    { id: 8, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 300, height: 200 }, alpha: 1, onscreen: true },
    { id: 9, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 2000, height: 2000 }, alpha: 1, onscreen: false },
    { ...main, alpha: 1, onscreen: true },
    { id: 10, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 3000, height: 3000 }, alpha: 0, onscreen: true },
    { id: 11, ownerPid: 41, layer: 25, bounds: { x: 0, y: 0, width: 4000, height: 4000 }, alpha: 1, onscreen: true },
    { id: 12, ownerPid: 99, layer: 0, bounds: { x: 0, y: 0, width: 5000, height: 5000 }, alpha: 1, onscreen: true },
  ]
  expect(selectDarwinWindow(rows, 41)).toEqual(main)
  const twin = { ...main, id: 13, alpha: 1, onscreen: true }
  expect(() => selectDarwinWindow([{ ...main, alpha: 1, onscreen: true }, twin], 41)).toThrow(
    /owned visible window.*sharing the largest area/i,
  )
  expect(() =>
    selectDarwinWindow(
      rows.filter((row) => row.id !== 7 && row.id !== 8),
      41,
    ),
  ).toThrow(/owned visible window.*found 0 candidates/i)
})

// 30685: a frame proves it shows the terminal only when the run names the app's other owned windows and
// why each was passed over; the census returns that list beside the selection, largest first.
test("Darwin census retains every owned layer-0 window with its disposition", () => {
  const owned = (id: number, width: number, extra: Record<string, unknown> = {}) => ({
    id,
    ownerPid: 41,
    layer: 0,
    bounds: { x: 0, y: 0, width, height: 100 },
    alpha: 1,
    onscreen: true,
    sharingState: 1,
    memoryUsage: 2048,
    ...extra,
  })
  const rows = [
    owned(8, 300),
    owned(9, 2000, { onscreen: false }),
    owned(7, 1000),
    owned(10, 3000, { alpha: 0 }),
    owned(11, 4000, { layer: 25 }),
    owned(12, 5000, { ownerPid: 99 }),
  ]
  const census = censusDarwinWindows(rows, 41)
  expect(census.ownedWindows.map((row) => [row.window.id, row.disposition])).toEqual([
    [10, "transparent"],
    [9, "offscreen"],
    [7, "selected"],
    [8, "smaller"],
  ])
  expect(census.ownedWindows[2]).toBe(census.selected)
  expect(census.selected).toEqual({
    window: { id: 7, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 1000, height: 100 } },
    alpha: 1,
    onscreen: true,
    sharingState: 1,
    memoryUsage: 2048,
    name: { present: false, value: null },
    disposition: "selected",
  })
})

// 33821: the hosted title reader. A window name is present in the same census that proves window
// identity, so the three shapes it can arrive in must stay distinguishable: a real title, a real
// empty title, and a key the window server withheld (which is never a title and is what the hosted
// run must refuse by name instead of falling back to AppleScript).
test("Darwin census reports the window name and whether the key was there at all", () => {
  const row = (id: number, extra: Record<string, unknown>) => ({
    id,
    ownerPid: 41,
    layer: 0,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    alpha: 1,
    onscreen: true,
    ...extra,
  })
  const name = (extra: Record<string, unknown>) => censusDarwinWindows([row(7, extra)], 41).selected.name
  expect(name({ namePresent: true, name: "~/hh — zsh" })).toEqual({ present: true, value: "~/hh — zsh" })
  expect(name({ namePresent: true, name: "" })).toEqual({ present: true, value: "" })
  expect(name({})).toEqual({ present: false, value: null })
})

test("a window name that is not a string is reported as withheld, not as a title", () => {
  const census = censusDarwinWindows(
    [
      {
        id: 7,
        ownerPid: 41,
        layer: 0,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        alpha: 1,
        onscreen: true,
        namePresent: true,
        name: null,
      },
    ],
    41,
  )
  expect(census.selected.name).toEqual({ present: true, value: null })
})

// 30390: the window server refuses an image of a window without a backing store; the same bounds are
// still on screen, so the frame comes from a region capture and the trace names both attempts.
test("Darwin capture falls back to a region capture of the window bounds when the window image is refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-region-"))
  const own = {
    id: 7,
    ownerPid: 41,
    layer: 0,
    bounds: { x: 12, y: 31, width: 1000, height: 677 },
    alpha: 1,
    onscreen: true,
  }
  const calls: string[][] = []
  const decoder = convertsTo(1000, 677)
  const runner = vi
    .spyOn(captureCore, "command")
    .mockImplementation(async (file, args, _input, _deadline, onStderr) => {
      if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([own]))
      if (file !== "/usr/sbin/screencapture") throw new Error(`Unexpected command ${file}`)
      calls.push(args)
      if (args[0] === "-l") {
        onStderr?.(Buffer.from("could not create image from window\n"))
        throw Object.assign(new Error("command exited 1"), {
          captureCommand: { file, args, stdoutBase64: "", stderrBase64: "", code: 1, signal: null, killed: false },
        })
      }
      writeFileSync(args.at(-1)!, PNG_STUB)
      return Buffer.alloc(0)
    })
  try {
    const adapter = await createDarwinCapture(directory, { appPid: 41, onRetained: () => {} })
    // #30392 C1/C3: the census taken at install is carried out of the adapter, and it is the same
    // census the first frame was taken against — the selected window by id and bounds, not a re-read.
    const { result } = await adapter.captureRaw({
      featureId: "extensions.truecolor",
      role: "control",
      label: "diagnostic",
    })
    expect(adapter.installCensus.window).toEqual({
      id: 7,
      ownerPid: 41,
      layer: 0,
      bounds: { x: 12, y: 31, width: 1000, height: 677 },
    })
    expect(adapter.installCensus.takenAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(adapter.installCensus.ownedWindows).toEqual((result.trace as { ownedWindows: unknown }).ownedWindows)
    expect(calls.map((args) => args.slice(0, -1))).toEqual([
      ["-l", "7", "-o", "-x", "-t", "png"],
      ["-x", "-R", "12,31,1000,677", "-t", "png"],
    ])
    expect(calls[1]?.at(-1)).not.toBe(calls[0]?.at(-1))
    expect(result.trace).toMatchObject({
      platform: "darwin",
      ownedWindows: [
        {
          window: { id: 7, ownerPid: 41, layer: 0, bounds: own.bounds },
          alpha: 1,
          onscreen: true,
          sharingState: null,
          memoryUsage: null,
          disposition: "selected",
        },
      ],
      measuredAppPid: 41,
      scale: 1,
      captureCommand: ["/usr/sbin/screencapture", "-x", "-R", "12,31,1000,677", "-t", "png"],
      refusedWindowCapture: {
        captureCommand: ["/usr/sbin/screencapture", "-l", "7", "-o", "-x", "-t", "png"],
        stderr: "could not create image from window\n",
      },
    })
    expect(result.frame.pixelsDigest).toBe(
      `sha256:${createHash("sha256")
        .update(Buffer.alloc(1000 * 677 * 4))
        .digest("hex")}`,
    )
    // One owner call per frame, with Darwin's explicit retention policy and no caller-supplied
    // extent: the owner measures the screenshot itself (#34549 amendments 1 and 2).
    expect(decoder.mock.calls.map(([input]) => ({ ...input, bytes: input.bytes.toString("hex") }))).toEqual([
      {
        bytes: PNG_STUB.toString("hex"),
        format: "png",
        retain: "original",
        featureId: "extensions.truecolor",
        deadline: undefined,
      },
    ])
    expect(typeof (result.trace as { convertMs?: unknown }).convertMs).toBe("number")
  } finally {
    decoder.mockRestore()
    runner.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

// #34892: the census and the restore confirmation own their budget. A paint deadline the cold first
// paint nearly exhausted used to be the budget the census got, so our own timer killed osascript and
// the record read as the app's SIGKILL in 71 rows of run 44267909484.
test("the window census and restore confirmation own their budget while the window image keeps the caller's deadline (34892)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-census-budget-"))
  const own = {
    id: 7,
    ownerPid: 41,
    layer: 0,
    bounds: { x: 0, y: 0, width: 80, height: 63 },
    alpha: 1,
    onscreen: true,
  }
  const calls: Array<{
    file: string
    deadline: number | undefined
    step: { step: string; budgetMs?: number } | undefined
  }> = []
  const decoder = convertsTo(80, 63)
  const runner = vi
    .spyOn(captureCore, "command")
    .mockImplementation(async (file, args, _input, deadline, _onStderr, _environment, step) => {
      calls.push({ file, deadline, step })
      if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([own]))
      if (file !== "/usr/sbin/screencapture") throw new Error(`Unexpected command ${file}`)
      writeFileSync(args.at(-1)!, PNG_STUB)
      return Buffer.alloc(0)
    })
  try {
    const adapter = await createDarwinCapture(directory, { appPid: 41, onRetained: () => {} })
    // The paint budget a cold first paint would leave behind: barely any time at all.
    const paintDeadline = Date.now() + 40
    const { result } = await adapter.captureRaw(
      { featureId: "extensions.truecolor", role: "control", label: "diagnostic" },
      paintDeadline,
    )
    expect(result.frame.pixelsDigest).toMatch(/^sha256:/)
    const censuses = calls.filter((call) => call.file === "/usr/bin/osascript")
    expect(censuses.map((call) => call.step?.step)).toEqual(["window census", "window census", "restore confirmation"])
    for (const call of censuses) {
      expect(call.step?.budgetMs).toBe(10_000)
      expect(call.deadline).toBeGreaterThanOrEqual(paintDeadline + 5_000)
    }
    // The image owns its own budget too (#35043): a paint deadline the census has already spent is
    // lifted to one measured from where the image runs, and the step names the budget it got.
    const shots = calls.filter((call) => call.file === "/usr/sbin/screencapture")
    expect(shots).toHaveLength(1)
    expect(shots[0]?.deadline).toBeGreaterThanOrEqual(paintDeadline + 5_000)
    expect(shots[0]?.step).toEqual({ step: "window image", budgetMs: 10_000 })
  } finally {
    decoder.mockRestore()
    runner.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

// #35043: a census that uses its own 10 s (#34892) leaves the paint deadline the caller passed in the
// past. The image that follows used to be handed that spent deadline, so `command` refused "deadline
// expired before invocation" before spawning and the collection died before grading a cell (run
// d28f90afe49aaa80a36cf3ad78781be3 and 1bae5ea901f4a926a8446125ed38873a, VS Code on macOS 26.7.3).
test("a census that outlives the paint deadline still leaves the window image a live budget (35043)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-image-budget-"))
  const own = {
    id: 7,
    ownerPid: 41,
    layer: 0,
    bounds: { x: 0, y: 0, width: 80, height: 63 },
    alpha: 1,
    onscreen: true,
  }
  const shots: Array<{ deadline: number | undefined }> = []
  const decoder = convertsTo(80, 63)
  const runner = vi
    .spyOn(captureCore, "command")
    .mockImplementation(async (file, args, _input, deadline, _onStderr, _environment, step) => {
      if (file === "/usr/bin/osascript") {
        // The census answers late enough to spend the caller's paint deadline, as a cold window
        // enumeration on a six-window app did in the live failure.
        await new Promise((resolve) => setTimeout(resolve, 60))
        return Buffer.from(JSON.stringify([own]))
      }
      if (file !== "/usr/sbin/screencapture") throw new Error(`Unexpected command ${file}`)
      expect(step?.step).toBe("window image")
      shots.push({ deadline })
      expect(deadline).toBeGreaterThan(Date.now())
      writeFileSync(args.at(-1)!, PNG_STUB)
      return Buffer.alloc(0)
    })
  try {
    const adapter = await createDarwinCapture(directory, { appPid: 41, onRetained: () => {} })
    const { result } = await adapter.captureRaw(
      { featureId: "extensions.truecolor", role: "control", label: "diagnostic" },
      Date.now() + 40,
    )
    expect(result.frame.pixelsDigest).toMatch(/^sha256:/)
    expect(shots).toHaveLength(1)
  } finally {
    decoder.mockRestore()
    runner.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

// 33587, @cto 730017b6: an owned Mac's console shows other people's apps, so a refused window image
// refuses by name there and no region of the screen is ever captured.
test("Darwin capture on an owned host refuses a refused window image instead of capturing a screen region", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-owned-"))
  const own = {
    id: 7,
    ownerPid: 41,
    layer: 0,
    bounds: { x: 12, y: 31, width: 1000, height: 677 },
    alpha: 1,
    onscreen: true,
  }
  const calls: string[][] = []
  const runner = vi
    .spyOn(captureCore, "command")
    .mockImplementation(async (file, args, _input, _deadline, onStderr) => {
      if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([own]))
      if (file !== "/usr/sbin/screencapture") throw new Error(`Unexpected command ${file}`)
      calls.push(args)
      if (args[0] === "-l") {
        onStderr?.(Buffer.from("could not create image from window\n"))
        throw Object.assign(new Error("command exited 1"), {
          captureCommand: { file, args, stdoutBase64: "", stderrBase64: "", code: 1, signal: null, killed: false },
        })
      }
      writeFileSync(args.at(-1)!, PNG_STUB)
      return Buffer.alloc(0)
    })
  try {
    const adapter = await createDarwinCapture(directory, { appPid: 41, ownedHost: true, onRetained: () => {} })
    await expect(
      adapter.captureRaw({ featureId: "extensions.truecolor", role: "control", label: "diagnostic" }),
    ).rejects.toThrow(/owned host never captures a screen region/)
    expect(calls.map((args) => args[0])).toEqual(["-l"])
  } finally {
    runner.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

// #33117: a checkpoint naming a same-shot control region still acquires exactly one screenshot;
// both region digests are crops of that one acquired image, never a second acquisition.
test("Darwin capture crops target and same-shot control from one acquired screenshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-same-shot-"))
  const own = {
    id: 7,
    ownerPid: 41,
    layer: 0,
    bounds: { x: 12, y: 31, width: 1000, height: 677 },
    alpha: 1,
    onscreen: true,
  }
  const screenshots: string[][] = []
  // The converter owner hands known pixels to the real finalizer, so the real crop code runs without
  // a real magick decode.
  const decoder = convertsTo(1000, 677)
  const runner = vi
    .spyOn(captureCore, "command")
    .mockImplementation(async (file, args, _input, _deadline, _onStderr) => {
      if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([own]))
      if (file !== "/usr/sbin/screencapture") throw new Error(`Unexpected command ${file}`)
      screenshots.push(args)
      writeFileSync(args.at(-1)!, PNG_STUB)
      return Buffer.alloc(0)
    })
  try {
    const adapter = await createDarwinCapture(directory, { appPid: 41, onRetained: () => {} })
    const { frame } = await adapter.capture(
      {
        featureId: "sgr.blink",
        role: "target",
        label: "styled row beside plain row",
        cells: { top: 3, left: 2, bottom: 3, right: 4 },
        controlCells: { top: 1, left: 2, bottom: 1, right: 4 },
        pixelGeometry: { cellWidth: 10, cellHeight: 10, textWidth: 1000, textHeight: 670 },
      },
      { origin: { x: 0, y: 0 }, basis: "measured fixture" },
    )
    expect(screenshots).toHaveLength(1)
    expect(frame.regionRectangle).toEqual({ x: 10, y: 20, width: 30, height: 10 })
    expect(frame.controlRegionRectangle).toEqual({ x: 10, y: 0, width: 30, height: 10 })
    expect(frame.regionDigest).toMatch(/^sha256:/)
    expect(frame.controlRegionDigest).toMatch(/^sha256:/)
  } finally {
    decoder.mockRestore()
    runner.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

// Selection tests cannot observe a successful command that creates no file. Exercise the actual
// adapter acquisition and filesystem read; the shared core owns real subprocess stderr transport.
// A refused window image is retried as a region capture, so "command failure" fails both attempts
// and the error carries both; a command that exits 0 without a file is not a refusal and is not retried.
test.each(["command failure", "missing output"])(
  "Darwin capture attributes %s to exact command output",
  async (failure) => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-diagnostic-"))
    const own = { id: 7, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 80, height: 63 } }
    const selected = { ...own, sharingState: 1, memoryUsage: 4096 }
    const preCapture = { ...own, sharingState: 0, memoryUsage: 0 }
    let censuses = 0
    const calls: string[][] = []
    const runner = vi
      .spyOn(captureCore, "command")
      .mockImplementation(async (file, args, _input, _deadline, onStderr) => {
        if (file === "/usr/bin/osascript") {
          return Buffer.from(JSON.stringify([censuses++ === 0 ? selected : preCapture]))
        }
        if (file !== "/usr/sbin/screencapture") throw new Error(`Unexpected diagnostic command ${file}`)
        calls.push(args)
        onStderr?.(Buffer.from("could not create image from window\n"))
        if (failure === "command failure") {
          throw Object.assign(new Error("command exited 1"), {
            captureCommand: {
              file,
              args,
              stdoutBase64: Buffer.from("failed stdout").toString("base64"),
              stderrBase64: Buffer.from("could not create image from window\n").toString("base64"),
              code: 1,
              signal: null,
              killed: false,
            },
          })
        }
        return Buffer.from("actual stdout")
      })
    try {
      const adapter = await createDarwinCapture(directory, { appPid: 41, onRetained: () => {} })
      // #30392 C1/C2: this fixture answers the install census and the pre-capture census differently,
      // so the recorded observations prove which read was kept; a refused capture adds no third read.
      expect(adapter.installCensus.observations).toEqual({
        sharingState: 1,
        memoryUsage: 4096,
        alpha: null,
        onscreen: null,
      })
      expect(censuses).toBe(1)
      let caught: unknown
      try {
        await adapter.captureRaw({ featureId: "extensions.truecolor", role: "control", label: "diagnostic" })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      const error = caught as Error
      expect(error.name).toBe(
        failure === "command failure" ? "DarwinCaptureCommandFailed" : "DarwinCaptureOutputMissing",
      )
      const captureArgs = calls.at(-1)!
      if (failure === "command failure") {
        expect(error.message).toMatch(/^Darwin window server refused .* region capture .* failed/)
        expect(calls.map((args) => args.slice(0, -1))).toEqual([
          ["-l", "7", "-o", "-x", "-t", "png"],
          ["-x", "-R", "0,0,80,63", "-t", "png"],
        ])
      } else {
        expect(error.message).toMatch(/^Darwin screenshot capture failed/)
        expect(calls.map((args) => args.slice(0, -1))).toEqual([["-l", "7", "-o", "-x", "-t", "png"]])
      }
      const details = JSON.parse(error.message.slice(error.message.indexOf("{"))) as Record<string, unknown>
      expect(details).toMatchObject({
        captureContext: {
          measuredAppPid: 41,
          selectedWindow: selected,
          preCaptureWindow: preCapture,
          ownedWindows: [{ window: own, sharingState: 0, memoryUsage: 0, disposition: "selected" }],
        },
        file: "/usr/sbin/screencapture",
        args: captureArgs,
        outputPath: captureArgs.at(-1),
        stdout: failure === "command failure" ? null : "actual stdout",
        stderr: "could not create image from window\n",
      })
      expect(error.cause).toBeInstanceOf(Error)
      if (failure === "command failure") {
        expect((error.cause as Error).message).toBe("command exited 1")
        expect(details.refusedWindowCapture).toMatchObject({
          file: "/usr/sbin/screencapture",
          args: calls[0],
          outputPath: calls[0]?.at(-1),
          stdout: null,
          stderr: "could not create image from window\n",
          cause: { message: "command exited 1" },
        })
        expect(error).toHaveProperty("captureCommand", {
          file: "/usr/sbin/screencapture",
          args: captureArgs,
          stdoutBase64: Buffer.from("failed stdout").toString("base64"),
          stderrBase64: Buffer.from("could not create image from window\n").toString("base64"),
          code: 1,
          signal: null,
          killed: false,
        })
      } else {
        expect(details).not.toHaveProperty("refusedWindowCapture")
        expect(error).not.toHaveProperty("captureCommand")
      }
    } finally {
      runner.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

// 30092 review round 1: raw calibration already decoded the frame, so finalization must reuse those
// pixels instead of decoding a second time outside the caller's deadline.
test("Darwin raw calibration decodes once and within the caller's deadline (30092)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-raw-"))
  const own = { id: 7, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 80, height: 63 } }
  const decoder = convertsTo(own.bounds.width, own.bounds.height)
  const runner = vi.spyOn(captureCore, "command").mockImplementation(async (file, args) => {
    if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([own]))
    if (file === "/usr/sbin/screencapture") {
      writeFileSync(args.at(-1)!, PNG_STUB)
      return Buffer.alloc(0)
    }
    throw new Error(`Unexpected command ${file}`)
  })
  try {
    const adapter = await createDarwinCapture(directory, { appPid: 41, onRetained: () => {} })
    const deadline = Date.now() + 5_000
    const { decoded, result } = await adapter.captureRaw(
      { featureId: "extensions.truecolor", role: "control", label: "diagnostic" },
      deadline,
    )
    expect(decoder.mock.calls.map(([{ featureId, deadline, retain }]) => ({ featureId, deadline, retain }))).toEqual([
      { featureId: "extensions.truecolor", deadline, retain: "original" },
    ])
    expect(decoded.width).toBe(own.bounds.width)
    expect(decoded.height).toBe(own.bounds.height)
    expect(result.trace).toMatchObject({
      captureCommand: ["/usr/sbin/screencapture", "-l", "7", "-o", "-x", "-t", "png"],
    })
    expect(result.trace).not.toHaveProperty("refusedWindowCapture")
    expect(result.frame.pixelsDigest).toBe(
      `sha256:${createHash("sha256")
        .update(Buffer.alloc(own.bounds.width * own.bounds.height * 4))
        .digest("hex")}`,
    )
  } finally {
    decoder.mockRestore()
    runner.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

// #34549 amendment 2: the owner measures the screenshot; the adapter still refuses a frame whose
// measured extent is not its window's point bounds, on both acquisition paths, and retains nothing.
test("Darwin capture still refuses a converted frame at another scale (34549)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-scale-"))
  const own = { id: 7, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 80, height: 63 } }
  const decoder = convertsTo(160, 126)
  const runner = vi.spyOn(captureCore, "command").mockImplementation(async (file, args) => {
    if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([own]))
    if (file === "/usr/sbin/screencapture") {
      writeFileSync(args.at(-1)!, PNG_STUB)
      return Buffer.alloc(0)
    }
    throw new Error(`Unexpected command ${file}`)
  })
  try {
    const adapter = await createDarwinCapture(directory, { appPid: 41, onRetained: () => {} })
    const checkpoint = { featureId: "extensions.truecolor", role: "control" as const, label: "retina" }
    await expect(adapter.captureRaw(checkpoint, Date.now() + 5_000)).rejects.toThrow(
      "Darwin capture requires scale 1: capture 160x126 differs from window point bounds 80x63",
    )
    await expect(adapter.capture(checkpoint, { origin: { x: 0, y: 0 }, basis: "fixture" })).rejects.toThrow(
      /requires scale 1/,
    )
    expect(decoder).toHaveBeenCalledTimes(2)
    expect(readdirSync(directory)).toEqual([])
  } finally {
    decoder.mockRestore()
    runner.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

// Approved Terminal.app repair 2026-11-08 (run 42560226484): a cold start's own startup window shares the
// launched window's area, so size alone refuses a run that is fine. The launch receipt names the exact
// window it created; the census selects that window and still refuses a tie when no id is known.
test("Darwin census selects the launch receipt's exact window id and refuses a tie without one", () => {
  const bounds = { x: 40, y: 51, width: 877, height: 499 }
  const launched = { id: 34, ownerPid: 41, layer: 0, bounds, alpha: 1, onscreen: true }
  const startup = { ...launched, id: 29 }
  expect(() => censusDarwinWindows([startup, launched], 41)).toThrow(/sharing the largest area/i)
  const census = censusDarwinWindows([startup, launched], 41, 34)
  expect(census.selected.window).toEqual({ id: 34, ownerPid: 41, layer: 0, bounds })
  expect(census.ownedWindows.map((row) => [row.window.id, row.disposition])).toEqual([
    [29, "rival"],
    [34, "selected"],
  ])
  // Newly routed PID-only apps must never select a rival by size. The legacy policy above remains.
  const larger = { ...startup, bounds: { ...bounds, width: 1000 } }
  expect(() => censusDarwinWindows([larger, launched], 41, undefined, "unique")).toThrow(/found 2 candidates/)
  expect(censusDarwinWindows([launched], 41, undefined, "unique").selected.window.id).toBe(34)
  expect(censusDarwinWindows([larger, launched], 41, 34, "unique").selected.window.id).toBe(34)
})

// The named id is a claim to check, never a bypass: a window that is offscreen, fully transparent, not
// layer 0 or owned by another process still refuses by name.
test("Darwin census refuses a named window it cannot prove owned, visible and layer 0", () => {
  const bounds = { x: 40, y: 51, width: 877, height: 499 }
  const launched = { id: 34, ownerPid: 41, layer: 0, bounds, alpha: 1, onscreen: true }
  const startup = { ...launched, id: 29 }
  expect(() => censusDarwinWindows([startup, { ...launched, onscreen: false }], 41, 34)).toThrow(/34/)
  expect(() => censusDarwinWindows([startup, { ...launched, alpha: 0 }], 41, 34)).toThrow(/34/)
  expect(() => censusDarwinWindows([startup, { ...launched, layer: 25 }], 41, 34)).toThrow(/34/)
  expect(() => censusDarwinWindows([startup, { ...launched, ownerPid: 99 }], 41, 34)).toThrow(/34/)
  expect(() => censusDarwinWindows([startup, launched], 41, 30)).toThrow(/30/)
})

// Run 42560226484: the workflow's launch receipt names the window it created (34). The receipt is the
// only honest source of that id on a hosted runner, so an absent or foreign record refuses by name
// instead of letting the census fall back to a window this run never launched.
test("Terminal.app launch receipt names the owned window id or refuses by name", async () => {
  // CTO boundary requirement: the shared reader must never interpret app-specific ownership files.
  const readerSource = readFileSync(new URL("./darwin-capture.ts", import.meta.url), "utf8")
  expect(readerSource).not.toMatch(/readTerminalLaunchWindowId|terminal-launch|hostedAppId|terminal-app/)
  const directory = mkdtempSync(join(tmpdir(), "terminal-launch-"))
  const record = join(directory, "terminal-launch.json")
  expect(() => readTerminalLaunchWindowId(directory)).toThrow(/launch receipt .*terminal-launch\.json/)
  writeFileSync(
    record,
    JSON.stringify({
      appId: "terminal-app",
      terminalWindow: { provider: "terminal-app", windowId: 34, tty: "/dev/ttys001" },
    }),
  )
  expect(readTerminalLaunchWindowId(directory)).toBe(34)
  for (const body of [
    JSON.stringify({ appId: "iterm2", terminalWindow: { provider: "terminal-app", windowId: 34 } }),
    JSON.stringify({ appId: "terminal-app", terminalWindow: { provider: "kitty", windowId: 34 } }),
    JSON.stringify({ appId: "terminal-app", terminalWindow: { provider: "terminal-app", windowId: 0 } }),
    JSON.stringify({ appId: "terminal-app" }),
  ]) {
    writeFileSync(record, body)
    expect(() => readTerminalLaunchWindowId(directory)).toThrow(/names no owned window id/)
  }
  writeFileSync(record, "not json")
  expect(() => readTerminalLaunchWindowId(directory)).toThrow(/is not JSON/)
})

// Ownership interprets the launch receipt; capture receives only its already verified numeric claim.
test("Darwin capture resolves a window tie through the ownership adapter's window claim", async () => {
  const artifacts = mkdtempSync(join(tmpdir(), "darwin-launch-receipt-"))
  const captureDirectory = join(artifacts, "artifacts")
  const bounds = { x: 40, y: 51, width: 877, height: 499 }
  const launched = { id: 34, ownerPid: 41, layer: 0, bounds, alpha: 1, onscreen: true }
  const startup = { ...launched, id: 29 }
  const runner = vi.spyOn(captureCore, "command").mockImplementation(async (file) => {
    if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([startup, launched]))
    throw new Error(`Unexpected command ${file}`)
  })
  try {
    expect(() => readTerminalLaunchWindowId(artifacts)).toThrow(/launch receipt .*terminal-launch\.json/)
    writeFileSync(
      join(artifacts, "terminal-launch.json"),
      JSON.stringify({
        appId: "terminal-app",
        terminalWindow: { provider: "terminal-app", windowId: 34, tty: "/dev/ttys001" },
      }),
    )
    const adapter = await createDarwinCapture(captureDirectory, {
      appPid: 41,
      expectedWindowId: readTerminalLaunchWindowId(artifacts),
      onRetained: () => {},
    })
    expect(adapter.installCensus.window).toEqual({ id: 34, ownerPid: 41, layer: 0, bounds })
    expect(adapter.installCensus.ownedWindows.map((row) => [row.window.id, row.disposition])).toEqual([
      [29, "rival"],
      [34, "selected"],
    ])
    // Every other app arm keeps selecting by size and needs no receipt at all.
    const sized = { ...launched, alpha: 1, onscreen: true, bounds: { x: 0, y: 0, width: 1000, height: 677 } }
    runner.mockImplementation(async (file) => {
      if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([startup, sized]))
      throw new Error(`Unexpected command ${file}`)
    })
    const otherAdapter = await createDarwinCapture(captureDirectory, {
      appPid: 41,
      windowSelection: "largest",
      onRetained: () => {},
    })
    expect(otherAdapter.installCensus.window.id).toBe(34)
  } finally {
    rmSync(artifacts, { recursive: true, force: true })
  }
})
