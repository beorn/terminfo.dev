/**
 * @failure TTY replies can be lost before listening or attributed to the wrong query.
 * @level l2
 * @consumer Real-terminal probe runner
 * @testonly none
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  drainStdin,
  measureRenderedWidth,
  query,
  queryMode,
  queryOutcome,
  queryWithSentinel,
  queryWithSentinelOutcome,
  withRawMode,
  withTTYOperation,
} from "./tty.ts"

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
  it("restores an untouched input stream after draining, including errors and nested leases", async () => {
    const stdin = process.stdin
    const originalTTY = Object.getOwnPropertyDescriptor(stdin, "isTTY")
    const originalFlowing = Object.getOwnPropertyDescriptor(stdin, "readableFlowing")
    const originalRawMode = Object.getOwnPropertyDescriptor(stdin, "setRawMode")
    let flowing: boolean | null = null
    Object.defineProperty(stdin, "isTTY", { configurable: true, value: true })
    Object.defineProperty(stdin, "readableFlowing", { configurable: true, get: () => flowing })
    Object.defineProperty(stdin, "setRawMode", { configurable: true, value: vi.fn() })
    const resume = vi.spyOn(stdin, "resume").mockImplementation(() => {
      flowing = true
      return stdin
    })
    const pause = vi.spyOn(stdin, "pause").mockImplementation(() => {
      flowing = false
      return stdin
    })
    const isPaused = vi.spyOn(stdin, "isPaused").mockReturnValue(false)
    try {
      await withRawMode(async () => {
        await drainStdin(1)
        expect(flowing).toBe(true)
      })
      expect(flowing).toBe(false)
      expect(pause).toHaveBeenCalledOnce()

      flowing = true
      pause.mockClear()
      await withRawMode(async () => {
        await drainStdin(1)
      })
      expect(flowing).toBe(true)
      expect(pause).not.toHaveBeenCalled()

      flowing = false
      await expect(
        withRawMode(async () => {
          throw new Error("probe failed")
        }),
      ).rejects.toThrow("probe failed")
      expect(flowing).toBe(false)
      expect(pause).toHaveBeenCalledOnce()

      flowing = null
      pause.mockClear()
      await withRawMode(async () => {
        await withRawMode(async () => {
          expect(flowing).toBe(true)
        })
        expect(flowing).toBe(true)
      })
      expect(flowing).toBe(false)
      expect(pause).toHaveBeenCalledOnce()
    } finally {
      resume.mockRestore()
      pause.mockRestore()
      isPaused.mockRestore()
      for (const [name, original] of [
        ["isTTY", originalTTY],
        ["readableFlowing", originalFlowing],
        ["setRawMode", originalRawMode],
      ] as const) {
        if (original) Object.defineProperty(stdin, name, original)
        else Reflect.deleteProperty(stdin, name)
      }
    }
  })

  it("has its listener ready before a synchronous terminal reply", async () => {
    process.stdout.write = (() => {
      reply("\x1b[12;34R")
      return true
    }) as typeof process.stdout.write
    expect(await query("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).toMatchObject(["\x1b[12;34R", "12", "34"])
  })

  it("retains exact synchronous reply bytes across UTF-8 chunk boundaries", async () => {
    const chunks = [Buffer.from([0xff, 0xc3]), Buffer.from([0xa9, ...Buffer.from("\x1b[12;34R")])]
    process.stdout.write = (() => {
      for (const chunk of chunks) process.stdin.emit("data", chunk)
      return true
    }) as typeof process.stdout.write
    const outcome = await queryOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)
    expect(outcome).toEqual({
      match: ["\x1b[12;34R", "12", "34"],
      reason: "reply",
      raw: "\uFFFDé\x1b[12;34R",
      rawBase64: Buffer.concat(chunks).toString("base64"),
    })
  })

  it("distinguishes a synchronous sentinel-only reply from a true timeout with retained bytes", async () => {
    const sentinelBytes = Buffer.from([0xff, ...Buffer.from("\x1b[?1;2c")])
    process.stdout.write = (() => {
      process.stdin.emit("data", sentinelBytes)
      return true
    }) as typeof process.stdout.write
    expect(await queryWithSentinelOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).toEqual({
      match: null,
      reason: "sentinel",
      raw: "\uFFFD\x1b[?1;2c",
      rawBase64: sentinelBytes.toString("base64"),
    })

    const timeoutBytes = Buffer.from("\x1b]unrelated")
    process.stdout.write = (() => {
      process.stdin.emit("data", timeoutBytes)
      return true
    }) as typeof process.stdout.write
    expect(await queryWithSentinelOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).toEqual({
      match: null,
      reason: "timeout",
      raw: "\x1b]unrelated",
      rawBase64: timeoutBytes.toString("base64"),
    })
  })

  it("removes the listener after a write error and admits the next query", async () => {
    const listenersBefore = process.stdin.listenerCount("data")
    process.stdout.write = (() => {
      throw new Error("write failed")
    }) as typeof process.stdout.write
    await expect(queryOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).rejects.toThrow("write failed")
    expect(process.stdin.listenerCount("data")).toBe(listenersBefore)
    process.stdout.write = (() => {
      reply("\x1b[1;1R")
      return true
    }) as typeof process.stdout.write
    expect((await queryOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).reason).toBe("reply")
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

  it("queues a delayed child query after its original operation has ended", async () => {
    const writes: string[] = []
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk)
      if (chunk === "\x1b[6n") reply("\x1b[1;1R")
      return true
    }) as typeof process.stdout.write
    let timerFired!: () => void
    const started = new Promise<void>((resolve) => {
      timerFired = resolve
    })
    let queryFinished!: (match: string[] | null) => void
    const delayed = new Promise<string[] | null>((resolve) => {
      queryFinished = resolve
    })
    await withRawMode(async () => {
      setTimeout(() => {
        timerFired()
        void query("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20).then(queryFinished)
      }, 0)
    })
    let releaseHold!: () => void
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve
    })
    const second = withRawMode(async () => {
      writes.push("hold-start")
      await hold
      writes.push("hold-end")
    })
    await started
    expect(writes).toEqual(["hold-start"])
    releaseHold()
    await second
    expect(await delayed).toBeTruthy()
    expect(writes).toEqual(["hold-start", "hold-end", "\x1b[6n"])
  })

  it("routes nested query, sentinel, and width traffic through one injected TTY", async () => {
    const writes: string[] = []
    const out = {
      columns: 12,
      write(chunk: string) {
        writes.push(chunk)
        if (chunk === "\x1b[6n") reply("\x1b[1;3R")
        if (chunk === "\x1b[?2026$p\x1b[c") reply("\x1b[?2026;1$y\x1b[?62;4c")
        return true
      },
    } as unknown as NodeJS.WriteStream
    process.stdout.write = (() => {
      throw new Error("controls reached stdout")
    }) as typeof process.stdout.write

    await withTTYOperation(async () => {
      expect((await queryOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).reason).toBe("reply")
      expect((await queryWithSentinelOutcome("\x1b[?2026$p", /\x1b\[\?2026;([0-4])\$y/, 20)).reason).toBe("reply")
      expect(await measureRenderedWidth("界")).toBe(2)
    }, out)
    expect(writes).toEqual(["\x1b[6n", "\x1b[?2026$p\x1b[c", "\x1b7\x1b[1G界", "\x1b[6n", "\x1b8"])
  })

  it("releases an injected stream after an error so a later default query uses stdout", async () => {
    const injectedWrites: string[] = []
    const out = {
      columns: 12,
      write(chunk: string) {
        injectedWrites.push(chunk)
        return true
      },
    } as unknown as NodeJS.WriteStream
    await expect(
      withTTYOperation(async () => {
        throw new Error("probe failed")
      }, out),
    ).rejects.toThrow("probe failed")
    const defaultWrites: string[] = []
    process.stdout.write = ((chunk: string) => {
      defaultWrites.push(chunk)
      reply("\x1b[2;4R")
      return true
    }) as typeof process.stdout.write
    expect(await query("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).toMatchObject(["\x1b[2;4R", "2", "4"])
    expect(injectedWrites).toEqual([])
    expect(defaultWrites).toEqual(["\x1b[6n"])
  })
})
