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
