import type { AppSemanticReading, ProbeCallbackResult, ProbeDefinition } from "./types.ts"
import { parserStateResult, reportsDecidedOutcome } from "./helpers.ts"

const reportFeatures = new Set([
  "extensions.osc176-app-id",
  "extensions.osc3008-context",
  "extensions.osc440-audio",
  "extensions.osc666-termprop",
  "extensions.osc555-flash",
  "extensions.osc710-font-normal",
  "extensions.osc113-reset-pointer-fg",
  "extensions.osc114-reset-pointer-bg",
  "extensions.osc117-reset-highlight-bg",
  "extensions.osc119-reset-highlight-fg",
])

/** The owned icon read returned unavailable. No observation, so an exact-version declaration can still replace it. */
function iconReaderGap(reason: string): ProbeCallbackResult {
  return {
    pass: false,
    note: reason,
    tests: [{ id: "criterion", status: "probe-todo", reason }],
  }
}

function iconPair(value: string): [string, string | null] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string") {
    throw new Error("Icon observation pair is not [title, icon]")
  }
  if (parsed[1] !== null && typeof parsed[1] !== "string") throw new Error("Icon observation pair is not [title, icon]")
  return [parsed[0], parsed[1]]
}

/**
 * OSC 2 sets title A, then the row sends B. Icon name B is supported. An OSC 0 icon name that
 * reads as some other C is supported. Absent, still A, or unchanged is unsupported. OSC 1 whose
 * title becomes B is unsupported. @cto 09e1912c.
 */
export function gradeIconNameReading(featureId: string, reading: AppSemanticReading): ProbeCallbackResult {
  if (reading.status !== "measured" || reading.reader !== "state") return gradeAppSemanticState(reading)
  let titleA: string
  let iconBefore: string | null
  let titleAfter: string
  let iconAfter: string | null
  let payloadB: string | null
  try {
    ;[titleA, iconBefore] = iconPair(reading.target.before)
    ;[titleAfter, iconAfter] = iconPair(reading.target.after)
    ;[, payloadB] = iconPair(reading.target.expected)
  } catch (error) {
    return gradeAppSemanticState({
      status: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (payloadB === null) {
    return gradeAppSemanticState({ status: "invalid", reason: "Icon payload B is missing" })
  }
  const seen = { titleA, iconBefore, titleAfter, iconAfter, payloadB }
  const note = `Seen title ${JSON.stringify(titleAfter)}, icon ${JSON.stringify(iconAfter)}`
  const osc1 = featureId === "extensions.osc1-icon"
  if (osc1 && titleAfter === payloadB) {
    return parserStateResult(false, "OSC 1 must not change the window title to its icon payload", seen, note)
  }
  if (iconAfter === payloadB && (!osc1 || titleAfter === titleA)) {
    return parserStateResult(
      true,
      osc1 ? "OSC 1 set the icon name to B and left title A" : "OSC 0 icon name reads B",
      seen,
    )
  }
  if (!osc1 && iconAfter !== null && iconAfter !== iconBefore && iconAfter !== titleA) {
    return parserStateResult(true, "OSC 0 icon name reads C", seen, note)
  }
  if (iconAfter === null || iconAfter === titleA || iconAfter === iconBefore) {
    return parserStateResult(false, "Icon name is absent, still A, or unchanged", seen, note)
  }
  return parserStateResult(false, "OSC 1 icon name was not B", seen, note)
}

/** App-only alternative. Existing effects win; a qualified report beats a no-setup fallback. */
export function withAppSemanticObservation(definition: ProbeDefinition): ProbeDefinition {
  const term = definition.term
  const icon = definition.id === "extensions.osc0-icon-title" || definition.id === "extensions.osc1-icon"
  const semantic =
    icon ||
    /^extensions\.osc(?:133|633)-[abcdep]$/.test(definition.id) ||
    definition.id === "extensions.osc7-cwd" ||
    definition.id === "extensions.semantic-prompts" ||
    definition.id === "extensions.osc-633-vscode"
  if (!term || (!semantic && !reportFeatures.has(definition.id))) return definition
  return {
    ...definition,
    term: async (ctx) => {
      if (icon) {
        if (!ctx.readAppSemanticState) return term(ctx)
        const reading = await ctx.readAppSemanticState(definition.id, ctx.write)
        if (reading.status === "unavailable") return iconReaderGap(reading.reason)
        if (reading.status === "measured" && reading.reader === "state") {
          return gradeIconNameReading(definition.id, reading)
        }
        return gradeAppSemanticState(reading)
      }
      if (!ctx.readAppSemanticState) return term(ctx)
      if (semantic) {
        const reading = await ctx.readAppSemanticState(definition.id, ctx.write)
        if (definition.id === "extensions.osc7-cwd" && reading.status === "unavailable") return term(ctx)
        return gradeAppSemanticState(reading)
      }
      const previous = await term(ctx)
      if (reportsDecidedOutcome(previous)) return previous
      const reading = await ctx.readAppSemanticState(definition.id, ctx.write)
      if (reading.status === "unavailable") return previous
      const result = gradeAppSemanticState(reading)
      return result.observation?.outcome === "unsupported" ||
        reading.status === "invalid" ||
        result.tests?.some((test) => test.status === "probe-invalid")
        ? result
        : previous
    },
  }
}

/** One grader for the owned reader. An App's identity selects its reader outside this package. */
export function gradeAppSemanticState(reading: AppSemanticReading): ProbeCallbackResult {
  const pending = (reason: string, invalid = false): ProbeCallbackResult => ({
    pass: false,
    response: JSON.stringify(reading),
    note: reason,
    tests: [{ id: "criterion", status: invalid ? "probe-invalid" : "probe-todo", reason }],
  })
  if (reading.status !== "measured") return pending(reading.reason, reading.status === "invalid")
  if (reading.reader === "report") {
    if (
      reading.unknown.reports.length === 0 ||
      reading.unknown.reports.some((code) => code !== reading.unknown.code) ||
      !reading.handled.applied ||
      reading.handled.reports.length !== 0
    ) {
      return pending("App exact-command log controls failed in this row", true)
    }
    if (reading.target.reports.length > 0 && reading.target.reports.every((code) => code === reading.target.code)) {
      return parserStateResult(false, "App reported this exact command as unhandled", reading)
    }
    return pending("App log has no qualified exact-command refusal; silence does not decide support")
  }
  if (
    reading.unknown.before !== reading.unknown.after ||
    reading.handled.before === reading.handled.expected ||
    reading.handled.after !== reading.handled.expected
  ) {
    return pending("App semantic-state controls failed in this row", true)
  }
  if (reading.target.before === reading.target.expected) {
    return pending("App target state was already present before this row's command")
  }
  if (reading.target.after === reading.target.expected) {
    return parserStateResult(true, "App stores this row's semantic state; unknown command leaves it unchanged", reading)
  }
  if (reading.target.after === reading.target.before) {
    return parserStateResult(
      false,
      "App semantic control changes its own state; this command leaves it unchanged",
      reading,
    )
  }
  return pending("App semantic target changed to an unexpected state")
}
