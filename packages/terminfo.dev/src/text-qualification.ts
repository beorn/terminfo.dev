import { createHash } from "node:crypto"
import {
  admitsTextObservation,
  assessTextQualification,
  finalizeProbeResult,
  type CapturedRunDraft,
  type ProbeSuiteManifest,
  type ProbeAttempt,
  beginCaptureLifecycle,
  endCaptureLifecycle,
  TEXT_QUALIFICATION_SPEC,
  TEXT_QUALIFICATION_RECIPES,
  textQualificationFixtures,
  type ObservationFrame,
  type TermProbeSource,
  type TextCellsObservationFrame,
  type TextQualification,
  type TextQualificationOwnership,
  type TextQualificationRecipe,
} from "@terminfo/probe-defs"
import { TextSnapshotRefused, type TextFrameCheckpoint } from "./serve.ts"

/** Measure mapping witnesses through the installed adapter before recording the execution test. */
export async function collectTextQualification({
  ctx,
  recipe,
  capture,
  ownership,
  onAttempt,
  ending = "restore",
}: {
  ctx: TermProbeSource
  recipe: TextQualificationRecipe
  capture: (checkpoint: TextFrameCheckpoint) => Promise<ObservationFrame>
  ownership?: () => Promise<TextQualificationOwnership>
  onAttempt?: () => void
  /** The verified Terminal.app owner destroys this window after retaining the response. */
  ending?: "restore" | "owned-window-disposal"
}): Promise<TextQualification> {
  const grid = { rows: ctx.rows, cols: ctx.cols }
  const header = { version: TEXT_QUALIFICATION_SPEC.version, recipe }
  const required = TEXT_QUALIFICATION_RECIPES[recipe].shapes
  const unavailable = (reason: string): TextQualification => ({
    ...header,
    grid,
    shapes: required.map((shape) => ({ shape, reason })),
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
    if (ending === "restore") {
      return unavailable(
        `Prior cursor visibility or autowrap state is unavailable (DECTCEM=${visibility}, DECAWM=${autowrap})`,
      )
    }
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
        const refused = cause instanceof TextSnapshotRefused ? cause : undefined
        shapes.push({
          shape: fixture.shape,
          reason: cause instanceof Error ? cause.message : String(cause),
          ...(refused?.diagnostic !== undefined && { diagnostic: refused.diagnostic }),
          ...(refused?.diagnosticDropped !== undefined && { diagnosticDropped: refused.diagnosticDropped }),
        })
      }
    }
    if ((required as readonly string[]).includes("console-host-ownership")) {
      try {
        if (!ownership) throw new Error("This observer has no console-host ownership witness")
        ctx.write("\x1b[2J\x1b[H")
        shapes.push({ shape: "console-host-ownership", ownership: await ownership() })
      } catch (cause) {
        shapes.push({ shape: "console-host-ownership", reason: cause instanceof Error ? cause.message : String(cause) })
      }
    }
  } finally {
    const failures: unknown[] = []
    try {
      if (ending === "owned-window-disposal") endCaptureLifecycle(ctx)
      else endCaptureLifecycle(ctx, `\x1b[?7${autowrap === "set" ? "h" : "l"}`)
    } catch (cause) {
      failures.push(cause)
    }
    if (ending === "restore") {
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
    }
    if (failures.length > 0) {
      const error = new AggregateError(failures, "Text qualification restoration could not be proved")
      error.name = "CaptureRestoreFailed"
      throw error
    }
  }
  return { ...header, grid, shapes }
}

/** Record the frozen text-oracle prerequisites before seal; current readers consume these facts. */
export function recordTextQualificationTests(
  run: CapturedRunDraft,
  manifest: ProbeSuiteManifest,
  snapshots: ReadonlyMap<string, Uint8Array>,
  attempt?: Exclude<ProbeAttempt, { scope: "none" }>,
): void {
  const assessment = assessTextQualification({ ...run, textQualificationSpec: manifest.textQualification }, snapshots)
  const qualificationAttempt: ProbeAttempt = attempt ?? { scope: "none" }
  run.results = run.results.map((result) => {
    if (!result.frames?.some((frame) => frame.kind === "text-cells")) return result
    const admittedContext = admitsTextObservation({ subject: run.subject, textClaims: manifest.textClaims }, result)
    const status = !admittedContext || !attempt ? "probe-todo" : assessment.qualified ? "supported" : "probe-invalid"
    const reason = !admittedContext
      ? "Text criterion requires a declared claim and a terminal-owned cell observer (the macOS text snapshot or Windows Terminal through UI Automation)"
      : !attempt
        ? "Text qualification has not been attempted"
        : assessment.reason
    return finalizeProbeResult({
      ...result,
      tests: [
        ...result.tests.filter((check) => check.id !== "text-qualification"),
        {
          id: "text-qualification",
          status,
          attempt: status === "probe-todo" ? { scope: "none" } : qualificationAttempt,
          ...(reason && { reason }),
        },
      ],
      ...(reason && { reason }),
    })
  })
}
