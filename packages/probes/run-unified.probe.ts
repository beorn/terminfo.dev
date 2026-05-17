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

const EXCLUDED = new Set(["peekaboo"])
type BackendFactory = () => Promise<TerminalBackend>
const backends: [string, BackendFactory][] = []

const m = manifest()
const allNames = Object.keys(m.backends).filter((name) => !EXCLUDED.has(name))

for (const name of allNames) {
  const pkg = m.backends[name]!.package
  try {
    const mod = await import(pkg)
    const entry = m.backends[name]!
    let factory: BackendFactory

    if (entry.type === "wasm") {
      if (name === "ghostty") {
        const instance = await mod.initGhostty()
        const testBackend = mod.createGhosttyBackend(undefined, instance)
        testBackend.init({ cols: 1, rows: 1 })
        testBackend.destroy()
        factory = async () => mod.createGhosttyBackend(undefined, instance)
      } else if (name === "libvterm") {
        const b = mod.createLibvtermBackend()
        b.init({ cols: 1, rows: 1 })
        b.destroy()
        factory = async () => mod.createLibvtermBackend()
      } else {
        continue
      }
    } else if (entry.type === "native") {
      const loadFn = Object.keys(mod).find((k) => k.startsWith("load"))
      if (loadFn) mod[loadFn]()
      const createFn = Object.keys(mod).find((k) => k.startsWith("create"))!
      factory = async () => mod[createFn]()
    } else {
      const createFn = Object.keys(mod).find((k) => k.startsWith("create"))!
      mod[createFn]()
      factory = async () => mod[createFn]()
    }

    backends.push([name, factory])
    log.debug?.(`Added backend: ${name} (${entry.type})`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.debug?.(`Skipping ${name} (load failed: ${msg})`)
  }
}

if (backends.length === 0) {
  console.warn("Warning: No backends available for unified probes")
}

// ── Helpers ──

const enc = new TextEncoder()
const dec = new TextDecoder()

function createTermlessContext(b: TerminalBackend): TermlessContext {
  return {
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
