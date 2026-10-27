import { createHash } from "node:crypto"
import {
  assessTextQualification,
  finalizeProbeResult,
  type CapturedRunDraft,
  type ProbeSuiteManifest,
  type ProbeAttempt,
  beginCaptureLifecycle,
  endCaptureLifecycle,
  TEXT_QUALIFICATION_SPEC,
  TEXT_QUALIFICATION_SHAPES,
  textQualificationFixtures,
  type ObservationFrame,
  type TermProbeSource,
  type TextCellsObservationFrame,
  type TextQualification,
} from "@terminfo/probe-defs"
import type { TextFrameCheckpoint } from "./serve.ts"

/** Measure mapping witnesses through the installed adapter before recording the execution check. */
export async function collectTextQualification({
  ctx,
  capture,
  onAttempt,
}: {
  ctx: TermProbeSource
  capture: (checkpoint: TextFrameCheckpoint) => Promise<ObservationFrame>
  onAttempt?: () => void
}): Promise<TextQualification> {
  const grid = { rows: ctx.rows, cols: ctx.cols }
  const unavailable = (reason: string): TextQualification => ({
    ...TEXT_QUALIFICATION_SPEC,
    grid,
    shapes: TEXT_QUALIFICATION_SHAPES.map((shape) => ({ shape, reason })),
  })
  const fixtures = textQualificationFixtures(grid.rows, grid.cols)
  if (typeof fixtures === "string") return unavailable(fixtures)
  onAttempt?.()
  const visibility = await ctx.queryMode(25)
  const autowrap = await ctx.queryMode(7)
  if ((visibility !== "set" && visibility !== "reset") || (autowrap !== "set" && autowrap !== "reset")) {
    // Retain the alternate query form through the existing owned preparation trace. Even a valid
    // diagnostic reply does not establish the prior state used by this qualification attempt.
    await ctx.queryOutcome("\x1b[?25$p", /\x1b\[\?25;[0-4]\$y/, 5000)
    await ctx.queryOutcome("\x1b[?7$p", /\x1b\[\?7;[0-4]\$y/, 5000)
    return unavailable(
      `Prior cursor visibility or autowrap state is unavailable (DECTCEM=${visibility}, DECAWM=${autowrap})`,
    )
  }
  const cells = { top: 1, left: 1, bottom: grid.rows, right: grid.cols }
  const read = async (role: ObservationFrame["role"], label: string): Promise<TextCellsObservationFrame> => {
    const frame = await capture({ role, label, cells })
    if (frame.kind !== "text-cells") throw new Error(`${label}: installed text adapter returned a pixel frame`)
    return frame
  }
  try {
    await read("control", "text qualification baseline before paint")
  } catch (cause) {
    return unavailable(
      `Baseline text read unavailable before paint: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const shapes: TextQualification["shapes"] = []
  try {
    beginCaptureLifecycle(ctx)
    ctx.write("\x1b[?7h")
    for (const fixture of fixtures) {
      try {
        ctx.write(fixture.controlWrites)
        const control = await read("control", `text qualification ${fixture.shape} control`)
        ctx.write(fixture.targetWrites)
        const target = await read("target", `text qualification ${fixture.shape} target`)
        shapes.push({ shape: fixture.shape, frames: [control, target] })
      } catch (cause) {
        shapes.push({ shape: fixture.shape, reason: cause instanceof Error ? cause.message : String(cause) })
      }
    }
  } finally {
    const failures: unknown[] = []
    try {
      endCaptureLifecycle(ctx, `\x1b[?7${autowrap === "set" ? "h" : "l"}`)
    } catch (cause) {
      failures.push(cause)
    }
    try {
      ctx.write(`\x1b[?25${visibility === "set" ? "h" : "l"}`)
      if ((await ctx.queryMode(25)) !== visibility || (await ctx.queryMode(7)) !== autowrap) {
        throw new Error("Restored cursor visibility or autowrap differs from its measured prior state")
      }
    } catch (cause) {
      failures.push(cause)
    }
    try {
      const restored = await read("target", "text qualification restored blank grid")
      const expected = `sha256:${createHash("sha256")
        .update(Array.from({ length: grid.rows }, () => " ".repeat(grid.cols)).join("\n"))
        .digest("hex")}`
      if (restored.frameDigest !== expected || restored.cellDigest !== expected) {
        throw new Error("Restored text grid does not match the complete blank grid")
      }
    } catch (cause) {
      failures.push(cause)
    }
    if (failures.length > 0) {
      const error = new AggregateError(failures, "Text qualification restoration could not be proved")
      error.name = "CaptureRestoreFailed"
      throw error
    }
  }
  return { ...TEXT_QUALIFICATION_SPEC, grid, shapes }
}

/** Record the frozen text-oracle prerequisites before seal; current readers consume these facts. */
export function recordTextQualificationChecks(
  run: CapturedRunDraft,
  manifest: ProbeSuiteManifest,
  snapshots: ReadonlyMap<string, Uint8Array>,
  attempt?: Exclude<ProbeAttempt, { scope: "none" }>,
): void {
  const assessment = assessTextQualification({ ...run, textQualificationSpec: manifest.textQualification }, snapshots)
  const qualificationAttempt: ProbeAttempt = attempt ?? { scope: "none" }
  run.results = run.results.map((result) => {
    if (result.evidence !== "text") return result
    const admittedContext =
      run.target.kind === "app" &&
      run.target.os?.toLowerCase() === "macos" &&
      result.host === undefined &&
      manifest.textClaims?.includes(result.featureId) === true
    const status = !admittedContext || !attempt ? "test-todo" : assessment.qualified ? "supported" : "test-failure"
    const reason = !admittedContext
      ? "Text criterion requires a declared claim and terminal-owned macOS cell observer"
      : !attempt
        ? "Text qualification has not been attempted"
        : assessment.reason
    return finalizeProbeResult({
      ...result,
      checks: [
        ...result.checks.filter((check) => check.id !== "text-qualification"),
        {
          id: "text-qualification",
          status,
          attempt: status === "test-todo" ? { scope: "none" } : qualificationAttempt,
          ...(reason && { reason }),
        },
      ],
      ...(reason && { reason }),
    })
  })
}
