/**
 * @failure The reviewed xterm.js OSC22 absence remains TODO, borrows another identity,
 *   or replaces an actual pointer observation. Other-feature declaration tests miss this ID.
 * @level l2
 * @consumer Registered OSC22 callback through the real xterm.js adapter and headless finalizer.
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the production TerminalBackend boundary. */
import { expect, test } from "vitest"
import { fileURLToPath } from "node:url"
import { createXtermBackend } from "@termless/xtermjs"
import { ALL_PROBES } from "@terminfo/probe-defs"
import { notTestedResult, parserStateResult } from "../probe-defs/src/helpers.ts"
import { withD2LibraryObservation } from "../probe-defs/src/extensions.ts"
import { collectBatch, createLibProbeSource } from "./headless-batch.ts"
import { headlessRuntimeIdentity, readAdapterSources } from "./headless-identity.ts"

test("xterm OSC22 declares only its reviewed identity and preserves deciding observations", async () => {
  const definition = ALL_PROBES.find((probe) => probe.id === "extensions.osc22-pointer")!
  const backend = createXtermBackend({ cols: 80, rows: 24 })
  try {
    const identity = await headlessRuntimeIdentity("xtermjs", "@termless/xtermjs", "js")
    identity.adapterSources = readAdapterSources("xtermjs", backend)
    const runtime = {
      identity,
      adapterPackage: "@termless/xtermjs",
      adapterType: "js" as const,
      adapterPath: fileURLToPath(import.meta.resolve("@termless/xtermjs")),
    }
    const batch = await collectBatch(
      async () => createXtermBackend(),
      "xtermjs",
      [definition],
      undefined,
      undefined,
      runtime,
    )
    expect(batch.results).toMatchObject([
      {
        featureId: "extensions.osc22-pointer",
        status: "untestable",
        reason: expect.stringMatching(/xterm\.js 6\.0\.0.*no OSC 22 handler.*parser tap/),
      },
    ])
    expect(batch.observations).toEqual([])

    const source = createLibProbeSource(backend, undefined, identity, undefined)
    const undecided = notTestedResult("no deciding pointer reading", {})
    const wrapped = withD2LibraryObservation({ ...definition, lib: () => undecided }).lib!
    for (const unknown of [
      undefined,
      { ...identity, engineVersion: "unreviewed" },
      { ...identity, integrity: { kind: "registry" as const, lockIntegrity: "unreviewed" } },
    ]) {
      expect(wrapped({ ...source, runtimeIdentity: unknown })).toBe(undecided)
    }
    const decided = parserStateResult(true, "actual pointer reader", { shape: "pointer" })
    expect(withD2LibraryObservation({ ...definition, lib: () => decided }).lib!(source)).toBe(decided)

    // osc-tap has a second identity arm. Its genuine vterm identity must not borrow this declaration.
    const vtermIdentity = await headlessRuntimeIdentity("vterm", "@termless/vterm", "js")
    const other = definition.lib!({ ...source, backendName: "vterm", runtimeIdentity: vtermIdentity })
    expect(JSON.stringify(other)).not.toContain("xterm.js 6.0.0")
  } finally {
    backend.destroy()
  }
})
