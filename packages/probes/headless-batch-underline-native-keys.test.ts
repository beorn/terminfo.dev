/**
 * @failure Missing native underline-colour readback stays TODO, or an unavailable reader/real negative is wrongly declared Untestable.
 * @level l2
 * @consumer Existing backend -> headless source -> registered SGR58 callback and finalizer.
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the existing backend observation boundary. */
import { expect, test } from "vitest"
import { createVt100Backend } from "@termless/vt100"
import { ALL_PROBES } from "@terminfo/probe-defs"
import { collectBatch } from "./headless-batch.ts"
import { headlessRuntimeIdentity, readAdapterSources } from "./headless-identity.ts"
import { OWNED_LAYOUT } from "./fixtures/owned-layout.fixture.ts"
import { fileURLToPath } from "node:url"

// The existing SGR tests have normalized cells only: none can distinguish a failed
// native-interface observation from an observed missing field across the collector.
test.runIf(OWNED_LAYOUT).each([
  ["missing", "probe-todo"],
  ["throws", "probe-todo"],
  ["absent", "untestable"],
  ["present", "unsupported"],
] as const)("native underline reader %s retains %s", async (reading, status) => {
  const backend = createVt100Backend({ cols: 80, rows: 24 })
  Object.assign(backend, {
    nativeCellKeys:
      reading === "missing"
        ? undefined
        : () => {
            if (reading === "throws") throw new Error("native cell unavailable")
            return reading === "present" ? ["char", "underline", "underlineColor"] : ["char", "underline"]
          },
  })
  if (reading === "present") {
    const getCell = backend.getCell.bind(backend)
    backend.getCell = (row, col) => {
      const cell = getCell(row, col)
      const colors = [
        { r: 0, g: 0, b: 255 },
        { r: 0, g: 255, b: 0 },
        { r: 1, g: 2, b: 3 },
      ]
      return { ...cell, underline: true, fg: colors[col] ?? null, underlineColor: colors[col] ?? null }
    }
  }
  const identity = await headlessRuntimeIdentity("vt100", "@termless/vt100", "js")
  identity.adapterSources = readAdapterSources("vt100", backend)
  const batch = await collectBatch(
    async () => backend,
    "vt100",
    [ALL_PROBES.find((probe) => probe.id === "sgr.underline-color-rgb")!],
    undefined,
    undefined,
    {
      identity,
      adapterPackage: "@termless/vt100",
      adapterType: "js",
      adapterPath: fileURLToPath(import.meta.resolve("@termless/vt100")),
    },
  )
  expect(batch.results, JSON.stringify(batch)).toMatchObject([{ status }])
  if (reading === "absent") {
    const evidence = JSON.stringify(batch.rawReplies)
    expect(evidence).toContain("nativeCellInterface")
    expect(evidence).toContain("underlineColor")
    expect(evidence).toContain(identity.adapterSources[0]!.blobOid)
  }
  if (reading === "throws") expect(JSON.stringify(batch.results)).toContain("native cell unavailable")
})

// A normalized cell always contains underlineColor:null. Reading its keys would
// lie about the native interface and must fail this real-adapter assertion.
test("vt100 reports keys from its live native cell", () => {
  const backend = createVt100Backend({ cols: 80, rows: 24 })
  try {
    backend.feed(new TextEncoder().encode("\x1b[4mX"))
    const native = backend as typeof backend & { nativeCellKeys(row: number, col: number): readonly string[] }
    expect(native.nativeCellKeys(0, 0)).toContain("char")
    expect(native.nativeCellKeys(0, 0)).not.toContain("underlineColor")
    expect(backend.getCell(0, 0)).toMatchObject({ char: "X", underline: "single", underlineColor: null })
  } finally {
    backend.destroy()
  }
})
