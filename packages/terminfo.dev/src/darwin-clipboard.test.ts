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
