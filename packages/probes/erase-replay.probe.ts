/** Selected-family production entry; captures once and reasserts twice without another backend. */
import { test } from "vitest"
import { runEraseReplay } from "./erase-run.ts"
test("xterm.js retained erase family", async (context) => {
  await runEraseReplay(context)
})
