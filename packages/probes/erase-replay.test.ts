/**
 * @failure The real erase family omits observer calls or opens a backend while asserting a retained call log offline.
 * @level l2
 * @consumer Phase0 recorder runner for the eleven existing erase callbacks.
 * @reach captures real xterm.js once and executes the same family twice with native backend creation forbidden.
 * @testonly none
 */
import { expect, test, vi } from "vitest"
import * as xterm from "@termless/xtermjs"
import { readCallLog } from "viprobe"
import { captureEraseCalls, replayEraseCalls } from "./erase-replay.ts"

test("real erase calls replay twice without opening a terminal backend", () => {
  const captured = captureEraseCalls()
  expect(captured.results.map(({ featureId }) => featureId)).toEqual([
    "erase.character",
    "erase.line.right",
    "erase.line.left",
    "erase.line.all",
    "erase.screen.below",
    "erase.screen.above",
    "erase.screen.all",
    "erase.selective",
    "erase.ed-scroll-region",
    "erase.el-with-attrs",
    "erase.screen.scrollback",
  ])
  // Call-log canonicalization sorts object keys. Compare the structured diagnostic
  // evidence, not the incidental key order inside the legacy JSON strings.
  const evidence = (records: typeof captured.results) =>
    records.map(({ featureId, result }) => ({
      featureId,
      ...result,
      response: result.response === undefined ? undefined : JSON.parse(result.response),
      assertions: result.assertions?.map((assertion) => ({
        ...assertion,
        observed: JSON.parse(assertion.observed),
      })),
    }))
  expect(captured.results.at(-1)?.result.observation).toEqual({ outcome: "supported", assertionType: "buffer_state" })
  const bytes = JSON.stringify(captured.log)
  const paths: string[] = []
  readCallLog(JSON.parse(bytes), { onOperation: ({ path }) => paths.push(path) })
  for (const method of ["open", "getCell", "getCursor", "getScrollback", "feed", "close"]) {
    expect(
      paths.some((path) => path.endsWith("." + method)),
      method,
    ).toBe(true)
  }
  const open = vi.spyOn(xterm, "createXtermBackend").mockImplementation(() => {
    throw new Error("Offline erase replay opened a live backend")
  })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(evidence(replayEraseCalls(readCallLog(JSON.parse(bytes))))).toEqual(evidence(captured.results))
    }
    expect(open).not.toHaveBeenCalled()
  } finally {
    open.mockRestore()
  }
})
