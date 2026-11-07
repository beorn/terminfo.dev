/**
 * @failure The native App reader changes a library's semantic-prompt result or loses
 *   its audited identity at collection. Callback-only App tests cannot detect this.
 * @level l2
 * @consumer Real xterm.js adapter through the headless batch recorder and finalizer.
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the production TerminalBackend boundary. */
import { expect, test, vi } from "vitest"
import { fileURLToPath } from "node:url"
import { createXtermBackend } from "@termless/xtermjs"
import { ALL_PROBES } from "@terminfo/probe-defs"
import { collectBatch } from "./headless-batch.ts"
import { headlessRuntimeIdentity, readAdapterSources } from "./headless-identity.ts"
import { OWNED_LAYOUT } from "./fixtures/owned-layout.fixture.ts"

test.runIf(OWNED_LAYOUT)("App semantic-state grading leaves the real library's passed-to-app result intact", async () => {
  const definition = ALL_PROBES.find((probe) => probe.id === "extensions.osc133-a")!
  const backend = createXtermBackend({ cols: 80, rows: 24 })
  const progress = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const identity = await headlessRuntimeIdentity("xtermjs", "@termless/xtermjs", "js")
    identity.adapterSources = readAdapterSources("xtermjs", backend)
    const batch = await collectBatch(async () => createXtermBackend(), "xtermjs", [definition], undefined, undefined, {
      identity,
      adapterPackage: "@termless/xtermjs",
      adapterType: "js",
      adapterPath: fileURLToPath(import.meta.resolve("@termless/xtermjs")),
    })
    expect(batch.results).toMatchObject([{
      featureId: "extensions.osc133-a",
      status: "untestable",
      reason: expect.stringMatching(/hands this command to the app/i),
    }])
    expect(batch.observations).toEqual([])
    expect(progress).toHaveBeenCalledExactlyOnceWith("headless xtermjs probe extensions.osc133-a\n")
  } finally {
    progress.mockRestore()
    backend.destroy()
  }
})
