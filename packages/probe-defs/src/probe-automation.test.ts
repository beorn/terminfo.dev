import { describe, expect, test } from "vitest"
import { ALL_PROBES, type TermlessContext } from "./index.ts"

function probe(id: string) {
  const found = ALL_PROBES.find((p) => p.id === id)
  if (!found) throw new Error(`missing probe ${id}`)
  return found
}

function context(overrides: Partial<TermlessContext>): TermlessContext {
  return {
    feed() {},
    feedCapture() {
      return ""
    },
    getCell() {
      return {
        char: "",
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        underlineColor: null,
        strikethrough: false,
        inverse: false,
        hidden: false,
        blink: false,
        fg: null,
        bg: null,
        wide: false,
      }
    },
    getCursor() {
      return { x: 0, y: 0, visible: true, style: "block" }
    },
    getMode() {
      return false
    },
    getText() {
      return ""
    },
    getScrollback() {
      return { viewportOffset: 0, totalLines: 24, screenLines: 24 }
    },
    getTitle() {
      return ""
    },
    reset() {},
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "unknown",
      extensions: new Set(),
    },
    ...overrides,
  }
}

describe("partial probe automation candidates", () => {
  test("modes.decsclm verifies the DEC private mode through DECRPM", () => {
    const p = probe("modes.decsclm")
    expect(p.termless).toBeTypeOf("function")

    const seen: string[] = []
    const result = p.termless!(
      context({
        feed(text) {
          seen.push(text)
        },
        feedCapture(text) {
          seen.push(text)
          return "\x1b[?4;1$y"
        },
      }),
    )

    expect(result.pass).toBe(true)
    expect(seen).toEqual(["\x1b[?4h", "\x1b[?4$p", "\x1b[?4l"])
  })

  test("device.dsr-996-color-scheme verifies the color-scheme response", () => {
    const p = probe("device.dsr-996-color-scheme")
    expect(p.termless).toBeTypeOf("function")

    const result = p.termless!(
      context({
        feedCapture(text) {
          expect(text).toBe("\x1b[?996n")
          return "\x1b[?997;1n"
        },
      }),
    )

    expect(result.pass).toBe(true)
    expect(result.response).toBe("\x1b[?997;1n")
  })
})
