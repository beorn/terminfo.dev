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

  test("OSC 113/114 reset probes verify pointer color reset through query responses", () => {
    const cases = [
      {
        id: "extensions.osc113-reset-pointer-fg",
        expected: "\x1b]13;?\x07",
        response: "\x1b]13;rgb:ffff/ffff/ffff\x1b\\",
      },
      {
        id: "extensions.osc114-reset-pointer-bg",
        expected: "\x1b]14;?\x07",
        response: "\x1b]14;rgb:0000/0000/0000\x1b\\",
      },
    ]

    for (const c of cases) {
      const p = probe(c.id)
      expect(p.termless).toBeTypeOf("function")
      const feed: string[] = []
      const capture: string[] = []
      const result = p.termless!(
        context({
          feed(text) {
            feed.push(text)
          },
          feedCapture(text) {
            capture.push(text)
            return c.response
          },
        }),
      )
      expect(result.pass).toBe(true)
      expect(capture).toEqual([c.expected])
      expect(feed.length).toBeGreaterThan(0)
    }
  })

  test("OSC 30001/30101 probes verify color stack restore behavior", () => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const p = probe(id)
      expect(p.termless).toBeTypeOf("function")
      const result = p.termless!(
        context({
          feedCapture(text) {
            expect(text).toBe(
              "\x1b]10;rgb:10/20/30\x07\x1b]30001\x07\x1b]10;rgb:aa/bb/cc\x07\x1b]30101\x07\x1b]10;?\x07",
            )
            return "\x1b]10;rgb:1010/2020/3030\x1b\\"
          },
        }),
      )
      expect(result.pass).toBe(true)
    }
  })

  test("mintty and rxvt query probes verify typed OSC responses", () => {
    const cases = [
      ["extensions.osc7770-font-size", "\x1b]7770;?\x07", "\x1b]7770;12\x1b\\"],
      ["extensions.osc7777-font-window-size", "\x1b]7777;?\x07", "\x1b]7777;12\x1b\\"],
      ["extensions.osc701-locale", "\x1b]701;?\x07", "\x1b]701;en_US.UTF-8\x1b\\"],
      ["extensions.osc702-version", "\x1b]702\x07", "\x1b]702;vterm.js;vterm;0;2\x1b\\"],
      ["extensions.osc776-cell-size", "\x1b]776\x07", "\x1b]776;8;17;14\x1b\\"],
    ] as const

    for (const [id, expected, response] of cases) {
      const p = probe(id)
      expect(p.termless).toBeTypeOf("function")
      const result = p.termless!(
        context({
          feedCapture(text) {
            expect(text).toBe(expected)
            return response
          },
        }),
      )
      expect(result.pass).toBe(true)
    }
  })

  test("OSC 720 verifies scrollback viewport movement", () => {
    const p = probe("extensions.osc720-scroll-up")
    expect(p.termless).toBeTypeOf("function")

    let scrollReads = 0
    const fed: string[] = []
    const result = p.termless!(
      context({
        feed(text) {
          fed.push(text)
        },
        getScrollback() {
          scrollReads++
          return scrollReads === 1
            ? { viewportOffset: 1, totalLines: 4, screenLines: 3 }
            : { viewportOffset: 0, totalLines: 4, screenLines: 3 }
        },
      }),
    )

    expect(result.pass).toBe(true)
    expect(fed).toContain("\x1b]720\x07")
  })
})
