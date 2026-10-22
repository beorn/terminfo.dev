/**
 * @failure A Darwin kernel path read is silent: off-platform or unanswered reads read as "no path", or a
 *          refused read is reported as a measured absence, so a renamed process is admitted on argv0.
 * @level l1
 * @consumer The Screen arm's kernel-executable evidence (#30518), before any uid-0 hop can admit.
 * @testonly none
 * @reach fs-walk <fixture-only: reads its own pid and the platform, never a source tree>
 */
import { expect, test } from "vitest"
import { kernelExecPath } from "./darwin-kernel-exec.ts"

// #30518 A3: off Darwin there is no kernel path read, and the answer says so. It is never a silent
// "no path", because a caller that cannot tell "not measured" from "measured nothing" admits on argv0.
test.skipIf(process.platform === "darwin")("the kernel reader names the platform away from Darwin", () => {
  const read = kernelExecPath(process.pid)
  expect(read).toEqual({ path: null, reader: null, error: "not darwin; no kernel path read", attempts: [] })
})

test("a pid that is not a live pid is named, never read as a missing path", () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    const read = kernelExecPath(pid)
    expect(read.path).toBeNull()
    expect(read.error).toBe(`pid ${String(pid)} is not a live pid`)
    expect(read.attempts).toEqual([])
  }
})

test.runIf(process.platform === "darwin")("on Darwin the reader answers with the reader that produced the path", () => {
  const read = kernelExecPath(process.pid)
  expect(read.path).toMatch(/^\//)
  expect(["proc_pidpath", "KERN_PROCARGS2"]).toContain(read.reader)
  expect(read.attempts.length).toBeGreaterThan(0)
  expect(read.attempts.at(-1)?.error).toBeNull()
})
