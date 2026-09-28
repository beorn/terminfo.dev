/**
 * @failure TTY replies can be lost before listening or attributed to the wrong query.
 * @level l2
 * @consumer Real-terminal probe runner
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { query, queryMode, queryWithSentinel, withRawMode } from "./tty.ts"

const originalWrite = process.stdout.write

afterEach(() => {
  process.stdout.write = originalWrite
  process.stdin.removeAllListeners("data")
  vi.restoreAllMocks()
})

function reply(bytes: string) {
  process.stdin.emit("data", Buffer.from(bytes))
}

describe("TTY transaction replies", () => {
  it("has its listener ready before a synchronous terminal reply", async () => {
    process.stdout.write = (() => {
      reply("\x1b[12;34R")
      return true
    }) as typeof process.stdout.write
    expect(await query("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).toMatchObject(["\x1b[12;34R", "12", "34"])
  })

  it("ignores a late reply for another mode and retains permanent mode states", async () => {
    process.stdout.write = (() => {
      reply("\x1b[?7;1$y\x1b[?2026;3$y\x1b[?1;4$y\x1b[?1;2c")
      return true
    }) as typeof process.stdout.write
    expect(await queryMode(2026)).toBe("set")
  })

  it("does not count DA1 before the expected reply as support", async () => {
    process.stdout.write = (() => {
      reply("\x1b[?1;2c\x1b[12;34R")
      return true
    }) as typeof process.stdout.write
    expect(await queryWithSentinel("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).toBeNull()
  })

  it("can query DA1 itself without mistaking its answer for the sentinel", async () => {
    process.stdout.write = (() => {
      reply("\x1b[?62;4c")
      return true
    }) as typeof process.stdout.write
    expect(await queryWithSentinel("\x1b[c", /\x1b\[\?([0-9;]+)c/, 20)).toMatchObject(["\x1b[?62;4c", "62;4"])
  })

  it("releases the TTY queue when an operation throws", async () => {
    await expect(
      withRawMode(async () => {
        throw new Error("probe failed")
      }),
    ).rejects.toThrow("probe failed")
    await expect(withRawMode(async () => "next probe")).resolves.toBe("next probe")
  })

  it("serializes whole operations without letting nested queries deadlock", async () => {
    const writes: string[] = []
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk)
      if (chunk === "\x1b[6n") reply("\x1b[1;1R")
      return true
    }) as typeof process.stdout.write
    let releaseFirst!: () => void
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = withRawMode(async () => {
      writes.push("first-start")
      await hold
      expect(await query("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).toBeTruthy()
      writes.push("first-end")
    })
    const second = withRawMode(async () => {
      writes.push("second")
    })
    await Promise.resolve()
    releaseFirst()
    await Promise.all([first, second])
    expect(writes).toEqual(["first-start", "\x1b[6n", "first-end", "second"])
  })
})
