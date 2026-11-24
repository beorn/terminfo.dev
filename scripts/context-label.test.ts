/**
 * @failure  A public context label leaks launcher flags (`nice -n 10`), binary or `/nix/store` paths,
 *           permissions, mux or outer-terminal names onto the public site (#37631).
 * @failure  An unparseable key is silently replaced with an invented name.
 * @level    l1
 * @consumer The evidence cell that names the contexts a grade came from (ResultEvidenceCell.vue joinedGrades).
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { contextLabel, contextLine } from "../docs/.vitepress/theme/context-label.ts"

describe("contextLabel (#37631: public OS only, never launcher/store/binary/perms/mux internals)", () => {
  it("prints only the formatted OS and version, stripping nice flags, store/binary paths, permissions, mux and outer terminal", () => {
    const key = `term:kitty@["term","kitty","linux","7.0.0-43-generic","wezterm","tmux","nice -n 10 /nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty/bin/kitty --config NONE","screen-recording"]`
    const label = contextLabel(key)
    expect(label).toBe("Linux 7.0.0-43-generic")
    expect(label).not.toMatch(/nice|nix\/store|\/bin\/|perms|mux|outer|config/i)
  })

  it("formats macOS cleanly without internal launch metadata", () => {
    const key = `term:ghostty@["term","ghostty","macos","26.7.2",null,null,null,null]`
    expect(contextLabel(key)).toBe("macOS 26.7.2")
  })

  it("keeps a single measured app's plain key", () => {
    expect(contextLabel("term:kitty")).toBe("term:kitty")
  })

  it("returns an unparseable key unchanged rather than inventing one", () => {
    expect(contextLabel("term:kitty@[not json")).toBe("term:kitty@[not json")
  })
})

describe("contextLine (#37341 + #37631)", () => {
  const kittyLinux = `term:kitty@["term","kitty","linux","7.0.0-43-generic",null,null,"nice -n 10 /nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty/bin/kitty --config NONE",null]`
  const kittyMac = `term:kitty@["term","kitty","macos","26.7.2",null,null,null,"clipboard-read"]`
  const word = (status: string) => ({ supported: "Supported", unsupported: "Unsupported" })[status] ?? status

  it("names only the public OS context a grade comes from, without internals or repeating the badge grade", () => {
    const line = contextLine([{ context: kittyLinux, status: "unsupported" }], 2, false, word)
    expect(line).toBe("Context: Linux 7.0.0-43-generic")
    expect(line).not.toMatch(/nice|nix\/store|\/bin\/|perms|kitty --config/i)
  })

  it("says each public OS context's grade when contexts differ, with zero internal launch details", () => {
    const grades = [
      { context: kittyLinux, status: "unsupported" },
      { context: kittyMac, status: "supported" },
    ]
    const line = contextLine(grades, 2, true, word)
    expect(line).toBe("Differs by context: Linux 7.0.0-43-generic — Unsupported · macOS 26.7.2 — Supported")
    expect(line).not.toMatch(/nice|nix\/store|\/bin\/|perms|clipboard-read/i)
  })

  it("prints no line when every context of the app carries the same grade, or no context is named", () => {
    const same = [
      { context: kittyLinux, status: "unsupported" },
      { context: kittyMac, status: "unsupported" },
    ]
    expect(contextLine(same, 2, false, word)).toBeUndefined()
    expect(contextLine(undefined, 2, false, word)).toBeUndefined()
  })
})
