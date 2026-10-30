import type { LibProbeSource, ProbeDefinition, ProbeCallbackResult, TermProbeSource } from "./types.ts"
import { notTestedResult, osInputReviewResult, probe } from "./helpers.ts"
import { kittyKeyboardFlagProbe } from "./extensions.ts"

export const inputProbes: ProbeDefinition[] = [
  probe("input.modify-other-keys", () => headlessXtestReview("key injection"), modifyOtherKeys2, "input_bytes"),

  // Negotiation only; actual key encoding requires an input-event observation.
  kittyKeyboardFlagProbe("input.csi-u", 1, 1),

  probe("input.pixel-mouse", () => headlessXtestReview("click injection"), pixelMouse, "input_bytes"),
  probe("input.urxvt-mouse", () => headlessXtestReview("click injection"), urxvtMouse, "input_bytes"),
  probe("input.x10-mouse", () => headlessXtestReview("click injection"), x10Mouse, "input_bytes"),

  probe("input.modify-other-keys-3", () => headlessXtestReview("key injection"), modifyOtherKeys3, "input_bytes"),

  probe("input.button-event-mouse", () => headlessXtestReview("click injection"), buttonEventMouse, "input_bytes"),

  probe("input.xtest-key", () => headlessXtestReview("key injection"), xtestKey, "input_bytes"),
  probe("input.xtest-click", () => headlessXtestReview("click injection"), xtestClick, "input_bytes"),
  probe("input.xtest-wheel", () => headlessXtestReview("wheel injection"), xtestWheel, "input_bytes"),
  {
    ...probe("input.kitty-click-events", kittyClickEventsLib, kittyClickEvents, "input_bytes"),
    libAssertionType: "input_bytes",
  },
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
const DECKPAM = "\x1b="
const DECKPNM = "\x1b>"
const APPLICATION_KEYPAD_REPORT = /^(?:\x1bOu|5)$/
const APPLICATION_KEYPAD_ENCODING = /^\x1bOu$/
const PIXEL_MOUSE_SET = "\x1b[?1016h"
const PIXEL_MOUSE_RESET = "\x1b[?1016l"
const URXVT_MOUSE_SET = "\x1b[?1015h"
const URXVT_MOUSE_RESET = "\x1b[?1015l"
const URXVT_OR_SGR_MOUSE = /\x1b\[(?:<\d+;\d+;\d+[Mm]|\d+;\d+;\d+M)/
const URXVT_MOUSE = /^\x1b\[\d+;\d+;\d+M/
const X10_MOUSE_SET = "\x1b[?9h"
const X10_MOUSE_RESET = "\x1b[?9l"
const X10_OR_SGR_MOUSE = /\x1b\[(?:<\d+;\d+;\d+[Mm]|M[\s\S]{3})/
const X10_MOUSE = /^\x1b\[M[\s\S]{3}/
const BUTTON_EVENT_MOUSE_SET = "\x1b[?1002h"
const BUTTON_EVENT_MOUSE_RESET = "\x1b[?1002l"
const ALT_SCREEN_SET = "\x1b[?1049h"
const ALT_SCREEN_RESET = "\x1b[?1049l"
const ALT_SCROLL_SET = "\x1b[?1007h"
const ALT_SCROLL_RESET = "\x1b[?1007l"
const ALT_SCROLL_OR_SGR = /\x1b(?:\[(?:<\d+;\d+;\d+[Mm]|[AB])|O[AB])/
const ALT_SCROLL_ENCODING = /^\x1b\[A$/
const KITTY_CLICK_START = "\x1b]133;A;click_events=1\x07"
const KITTY_CLICK_END = "\x1b]133;B\x07"
const SGR_MOUSE_PRESS = /\x1b\[<\d+;\d+;\d+M/
const SGR_MOUSE_RELEASE = /\x1b\[<\d+;\d+;\d+m/

function xtestCoverage(kind: string): ProbeCallbackResult {
  return notTestedResult(`OS-level XTEST ${kind}`, { input: false })
}

/** The headless arm of an XTEST criterion: the same coverage, with the required review selected. */
function headlessXtestReview(kind: string): ProbeCallbackResult {
  return osInputReviewResult(`OS-level XTEST ${kind}`, { input: false })
}

async function deliveryControl(
  inject: () => Promise<void>,
  read: NonNullable<TermProbeSource["readInput"]>,
  pattern: RegExp,
  message: string,
): Promise<string> {
  const report = (await read(pattern, 1000, inject))?.[0]
  if (!report) throw new Error(message)
  return report
}

function interactionResult(action: string, expected: string, observed: Record<string, unknown>): ProbeCallbackResult {
  return {
    pass: true,
    response: JSON.stringify(observed),
    observation: { outcome: "supported", assertionType: "input_bytes" },
    assertions: [
      { assertionType: "input_bytes" as const, kind: "positive", expected, observed: JSON.stringify(observed), action },
    ],
  }
}

function unsupportedInteraction(
  action: string,
  expected: string,
  observed: Record<string, unknown>,
): ProbeCallbackResult {
  return {
    pass: false,
    response: JSON.stringify(observed),
    observation: { outcome: "unsupported", assertionType: "input_bytes" },
    assertions: [
      { assertionType: "input_bytes" as const, kind: "negative", expected, observed: JSON.stringify(observed), action },
    ],
  }
}

async function withModifyOtherKeys<T>(ctx: TermProbeSource, enable: string, work: () => Promise<T>): Promise<T> {
  ctx.write(enable)
  try {
    return await work()
  } finally {
    ctx.write(MODIFY_OTHER_KEYS_RESET)
  }
}

async function modifyOtherKeys2(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
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

async function modifyOtherKeys3(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
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

export async function applicationKeypad(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage("key injection")
  const control = await deliveryControl(
    () => input.injectKey("a"),
    readInput,
    PLAIN_A,
    "XTEST delivery control failed: plain a did not reach the app",
  )
  ctx.write(DECKPAM)
  try {
    const report = (await readInput(APPLICATION_KEYPAD_REPORT, 1000, () => input.injectKey("KP_5")))?.[0]
    if (!report) {
      throw new Error("XTEST application keypad KP_5 did not reach the app after a successful delivery control")
    }
    const observed = { mode: "application-keypad", control, report }
    const expected = "OS XTEST KP_5 report as SS3 u under DECKPAM after plain-a delivery control"
    if (APPLICATION_KEYPAD_ENCODING.test(report)) {
      return interactionResult("application-keypad:KP_5", expected, observed)
    }
    return unsupportedInteraction("application-keypad:KP_5", expected, observed)
  } finally {
    ctx.write(DECKPNM)
  }
}

export async function altScroll1007(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage("wheel injection")
  const control = await withMouseModes(ctx, async () =>
    deliveryControl(
      () => input.injectClick(1),
      readInput,
      SGR_MOUSE,
      "XTEST delivery control failed: click under 1000+1006 did not reach the app",
    ),
  )
  ctx.write(ALT_SCREEN_SET + ALT_SCROLL_SET)
  try {
    const report = (await readInput(ALT_SCROLL_OR_SGR, 1000, () => input.injectClick(4)))?.[0]
    if (!report) {
      throw new Error("XTEST 1007 alt-scroll wheel did not reach the app after a successful 1000+1006 delivery control")
    }
    const observed = { mode: "1007", control, report }
    const expected = "OS XTEST wheel-4 report under 1007 as CSI A after 1000+1006 delivery control on alt-screen"
    if (ALT_SCROLL_ENCODING.test(report)) {
      return interactionResult("alt-scroll-1007:4", expected, observed)
    }
    return unsupportedInteraction("alt-scroll-1007:4", expected, observed)
  } finally {
    ctx.write(ALT_SCROLL_RESET + ALT_SCREEN_RESET)
  }
}

async function xtestKey(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
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

async function withMouseModes<T>(ctx: TermProbeSource, work: () => Promise<T>): Promise<T> {
  ctx.write(MOUSE_SET)
  try {
    return await work()
  } finally {
    ctx.write(MOUSE_RESET)
  }
}

function sgrMouseCoords(report: string): { x: number; y: number } | undefined {
  const match = /^\x1b\[<\d+;(\d+);(\d+)[Mm]/.exec(report)
  if (!match) return undefined
  return { x: Number(match[1]), y: Number(match[2]) }
}

function pixelCoordsDistinct(control: string, report: string): boolean {
  const cell = sgrMouseCoords(control)
  const pixel = sgrMouseCoords(report)
  return cell !== undefined && pixel !== undefined && (pixel.x !== cell.x || pixel.y !== cell.y)
}

function isUrxvtMouse(report: string): boolean {
  return URXVT_MOUSE.test(report)
}

function isX10Mouse(report: string): boolean {
  return X10_MOUSE.test(report)
}

function sgrMouseButton(report: string): number | undefined {
  const match = /^\x1b\[<(\d+);\d+;\d+[Mm]/.exec(report)
  if (!match) return undefined
  return Number(match[1])
}

function isButtonEventMotion(report: string): boolean {
  const button = sgrMouseButton(report)
  return button !== undefined && (button & 32) !== 0
}

async function urxvtMouse(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
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
    ctx.write(URXVT_MOUSE_SET)
    try {
      const report = (await readInput(URXVT_OR_SGR_MOUSE, 1000, () => input.injectClick(1)))?.[0]
      if (!report) {
        throw new Error(
          "XTEST 1015 urxvt-mouse click did not reach the app after a successful 1000+1006 delivery control",
        )
      }
      const observed = { mode: "1015", control, report }
      const expected = "OS XTEST click report under 1015 as CSI btn;x;yM without < after 1000+1006 delivery control"
      if (isUrxvtMouse(report)) {
        return interactionResult("urxvt-mouse:1", expected, observed)
      }
      return unsupportedInteraction("urxvt-mouse:1", expected, observed)
    } finally {
      ctx.write(URXVT_MOUSE_RESET)
    }
  })
}

async function x10Mouse(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
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
    ctx.write(X10_MOUSE_SET)
    try {
      const report = (await readInput(X10_OR_SGR_MOUSE, 1000, () => input.injectClick(1)))?.[0]
      if (!report) {
        throw new Error("XTEST 9 x10-mouse click did not reach the app after a successful 1000+1006 delivery control")
      }
      const observed = { mode: "9", control, report }
      const expected = "OS XTEST click report under 9 as CSI M plus three bytes after 1000+1006 delivery control"
      if (isX10Mouse(report)) {
        return interactionResult("x10-mouse:1", expected, observed)
      }
      return unsupportedInteraction("x10-mouse:1", expected, observed)
    } finally {
      ctx.write(X10_MOUSE_RESET)
    }
  })
}

async function buttonEventMouse(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage("click injection")
  const injectDrag = input.injectDrag
  if (!injectDrag) return xtestCoverage("drag injection")
  return withMouseModes(ctx, async () => {
    const control = await deliveryControl(
      () => input.injectClick(1),
      readInput,
      SGR_MOUSE,
      "XTEST delivery control failed: click under 1000+1006 did not reach the app",
    )
    ctx.write(BUTTON_EVENT_MOUSE_SET)
    try {
      const report = (await readInput(SGR_MOUSE, 1000, () => injectDrag(1)))?.[0]
      if (!report) {
        throw new Error(
          "XTEST 1002 button-event-mouse drag did not reach the app after a successful 1000+1006 delivery control",
        )
      }
      const observed = { mode: "1002", control, report }
      const expected = "OS XTEST drag report under 1002 as SGR motion (Pb+32) after 1000+1006 delivery control"
      if (isButtonEventMotion(report)) {
        return interactionResult("button-event-mouse:1", expected, observed)
      }
      return unsupportedInteraction("button-event-mouse:1", expected, observed)
    } finally {
      ctx.write(BUTTON_EVENT_MOUSE_RESET)
    }
  })
}

async function pixelMouse(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
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
    ctx.write(PIXEL_MOUSE_SET)
    try {
      const report = (await readInput(SGR_MOUSE, 1000, () => input.injectClick(1)))?.[0]
      if (!report) {
        throw new Error(
          "XTEST 1016 pixel-mouse click did not reach the app after a successful 1000+1006 delivery control",
        )
      }
      const observed = { mode: "1016", control, report }
      const expected = "OS XTEST click report under 1016 with pixel coordinates after 1000+1006 delivery control"
      if (pixelCoordsDistinct(control, report)) {
        return interactionResult("pixel-mouse:1", expected, observed)
      }
      return unsupportedInteraction("pixel-mouse:1", expected, observed)
    } finally {
      ctx.write(PIXEL_MOUSE_RESET)
    }
  })
}

async function xtestClick(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
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
    const expected = "OS XTEST button-1 report under 1000+1006 after same-run control click"
    const observed = {
      mode: "1000+1006",
      control,
      report,
    }
    return /^\x1b\[<0;\d+;\d+[Mm]$/.test(report)
      ? interactionResult("xtest-click:1", expected, observed)
      : unsupportedInteraction("xtest-click:1", expected, observed)
  })
}

async function xtestWheel(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
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
    const expected = "OS XTEST wheel-4 report under 1000+1006 after same-run control click"
    const observed = {
      mode: "1000+1006",
      control,
      report,
    }
    return /^\x1b\[<64;\d+;\d+M$/.test(report)
      ? interactionResult("xtest-wheel:4", expected, observed)
      : unsupportedInteraction("xtest-wheel:4", expected, observed)
  })
}

/**
 * Kitty shell-integration click events: mark a prompt with click_events=1 and click inside it.
 * The same-run 1000+1006 delivery control proves the pointer is over the app and records the
 * click cell, so the marker is placed under that exact cell; mouse modes are then off, leaving
 * the click-events path as the only way a report can arrive. Kitty only treats a click as a
 * prompt click on the main linebuf at the current visible prompt (screen.c, mouse.c), so no
 * alternate screen is used and the cursor is left on the prompt; the written row is cleared
 * afterwards. The control click's release is drained and the target report must correlate with
 * the control's button and cell, so an arbitrary SGR report is never read as prompt support.
 */
async function kittyClickEvents(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage("click injection")
  const control = await withMouseModes(ctx, () =>
    deliveryControl(
      () => input.injectClick(1),
      readInput,
      SGR_MOUSE,
      "OS click delivery control failed: click under 1000+1006 did not reach the app",
    ),
  )
  const point = sgrMouseCoords(control)
  if (!point) throw new Error(`click delivery control ${JSON.stringify(control)} carries no SGR cell coordinates`)
  // Attach the listener with a no-op inject so a release already in flight is consumed, not injected.
  await readInput(SGR_MOUSE_RELEASE, 300, async () => {})
  const expected =
    "Click inside a main-screen OSC 133 prompt marked click_events=1 reports SGR mouse while mouse modes are off"
  const observedBase = { marker: "OSC 133;A;click_events=1", control, pointer: point }
  try {
    // The marker spans the click cell on the click row and leaves the cursor at the prompt end.
    const pad = " ".repeat(Math.max(0, point.x - 2))
    ctx.write(`\x1b[${point.y};1H${KITTY_CLICK_START}$ ${pad}`)
    const report = (await readInput(SGR_MOUSE_PRESS, 1000, () => input.injectClick(1)))?.[0]
    const observed = { ...observedBase, report: report ?? null }
    if (!report) return unsupportedInteraction("kitty-click-events:1", expected, observed)
    const reported = sgrMouseCoords(report)
    if (sgrMouseButton(report) !== 0 || !reported || reported.x !== point.x || reported.y !== point.y) {
      return {
        pass: false,
        response: JSON.stringify(observed),
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "input_bytes",
          note: "A click report arrived but did not correlate with the control click's button and cell",
        },
      }
    }
    return interactionResult("kitty-click-events:1", expected, observed)
  } finally {
    ctx.write(`${KITTY_CLICK_END}\x1b[${point.y};1H\x1b[2K\x1b[H`)
  }
}

function decodeMouseReport(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

function kittyClickEventsLib(ctx: LibProbeSource): ProbeCallbackResult {
  if (!ctx.capabilities.extensions.has("mouse-encoding") || typeof ctx.encodeMouse !== "function") {
    return notTestedResult("library mouse-event encoding (undeclared mouse-encoding extension)", {
      mouseEncoding: false,
    })
  }
  const encodeMouse = ctx.encodeMouse
  const cell = { x: 4, y: 2 } as const
  const targetPoint = { x: cell.x + 1, y: cell.y + 1 }
  const nonPromptCell = { x: cell.x, y: cell.y + 1 } as const
  const expected =
    "Click inside a main-screen OSC 133 prompt marked click_events=1 reports SGR mouse while mouse modes are off"
  const csi = MOUSE_SET.slice(0, 2)
  ctx.feed(MOUSE_SET)
  let control: string | null = null
  let controlCompleted = false
  try {
    control = decodeMouseReport(encodeMouse({ x: cell.x, y: cell.y, button: "left", action: "press" }))
    if (control === null) {
      const observed = { marker: "OSC 133;A;click_events=1", control: null, pointer: targetPoint, report: null }
      return {
        pass: false,
        response: JSON.stringify(observed),
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "input_bytes",
          note: "Library mouse encoding delivery control under 1000+1006 returned null",
        },
      }
    }
    const point = sgrMouseCoords(control)
    if (
      !point ||
      !SGR_MOUSE_PRESS.test(control) ||
      sgrMouseButton(control) !== 0 ||
      point.x !== targetPoint.x ||
      point.y !== targetPoint.y
    ) {
      throw new Error(`click delivery control ${JSON.stringify(control)} carries no SGR cell coordinates`)
    }
    encodeMouse({ x: cell.x, y: cell.y, button: "left", action: "release" })
    controlCompleted = true
  } finally {
    if (!controlCompleted) {
      ctx.feed(MOUSE_RESET)
    }
  }
  try {
    const observedBase = { marker: "OSC 133;A;click_events=1", control, pointer: targetPoint }
    const pad = " ".repeat(Math.max(0, targetPoint.x - 2))
    ctx.feed(`${csi}${String(targetPoint.y)};1H${KITTY_CLICK_START}$ ${pad}`)
    ctx.feed(MOUSE_RESET)
    const negativeControl = decodeMouseReport(
      encodeMouse({ x: nonPromptCell.x, y: nonPromptCell.y, button: "left", action: "press" }),
    )
    if (negativeControl !== null) {
      const observed = { ...observedBase, negativeControl, report: null }
      return {
        pass: false,
        response: JSON.stringify(observed),
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "input_bytes",
          note: "Negative control outside the marked prompt still emitted a mouse report after 1000+1006 reset (mouse modes still active)",
        },
      }
    }
    const report = decodeMouseReport(encodeMouse({ x: cell.x, y: cell.y, button: "left", action: "press" }))
    const observed = { ...observedBase, negativeControl: null, report }
    if (report === null) return unsupportedInteraction("kitty-click-events:1", expected, observed)
    encodeMouse({ x: cell.x, y: cell.y, button: "left", action: "release" })
    const reported = sgrMouseCoords(report)
    if (
      !SGR_MOUSE_PRESS.test(report) ||
      sgrMouseButton(report) !== 0 ||
      !reported ||
      reported.x !== targetPoint.x ||
      reported.y !== targetPoint.y
    ) {
      return {
        pass: false,
        response: JSON.stringify(observed),
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "input_bytes",
          note: "A click report arrived but did not correlate with the control click's button and cell",
        },
      }
    }
    return interactionResult("kitty-click-events:1", expected, observed)
  } finally {
    ctx.feed(`${KITTY_CLICK_END}${csi}${String(targetPoint.y)};1H${csi}2K${csi}H${MOUSE_RESET}`)
  }
}
