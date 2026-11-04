/**
 * @failure The headless OSC 1 arm ignores getIconLabel and stays not-tested after the icon changes.
 * @level l1
 * @consumer Headless icon-name readback for extensions.osc1-icon.
 * @reach Calls the osc1 lib arm with and without getIconLabel.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import type { LibProbeSource } from "./types.ts"

function source(
  icon: { current: string } | null,
  options: {
    changesTitle?: boolean
    ignoresTitleSetup?: boolean
    ignoresIconSet?: boolean
    initialTitle?: string
  } = {},
): LibProbeSource {
  let title = options.initialTitle ?? "unchanged-title"
  return {
    backendName: "scripted-model",
    kind: "live",
    cols: 80,
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "15.1",
      extensions: new Set<string>(),
    },
    feed(text: string) {
      const windowTitle = /\x1b\](?:0|2);([^\x07]*)\x07/.exec(text)?.[1]
      if (windowTitle !== undefined && !options.ignoresTitleSetup) title = windowTitle
      const iconLabel = /\x1b\](?:0|1);([^\x07]*)\x07/.exec(text)?.[1]
      if (icon && iconLabel !== undefined && !options.ignoresIconSet) {
        icon.current = iconLabel
        if (options.changesTitle) title = iconLabel
      }
    },
    feedCapture: () => "",
    getMode: () => false,
    getText: () => "",
    getTitle: () => title,
    ...(icon ? { getIconLabel: () => icon.current } : {}),
    getCell: () => ({
      char: "X",
      bold: false,
      dim: null,
      italic: null,
      underline: false,
      strikethrough: null,
      inverse: false,
      hidden: false,
      blink: null,
      overline: null,
      fg: null,
      bg: null,
      wide: false,
    }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
    reset: () => {},
  }
}

test("headless osc1 grades the icon when getIconLabel is present", () => {
  const probe = extensionsProbes.find((entry) => entry.id === "extensions.osc1-icon")
  expect(probe?.lib).toBeTypeOf("function")
  const icon = { current: "" }
  const result = probe!.lib!(source(icon))
  expect(icon.current).toBe("")
  expect(result.notTested).toBeUndefined()
  expect(result.pass).toBe(true)
})

test("headless osc1 stays not-tested when getIconLabel is absent", () => {
  const probe = extensionsProbes.find((entry) => entry.id === "extensions.osc1-icon")
  const result = probe!.lib!(source(null))
  expect(result.notTested?.reason).toBe("no-semantic-observable")
  expect(result.pass).toBe(false)
})

test.each([false, true])("headless osc1 checks title independence when the title side effect is %s", (changesTitle) => {
  const probe = extensionsProbes.find((entry) => entry.id === "extensions.osc1-icon")
  const icon = { current: "original-icon" }
  const ctx = source(icon, { changesTitle })
  const result = probe!.lib!(ctx)
  expect(result.observation).toMatchObject({ outcome: changesTitle ? "unsupported" : "supported" })
  expect(icon.current).toBe("original-icon")
  expect(ctx.getTitle()).toBe("unchanged-title")
})

test("headless osc1 requires a verified title control before deciding independence", () => {
  const probe = extensionsProbes.find((entry) => entry.id === "extensions.osc1-icon")
  const result = probe!.lib!(source({ current: "original-icon" }, { ignoresTitleSetup: true }))
  expect(result.observation).toBeUndefined()
  expect(result.notTested?.noObservable).toBe("observation not decided: no same-path control in this run")
})

test.each(["original-icon", "test-icon"])(
  "headless osc1 keeps an unqualified icon path undecided from %s",
  (initial) => {
    const probe = extensionsProbes.find((entry) => entry.id === "extensions.osc1-icon")
    const result = probe!.lib!(source({ current: initial }, { ignoresIconSet: true }))
    expect(result.observation).toBeUndefined()
    expect(result.notTested?.noObservable).toBe("observation not decided: no same-path control in this run")
  },
)

// The title criterion must witness a change, including when the old title already equals the
// usual payload. Existing OSC 1 controls exercise title setup but never the OSC 2 probe itself.
test.each(["unchanged-title", "Test Title"])(
  "headless osc2 keeps an unqualified write undecided from initial title %s",
  (initialTitle) => {
    const probe = extensionsProbes.find((entry) => entry.id === "extensions.osc2-title")!
    for (const ignoresTitleSetup of [true, false]) {
      const ctx = source(null, { initialTitle, ignoresTitleSetup })
      const result = probe.lib!(ctx)
      if (ignoresTitleSetup) {
        expect(result.notTested?.noObservable).toBe("observation not decided: no same-path control in this run")
        expect(result.observation).toBeUndefined()
      } else {
        expect(result.observation).toMatchObject({ outcome: "supported" })
      }
      expect(ctx.getTitle()).toBe(initialTitle)
    }
  },
)
