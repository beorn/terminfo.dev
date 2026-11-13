import { createHash } from "node:crypto"
import type { ProbeCallbackResult } from "@terminfo/probe-defs"
import { expect, test } from "vitest"
import { createDarwinClipboardAdapter, type DarwinCommand } from "./darwin-clipboard.ts"

test("hosted Darwin pasteboard saves, writes, and restores through the owned transaction", async () => {
  let pasteboard = "baseline"
  const title = "Window"
  const run: DarwinCommand = async (file, args, stdin) => {
    if (file.endsWith("pbpaste")) return `${pasteboard}\n`
    if (file.endsWith("pbcopy")) {
      pasteboard = stdin ?? ""
      return ""
    }
    throw new Error(`unexpected ${file}`)
  }
  const adapter = await createDarwinClipboardAdapter({
    appComm: "iTerm2",
    appId: "iterm2",
    titleRead: "none",
    assertOwned: async () => {},
    run,
  })
  expect(adapter.config).toBe(null)
  await expect(adapter.readTitle()).rejects.toThrow(/System Events/)
  expect(title).toBe("Window")
  const result = await adapter.withClipboardFixture(
    async (fixture) => {
      expect(await fixture.readText()).toBe("baseline")
      await fixture.writeText("nonce")
      expect(await fixture.readText()).toBe("nonce")
      return { pass: true, note: "wrote" } as ProbeCallbackResult
    },
    () => {},
    async () => {},
  )
  expect(result.pass).toBe(true)
  expect(pasteboard).toBe("baseline")
})

// @cto 2026-11-13: codimac's pasteboard is the fleet's one global pasteboard. Its pre-existing
// contents are never read - not for a baseline, not to restore them - because reading is what would
// put them in an artifact. The run writes its own sentinel first and leaves the pasteboard empty.
test("an owned-host pasteboard is never read: the run writes its own sentinel first and empties it at dispose", async () => {
  const calls: string[] = []
  let pasteboard = "PRE-EXISTING SECRET"
  const run: DarwinCommand = async (file, args, stdin) => {
    if (file.endsWith("pbpaste")) {
      calls.push("pbpaste")
      return pasteboard + "\n"
    }
    if (file.endsWith("pbcopy")) {
      calls.push("pbcopy:" + (stdin ?? ""))
      pasteboard = stdin ?? ""
      return ""
    }
    throw new Error("unexpected " + file)
  }
  let owned = 0
  const adapter = await createDarwinClipboardAdapter({
    appComm: "Terminal",
    appId: "terminal-app",
    titleRead: "none",
    ownedHost: true,
    assertOwned: async () => {
      owned += 1
    },
    run,
  })
  expect(calls[0]).toMatch(/^pbcopy:terminfo owned pasteboard /)
  expect(calls.filter((call) => call === "pbpaste")).toHaveLength(0)
  expect(owned).toBe(1)
  await adapter.withClipboardFixture(
    async (fixture) => {
      expect(await fixture.readText()).toMatch(/^terminfo owned pasteboard /)
      await fixture.writeText("run value")
      expect(await fixture.readText()).toBe("run value")
      return { pass: true, note: "wrote" } as ProbeCallbackResult
    },
    () => {},
    async () => {},
  )
  expect(JSON.stringify(calls)).not.toContain("PRE-EXISTING")
  await adapter.dispose()
  expect(pasteboard).toBe("")
})

// @cto 1c7e19df on the owned host: foreign text can be a password or a one-time code, and the
// sha256 of a short value is a guessable fingerprint. The diagnostic keeps the length and drops it.
test("an owned host records the length of foreign text, never its digest", async () => {
  let pasteboard = ""
  const run: DarwinCommand = async (file, _args, stdin) => {
    if (file.endsWith("pbcopy")) {
      pasteboard = stdin ?? ""
      return ""
    }
    if (file.endsWith("pbpaste")) return pasteboard + "\n"
    throw new Error("unexpected " + file)
  }
  const adapter = await createDarwinClipboardAdapter({
    appComm: "Terminal",
    appId: "terminal-app",
    titleRead: "none",
    ownedHost: true,
    assertOwned: async () => {},
    run,
  })
  // Something else on the shared machine copies between our sentinel and the callback.
  pasteboard = "FOREIGN SECRET"
  const failure = await adapter
    .withClipboardFixture(
      async () => ({ pass: true, note: "never reached" }) as ProbeCallbackResult,
      () => {},
      async () => {},
    )
    .then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  expect(failure).toMatch(/baseline changed/)
  expect(failure).toMatch(/read length 14/)
  expect(failure).not.toMatch(/sha256/)
  expect(failure).not.toMatch(/[a-f0-9]{32}/)
})

// @dev/3 R2 at 2fe85988d106b: emptying the pasteboard is a write like any other. A run that has lost
// its window must leave the value it can no longer vouch for rather than empty someone else's.
test("an owned host whose window is gone clears nothing on dispose, and says so", async () => {
  const calls: { file: string; stdin: string | undefined }[] = []
  let owned = true
  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "))
  }
  try {
    const adapter = await createDarwinClipboardAdapter({
      appComm: "Terminal",
      appId: "terminal-app",
      titleRead: "none",
      ownedHost: true,
      assertOwned: async () => {
        if (!owned) throw new Error("owned Terminal window no longer exists uniquely")
      },
      run: async (file, _args, stdin) => {
        calls.push({ file, stdin })
        return ""
      },
    })
    // Construction wrote the sentinel while the window was still ours.
    expect(calls.filter((call) => call.file.endsWith("pbcopy"))).toHaveLength(1)
    owned = false
    const before = calls.length
    await adapter.dispose()
    expect(calls.slice(before)).toEqual([])
    expect(errors.join("\n")).toContain("not cleared")
    expect(errors.join("\n")).toContain("owned Terminal window no longer exists uniquely")
  } finally {
    console.error = originalError
  }
})

test("a system-events declaration reads the window name and does not depend on the app id", async () => {
  const scripts: string[] = []
  const run: DarwinCommand = async (file, args) => {
    if (file.endsWith("pbpaste")) return "baseline\n"
    if (file.endsWith("osascript")) {
      scripts.push(args.join("\n"))
      return "Measured Title\n"
    }
    throw new Error(`unexpected ${file}`)
  }
  const adapter = await createDarwinClipboardAdapter({
    appComm: "stable",
    appId: "iterm2",
    titleRead: "system-events",
    assertOwned: async () => {},
    run,
  })
  await expect(adapter.readTitle()).resolves.toBe("Measured Title")
  expect(scripts).toEqual([`-e\ntell application "System Events" to get name of window 1 of process "stable"`])
})

test("a measured title refusal is thrown verbatim and never spawns a reader", async () => {
  const readers: string[] = []
  const run: DarwinCommand = async (file) => {
    if (file.endsWith("pbpaste")) return "baseline\n"
    readers.push(file)
    throw new Error(`unexpected ${file}`)
  }
  const titleUnavailable =
    "Hosted Darwin title read unavailable for cmux: the window server reports the app's own window title (\"Terminal\"), not this run's title, so this instrument cannot observe it (33821 calibration run 43327254711: read-failed with that name observed)"
  const adapter = await createDarwinClipboardAdapter({
    appComm: "cmux",
    appId: "iterm2",
    titleRead: "system-events",
    titleUnavailable,
    assertOwned: async () => {},
    run,
  })
  // The refusal is the route's own reason: no osascript, and no generic 5 s System Events timeout.
  await expect(adapter.readTitle()).rejects.toThrow(titleUnavailable)
  expect(readers).toEqual([])
})

// #30724 (@cto 41cd2559 condition 3): a fresh hosted runner's pasteboard is EMPTY, so a negative
// grade has no non-empty baseline to compare against and "unsupported" can never be reached. The
// disposable arm takes the owned-host sentinel path - it still never reads foreign contents, since
// there are none to preserve - and proves the sentinel comes back before any grade runs.
test("a disposable hosted pasteboard writes a random sentinel and proves it round-trips before any grade", async () => {
  let pasteboard = ""
  const calls: string[] = []
  const run: DarwinCommand = async (file, _args, stdin) => {
    if (file.endsWith("pbpaste")) {
      calls.push("pbpaste")
      return pasteboard + "\n"
    }
    if (file.endsWith("pbcopy")) {
      calls.push("pbcopy:" + (stdin ?? ""))
      pasteboard = stdin ?? ""
      return ""
    }
    throw new Error("unexpected " + file)
  }
  const adapter = await createDarwinClipboardAdapter({
    appComm: "iTerm2",
    appId: "iterm2",
    titleRead: "none",
    disposableHost: { receiptKind: "github-hosted-runner" },
    assertOwned: async () => {},
    run,
  })
  const sentinel = pasteboard
  expect(sentinel).toMatch(/^terminfo owned pasteboard /)
  // Construction writes the sentinel and reads nothing; the readback is the fixture's own first act.
  expect(calls.filter((call) => call === "pbpaste")).toHaveLength(0)
  const result = await adapter.withClipboardFixture(
    async (fixture) => {
      expect(fixture.baseline).toBe(sentinel)
      return { pass: true, note: "grade ran" } as ProbeCallbackResult
    },
    () => {},
    async () => {},
  )
  expect(result.pass).toBe(true)
  expect(calls.filter((call) => call === "pbpaste").length).toBeGreaterThan(0)
  // A second run on a second runner never reuses the sentinel.
  const second = await createDarwinClipboardAdapter({
    appComm: "iTerm2",
    appId: "iterm2",
    titleRead: "none",
    disposableHost: { receiptKind: "github-hosted-runner" },
    assertOwned: async () => {},
    run,
  })
  expect(pasteboard).not.toBe(sentinel)
  await second.dispose()
})

test("a disposable pasteboard whose sentinel does not come back refuses the clipboard rows and nothing else", async () => {
  const run: DarwinCommand = async (file) => {
    if (file.endsWith("pbcopy")) return ""
    if (file.endsWith("pbpaste")) return "text this run never wrote\n"
    throw new Error("unexpected " + file)
  }
  const adapter = await createDarwinClipboardAdapter({
    appComm: "iTerm2",
    appId: "iterm2",
    titleRead: "none",
    disposableHost: { receiptKind: "github-hosted-runner" },
    assertOwned: async () => {},
    run,
  })
  const result = await adapter.withClipboardFixture(
    async () => ({ pass: true, note: "this grade must never run" }) as ProbeCallbackResult,
    () => {},
    async () => {},
  )
  expect(result.pass).toBe(false)
  expect(result.tests).toEqual([
    {
      id: "criterion",
      status: "probe-invalid",
      reason: expect.stringContaining("sentinel self-roundtrip failed"),
    },
  ])
})

test("the shared-machine and disposable facts cannot be claimed together", async () => {
  await expect(
    createDarwinClipboardAdapter({
      appComm: "Terminal",
      appId: "terminal-app",
      titleRead: "none",
      ownedHost: true,
      disposableHost: { receiptKind: "github-hosted-runner" },
      assertOwned: async () => {},
      run: async () => "",
    }),
  ).rejects.toThrow(/disposableHost and ownedHost/)
})

// @cto 2026-11-13: adding the ordinary-open digest mode must not move a single byte of what the two existing
// configurations publish. `record` still names the sha256 and the length of foreign text; `omit` still names only
// the length, because an owned host's pasteboard text is shared with everything else on that machine.
test("the two existing foreign-read digest modes publish exactly what they published before", async () => {
  const foreign = "0123456789ab"
  const expected = {
    record: `Owned clipboard baseline changed before callback: read sha256 ${createHash("sha256").update(foreign).digest("hex")} length 12`,
    omit: "Owned clipboard baseline changed before callback: read length 12",
  } as const
  for (const mode of ["record", "omit"] as const) {
    let reads = 0
    let copied: string | undefined
    const run: DarwinCommand = async (file, _args, stdin) => {
      if (file.endsWith("pbpaste")) {
        reads += 1
        // The pre-flight read sees foreign text; everything before and after it sees the baseline.
        if (reads === (mode === "record" ? 2 : 1)) return `${foreign}\n`
        return `${copied ?? "hosted baseline"}\n`
      }
      if (file.endsWith("pbcopy")) {
        copied = stdin ?? ""
        return ""
      }
      throw new Error(`unexpected ${file}`)
    }
    const adapter = await createDarwinClipboardAdapter({
      appComm: "iTerm2",
      appId: "iterm2",
      titleRead: "none",
      ...(mode === "omit" ? { ownedHost: true } : {}),
      assertOwned: async () => {},
      run,
    })
    await expect(
      adapter.withClipboardFixture(
        async () => ({ pass: true }) as ProbeCallbackResult,
        () => {},
        async () => {},
      ),
    ).rejects.toThrow(expected[mode])
    await adapter.dispose()
  }
})
