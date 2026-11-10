import type { ProbeCallbackResult } from "@terminfo/probe-defs"
import { expect, test } from "vitest"
import { createDarwinClipboardAdapter, type DarwinCommand } from "./darwin-clipboard.ts"

test("hosted Darwin pasteboard saves, writes, and restores through the owned transaction", async () => {
  let pasteboard = "baseline"
  let title = "Window"
  const run: DarwinCommand = async (file, args, stdin) => {
    if (file.endsWith("pbpaste")) return `${pasteboard}\n`
    if (file.endsWith("pbcopy")) {
      pasteboard = stdin ?? ""
      return ""
    }
    if (file.endsWith("osascript")) {
      expect(args.join(" ")).toContain("iTerm2")
      return `${title}\n`
    }
    throw new Error(`unexpected ${file}`)
  }
  const adapter = await createDarwinClipboardAdapter({
    appComm: "iTerm2",
    assertOwned: async () => {},
    run,
  })
  expect(adapter.config).toBe(null)
  expect(await adapter.readTitle()).toBe("Window")
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
