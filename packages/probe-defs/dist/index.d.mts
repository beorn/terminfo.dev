//#region src/types.d.ts
interface ProbeResult {
  pass: boolean;
  note?: string;
  response?: string;
}
/** Context for headless backends (synchronous cell-state access) */
interface TermlessContext {
  feed(text: string): void;
  feedCapture(text: string): string;
  getCell(row: number, col: number): {
    char: string;
    bold: boolean;
    dim: boolean;
    italic: boolean;
    underline: any;
    underlineColor?: {
      r: number;
      g: number;
      b: number;
    } | null;
    strikethrough: boolean;
    inverse: boolean;
    hidden: boolean;
    blink: boolean;
    overline?: boolean;
    fg: {
      r: number;
      g: number;
      b: number;
    } | null;
    bg: {
      r: number;
      g: number;
      b: number;
    } | null;
    wide: boolean;
  };
  getCursor(): {
    x: number;
    y: number;
    visible: boolean | null;
    style: string | null;
  };
  getMode(mode: string): boolean;
  getText(): string;
  getScrollback(): {
    viewportOffset: number;
    totalLines: number;
    screenLines: number;
  };
  getTitle(): string;
  reset(): void;
  capabilities: {
    truecolor: boolean;
    kittyKeyboard: boolean;
    kittyGraphics: boolean;
    sixel: boolean;
    osc8Hyperlinks: boolean;
    semanticPrompts: boolean;
    reflow: boolean;
    unicode: string;
    extensions: Set<string>;
  };
}
/** Context for real terminal probing (async TTY I/O) */
interface TermContext {
  write(text: string): void;
  queryCursorPosition(): Promise<{
    row: number;
    col: number;
  } | null>;
  measureRenderedWidth(text: string): Promise<number | null>;
  query(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<string[] | null>;
  queryWithSentinel(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<string[] | null>;
  queryMode(modeNum: number): Promise<"set" | "reset" | "unknown" | null>;
  cols: number;
}
interface ProbeDefinition {
  id: string;
  termless: ((ctx: TermlessContext) => ProbeResult) | null;
  term: ((ctx: TermContext) => Promise<ProbeResult>) | null;
}
//#endregion
//#region src/helpers.d.ts
/**
 * SGR probe — feed SGR sequence + "X", verify cell attribute (termless) or cursor position (term).
 *
 * Termless: check that the SGR sequence is parsed and applied to the cell.
 * Term: check that the SGR sequence is consumed (cursor advances by 1 char, not printed literally).
 */
declare function sgrProbe(id: string, sequence: string, check: (cell: ReturnType<TermlessContext["getCell"]>) => boolean): ProbeDefinition;
/**
 * Cursor probe — move cursor, verify position.
 * Termless uses 0-based coordinates, term DSR uses 1-based.
 */
declare function cursorProbe(id: string, setup: string, move: string, expected: {
  row: number;
  col: number;
}): ProbeDefinition;
/**
 * Mode probe — check mode via getMode (termless) or DECRPM (term).
 */
declare function modeProbe(id: string, modeName: string, enableSeq: string, _disableSeq: string, modeNum: number): ProbeDefinition;
/**
 * Behavioral mode probe — enable mode, verify terminal is responsive, disable.
 * Uses DECRPM first (term), falls back to behavioral test.
 */
declare function behavioralModeProbe(id: string, enableSeq: string, disableSeq: string, modeNum: number, termlessFn: ((ctx: TermlessContext) => ProbeResult) | null, termBehaviorFn?: (ctx: TermContext) => Promise<ProbeResult>): ProbeDefinition;
/**
 * Response probe — send query, check response via feedCapture (termless) or query (term).
 */
declare function responseProbe(id: string, sequence: string, expectedPattern: RegExp, termlessCheck?: (response: string) => ProbeResult, termQueryFn?: (ctx: TermContext) => Promise<ProbeResult>): ProbeDefinition;
/**
 * Capability probe — check capabilities flag (termless only, term=null).
 */
declare function capabilityProbe(id: string, capName: keyof TermlessContext["capabilities"]): ProbeDefinition;
/**
 * Width probe — check rendered width of text.
 */
declare function widthProbe(id: string, text: string, expectedWidth: number): ProbeDefinition;
/** Check if a cell character is blank (empty or space). */
declare function isBlank(char: string): boolean;
/**
 * Simple probe — for probes that need custom logic on both sides.
 */
declare function probe(id: string, termless: ((ctx: TermlessContext) => ProbeResult) | null, term: ((ctx: TermContext) => Promise<ProbeResult>) | null): ProbeDefinition;
//#endregion
//#region src/sgr.d.ts
declare const sgrProbes: ProbeDefinition[];
//#endregion
//#region src/cursor.d.ts
declare const cursorProbes: ProbeDefinition[];
//#endregion
//#region src/text.d.ts
declare const textProbes: ProbeDefinition[];
//#endregion
//#region src/erase.d.ts
declare const eraseProbes: ProbeDefinition[];
//#endregion
//#region src/editing.d.ts
declare const editingProbes: ProbeDefinition[];
//#endregion
//#region src/modes.d.ts
declare const modesProbes: ProbeDefinition[];
//#endregion
//#region src/device.d.ts
declare const deviceProbes: ProbeDefinition[];
//#endregion
//#region src/extensions.d.ts
declare const extensionsProbes: ProbeDefinition[];
//#endregion
//#region src/input.d.ts
declare const inputProbes: ProbeDefinition[];
//#endregion
//#region src/reset.d.ts
declare const resetProbes: ProbeDefinition[];
//#endregion
//#region src/scrollback.d.ts
declare const scrollbackProbes: ProbeDefinition[];
//#endregion
//#region src/charsets.d.ts
declare const charsetsProbes: ProbeDefinition[];
//#endregion
//#region src/unicode.d.ts
declare const unicodeProbes: ProbeDefinition[];
//#endregion
//#region src/index.d.ts
declare const ALL_PROBES: ProbeDefinition[];
//#endregion
export { ALL_PROBES, type ProbeDefinition, type ProbeResult, type TermContext, type TermlessContext, behavioralModeProbe, capabilityProbe, charsetsProbes, cursorProbe, cursorProbes, deviceProbes, editingProbes, eraseProbes, extensionsProbes, inputProbes, isBlank, modeProbe, modesProbes, probe, resetProbes, responseProbe, scrollbackProbes, sgrProbe, sgrProbes, textProbes, unicodeProbes, widthProbe };