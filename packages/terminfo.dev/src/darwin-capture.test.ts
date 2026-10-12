/**
 * @failure A screenshot targets the wrong app, has scaled pixels, or loses the command evidence when no PNG appears.
 * @level l1
 * @consumer createDarwinCapture ownership, scale and attributed acquisition failures
 * @testonly none
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"
import * as captureCore from "./capture-core.ts"
import { createDarwinCapture, selectDarwinWindow, requireDarwinScale } from "./darwin-capture.ts"

test("Darwin capture admits exactly one measured app window and scale one", () => {
  const own = { id: 7, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 80, height: 63 } }
  expect(selectDarwinWindow([own, { ...own, id: 8, ownerPid: 99 }], 41)).toEqual(own)
  expect(() => requireDarwinScale(own, { width: 80, height: 63 })).not.toThrow()
  for (const rows of [[], [{ ...own, ownerPid: 99 }], [own, { ...own, id: 8 }]]) {
    expect(() => selectDarwinWindow(rows, 41)).toThrow(/owned.*window/i)
  }
  expect(() => requireDarwinScale(own, { width: 160, height: 126 })).toThrow(/scale 1/)
})

// Selection tests cannot observe a successful command that creates no file. Exercise the actual
// adapter acquisition and filesystem read; the shared core owns real subprocess stderr transport.
test.each(["command failure", "missing output"])(
  "Darwin capture attributes %s to exact command output",
  async (failure) => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-diagnostic-"))
    const own = { id: 7, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 80, height: 63 } }
    let captureArgs: string[] = []
    const runner = vi
      .spyOn(captureCore, "command")
      .mockImplementation(async (file, args, _input, _deadline, onStderr) => {
        if (file === "/usr/bin/osascript") return Buffer.from(JSON.stringify([own]))
        if (file === "magick" && args[0] === "-version") return Buffer.from("test converter")
        if (file !== "/usr/sbin/screencapture") throw new Error(`Unexpected diagnostic command ${file}`)
        captureArgs = args
        onStderr?.(Buffer.from("actual stderr"))
        if (failure === "command failure") throw new Error("command exited 1")
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
      const details = JSON.parse(error.message.slice(error.message.indexOf("{")))
      expect(details).toMatchObject({
        file: "/usr/sbin/screencapture",
        args: captureArgs,
        outputPath: captureArgs.at(-1),
        stdout: failure === "command failure" ? null : "actual stdout",
        stderr: "actual stderr",
      })
      expect(error.cause).toBeInstanceOf(Error)
    } finally {
      runner.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
