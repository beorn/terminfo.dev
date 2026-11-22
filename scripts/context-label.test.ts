/**
 * @failure  A context is named by its storage key instead of its machine and launch profile, or an
 *           unparseable key is silently replaced with an invented name.
 * @failure  The Context line under a card repeats the grade the badge shows, or prints "no permissions" for an empty
 *           field, as the Kitty Linux TERM_FEATURES card did ("no permissions — Unsupported", #37341).
 * @level    l1
 * @consumer The evidence cell that names the contexts a grade came from (ResultEvidenceCell.vue joinedGrades).
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { contextLabel, contextLine } from "../docs/.vitepress/theme/context-label.ts"

describe("contextLabel", () => {
  it("names machine, launch profile and permissions from a recorded context key", () => {
    const key = `term:kitty@["term","kitty","linux","7.0.0-34-generic",null,null,"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty/bin/kitty --config NONE","screen-recording"]`
    expect(contextLabel(key)).toBe("linux 7.0.0-34-generic · kitty --config NONE · perms screen-recording")
  })

  // #37341: an empty permissions field says nothing about the grade, so the label prints nothing for it.
  it("prints nothing for an empty permissions field", () => {
    const key = `term:kitty@["term","kitty","linux","7.0.0-34-generic",null,null,"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty/bin/kitty --config NONE",null]`
    expect(contextLabel(key)).toBe("linux 7.0.0-34-generic · kitty --config NONE")
  })

  it("keeps a single measured app's plain key", () => {
    expect(contextLabel("term:kitty")).toBe("term:kitty")
  })

  it("returns an unparseable key unchanged rather than inventing one", () => {
    expect(contextLabel("term:kitty@[not json")).toBe("term:kitty@[not json")
  })
})

describe("contextLine (#37341: it names where a grade comes from, never the grade)", () => {
  const kitty = `term:kitty@["term","kitty","linux","7.0.0-43-generic",null,null,"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty/bin/kitty --config NONE",null]`
  const kittyRead = `term:kitty@["term","kitty","linux","7.0.0-43-generic",null,null,"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty/bin/kitty --config NONE","clipboard-read"]`
  const word = (status: string) => ({ supported: "Supported", unsupported: "Unsupported" })[status] ?? status

  it("names the context a grade comes from, without the grade the badge already shows", () => {
    expect(contextLine([{ context: kitty, status: "unsupported" }], 2, false, word)).toBe(
      "Context: linux 7.0.0-43-generic · kitty --config NONE",
    )
  })

  it("says each context's grade when the contexts differ, because that difference is the line", () => {
    const grades = [
      { context: kitty, status: "unsupported" },
      { context: kittyRead, status: "supported" },
    ]
    expect(contextLine(grades, 2, true, word)).toBe(
      "Differs by context: linux 7.0.0-43-generic · kitty --config NONE — Unsupported · " +
        "linux 7.0.0-43-generic · kitty --config NONE · perms clipboard-read — Supported",
    )
  })

  it("prints no line when every context of the app carries the same grade, or no context is named", () => {
    const same = [
      { context: kitty, status: "unsupported" },
      { context: kittyRead, status: "unsupported" },
    ]
    expect(contextLine(same, 2, false, word)).toBeUndefined()
    expect(contextLine(undefined, 2, false, word)).toBeUndefined()
  })
})
