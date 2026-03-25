export interface ProbeResult {
  pass: boolean
  note?: string
  response?: string
}

/** Context for headless backends (synchronous cell-state access) */
export interface TermlessContext {
  feed(text: string): void
  feedCapture(text: string): string
  getCell(
    row: number,
    col: number,
  ): {
    char: string
    bold: boolean
    dim: boolean
    italic: boolean
    underline: any
    underlineColor?: { r: number; g: number; b: number } | null
    strikethrough: boolean
    inverse: boolean
    hidden: boolean
    blink: boolean
    overline?: boolean
    fg: { r: number; g: number; b: number } | null
    bg: { r: number; g: number; b: number } | null
    wide: boolean
  }
  getCursor(): { x: number; y: number; visible: boolean | null; style: string | null }
  getMode(mode: string): boolean
  getText(): string
  getScrollback(): { viewportOffset: number; totalLines: number; screenLines: number }
  getTitle(): string
  reset(): void
  capabilities: {
    truecolor: boolean
    kittyKeyboard: boolean
    kittyGraphics: boolean
    sixel: boolean
    osc8Hyperlinks: boolean
    semanticPrompts: boolean
    reflow: boolean
    unicode: string
    extensions: Set<string>
  }
}

/** Context for real terminal probing (async TTY I/O) */
export interface TermContext {
  write(text: string): void
  queryCursorPosition(): Promise<{ row: number; col: number } | null>
  measureRenderedWidth(text: string): Promise<number | null>
  query(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<string[] | null>
  queryWithSentinel(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<string[] | null>
  queryMode(modeNum: number): Promise<"set" | "reset" | "unknown" | null>
  cols: number
}

export interface ProbeDefinition {
  id: string
  termless: ((ctx: TermlessContext) => ProbeResult) | null
  term: ((ctx: TermContext) => Promise<ProbeResult>) | null
}
