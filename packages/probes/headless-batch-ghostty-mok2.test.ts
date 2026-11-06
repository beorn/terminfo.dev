/**
 * @failure Raw MOK2 format changes are erased by logical normalization, or inert/stuck encoders read Supported.
 * @level l5
 * @consumer Registered MOK2 callback through the owned Ghostty native key encoder and same-path controls.
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the real library probe source. */
import { expect, test } from "vitest"
import { createGhosttyNativeBackend } from "@termless/ghostty-native"
import { ALL_PROBES, type LibProbeSource } from "@terminfo/probe-defs"
import { createLibProbeSource } from "./headless-batch.ts"
import { headlessRuntimeIdentity, readAdapterSources } from "./headless-identity.ts"
import { OWNED_LAYOUT } from "./fixtures/owned-layout.fixture.ts"

// Each counterfactual keeps a real positive witness: removing the raw discriminator
// must break both cases, while an encoder that ignores the mode or reset stays undecided.
test.runIf(OWNED_LAYOUT).each(["ignores-mode", "ignores-reset"] as const)(
  "MOK2 raw mode/reset evidence rejects an encoder that %s",
  async (fault) => {
    const definition = ALL_PROBES.find((probe) => probe.id === "input.modify-other-keys")!
    for (const candidate of ["real", fault] as const) {
      const backend = createGhosttyNativeBackend()
      try {
        await backend.init({ cols: 80, rows: 24 })
        const identity = await headlessRuntimeIdentity("ghostty-native", "@termless/ghostty-native", "native")
        identity.adapterSources = readAdapterSources("ghostty-native", backend)
        const source = createLibProbeSource(backend, undefined, identity, undefined)
        let active = false
        const stub: LibProbeSource = {
          ...source,
          feed(text) {
            if (text === "\x1b[>4;2m") active = true
            if (text === "\x1b[>4;0m" && candidate !== "ignores-reset") active = false
            source.feed(text)
          },
          encodeKey(event) {
            if (event.key === "i" && event.ctrl) {
              const text = active && candidate !== "ignores-mode" ? "\x1b[27;5;105~" : "\x1b[105;5u"
              return new TextEncoder().encode(text)
            }
            return source.encodeKey!(event)
          },
        }
        const result = definition.lib!(candidate === "real" ? source : stub)
        if (candidate === "real") {
          expect(result.observation, JSON.stringify(result)).toMatchObject({ outcome: "supported" })
          expect(result.observation?.note).toMatch(/Ctrl\+a stays \[1\].*xterm.*level 2/)
          expect(JSON.parse(result.response!)).toMatchObject({
            off: { ctrlI: { text: "\x1b[105;5u" } },
            on: { ctrlI: { text: "\x1b[27;5;105~" } },
            reset: { ctrlI: { text: "\x1b[105;5u" } },
          })
        } else {
          expect(result.observation?.outcome, JSON.stringify(result)).not.toBe("supported")
        }
      } finally {
        backend.destroy()
      }
    }
  },
)
