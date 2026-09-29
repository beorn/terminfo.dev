/**
 * Unified probe runner — imports probe definitions from @terminfo/probe-defs,
 * creates TermlessContext from each backend, runs probes as Vitest tests.
 *
 * Replaces all individual *.probe.ts files with a single runner.
 */
/* oxlint-disable typescript/no-deprecated -- Existing resolve() adapters implement TerminalBackend until the Emulator migration. */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest"
import type { TerminalBackend } from "@termless/core"
import { ALL_PROBES, type TermlessContext } from "@terminfo/probe-defs"
import { createTermlessContext } from "./headless-batch.ts"

import { manifest } from "@termless/core"
import { createLogger } from "loggily"

const log = createLogger("probes:unified")

type BackendFactory = () => Promise<TerminalBackend>
const backends: [string, BackendFactory][] = []
const loadErrors: string[] = []

const m = manifest()
// peekaboo observes a real OS terminal; it is not a headless emulation engine.
if (m.backends.peekaboo?.type !== "os") throw new Error("peekaboo must be classified as OS automation")
const allNames = Object.keys(m.backends).filter((name) => m.backends[name]?.type !== "os")

for (const name of allNames) {
  const entry = m.backends[name]
  if (!entry) throw new Error(`Missing backend manifest entry for ${name}`)
  const pkg = entry.package
  try {
    const mod = (await import(pkg)) as { resolve?: () => TerminalBackend | Promise<TerminalBackend> }
    const resolve = mod.resolve
    if (typeof resolve !== "function") throw new Error(`${pkg} does not export resolve()`)
    const factory: BackendFactory = () => Promise.resolve(resolve())
    // Verify the actual adapter can initialize before registering its tests.
    const testBackend = await factory()
    try {
      testBackend.init({ cols: 1, rows: 1 })
      testBackend.getCell(0, 0)
    } finally {
      testBackend.destroy()
    }
    backends.push([name, factory])
    log.debug?.(`Added backend: ${name} (${entry.type})`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    loadErrors.push(`${name} (${pkg}): ${msg}`)
  }
}

if (loadErrors.length > 0 || backends.length !== allNames.length) {
  throw new Error(
    `Headless backend load failed for ${loadErrors.length}/${allNames.length} expected engines; ` +
      `peekaboo is OS automation outside this suite:\n${loadErrors.join("\n")}`,
  )
}

// ── Run all probes against all backends ──

// Group probes by category (prefix before first dot)
const categories = new Map<string, typeof ALL_PROBES>()
for (const p of ALL_PROBES) {
  // Use the top-level category (e.g., "sgr", "cursor", "text", etc.)
  const topCat = p.id.split(".")[0]
  if (!topCat) throw new Error(`Probe has no category: ${p.id}`)
  const group = categories.get(topCat) ?? []
  group.push(p)
  categories.set(topCat, group)
}

for (const [backendName, factory] of backends) {
  describe(backendName, () => {
    let _b: TerminalBackend
    let ctx: TermlessContext

    beforeAll(async () => {
      _b = await factory()
      _b.init({ cols: 80, rows: 24 })
      ctx = createTermlessContext(_b)
    })

    afterAll(() => {
      _b.destroy()
    })

    beforeEach(() => {
      _b.reset()
    })

    for (const [catName, probes] of categories) {
      describe(catName, () => {
        for (const p of probes) {
          if (p.termless) {
            const fn = p.termless
            test(p.id, () => {
              const result = fn(ctx)
              expect(result.pass).toBe(true)
            })
          }
        }
      })
    }
  })
}
