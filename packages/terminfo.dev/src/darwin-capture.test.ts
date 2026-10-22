/**
 * @failure A screenshot targets the wrong app, has scaled pixels, or loses the command evidence when no PNG appears.
 * @level l1
 * @consumer createDarwinCapture ownership, scale and attributed acquisition failures
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"
import * as captureCore from "./capture-core.ts"
import { censusDarwinWindows, createDarwinCapture, requireDarwinScale } from "./darwin-capture.ts"

const PNG_STUB = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
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
    disposition: "selected",
  })
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
  const decoder = vi.spyOn(captureCore, "decodeCapture").mockImplementation(async ({ source }) => ({
    width: source.width,
    height: source.height,
    rgba: Buffer.alloc(source.width * source.height * 4),
  }))
  const runner = vi
    .spyOn(captureCore, "command")
    .mockImplementation(async (file, args, _input, _deadline, onStderr) => {
      if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([own]))
      if (file === "magick") return Buffer.from(args[0] === "-version" ? "test converter" : "1000x677")
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
    const adapter = await createDarwinCapture(directory, { appPid: 41 })
    const { result } = await adapter.captureRaw({
      featureId: "extensions.truecolor",
      role: "control",
      label: "diagnostic",
    })
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
        if (file === "magick" && args[0] === "-version") return Buffer.from("test converter")
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
      const adapter = await createDarwinCapture(directory, { appPid: 41 })
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
  const decodes: Array<{ featureId: string; deadline?: number }> = []
  const decoder = vi.spyOn(captureCore, "decodeCapture").mockImplementation(async ({ source, featureId, deadline }) => {
    decodes.push({ featureId, deadline })
    return { width: source.width, height: source.height, rgba: Buffer.alloc(source.width * source.height * 4) }
  })
  const runner = vi.spyOn(captureCore, "command").mockImplementation(async (file, args, _input, deadline) => {
    if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([own]))
    if (file === "/usr/sbin/screencapture") {
      writeFileSync(args.at(-1)!, PNG_STUB)
      return Buffer.alloc(0)
    }
    if (file !== "magick") throw new Error(`Unexpected command ${file}`)
    if (args[0] === "-version") return Buffer.from("test converter")
    return Buffer.from(`${own.bounds.width}x${own.bounds.height}`)
  })
  try {
    const adapter = await createDarwinCapture(directory, { appPid: 41 })
    const deadline = Date.now() + 5_000
    const { decoded, result } = await adapter.captureRaw(
      { featureId: "extensions.truecolor", role: "control", label: "diagnostic" },
      deadline,
    )
    expect(decodes).toEqual([{ featureId: "extensions.truecolor", deadline }])
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
