import type { ProbeDefinition, ProbeResult, TermContext } from "./types.ts"
import { notTestedResult, probe } from "./helpers.ts"
import { kittyKeyboardFlagProbe } from "./extensions.ts"

const absentEventNote = "No generated input event and encoded report were validated"

/** A current parser mode is diagnostic context, not a mouse-event observation. */
function mouseInputProbe(id: string, modeName: string): ProbeDefinition {
  return probe(
    id,
    (ctx) => ({
      pass: false,
      response: JSON.stringify({ currentMode: ctx.getMode(modeName) === true }),
      note: absentEventNote,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "legacy",
        note: absentEventNote,
      },
    }),
    () =>
      Promise.resolve<ProbeResult>({
        pass: false,
        note: absentEventNote,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: absentEventNote,
        },
      }),
  )
}

export const inputProbes: ProbeDefinition[] = [
  probe(
    "input.modify-other-keys",
    (ctx) => ({
      pass: false,
      response: JSON.stringify({ declaredModifyOtherKeys: ctx.capabilities.extensions.has("modifyOtherKeys") }),
      note: absentEventNote,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "legacy",
        note: absentEventNote,
      },
    }),
    () =>
      Promise.resolve<ProbeResult>({
        pass: false,
        note: absentEventNote,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: absentEventNote,
        },
      }),
  ),

  // Negotiation only; actual key encoding requires an input-event observation.
  kittyKeyboardFlagProbe("input.csi-u", 1, 1),

  mouseInputProbe("input.pixel-mouse", "pixelMouse"),
  mouseInputProbe("input.urxvt-mouse", "mouseTracking"),
  mouseInputProbe("input.x10-mouse", "mouseTracking"),

  // Mode 3 cannot be distinguished from mode 2 by this declared capability.
  probe(
    "input.modify-other-keys-3",
    (ctx) => ({
      pass: false,
      response: JSON.stringify({ declaredModifyOtherKeys: ctx.capabilities.extensions.has("modifyOtherKeys") }),
      note: absentEventNote,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "legacy",
        note: absentEventNote,
      },
    }),
    () =>
      Promise.resolve<ProbeResult>({
        pass: false,
        note: absentEventNote,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: absentEventNote,
        },
      }),
  ),

  mouseInputProbe("input.button-event-mouse", "mouseTracking"),

  probe("input.xtest-key", () => xtestCoverage("key injection"), xtestKey, "interaction"),
  probe("input.xtest-click", () => xtestCoverage("click injection"), xtestClick, "interaction"),
  probe("input.xtest-wheel", () => xtestCoverage("wheel injection"), xtestWheel, "interaction"),
]

const MODIFY_OTHER_KEYS_SET = "\x1b[>4;2m"
const MODIFY_OTHER_KEYS_RESET = "\x1b[>4;0m"
const MOUSE_SET = "\x1b[?1000h\x1b[?1006h"
const MOUSE_RESET = "\x1b[?1000l\x1b[?1006l"
const PLAIN_A = /^a/
const MODIFIED_KEY = /\x1b\[(?:27;\d+;\d+~|\d+;\d+u)/
const SGR_MOUSE = /\x1b\[<\d+;\d+;\d+[Mm]/

function xtestCoverage(kind: string): ProbeResult {
  return notTestedResult(`OS-level XTEST ${kind}`, { input: false })
}

async function deliveryControl(
  inject: () => Promise<void>,
  read: NonNullable<TermContext["readInput"]>,
  pattern: RegExp,
  message: string,
): Promise<string> {
  const report = (await read(pattern, 1000, inject))?.[0]
  if (!report) throw new Error(message)
  return report
}

function interactionResult(action: string, expected: string, observed: Record<string, unknown>): ProbeResult {
  return {
    pass: true,
    response: JSON.stringify(observed),
    observation: { outcome: "supported", evidence: "interaction" },
    assertions: [{ kind: "positive", expected, observed: JSON.stringify(observed), action }],
  }
}

async function xtestKey(ctx: TermContext): Promise<ProbeResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage("key injection")
  const control = await deliveryControl(
    () => input.injectKey("a"),
    readInput,
    PLAIN_A,
    "XTEST delivery control failed: plain a did not reach the app",
  )
  ctx.write(MODIFY_OTHER_KEYS_SET)
  try {
    const report = (await readInput(MODIFIED_KEY, 1000, () => input.injectKey("ctrl+shift+a")))?.[0]
    if (!report) {
      throw new Error("XTEST modified key did not reach the app after a successful delivery control")
    }
    return interactionResult("xtest-key:ctrl+shift+a", "OS XTEST ctrl+shift+a report after plain-a delivery control", {
      control,
      report,
    })
  } finally {
    ctx.write(MODIFY_OTHER_KEYS_RESET)
  }
}

async function withMouseModes<T>(ctx: TermContext, work: () => Promise<T>): Promise<T> {
  ctx.write(MOUSE_SET)
  try {
    return await work()
  } finally {
    ctx.write(MOUSE_RESET)
  }
}

async function xtestClick(ctx: TermContext): Promise<ProbeResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage("click injection")
  return withMouseModes(ctx, async () => {
    const control = await deliveryControl(
      () => input.injectClick(1),
      readInput,
      SGR_MOUSE,
      "XTEST delivery control failed: click under 1000+1006 did not reach the app",
    )
    const report = (await readInput(SGR_MOUSE, 1000, () => input.injectClick(1)))?.[0]
    if (!report) {
      throw new Error("XTEST click did not reach the app after a successful 1000+1006 delivery control")
    }
    return interactionResult("xtest-click:1", "OS XTEST button-1 report under 1000+1006 after same-run control click", {
      mode: "1000+1006",
      control,
      report,
    })
  })
}

async function xtestWheel(ctx: TermContext): Promise<ProbeResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage("wheel injection")
  return withMouseModes(ctx, async () => {
    const control = await deliveryControl(
      () => input.injectClick(1),
      readInput,
      SGR_MOUSE,
      "XTEST delivery control failed: click under 1000+1006 did not reach the app",
    )
    const report = (await readInput(SGR_MOUSE, 1000, () => input.injectClick(4)))?.[0]
    if (!report) {
      throw new Error("XTEST wheel did not reach the app after a successful 1000+1006 delivery control")
    }
    return interactionResult("xtest-wheel:4", "OS XTEST wheel-4 report under 1000+1006 after same-run control click", {
      mode: "1000+1006",
      control,
      report,
    })
  })
}
