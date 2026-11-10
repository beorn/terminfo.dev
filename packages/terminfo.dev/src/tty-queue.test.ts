import { expect, test } from "vitest"
import { releaseTTYQueue, withTTYOperation } from "./tty.ts"

test("a released TTY queue lets the next operation run", async () => {
  void withTTYOperation(() => new Promise(() => {}))
  releaseTTYQueue()
  await expect(withTTYOperation(async () => "next")).resolves.toBe("next")
})
