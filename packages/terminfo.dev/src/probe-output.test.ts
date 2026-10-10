/**
 * @failure --output probes through a fresh /dev/tty, so the owned-terminal arm cannot bind the
 *   output stream to fd0 and the ps tty on Darwin (#28553).
 * @level l2
 * @consumer probeOutputStream in the terminfo CLI test command
 * @testonly none
 */
import { describe, expect, it, vi } from "vitest"
import { probeOutputStream } from "./probe-output.ts"

const ttyStdout = () => ({ isTTY: true, fd: 1 }) as unknown as NodeJS.WriteStream
const pipedStdout = () => ({ isTTY: false, fd: 1 }) as unknown as NodeJS.WriteStream
const openedStream = (fd: number) => ({ fd, isTTY: true }) as unknown as NodeJS.WriteStream

describe("probeOutputStream — the collector's probe terminal (#28553)", () => {
  it("uses this process's own stdout when --output owns the JSON and stdout is a terminal", () => {
    const stdout = ttyStdout()
    const opener = vi.fn(() => openedStream(3))
    const out = probeOutputStream({ output: "/tmp/run.json" }, { stdout, openControllingTerminal: opener })

    expect(opener).not.toHaveBeenCalled()
    expect(out).toBe(stdout)
    // The arm's selectedFd refuses a stream with no numeric fd; the process's own stdout has one.
    expect(typeof (out as { fd?: unknown } | undefined)?.fd).toBe("number")
  })

  it("falls back to the controlling terminal when --output is given but stdout is not a terminal", () => {
    const opener = vi.fn(() => openedStream(3))
    const out = probeOutputStream(
      { output: "/tmp/run.json" },
      { stdout: pipedStdout(), openControllingTerminal: opener },
    )

    expect(opener).toHaveBeenCalledTimes(1)
    expect(out).toBe(opener.mock.results[0]!.value)
  })

  it("--json keeps the controlling terminal because stdout carries the JSON", () => {
    const opener = vi.fn(() => openedStream(4))
    const out = probeOutputStream({ json: true }, { stdout: ttyStdout(), openControllingTerminal: opener })

    expect(opener).toHaveBeenCalledTimes(1)
    expect(out).toBe(opener.mock.results[0]!.value)
  })

  it("returns undefined for a plain test run, so the collector's own stdout default applies", () => {
    const opener = vi.fn(() => openedStream(5))
    const out = probeOutputStream({}, { stdout: ttyStdout(), openControllingTerminal: opener })

    expect(opener).not.toHaveBeenCalled()
    expect(out).toBeUndefined()
  })
})
