/** Real-parser fault controls for the production erase runner; no injected domain results. */
import { inject, test, vi } from "vitest"
import { IncompleteReplay } from "viprobe"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { eraseProbes } from "../../probe-defs/src/erase.ts"
import { createLibProbeSource } from "../headless-batch.ts"
import { HEADLESS_TERMINAL } from "../headless-terminal.ts"
import { createXtermBackend } from "@termless/xtermjs"
const control = vi.hoisted(() => ({ mode: "deciding", reads: 0 }))
declare module "vitest" {
  interface ProvidedContext {
    eraseFault: "deciding" | "precondition" | "replay-failure" | "painted-seed"
  }
}
vi.mock("@termless/xtermjs", async (original) => {
  const actual = await original<typeof import("@termless/xtermjs")>()
  return {
    ...actual,
    createXtermBackend() {
      const backend = actual.createXtermBackend()
      const feed = backend.feed.bind(backend)
      backend.feed = (bytes) => {
        let text = new TextDecoder().decode(bytes)
        if (control.mode === "painted-seed") text = text.replaceAll("\x1b[42m", "")
        if (text === "\x1b[1;2H\x1b[2X") {
          if (control.mode === "deciding") text = "\x1b[1;2H"
          if (control.mode === "precondition") text = "\x1b[2X"
        }
        return feed(new TextEncoder().encode(text))
      }
      return backend
    },
  }
})
vi.mock("../erase-capture.ts", async (original) => {
  const actual = await original<typeof import("../erase-capture.ts")>()
  return {
    ...actual,
    readEraseCapture(...args: Parameters<typeof actual.readEraseCapture>) {
      const loaded = actual.readEraseCapture(...args)
      if (control.mode === "replay-failure" && ++control.reads === 2) {
        throw new IncompleteReplay("Replay control failed after the first completed assertion")
      }
      return loaded
    },
  }
})
import { runEraseReplay } from "../erase-run.ts"
test("production erase domain fault", async (context) => {
  control.mode = inject("eraseFault")
  control.reads = 0
  let live
  if (control.mode === "painted-seed") {
    const backend = createXtermBackend()
    backend.init(HEADLESS_TERMINAL)
    try {
      const source = createLibProbeSource(backend, undefined, undefined, undefined)
      source.reset()
      const probe = eraseProbes.find(({ id }) => id === "erase.el-with-attrs")
      if (!probe?.lib) throw new Error("Missing live background erase callback")
      live = probe.lib(source)
    } finally {
      backend.destroy()
    }
  }
  const record = await runEraseReplay(context)
  if (live) {
    const capture = record.files[0]
    if (!capture) throw new Error("Missing painted-seed capture artifact")
    writeFileSync(join(dirname(capture), "painted-seed-live.json"), JSON.stringify(live))
  }
})
