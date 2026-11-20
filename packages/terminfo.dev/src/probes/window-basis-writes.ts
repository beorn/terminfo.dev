/**
 * Classify one retained window-basis write into @cto's closed lists.
 *
 * This is the escape-sequence half of the window-basis admission decision. The ledger in
 * `attribute-ledger.ts` names the attributes a write CHANGES, and a window basis can only prove a
 * restore for attributes; but a cell's retained writes are full terminal output, so most of them also
 * carry text, erases, cursor moves and window-size reads that change no restorable attribute and must
 * still be named rather than left unclassified. @cto's lists (69ad9f37, and the 0.29.2 ruling point 2
 * recorded on #33680's build spec) name exactly those: screen-text is printable bytes plus CR and LF,
 * erase is `CSI J` and `CSI K`, cursor-move is `CSI H` and `CSI r;cH`, window-size is the `CSI 8;r;ct`
 * write and the `CSI 18t` read. `ESC 8` may classify only when sgr plus origin plus a charset byte
 * prove its restore, and never after an `ESC 7`; nothing in the retained traces carries that proof, so
 * save/restore cursor stays unclassified here and the cell is excluded by name rather than guessed.
 *
 * The splitter is `tokenizeAnsi` from the published `silvery/ui/ansi` entry (0.29.2+). @cto's standing
 * rule is that terminfo.dev never grows a second splitter, and a run-time unclassifiable write is
 * run-fatal, so this decision is made once, here, from the retained traces.
 */
import { tokenizeAnsi, type AnsiToken } from "silvery/ui/ansi"
import { classifyWrite, type LedgerAttribute } from "./attribute-ledger.ts"

/** The closed-list names a window-basis write can carry besides its attributes. */
export type WindowWriteKind = "screen-text" | "erase" | "cursor-move" | "window-size"

/** One write, named by the lists it satisfies, or the reason it satisfies none. */
export type WindowWriteClassification =
  | {
      readonly kinds: readonly WindowWriteKind[]
      /** Every attribute this write changes, in token order. */
      readonly attributes: readonly LedgerAttribute[]
      /** The exact sequences that changed an attribute, so a restore target can be read off them. */
      readonly attributeSequences: readonly string[]
    }
  | { readonly unclassified: string }

const CSI_ERASE = /^\x1b\[[0-9;]*[JK]$/
const CSI_CURSOR_MOVE = /^\x1b\[[0-9;]*H$/
const CSI_WINDOW_SIZE = /^\x1b\[(?:8;[0-9]+;[0-9]+|18)t$/

/** Printable bytes plus CR and LF, which is @cto's screen-text list and nothing wider. */
function isScreenText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? -1
    if (code === 0x0d || code === 0x0a) continue
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

type TokenClassification =
  | { readonly kind: WindowWriteKind }
  | { readonly attributes: readonly LedgerAttribute[] }
  | { readonly unclassified: string }

function classifyToken(token: AnsiToken, touched: readonly LedgerAttribute[]): TokenClassification {
  switch (token.type) {
    case "text":
      return isScreenText(token.value)
        ? { kind: "screen-text" }
        : {
            unclassified: `text carries a control byte outside CR, LF and printable ASCII: ${JSON.stringify(token.value.slice(0, 24))}`,
          }
    case "csi": {
      if (CSI_ERASE.test(token.value)) return { kind: "erase" }
      if (CSI_CURSOR_MOVE.test(token.value)) return { kind: "cursor-move" }
      if (CSI_WINDOW_SIZE.test(token.value)) return { kind: "window-size" }
      const classification = classifyWrite(token.value, touched)
      if ("attributes" in classification) return { attributes: classification.attributes }
      return { unclassified: `CSI is on no closed list: ${JSON.stringify(token.value.slice(0, 24))}` }
    }
    case "osc": {
      const classification = classifyWrite(token.value, touched)
      if ("attributes" in classification) return { attributes: classification.attributes }
      return { unclassified: `OSC is on no closed list: ${JSON.stringify(token.value.slice(0, 24))}` }
    }
    case "esc":
      return /^\x1b[78]$/.test(token.value)
        ? {
            unclassified:
              "ESC 7/ESC 8 save-restore is not on a closed list, and no retained write proves sgr plus origin plus charset",
          }
        : { unclassified: `ESC is on no closed list: ${JSON.stringify(token.value.slice(0, 24))}` }
    default:
      return { unclassified: `${token.type} is on no closed list` }
  }
}

/**
 * Classify one write. A truncated CSI or OSC tokenizes as `csi`/`osc` with no final byte, so the
 * anchored lists above never match it: an incomplete sequence classifies nothing. A bare `ESC ( B`
 * charset designation is an `esc` token and is likewise named, never treated as screen text.
 *
 * `touched` is what the cell changed before this write; the restore ledger passes it so a union reset
 * (DECSTR, OSC 104) can name what it resets, the same rule `classifyWrite` applies (34579). Attributes
 * an earlier token of this same write changed count as touched too.
 */
export function classifyWindowWrite(
  write: string,
  touched: readonly LedgerAttribute[] = [],
): WindowWriteClassification {
  const kinds: WindowWriteKind[] = []
  const attributes: LedgerAttribute[] = []
  const attributeSequences: string[] = []
  for (const token of tokenizeAnsi(write)) {
    const classification = classifyToken(token, [...touched, ...attributes])
    if ("unclassified" in classification) return { unclassified: classification.unclassified }
    if ("kind" in classification) {
      if (!kinds.includes(classification.kind)) kinds.push(classification.kind)
      continue
    }
    attributes.push(...classification.attributes)
    attributeSequences.push(token.value)
  }
  return { kinds, attributes, attributeSequences }
}
