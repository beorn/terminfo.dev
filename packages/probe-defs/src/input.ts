import type {
  LibProbeSource,
  LibKeyEvent,
  LibMouseEvent,
  MeasuredProbeCallbackResult,
  ProbeDefinition,
  ProbeCallbackResult,
  TermProbeSource,
} from "./types.ts"
import {
  HEADLESS_OBSERVABLE_REVIEW,
  auditedAdapterSources,
  declaredUntestableResult,
  decrpmPs,
  decrpmReplyPattern,
  queryDecrpm,
  notTestedResult,
  osInputReviewResult,
  NO_SAME_PATH_CONTROL,
  probe,
  reportsDecidedOutcome,
  replyFailure,
  validSize,
  withUnhandledModeReport,
} from "./helpers.ts"
import { hasAuditedOscInterfaceAbsence, kittyKeyboardFlagProbe, unhandledOscReportResult } from "./extensions.ts"
import { queryPixelGeometry, type PixelGeometry } from "./region-readback.ts"

const inputDefinitions: ProbeDefinition[] = [
  {
    ...probe("input.modify-other-keys", (ctx) => modifyOtherKeysLib(ctx, 2), modifyOtherKeys2, "input_bytes"),
    libAssertionType: "input_bytes",
  },

  // Negotiation only; actual key encoding requires an input-event observation.
  kittyKeyboardFlagProbe("input.csi-u", 1, 1),

  {
    ...probe("input.pixel-mouse", (ctx) => mouseEncodingLib(ctx, "pixel"), pixelMouse, "input_bytes"),
    termNeedsGeometry: true,
  },
  probe("input.urxvt-mouse", (ctx) => mouseEncodingLib(ctx, "urxvt"), urxvtMouse, "input_bytes"),
  probe("input.x10-mouse", (ctx) => mouseEncodingLib(ctx, "x10"), x10Mouse, "input_bytes"),

  {
    ...probe("input.modify-other-keys-3", (ctx) => modifyOtherKeysLib(ctx, 3), modifyOtherKeys3, "input_bytes"),
    libAssertionType: "input_bytes",
  },

  probe("input.button-event-mouse", (ctx) => mouseEncodingLib(ctx, "button"), buttonEventMouse, "input_bytes"),

  {
    ...probe(
      "input.xtest-key",
      (ctx) => {
        const declared = NO_LIBRARY_KEY_ENCODER[ctx.backendName]
        if (declared) return declaredUntestableResult(`OS-level XTEST key injection: ${declared}`, { input: false })
        if (ctx.encodeKey) return xtestKeyLib(ctx.encodeKey)
        return headlessXtestReview("key injection", true)
      },
      xtestKey,
      "input_bytes",
    ),
    libAssertionType: "input_bytes",
  },
  probe("input.xtest-click", (ctx) => mouseEncodingLib(ctx, "click"), xtestClick, "input_bytes"),
  probe("input.xtest-wheel", (ctx) => mouseEncodingLib(ctx, "wheel"), xtestWheel, "input_bytes"),
  {
    ...probe("input.kitty-click-events", kittyClickEventsLib, kittyClickEvents, "input_bytes"),
    libAssertionType: "input_bytes",
  },
]

export const inputProbes: ProbeDefinition[] = inputDefinitions.map(withUnhandledModeReport)

const MOUSE_SET = "\x1b[?1000h\x1b[?1006h"
const MOUSE_RESET = "\x1b[?1000l\x1b[?1006l"
const PLAIN_A = /^a/
// input.xtest-key injects ctrl+e, which is neither tmux's nor Screen's prefix (#32569, @cto b9dd747c): ctrl+a is
// Screen's command key, so Screen consumed it. The modifyOtherKeys controls below still read ctrl+a.
const MODIFIED_KEY = /\x05|\x1b\[(?:27;\d+;\d+~|\d+;\d+u)/
const CTRL_E_ENCODING = /^(?:\x05|\x1b\[(?:27;5;101~|101;5u))$/
const CTRL_A_ENCODING = /^(?:\x01|\x1b\[(?:27;5;97~|97;5u))$/
const SGR_MOUSE = /\x1b\[<\d+;\d+;\d+[Mm]/
const MODIFY_OTHER_KEYS_2 = "\x1b[>4;2m"
const MODIFY_OTHER_KEYS_3 = "\x1b[>4;3m"
const MODIFY_OTHER_KEYS_RESET = "\x1b[>4;0m"
const MODIFY_OTHER_KEYS_REPORT = /\t|\x1b\[(?:27;\d+;\d+~|\d+;\d+u)/
const MODIFY_OTHER_KEYS_3_REPORT = /\x1b\[(?:27;\d+;\d+~|\d+;\d+u)|i/
const MODIFY_OTHER_KEYS_2_ENCODING = /^\x1b\[(?:27;5;105~|105;5u)$/
const MODIFY_OTHER_KEYS_3_ENCODING = /^\x1b\[(?:27;1;105~|105;1u)$/
const DECKPAM = "\x1b="
const DECKPNM = "\x1b>"
// KP_Add has no NumLock level (#32582): SS3 k under DECKPAM, + under DECKPNM. SS3 may be mixed with other replies;
// only a standalone + is the numeric keypad's answer.
const KEYPAD_ADD_REPORT = /\x1bOk|^\+$/
const KEYPAD_ADD_APPLICATION = "\x1bOk"
const KEYPAD_ADD_NUMERIC = "+"
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
const KITTY_CLICK_START = "\x1b]133;A;click_events=1\x07"
const KITTY_CLICK_END = "\x1b]133;B\x07"
const SGR_MOUSE_PRESS = /\x1b\[<\d+;\d+;\d+M/
// A drag opens with its press under 1000 as under 1002, so button-event tracking reads past it (#32582): a motion report
// (SGR Pb with bit 32 set, every such Pb in 0-255) or a release (final m), whichever comes first.
const SGR_MOTION_OR_RELEASE =
  /\x1b\[<(?:(?:3[2-9]|[45]\d|6[0-3]|9[6-9]|1[01]\d|12[0-7]|1[6-8]\d|19[01]|22[4-9]|2[34]\d|25[0-5]);\d+;\d+M|\d+;\d+;\d+m)/
const SGR_MOUSE_RELEASE = /\x1b\[<\d+;\d+;\d+m/

function xtestCoverage(kind?: string): ProbeCallbackResult {
  if (!kind) {
    // @chief ab9fa8aa: these cells are untestable. Do not add a CGEvent capture system.
    return declaredUntestableResult("real-surface input injection (XTEST/CGEvent)", { input: false })
  }
  return notTestedResult(`OS-level XTEST ${kind}`, { input: false })
}

/**
 * Declared Untestable (operator Nov 4 16:55): these libraries export no public key-event encoder, so a key event has
 * no library interface to reach. Each reason names the checked public surface (@dev/7 export audit, CTO 47010d76).
 * Backend/criterion entries declare a missing public parsed-state route or requested-level selector only for that
 * MOK criterion. Their public encoder still exists; XTEST's backend-only lookup does not select these entries.
 */
const NO_LIBRARY_KEY_ENCODER: Readonly<Record<string, string>> = {
  vt100:
    "vt100.js exports createVt100Screen and its Screen byte parser and state readers, and no key-event-to-byte encoder",
  vt220:
    "vt220.js exports createVt220Screen and its Screen byte parser and state readers, and no key-event-to-byte encoder",
  vterm:
    "vterm.js exports createVtermScreen and its Screen byte parser and state readers, and no key-event-to-byte encoder",
  xterm:
    "@xterm/headless 6.0.0 exports Terminal, whose input() takes already encoded bytes, and no public key-event encoder",
  alacritty:
    "alacritty_terminal 0.26.0 exposes terminal state and byte-oriented PTY notification, and no public key-event encoder",
  "vt100-rust":
    "the vt100 crate 0.16.2 exposes Parser and Screen state and mode serialization, and no public key-event encoder",
  "ghostty/input.modify-other-keys":
    "ghostty-web 0.4.0 public KeyEncoder exposes a modifyOtherKeys state-2 option but no public route from GhosttyTerminal's parsed modifyOtherKeys state to that option",
  "ghostty/input.modify-other-keys-3":
    "ghostty-web 0.4.0 public KeyEncoder exposes only a state-2 option, with no modifyOtherKeys level-3 selector",
  "ghostty-native/input.modify-other-keys-3":
    "Ghostty 1.3.1 (332b2aef) public input.KeyEncodeOptions carries only modify_other_keys_state_2: bool, and fromTerminal copies it from the terminal's flags. No public field or route selects modifyOtherKeys level 3",
  "kitty/input.modify-other-keys":
    "Kitty 0.49.2 (b2cb8712) public kitty.fast_data_types Screen exposes cursor_key_mode and current_key_encoding_flags(); encode_key_for_tty has no modifyOtherKeys state or level selector",
  "kitty/input.modify-other-keys-3":
    "Kitty 0.49.2 (b2cb8712) public kitty.fast_data_types Screen exposes cursor_key_mode and current_key_encoding_flags(); encode_key_for_tty has no modifyOtherKeys state or level selector",
}

/** The headless arm of an XTEST criterion: the same coverage, with the required review selected. */
function headlessXtestReview(kind: string, byDesign = false): ProbeCallbackResult {
  return osInputReviewResult(
    `OS-level XTEST ${kind}`,
    { input: false },
    byDesign
      ? "Lib arm: the engine consumes bytes and has no input surface; host input encoding is measured in the terminal arm."
      : undefined,
  )
}

/** Checked library-interface absences, not protocol support claims (#32309, CTO47010d76). */
function modifyOtherKeysLib(ctx: LibProbeSource, level: 2 | 3): ProbeCallbackResult {
  const featureId = level === 2 ? "input.modify-other-keys" : "input.modify-other-keys-3"
  const reason = NO_LIBRARY_KEY_ENCODER[`${ctx.backendName}/${featureId}`] ?? NO_LIBRARY_KEY_ENCODER[ctx.backendName]
  if (reason) {
    return declaredUntestableResult(reason, { keyEncoder: ctx.encodeKey !== undefined, requestedLevel: level })
  }
  const encode = ctx.encodeKey
  if (!encode) {
    return notTestedResult("Native key-encoding route is not qualified for this library", { keyEncoder: false })
  }
  const events = {
    a: { key: "a" },
    ctrlA: { key: "a", ctrl: true },
    ctrlI: { key: "i", ctrl: true },
    i: { key: "i" },
    arrow: { key: "ArrowUp" },
  } satisfies Record<string, LibKeyEvent>
  const sampleKey = (event: LibKeyEvent) => {
    const bytes = Array.from(encode.call(ctx, event))
    return { event, bytes, text: String.fromCharCode(...bytes) }
  }
  const sample = () => ({
    a: sampleKey(events.a),
    ctrlA: sampleKey(events.ctrlA),
    ctrlI: sampleKey(events.ctrlI),
    i: sampleKey(events.i),
    arrow: sampleKey(events.arrow),
  })
  const cursorControl = () => {
    let on: ReturnType<typeof sampleKey>
    try {
      ctx.feed("\x1b[?1h")
      on = sampleKey(events.arrow)
    } finally {
      ctx.feed("\x1b[?1l")
    }
    return { on, off: sampleKey(events.arrow) }
  }
  let cursorBefore: ReturnType<typeof cursorControl>
  let off: ReturnType<typeof sample>, on: ReturnType<typeof sample>
  try {
    cursorBefore = cursorControl()
    ctx.feed(MODIFY_OTHER_KEYS_RESET)
    off = sample()
    ctx.feed(level === 2 ? MODIFY_OTHER_KEYS_2 : MODIFY_OTHER_KEYS_3)
    on = sample()
  } finally {
    ctx.feed(MODIFY_OTHER_KEYS_RESET)
  }
  const reset = sample()
  let cursorAfter: ReturnType<typeof cursorControl>
  try {
    cursorAfter = cursorControl()
  } finally {
    ctx.feed(MODIFY_OTHER_KEYS_RESET)
  }
  const recovery = ctx.feedCapture("\x1b[6n")
  const observed = { level, off, on, reset, recovery, cursorModeControl: { before: cursorBefore, after: cursorAfter } }
  const controls = (phase: ReturnType<typeof sample>) =>
    phase.a.text === "a" && CTRL_A_ENCODING.test(phase.ctrlA.text) && /^(?:\x1b\[A|\x1bOA)$/.test(phase.arrow.text)
  if (![off, on, reset].every(controls)) return notTestedResult("Native key delivery control failed", observed)
  const logical = (text: string) => {
    const tilde = text.match(/^\x1b\[27;(\d+);(\d+)~$/)
    if (tilde) return `${Number(tilde[2])}:${Number(tilde[1])}`
    const u = text.match(/^\x1b\[(\d+);(\d+)u$/)
    return u ? `${Number(u[1])}:${Number(u[2])}` : text
  }
  const target = level === 2 ? "ctrlI" : "i"
  const before = logical(off[target].text),
    active = logical(on[target].text),
    after = logical(reset[target].text)
  const discriminator =
    (off[target].text !== on[target].text && off[target].text === reset[target].text) ||
    (["ctrlA", "ctrlI", "i"] as const).some(
      (name) =>
        logical(off[name].text) !== logical(on[name].text) && logical(off[name].text) === logical(reset[name].text),
    )
  if (!discriminator) {
    const cursorPasses = (control: ReturnType<typeof cursorControl>) =>
      control.on.text === "\x1bOA" && control.off.text === "\x1b[A"
    if (!cursorPasses(cursorBefore) || !cursorPasses(cursorAfter)) {
      return notTestedResult(
        `Native cursor-mode control failed ${!cursorPasses(cursorBefore) ? "before MOK" : "after reset"}`,
        observed,
      )
    }
    if (!/^\x1b\[\d+;\d+R$/.test(recovery)) {
      return notTestedResult("Native DSR recovery control failed after MOK reset", observed)
    }
    // xterm ctlseqs: level 2 encodes keys "including the exceptions listed" (Control-letter).
    // https://invisible-island.net/xterm/ctlseqs/ctlseqs.html (modifyOtherKeys)
    // Level 3: content/features.json input.modify-other-keys-3 cites the same source
    // and requires an encoded unmodified i (codepoint 105, modifier 1).
    const absenceKey =
      level === 2
        ? logical(off.ctrlA.text) !== "97:5"
          ? "ctrlA"
          : logical(off.ctrlI.text) !== "105:5"
            ? "ctrlI"
            : undefined
        : logical(off.i.text) !== "105:1"
          ? "i"
          : undefined
    const unchanged = (["a", "ctrlA", "ctrlI", "i", "arrow"] as const).every(
      (name) => off[name].text === on[name].text && off[name].text === reset[name].text,
    )
    if (absenceKey && unchanged) {
      const bytes = JSON.stringify(off[absenceKey].bytes)
      return unsupportedInteraction(
        `modify-other-keys-${level}:native`,
        `Native modifyOtherKeys ${level}: ${absenceKey} remains ${bytes} off/on/reset despite passing cursor-mode controls and DSR recovery`,
        { ...observed, absenceKey },
      )
    }
  }
  if (!on[target].bytes.length || !discriminator || before !== after) {
    const reason = !on[target].bytes.length
      ? "Open: with modify-other-keys on (the setting that makes keys like Ctrl+Enter send their own codes), the test key sent no bytes, so there is nothing to compare with the setting off."
      : !discriminator
        ? "Open: our test has no key that sends different codes with modify-other-keys (the setting that makes keys like Ctrl+Enter send their own codes) on and off, so it cannot tell a reset from no change."
        : "Open: after resetting modify-other-keys, the target key bytes differed from those with the mode off."
    return notTestedResult(reason, observed)
  }
  const expected = `Native modifyOtherKeys ${level} codepoint 105 modifier ${level === 2 ? 5 : 1} after same-path controls`
  const result =
    active === `105:${level === 2 ? 5 : 1}`
      ? interactionResult(`modify-other-keys-${level}:native`, expected, observed)
      : unsupportedInteraction(`modify-other-keys-${level}:native`, expected, observed)
  return {
    ...result,
    observation: {
      ...result.observation,
      ...(level === 2 && off.ctrlA.text === on.ctrlA.text && off.ctrlA.text === reset.ctrlA.text
        ? { note: `Ctrl+a stays ${JSON.stringify(off.ctrlA.bytes)} off/on/reset; xterm's level 2 changes it.` }
        : {}),
    },
    assertions: [
      {
        assertionType: "input_bytes" as const,
        kind: result.observation.outcome === "supported" ? ("positive" as const) : ("negative" as const),
        action: "native-key-controls:off/on/reset",
        expected: "criterion after plain a, Ctrl+a and ArrowUp controls on the same native path in every phase",
        observed: JSON.stringify(observed),
      },
      ...(result.assertions ?? []),
    ],
  }
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

function interactionResult(
  action: string,
  expected: string,
  observed: Record<string, unknown>,
): MeasuredProbeCallbackResult {
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
): MeasuredProbeCallbackResult {
  return {
    pass: false,
    response: JSON.stringify(observed),
    observation: { outcome: "unsupported", assertionType: "input_bytes" },
    assertions: [
      { assertionType: "input_bytes" as const, kind: "negative", expected, observed: JSON.stringify(observed), action },
    ],
  }
}

/** A report the row's criterion names as no reading: PROBE INVALID by name, with the observed bytes kept (#32582). */
function invalidInteraction(reason: string, observed: Record<string, unknown>): ProbeCallbackResult {
  return {
    pass: false,
    note: reason,
    response: JSON.stringify(observed),
    tests: [{ id: "criterion", status: "probe-invalid", reason }],
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
  if (!input || !readInput) return xtestCoverage()
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
    if (MODIFY_OTHER_KEYS_2_ENCODING.test(report)) {
      return interactionResult("modify-other-keys:ctrl+i", expected, observed)
    }
    return unsupportedInteraction("modify-other-keys:ctrl+i", expected, observed)
  })
}

async function modifyOtherKeys3(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage()
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
    if (MODIFY_OTHER_KEYS_3_ENCODING.test(report)) {
      return interactionResult("modify-other-keys-3:i", expected, observed)
    }
    return unsupportedInteraction("modify-other-keys-3:i", expected, observed)
  })
}

export async function applicationKeypad(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage()
  const control = await deliveryControl(
    () => input.injectKey("a"),
    readInput,
    PLAIN_A,
    "XTEST delivery control failed: plain a did not reach the app",
  )
  // #32582 (@cto d590724a): KP_Add, once under DECKPAM and once under DECKPNM. KP_5 was the NumLock level of its key,
  // which xterm reads in numeric mode under DECKPAM too, so its "5" decided nothing.
  const keypadAdd = async () => (await readInput(KEYPAD_ADD_REPORT, 1000, () => input.injectKey("KP_Add")))?.[0] ?? null
  ctx.write(DECKPAM)
  let application: string | null
  try {
    application = await keypadAdd()
  } finally {
    ctx.write(DECKPNM)
  }
  const numeric = await keypadAdd()
  const observed = { mode: "application-keypad", control, application, numeric }
  const expected = "OS XTEST KP_Add report as SS3 k under DECKPAM, then + under DECKPNM, after plain-a delivery control"
  if (numeric === KEYPAD_ADD_NUMERIC && application === KEYPAD_ADD_APPLICATION) {
    return interactionResult("application-keypad:KP_Add", expected, observed)
  }
  if (numeric === KEYPAD_ADD_NUMERIC && application === KEYPAD_ADD_NUMERIC) {
    return unsupportedInteraction("application-keypad:KP_Add", expected, observed)
  }
  const read = (report: string | null) => (report === null ? "no report" : JSON.stringify(report))
  return invalidInteraction(
    `modes.application-keypad: KP_Add read ${read(application)} under DECKPAM and ${read(numeric)} under DECKPNM after plain a reached the app; only SS3 k then +, or + under both, decides this row`,
    observed,
  )
}

export async function focusTracking1004(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input?.focusRoundTrip || !readInput) return xtestCoverage("owned focus roundtrip")
  const focusRoundTrip = input.focusRoundTrip.bind(input)
  const decrpm = await queryDecrpm(ctx, 1004)
  const readArm = async () => {
    let focus: Awaited<ReturnType<typeof focusRoundTrip>> | undefined
    const report =
      (
        await readInput(/^[\s\S]*a/, 1000, async () => {
          focus = await focusRoundTrip()
          await input.injectKey("a")
        })
      )?.[0] ?? null
    return { report, focus }
  }
  let enabledArm: Awaited<ReturnType<typeof readArm>>
  let enableTimeRaw: string | null
  try {
    enableTimeRaw =
      (
        await readInput(/^[\s\S]*a/, 1000, async () => {
          ctx.write("\x1b[?1004h")
          await input.injectKey("a")
        })
      )?.[0] ?? null
    enabledArm = await readArm()
  } finally {
    ctx.write("\x1b[?1004l")
  }
  const resetArm = await readArm()
  const enabled = enabledArm.report
  const reset = resetArm.report
  const enableTime = /^(\x1b\[[IO])?a$/.exec(enableTimeRaw ?? "")
  const enableTimeReport = enableTime?.[1] ?? null
  const roundTrip = enabled === "\x1b[O\x1b[Ia" ? "\x1b[O\x1b[I" : null
  const observed = {
    decrpm,
    enabled,
    reset,
    enableTimeRaw,
    enableTimeReport,
    roundTrip,
    focus: { enabled: enabledArm.focus, reset: resetArm.focus },
  }
  if (!enabledArm.focus || !resetArm.focus) {
    return invalidInteraction("Focus roundtrip did not retain its owned/root/owned X focus witness", observed)
  }
  const expected =
    "at most one separate enable-time report, then CSI O and CSI I before a with 1004 set; only a with 1004 reset"
  if (reset === "a" && enableTime && roundTrip === "\x1b[O\x1b[I") {
    return interactionResult("focus-tracking:roundtrip", expected, observed)
  }
  if (reset === "a" && enableTime && enabled === "a") {
    return unsupportedInteraction("focus-tracking:roundtrip", expected, observed)
  }
  return invalidInteraction(
    "Focus roundtrip read a wrong focus report, no plain key, or a report with 1004 reset",
    observed,
  )
}

export async function utf8Mouse1005(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  if (!input?.resizeWindow) return xtestCoverage("owned mouse position and window resize")
  const resizeWindow = input.resizeWindow.bind(input)
  const decrpm = await queryDecrpm(ctx, 1005)
  const size = async (timeout = 1000) => {
    const reply = await ctx.query("\x1b[18t", /\x1b\[8;(\d+);(\d+)t/, timeout)
    const rows = Number(reply?.[1])
    const cols = Number(reply?.[2])
    return Number.isSafeInteger(rows) && rows > 0 && Number.isSafeInteger(cols) && cols > 0 ? { rows, cols } : null
  }
  const poll = async (accept: (reading: { rows: number; cols: number }) => boolean) => {
    const deadline = Date.now() + 2000
    let count = 0
    let reading: Awaited<ReturnType<typeof size>> = null
    while (Date.now() < deadline) {
      const nextPoll = Date.now() + 100
      reading = await size(Math.max(1, Math.min(100, deadline - Date.now())))
      count++
      if (reading && accept(reading)) return { reading, count, matched: true }
      const remaining = deadline - Date.now()
      const pause = Math.min(nextPoll - Date.now(), remaining)
      if (pause > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, pause)
        })
      }
    }
    return { reading, count, matched: false }
  }
  const before = await size()
  if (!before) return invalidInteraction("UTF8 mouse needs the original CSI18t size", { decrpm, before })
  const observed: Record<string, unknown> = { decrpm, before }
  let original: { width: number; height: number } | undefined
  let restored = false
  let result: ProbeCallbackResult
  try {
    original = await resizeWindow(1400, 600)
    const resized = await poll((reading) => reading.cols > 95)
    observed.resized = resized
    if (!resized.reading) {
      result = invalidInteraction("UTF8 mouse resized-window CSI18t read is missing or invalid", observed)
    } else if (!resized.matched || resized.reading.cols <= 95) {
      const cols = resized.reading.cols
      result = invalidInteraction(
        `coordinates up to 95 encode identically in both modes and this window is ${cols} columns wide, so no click here can separate them`,
        observed,
      )
    } else {
      const readInjected = ctx.readInjected
      if (!readInjected) {
        result = invalidInteraction("UTF8 mouse needs the listener-first injected read", observed)
      } else {
        const injected = async (pattern: RegExp, timeout: number, inject: () => Promise<void>) => {
          const read = await readInjected(pattern, timeout, inject)
          return { text: read.raw, bytes: Array.from(atob(read.rawBase64), (byte) => byte.charCodeAt(0)) }
        }
        const echoed = await injected(/^a$/, 1000, () => input.injectKey("a"))
        observed.postResizeKey = echoed.text
        if (echoed.text !== "a") {
          result = invalidInteraction("post-resize key did not echo; refusing to judge mouse controls", observed)
        } else {
          result = await withMouseModes(ctx, async () => {
            ctx.write("\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1015l\x1b[?1016l")
            // A terminal may leave SGR (1006) when a sibling mouse-encoding mode is reset:
            // WezTerm answered this control in legacy X10 form after 1016l although the same
            // run's x10 control read SGR from it. Re-assert the encoding the control is judged in.
            // Ghostty, xterm and kitty also clear mouse tracking outright on 1002l/1003l rather
            // than only their motion arm, so the encoding must be re-asserted WITH normal tracking
            // or every later click is silently unreported (#32915 AC4, all three probe images).
            ctx.write("\x1b[?1000h\x1b[?1006h")
            const sgrClick = (position: { x: number; y: number }) =>
              injected(/^\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m$/, 2000, () => input.injectClick(1, position))
            // A click injected right after a resize can be dropped before the App applies the
            // mode write, and a loaded host can answer past the first read window. Retry the
            // SAME control click a bounded number of times and keep every read as evidence, so a
            // dropped click reads as harness noise instead of a terminal that cannot report it.
            const sgrPair = /^\x1b\[<0;(\d+);(\d+)M\x1b\[<0;\1;\2m$/
            const sgrClickControl = async (position: { x: number; y: number }) => {
              const attempts: string[] = []
              for (let attempt = 1; attempt <= 3; attempt++) {
                const read = await sgrClick(position)
                attempts.push(read.text)
                const matched = sgrPair.exec(read.text)
                if (matched) return { read, matched, attempts }
                if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, 150))
              }
              return { read: { text: "", bytes: [] as number[] }, matched: null, attempts }
            }
            const click = () =>
              injected(/^[\s\S]*a$/, 1000, async () => {
                await input.injectClick(1, { x: 1300, y: 120 })
                await input.injectKey("a")
              })
            const ordinary = await sgrClickControl({ x: 400, y: 300 })
            observed.ordinaryControl = ordinary.read
            observed.ordinaryAttempts = ordinary.attempts
            const ordinaryX = Number(ordinary.matched?.[1])
            const ordinaryY = Number(ordinary.matched?.[2])
            if (!ordinary.matched || ordinaryX < 1 || ordinaryX > 95 || ordinaryY < 1 || ordinaryY > 223) {
              return invalidInteraction(
                "UTF8 mouse ordinary-position SGR press/release control did not prove coordinates within columns 1 through 95",
                observed,
              )
            }
            const sensitive = await sgrClickControl({ x: 1300, y: 120 })
            const control = sensitive.read
            observed.control = control
            observed.controlAttempts = sensitive.attempts
            const sgr = sensitive.matched
            const x = Number(sgr?.[1])
            const y = Number(sgr?.[2])
            if (!sgr || x <= 95 || x > 223 || y < 1 || y > 223) {
              return invalidInteraction(
                "UTF8 mouse SGR press/release control did not prove a sensitive same-position click after the ordinary click arrived",
                observed,
              )
            }
            ctx.write("\x1b[?1006l\x1b[?1005h")
            const enabled = await click()
            ctx.write("\x1b[?1005l")
            const reset = await click()
            ctx.write("\x1b[?1000l")
            const trackingReset = await click()
            Object.assign(observed, { enabled, reset, trackingReset })
            const encoded = (utf8: boolean) => {
              const coords = utf8
                ? [...new TextEncoder().encode(String.fromCharCode(x + 32, y + 32))]
                : [x + 32, y + 32]
              return [27, 91, 77, 32, ...coords, 27, 91, 77, 35, ...coords, 97]
            }
            const same = (actual: number[], expected: number[]) =>
              actual.length === expected.length && actual.every((byte, i) => byte === expected[i])
            const expected =
              "same-position UTF8 bytes only with 1005 set, legacy bytes with it reset, and a key without tracking"
            if (!same(trackingReset.bytes, [97]) || !same(reset.bytes, encoded(false))) {
              return invalidInteraction("UTF8 mouse reset coordinate/key or tracking-reset control failed", observed)
            }
            if (same(enabled.bytes, encoded(true))) return interactionResult("utf8-mouse-1005", expected, observed)
            if (same(enabled.bytes, encoded(false))) {
              return unsupportedInteraction("utf8-mouse-1005", expected, observed)
            }
            return invalidInteraction(
              "UTF8 mouse enabled/reset encoding pair is neither UTF8/legacy nor legacy/legacy",
              observed,
            )
          })
        }
      }
    }
  } finally {
    ctx.write("\x1b[?1000l\x1b[?1005l\x1b[?1006l")
    if (original) {
      await resizeWindow(original.width, original.height)
      const restoration = await poll((reading) => reading.cols === before.cols && reading.rows === before.rows)
      observed.restoration = restoration
      restored = restoration.matched
    }
  }
  if (!restored) return invalidInteraction("UTF8 mouse original-size restoration failed", observed)
  return { ...result, response: JSON.stringify(observed) }
}

export async function mouseTracking1000(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const { input, readInput } = ctx
  if (!input || !readInput) return replyFailure("Mouse tracking effect needs owned click injection and input readback")
  const untilKey = new RegExp(`^(?:${X10_OR_SGR_MOUSE.source})*a$`)
  const readClick = async () =>
    (
      await readInput(untilKey, 1000, async () => {
        await input.injectClick(1)
        await input.injectKey("a")
      })
    )?.[0]
  const hasClick = (bytes: string | undefined) =>
    (bytes?.match(new RegExp(X10_OR_SGR_MOUSE.source, "g")) ?? []).some((report) =>
      isX10Mouse(report) ? report.charCodeAt(3) === 32 : sgrMouseButton(report) === 0 && report.endsWith("M"),
    )
  return withMouseModes(ctx, async () => {
    ctx.write("\x1b[?1002l\x1b[?1003l\x1b[?1000l")
    const reset = await readClick()
    ctx.write("\x1b[?1000h")
    const set = await readClick()
    ctx.write("\x1b[?1000l")
    const resetAgain = await readClick()
    const observed: Record<string, unknown> = { reset, set, resetAgain }
    if (!reset || !set || !resetAgain) {
      return {
        ...replyFailure("Mouse tracking effect needs plain-a delivery in every arm"),
        response: JSON.stringify(observed),
      }
    }
    if (X10_OR_SGR_MOUSE.test(reset) || X10_OR_SGR_MOUSE.test(resetAgain)) {
      return {
        ...replyFailure("Mouse tracking reset arm emitted a report, so the set/reset contrast is unqualified"),
        response: JSON.stringify(observed),
      }
    }
    const expected =
      "left-click reports only with 1000 set, plain a in every arm, and independent click delivery for a negative"
    if (hasClick(set)) return interactionResult("mouse-tracking-1000", expected, observed)
    // An absent target report is negative only when another tracking mode
    // demonstrates the same owned click path in this callback.
    ctx.write("\x1b[?1003h")
    let control: string | undefined
    try {
      control = await readClick()
    } finally {
      ctx.write("\x1b[?1003l")
    }
    observed.control = control
    if (!hasClick(control)) {
      return {
        ...replyFailure("Mouse tracking negative lacks an independent 1003 left-click delivery control"),
        response: JSON.stringify(observed),
      }
    }
    return unsupportedInteraction("mouse-tracking-1000", expected, observed)
  })
}

export async function sgrMouse1006(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const { input, readInput } = ctx
  if (!input || !readInput) return replyFailure("SGR mouse effect needs owned click injection and input readback")
  const untilKey = new RegExp(`^(?:${X10_OR_SGR_MOUSE.source})*a$`)
  return withMouseModes(ctx, async () => {
    ctx.write("\x1b[?1002l\x1b[?1003l")
    const readClick = async (enabled: boolean) => {
      ctx.write(`\x1b[?1006${enabled ? "h" : "l"}`)
      return (
        await readInput(untilKey, 1000, async () => {
          await input.injectClick(1)
          await input.injectKey("a")
        })
      )?.[0]
    }
    const reset = await readClick(false)
    const set = await readClick(true)
    const resetAgain = await readClick(false)
    const observed = { reset, set, resetAgain }
    const response = JSON.stringify(observed)
    const [offReports, onReports, restoredReports] = [reset, set, resetAgain].map((bytes) =>
      bytes?.match(new RegExp(X10_OR_SGR_MOUSE.source, "g")),
    )
    if (!offReports?.length || !onReports?.length || !restoredReports?.length) {
      return { ...replyFailure("SGR mouse effect needs click reports followed by plain a in every arm"), response }
    }
    if (!offReports.every(isX10Mouse) || !restoredReports.every(isX10Mouse)) {
      return {
        ...replyFailure("SGR mouse reset arms did not restore X10 encoding, so the contrast is unqualified"),
        response,
      }
    }
    const expected = "X10 click reports with 1006 reset, SGR with it set, then X10 again; plain a in every arm"
    return onReports.every((report) => SGR_MOUSE.test(report))
      ? interactionResult("sgr-mouse-1006", expected, observed)
      : unsupportedInteraction("sgr-mouse-1006", expected, observed)
  })
}

export async function allMotion1003(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const { input, readInput } = ctx
  const injectMove = input?.injectMove
  if (!input || !readInput || !injectMove) {
    return replyFailure("All-motion effect needs owned buttonless movement and input readback")
  }
  const geometry = ctx.captureGeometry?.geometry
  if (
    !geometry ||
    !validSize(geometry.cellWidth, 1) ||
    !validSize(geometry.cellHeight, 1) ||
    !validSize(geometry.textWidth, 3 * geometry.cellWidth) ||
    !validSize(geometry.textHeight, geometry.cellHeight)
  ) {
    return replyFailure("All-motion effect needs measured window geometry with room for two different cells")
  }
  const y = Math.floor(geometry.textHeight / 2)
  const points = [
    Math.floor(geometry.textWidth / 2 - geometry.cellWidth),
    Math.floor(geometry.textWidth / 2 + geometry.cellWidth),
  ]
  const untilKey = new RegExp(`^(?:${SGR_MOUSE.source})*a$`)
  const read = async (inject: () => Promise<void>) =>
    (
      await readInput(untilKey, 1000, async () => {
        await inject()
        await input.injectKey("a")
      })
    )?.[0]
  ctx.write("\x1b[?1002l\x1b[?1003l")
  try {
    const control = await withMouseModes(ctx, () => read(() => input.injectClick(1)))
    if (!control || !SGR_MOUSE.test(control)) {
      return replyFailure("All-motion click control did not read a 1000 mouse report followed by injected plain a")
    }
    ctx.write("\x1b[?1006h")
    const readMotion = async (enabled: boolean) => {
      ctx.write(`\x1b[?1003${enabled ? "h" : "l"}`)
      return read(async () => {
        for (const x of points) await injectMove(x, y)
      })
    }
    const reset = await readMotion(false)
    const set = await readMotion(true)
    const resetAgain = await readMotion(false)
    const observed = { control, points, y, reset, set, resetAgain }
    const response = JSON.stringify(observed)
    if (!reset || !set || !resetAgain) {
      return {
        ...replyFailure("All-motion effect did not read the ending plain-a delivery control in every arm"),
        response,
      }
    }
    if (SGR_MOUSE.test(reset) || SGR_MOUSE.test(resetAgain)) {
      return {
        ...replyFailure("All-motion reset arm emitted a mouse report, so the set/reset contrast is unqualified"),
        response,
      }
    }
    const reports = set.match(new RegExp(SGR_MOUSE.source, "g")) ?? []
    if (reports.some((report) => !isButtonEventMotion(report))) {
      return { ...replyFailure("Buttonless all-motion injection emitted a non-motion mouse report"), response }
    }
    const expected =
      "buttonless movement reports only with 1003 set, after a measured 1000 click and with plain-a delivery in every arm"
    return reports.length
      ? interactionResult("all-motion-1003", expected, observed)
      : unsupportedInteraction("all-motion-1003", expected, observed)
  } finally {
    ctx.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l")
  }
}

export async function altScroll1007(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage()
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
    const anyForm =
      "OS XTEST wheel-4 report under 1007 as CSI A or SS3 A after 1000+1006 delivery control on alt-screen"
    // #32569 (@cto third-table ruling 2026-11-06): the delivery control passed, so a silent wheel is Unsupported.
    if (!report) return unsupportedInteraction("alt-scroll-1007:4", anyForm, { mode: "1007", control, report: null })
    const observed = { mode: "1007", control, report }
    const cursorUpForm = report === "\x1b[A" ? "CSI A" : report === "\x1bOA" ? "SS3 A" : undefined
    const expected = cursorUpForm
      ? `OS XTEST wheel-4 report under 1007 as ${cursorUpForm} after 1000+1006 delivery control on alt-screen`
      : anyForm
    if (cursorUpForm) {
      return {
        ...interactionResult("alt-scroll-1007:4", expected, observed),
        observation: {
          outcome: "supported",
          assertionType: "input_bytes",
          note: `XTEST wheel-4 under alternate-scroll 1007 produced ${cursorUpForm} cursor-up input after successful 1000+1006 delivery control on alt-screen`,
        },
      }
    }
    return unsupportedInteraction("alt-scroll-1007:4", expected, observed)
  } finally {
    ctx.write(ALT_SCROLL_RESET + ALT_SCREEN_RESET)
  }
}

async function xtestKey(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage()
  const control = await deliveryControl(
    () => input.injectKey("a"),
    readInput,
    PLAIN_A,
    "XTEST delivery control failed: plain a did not reach the app",
  )
  const report = (await readInput(MODIFIED_KEY, 1000, () => input.injectKey("ctrl+e")))?.[0]
  if (!report) {
    throw new Error("XTEST modified key did not reach the app after a successful delivery control")
  }
  const observed = { control, report }
  const expected = "OS XTEST ctrl+e report after plain-a delivery control"
  return CTRL_E_ENCODING.test(report)
    ? interactionResult("xtest-key:ctrl+e", expected, observed)
    : unsupportedInteraction("xtest-key:ctrl+e", expected, observed)
}

/**
 * Library arm of input.xtest-key (#32308, @cto e4f1c5bd): the library's own key-event encoder, bound only under
 * "key-encoding", must encode plain a as "a" before its ctrl+e bytes are judged by the terminal arm's criterion.
 */
function xtestKeyLib(encodeKey: NonNullable<LibProbeSource["encodeKey"]>): ProbeCallbackResult {
  const decoder = new TextDecoder()
  const controlBytes = encodeKey({ key: "a" })
  const control = decoder.decode(controlBytes)
  if (control !== "a") {
    return notTestedResult("library key-event encoder delivery control: plain a did not encode as a", {
      control,
      controlBytes: [...controlBytes],
    })
  }
  const reportBytes = encodeKey({ key: "e", ctrl: true })
  const report = decoder.decode(reportBytes)
  const observed = { control, controlBytes: [...controlBytes], report, reportBytes: [...reportBytes] }
  const expected = "library key-event encoder ctrl+e report after plain-a control"
  return CTRL_E_ENCODING.test(report)
    ? interactionResult("xtest-key:ctrl+e", expected, observed)
    : unsupportedInteraction("xtest-key:ctrl+e", expected, observed)
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

function pixelCoordsWithin(control: string, report: string, geometry: PixelGeometry): boolean {
  const cell = sgrMouseCoords(control)
  const pixel = sgrMouseCoords(report)
  return (
    cell !== undefined &&
    pixel !== undefined &&
    pixel.x > (cell.x - 1) * geometry.cellWidth &&
    pixel.x <= cell.x * geometry.cellWidth &&
    pixel.y > (cell.y - 1) * geometry.cellHeight &&
    pixel.y <= cell.y * geometry.cellHeight
  )
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
  if (!input || !readInput) return xtestCoverage()
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
  if (!input || !readInput) return xtestCoverage()
  // #32582 (@cto d590724a): the control leaves 1000 and 1006 before mode 9 is set; with 1006 still on, a terminal
  // honouring 9 answers in SGR form.
  const control = await withMouseModes(ctx, () =>
    deliveryControl(
      () => input.injectClick(1),
      readInput,
      SGR_MOUSE,
      "XTEST delivery control failed: click under 1000+1006 did not reach the app",
    ),
  )
  ctx.write(X10_MOUSE_SET)
  try {
    const report = (await readInput(X10_OR_SGR_MOUSE, 1000, () => input.injectClick(1)))?.[0]
    const expected = "OS XTEST click report under 9 alone as CSI M plus three bytes after 1000+1006 delivery control"
    // #32569 (@cto third-table ruling 2026-11-06): the delivery control passed, so a silent click is Unsupported.
    if (!report) return unsupportedInteraction("x10-mouse:1", expected, { mode: "9", control, report: null })
    const observed = { mode: "9", control, report }
    if (isX10Mouse(report)) {
      return interactionResult("x10-mouse:1", expected, observed)
    }
    return invalidInteraction(
      "input.x10-mouse: the click under mode 9 got an SGR report with 1000 and 1006 reset, which is neither the X10 report nor its absence",
      observed,
    )
  } finally {
    ctx.write(X10_MOUSE_RESET)
  }
}

async function buttonEventMouse(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return xtestCoverage()
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
      const report = (await readInput(SGR_MOTION_OR_RELEASE, 1000, () => injectDrag(1)))?.[0]
      if (!report) {
        throw new Error(
          "XTEST 1002 button-event-mouse drag produced no SGR motion or release report after a successful 1000+1006 delivery control",
        )
      }
      const observed = { mode: "1002", control, report }
      const expected =
        "OS XTEST drag report under 1002 as SGR motion (Pb+32) before the release after 1000+1006 delivery control"
      if (report.endsWith("M") && isButtonEventMotion(report)) {
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
  if (!input || !readInput) return xtestCoverage()
  return withMouseModes(ctx, async () => {
    const control = await deliveryControl(
      () => input.injectClick(1),
      readInput,
      SGR_MOUSE,
      "XTEST delivery control failed: click under 1000+1006 did not reach the app",
    )
    const cell = sgrMouseCoords(control)
    if (
      sgrMouseButton(control) !== 0 ||
      !cell ||
      !Number.isSafeInteger(cell.x) ||
      !Number.isSafeInteger(cell.y) ||
      cell.x < 1 ||
      cell.y < 1 ||
      cell.x > ctx.cols ||
      cell.y > ctx.rows
    ) {
      return notTestedResult("pixel-mouse delivery control is not a button-1 event in a valid screen cell", { control })
    }
    const queried = await queryPixelGeometry(ctx)
    // #32569 (@cto third-table ruling 2026-11-06): a terminal that refuses CSI 16 t and 14 t (Screen) is judged with
    // this run's calibrated raster geometry (#31742), the measurement region readback uses; the refusal is retained.
    const calibrated = "missing" in queried ? ctx.captureGeometry : undefined
    const measured = calibrated ?? queried
    if ("missing" in measured) {
      return notTestedResult(`no cell geometry: ${measured.missing}`, { control, geometry: measured })
    }
    ctx.write(PIXEL_MOUSE_SET)
    try {
      const report = (await readInput(SGR_MOUSE, 1000, () => input.injectClick(1)))?.[0]
      if (!report) {
        throw new Error(
          "XTEST 1016 pixel-mouse click did not reach the app after a successful 1000+1006 delivery control",
        )
      }
      const observed = {
        mode: "1016",
        control,
        report,
        geometry: measured.geometry,
        geometrySource: measured.source,
        ...(calibrated && "missing" in queried && { queryRefusal: queried.missing }),
      }
      if (sgrMouseButton(report) !== 0) {
        return notTestedResult("pixel-mouse target is not a button-1 event", observed)
      }
      const expected = "OS XTEST click report under 1016 with pixel coordinates after 1000+1006 delivery control"
      if (pixelCoordsWithin(control, report, measured.geometry)) {
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
  if (!input || !readInput) return xtestCoverage()
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
  if (!input || !readInput) return xtestCoverage()
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
    // End any earlier prompt before checking that ordinary mouse reporting is off.
    ctx.write(`${KITTY_CLICK_END}\x1b[${point.y};1H\x1b[2K`)
    const negativeControl = (await readInput(SGR_MOUSE_PRESS, 1000, () => input.injectClick(1)))?.[0] ?? null
    if (negativeControl !== null) {
      return {
        pass: false,
        response: JSON.stringify({ ...observedBase, negativeControl, report: null }),
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "input_bytes",
          note: "An unmarked click still emitted a mouse report with mouse modes off; prompt click support is not isolated",
        },
      }
    }
    // The marker spans the click cell on the click row and leaves the cursor at the prompt end.
    const pad = " ".repeat(Math.max(0, point.x - 2))
    ctx.write(`\x1b[${point.y};1H${KITTY_CLICK_START}$ ${pad}`)
    const report = (await readInput(SGR_MOUSE_PRESS, 1000, () => input.injectClick(1)))?.[0]
    const observed = { ...observedBase, negativeControl, report: report ?? null }
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

/** Library criteria measure the same event's report encoding; OS injection stays in the terminal arm. */
function mouseEncodingLib(
  ctx: LibProbeSource,
  kind: "pixel" | "urxvt" | "x10" | "button" | "click" | "wheel",
): ProbeCallbackResult {
  if ((kind === "pixel" || kind === "urxvt") && ctx.backendName === "alacritty") {
    // NR-D: qualify the engine's DECRQM reader, independently of Termless's shared encoder.
    const target = kind === "pixel" ? 1016 : 1015
    const read = (mode: number) => ctx.feedCapture(`\x1b[?${mode}$p`)
    try {
      ctx.feed("\x1b[?1006l")
      const controlReset = read(1006)
      ctx.feed("\x1b[?1006h")
      const controlSet = read(1006)
      const unknown = read(9999)
      const targetBefore = read(target)
      ctx.feed(`\x1b[?${target}h`)
      const targetAfter = read(target)
      const observed = { controlReset, controlSet, unknown, targetBefore, targetAfter }
      const ps = (mode: number, reply: string) => decrpmPs(decrpmReplyPattern(mode).exec(reply)?.[1])
      if (
        ps(1006, controlReset) !== 2 ||
        ps(1006, controlSet) !== 1 ||
        ps(9999, unknown) !== 0 ||
        ps(target, targetBefore) !== 0 ||
        ps(target, targetAfter) !== 0
      ) {
        return notTestedResult(NO_SAME_PATH_CONTROL, observed)
      }
      const note = `DECRQM ${target} stays unrecognized after set; the same reader moves mode 1006 from reset to set and reports unknown 9999 as unrecognized`
      const response = JSON.stringify(observed)
      return {
        pass: false,
        response,
        note,
        observation: { outcome: "unsupported", assertionType: "query_reply", note },
        assertions: [
          {
            assertionType: "query_reply",
            kind: "negative",
            expected:
              kind === "pixel"
                ? "pixel-coordinate mode 1016 recognized after set"
                : "urxvt mouse mode 1015 recognized after set",
            observed: response,
          },
        ],
      }
    } finally {
      ctx.feed(`\x1b[?1006;${target}l`)
    }
  }
  if (!ctx.capabilities.extensions.has("mouse-encoding") || typeof ctx.encodeMouse !== "function") {
    return notTestedResult(
      ctx.backendName === "ghostty-native"
        ? "Open: our adapter for Ghostty's native library has no hook for sending mouse events yet."
        : `Open: our ${ctx.backendName} adapter has no hook for sending mouse events yet.`,
      {
        mouseEncoding: false,
      },
    )
  }
  const encodeMouse = ctx.encodeMouse.bind(ctx)
  const reset = "\x1b[?9;1000;1002;1003;1005;1006;1015;1016l"
  const tracking = kind === "x10" ? 9 : kind === "button" ? 1002 : 1000
  const encoding = kind === "x10" ? "" : `\x1b[?${kind === "pixel" ? 1016 : kind === "urxvt" ? 1015 : 1006}h`
  const event = {
    x: 4,
    y: 2,
    ...(kind === "pixel" ? { pixel: { x: 40, y: 24 } } : {}),
    button: kind === "wheel" ? "wheelUp" : "left",
    action: kind === "button" ? "move" : "press",
  } as const
  const expected =
    kind === "x10"
      ? "\x1b[M %#"
      : kind === "pixel"
        ? "\x1b[<0;41;25M"
        : kind === "urxvt"
          ? "\x1b[32;5;3M"
          : `\x1b[<${kind === "button" ? 32 : kind === "wheel" ? 64 : 0};5;3M`
  let held: LibMouseEvent | undefined
  let failed = false
  let primary: unknown
  const release = () => {
    if (!held) return null
    const pressed = held
    held = undefined
    return decodeMouseReport(encodeMouse({ ...pressed, action: "release" }))
  }
  const encode = (input: LibMouseEvent) => {
    if (input.button === "left" && input.action === "press") held = input
    return decodeMouseReport(encodeMouse(input))
  }
  ctx.feed(reset)
  try {
    const negativeControl = encode(event)
    if (negativeControl !== null) throw new Error("Mouse encoding emitted a report with tracking reset")
    if (release() !== null) throw new Error("Mouse encoding emitted a report with tracking reset")
    ctx.feed(`\x1b[?${tracking}h${encoding}`)
    const enabled = ctx.getMode("mouseTracking")
    if (enabled === null) {
      return notTestedResult(`adapter binding ${ctx.backendName}: mouseTracking unavailable`, { tracking: null })
    }
    if (kind === "button") encode({ ...event, x: 3, action: "press" })
    const report = encode(event)
    const observed = { tracking: enabled, negativeControl, report }
    if ((kind === "pixel" || kind === "urxvt") && ctx.backendName === "vt100-rust") {
      // A former source-negative site: shared encoder bytes are instrument output, not engine evidence (#32246).
      return notTestedResult(NO_SAME_PATH_CONTROL, observed)
    }
    if (enabled && report === expected) return interactionResult(`mouse-encoding:${kind}`, expected, observed)
    release()
    ctx.feed(reset)
    ctx.feed("\x1b[?1000h\x1b[?1006h")
    const controlTracking = ctx.getMode("mouseTracking")
    const controlReport = encode({ x: 4, y: 2, button: "left", action: "press" })
    release()
    ctx.feed(reset)
    const controlled = { ...observed, controlTracking, controlReport }
    if (controlTracking !== true || controlReport !== "\x1b[<0;5;3M") {
      return notTestedResult(NO_SAME_PATH_CONTROL, controlled)
    }
    return unsupportedInteraction(`mouse-encoding:${kind}`, expected, controlled)
  } catch (error) {
    failed = true
    primary = error
    // Termless packages/libvterm/src/backend.ts rejects pixel coordinates before native input.
    if (error instanceof Error && error.message === "libvterm mouse API has no native encoding for pixel coordinates") {
      held = undefined
      const identity = ctx.runtimeIdentity
      if (
        kind === "pixel" &&
        ctx.backendName === "libvterm" &&
        identity?.kind === "js" &&
        identity.runtimeFormat === "wasm" &&
        identity.engineVersion === "0.3.3" &&
        (identity.loadedBinary.sha256 === "3b7c02322357c00adb8addea05240d1d348d901cf6d6300c10401eb62b945fe0" ||
          auditedAdapterSources(identity, "libvtermR1"))
      ) {
        return declaredUntestableResult(
          "Untestable: libvterm's mouse functions take cell positions only, so pixel coordinates have no way in.",
          { backend: ctx.backendName, engineVersion: identity.engineVersion, wasmSha256: identity.loadedBinary.sha256 },
        )
      }
    }
    if (error instanceof Error && error.message.startsWith("mouse encoding unavailable:")) {
      // Named binding refusals reject the gesture before native button input is accepted.
      held = undefined
      return notTestedResult(
        kind === "pixel" &&
          ctx.backendName === "kitty" &&
          error.message === "mouse encoding unavailable: Kitty pixel-coordinate path is not bound"
          ? "Open: our Kitty adapter does not connect Kitty's function for mouse positions in pixels."
          : kind === "pixel" &&
              ctx.backendName === "wezterm" &&
              error.message === "mouse encoding unavailable: WezTerm pixel-coordinate path is not bound"
            ? "Open: our WezTerm adapter does not connect WezTerm's function for mouse positions in pixels."
            : `Open: our ${ctx.backendName} adapter cannot use the library's mouse-event encoder. [${error.message}; #31297]`,
        {
          mouseEncoding: true,
          unavailable: error.message,
        },
      )
    }
    throw error
  } finally {
    const failures: unknown[] = failed ? [primary] : []
    try {
      release()
    } catch (cleanup) {
      failures.push(cleanup)
    }
    try {
      ctx.feed(reset)
    } catch (cleanup) {
      failures.push(cleanup)
    }
    if (failures.length > 1) throw new AggregateError(failures, "Mouse encoding and cleanup failed")
    if (!failed && failures.length) throw failures[0]
  }
}

/**
 * @cto ce2d3969 K2 / @chief 4d98c1c0: adapters whose termless mouse-encoding path uses the shared
 * encodeMouseReport (no prompt or click_events state). Each engine carries its own verified citation
 * and review branch rather than inheriting another engine's classification:
 * - ghostty core parses OSC 133;A;click_events=1, while its WASM binding does not forward click_events
 *   and a headless library run has no pointer surface -> HEADLESS_OBSERVABLE_REVIEW (Untestable-only).
 * alacritty and vt100-rust, the former source-negative sites, return PROBE TODO with no same-path control (#32246).
 */
const SHARED_ENCODER_CLICK_EVENTS_LIMITS = new Map<
  string,
  {
    readonly branch: typeof HEADLESS_OBSERVABLE_REVIEW
    readonly limit: string
    readonly noObservable: string
  }
>([
  [
    "ghostty",
    {
      branch: HEADLESS_OBSERVABLE_REVIEW,
      limit:
        'Open: two things block this. Our test has no mouse pointer to click with, and the web build of Ghostty we test does not pass on the "click to move the cursor in a prompt" setting, though Ghostty\'s native library reads it.',
      noObservable:
        "WASM binding does not forward OSC 133 click_events and headless library context has no pointer surface",
    },
  ],
])

function kittyClickEventsLib(ctx: LibProbeSource): ProbeCallbackResult {
  const expected =
    "Click inside a main-screen OSC 133 prompt marked click_events=1 reports SGR mouse while mouse modes are off"
  // @cto routes-32 sections 3 and 4: both DEC engines list OSC 133 in their own report.
  if (ctx.backendName === "vt100" || ctx.backendName === "vt220") {
    const report = unhandledOscReportResult(
      ctx,
      KITTY_CLICK_START,
      notTestedResult(NO_SAME_PATH_CONTROL, { storedClickEvents: false }),
    )
    if (reportsDecidedOutcome(report)) return report
  }
  if (ctx.backendName === "kitty") {
    if (hasAuditedOscInterfaceAbsence(ctx, "host-effect-h4")) {
      return declaredUntestableResult(
        "Untestable: Kitty 0.49.2 keeps click_events in its C screen state and handles the click in Window, which a library run does not have.",
        { backend: ctx.backendName, storedClickEvents: false },
      )
    }
    return notTestedResult(
      "Open: our test sends clicks through Kitty's mouse-event function, which never reaches the code that handles clicks in a shell prompt, so the test cannot click a prompt.",
      {
        storedClickEvents: false,
      },
    )
  }
  if (ctx.backendName === "vterm") {
    return notTestedResult(NO_SAME_PATH_CONTROL, { storedClickEvents: false })
  }
  if (ctx.backendName === "alacritty" || ctx.backendName === "vt100-rust") {
    return notTestedResult(NO_SAME_PATH_CONTROL, { storedClickEvents: false })
  }
  // Adapters whose termless mouse path uses the shared encodeMouseReport return before encodeMouse: PROBE TODO,
  // never a source-qualified review (#32246).
  const sharedEncoderClickEventsLimit = SHARED_ENCODER_CLICK_EVENTS_LIMITS.get(ctx.backendName)
  if (sharedEncoderClickEventsLimit) {
    if (hasAuditedOscInterfaceAbsence(ctx, "ghostty-web-d2")) {
      return declaredUntestableResult(
        "Untestable: the ghostty-web 0.4.0 WASM does not keep click_events, and Surface, which acts on a click, is not in it.",
        { backend: ctx.backendName, storedClickEvents: false },
      )
    }
    return notTestedResult(sharedEncoderClickEventsLimit.limit, { storedClickEvents: false })
  }
  if (!ctx.capabilities.extensions.has("mouse-encoding") || typeof ctx.encodeMouse !== "function") {
    return notTestedResult("Open: our adapter for this library has no declared way to send mouse events.", {
      mouseEncoding: false,
    })
  }
  const encodeMouse = ctx.encodeMouse
  const cell = { x: 4, y: 2 } as const
  const targetPoint = { x: cell.x + 1, y: cell.y + 1 }
  const nonPromptCell = { x: cell.x, y: cell.y + 1 } as const
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
