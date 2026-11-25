/**
 * Plain-English card presenter for terminfo.dev 2.7.4 result cards (#38269, mock v12).
 *
 * Implements the operator-approved v12 card layout (/hh/var/@cpo/term/operator-feedback/card-mock-v12.html)
 * and @cpo/term's product calls (e61c3c04):
 *   - Top row: feature title (+ optional vendor extension tag, Item 8) + verdict pill top right.
 *   - Who line: terminal version (or spelled-out "X library (no window)") · OS · date (no kernel version).
 *   - Steps (single surface, no inner background): numbered rows with left-aligned bytes in col 2 and
 *     plain words in col 3. Long byte payloads are cut with "…" (full bytes live in Details).
 *   - Blue ← readout row: "Reply:", "Library says:", "TERM_FEATURES:", "Window title:", "Notification:",
 *     "Working folder:", "Clipboard:", or "Terminal sent:" — with a small ✓ / ✕ / ≠ mark beside the words.
 *   - Screen results: steps, then top-aligned pictures ("Expected" + "<Terminal>'s screen <mark>", or
 *     "<Terminal>'s screen <mark>" alone when no Expected picture exists, with expected described in the
 *     closing sentence). Text-cell captures show the captured cells as text in the picture box.
 *   - Derived unsupported: no evidence block; one sentence linking to the unsupported parent feature.
 *   - Closing row: plain sentence only (no pill), carrying any caveat.
 */
import type { AppCellStatus } from "../../data/app-cells.ts"
import { formatControlBytes, type TraceCaptures, type TraceEvent, type TraceQuery } from "../../data/evidence-reader.ts"

export interface CardStepRow {
  readonly num: number
  readonly code: string
  /** Full un-shortened bytes for the hover title when `code` is shortened with "…" (v16). */
  readonly fullCode?: string
  /** Muted italic placeholder in the bytes column when a step sends no bytes (v16). */
  readonly codeMuted?: "no bytes"
  /** True for short setup/seed rows styled grey (Style 5, #38269). */
  readonly setup?: boolean
  readonly words: string
}

export interface CardReadoutRow {
  readonly label: string
  readonly text: string
  readonly code: string
  /** Full un-shortened bytes for the hover title when `code` is shortened with "…" (v16). */
  readonly fullCode?: string
  /** Muted italic placeholder when a readout has no reply bytes ("nothing" or "read directly", v16). */
  readonly codeMuted?: "nothing" | "read directly"
  /**
   * Verdict mark in column 4 (v16). Set ONLY when this single readout row is the decisive verdict proof
   * (or carries its own context's grade on Differs). Omitted when multiple replies exist and we cannot
   * prove which one decided the verdict (never guess).
   */
  readonly mark?: "ok" | "no"
}

/** Style 5 EXPECTED row inside the result panel (#38269). Bytes only for reply families; never fake bytes. */
export interface CardExpectedRow {
  readonly code?: string
  readonly fullCode?: string
  readonly words: string
}

/** Style 5 RECEIVED row inside the result panel (#38269). Bytes only for reply families; verbatim log line for report kinds. */
export interface CardReceivedRow {
  readonly code?: string
  readonly fullCode?: string
  /** Set ONLY for reply families when the terminal sent nothing back. */
  readonly codeMuted?: "nothing"
  readonly words: string
  /** True when `words` is a verbatim parser/app log line (rendered monospace blue). */
  readonly isLog?: boolean
}

/** Style 5 bottom result line: centered, 3–6 words, green ✓ on pass or red ✕ on fail (#38269). */
export interface CardVerdict {
  readonly tone: "ok" | "no"
  readonly text: string
}

export interface CardModel {
  /** True for measured Supported/Unsupported cards (rendered with the Style 5 panel); false for Untestable/Derived/Differs/No result. */
  readonly measured: boolean
  readonly steps: readonly CardStepRow[]
  readonly expected?: CardExpectedRow
  readonly received?: CardReceivedRow
  readonly verdict?: CardVerdict
  readonly readouts: readonly CardReadoutRow[]
  /** Convenience alias for the first readout row when present. */
  readonly readout?: CardReadoutRow
  /** One-line explanation for non-measured kinds (Untestable, Derived, Differs, No result yet). */
  readonly closing: string
  readonly contextNote?: string
  readonly truncated: boolean
}

export interface ExpectedVisual {
  readonly text: string
  readonly style: Record<string, string>
  readonly caption?: string
}

export interface ExchangeInput {
  readonly writes?: readonly string[]
  readonly queries?: readonly TraceQuery[]
  readonly events?: readonly TraceEvent[]
}

const MAX_CODE_CHARS = 40

/** Truncate long inline escape payloads with "…" so every ESC stays aligned in the byte column. */
export function truncateCode(code: string, max = MAX_CODE_CHARS): { text: string; truncated: boolean } {
  if (code.length <= max) return { text: code, truncated: false }
  const tailMatch = /\s+(BEL|ESC \\)$/.exec(code)
  if (tailMatch) {
    const suffix = `… ${tailMatch[1]}`
    const headLen = Math.max(8, max - suffix.length)
    return { text: `${code.slice(0, headLen).trimEnd()}${suffix}`, truncated: true }
  }
  return { text: `${code.slice(0, max - 1).trimEnd()}…`, truncated: true }
}

const DEC_PRIVATE_MODES: Readonly<Record<string, string>> = {
  "1": "application cursor keys",
  "3": "132-column mode",
  "4": "smooth scroll",
  "5": "reverse video",
  "6": "origin mode",
  "7": "auto-wrap",
  "12": "blinking cursor",
  "25": "visible cursor",
  "45": "reverse wrap",
  "47": "legacy alternate screen",
  "66": "application keypad",
  "69": "left/right margins",
  "1000": "mouse click tracking",
  "1002": "button-event mouse",
  "1003": "all-motion mouse",
  "1004": "focus tracking",
  "1005": "UTF-8 mouse mode",
  "1006": "SGR mouse mode",
  "1007": "alternate scroll wheel",
  "1015": "urxvt mouse mode",
  "1016": "pixel mouse mode",
  "1047": "alternate screen",
  "1048": "save/restore cursor",
  "1049": "alternate screen with saved cursor",
  "2004": "bracketed paste",
  "2026": "synchronized output",
  "2027": "grapheme cluster mode",
  "2031": "color scheme reporting",
}

const SGR_NAMES: Readonly<Record<string, string>> = {
  "0": "Reset text style",
  "1": "Turn on bold",
  "2": "Turn on faint (dim)",
  "3": "Turn on italic",
  "4": "Turn on underline",
  "4:0": "Turn off underline",
  "4:1": "Turn on single underline",
  "4:2": "Turn on double underline",
  "4:3": "Turn on curly underline",
  "4:4": "Turn on dotted underline",
  "4:5": "Turn on dashed underline",
  "5": "Turn on blink",
  "7": "Turn on reverse video",
  "8": "Turn on hidden text",
  "9": "Turn on strikethrough",
  "21": "Turn on double underline",
  "22": "Turn off bold and faint",
  "23": "Turn off italic",
  "24": "Turn off underline",
  "25": "Turn off blink",
  "27": "Turn off reverse video",
  "28": "Turn off hidden text",
  "29": "Turn off strikethrough",
  "39": "Reset text color",
  "49": "Reset background color",
  "53": "Turn on overline",
  "55": "Turn off overline",
  "59": "Reset underline color",
}

const VENDOR_BY_FEATURE: Readonly<Record<string, string>> = {
  "extensions.osc776-cell-size": "rxvt-unicode extension",
  "extensions.osc701-locale": "rxvt-unicode extension",
  "extensions.osc702-version": "rxvt-unicode extension",
  "extensions.osc710-font-normal": "rxvt-unicode extension",
  "extensions.osc720-scroll-up": "rxvt-unicode extension",
  "extensions.osc777-notify": "rxvt-unicode extension",
  "extensions.osc7770-font-size": "Mintty extension",
  "extensions.osc7777-font-window-size": "Mintty extension",
  "extensions.osc440-audio": "Mintty extension",
  "extensions.osc555-flash": "Foot extension",
  "extensions.osc176-app-id": "Foot extension",
  "extensions.osc666-termprop": "VTE extension",
  "extensions.osc3008-context": "systemd extension",
  "extensions.osc9-progress": "ConEmu extension",
  "extensions.iterm2-images": "iTerm2 extension",
  "extensions.osc1337-cellsize": "iTerm2 extension",
  "extensions.osc1337-capabilities": "iTerm2 extension",
  "device.term-features": "iTerm2 extension",
  "device.env-lc-terminal": "iTerm2 extension",
  "extensions.osc-633-vscode": "VS Code extension",
  "extensions.osc633-a": "VS Code extension",
  "extensions.osc633-b": "VS Code extension",
  "extensions.osc633-c": "VS Code extension",
  "extensions.osc633-d": "VS Code extension",
  "extensions.osc633-e": "VS Code extension",
  "extensions.osc633-p": "VS Code extension",
  "extensions.osc99-kitty-notify": "Kitty extension",
  "extensions.osc66-text-sizing": "Kitty extension",
  "extensions.osc21-kitty-color": "Kitty extension",
  "extensions.osc5522-clipboard": "Kitty extension",
  "extensions.osc30001-color-stack-push": "Kitty extension",
  "extensions.osc30101-color-stack-pop": "Kitty extension",
  "input.urxvt-mouse": "rxvt-unicode extension",
}

export function vendorExtensionOrigin(
  featureId: string,
  tags?: readonly string[],
  testedTerminal?: string,
): string | undefined {
  let origin: string | undefined = VENDOR_BY_FEATURE[featureId]
  if (!origin) {
    if (featureId.startsWith("extensions.kitty-") || featureId.startsWith("input.kitty-")) origin = "Kitty extension"
    else if (tags?.includes("vscode-extensions")) origin = "VS Code extension"
    else if (tags?.includes("iterm2")) origin = "iTerm2 extension"
    else if (tags?.includes("conemu")) origin = "ConEmu extension"
    else if (tags?.includes("kitty-extensions") && !tags.includes("ecma-48")) origin = "Kitty extension"
  }
  if (!origin) return undefined
  const target = testedTerminal?.trim()
  if (target) {
    const vendor = origin.replace(/\s+extension$/iu, "").trim()
    if (vendor && target.toLowerCase() !== vendor.toLowerCase()) {
      return `${vendor}'s command, tested in ${target}`
    }
  }
  return origin
}

export function shortTerminalName(subjectName: string, subjectKind?: string): string {
  let clean = subjectName
    .replace(/\s*\((?:Linux|macOS|Windows|lib|library)\)\s*$/iu, "")
    .replace(/\s+library(?:\s*\(no window\))?$/iu, "")
    .trim()
  if (subjectKind === "lib" && /\blib\b/i.test(subjectName) && !clean) clean = subjectName
  return clean || subjectName
}

export function formatWhoLine(input: {
  readonly subjectName: string
  readonly version?: string
  readonly subjectKind?: string
  readonly osName?: string
  readonly measuredDate?: string
}): string {
  const isLib = input.subjectKind === "lib" || /\(lib\)\s*$/iu.test(input.subjectName)
  const base = shortTerminalName(input.subjectName, input.subjectKind)
  const datePart = input.measuredDate
    ? /^tested\s+/iu.test(input.measuredDate)
      ? input.measuredDate
      : `tested ${input.measuredDate}`
    : undefined
  if (isLib) {
    const namePart = input.version ? `${base} ${input.version}` : base
    return [namePart, "library (no window)", input.osName, datePart].filter(Boolean).join(" · ")
  }
  const namePart = input.version ? `${base} ${input.version}` : base
  return [namePart, input.osName, datePart].filter(Boolean).join(" · ")
}

function isCollectorScaffoldingWrite(raw: string): boolean {
  if (/^\x1b7\x1b\[\d+;\d+H\x1b\[0m(?:\x1b\[45m)?\s+\x1b\[\d+;\d+H(?:\x1b\[45m)?\s+\x1b\[0m\x1b8$/u.test(raw)) {
    return true
  }
  if (/^\x1b\[1;1H(?:\d+-[0-9a-f]{16,}|\s+)$/u.test(raw)) return true
  if (raw === "\x1b[?25l" || raw === "\x1b[?25h" || raw === "\x1b[2J\x1b[H") return true
  return false
}

export function splitRawCommands(raw: string): Array<{ raw: string; isText: boolean }> {
  const normalized = raw.replace(/\\x1b/gi, "\x1b")
  const out: Array<{ raw: string; isText: boolean }> = []
  let i = 0
  while (i < normalized.length) {
    const ch = normalized.charCodeAt(i)
    if (ch === 0x1b) {
      const next = normalized[i + 1]
      if (next === "[") {
        const m = /^\x1b\[[?>=<]?[0-9:;]*[ -/]*[@-~]/.exec(normalized.slice(i))
        if (m) {
          out.push({ raw: m[0], isText: false })
          i += m[0].length
          continue
        }
      } else if (next === "]") {
        const belIdx = normalized.indexOf("\x07", i + 2)
        const stIdx = normalized.indexOf("\x1b\\", i + 2)
        const endIdx = belIdx !== -1 && (stIdx === -1 || belIdx < stIdx) ? belIdx + 1 : stIdx !== -1 ? stIdx + 2 : -1
        if (endIdx !== -1) {
          out.push({ raw: normalized.slice(i, endIdx), isText: false })
          i = endIdx
          continue
        }
      } else if (next === "P" || next === "_" || next === "^") {
        const stIdx = normalized.indexOf("\x1b\\", i + 2)
        if (stIdx !== -1) {
          out.push({ raw: normalized.slice(i, stIdx + 2), isText: false })
          i = stIdx + 2
          continue
        }
      } else if (next && /[78cDEHM=>NO\\]/.test(next)) {
        out.push({ raw: normalized.slice(i, i + 2), isText: false })
        i += 2
        continue
      } else if (next && /[()*/+-]/.test(next) && normalized[i + 2]) {
        out.push({ raw: normalized.slice(i, i + 3), isText: false })
        i += 3
        continue
      }
      out.push({ raw: "\x1b", isText: false })
      i += 1
      continue
    }
    if (ch < 0x20 || ch === 0x7f) {
      let end = i + 1
      while (end < normalized.length && normalized.charCodeAt(end) === ch) end++
      out.push({ raw: normalized.slice(i, end), isText: false })
      i = end
      continue
    }
    let end = i + 1
    while (end < normalized.length && normalized.charCodeAt(end) >= 0x20 && normalized.charCodeAt(end) !== 0x7f) {
      end++
    }
    const text = normalized.slice(i, end)
    if (text.trim().length > 0) out.push({ raw: text, isText: true })
    i = end
  }
  return out
}

function isDa1Fence(raw: string): boolean {
  return /^\x1b\[0?c$/.test(raw)
}

function isDa1Reply(raw: string): boolean {
  return /^\x1b\[\?[0-9;]+c$/.test(raw)
}

function isResetOrClearCommand(raw: string): boolean {
  return (
    raw === "\x1b[0m" ||
    raw === "\x1b[m" ||
    raw === "\x1b[2J" ||
    raw === "\x1b[0J" ||
    raw === "\x1b[J" ||
    raw === "\x1b[H" ||
    raw === "\x1b[?25l" ||
    raw === "\x1b[?25h"
  )
}

function featureTestsReset(featureId?: string): boolean {
  if (!featureId) return false
  return (
    featureId.includes("reset") ||
    featureId.includes("clear") ||
    featureId.includes("erase") ||
    featureId.includes("default") ||
    featureId.includes("cursor.visibility") ||
    featureId.includes("cursor.show") ||
    featureId.includes("cursor.hide")
  )
}

function featureTestsCursorPosition(featureId?: string): boolean {
  if (!featureId) return false
  return (
    featureId.startsWith("cursor.") ||
    featureId.startsWith("scroll.") ||
    featureId.startsWith("scrollback.") ||
    featureId.startsWith("editing.") ||
    featureId.startsWith("text.") ||
    featureId.includes("margin") ||
    featureId.includes("wrap")
  )
}

function isSaveRestoreFeature(featureId?: string): boolean {
  return featureId === "cursor.save-restore" || featureId === "cursor.ansi-save" || featureId === "cursor.ansi-restore"
}

function isDa1Feature(featureId?: string): boolean {
  return featureId === "device.da1" || featureId === "device.primary-da" || featureId === "extensions.sixel-da1"
}

/** Decode one sent command into plain words (never empty; falls back to family name). */
export function explainSentCommand(
  raw: string,
  isText: boolean,
  hasCaptures = false,
): { words: string; fallback: boolean } {
  if (isText) return { words: "Draw text", fallback: false }
  if (raw === "\x1b7") return { words: "Save the cursor", fallback: false }
  if (raw === "\x1b8") return { words: "Restore", fallback: false }
  if (raw === "\x1bc") return { words: "Full terminal reset", fallback: false }
  if (raw === "\x1bH") return { words: "Set a tab stop here", fallback: false }
  if (raw === "\x1bD") return { words: "Move down (index)", fallback: false }
  if (raw === "\x1bM") return { words: "Move up (reverse index)", fallback: false }
  if (raw === "\x1bE") return { words: "Move to next line", fallback: false }
  if (raw === "\x1b(0") return { words: "Select line-drawing charset (G0)", fallback: false }
  if (raw === "\x1b(B") return { words: "Select ASCII charset (G0)", fallback: false }
  if (raw === "\x1b)0") return { words: "Select line-drawing charset (G1)", fallback: false }
  if (raw === "\x1b)B") return { words: "Select ASCII charset (G1)", fallback: false }
  if (raw === "\x0e") return { words: "Switch to G1 charset", fallback: false }
  if (raw === "\x0f") return { words: "Switch to G0 charset", fallback: false }
  if (/^\x08+$/.test(raw))
    return { words: raw.length === 1 ? "Backspace" : `${raw.length} backspaces`, fallback: false }
  if (raw === "\n") return { words: "New line", fallback: false }
  if (raw === "\r") return { words: "Carriage return", fallback: false }
  if (raw === "\t") return { words: "Tab", fallback: false }

  const decrqm = /^\x1b\[(\??)(\d+)\$p$/.exec(raw)
  if (decrqm) return { words: `Ask: do you know mode ${decrqm[2]}?`, fallback: false }

  const decset = /^\x1b\[\?(\d+)([hl])$/.exec(raw)
  if (decset) {
    const mode = decset[1]!
    const label = DEC_PRIVATE_MODES[mode]
    const verb = decset[2] === "h" ? "Turn on" : "Turn off"
    return { words: label ? `${verb} ${label}` : `${verb} mode ${mode}`, fallback: false }
  }

  const sm = /^\x1b\[(\d+)([hl])$/.exec(raw)
  if (sm) {
    const verb = sm[2] === "h" ? "Turn on" : "Turn off"
    return { words: sm[1] === "4" ? `${verb} insert mode` : `${verb} mode ${sm[1]}`, fallback: false }
  }

  if (isDa1Fence(raw)) return { words: "Ask terminal ID", fallback: false }
  if (/^\x1b\[>0?c$/.test(raw)) return { words: "Ask secondary terminal ID", fallback: false }
  if (/^\x1b\[>0?q$/.test(raw)) return { words: "Ask terminal name and version", fallback: false }
  if (raw === "\x1b[6n") return { words: "Ask where the cursor is", fallback: false }
  if (raw === "\x1b[5n") return { words: "Ask if terminal is ready", fallback: false }
  if (raw === "\x1b[?996n") return { words: "Ask light or dark theme", fallback: false }
  if (raw === "\x1b[s") return { words: "Save the cursor", fallback: false }
  if (raw === "\x1b[u") return { words: "Restore", fallback: false }
  if (raw === "\x1b[H" || raw === "\x1b[1;1H") return { words: "Move to 1;1", fallback: false }

  const cup = /^\x1b\[(\d+);(\d+)H$/.exec(raw)
  if (cup) return { words: `Move to ${cup[1]};${cup[2]}`, fallback: false }

  const move = /^\x1b\[(\d*)([ABCD])$/.exec(raw)
  if (move) {
    const n = move[1] || "1"
    const dir = { A: "up", B: "down", C: "right", D: "left" }[move[2]!]!
    return { words: `Move ${dir} ${n}`, fallback: false }
  }

  const cpl = /^\x1b\[(\d*)([EF])$/.exec(raw)
  if (cpl) return { words: `${cpl[2] === "E" ? "Next" : "Previous"} line ×${cpl[1] || "1"}`, fallback: false }
  const cha = /^\x1b\[(\d*)G$/.exec(raw)
  if (cha) return { words: `Move to column ${cha[1] || "1"}`, fallback: false }
  const vpa = /^\x1b\[(\d*)d$/.exec(raw)
  if (vpa) return { words: `Move to row ${vpa[1] || "1"}`, fallback: false }
  const tbc = /^\x1b\[(\d*)g$/.exec(raw)
  if (tbc) return { words: tbc[1] === "3" ? "Clear all tab stops" : "Clear tab stop here", fallback: false }
  const tabMove = /^\x1b\[(\d*)([IZ])$/.exec(raw)
  if (tabMove) return { words: `Tab ${tabMove[2] === "I" ? "forward" : "back"} ${tabMove[1] || "1"}`, fallback: false }
  const decstbm = /^\x1b\[(\d*);?(\d*)r$/.exec(raw)
  if (decstbm) {
    return {
      words: decstbm[1] && decstbm[2] ? `Set scroll region rows ${decstbm[1]}–${decstbm[2]}` : "Reset scroll region",
      fallback: false,
    }
  }
  const scroll = /^\x1b\[(\d*)([ST])$/.exec(raw)
  if (scroll) return { words: `Scroll ${scroll[2] === "S" ? "up" : "down"} ${scroll[1] || "1"}`, fallback: false }
  const edit = /^\x1b\[(\d*)([@PLMX])$/.exec(raw)
  if (edit) {
    const n = edit[1] || "1"
    const verb = { "@": "Insert chars", P: "Delete chars", L: "Insert lines", M: "Delete lines", X: "Erase chars" }[
      edit[2]!
    ]!
    return { words: `${verb} (${n})`, fallback: false }
  }
  const rep = /^\x1b\[(\d*)b$/.exec(raw)
  if (rep) return { words: `Repeat last char ×${rep[1] || "1"}`, fallback: false }

  if (raw === "\x1b[2J") return { words: "Clear screen", fallback: false }
  if (raw === "\x1b[0J" || raw === "\x1b[J") return { words: "Clear below cursor", fallback: false }
  if (raw === "\x1b[1J") return { words: "Clear above cursor", fallback: false }
  if (raw === "\x1b[3J") return { words: "Clear scrollback", fallback: false }
  if (/^\x1b\[[012]?K$/.test(raw)) return { words: "Clear line", fallback: false }

  if (/^\x1b\[\?2;1;0S$/.test(raw)) return { words: "Ask Sixel pixel geometry", fallback: false }
  if (/^\x1b\[#P$/.test(raw)) return { words: "Push palette onto stack", fallback: false }
  if (/^\x1b\[#Q$/.test(raw)) return { words: "Pop palette from stack", fallback: false }
  if (/^\x1b\[#R$/.test(raw)) return { words: "Ask palette stack status", fallback: false }
  if (/^\x1b\[#\{$/.test(raw)) return { words: "Push text attributes", fallback: false }
  if (/^\x1b\[#\}$/.test(raw)) return { words: "Pop text attributes", fallback: false }
  const hpa = /^\x1b\[(\d*)`$/.exec(raw)
  if (hpa) return { words: `Move to column ${hpa[1] || "1"}`, fallback: false }
  const cursorShape = /^\x1b\[(\d*) q$/.exec(raw)
  if (cursorShape) return { words: `Set cursor shape (${cursorShape[1] || "default"})`, fallback: false }
  if (/^\x1b\[=0?c$/.test(raw)) return { words: "Ask tertiary terminal ID (DA3)", fallback: false }
  const decsca = /^\x1b\[(\d*)"q$/.exec(raw)
  if (decsca)
    return { words: decsca[1] === "1" ? "Protect cells from selective erase" : "Unprotect cells", fallback: false }
  const decsace = /^\x1b\[(\d*)\*x$/.exec(raw)
  if (decsace) return { words: "Set rectangular edit mode (DECSACE)", fallback: false }
  const rectOp = /^\x1b\[([0-9;]*)\$([rzvtx\{])$/.exec(raw)
  if (rectOp) {
    const params = (rectOp[1] ?? "").split(";")
    const op = rectOp[2] ?? ""
    const [pt, pl, pb, pr, ...rest] = params
    const rectDesc = pt && pl && pb && pr ? `rows ${pt}–${pb}, cols ${pl}–${pr}` : "rectangle"
    if (op === "r" || op === "t") {
      const rectAttrNames: Record<string, string> = {
        "0": "plain",
        "1": "bold",
        "4": "underline",
        "5": "blink",
        "7": "inverse",
        "22": "not bold",
        "24": "not underlined",
        "25": "not blinking",
        "27": "not inverse",
      }
      const attrLabels = rest
        .filter((code) => code !== "")
        .map((code) => (rectAttrNames[code] ? `${rectAttrNames[code]} (${code})` : `SGR ${code}`))
      const attrText = attrLabels.length > 0 ? attrLabels.join(", ") : "attributes"
      const verb = op === "r" ? "Set" : "Reverse"
      const tag = op === "r" ? "DECCARA" : "DECRARA"
      return { words: `${verb} ${attrText} in ${rectDesc} (${tag})`, fallback: false }
    }
    const names: Record<string, string> = {
      v: "Copy rectangular area (DECCRA)",
      x: `Fill ${rectDesc} (DECFRA)`,
      z: `Erase ${rectDesc} (DECERA)`,
      "{": `Selectively erase ${rectDesc} (DECSERA)`,
    }
    return { words: names[op] ?? "Edit rectangular region", fallback: false }
  }
  const rectCksum = /^\x1b\[[0-9;]*\*y$/.exec(raw)
  if (rectCksum) return { words: "Ask rectangle checksum (DECRQCRA)", fallback: false }
  const decic = /^\x1b\[(\d*)'([}~])$/.exec(raw)
  if (decic) {
    return {
      words: decic[2] === "}" ? `Insert columns (${decic[1] || "1"})` : `Delete columns (${decic[1] || "1"})`,
      fallback: false,
    }
  }
  const slsr = /^\x1b\[(\d*) ([ @A])$/.exec(raw)
  if (slsr && (slsr[2] === "@" || slsr[2] === "A")) {
    return {
      words: slsr[2] === "@" ? `Shift left (${slsr[1] || "1"})` : `Shift right (${slsr[1] || "1"})`,
      fallback: false,
    }
  }

  const sgr = /^\x1b\[([0-9;:]*)m$/.exec(raw)
  if (sgr) {
    const p = sgr[1] || "0"
    const base = SGR_NAMES[p]
      ? SGR_NAMES[p]!
      : /^38[;:]2/.test(p)
        ? "Set 24-bit text color"
        : /^48[;:]2/.test(p)
          ? "Set 24-bit background"
          : /^58[;:]2/.test(p)
            ? "Set 24-bit underline color"
            : /^38[;:]5/.test(p)
              ? "Set 256-color text"
              : /^48[;:]5/.test(p)
                ? "Set 256-color background"
                : /^58[;:]5/.test(p)
                  ? "Set underline color"
                  : /^(?:3[0-7]|9[0-7])$/.test(p)
                    ? "Set text color"
                    : /^(?:4[0-7]|10[0-7])$/.test(p)
                      ? "Set background color"
                      : `Set style (SGR ${p})`
    return { words: hasCaptures && p !== "0" ? `${base} and draw text` : base, fallback: false }
  }

  const winops = /^\x1b\[(\d+(?:;\d+)*)t$/.exec(raw)
  if (winops) {
    const code = winops[1]!.split(";")[0]
    if (code === "14") return { words: "Ask window size in pixels", fallback: false }
    if (code === "16") return { words: "Ask cell size in pixels", fallback: false }
    if (code === "18") return { words: "Ask grid size", fallback: false }
    if (code === "22") return { words: "Save window title", fallback: false }
    if (code === "23") return { words: "Restore window title", fallback: false }
    return { words: `Window op (CSI ${winops[1]} t)`, fallback: false }
  }

  if (raw === "\x1b[?u") return { words: "Ask Kitty keyboard flags", fallback: false }
  if (/^\x1b\[>[0-9;]*u$/.test(raw)) return { words: "Enable Kitty keyboard flags", fallback: false }
  if (/^\x1b\[<[0-9]*u$/.test(raw)) return { words: "Pop Kitty keyboard flags", fallback: false }
  if (/^\x1bP\$qm(?:\x1b\\)?$/.test(raw)) return { words: "Ask the current text style", fallback: false }
  if (/^\x1bP\$q/.test(raw)) return { words: "Ask current setting (DECRQSS)", fallback: false }
  if (/^\x1bP\+q/.test(raw)) return { words: "Ask terminfo capability", fallback: false }
  if (/^\x1bP\+Q/.test(raw)) return { words: "Ask xterm resource", fallback: false }

  const osc = /^\x1b\](\d+)(?:;([\s\S]*?))?(?:\x07|\x1b\\)$/.exec(raw)
  if (osc) {
    const code = osc[1]!
    const arg = osc[2] ?? ""
    if (code === "0" || code === "2") return { words: "Set window title", fallback: false }
    if (code === "1") return { words: "Set icon title", fallback: false }
    if (code === "4") return { words: arg.endsWith("?") ? "Ask palette color" : "Set palette color", fallback: false }
    if (code === "5") return { words: arg.endsWith("?") ? "Ask special color" : "Set special color", fallback: false }
    if (code === "7") return { words: "Report working folder", fallback: false }
    if (code === "8") return { words: arg.includes("://") ? "Start hyperlink" : "End hyperlink", fallback: false }
    if (code === "9")
      return { words: arg.startsWith("4;") ? "Set progress bar" : "Send notification (OSC 9)", fallback: false }
    if (code === "10") return { words: arg === "?" ? "Ask text color" : "Set text color", fallback: false }
    if (code === "11") return { words: arg === "?" ? "Ask background color" : "Set background color", fallback: false }
    if (code === "12") return { words: arg === "?" ? "Ask cursor color" : "Set cursor color", fallback: false }
    if (/^(?:13|14|15|16|17|18|19)$/.test(code)) {
      return { words: arg === "?" ? `Ask OSC ${code} color` : `Set OSC ${code} color`, fallback: false }
    }
    if (/^1(?:04|10|11|12|13|14|15|16|17|18|19)$/.test(code)) {
      return { words: `Reset color (OSC ${code})`, fallback: false }
    }
    if (code === "21") return { words: "Query/set Kitty color (OSC 21)", fallback: false }
    if (code === "22") return { words: arg === "?" ? "Ask pointer shape" : "Set pointer shape", fallback: false }
    if (code === "50") return { words: arg === "?" ? "Ask font name" : "Set font name", fallback: false }
    if (code === "52") {
      return { words: arg.endsWith("?") ? "Read the clipboard" : "Put test text on the clipboard", fallback: false }
    }
    if (code === "99") return { words: "Send Kitty notification", fallback: false }
    if (code === "133") return { words: "Send prompt mark", fallback: false }
    if (code === "176") return { words: "Set app ID (OSC 176)", fallback: false }
    if (code === "440") return { words: "Play audio bell (OSC 440)", fallback: false }
    if (code === "555") return { words: "Flash screen (OSC 555)", fallback: false }
    if (code === "633") return { words: "Send VS Code shell mark", fallback: false }
    if (code === "776") return { words: "Ask: how big is a cell?", fallback: false }
    if (code === "777") return { words: "Send notification (OSC 777)", fallback: false }
    if (code === "1337") return { words: "Send iTerm2 command", fallback: false }
    if (code === "3008") return { words: "Send shell context (OSC 3008)", fallback: false }
    if (code === "7654") return { words: "Send unknown OSC control (negative check)", fallback: false }
    if (code === "30001") return { words: "Push color stack (OSC 30001)", fallback: false }
    if (code === "30101") return { words: "Pop color stack (OSC 30101)", fallback: false }
    return { words: `OSC ${code} command`, fallback: true }
  }

  if (raw.startsWith("\x1b_G")) return { words: "Send Kitty graphics command", fallback: false }
  if (raw.startsWith("\x1b[")) return { words: "CSI sequence", fallback: true }
  if (raw.startsWith("\x1bP")) return { words: "DCS sequence", fallback: true }
  if (raw.startsWith("\x1b_")) return { words: "APC sequence", fallback: true }
  return { words: "Escape sequence", fallback: true }
}

/** Decode one reply command into plain words (never empty; falls back to family name). */
export function explainReplyCommand(raw: string): { words: string; fallback: boolean } {
  const decrpm = /^\x1b\[(\??)(\d+);(\d+)\$y$/.exec(raw)
  if (decrpm) {
    const pm = decrpm[3]!
    if (pm === "0") return { words: "“Not recognized”", fallback: false }
    if (pm === "1") return { words: "“Yes, it is on right now”", fallback: false }
    if (pm === "2") return { words: "“Yes, it is off right now”", fallback: false }
    if (pm === "3") return { words: "“Yes, always on”", fallback: false }
    if (pm === "4") return { words: "“No, always off”", fallback: false }
    return { words: `“Mode status ${pm}”`, fallback: false }
  }
  const cpr = /^\x1b\[(\d+);(\d+)R$/.exec(raw)
  if (cpr) return { words: `“At ${cpr[1]};${cpr[2]}”`, fallback: false }
  if (isDa1Reply(raw)) return { words: "terminal ID", fallback: false }
  if (/^\x1b\[>[0-9;]+c$/.test(raw)) return { words: "secondary terminal ID", fallback: false }
  if (raw === "\x1b[0n") return { words: "“Ready”", fallback: false }
  if (raw === "\x1b[?997;1n") return { words: "“Dark theme”", fallback: false }
  if (raw === "\x1b[?997;2n") return { words: "“Light theme”", fallback: false }
  if (raw === "\x1b[O") return { words: "“focus out”", fallback: false }
  if (raw === "\x1b[I") return { words: "“focus in”", fallback: false }
  const kbd = /^\x1b\[\?(\d+)u$/.exec(raw)
  if (kbd) return { words: `“Keyboard flags ${kbd[1]}”`, fallback: false }
  const decrqss = /^\x1bP([01])\$r([\s\S]*?)\x1b\\$/.exec(raw)
  if (decrqss) {
    if (decrqss[1] !== "1") return { words: "“Not recognized”", fallback: false }
    const val = decrqss[2] ?? ""
    if (val === "" || val === "m" || val === "0m") return { words: "“Style: plain”", fallback: false }
    return { words: val.endsWith("m") ? `“Style: ${val}”` : `“Setting: ${val}”`, fallback: false }
  }
  const tcap = /^\x1bP([01])\+([rR])([\s\S]*?)\x1b\\$/.exec(raw)
  if (tcap) {
    const what = tcap[2] === "R" ? "resource" : "capability"
    return { words: tcap[1] === "1" ? `reported ${what}` : `${what} not recognized`, fallback: false }
  }
  const cksum = /^\x1bP\d+!~([0-9a-fA-F]+)\x1b\\$/.exec(raw)
  if (cksum) return { words: `rectangle checksum ${cksum[1]}`, fallback: false }
  const xtver = /^\x1bP>\|([\s\S]*?)\x1b\\$/.exec(raw)
  if (xtver) return { words: `“${xtver[1]}”`, fallback: false }
  const xtreport = /^\x1b\[\??(\d+);(\d+)#Q$/.exec(raw)
  if (xtreport) return { words: `color stack (${xtreport[1]} saved)`, fallback: false }
  const sixelGeo = /^\x1b\[\?2;0;(\d+);(\d+)S$/.exec(raw)
  if (sixelGeo) return { words: `Sixel area ${sixelGeo[1]}×${sixelGeo[2]} px`, fallback: false }
  if (/^\x1b\[\?2;\d+S$/.test(raw)) return { words: "Sixel geometry status", fallback: false }
  const sgrMouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(raw)
  if (sgrMouse) {
    return {
      words: `mouse ${sgrMouse[4] === "M" ? "press" : "release"} at ${sgrMouse[2]};${sgrMouse[3]}`,
      fallback: false,
    }
  }
  if (/^\x1b\[M[\s\S]{3}$/.test(raw)) return { words: "X10 mouse event", fallback: false }
  if (/^\x1b\[[ABCD]$/.test(raw)) return { words: "arrow key sequence", fallback: false }
  if (/^\x1b_G[\s\S]*?;OK\x1b\\$/.test(raw)) return { words: "“OK”", fallback: false }
  if (/^\x1b\](?:4|5|10|11|12|13|14|15|16|17|18|19|21);/.test(raw)) return { words: "reported color", fallback: false }
  if (/^\x1b\]22;/.test(raw)) return { words: "reported pointer shape", fallback: false }
  if (/^\x1b\]99;/.test(raw)) return { words: "reported notification capabilities", fallback: false }
  if (/^\x1b\]776;/.test(raw)) return { words: "reported cell size", fallback: false }
  if (/^\x1b\]1337;/.test(raw)) return { words: "reported capability", fallback: false }
  if (/^\x1b\]52;/.test(raw)) return { words: "returned clipboard text", fallback: false }
  const winSize = /^\x1b\[([468]);(\d+);(\d+)t$/.exec(raw)
  if (winSize) {
    if (winSize[1] === "4") return { words: `window ${winSize[3]}×${winSize[2]} px`, fallback: false }
    if (winSize[1] === "6") return { words: `cell ${winSize[3]}×${winSize[2]} px`, fallback: false }
    if (winSize[1] === "8") return { words: `grid ${winSize[2]}×${winSize[3]}`, fallback: false }
  }
  if (raw.startsWith("\x1b[")) return { words: "CSI reply", fallback: true }
  if (raw.startsWith("\x1b]")) return { words: "OSC reply", fallback: true }
  if (raw.startsWith("\x1bP")) return { words: "DCS reply", fallback: true }
  return { words: "reply bytes", fallback: true }
}

/** Summarize a headless library's stored parserState into one short readout phrase ("Library says:"). */
export function summarizeLibraryState(parserState: unknown, traceEvidence?: readonly string[]): string {
  if (parserState && typeof parserState === "object" && !Array.isArray(parserState)) {
    const rec = parserState as Record<string, unknown>
    // Single cell snapshot
    if (typeof rec.char === "string") {
      const attrs = [
        "bold",
        "dim",
        "italic",
        "underline",
        "overline",
        "strikethrough",
        "inverse",
        "blink",
        "hidden",
      ].filter((k) => rec[k] === true || (typeof rec[k] === "string" && rec[k] !== "none"))
      if (attrs.length > 0) return `cell “${rec.char}” has ${attrs.join(", ")}`
      if (rec.fg && typeof rec.fg === "object") return `cell “${rec.char}” has foreground color`
      if (rec.bg && typeof rec.bg === "object") return `cell “${rec.char}” has background color`
      return `cell “${rec.char}” has plain style`
    }
    // Cursor save/restore state
    if (rec.final && typeof rec.final === "object" && rec.final !== null) {
      const f = rec.final as Record<string, unknown>
      if (typeof f.row === "number" && typeof f.col === "number") {
        return `cursor at ${f.row + 1};${f.col + 1}`
      }
    }
    if (rec.after && typeof rec.after === "object" && rec.after !== null) {
      return summarizeLibraryState(rec.after, traceEvidence)
    }
  }
  const ev = traceEvidence?.[0]
  if (ev && !/shown below/i.test(ev)) return ev.replace(/\.$/, "")
  return "state recorded in parser buffer"
}

function readbackSourceLabel(featureId: string, assertionType?: string): string {
  if (assertionType === "clipboard" || featureId.includes("osc52")) return "Clipboard"
  if (assertionType === "notification" || featureId.includes("notif")) return "Notification"
  if (assertionType === "process_environment") return "TERM_FEATURES"
  if (featureId === "extensions.osc7-cwd") return "Working folder"
  if (featureId.includes("title") || featureId === "device.xtwinops-22" || featureId === "device.xtwinops-23") {
    return "Window title"
  }
  if (assertionType === "input_bytes") return "Terminal sent"
  if (assertionType === "buffer_state") return "Terminal state"
  return "Reply"
}

function inputProbeActionWords(featureId: string): string {
  if (featureId.includes("paste")) return "Paste test text"
  if (featureId.includes("focus")) return "Move focus away and back"
  if (featureId.includes("mouse") || featureId.includes("click")) return "Click / move mouse in terminal"
  return "Send test key press"
}

const RAW_JSON_OR_STORE_PATH = /^\s*\{[\s\S]*"[\w-]+":|\/nix\/store\/[a-z0-9]{10,}/i

function sanitizeCardText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.replace(/\s+/g, " ").trim().replace(/\.$/, "")
  if (!trimmed) return undefined
  if (RAW_JSON_OR_STORE_PATH.test(trimmed)) return undefined
  return trimmed
}

function capitalizeFirst(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text
}

function shortWhoForVerdict(shortSubjectName?: string): string {
  const clean = shortSubjectName?.trim()
  if (!clean) return "Terminal"
  const words = clean.split(/\s+/).filter(Boolean)
  return words.length <= 2 ? clean : "Terminal"
}

export function countVerdictWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function isAppLogCalibrationCmd(raw: string, featureId: string): boolean {
  if (/^\x1b\](?:7654|7655);/.test(raw)) return true
  if (!featureId.includes("title") && /^\x1b\]2;/.test(raw)) return true
  return false
}

function oscCodeForFeature(featureId: string, sentCommands: readonly string[]): string | undefined {
  for (const raw of sentCommands) {
    const m = /^\x1b\](\d+)(?:;|\x07|\x1b\\)/.exec(raw)
    if (m && m[1] !== "7654" && m[1] !== "7655" && m[1] !== "2") return m[1]
  }
  const idMatch = /osc-?(\d+)/i.exec(featureId)
  return idMatch?.[1]
}

function sgrExpectedStyleName(featureId: string, sentCommands: readonly string[]): { code?: string; label: string } {
  const sgrMap: Record<string, { code: string; label: string }> = {
    "sgr.overline": { code: "53", label: "overline" },
    "sgr.bold": { code: "1", label: "bold" },
    "sgr.faint": { code: "2", label: "faint" },
    "sgr.italic": { code: "3", label: "italic" },
    "sgr.blink": { code: "5", label: "blink" },
    "sgr.inverse": { code: "7", label: "inverse" },
    "sgr.hidden": { code: "8", label: "hidden" },
    "sgr.strikethrough": { code: "9", label: "strikethrough" },
    "sgr.underline.single": { code: "4", label: "underline" },
    "sgr.underline.double": { code: "4:2", label: "double underline" },
    "sgr.underline.curly": { code: "4:3", label: "curly underline" },
    "sgr.underline.dotted": { code: "4:4", label: "dotted underline" },
    "sgr.underline.dashed": { code: "4:5", label: "dashed underline" },
  }
  if (sgrMap[featureId]) return sgrMap[featureId]!
  for (const raw of sentCommands) {
    const m = /^\x1b\[([0-9;:]+)m$/.exec(raw)
    if (m && m[1] !== "0") {
      return { code: m[1], label: SGR_NAMES[m[1]!]?.replace(/^Turn on /i, "") ?? `SGR ${m[1]}` }
    }
  }
  return { label: "styled text" }
}

function expectedReplyForProbe(opts: {
  featureId: string
  featureName: string
  sawDecrqm: boolean
  decrqmMode?: string
  saveRestore: boolean
  savedCupPos?: string
  sentCommands: readonly string[]
  queryCommands: readonly string[]
  assertionType?: string
  trimCode: (code: string) => { code: string; fullCode?: string }
}): CardExpectedRow {
  const {
    featureId,
    sawDecrqm,
    decrqmMode,
    saveRestore,
    savedCupPos,
    sentCommands,
    queryCommands,
    assertionType,
    trimCode,
  } = opts
  const apply = (rawCode: string, words: string): CardExpectedRow => {
    const t = trimCode(rawCode)
    return { code: t.code, ...(t.fullCode ? { fullCode: t.fullCode } : {}), words }
  }

  if (assertionType === "input_bytes") {
    if (featureId.includes("paste")) return apply("ESC [ 200~ … ESC [ 201~", "Pasted text in bracketed markers")
    if (featureId.includes("focus")) return apply("ESC [ O  ESC [ I", "Focus out / focus in events")
    if (featureId.includes("mouse") || featureId.includes("click") || featureId.includes("wheel")) {
      return apply("ESC [ <… M", "Mouse coordinates escape sequence")
    }
    if (featureId.includes("modify-other-keys")) return apply("ESC [ 27;… ~", "Modified key escape sequence")
    return apply("ESC [ …", "Expected key escape sequence")
  }
  if (sawDecrqm) {
    const m = decrqmMode ?? "N"
    return apply(`ESC [ ?${m};1|2 $ y`, "“Yes, on” or “Yes, off”")
  }
  if (queryCommands.some((q) => /^\x1bP\$q/.test(q))) {
    if (featureId.startsWith("sgr.")) {
      const sgr = sgrExpectedStyleName(featureId, sentCommands)
      return apply(sgr.code ? `ESC P 1 $ r ${sgr.code} m …` : "ESC P 1 $ r … m ESC \\", `“Style: ${sgr.label}”`)
    }
    return apply("ESC P 1 $ r … ESC \\", "Current setting reported")
  }
  if (saveRestore) {
    const pos = savedCupPos ?? "3;5"
    return apply(`ESC [ ${pos} R`, `“At ${pos}”`)
  }
  if (queryCommands.some((q) => q === "\x1b[6n")) {
    return apply("ESC [ <row>;<col> R", "Expected cursor position")
  }
  if (queryCommands.some((q) => q === "\x1b[5n") || featureId === "device.status-report") {
    return apply("ESC [ 0 n", "“Ready”")
  }
  if (queryCommands.some((q) => q === "\x1b[?996n") || featureId === "device.dsr-996-color-scheme") {
    return apply("ESC [ ?997;1|2 n", "“Dark theme” or “Light theme”")
  }
  if (queryCommands.some((q) => /^\x1b\[>0?q$/.test(q)) || featureId === "device.xtversion") {
    return apply("ESC P > | <name> ESC \\", "Terminal name and version")
  }
  if (queryCommands.some((q) => /^\x1b\[>0?c$/.test(q)) || featureId === "device.secondary-da") {
    return apply("ESC [ >… c", "Secondary terminal ID")
  }
  if (queryCommands.some((q) => /^\x1b\[=0?c$/.test(q))) {
    return apply("ESC P ! | … ESC \\", "Tertiary terminal ID")
  }
  if (isDa1Feature(featureId)) {
    return apply("ESC [ ?… c", "Primary terminal ID")
  }
  if (queryCommands.some((q) => q === "\x1b[?u") || featureId.includes("kitty-keyboard")) {
    return apply("ESC [ ?<flags> u", "Active keyboard flags")
  }
  if (queryCommands.some((q) => /^\x1b_G/.test(q)) || featureId === "extensions.kitty-graphics") {
    return apply("ESC _ G … ;OK ESC \\", "“OK” acknowledgement")
  }
  if (queryCommands.some((q) => /^\x1bP\+q/.test(q))) {
    return apply("ESC P 1 + r … ESC \\", "Capability value reported")
  }
  if (queryCommands.some((q) => /^\x1bP\+Q/.test(q))) {
    return apply("ESC P 1 + R … ESC \\", "Resource value reported")
  }
  if (queryCommands.some((q) => /^\x1b\[[0-9;]*\*y$/.test(q))) {
    return apply("ESC P … ! ~ <hex> ESC \\", "Rectangle checksum")
  }
  if (queryCommands.some((q) => /^\x1b\[\?2;1;0S$/.test(q))) {
    return apply("ESC [ ?2;0;<w>;<h> S", "Sixel pixel dimensions")
  }
  if (queryCommands.some((q) => /^\x1b\[#R$/.test(q)) || featureId === "device.xtreportcolors") {
    return apply("ESC [ ?<n>;<max> # Q", "Color stack depth")
  }
  const winopQ = queryCommands.find((q) => /^\x1b\[(14|16|18)(?:;\d+)*t$/.exec(q))
  if (winopQ) {
    const m = /^\x1b\[(14|16|18)/.exec(winopQ)!
    if (m[1] === "14") return apply("ESC [ 4;<h>;<w> t", "Window size in pixels")
    if (m[1] === "16") return apply("ESC [ 6;<h>;<w> t", "Cell size in pixels")
    return apply("ESC [ 8;<rows>;<cols> t", "Terminal grid size")
  }
  const oscQ =
    queryCommands.find((q) => /^\x1b\](\d+)(?:;|\x07|\x1b\\)/.test(q)) ??
    sentCommands.find((s) => /^\x1b\](\d+)(?:;|\x07|\x1b\\)/.test(s))
  if (oscQ) {
    const m = /^\x1b\](\d+)(?:;|\x07|\x1b\\)/.exec(oscQ)
    const code = m?.[1]
    if (code === "776" || featureId === "extensions.osc776-cell-size") {
      return apply("ESC ]776;<w>;<h> BEL", "Cell width and height")
    }
    if (code && /^(?:4|5|10|11|12|13|14|15|16|17|18|19|21)$/.test(code)) {
      return apply(`ESC ]${code};rgb:… BEL`, "Current RGB color")
    }
    if (code === "22") return apply("ESC ]22;<shape> BEL", "Current pointer shape")
    if (code === "52") return apply("ESC ]52;c;<data> BEL", "Clipboard text returned")
    if (code === "99") return apply("ESC ]99;… BEL", "Notification capabilities")
    if (code === "1337") return apply("ESC ]1337;… BEL", "iTerm2 reply value")
    if (code) return apply(`ESC ]${code};… BEL`, `OSC ${code} reply`)
  }
  return apply("ESC …", "Matching reply sequence")
}

function expectedNonReplyWords(opts: {
  featureId: string
  featureName: string
  assertionType?: string
  subjectKind?: string
  isScreen: boolean
  isAppLog: boolean
  expectedSentence?: string
  sentCommands: readonly string[]
}): string {
  const { featureId, featureName, assertionType, subjectKind, isScreen, isAppLog, expectedSentence, sentCommands } =
    opts
  if (isAppLog) {
    const osc = oscCodeForFeature(featureId, sentCommands)
    return osc ? `Handle OSC ${osc} without an error` : "Handle command without an unhandled error"
  }
  if (assertionType === "process_environment") return "TERM_FEATURES environment variable set"
  if (assertionType === "clipboard" || featureId.includes("osc52")) return "Test text placed on the clipboard"
  if (assertionType === "notification" || featureId.includes("notif"))
    return "Desktop notification delivered with test text"
  if (subjectKind === "lib") {
    if (featureId.startsWith("sgr.")) {
      const sgr = sgrExpectedStyleName(featureId, sentCommands)
      return `Parser cell has ${sgr.label}`
    }
    const clean = sanitizeCardText(expectedSentence)
    return clean && clean.length <= 95 ? clean : `Parser records ${featureName}`
  }
  if (featureId === "extensions.osc7-cwd") return "Working folder updated to test path"
  if (featureId === "device.xtwinops-22" || featureId === "device.xtwinops-23")
    return "Saved window title pushed and restored"
  if (featureId.includes("title") || featureId.includes("icon")) return "Window title updated to test text"
  if (isScreen) {
    if (featureId === "sgr.overline") return "Line drawn above the text"
    if (featureId === "sgr.bold") return "Text drawn bold"
    if (featureId === "sgr.faint") return "Text drawn dimmer"
    if (featureId === "sgr.italic") return "Text drawn italic"
    if (featureId === "sgr.strikethrough") return "Line drawn through the text"
    if (featureId === "sgr.inverse") return "Foreground and background swapped"
    if (featureId === "sgr.hidden") return "Text hidden on screen"
    if (featureId.startsWith("sgr.underline")) return "Styled underline drawn under text"
    if (featureId.startsWith("sgr.fg.") || featureId.startsWith("sgr.bg.")) return "Requested color drawn on screen"
    if (
      featureId === "extensions.iterm2-images" ||
      featureId === "extensions.kitty-graphics" ||
      featureId === "extensions.sixel"
    ) {
      return "Test image drawn inside the cell"
    }
    const clean = sanitizeCardText(expectedSentence)
    return clean && clean.length <= 110 ? clean : `Screen shows ${featureName}`
  }
  const clean = sanitizeCardText(expectedSentence)
  return clean && clean.length <= 110 ? clean : `Terminal applies ${featureName}`
}

function buildStyle5Verdict(opts: {
  status: "supported" | "unsupported"
  featureId: string
  shortSubjectName?: string
  subjectKind?: string
  assertionType?: string
  sawDecrqm: boolean
  saveRestore: boolean
  isScreen: boolean
  isAppLog: boolean
  hasEndMarkerProof: boolean
  hadNullQuery: boolean
  replyCount: number
  sentCommands: readonly string[]
}): CardVerdict {
  const {
    status,
    featureId,
    shortSubjectName,
    subjectKind,
    assertionType,
    sawDecrqm,
    saveRestore,
    isScreen,
    isAppLog,
    hasEndMarkerProof,
    hadNullQuery,
    replyCount,
    sentCommands,
  } = opts
  const ok = status === "supported"
  const tone: "ok" | "no" = ok ? "ok" : "no"
  const who = shortWhoForVerdict(shortSubjectName)

  const make = (text: string): CardVerdict => {
    const wc = countVerdictWords(text)
    if (wc >= 3 && wc <= 6) return { tone, text }
    return { tone, text: ok ? "Feature worked as expected" : "Feature did not work" }
  }

  if (isAppLog) {
    const osc = oscCodeForFeature(featureId, sentCommands)
    if (osc) return make(ok ? `${who} handled OSC ${osc}` : `${who} ignored OSC ${osc}`)
    return make(ok ? `${who} handled this command` : `${who} ignored this command`)
  }
  if (subjectKind === "lib") {
    return make(ok ? "Parser stored expected state" : "Parser missed expected state")
  }
  if (assertionType === "process_environment") {
    return make(ok ? "TERM_FEATURES was set" : "TERM_FEATURES was not set")
  }
  if (assertionType === "clipboard") {
    return make(ok ? "Clipboard received the text" : "Clipboard did not change")
  }
  if (assertionType === "notification") {
    return make(ok ? "Desktop notification was delivered" : "No notification was delivered")
  }
  if (assertionType === "input_bytes") {
    return make(ok ? "Terminal sent expected input" : "Expected input not sent")
  }
  if (sawDecrqm && !isScreen) {
    return make(ok ? `${who} knows this mode` : `${who} does not support mode`)
  }
  if (saveRestore) {
    return make(ok ? "Cursor returned to spot" : "Cursor did not return")
  }
  if (isScreen) {
    if (featureId === "sgr.overline") return make(ok ? "Overline drawn as expected" : "Overline didn’t stick")
    if (featureId === "sgr.bold") return make(ok ? "Bold drawn as expected" : "Text stayed plain weight")
    if (featureId === "sgr.faint") return make(ok ? "Faint text drawn dimmer" : "Text did not dim")
    if (featureId === "sgr.italic") return make(ok ? "Italic drawn as expected" : "Text stayed upright plain")
    if (featureId === "sgr.strikethrough") return make(ok ? "Strikethrough drawn as expected" : "No line through text")
    if (featureId === "sgr.inverse") return make(ok ? "Colors swapped as expected" : "Colors did not swap")
    if (featureId === "sgr.hidden") return make(ok ? "Text hidden on screen" : "Text remained visible onscreen")
    if (featureId.startsWith("sgr.underline")) {
      return make(ok ? "Underline drawn as expected" : "Underline did not match")
    }
    if (featureId.startsWith("sgr.fg.") || featureId.startsWith("sgr.bg.")) {
      return make(ok ? "Color drawn as expected" : "Color did not change")
    }
    if (
      featureId === "extensions.iterm2-images" ||
      featureId === "extensions.kitty-graphics" ||
      featureId === "extensions.sixel"
    ) {
      return make(ok ? "Image appeared on screen" : "No image was drawn")
    }
    return make(ok ? "Screen matched expected output" : "Screen did not match")
  }
  if (!ok && (hasEndMarkerProof || (hadNullQuery && replyCount === 0))) {
    return make(hasEndMarkerProof ? "Terminal ignored this query" : "No reply came back")
  }
  if (featureId === "extensions.osc7-cwd") {
    return make(ok ? "Working folder was updated" : "Working folder stayed unchanged")
  }
  if (featureId.includes("title") || featureId === "device.xtwinops-22" || featureId === "device.xtwinops-23") {
    return make(ok ? "Window title was updated" : "Window title stayed unchanged")
  }
  if (replyCount > 0) {
    return make(ok ? "Terminal sent expected reply" : "Reply did not match")
  }
  return make(ok ? "Feature worked as expected" : "Feature did not work")
}

/**
 * Build the complete Style 5 card model for any decided or undecided cell (#38269, card-style5-rule-0010.md).
 */
export function buildCardModel(input: {
  readonly status: AppCellStatus | undefined
  readonly featureId: string
  readonly featureName: string
  readonly shortSubjectName?: string
  readonly subjectKind?: string
  readonly assertionType?: string
  readonly declaredSequence?: string
  readonly expectedSentence?: string
  readonly derived?: boolean
  readonly reason?: string
  readonly traceEvidence?: readonly string[]
  readonly logLine?: string
  readonly exchange?: ExchangeInput
  readonly parserState?: unknown
  readonly captures?: TraceCaptures
  readonly hasExpectedPicture?: boolean
  /** Per-context statuses when `status === "differs-by-context"`. */
  readonly joinedFrom?: ReadonlyArray<{ readonly context: string; readonly status: string }>
}): CardModel {
  const {
    status,
    featureId,
    featureName,
    shortSubjectName,
    subjectKind,
    assertionType,
    declaredSequence,
    expectedSentence,
    derived,
    reason,
    traceEvidence,
    logLine,
    exchange,
    parserState,
    captures,
    hasExpectedPicture,
    joinedFrom,
  } = input

  // Non-measured: No result yet
  if (status === undefined || status === "probe-todo" || status === "probe-invalid" || status === "probe-conflict") {
    return {
      measured: false,
      steps: [],
      readouts: [],
      closing: "Our test could not read a result here yet.",
      truncated: false,
    }
  }

  // Non-measured: Untestable
  if (status === "untestable") {
    const clean = reason?.replace(/^Untestable(?:\s*\([^)]+\))?:\s*/i, "").trim()
    const ended = clean ? (/[.!?]$/.test(clean) ? clean : `${clean}.`) : "Could not be tested automatically here."
    return { measured: false, steps: [], readouts: [], closing: `${ended} Not a no.`, truncated: false }
  }

  // Non-measured: Derived unsupported (no panel; component renders parent link sentence)
  if (status === "unsupported" && derived) {
    return {
      measured: false,
      steps: [],
      readouts: [],
      closing: "Unsupported because its required parent feature is unsupported here.",
      truncated: false,
    }
  }

  // Non-measured: Differs by context (no panel; keep one-line explanation)
  if (status === "differs-by-context") {
    const summary =
      joinedFrom && joinedFrom.length > 1
        ? joinedFrom
            .map(
              (e) =>
                `${e.context}: ${e.status === "supported" ? "supported" : e.status === "unsupported" ? "unsupported" : e.status}`,
            )
            .join("; ") + "."
        : "Results differed across measured settings or setups."
    return {
      measured: false,
      steps: [],
      readouts: [],
      closing: summary,
      truncated: false,
    }
  }

  const singleMark: "ok" | "no" = status === "supported" ? "ok" : "no"

  let codeTruncated = false
  let stepsOmitted = false
  const trimCode = (code: string): { code: string; fullCode?: string } => {
    const t = truncateCode(code)
    if (t.truncated) {
      codeTruncated = true
      return { code: t.text, fullCode: code }
    }
    return { code: t.text }
  }

  // Measured: Headless library result (no fake bytes; words only in Expected/Received)
  if (subjectKind === "lib") {
    const seqTrim = declaredSequence ? trimCode(formatControlBytes(declaredSequence)) : undefined
    const libSteps: CardStepRow[] = seqTrim
      ? [
          {
            num: 1,
            code: seqTrim.code,
            ...(seqTrim.fullCode ? { fullCode: seqTrim.fullCode } : {}),
            words: "Feed sequence to library parser",
          },
        ]
      : [{ num: 1, code: "", codeMuted: "no bytes", words: "Feed test input to library parser" }]
    const libSummary =
      sanitizeCardText(summarizeLibraryState(parserState, traceEvidence)) ?? "State recorded in parser buffer"
    const expected: CardExpectedRow = {
      words: expectedNonReplyWords({
        featureId,
        featureName,
        assertionType,
        subjectKind,
        isScreen: false,
        isAppLog: false,
        expectedSentence,
        sentCommands: declaredSequence ? [declaredSequence] : [],
      }),
    }
    const received: CardReceivedRow = { words: capitalizeFirst(libSummary) }
    const verdict = buildStyle5Verdict({
      status,
      featureId,
      shortSubjectName,
      subjectKind,
      assertionType,
      sawDecrqm: false,
      saveRestore: false,
      isScreen: false,
      isAppLog: false,
      hasEndMarkerProof: false,
      hadNullQuery: false,
      replyCount: 0,
      sentCommands: declaredSequence ? [declaredSequence] : [],
    })
    const readout: CardReadoutRow = {
      label: "Library says",
      text: libSummary,
      code: "",
      codeMuted: "read directly",
      mark: singleMark,
    }
    return {
      measured: true,
      steps: libSteps,
      expected,
      received,
      verdict,
      readouts: [readout],
      readout,
      closing: verdict.text,
      truncated: codeTruncated,
    }
  }

  // Measured: Process environment check (zero bytes sent; words only in Expected/Received)
  if (assertionType === "process_environment") {
    const ev = sanitizeCardText(traceEvidence?.[0]) ?? (status === "supported" ? "value set" : "not set")
    const valMatch = status === "supported" ? /TERM_FEATURES(?:=|\s+was\s+(?:set\s+to\s+)?)([^\s.,]+)/i.exec(ev) : null
    const val = valMatch?.[1] && !/^(?:not|unset|absent)$/i.test(valMatch[1]) ? valMatch[1] : undefined
    const receivedWords = val
      ? `TERM_FEATURES=${val}`
      : status === "supported"
        ? "TERM_FEATURES was set"
        : "TERM_FEATURES was not set"
    const expected: CardExpectedRow = { words: "TERM_FEATURES environment variable set" }
    const received: CardReceivedRow = { words: receivedWords }
    const verdict = buildStyle5Verdict({
      status,
      featureId,
      shortSubjectName,
      subjectKind,
      assertionType,
      sawDecrqm: false,
      saveRestore: false,
      isScreen: false,
      isAppLog: false,
      hasEndMarkerProof: false,
      hadNullQuery: false,
      replyCount: 0,
      sentCommands: [],
    })
    const readout: CardReadoutRow = {
      label: "TERM_FEATURES",
      text: val ? `“${val}”` : status === "supported" ? "set" : "not set",
      code: "",
      codeMuted: "read directly",
      mark: singleMark,
    }
    return {
      measured: true,
      steps: [{ num: 1, code: "", codeMuted: "no bytes", words: "Read TERM_FEATURES at launch" }],
      expected,
      received,
      verdict,
      readouts: [readout],
      readout,
      closing: verdict.text,
      truncated: false,
    }
  }

  // Flatten ordered writes & queries from trace exchange
  const rawSteps: Array<{ kind: "write" | "query"; sequence: string; match?: string[] | null }> = []
  if (exchange?.events && exchange.events.length > 0) {
    for (const ev of exchange.events) {
      if ((ev.kind === "write" || ev.kind === "query") && typeof ev.sequence === "string" && ev.sequence.length > 0) {
        rawSteps.push({ kind: ev.kind, sequence: ev.sequence, match: ev.match })
      }
    }
  } else if (exchange) {
    for (const w of exchange.writes ?? []) if (w.length > 0) rawSteps.push({ kind: "write", sequence: w })
    for (const q of exchange.queries ?? []) {
      if (q.sequence.length > 0) rawSteps.push({ kind: "query", sequence: q.sequence, match: q.match })
    }
  }

  const hasCaptures = Boolean(captures?.observed || captures?.textCells)
  const isScreen = hasCaptures || assertionType === "screenshot" || assertionType === "visual"
  const isAppLog = Boolean(logLine)
  const hasAppLogPlumbing = isAppLog || rawSteps.some((s) => /\x1b\](?:7654|7655);/.test(s.sequence))
  const isNonReplyStateProbe =
    assertionType === "clipboard" || assertionType === "notification" || assertionType === "buffer_state"
  const da1Feature = isDa1Feature(featureId)
  const keepResets = featureTestsReset(featureId)
  const keepCursorMoves = featureTestsCursorPosition(featureId)
  const saveRestore = isSaveRestoreFeature(featureId)

  const hasScaffolding = rawSteps.some((s) => isCollectorScaffoldingWrite(s.sequence))
  // Risk #1 invariant: never filter out any query step when trimming capture scaffolding (except CPR sync barriers on app-log/clipboard/state probes).
  let activeSteps = rawSteps.filter((s) => {
    if (
      (hasAppLogPlumbing || isNonReplyStateProbe) &&
      s.kind === "query" &&
      s.sequence === "\x1b[6n" &&
      !keepCursorMoves
    ) {
      return false
    }
    return s.kind === "query" || !isCollectorScaffoldingWrite(s.sequence)
  })

  // Multi-frame 0/1/2 visual probes
  const w0Idx = activeSteps.findIndex((s) => s.kind === "write" && /^\x1b\[\d+;1H0$/u.test(s.sequence))
  const w1Idx =
    w0Idx >= 0
      ? activeSteps.findIndex((s, i) => i > w0Idx && s.kind === "write" && /^\x1b\[\d+;1H1$/u.test(s.sequence))
      : -1
  if (w0Idx >= 0 && w1Idx > w0Idx) {
    const targetWindow = activeSteps.slice(w0Idx + 1, w1Idx).filter((s) => !/^\x1b\[\d+;1H$/u.test(s.sequence))
    if (targetWindow.length > 0) {
      const queriesOnly = activeSteps.filter((s) => s.kind === "query")
      activeSteps = [...targetWindow, ...queriesOnly.filter((q) => !targetWindow.includes(q))]
    }
  } else if (hasScaffolding && activeSteps.length > 2) {
    const isSgrControlWrite = (seq: string): boolean =>
      /AaBb 0123456789/u.test(seq) &&
      (/\x1b\[99m/.test(seq) ||
        (!featureId.includes("inverse") && /\x1b\[7m/.test(seq)) ||
        (!featureId.includes("underline") && /\x1b\[4m/.test(seq)))
    const filtered = activeSteps.filter((s) => s.kind === "query" || !isSgrControlWrite(s.sequence))
    activeSteps = filtered.map((s) =>
      s.kind === "write" && /AaBb 0123456789/u.test(s.sequence)
        ? { ...s, sequence: s.sequence.replace(/\x1b\[0m\x1b\[2;1H\x1b\[1;1H\s*$/u, "\x1b[0m") }
        : s,
    )
  }

  // Detect no-reply-with-DA1-end-marker pattern
  const hadNullQuery = activeSteps.some((s) => s.kind === "query" && s.match === null)
  const da1FenceReply = activeSteps
    .filter((s) => s.kind === "query" && typeof s.match?.[0] === "string" && isDa1Reply(s.match[0]))
    .map((s) => s.match![0]!)[0]
  const hasEndMarkerProof =
    !da1Feature && hadNullQuery && (Boolean(da1FenceReply) || /device check/i.test(traceEvidence?.join(" ") ?? ""))

  const writeSteps: CardStepRow[] = []
  const querySteps: CardStepRow[] = []
  const orderedSteps: Array<CardStepRow & { isQuery: boolean; isSeed: boolean }> = []
  const sentCommands: string[] = []
  const queryCommands: string[] = []
  let pendingSaveCup: string | undefined
  let savedCupPos: string | undefined
  const replyParts: Array<{ raw: string; code: string; words: string }> = []
  let queryReplyCount = 0
  let sawDecrqm = false
  let decrqmMode: string | undefined

  for (const step of activeSteps) {
    const cmds = splitRawCommands(step.sequence)
    const isQuery = step.kind === "query"
    for (let cmdIdx = 0; cmdIdx < cmds.length; cmdIdx++) {
      const cmd = cmds[cmdIdx]
      if (!cmd) continue
      if (!da1Feature && isDa1Fence(cmd.raw)) continue
      if (hasAppLogPlumbing && isAppLogCalibrationCmd(cmd.raw, featureId)) continue
      if (!isQuery) {
        if (!keepResets && isResetOrClearCommand(cmd.raw)) continue
        if (orderedSteps.length === 0 && (cmd.raw === "\x0f" || cmd.raw === "\x1b(B" || cmd.raw === "\x1b)B")) continue
        if (!keepResets && cmd.raw === "\x1b[2K") continue
        const cupMatch = /^\x1b\[(\d+);(\d+)H$/.exec(cmd.raw)
        if (cupMatch) {
          if (!keepCursorMoves) continue
          if (saveRestore && orderedSteps.length === 0 && !pendingSaveCup) {
            pendingSaveCup = `${cupMatch[1]};${cupMatch[2]}`
            savedCupPos = pendingSaveCup
            continue
          }
          const nextCmd = cmds[cmdIdx + 1]
          if (nextCmd?.isText && featureId.startsWith("editing.")) {
            const textStr = nextCmd.raw.trim()
            if (textStr) {
              const combinedRaw = `${formatControlBytes(cmd.raw)} ${textStr}`
              const trimmedPair = trimCode(combinedRaw)
              const pairRow = {
                num: orderedSteps.length + 1,
                code: trimmedPair.code,
                ...(trimmedPair.fullCode ? { fullCode: trimmedPair.fullCode } : {}),
                setup: true,
                words: `Draw “${textStr}” at ${cupMatch[1]};${cupMatch[2]}`,
                isQuery: false,
                isSeed: true,
              }
              orderedSteps.push(pairRow)
              writeSteps.push(pairRow)
              cmdIdx++
              continue
            }
          }
          if (featureId.startsWith("editing.") && (!nextCmd || !nextCmd.isText)) {
            continue
          }
        }
        if (cmd.isText && hasCaptures && featureId.startsWith("sgr.")) continue
      }
      sentCommands.push(cmd.raw)
      if (isQuery) queryCommands.push(cmd.raw)
      const decrqmMatch = /^\x1b\[\??(\d+)\$p$/.exec(cmd.raw)
      if (decrqmMatch) {
        sawDecrqm = true
        decrqmMode = decrqmMatch[1]
      }

      const rawCode = cmd.isText ? cmd.raw.trim() : formatControlBytes(cmd.raw)
      if (!rawCode) continue
      let words = explainSentCommand(cmd.raw, cmd.isText, hasCaptures).words
      if (pendingSaveCup && (cmd.raw === "\x1b7" || cmd.raw === "\x1b[s")) {
        words = `Save the cursor at ${pendingSaveCup}`
        pendingSaveCup = undefined
      }
      const trimmed = trimCode(rawCode)
      // Deduplicate identical consecutive or app-log/SGR duplicate non-query write steps.
      const prev = orderedSteps[orderedSteps.length - 1]
      if (!isQuery && prev && !prev.isQuery && prev.code === trimmed.code && prev.words === words) continue
      if (
        !isQuery &&
        (featureId.startsWith("sgr.") || isAppLog) &&
        orderedSteps.some((r) => !r.isQuery && r.code === trimmed.code && r.words === words)
      ) {
        continue
      }
      const isSeed = !isQuery && (cmd.isText || /^\x1b\[\d+;\d+H$/.test(cmd.raw))
      const row: CardStepRow & { isQuery: boolean; isSeed: boolean } = {
        num: orderedSteps.length + 1,
        code: trimmed.code,
        ...(trimmed.fullCode ? { fullCode: trimmed.fullCode } : {}),
        ...(isSeed ? { setup: true } : {}),
        words,
        isQuery,
        isSeed,
      }
      orderedSteps.push(row)
      if (isQuery) querySteps.push(row)
      else writeSteps.push(row)
    }

    if (isQuery && typeof step.match?.[0] === "string" && step.match[0].length > 0) {
      let stepAddedReply = false
      for (const part of splitRawCommands(step.match[0])) {
        if (!da1Feature && isDa1Reply(part.raw)) continue
        const decrpmMatch = /^\x1b\[\??(\d+);(\d+)\$y$/.exec(part.raw)
        if (decrpmMatch) {
          decrqmMode ??= decrpmMatch[1]
        }
        const rawCode = part.isText ? part.raw : formatControlBytes(part.raw)
        if (!rawCode) continue
        replyParts.push({
          raw: part.raw,
          code: rawCode,
          words: part.isText ? `“${part.raw}”` : explainReplyCommand(part.raw).words,
        })
        stepAddedReply = true
      }
      if (stepAddedReply) queryReplyCount += 1
    }
  }

  let keptOrdered = orderedSteps
  if (orderedSteps.length > 6) {
    const mustKeep = new Set<number>()
    orderedSteps.forEach((row, idx) => {
      if (row.isQuery) mustKeep.add(idx)
    })
    orderedSteps.forEach((row, idx) => {
      if (!row.isQuery && !row.isSeed && mustKeep.size < 6) mustKeep.add(idx)
    })
    orderedSteps.forEach((row, idx) => {
      if (mustKeep.size < 6 && !mustKeep.has(idx)) mustKeep.add(idx)
    })
    keptOrdered = orderedSteps.filter((_, idx) => mustKeep.has(idx))
    stepsOmitted = true
  }
  const hasNonSeedStep = keptOrdered.some((r) => !r.isSeed)
  const shownSteps: CardStepRow[] = keptOrdered.map((r, i) => ({
    num: i + 1,
    code: r.code,
    ...(r.fullCode ? { fullCode: r.fullCode } : {}),
    ...(r.isSeed && hasNonSeedStep ? { setup: true } : {}),
    words: r.words,
  }))

  // Add non-byte action step with explicit muted "no bytes"
  if (assertionType === "input_bytes") {
    shownSteps.push({
      num: shownSteps.length + 1,
      code: "",
      codeMuted: "no bytes",
      words: inputProbeActionWords(featureId),
    })
  } else if (assertionType === "clipboard" && shownSteps.length > 0) {
    shownSteps.push({
      num: shownSteps.length + 1,
      code: "",
      codeMuted: "no bytes",
      setup: true,
      words: "Read the clipboard",
    })
  } else if (featureId === "extensions.osc7-cwd" && shownSteps.length === 0) {
    shownSteps.push({
      num: 1,
      code: "",
      codeMuted: "no bytes",
      words: "Send working folder (OSC 7) and read app state",
    })
  } else if (shownSteps.length === 0 && declaredSequence) {
    const seqTrim = trimCode(formatControlBytes(declaredSequence))
    shownSteps.push({
      num: 1,
      code: seqTrim.code,
      ...(seqTrim.fullCode ? { fullCode: seqTrim.fullCode } : {}),
      words: `Send ${featureName} sequence`,
    })
  }

  if (hasEndMarkerProof && replyParts.length === 0) {
    shownSteps.push({
      num: shownSteps.length + 1,
      code: "ESC [ c",
      setup: true,
      words: "End marker (always answered)",
    })
  }

  // Reply-family detection: bytes appear ONLY for reply families (never fake bytes for screen/log/clipboard/notification/env/lib/state).
  const isReplyFamily =
    !isAppLog &&
    !isNonReplyStateProbe &&
    assertionType !== "input_bytes" &&
    (querySteps.length > 0 ||
      replyParts.length > 0 ||
      hadNullQuery ||
      hasEndMarkerProof ||
      assertionType === "query_reply")

  // Build Style 5 EXPECTED row
  const expected: CardExpectedRow =
    isReplyFamily || assertionType === "input_bytes"
      ? expectedReplyForProbe({
          featureId,
          featureName,
          sawDecrqm,
          decrqmMode,
          saveRestore,
          savedCupPos,
          sentCommands,
          queryCommands,
          assertionType,
          trimCode,
        })
      : {
          words: expectedNonReplyWords({
            featureId,
            featureName,
            assertionType,
            subjectKind,
            isScreen,
            isAppLog,
            expectedSentence,
            sentCommands,
          }),
        }

  // Build Style 5 RECEIVED row (and legacy readouts array for any helper callers)
  const cleanEv = sanitizeCardText(traceEvidence?.[0])
  const readouts: CardReadoutRow[] = []
  let received: CardReceivedRow

  if (isAppLog && logLine) {
    received = { words: logLine, isLog: true }
  } else if (isReplyFamily) {
    if (replyParts.length > 0) {
      const combined = trimCode(replyParts.map((r) => r.code).join("  "))
      const combinedWords = replyParts.map((r) => r.words).join(", ")
      received = {
        code: combined.code,
        ...(combined.fullCode ? { fullCode: combined.fullCode } : {}),
        words: combinedWords,
      }
      const markAllowed = !hasCaptures && (queryReplyCount <= 1 || status === "supported")
      readouts.push({
        label: readbackSourceLabel(featureId, assertionType),
        text: combinedWords,
        code: combined.code,
        ...(combined.fullCode ? { fullCode: combined.fullCode } : {}),
        ...(markAllowed ? { mark: singleMark } : {}),
      })
    } else if (hasEndMarkerProof) {
      const fenceTrim = da1FenceReply ? trimCode(formatControlBytes(da1FenceReply)) : { code: "ESC [ ? … c" }
      received = {
        code: fenceTrim.code,
        ...(fenceTrim.fullCode ? { fullCode: fenceTrim.fullCode } : {}),
        words: "Answered only the end marker",
      }
      readouts.push({
        label: "Reply",
        text: "answered only the end marker",
        code: fenceTrim.code,
        ...(fenceTrim.fullCode ? { fullCode: fenceTrim.fullCode } : {}),
        ...(!hasCaptures ? { mark: singleMark } : {}),
      })
    } else if (hadNullQuery) {
      received = { codeMuted: "nothing", words: "No reply" }
      readouts.push({
        label: "Reply",
        text: "no reply",
        code: "",
        codeMuted: "nothing",
        ...(!hasCaptures ? { mark: singleMark } : {}),
      })
    } else {
      received = {
        ...(status === "unsupported" ? { codeMuted: "nothing" as const } : {}),
        words: cleanEv
          ? capitalizeFirst(cleanEv)
          : status === "supported"
            ? "Matched expected reply"
            : "No matching reply",
      }
    }
  } else if (isScreen) {
    let words: string
    if (cleanEv && !/shown below/i.test(cleanEv)) {
      words = capitalizeFirst(cleanEv)
    } else if (
      status === "unsupported" &&
      (featureId === "extensions.iterm2-images" ||
        featureId === "extensions.kitty-graphics" ||
        featureId === "extensions.sixel")
    ) {
      words = "Test cell stayed blank and unchanged"
    } else if (featureId === "sgr.overline") {
      words = status === "supported" ? "Line drawn above the text" : "Plain text with no line above"
    } else {
      words = status === "supported" ? "Screen matched expected output" : "Screen did not match expected output"
    }
    received = { words }
  } else if (assertionType === "clipboard") {
    const clipEv = cleanEv && !/sent back ESC \[ \d+;\d+ R/i.test(cleanEv) ? cleanEv : undefined
    received = {
      words: clipEv
        ? capitalizeFirst(clipEv)
        : status === "supported"
          ? "Test text read back from clipboard"
          : "Clipboard did not change",
    }
  } else if (assertionType === "notification") {
    received = {
      words: cleanEv
        ? capitalizeFirst(cleanEv)
        : status === "supported"
          ? "Notification arrived at desktop service"
          : "No notification arrived",
    }
  } else if (assertionType === "input_bytes") {
    received = {
      words: cleanEv
        ? capitalizeFirst(cleanEv)
        : status === "supported"
          ? "Expected escape sequence received"
          : "No matching escape sequence sent",
    }
  } else {
    received = {
      words: cleanEv
        ? capitalizeFirst(cleanEv)
        : status === "supported"
          ? "Matched expected terminal state"
          : "Terminal did not apply the change",
    }
  }

  const verdict = buildStyle5Verdict({
    status,
    featureId,
    shortSubjectName,
    subjectKind,
    assertionType,
    sawDecrqm,
    saveRestore,
    isScreen,
    isAppLog,
    hasEndMarkerProof,
    hadNullQuery,
    replyCount: replyParts.length,
    sentCommands,
  })

  const readout = readouts[0]
  const contextNote = codeTruncated
    ? "Long data is shortened with …; Details shows all of it."
    : stepsOmitted
      ? "Extra setup steps are omitted; Details shows all of them."
      : undefined
  return {
    measured: true,
    steps: shownSteps,
    expected,
    received,
    verdict,
    readouts,
    ...(readout ? { readout } : {}),
    closing: verdict.text,
    ...(contextNote ? { contextNote } : {}),
    truncated: codeTruncated,
  }
}

/**
 * Item 5: visual CSS specimen for the "Expected" panel next to a screen-captured crop
 * for the 23 SGR/color features (Cut (a): non-SGR features show the single screen crop + closing sentence).
 */
export function expectedVisualSpecimen(featureId: string): ExpectedVisual | undefined {
  const sample = "AaBb 0123456789 - terminal text"
  switch (featureId) {
    case "sgr.overline":
      return {
        text: sample,
        style: { textDecoration: "overline", textDecorationColor: "#f59e0b", textDecorationThickness: "2px" },
      }
    case "sgr.bold":
      return { text: sample, style: { fontWeight: "700", color: "#ffffff" } }
    case "sgr.faint":
      return { text: sample, style: { opacity: "0.48" } }
    case "sgr.italic":
      return { text: sample, style: { fontStyle: "italic" } }
    case "sgr.strikethrough":
      return {
        text: sample,
        style: { textDecoration: "line-through", textDecorationThickness: "1.5px" },
      }
    case "sgr.inverse":
      return {
        text: sample,
        style: { background: "#f3f4f6", color: "#0b0c0f", padding: "1px 4px", borderRadius: "2px" },
      }
    case "sgr.hidden":
      return { text: sample, style: { color: "transparent" }, caption: "Blank cells (hidden)" }
    case "sgr.underline.single":
      return { text: sample, style: { textDecoration: "underline", textDecorationThickness: "1.5px" } }
    case "sgr.underline.double":
      return { text: sample, style: { textDecoration: "underline double", textDecorationThickness: "1.5px" } }
    case "sgr.underline.curly":
      return { text: sample, style: { textDecoration: "underline wavy", textDecorationColor: "#38bdf8" } }
    case "sgr.underline.dotted":
      return { text: sample, style: { textDecoration: "underline dotted", textDecorationThickness: "2px" } }
    case "sgr.underline.dashed":
      return { text: sample, style: { textDecoration: "underline dashed", textDecorationThickness: "2px" } }
    case "sgr.underline.color":
    case "sgr.underline-color-rgb":
    case "sgr.underline-color-indexed":
      return {
        text: sample,
        style: { textDecoration: "underline", textDecorationColor: "#ff0080", textDecorationThickness: "2px" },
      }
    case "sgr.fg.truecolor":
    case "sgr.fg.256":
    case "sgr.fg.standard":
    case "sgr.fg.bright":
      return { text: sample, style: { color: "#f97316" } }
    case "sgr.bg.truecolor":
    case "sgr.bg.256":
    case "sgr.bg.standard":
    case "sgr.bg.bright":
      return {
        text: sample,
        style: { background: "#2563eb", color: "#ffffff", padding: "1px 4px", borderRadius: "2px" },
      }
    default:
      return undefined
  }
}
