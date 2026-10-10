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
  probe("input.modify-other-keys", () => xtestCoverage("key injection"), modifyOtherKeys2, "interaction"),

  // Negotiation only; actual key encoding requires an input-event observation.
  kittyKeyboardFlagProbe("input.csi-u", 1, 1),

  mouseInputProbe("input.pixel-mouse", "pixelMouse"),
  mouseInputProbe("input.urxvt-mouse", "mouseTracking"),
  mouseInputProbe("input.x10-mouse", "mouseTracking"),

  probe("input.modify-other-keys-3", () => xtestCoverage("key injection"), modifyOtherKeys3, "interaction"),

  mouseInputProbe("input.button-event-mouse", "mouseTracking"),

  probe("input.xtest-key", () => xtestCoverage("key injection"), xtestKey, "interaction"),
  probe("input.xtest-click", () => xtestCoverage("click injection"), xtestClick, "interaction"),
  probe("input.xtest-wheel", () => xtestCoverage("wheel injection"), xtestWheel, "interaction"),
]

const MOUSE_SET = "\x1b[?1000h\x1b[?1006h"
const MOUSE_RESET = "\x1b[?1000l\x1b[?1006l"
const PLAIN_A = /^a/
const MODIFIED_KEY = /\x01|\x1b\[(?:27;\d+;\d+~|\d+;\d+u)/
const SGR_MOUSE = /\x1b\[<\d+;\d+;\d+[Mm]/
const MODIFY_OTHER_KEYS_2 = "\x1b[>4;2m"
const MODIFY_OTHER_KEYS_3 = "\x1b[>4;3m"
const MODIFY_OTHER_KEYS_RESET = "\x1b[>4;0m"
const MODIFY_OTHER_KEYS_REPORT = /\t|\x1b\[(?:27;\d+;\d+~|\d+;\d+u)/
const MODIFY_OTHER_KEYS_3_REPORT = /\x1b\[(?:27;\d+;\d+~|\d+;\d+u)|i/
const MODIFY_OTHER_KEYS_ENCODING = /\x1b\[(?:27;\d+;105~|105;\d+u)/

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

function unsupportedInteraction(action: string, expected: string, observed: Record<string, unknown>): ProbeResult {
  return {
    pass: false,
    response: JSON.stringify(observed),
    observation: { outcome: "unsupported", evidence: "interaction" },
    assertions: [{ kind: "negative", expected, observed: JSON.stringify(observed), action }],
  }
}

async function withModifyOtherKeys<T>(ctx: TermContext, enable: string, work: () => Promise<T>): Promise<T> {
  ctx.write(enable)
  try {
    return await work()
  } finally {
    ctx.write(MODIFY_OTHER_KEYS_RESET)
  }
}

async function modifyOtherKeys2(ctx: TermContext): Promise<ProbeResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage("key injection")
  return withModifyOtherKeys(ctx, MODIFY_OTHER_KEYS_2, async () => {
    const control = await deliveryControl(
      () => input.injectKey("a"),
      readInput,
      PLAIN_A,
      "XTEST delivery control failed: plain a did not reach the app",
    )
    const report = (await readInput(MODIFY_OTHER_KEYS_REPORT, 1000, () => input.injectKey("ctrl+i")))?.[0]
    if (!report) {
      throw new Error("XTEST modifyOtherKeys ctrl+i did not reach the app after a successful delivery control")
    }
    const observed = { mode: "modifyOtherKeys-2", control, report }
    const expected = "OS XTEST ctrl+i report under modifyOtherKeys 2 after plain-a delivery control"
    if (MODIFY_OTHER_KEYS_ENCODING.test(report)) {
      return interactionResult("modify-other-keys:ctrl+i", expected, observed)
    }
    return unsupportedInteraction("modify-other-keys:ctrl+i", expected, observed)
  })
}

async function modifyOtherKeys3(ctx: TermContext): Promise<ProbeResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage("key injection")
  const control = await deliveryControl(
    () => input.injectKey("a"),
    readInput,
    PLAIN_A,
    "XTEST delivery control failed: plain a did not reach the app",
  )
  return withModifyOtherKeys(ctx, MODIFY_OTHER_KEYS_3, async () => {
    const report = (await readInput(MODIFY_OTHER_KEYS_3_REPORT, 1000, () => input.injectKey("i")))?.[0]
    if (!report) {
      throw new Error("XTEST modifyOtherKeys unmodified i did not reach the app after a successful delivery control")
    }
    const observed = { mode: "modifyOtherKeys-3", control, report }
    const expected = "OS XTEST unmodified i report under modifyOtherKeys 3 after plain-a delivery control"
    if (MODIFY_OTHER_KEYS_ENCODING.test(report)) {
      return interactionResult("modify-other-keys-3:i", expected, observed)
    }
    return unsupportedInteraction("modify-other-keys-3:i", expected, observed)
  })
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
  const report = (await readInput(MODIFIED_KEY, 1000, () => input.injectKey("ctrl+a")))?.[0]
  if (!report) {
    throw new Error("XTEST modified key did not reach the app after a successful delivery control")
  }
  return interactionResult("xtest-key:ctrl+a", "OS XTEST ctrl+a report after plain-a delivery control", {
    control,
    report,
  })
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
