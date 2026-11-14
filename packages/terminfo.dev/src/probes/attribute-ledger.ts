/**
 * Fold 2 of #34148: prove a cell's mutation was put back, from the bytes it wrote.
 *
 * A mutation callback cannot be trusted to declare what it touched: /pro's objection was that a
 * static declaration cannot stop a callback escaping it (@cto cbc34e67). So this ledger reads the
 * collector's own `write` events, classifies each sequence into the attribute it changed, and
 * requires every touched attribute to be read back and found equal to its pre-state before the cell
 * may be graded. A touched attribute with no query, or whose query drew no reply, is "restore
 * unprovable" and refuses; it is never assumed restored (@cto e6ae2880 condition 1).
 *
 * Every class here has a query: DECRQM for modes, OSC 4/10/11/12/17/19 for colours, DECRQSS `$ q m`
 * for the SGR pen state, and OSC 22's current-shape form. The SGR and OSC 22 bytes and reply patterns
 * are the ones probe-defs already sends (@cto 8087ba1e: same table, same mechanism, no new proof type).
 *
 * Pure: no host access, no I/O. The caller supplies the before/after replies it already collected;
 * the readback queries come from `readbackFor`, which reuses probe-defs' DECRPM vocabulary and its
 * DECRQSS/OSC 22 bytes rather than growing a second parser (@cto e6ae2880 condition 6 — there is no
 * existing classifier of WRITES in probe-defs or termless; what exists is the declared `feed`/`code`
 * vocabulary in extensions.ts and the reply helpers in helpers.ts, both reused here).
 */

import {
  DECRQSS_SGR_QUERY,
  DECRQSS_SGR_REPLY,
  OSC22_CURRENT_QUERY,
  OSC22_SHAPE_REPLY,
  decrpmPs,
  decrpmReplyPattern,
} from "@terminfo/probe-defs"

/** One attribute a cell can change. The key is what the ledger compares. */
export type LedgerAttribute =
  | { readonly kind: "dec-mode"; readonly mode: number }
  | { readonly kind: "ansi-mode"; readonly mode: number }
  | { readonly kind: "sgr" }
  | { readonly kind: "palette"; readonly index: number }
  | { readonly kind: "foreground" }
  | { readonly kind: "background" }
  | { readonly kind: "cursor-colour" }
  | { readonly kind: "highlight-background" }
  | { readonly kind: "highlight-foreground" }
  | { readonly kind: "pointer-shape" }

export function attributeKey(attribute: LedgerAttribute): string {
  switch (attribute.kind) {
    case "dec-mode":
      return `dec:${attribute.mode}`
    case "ansi-mode":
      return `ansi:${attribute.mode}`
    case "sgr":
      return "sgr"
    case "palette":
      return `osc:4:${attribute.index}`
    case "foreground":
      return "osc:10"
    case "background":
      return "osc:11"
    case "cursor-colour":
      return "osc:12"
    case "highlight-background":
      return "osc:17"
    case "highlight-foreground":
      return "osc:19"
    case "pointer-shape":
      return "osc:22"
  }
}

/** One classified write, or the reason this sequence cannot be classified. */
export type WriteClassification =
  | { readonly attributes: readonly LedgerAttribute[]; readonly resetUnion?: true }
  | { readonly unclassified: string }

const CSI_PRIVATE_MODE = /^\x1b\[\?([0-9;]+)([hl])$/
const CSI_ANSI_MODE = /^\x1b\[([0-9;]+)([hl])$/
const CSI_SGR = /^\x1b\[([0-9;:]*)m$/
const CSI_DECSTR = /^\x1b\[!p$/
const OSC_PALETTE = /^\x1b\]4;([0-9]+);(?:[^\x07\x1b]*)(?:\x07|\x1b\\)$/
const OSC_PALETTE_RESET = /^\x1b\]104(?:;([0-9]+))?(?:\x07|\x1b\\)$/
const OSC_DIRECT = /^\x1b\](10|11|12|17|19);[^\x07\x1b]*(?:\x07|\x1b\\)$/
const OSC_DIRECT_RESET = /^\x1b\](110|111|112|117|119)(?:\x07|\x1b\\)$/
const OSC_POINTER = /^\x1b\]22(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)$/

/** The direct-colour OSC codes, narrowed to the attributes they name. */
type DirectAttributeKind =
  | "foreground"
  | "background"
  | "cursor-colour"
  | "highlight-background"
  | "highlight-foreground"

const DIRECT_BY_CODE: Readonly<Record<string, DirectAttributeKind>> = {
  "10": "foreground",
  "11": "background",
  "12": "cursor-colour",
  "17": "highlight-background",
  "19": "highlight-foreground",
}

const DIRECT_RESET_BY_CODE: Readonly<Record<string, DirectAttributeKind>> = {
  "110": "foreground",
  "111": "background",
  "112": "cursor-colour",
  "117": "highlight-background",
  "119": "highlight-foreground",
}

/**
 * Classify one write sequence. `touched` is every attribute the cell has already changed, so the
 * union resets (DECSTR, OSC 104) can name what they touch instead of guessing. A sequence this
 * module cannot name is `unclassified` and refuses the cell; there is no default (@cto condition 1).
 */
export function classifyWrite(sequence: string, touched: readonly LedgerAttribute[] = []): WriteClassification {
  const privateMode = CSI_PRIVATE_MODE.exec(sequence)
  if (privateMode) {
    return {
      attributes: privateMode[1]!.split(";").map((mode) => ({ kind: "dec-mode" as const, mode: Number(mode) })),
    }
  }
  const ansiMode = CSI_ANSI_MODE.exec(sequence)
  if (ansiMode) {
    return {
      attributes: ansiMode[1]!.split(";").map((mode) => ({ kind: "ansi-mode" as const, mode: Number(mode) })),
    }
  }
  const sgr = CSI_SGR.exec(sequence)
  if (sgr) return { attributes: [{ kind: "sgr" }] }
  if (CSI_DECSTR.test(sequence)) {
    if (touched.length === 0) {
      return { unclassified: "DECSTR before any attribute was touched: it resets state this cell never wrote" }
    }
    return { attributes: touched, resetUnion: true }
  }
  const palette = OSC_PALETTE.exec(sequence)
  if (palette) return { attributes: [{ kind: "palette", index: Number(palette[1]) }] }
  const paletteReset = OSC_PALETTE_RESET.exec(sequence)
  if (paletteReset) {
    const index = paletteReset[1] === undefined ? undefined : Number(paletteReset[1])
    const paletteTouched = touched.filter(
      (attribute): attribute is Extract<LedgerAttribute, { kind: "palette" }> => attribute.kind === "palette",
    )
    if (index !== undefined) return { attributes: [{ kind: "palette", index }] }
    if (paletteTouched.length === 0) {
      return { unclassified: "OSC 104 resets the whole palette, and this cell touched no palette entry" }
    }
    return { attributes: paletteTouched, resetUnion: true }
  }
  const direct = OSC_DIRECT.exec(sequence)
  if (direct) return { attributes: [{ kind: DIRECT_BY_CODE[direct[1]!]! }] }
  const directReset = OSC_DIRECT_RESET.exec(sequence)
  if (directReset) return { attributes: [{ kind: DIRECT_RESET_BY_CODE[directReset[1]!]! }] }
  if (OSC_POINTER.test(sequence)) return { attributes: [{ kind: "pointer-shape" }] }
  return { unclassified: `no attribute class matches ${JSON.stringify(sequence)}` }
}

/** How to read one attribute back, or the name of why it cannot be read back at all. */
export type Readback =
  | {
      readonly query: string
      readonly pattern: RegExp
      /** The reply's state word, compared with `===`; null is "the terminal did not answer". */
      readonly read: (reply: string) => string | null
    }
  | { readonly unprovable: string }

const OSC_TERMINATOR = String.raw`(?:\x07|\x1b\\)`

/**
 * The readback for one attribute. This is where condition 1 is decided: a class with no query at
 * all is `unprovable`, never "assume the callback restored it".
 */
export function readbackFor(attribute: LedgerAttribute): Readback {
  switch (attribute.kind) {
    case "dec-mode": {
      const pattern = decrpmReplyPattern(attribute.mode)
      return {
        query: `\x1b[?${attribute.mode}$p`,
        pattern,
        read: (reply) => {
          const ps = decrpmPs(pattern.exec(reply)?.[1])
          return ps === null ? null : String(ps)
        },
      }
    }
    case "ansi-mode": {
      const pattern = decrpmReplyPattern(attribute.mode, "ansi")
      return {
        query: `\x1b[${attribute.mode}$p`,
        pattern,
        read: (reply) => {
          const ps = decrpmPs(pattern.exec(reply)?.[1])
          return ps === null ? null : String(ps)
        },
      }
    }
    case "palette": {
      const pattern = new RegExp(`\\x1b\\]4;${attribute.index};([^\\x07\\x1b]*)${OSC_TERMINATOR}`)
      return {
        query: `\x1b]4;${attribute.index};?\x07`,
        pattern,
        read: (reply) => pattern.exec(reply)?.[1] ?? null,
      }
    }
    case "foreground":
    case "background":
    case "cursor-colour":
    case "highlight-background":
    case "highlight-foreground": {
      const code = attributeKindToOsc(attribute.kind)
      const pattern = new RegExp(`\\x1b\\]${code};([^\\x07\\x1b]*)${OSC_TERMINATOR}`)
      return {
        query: `\x1b]${code};?\x07`,
        pattern,
        read: (reply) => pattern.exec(reply)?.[1] ?? null,
      }
    }
    case "sgr":
      // DECRQSS `$ q m`: the terminal's own active rendition, whole-state, so one readback covers
      // every SGR write in the cell. A terminal that does not answer the request, or answers the
      // `DCS 0 $ r ST` "not recognized" form, gives null and the cell refuses (@cto 8087ba1e).
      return {
        query: DECRQSS_SGR_QUERY,
        pattern: DECRQSS_SGR_REPLY,
        read: (reply) => DECRQSS_SGR_REPLY.exec(reply)?.[1] ?? null,
      }
    case "pointer-shape":
      // OSC 22's own current-shape query. KitKat-style silence is a read-method gap, never a pass:
      // a reply that does not parse is null and the cell refuses (@cto 8087ba1e).
      return {
        query: OSC22_CURRENT_QUERY,
        pattern: OSC22_SHAPE_REPLY,
        read: (reply) => OSC22_SHAPE_REPLY.exec(reply)?.[1] ?? null,
      }
  }
}

function attributeKindToOsc(kind: LedgerAttribute["kind"]): string {
  switch (kind) {
    case "foreground":
      return "10"
    case "background":
      return "11"
    case "cursor-colour":
      return "12"
    case "highlight-background":
      return "17"
    case "highlight-foreground":
      return "19"
    default:
      throw new Error(`attribute ${kind} has no direct OSC code`)
  }
}

/** One attribute's before/after replies, as the collector read them. */
export interface AttributeReads {
  readonly before?: string
  readonly after?: string
}

export type LedgerOmega =
  | { readonly status: "restored"; readonly touched: readonly string[] }
  | {
      readonly status: "refused"
      readonly touched: readonly string[]
      readonly failures: readonly LedgerFailure[]
    }

export type LedgerFailure =
  | { readonly attribute: string; readonly reason: "unclassified"; readonly detail: string }
  | { readonly attribute: string; readonly reason: "unprovable"; readonly detail: string }
  | { readonly attribute: string; readonly reason: "no-pre-state" }
  | { readonly attribute: string; readonly reason: "no-post-state" }
  | {
      readonly attribute: string
      readonly reason: "diverged"
      readonly before: string
      readonly after: string
    }

export interface LedgerInput {
  /** The cell's write events, in the order the collector recorded them. */
  readonly writes: readonly string[]
  /** Read replies keyed by `attributeKey`; the caller performs the queries from `readbackFor`. */
  readonly reads: ReadonlyMap<string, AttributeReads>
}

/**
 * Every attribute a cell's writes touch, plus the writes that could not be classified. The collector
 * uses this to know what to read back after the callback, in the same walk `ledgerOmega` performs.
 */
export function touchedAttributes(writes: readonly string[]): {
  readonly attributes: readonly LedgerAttribute[]
  readonly unclassified: readonly string[]
} {
  const attributes: LedgerAttribute[] = []
  const unclassified: string[] = []
  for (const write of writes) {
    const classification = classifyWrite(write, attributes)
    if ("unclassified" in classification) {
      unclassified.push(write)
      continue
    }
    for (const attribute of classification.attributes) {
      const key = attributeKey(attribute)
      if (!attributes.some((existing) => attributeKey(existing) === key)) attributes.push(attribute)
    }
  }
  return { attributes, unclassified }
}

/**
 * The ledger's verdict for one cell. Every touched attribute must have a before and an after reply
 * that are equal. Anything else is a `refused` verdict naming each failing attribute, so the run can
 * abort with the diff retained (@cto conditions 1, 3 and 5).
 */
export function ledgerOmega(input: LedgerInput): LedgerOmega {
  const touched: LedgerAttribute[] = []
  const failures: LedgerFailure[] = []
  for (const write of input.writes) {
    const classification = classifyWrite(write, touched)
    if ("unclassified" in classification) {
      failures.push({ attribute: JSON.stringify(write), reason: "unclassified", detail: classification.unclassified })
      continue
    }
    for (const attribute of classification.attributes) {
      const key = attributeKey(attribute)
      if (!touched.some((existing) => attributeKey(existing) === key)) touched.push(attribute)
    }
  }
  for (const attribute of touched) {
    const key = attributeKey(attribute)
    const readback = readbackFor(attribute)
    if ("unprovable" in readback) {
      failures.push({ attribute: key, reason: "unprovable", detail: readback.unprovable })
      continue
    }
    const reads = input.reads.get(key)
    const before = reads?.before === undefined ? null : readback.read(reads.before)
    if (before === null) {
      failures.push({ attribute: key, reason: "no-pre-state" })
      continue
    }
    const after = reads?.after === undefined ? null : readback.read(reads.after)
    if (after === null) {
      failures.push({ attribute: key, reason: "no-post-state" })
      continue
    }
    if (after !== before) failures.push({ attribute: key, reason: "diverged", before, after })
  }
  const keys = touched.map(attributeKey)
  return failures.length === 0 ? { status: "restored", touched: keys } : { status: "refused", touched: keys, failures }
}

/** The run-fatal refusal this ledger raises; named like `CaptureCalibrationRefused`. */
export class MutationRestoreRefused extends Error {
  readonly omega: LedgerOmega

  constructor(cell: string, omega: LedgerOmega) {
    super(
      omega.status === "restored"
        ? `cell ${cell} claimed a restore refusal with no failure`
        : `cell ${cell} cannot prove its writes were restored: ${omega.failures
            .map((failure) => `${failure.attribute} (${failure.reason})`)
            .join(", ")}; the run stops here rather than grading a cell that may have left state behind`,
    )
    this.name = "MutationRestoreRefused"
    this.omega = omega
  }
}
