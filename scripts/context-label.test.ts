/**
 * @failure  A context is named by its storage key instead of its machine and launch profile, or an
 *           unparseable key is silently replaced with an invented name.
 * @level    l1
 * @consumer The evidence cell that names the contexts a "differs by context" grade came from.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { contextLabel } from "../docs/.vitepress/theme/context-label.ts"

describe("contextLabel", () => {
  it("names machine, launch profile and permissions from a recorded context key", () => {
    const key = `term:kitty@["term","kitty","linux","7.0.0-34-generic",null,null,"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty/bin/kitty --config NONE",null]`
    expect(contextLabel(key)).toBe("linux 7.0.0-34-generic · kitty --config NONE · no permissions")
  })

  it("keeps a single measured app's plain key", () => {
    expect(contextLabel("term:kitty")).toBe("term:kitty")
  })

  it("returns an unparseable key unchanged rather than inventing one", () => {
    expect(contextLabel("term:kitty@[not json")).toBe("term:kitty@[not json")
  })
})
