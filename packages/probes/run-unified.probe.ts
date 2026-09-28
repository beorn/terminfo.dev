/**
 * Unified probe runner — imports probe definitions from @terminfo/probe-defs,
 * creates TermlessContext from each backend, runs probes as Vitest tests.
 *
 * Replaces all individual *.probe.ts files with a single runner.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest"
import type { TerminalBackend } from "@termless/core"
import { ALL_PROBES, type TermlessContext } from "@terminfo/probe-defs"

// ── Re-use backend discovery from setup.ts ──
// We need the backends array but NOT the describeBackends helper (we'll create our own)

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
  const pkg = m.backends[name]!.package
  try {
    const mod = await import(pkg)
    if (typeof mod.resolve !== "function") throw new Error(`${pkg} does not export resolve()`)
    const factory: BackendFactory = async () => mod.resolve()
    // Verify the actual adapter can initialize before registering its tests.
    const testBackend = await factory()
    try {
      testBackend.init({ cols: 1, rows: 1 })
      testBackend.getCell(0, 0)
    } finally {
      testBackend.destroy()
    }
    backends.push([name, factory])
    log.debug?.(`Added backend: ${name} (${m.backends[name]!.type})`)
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

// ── Helpers ──

const enc = new TextEncoder()
const dec = new TextDecoder()

function createTermlessContext(b: TerminalBackend): TermlessContext {
  let cols: number
  try {
    cols = b.getRow(0).length
  } catch (cause) {
    throw new Error(`${b.name} has no initialized row 0 grid for headless probes`, { cause })
  }
  if (!Number.isSafeInteger(cols) || cols < 1) {
    throw new Error(`${b.name} returned invalid initialized grid width ${cols}`)
  }
  if (cols !== 80) throw new Error(`${b.name} initialized ${cols} columns; requested 80`)
  return {
    cols,
    feed(text: string) {
      b.feed(enc.encode(text))
    },
    feedCapture(text: string) {
      let response = ""
      const prev = b.onResponse
      b.onResponse = (data) => {
        response += dec.decode(data)
      }
      b.feed(enc.encode(text))
      b.onResponse = prev
      return response
    },
    getCell(row, col) {
      return b.getCell(row, col) as any
    },
    getCursor() {
      return b.getCursor()
    },
    getMode(mode) {
      return b.getMode(mode as any)
    },
    getText() {
      return b.getText()
    },
    getScrollback() {
      return b.getScrollback()
    },
    getTitle() {
      return b.getTitle()
    },
    reset() {
      b.reset()
    },
    get capabilities() {
      return b.capabilities
    },
  }
}

// ── Run all probes against all backends ──

// Group probes by category (prefix before first dot)
const categories = new Map<string, typeof ALL_PROBES>()
for (const p of ALL_PROBES) {
  const cat = p.id.split(".").slice(0, -1).join(".")
  // Use the top-level category (e.g., "sgr", "cursor", "text", etc.)
  const topCat = p.id.split(".")[0]!
  if (!categories.has(topCat)) categories.set(topCat, [])
  categories.get(topCat)!.push(p)
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
