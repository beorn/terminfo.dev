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
  readResponse,
  sentinelGraceMs,
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

  it("captures stdin emitted during inject, which inject-then-listen would drop", async () => {
    expect(await readResponse(/^a/, 50, async () => reply("a"))).toEqual(["a"])
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
    const sentinel = await queryWithSentinelOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)
    expect(sentinel).toMatchObject({
      match: null,
      reason: "sentinel",
      raw: "\uFFFD\x1b[?1;2c",
      rawBase64: sentinelBytes.toString("base64"),
    })
    expect(sentinel.sentinel?.graceMs).toBe(250)
    expect(sentinel.sentinel?.atMs).toBeGreaterThanOrEqual(0)

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

  it("grades a reply that arrives after the DA1 sentinel by the reply, and marks it late", async () => {
    const bytes = "\x1b[?1;2c\x1b[12;34R"
    process.stdout.write = (() => {
      reply(bytes)
      return true
    }) as typeof process.stdout.write
    const outcome = await queryWithSentinelOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)
    expect(outcome).toMatchObject({
      match: ["\x1b[12;34R", "12", "34"],
      reason: "reply",
      raw: bytes,
      rawBase64: Buffer.from(bytes).toString("base64"),
    })
    expect(outcome.sentinel?.graceMs).toBe(250)
    expect(await queryWithSentinel("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 20)).toMatchObject(["\x1b[12;34R", "12", "34"])
  })

  it("keeps reading through the grace window after the sentinel and grades a reply that lands in it", async () => {
    process.stdout.write = (() => {
      reply("\x1b[?1;2c")
      setTimeout(() => reply("\x1b[12;34R"), 30)
      return true
    }) as typeof process.stdout.write
    expect(await queryWithSentinelOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 1000, 200)).toMatchObject({
      match: ["\x1b[12;34R", "12", "34"],
      reason: "reply",
      sentinel: { graceMs: 200 },
    })
  })

  it("calls a sentinel-only read silent only after the grace window, and stops reading there", async () => {
    const listenersBefore = process.stdin.listenerCount("data")
    process.stdout.write = (() => {
      reply("\x1b[?1;2c")
      return true
    }) as typeof process.stdout.write
    const started = Date.now()
    expect(await queryWithSentinelOutcome("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 1000, 60)).toMatchObject({
      match: null,
      reason: "sentinel",
      raw: "\x1b[?1;2c",
      sentinel: { graceMs: 60 },
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
    expect(process.stdin.listenerCount("data")).toBe(listenersBefore)
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
    const cursorReplies = ["\x1b[1;3R", "\x1b[2;1R", "\x1b[1;2R", "\x1b[1;3R", "\x1b[1;4R"]
    const out = {
      columns: 12,
      write(chunk: string) {
        writes.push(chunk)
        if (chunk === "\x1b[6n") reply(cursorReplies.shift() ?? "")
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
    expect(cursorReplies).toEqual([])
    expect(writes).toEqual([
      "\x1b[6n",
      "\x1b[?2026$p\x1b[c",
      "\x1b7",
      "\x1b[2;1H",
      "\x1b[6n",
      "\x1b[1;1HA",
      "\x1b[6n",
      "\x1b[1;1H界",
      "\x1b[6n",
      "A",
      "\x1b[6n",
      "\x1b8",
    ])
  })

  it("declines a wrapped sample even when its final column resembles a valid width", async () => {
    const writes: string[] = []
    let lastControl = ""
    const out = {
      columns: 12,
      write(chunk: string) {
        writes.push(chunk)
        if (chunk !== "\x1b[6n") lastControl = chunk
        else if (lastControl === "\x1b[2;1H") reply("\x1b[2;1R")
        else if (lastControl === "\x1b[1;1HA") reply("\x1b[1;2R")
        else reply("\x1b[2;3R")
        return true
      },
    } as unknown as NodeJS.WriteStream
    expect(await withTTYOperation(() => measureRenderedWidth("界"), out)).toBeNull()
    expect(writes.at(-1)).toBe("\x1b8")
  })

  it("declines a sample at the last column when its pending wrap mimics a narrower width", async () => {
    const writes: string[] = []
    let lastControl = ""
    const out = {
      columns: 3,
      write(chunk: string) {
        writes.push(chunk)
        if (chunk !== "\x1b[6n") lastControl = chunk
        else if (lastControl === "\x1b[2;1H") reply("\x1b[2;1R")
        else if (lastControl === "\x1b[1;1HA") reply("\x1b[1;2R")
        else if (lastControl === "A") reply("\x1b[2;2R")
        else reply("\x1b[1;3R")
        return true
      },
    } as unknown as NodeJS.WriteStream
    expect(await withTTYOperation(() => measureRenderedWidth("界"), out)).toBeNull()
    expect(writes.at(-1)).toBe("\x1b8")
  })

  it("restores cursor and declines a width when the setup grid cannot be verified", async () => {
    const writes: string[] = []
    const out = {
      write(chunk: string) {
        writes.push(chunk)
        if (chunk === "\x1b[6n") reply("\x1b[1;1R")
        return true
      },
    } as unknown as NodeJS.WriteStream
    expect(await withTTYOperation(() => measureRenderedWidth("界"), out)).toBeNull()
    expect(writes).toEqual(["\x1b7", "\x1b[2;1H", "\x1b[6n", "\x1b8"])
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

/** The window is a measured value, so widening it is explicit and a typo must never be silent. */
describe("sentinel grace override", () => {
  it("keeps the floor when unset or empty, honours a whole count, and refuses anything else", () => {
    expect(sentinelGraceMs(undefined)).toBe(250)
    expect(sentinelGraceMs("")).toBe(250)
    expect(sentinelGraceMs("1000")).toBe(1000)
    expect(() => sentinelGraceMs("1s")).toThrow(/whole number of milliseconds/)
    expect(() => sentinelGraceMs("-5")).toThrow(/whole number of milliseconds/)
    expect(() => sentinelGraceMs("0")).toThrow(/positive whole number/)
    expect(() => sentinelGraceMs("1.5")).toThrow(/whole number of milliseconds/)
    expect(() => sentinelGraceMs("9007199254740993")).toThrow(/positive whole number/)
  })
})
