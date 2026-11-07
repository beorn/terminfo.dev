/**
 * @failure Fresh native no-setup outcomes are discarded, or unrelated/disagreeing Untestable repeats are adopted.
 * @level l5
 * @consumer collectBatch merges real Ghostty native highlight-reset observations.
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the collector's real TerminalBackend execution path. */
import { expect, test, vi } from "vitest"
import { createGhosttyNativeBackend } from "@termless/ghostty-native"
import { ALL_PROBES, declaredUntestableResult, isDeclaredUntestable } from "@terminfo/probe-defs"
import { collectBatch } from "./headless-batch.ts"
import { OWNED_LAYOUT } from "./fixtures/owned-layout.fixture.ts"

const ids = ["extensions.osc117-reset-highlight-bg", "extensions.osc119-reset-highlight-fg"]

test.runIf(OWNED_LAYOUT).each(["real", "disagree", "other-cause"] as const)(
  "native highlight repeats preserve only matching no-setup readings: %s",
  async (mode) => {
    const passes = new Map<string, number>()
    const definitions = ids.map((id) => {
      const definition = ALL_PROBES.find((probe) => probe.id === id)!
      return {
        ...definition,
        lib(ctx: Parameters<NonNullable<typeof definition.lib>>[0]) {
          const result = definition.lib!(ctx)
          const pass = (passes.get(id) ?? 0) + 1
          passes.set(id, pass)
          if (mode === "real" || pass === 1 || !isDeclaredUntestable(result)) return result
          // Retain the real query/control path; vary only the repeat outcome under test.
          const reason =
            mode === "other-cause"
              ? "Untestable (app): counterfactual application-owned setup."
              : `Untestable (no setup): counterfactual repeat ${pass}.`
          return declaredUntestableResult(reason, { response: result.response })
        },
      }
    })
    const write = process.stderr.write.bind(process.stderr)
    const progress = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      if (
        typeof chunk === "string" &&
        /^headless ghostty-native probe extensions\.osc(?:117-reset-highlight-bg|119-reset-highlight-fg)\n$/.test(chunk)
      )
        return true
      return write(chunk)
    })
    const batch = await collectBatch(async () => createGhosttyNativeBackend(), "ghostty-native", definitions).finally(
      () => progress.mockRestore(),
    )
    const repeatPasses = JSON.parse(batch.rawReplies["collector.repeatPasses"]!) as {
      second: Record<string, string>
    }
    for (const id of ids) {
      const repeated = JSON.parse(batch.rawReplies[`collector.repeats.${id}`]!) as {
        secondResults: typeof batch.results
        thirdResults: typeof batch.results
      }
      const second = repeated.secondResults[0]!
      const third = repeated.thirdResults[0]!
      expect([second.status, third.status]).toEqual(["untestable", "untestable"])
      const row = batch.results.find((result) => result.featureId === id)!
      if (mode === "real") {
        expect(row.status).toBe("untestable")
        expect(row.reason).toMatch(/^Untestable \(no setup\): OSC (17|19) colour setup/)
        expect(second.reason).toBe(third.reason)
        const ref = `collector.repeatResponse.${id}`
        expect(row.rawReplyRef).toBe(ref)
        expect(row.tests[0]?.rawReplyRef).toBe(ref)
        expect(repeatPasses.second[id]).toEqual(expect.any(String))
        expect(batch.rawReplies[ref]).toBe(repeatPasses.second[id])
      } else {
        expect(row.status).toBe("probe-todo")
        expect(row.reason).toContain("no control in this run")
        if (mode === "disagree") expect(second.reason).not.toBe(third.reason)
        else {
          expect(second.reason).toBe(third.reason)
          expect(second.reason).toMatch(/^Untestable \(app\):/)
        }
      }
    }
  },
)
