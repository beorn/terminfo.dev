/**
 * The one place a public card words its evidence (#37341; @cto b8e68da0, 0e2bbcf6, @cpo/term b5346b67).
 *
 * A run's stored record goes in; one or two plain sentences come out, built from the record's own values at
 * trace build time (run-trace.ts `currentTrace`). The evidence kinds are a closed set with one template each.
 * An unknown kind, or a field a template needs that the record does not hold, throws and names the probe id
 * and the kind: there is no fallback text and no placeholder.
 *
 * What a sentence may show is positive and per feature (`REPLY_SHAPES`, `APP_STATE_READS`, `OBSERVED_SHAPES`,
 * `ENVIRONMENT_READS`). A value is shown only when the probe wrote it (its nonce or its own test text) or when it
 * matches a shape declared for its feature. Any other value is described in words, with its size, and never
 * shown. A value whose feature declares no shape at all fails the build.
 */
import { createHash } from "node:crypto"
import type { ProbeStatus } from "../../packages/probe-defs/src/types.ts"
import { formatControlBytes } from "./evidence-reader.ts"

/** The closed set of evidence kinds. Each has exactly one template in `TEMPLATES`. */
export const EVIDENCE_KINDS = [
  "byte-reply",
  "no-reply",
  "environment",
  "screen",
  "text-readback",
  "app-state",
  "notification",
  "untestable",
  "library-state",
] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** A value on a card: shown as written, or described by its size because no declared shape admits it. */
export type CardValue = { shown: string } | { withheld: { bytes: number; ours: false } } | { absent: true }

export interface Region {
  top: number
  left: number
  bottom: number
  right: number
}

/** A query wait the terminal did not answer. Older runs kept no time limit for a timed-out read. */
export type Wait = { kind: "fence"; graceMs: number } | { kind: "limit"; ms?: number }

export type EvidenceFacts =
  | { kind: "byte-reply"; queries: number; replies: CardValue[]; silent: Wait[] }
  | { kind: "no-reply"; queries: number; waits: Wait[]; readOnly: boolean }
  | {
      kind: "environment"
      variable: string
      launcher: "terminal" | "multiplexer"
      fresh: boolean
      value: CardValue
    }
  | {
      kind: "screen" | "text-readback"
      region?: Region
      outcome: "unchanged" | "expected" | "plain" | "changed" | "held" | "failed"
      /** Where a text read came from: the app's own text snapshot (macOS) or the console host's buffer (Windows). */
      reader?: "app snapshot" | "console host"
    }
  | { kind: "app-state"; read: "readings"; surface: string; readings: Array<{ label: string; value: CardValue }> }
  | { kind: "app-state"; read: "sequence"; surface: string; set: number; matched: number; after: CardValue }
  | { kind: "app-state"; read: "counts"; surface: string; counts: Array<{ label: string; lines: number }> }
  | { kind: "app-state"; read: "outer-log"; command: string; control: string; sent: boolean; controlArrived: boolean }
  | { kind: "app-state"; read: "state"; target: "unchanged" | "expected" | "other"; control: "worked" | "failed" }
  | { kind: "app-state"; read: "report"; code: string; listed: boolean; controlListed: boolean }
  | { kind: "notification"; text: CardValue; delivered: boolean; deadlineMs: number }
  | { kind: "untestable"; sent: number; answered: number; reasonCode?: string }
  | { kind: "library-state"; state: CardValue | { block: true } }

/** One stored query as the run kept it (read windows are never read here). */
export interface StoredQuery {
  sequence: string
  reason?: string
  match?: string[] | null
  timeoutMs?: number
  sentinel?: { graceMs?: number } | null
}

/** One result's stored record: everything a template may read, nothing it may print without a shape. */
export interface StoredEvidence {
  runId: string
  featureId: string
  subjectKind: string
  /** The subject's operating system, as the run recorded it. */
  os: string | null
  status: ProbeStatus
  assertionType?: string
  reasonCode?: string
  /** The kinds of the frames the result cites (`pixels`, `text-cells`). */
  frameKinds: readonly string[]
  /** The stored exchange: what the probe wrote and asked. */
  writes: readonly string[]
  queries: readonly StoredQuery[]
  /** Other stored keys of the exchange (captures, clipboard, titleReads). */
  exchangeExtra: Readonly<Record<string, unknown>>
  /** The parsed `<feature>.callbackResponse`, when the run stored one. */
  callback?: unknown
  /** A headless library's parser state, read windows removed. */
  parserState?: unknown
  assertions: ReadonlyArray<{ kind: string; expected: string; observed: string }>
}

function fail(stored: Pick<StoredEvidence, "featureId" | "runId">, kind: string, what: string): never {
  throw new Error(`evidence for ${stored.featureId} (kind ${kind}) in run ${stored.runId}: ${what}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function at(value: unknown, path: string): unknown {
  let node = value
  for (const key of path.split(".")) {
    if (!isRecord(node)) return undefined
    node = node[key]
  }
  return node
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const bytes = (text: string) => new TextEncoder().encode(text).length
const withheld = (text: string): CardValue => ({ withheld: { bytes: bytes(text), ours: false } })

// ---------------------------------------------------------------------------------------------------------
// What a card may show (@cto 0e2bbcf6): positive, per feature.
// ---------------------------------------------------------------------------------------------------------

/**
 * Closed control-reply grammar: CSI reports, SS3 keys, DECRQSS/DECCKSR status strings, OSC colour, pointer-shape
 * and number reports, iTerm2 cell-size and capability reports, X10 mouse reports, and at most two typed characters (a key the probe pressed). Titles,
 * paths, clipboard text, unit IDs and free text do not fit.
 */
const CONTROL_TOKEN = new RegExp(
  [
    // X10 mouse first: its three coordinate bytes follow a final byte a CSI report would end on.
    /\x1b\[M[\s\S]{3}/.source,
    /\x1b\[[<=>?]?[0-9;:]*[ -/]*[@-~]/.source,
    /\x1bO[@-~]/.source,
    /\x1bP[0-9]{0,3}(?:\$r(?:[0-9;:]*[ -/]*[@-~]){0,3}|!~[0-9A-Fa-f]*)\x1b\\/.source,
    /\x1b\][0-9]+(?:;[0-9]+)?;(?:[a-z_]+=)?(?:rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}|#[0-9a-fA-F]{3,12})(?:\x07|\x1b\\)/
      .source,
    /\x1b\][0-9]+(?:;[0-9.]+)*(?:\x07|\x1b\\)/.source,
    /\x1b\]22;[a-z_-]{1,24}(?:\x07|\x1b\\)/.source,
    /\x1b\]1337;(?:ReportCellSize=[0-9.;]{1,32}|Capabilities=[A-Za-z0-9]{1,64})(?:\x07|\x1b\\)/.source,
  ].join("|"),
  "y",
)
const TYPED = /[\x01-\x1a\x7f -~]/y

function isControlReply(text: string): boolean {
  if (text === "") return false
  let index = 0
  let typed = 0
  while (index < text.length) {
    CONTROL_TOKEN.lastIndex = index
    const token = CONTROL_TOKEN.exec(text)
    if (token) {
      index += token[0].length
      continue
    }
    TYPED.lastIndex = index
    if (!TYPED.exec(text) || (typed += 1) > 2) return false
    index += 1
  }
  return true
}

const hexText = (hex: string) =>
  hex.length % 2 === 0 && /^[0-9A-Fa-f]*$/.test(hex) ? Buffer.from(hex, "hex").toString("latin1") : undefined
const printable = (text: string, max: number) => text.length <= max && /^[ -~]*$/.test(text)

/** The nonce a clipboard probe wrote, proven equal by the stored clipboard-write digest or length. */
function isOurClipboardNonce(text: string, stored: StoredEvidence, pattern: RegExp): boolean {
  if (!pattern.test(text)) return false
  const events = stored.exchangeExtra.clipboard
  if (!Array.isArray(events)) return false
  return events.some(
    (event) =>
      isRecord(event) &&
      event.kind === "clipboard-write" &&
      (typeof event.sha256 === "string" ? event.sha256 === sha256(text) : event.length === bytes(text)),
  )
}

const wroteIt = (text: string, stored: StoredEvidence) =>
  text !== "" && [...stored.writes, ...stored.queries.map((query) => query.sequence)].some((w) => w.includes(text))

type ShapeCheck = (reply: string, stored: StoredEvidence) => CardValue | undefined

/** Each shape returns the value a card shows, or undefined when the reply does not fit. */
const SHAPES = {
  control: (reply) => (isControlReply(reply) ? { shown: formatControlBytes(reply) } : undefined),
  /** XTVERSION: a name and a version only. */
  xtversion: (reply) => {
    const body = /^\x1bP>\|([ -~]{1,64})\x1b\\$/.exec(reply)?.[1]
    return body && /^[A-Za-z][A-Za-z0-9._+-]*(?: |\()[0-9A-Za-z][0-9A-Za-z._+~-]*\)?$/.test(body)
      ? { shown: body }
      : undefined
  },
  /** XTGETTCAP: the capability name and its value. */
  xtgettcap: (reply) => {
    const found = /^\x1bP([01])\+r([0-9A-Fa-f]+)(?:=([0-9A-Fa-f]*))?\x1b\\$/.exec(reply)
    const name = found?.[2] === undefined ? undefined : hexText(found[2])
    const value = found?.[3] === undefined ? "" : hexText(found[3])
    if (!found || !name || !/^[A-Za-z0-9_]{1,16}$/.test(name) || value === undefined || !printable(value, 64)) {
      return undefined
    }
    if (value.includes("/")) return undefined
    return { shown: found[1] === "1" ? `${name}=${value}` : `${name} (not known to the terminal)` }
  },
  /** XTGETXRES: the resource name and its value, never a path. */
  xtgetxres: (reply) => {
    const found = /^\x1bP([01])\+R([0-9A-Fa-f]+)(?:=([0-9A-Fa-f]*))?\x1b\\$/.exec(reply)
    const name = found?.[2] === undefined ? undefined : hexText(found[2])
    const value = found?.[3] === undefined ? "" : hexText(found[3])
    if (!found || !name || !/^[A-Za-z0-9_.*]{1,40}$/.test(name) || value === undefined || !printable(value, 64)) {
      return undefined
    }
    if (value.includes("/")) return undefined
    return { shown: found[1] === "1" ? `${name}: ${value}` : `${name} (not set)` }
  },
  /** OSC 52: only our own nonce comes back on a card. */
  osc52: (reply, stored) => {
    const payload = /^\x1b\]52;[cps0-7]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)$/.exec(reply)?.[1]
    if (payload === undefined) return undefined
    const text = Buffer.from(payload, "base64").toString("utf8")
    return isOurClipboardNonce(text, stored, /^terminfo-osc52-[0-9a-f-]{36}$/) ? { shown: text } : undefined
  },
  /** Kitty graphics: an OK acknowledgement with numeric ids only; error text is never shown. */
  "kitty-graphics": (reply) =>
    /^\x1b_G(?:[a-zA-Z]=[0-9]+,?)*;OK\x1b\\$/.test(reply) ? { shown: formatControlBytes(reply) } : undefined,
  /** A paste of our own clipboard nonce, bare or inside bracketed-paste markers. */
  "pasted-nonce": (reply, stored) => {
    const text = /^(?:\x1b\[200~)?(terminfo-paste-[0-9a-f-]{36})(?:\x1b\[201~)?$/.exec(reply)?.[1]
    return text && isOurClipboardNonce(text, stored, /^terminfo-paste-[0-9a-f-]{36}$/)
      ? { shown: formatControlBytes(reply) }
      : undefined
  },
  /** OSC 99 capability report: the id is the one the probe wrote; the rest is a closed key list. */
  "kitty-notify": (reply, stored) => {
    const found = /^\x1b\]99;i=([0-9a-f-]{1,64}):p=\?;[a-z0-9=,:;?]{0,300}(?:\x07|\x1b\\)$/.exec(reply)
    return found && wroteIt(`i=${found[1]}`, stored) ? { shown: formatControlBytes(reply) } : undefined
  },
  /** A title or icon reply: shown only when it is text this probe wrote. */
  "probe-text": (reply, stored) => {
    const title = /^\x1b\][lL]([ -~]*)\x1b\\$/.exec(reply)?.[1]
    return title !== undefined && wroteIt(title, stored) ? { shown: formatControlBytes(reply) } : undefined
  },
} satisfies Record<string, ShapeCheck>
export type ReplyShape = keyof typeof SHAPES

const group = (shapes: readonly ReplyShape[], ids: readonly string[]) =>
  Object.fromEntries(ids.map((id) => [id, shapes])) as Record<string, readonly ReplyShape[]>

/**
 * The reply shapes each feature may show. The control group is the 2026-10-21 closed-grammar census (226 ids,
 * @cto review 758fe191) that run-trace.ts held as REPLY_LIST; it is now checked value by value. An empty list
 * means the feature's replies are always described, never shown. A live reply on a feature with no entry fails
 * the build.
 */
export const REPLY_SHAPES: Readonly<Record<string, readonly ReplyShape[]>> = {
  ...group(
    ["control"],
    [
      "charsets.dec-line-drawing",
      "charsets.dec-special",
      "charsets.g0-g1-switching",
      "charsets.utf8",
      "cursor.ansi-restore",
      "cursor.ansi-save",
      "cursor.cpl",
      "cursor.cud-past-bottom",
      "cursor.cup-boundaries",
      "cursor.cup-scroll-region",
      "cursor.cuu-past-top",
      "cursor.hide",
      "cursor.horizontal-absolute",
      "cursor.hpa",
      "cursor.move.absolute",
      "cursor.move.back",
      "cursor.move.down",
      "cursor.move.forward",
      "cursor.move.home",
      "cursor.move.up",
      "cursor.next-line",
      "cursor.position-report",
      "cursor.reverse-wrap",
      "cursor.save-restore",
      "cursor.shape",
      "cursor.vpa",
      "device.decrpm",
      "device.decrqss",
      "device.dsr-996-color-scheme",
      "device.primary-da",
      "device.secondary-da",
      "device.status-report",
      "device.xtreportcolors",
      "device.xtwinops-14",
      "device.xtwinops-16",
      "device.xtwinops-18",
      "device.xtwinops-22",
      "device.xtwinops-23",
      "editing.deccara",
      "editing.deccra",
      "editing.decdc",
      "editing.decera",
      "editing.decfra",
      "editing.decic",
      "editing.decrara",
      "editing.decrqcra",
      "editing.decsace",
      "editing.decsera",
      "editing.delete-chars",
      "editing.delete-lines",
      "editing.insert-chars",
      "editing.insert-lines",
      "editing.repeat-char",
      "editing.sl",
      "editing.sr",
      "erase.character",
      "erase.ed-scroll-region",
      "erase.el-with-attrs",
      "erase.line.all",
      "erase.line.left",
      "erase.line.right",
      "erase.screen.above",
      "erase.screen.all",
      "erase.screen.below",
      "erase.screen.scrollback",
      "erase.selective",
      "extensions.kitty-keyboard",
      "extensions.kitty-keyboard.disambiguate",
      "extensions.kitty-keyboard.report-all-keys",
      "extensions.kitty-keyboard.report-alternate",
      "extensions.kitty-keyboard.report-events",
      "extensions.kitty-keyboard.report-text",
      "extensions.osc-633-vscode",
      "extensions.osc10-fg-color",
      "extensions.osc11-bg-color",
      "extensions.osc117-reset-highlight-bg",
      "extensions.osc119-reset-highlight-fg",
      "extensions.osc12-cursor-color",
      "extensions.osc133-a",
      "extensions.osc133-b",
      "extensions.osc133-c",
      "extensions.osc133-d",
      "extensions.osc133-p",
      "extensions.osc1337-capabilities",
      "extensions.osc1337-cellsize",
      "extensions.osc17-highlight-bg",
      "extensions.osc176-app-id",
      "extensions.osc19-highlight-fg",
      "extensions.osc21-kitty-color",
      "extensions.osc22-pointer",
      "extensions.osc30001-color-stack-push",
      "extensions.osc3008-context",
      "extensions.osc30101-color-stack-pop",
      "extensions.osc4-palette",
      "extensions.osc440-audio",
      "extensions.osc5-special-color",
      "extensions.osc555-flash",
      "extensions.osc633-a",
      "extensions.osc633-b",
      "extensions.osc633-c",
      "extensions.osc633-d",
      "extensions.osc633-e",
      "extensions.osc633-p",
      "extensions.osc66-text-sizing",
      "extensions.osc702-version",
      "extensions.osc720-scroll-up",
      "extensions.osc776-cell-size",
      "extensions.osc777-notify",
      "extensions.osc7770-font-size",
      "extensions.osc7777-font-window-size",
      "extensions.osc8",
      "extensions.osc9-progress",
      "extensions.semantic-prompts",
      "extensions.sixel",
      "extensions.sixel-da1",
      "extensions.sixel-geometry-report",
      "extensions.truecolor",
      "input.button-event-mouse",
      "input.csi-u",
      "input.kitty-click-events",
      "input.modify-other-keys",
      "input.modify-other-keys-3",
      "input.pixel-mouse",
      "input.urxvt-mouse",
      "input.x10-mouse",
      "input.xtest-click",
      "input.xtest-key",
      "input.xtest-wheel",
      "modes.alt-screen.enter",
      "modes.alt-screen.exit",
      "modes.alt-scroll-1007",
      "modes.altscreen-1047",
      "modes.altscreen-1048",
      "modes.altscreen-47",
      "modes.application-cursor",
      "modes.application-keypad",
      "modes.auto-wrap",
      "modes.color-scheme-reporting",
      "modes.deccolm",
      "modes.decsclm",
      "modes.decsscls",
      "modes.focus-tracking",
      "modes.insert-replace",
      "modes.left-right-margin",
      "modes.mouse-all",
      "modes.mouse-sgr",
      "modes.mouse-tracking",
      "modes.origin",
      "modes.reverse-video",
      "modes.synchronized-output",
      "modes.utf8-mouse-1005",
      "modes.xtpopcolors",
      "modes.xtpopsgr",
      "modes.xtpushcolors",
      "modes.xtpushsgr",
      "modes.xtrestore",
      "modes.xtsave",
      "reset.decaln",
      "reset.ris",
      "reset.sgr",
      "reset.soft",
      "scrollback.accumulate",
      "scrollback.alt-screen",
      "scrollback.decstbm",
      "scrollback.decstbm-reset",
      "scrollback.reverse-index",
      "scrollback.scroll-down",
      "scrollback.scroll-up",
      "scrollback.set-region",
      "scrollback.total-lines",
      "sgr.bg.256",
      "sgr.bg.bright",
      "sgr.bg.default",
      "sgr.bg.standard",
      "sgr.bg.truecolor",
      "sgr.blink",
      "sgr.bold",
      "sgr.faint",
      "sgr.fg.256",
      "sgr.fg.bright",
      "sgr.fg.default",
      "sgr.fg.standard",
      "sgr.fg.truecolor",
      "sgr.hidden",
      "sgr.inverse",
      "sgr.italic",
      "sgr.overline",
      "sgr.reset",
      "sgr.selective-reset.bold",
      "sgr.selective-reset.inverse",
      "sgr.selective-reset.italic",
      "sgr.selective-reset.underline",
      "sgr.strikethrough",
      "sgr.underline-color-indexed",
      "sgr.underline-color-reset",
      "sgr.underline-color-rgb",
      "sgr.underline.color",
      "sgr.underline.curly",
      "sgr.underline.dashed",
      "sgr.underline.dotted",
      "sgr.underline.double",
      "sgr.underline.single",
      "text.backspace",
      "text.basic",
      "text.cbt",
      "text.cht",
      "text.combining",
      "text.cr",
      "text.hts",
      "text.index",
      "text.newline",
      "text.next-line",
      "text.overwrite",
      "text.reverse-index-scroll",
      "text.tab",
      "text.tbc",
      "text.wide.cjk",
      "text.wide.emoji",
      "text.wide.emoji-flags",
      "text.wide.emoji-vs16",
      "text.wide.emoji-zwj",
      "text.wrap",
      "unicode.east-asian-ambiguous",
      "unicode.grapheme-cursor",
      "unicode.tab-stops",
      "unicode.wrap-boundary",
      // The cursor-position and device-attribute controls these probes send before or after their target.
      "extensions.osc52-write",
      "extensions.osc5522-clipboard",
      "extensions.osc666-termprop",
      "extensions.reflow",
      "scrollback.viewport-hold-output",
      "extensions.osc104-reset-palette",
      "extensions.osc110-reset-fg",
      "extensions.osc111-reset-bg",
      "extensions.osc112-reset-cursor",
      "extensions.osc113-reset-pointer-fg",
      "extensions.osc114-reset-pointer-bg",
    ],
  ),
  "device.xtversion": ["xtversion"],
  "device.xtgettcap": ["xtgettcap"],
  "device.xtgetxres": ["xtgetxres"],
  "extensions.osc52-read": ["osc52", "control"],
  "extensions.osc52-clipboard": ["osc52", "control"],
  ...group(
    ["kitty-graphics"],
    [
      "extensions.kitty-graphics",
      "extensions.kitty-graphics.animation",
      "extensions.kitty-graphics.display",
      "extensions.kitty-graphics.transmit",
      "extensions.kitty-graphics.unicode-placeholders",
    ],
  ),
  "extensions.clipboard-paste": ["pasted-nonce", "control"],
  "modes.bracketed-paste": ["pasted-nonce", "control"],
  "extensions.osc99-kitty-notify": ["kitty-notify"],
  "device.xtwinops-20": ["probe-text"],
  "extensions.osc0-icon-title": ["probe-text"],
  "extensions.osc1-icon": ["probe-text"],
  "device.xtwinops-21": ["probe-text"],
  // A unit ID and a font name are machine details: always described.
  "device.tertiary-da": [],
  "extensions.font-ligatures": [],
  "extensions.osc701-locale": [],
}

/** Read one live reply through its feature's declared shapes. */
export function replyValue(stored: StoredEvidence, reply: string): CardValue {
  const shapes = REPLY_SHAPES[stored.featureId]
  if (shapes === undefined) fail(stored, "byte-reply", "a reply with no declared shape for this feature")
  for (const shape of shapes) {
    const value = SHAPES[shape](reply, stored)
    if (value) return value
  }
  return withheld(reply)
}

/** Whether a stored reply may appear in the public trace as written (it fits a declared shape). */
export function replyPublishable(stored: StoredEvidence, reply: string): boolean {
  return "shown" in replyValue(stored, reply)
}

/**
 * Assertion `observed` values a trace may carry for a live terminal, per feature. The reverse-wrap step table
 * reads its measured cursor reports; every other live observation is worded by its template instead.
 */
export const OBSERVED_SHAPES: Readonly<Record<string, (observed: string) => boolean>> = {
  "cursor.reverse-wrap": (observed) => {
    if (!observed.startsWith("{")) return false
    const parsed: unknown = JSON.parse(observed)
    return (
      isRecord(parsed) &&
      Object.keys(parsed).every((key) => key === "measured") &&
      Array.isArray(parsed.measured) &&
      parsed.measured.every(
        (step) =>
          isRecord(step) &&
          ["home", "wrapped", "reverted"].includes(step.step as string) &&
          (step.report === null ||
            (isRecord(step.report) &&
              Number.isSafeInteger(step.report.row) &&
              Number.isSafeInteger(step.report.col) &&
              Object.keys(step.report).length === 2)),
      )
    )
  },
}

/** The environment variable each environment-read feature checks. */
export const ENVIRONMENT_READS: Readonly<Record<string, { variable: string; value: RegExp }>> = {
  "device.term-features": { variable: "TERM_FEATURES", value: /^[A-Za-z0-9:,_-]{1,200}$/ },
}

/**
 * App-state reads (window title, icon name, working directory, line counts, an outer terminal's command log):
 * the paths into the stored callback that a card names, per feature. A feature may declare several, one per
 * stored form; the first whose paths the record holds is read. A path ending in `?` may be absent. A title
 * or path reading is shown only when it is text this probe wrote, or absent; any other value is described.
 * The app's own record of commands (`reader` in the callback) needs no entry: it is read the same way for all.
 */
export type AppStateRead =
  | { read: "readings"; surface: string; readings: ReadonlyArray<readonly [label: string, path: string]> }
  | { read: "sequence"; surface: string; set: string; readings: string; after: string }
  | { read: "counts"; surface: string; counts: ReadonlyArray<readonly [label: string, path: string]> }
  | { read: "outer-log"; command: string; control: string }

const ICON_AND_TITLE: AppStateRead = {
  read: "readings",
  surface: "icon name and window title",
  readings: [
    ["icon name", "iconAfter"],
    ["window title", "titleAfter"],
  ],
}
const TITLE_STACK: AppStateRead = {
  read: "readings",
  surface: "window title",
  readings: [
    ["after the push and pop", "popFixture.restored"],
    ["at the end", "restored"],
  ],
}
const LINE_TOTALS: AppStateRead = {
  read: "counts",
  surface: "the terminal's lines, history included",
  counts: [
    ["before the test wrote more lines", "baseline.totalLines"],
    ["after", "scroll.totalLines"],
  ],
}

export const APP_STATE_READS: Readonly<Record<string, readonly AppStateRead[]>> = {
  "extensions.osc0-icon-title": [ICON_AND_TITLE],
  "extensions.osc1-icon": [ICON_AND_TITLE],
  "device.xtwinops-22": [TITLE_STACK],
  "device.xtwinops-23": [TITLE_STACK],
  "extensions.osc2-title": [
    { read: "sequence", surface: "window title", set: "values", readings: "readings", after: "negative" },
  ],
  "extensions.osc7-cwd": [
    { read: "sequence", surface: "working directory", set: "paths", readings: "readings", after: "negative" },
  ],
  "erase.screen.scrollback": [
    {
      read: "counts",
      surface: "the lines of history above the screen",
      counts: [
        ["before the erase", "before"],
        ["after it", "after"],
        ["after more lines were written", "alive"],
      ],
    },
    {
      read: "counts",
      surface: "the multiplexer's lines of history",
      counts: [
        ["before the erase", "muxHistory.before"],
        ["after it", "muxHistory.after"],
      ],
    },
  ],
  "scrollback.accumulate": [LINE_TOTALS],
  "scrollback.total-lines": [LINE_TOTALS],
  "extensions.osc720-scroll-up": [
    {
      read: "counts",
      surface: "how many lines the view was scrolled back",
      counts: [
        ["before the command", "readings.baseline.viewportOffset"],
        ["after it", "readings.afterOsc720.viewportOffset"],
        ["after a known scroll command", "readings.afterCopyModeControl.viewportOffset?"],
      ],
    },
  ],
  "extensions.osc22-pointer": [
    { read: "outer-log", command: "The pointer-shape command", control: "the title change sent after it" },
  ],
}

// ---------------------------------------------------------------------------------------------------------
// Reading the stored record into facts.
// ---------------------------------------------------------------------------------------------------------

function waitOf(stored: StoredEvidence, query: StoredQuery): Wait {
  if (query.reason === "sentinel") {
    const graceMs = query.sentinel?.graceMs
    if (graceMs === undefined || !Number.isSafeInteger(graceMs)) {
      return fail(stored, "no-reply", "a fenced query without its grace time")
    }
    return { kind: "fence", graceMs }
  }
  if (query.reason === "timeout") {
    if (query.timeoutMs === undefined) return { kind: "limit" }
    if (!Number.isSafeInteger(query.timeoutMs)) fail(stored, "no-reply", "a timed-out query with a bad time limit")
    return { kind: "limit", ms: query.timeoutMs }
  }
  return fail(stored, "no-reply", `a query that got no reply with reason ${JSON.stringify(query.reason)}`)
}

const answered = (query: StoredQuery) => Array.isArray(query.match) && typeof query.match[0] === "string"

function readRegion(value: unknown): Region | undefined {
  if (!isRecord(value)) return undefined
  const { top, left, bottom, right } = value
  return [top, left, bottom, right].every((n) => Number.isSafeInteger(n))
    ? { top: top as number, left: left as number, bottom: bottom as number, right: right as number }
    : undefined
}

function regionOf(stored: StoredEvidence): Region | undefined {
  const fromCallback = readRegion(at(stored.callback, "region"))
  if (fromCallback) return fromCallback
  for (const assertion of stored.assertions) {
    const quoted = /region (\{"top":\d+,"left":\d+,"bottom":\d+,"right":\d+\})/.exec(assertion.expected)?.[1]
    if (quoted) return readRegion(JSON.parse(quoted))
  }
  return undefined
}

/** After vs. the screen before the test and the expected screen, when the run stored all three digests. */
function screenOutcome(stored: StoredEvidence, kind: "screen" | "text-readback") {
  const [seed, after, expected, plain] = ["seed", "after", "expected", "noAttribute"].map((key) =>
    at(stored.callback, key),
  )
  const digest = (value: unknown) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
  if (digest(seed) && digest(after) && digest(expected)) {
    // A colour probe's plain-text frame can equal its expected frame; matching plain text is then the fact.
    if (digest(plain) && after === plain) return "plain" as const
    if (after === expected) return "expected" as const
    if (after === seed) return "unchanged" as const
    return "changed" as const
  }
  // No stored comparison: the outcome is the cell's own decided result, which its assertions reached.
  if (stored.assertions.length === 0) fail(stored, kind, "no stored comparison and no assertion")
  if (stored.status === "supported") return "held" as const
  if (stored.status === "unsupported") return "failed" as const
  return fail(stored, kind, `a screen read with status ${stored.status}`)
}

function readingValue(stored: StoredEvidence, value: unknown, path: string): CardValue {
  if (value === undefined) fail(stored, "app-state", `no stored reading ${path}`)
  if (value === null || value === "") return { absent: true }
  if (typeof value !== "string") fail(stored, "app-state", `reading ${path} is not text`)
  return wroteIt(value, stored) ? { shown: value } : withheld(value)
}

const optional = (path: string) => path.endsWith("?")
const bare = (path: string) => path.replace(/\?$/, "")

/** The first declared read whose required paths this record holds. */
function declaredRead(stored: StoredEvidence): AppStateRead | undefined {
  const required = (read: AppStateRead): string[] => {
    if (read.read === "readings") return read.readings.map(([, path]) => path)
    if (read.read === "sequence") return [read.set, read.readings, read.after]
    if (read.read === "counts") return read.counts.map(([, path]) => path).filter((path) => !optional(path))
    return ["outerCommands"]
  }
  return APP_STATE_READS[stored.featureId]?.find((read) =>
    required(read).every((path) => at(stored.callback, path) !== undefined),
  )
}

function textList(stored: StoredEvidence, path: string): string[] {
  const value = at(stored.callback, path)
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(stored, "app-state", `reading ${path} is not a list of text`)
  }
  return value as string[]
}

function declaredFacts(stored: StoredEvidence, read: AppStateRead): EvidenceFacts {
  if (read.read === "readings") {
    return {
      kind: "app-state",
      read: "readings",
      surface: read.surface,
      readings: read.readings.map(([label, path]) => ({
        label,
        value: readingValue(stored, at(stored.callback, path), path),
      })),
    }
  }
  if (read.read === "sequence") {
    const set = textList(stored, read.set)
    const readings = textList(stored, read.readings)
    return {
      kind: "app-state",
      read: "sequence",
      surface: read.surface,
      set: set.length,
      matched: set.filter((value, index) => readings[index] === value).length,
      after: readingValue(stored, at(stored.callback, read.after), read.after),
    }
  }
  if (read.read === "counts") {
    return {
      kind: "app-state",
      read: "counts",
      surface: read.surface,
      counts: read.counts.flatMap(([label, path]) => {
        const lines = at(stored.callback, bare(path))
        if (lines === undefined && optional(path)) return []
        if (!Number.isSafeInteger(lines)) fail(stored, "app-state", `count ${bare(path)} is not a whole number`)
        return [{ label, lines: lines as number }]
      }),
    }
  }
  const sent = at(stored.callback, "outerCommands.targetSent")
  const nonce = at(stored.callback, "outerCommands.detail.nonce")
  const lines = at(stored.callback, "outerCommands.detail.unknown.lines")
  const controls = at(stored.callback, "outerCommands.detail.commands.control")
  if (
    typeof sent !== "boolean" ||
    typeof nonce !== "string" ||
    !Array.isArray(lines) ||
    !Number.isSafeInteger(controls)
  ) {
    fail(stored, "app-state", "an outer command log without the target, the control's text and the logged lines")
  }
  return {
    kind: "app-state",
    read: "outer-log",
    command: read.command,
    control: read.control,
    sent,
    controlArrived:
      (controls as number) > 0 ||
      (wroteIt(nonce, stored) && lines.some((line) => typeof line === "string" && line.includes(nonce))),
  }
}

function appState(stored: StoredEvidence): EvidenceFacts {
  const declared = declaredRead(stored)
  if (declared) return declaredFacts(stored, declared)
  const reader = at(stored.callback, "reader")
  if (reader === "state") {
    const [before, after, expected] = ["before", "after", "expected"].map((key) => at(stored.callback, `target.${key}`))
    const [handledAfter, handledExpected] = ["after", "expected"].map((key) => at(stored.callback, `handled.${key}`))
    if ([before, after, expected, handledAfter, handledExpected].some((v) => typeof v !== "string")) {
      fail(stored, "app-state", "an app record without before, after and expected states")
    }
    return {
      kind: "app-state",
      read: "state",
      target: after === expected ? "expected" : after === before ? "unchanged" : "other",
      control: handledAfter === handledExpected ? "worked" : "failed",
    }
  }
  if (reader === "report") {
    const code = at(stored.callback, "target.code")
    const reports = at(stored.callback, "target.reports")
    const controlCode = at(stored.callback, "unknown.code")
    const controlReports = at(stored.callback, "unknown.reports")
    if (
      typeof code !== "string" ||
      !/^[0-9]{1,6}$/.test(code) ||
      !Array.isArray(reports) ||
      typeof controlCode !== "string" ||
      !Array.isArray(controlReports)
    ) {
      fail(stored, "app-state", "an app log without the command code and its reports")
    }
    return {
      kind: "app-state",
      read: "report",
      code,
      listed: reports.includes(code),
      controlListed: controlReports.includes(controlCode),
    }
  }
  return fail(stored, "app-state", "no declared reading for this feature")
}

function notification(stored: StoredEvidence): EvidenceFacts {
  const nonce = at(stored.callback, "nonce")
  const deadlineMs = at(stored.callback, "deadlineMs")
  const missed = at(stored.callback, "noNonceCallByDeadline")
  if (typeof nonce !== "string" || !Number.isSafeInteger(deadlineMs) || typeof missed !== "boolean") {
    fail(stored, "notification", "a notification record without its text, deadline and outcome")
  }
  return {
    kind: "notification",
    text: wroteIt(nonce, stored) ? { shown: nonce } : withheld(nonce),
    delivered: !missed,
    deadlineMs: deadlineMs as number,
  }
}

function environment(stored: StoredEvidence): EvidenceFacts {
  const declared = ENVIRONMENT_READS[stored.featureId]
  if (!declared) fail(stored, "environment", "no declared variable for this feature")
  const present = at(stored.callback, "present")
  const value = at(stored.callback, "value")
  // The launch marker is the collector run's id, set in the environment of the terminal it started; equal
  // means this terminal was started fresh for this run. Neither id is shown.
  const marker = at(stored.callback, "launchMarker")
  const runId = at(stored.callback, "runId")
  if (
    typeof present !== "boolean" ||
    typeof value !== "string" ||
    typeof marker !== "string" ||
    typeof runId !== "string"
  ) {
    fail(stored, "environment", "an environment read without present, value, its launch marker and the run's id")
  }
  return {
    kind: "environment",
    variable: declared.variable,
    launcher: typeof at(stored.callback, "mux") === "string" ? "multiplexer" : "terminal",
    fresh: marker === runId,
    value: !present ? { absent: true } : declared.value.test(value) ? { shown: value } : withheld(value),
  }
}

/** Sort one stored result into its evidence kind and read the fields that kind's template needs. */
export function evidenceFacts(stored: StoredEvidence): EvidenceFacts {
  if (stored.status === "untestable") {
    return {
      kind: "untestable",
      sent: stored.writes.length + stored.queries.length,
      answered: stored.queries.filter(answered).length,
      ...(stored.reasonCode !== undefined && { reasonCode: stored.reasonCode }),
    }
  }
  if (stored.subjectKind === "lib") {
    if (stored.parserState !== undefined) {
      return {
        kind: "library-state",
        state:
          typeof stored.parserState === "string" ? { shown: formatControlBytes(stored.parserState) } : { block: true },
      }
    }
    const observed = stored.assertions.map((assertion) => assertion.observed).filter((value) => value !== "")
    if (observed.length === 0) fail(stored, "library-state", "no parser state and no observed value")
    return { kind: "library-state", state: { block: true } }
  }
  if (stored.assertionType === "process_environment") return environment(stored)
  if (stored.assertionType === "notification") return notification(stored)
  if (stored.frameKinds.includes("text-cells")) {
    return {
      kind: "text-readback",
      region: regionOf(stored),
      outcome: screenOutcome(stored, "text-readback"),
      reader: stored.os === "windows" ? "console host" : "app snapshot",
    }
  }
  if (stored.assertionType === "screenshot" || "captures" in stored.exchangeExtra) {
    return { kind: "screen", region: regionOf(stored), outcome: screenOutcome(stored, "screen") }
  }
  if (stored.assertionType === "buffer_state") return appState(stored)
  if (stored.queries.length > 0) {
    const replies = stored.queries
      .filter(answered)
      .map((query) =>
        replyValue(stored, query.match?.[0] ?? fail(stored, "byte-reply", "an answered query without its reply")),
      )
    const silent = stored.queries.filter((query) => !answered(query)).map((query) => waitOf(stored, query))
    if (replies.length > 0) return { kind: "byte-reply", queries: stored.queries.length, replies, silent }
    return {
      kind: "no-reply",
      queries: stored.queries.length,
      waits: silent,
      readOnly: stored.queries.every((query) => query.sequence === ""),
    }
  }
  return fail(stored, "none", "no query, screen read, environment read, app-state read or notification stored")
}

// ---------------------------------------------------------------------------------------------------------
// The templates: one per kind, one or two sentences each.
// ---------------------------------------------------------------------------------------------------------

function words(value: CardValue): string {
  if ("shown" in value) return value.shown
  if ("absent" in value) return "nothing"
  return `a value we don't show (${value.withheld.bytes} bytes, not text the test sent)`
}

/** A text reading (a title, a path, our nonce) in quotes; a described or absent value in words. */
const quoted = (value: CardValue) => ("shown" in value ? `"${formatControlBytes(value.shown)}"` : words(value))

function list(values: readonly string[]): string {
  const head = values.slice(0, 4)
  const more = values.length - head.length
  return more > 0 ? `${head.join(", ")} and ${more} more` : head.join(", ")
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/**
 * How the test waited for the replies that never came: behind a device check the terminal did answer (a
 * fence), or up to a time limit. Older runs kept no time limit for a timed-out read.
 */
function waited(waits: readonly Wait[]): { fenced: true; ms: string } | { fenced: false; within: string } {
  const ms = (values: number[]) => {
    const unique = [...new Set(values)].sort((a, b) => a - b)
    return unique.length === 1 ? `${unique[0]} ms` : `${unique[0]}–${unique.at(-1)} ms`
  }
  if (waits.every((wait) => wait.kind === "fence")) return { fenced: true, ms: ms(waits.map((wait) => wait.graceMs)) }
  if (waits.some((wait) => wait.kind === "limit" && wait.ms === undefined)) {
    return { fenced: false, within: "before the test stopped waiting" }
  }
  return {
    fenced: false,
    // Every limit wait holds its time here: a limit with none returned "before the test stopped waiting" above.
    within: `within ${ms(waits.flatMap((wait) => (wait.kind === "fence" ? [wait.graceMs] : wait.ms === undefined ? [] : [wait.ms])))}`,
  }
}

function rows(region: Region): string {
  const span = (a: number, b: number, one: string) => (a === b ? `${one} ${a}` : `${one}s ${a}–${b}`)
  return `${span(region.top, region.bottom, "row")}, ${span(region.left, region.right, "column")}`
}

const SCREEN_OUTCOME = {
  unchanged: "did not change.",
  expected: "matched the expected result.",
  changed: "changed, but not to the expected result.",
  plain: "looked the same as plain text with no attribute set.",
  held: "showed the expected result.",
  failed: "did not show the expected result.",
} as const

const UNTESTABLE_REASON: Readonly<Record<string, string>> = {
  permission: "the test needed a permission this run did not have",
  "policy-refused": "this run's settings did not allow the test",
}

// An intersection, not Extract: the screen facts declare kind "screen" | "text-readback" in one member, which Extract
// drops for either kind alone, leaving those two templates typed never.
type Template<K extends EvidenceKind> = (facts: EvidenceFacts & { kind: K }, probeId: string) => string[]

const TEMPLATES: { [K in EvidenceKind]: Template<K> } = {
  "byte-reply": ({ replies, silent }) => {
    const [only] = replies
    const sent =
      replies.length === 1 && only !== undefined
        ? `The terminal sent back ${words(only)}.`
        : `The terminal sent back ${replies.length} replies: ${list(replies.map(words))}.`
    if (silent.length === 0) return [sent]
    const other = silent.length === 1 ? "The other query" : `The other ${silent.length} queries`
    const wait = waited(silent)
    return [
      sent,
      wait.fenced
        ? `${other} got no reply: the terminal answered the device check sent after ${silent.length === 1 ? "it" : "each one"}, and nothing else came within ${wait.ms}.`
        : `${other} got no reply ${wait.within}.`,
    ]
  },
  "no-reply": ({ queries, waits, readOnly }) => {
    const wait = waited(waits)
    if (!wait.fenced) {
      if (readOnly) return [`The terminal sent nothing ${wait.within}.`]
      return [
        queries === 1
          ? `No reply came back ${wait.within}.`
          : `None of the ${queries} queries got a reply ${wait.within}.`,
      ]
    }
    return [
      queries === 1 ? "No reply came back to the query." : `None of the ${queries} queries got a reply.`,
      `The terminal did answer the device check sent after ${queries === 1 ? "it" : "each one"}, and nothing else came within ${wait.ms}.`,
    ]
  },
  environment: ({ variable, launcher, fresh, value }) => [
    `The ${launcher} was ${fresh ? "started fresh for this run" : "not started fresh for this run"}, and ${
      "absent" in value
        ? `${variable} was not set in the environment it gave the test.`
        : `it set ${variable} to ${quoted(value)} in the environment it gave the test.`
    }`,
  ],
  screen: ({ region, outcome }) => [
    region ? `Compared ${rows(region)} of the screen with the expected result.` : "Checked the screen after the test.",
    `${region ? "Those cells" : "It"} ${SCREEN_OUTCOME[outcome]}`,
  ],
  "text-readback": ({ region, outcome, reader }) => [
    `Read ${region ? rows(region) : "the screen"} as text from ${
      reader === "console host" ? "the console host's buffer" : "the terminal's own text snapshot"
    }, not from its pixels.`,
    `${region ? "Those cells" : "It"} ${SCREEN_OUTCOME[outcome]}`,
  ],
  "app-state": (facts) => {
    if (facts.read === "readings") {
      return [
        `Read the ${facts.surface} back after the test: ${facts.readings
          .map(({ label, value }) => `${label}, ${"absent" in value ? "not set" : quoted(value)}`)
          .join("; ")}.`,
      ]
    }
    if (facts.read === "sequence") {
      return [
        `Set the ${facts.surface} ${plural(facts.set, "time")} and read it back each time: ${facts.matched} of ${facts.set} readings matched.`,
        "absent" in facts.after
          ? "A made-up command then left it empty."
          : `A made-up command then left it at ${quoted(facts.after)}.`,
      ]
    }
    if (facts.read === "counts") {
      const counts = facts.counts.map(({ label, lines }) => `${lines} ${label}`)
      return [
        `Counted ${facts.surface}: ${counts.slice(0, -1).join(", ")}${counts.length > 1 ? " and " : ""}${counts.at(-1)}.`,
      ]
    }
    if (facts.read === "outer-log") {
      return [
        "Read the outer terminal's own log of the commands it got.",
        `${facts.command} ${facts.sent ? "reached it" : "did not reach it"}${
          facts.controlArrived ? `${facts.sent ? ", and" : ", but"} ${facts.control} did.` : "."
        }`,
      ]
    }
    if (facts.read === "state") {
      return [
        "Read the app's own record of the command before and after it.",
        facts.target === "expected"
          ? "It changed to what the command sets."
          : `${facts.target === "unchanged" ? "It did not change" : "It changed, but not to what the command sets"}${
              facts.control === "worked" ? ", though a known command did change it." : "."
            }`,
      ]
    }
    return [
      "Read the app's own log of commands it does not handle.",
      `It ${facts.listed ? "listed" : "did not list"} OSC ${facts.code}${
        facts.controlListed ? ", and it also listed a made-up command we sent to compare." : "."
      }`,
    ]
  },
  notification: ({ text, delivered, deadlineMs }) => [
    `Sent a desktop notification with the text ${quoted(text)}.`,
    delivered
      ? `It reached the desktop within ${deadlineMs} ms.`
      : `No notification with that text reached the desktop within ${deadlineMs} ms.`,
  ],
  untestable: ({ sent, answered: replies, reasonCode }) => {
    const why = reasonCode === undefined ? undefined : UNTESTABLE_REASON[reasonCode]
    if (reasonCode !== undefined && why === undefined) throw new Error(`no wording for reason code ${reasonCode}`)
    if (why) return [`Not run: ${why}.`]
    if (sent === 0) return ["This terminal could not be tested for this feature, so nothing was sent."]
    return [
      `The test sent ${plural(sent, "sequence")} and got ${plural(replies, "reply", "replies")}.`,
      "On this terminal, that cannot show whether the feature works.",
    ]
  },
  "library-state": ({ state }) => [
    "block" in state ? "The library's state after the test is shown below." : `The library sent back ${words(state)}.`,
  ],
}

/** Word one result's evidence: one or two sentences, or a build error naming the probe and the kind. */
export function evidenceSentences(probeId: string, facts: EvidenceFacts): string[] {
  if (!(EVIDENCE_KINDS as readonly string[]).includes(facts.kind)) {
    throw new Error(`evidence for ${probeId} (kind ${String(facts.kind)}): unknown evidence kind`)
  }
  let sentences: string[]
  try {
    sentences = (TEMPLATES[facts.kind] as Template<EvidenceKind>)(facts as never, probeId)
  } catch (error) {
    throw new Error(`evidence for ${probeId} (kind ${facts.kind}): ${(error as Error).message}`)
  }
  if (sentences.length < 1 || sentences.length > 2 || sentences.some((s) => !/^[A-Z].*[.]$/s.test(s))) {
    throw new Error(`evidence for ${probeId} (kind ${facts.kind}): template returned ${JSON.stringify(sentences)}`)
  }
  return sentences
}
