/**
 * @failure The expected context register could drift from the catalog: a hand-maintained list would
 *   miss a new terminal, double-count an engine across operating systems, or silently drop a
 *   historical row instead of naming it.
 * @level l2
 * @consumer the full-273 project context census (docs/data/full-census.ts, step 7)
 * @source-grep the register is derived from content/terminals.json and content/probes-libs targets,
 *   so only this real-catalog assertion can catch a declaration the project must re-rule.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { fullContextCensus } from "../docs/data/full-census.ts"

const contentDir = join(import.meta.dirname, "..", "content")

describe("the expected context register", () => {
  it("derives all 33 agreed contexts from the catalog", () => {
    const census = fullContextCensus(contentDir)
    expect(census.contexts).toHaveLength(33)
    expect(census.engines).toHaveLength(11)
    expect(census.contexts.map((entry) => entry.context)).toEqual([
      "ghostty/linux",
      "ghostty/macos",
      "kitty/linux",
      "kitty/macos",
      "iterm2/macos",
      "terminal-app/macos",
      "warp/macos",
      "cursor/macos",
      "com.microsoft.VSCode/macos",
      "cmux/macos",
      "tmux/linux",
      "tmux/macos",
      "screen/linux",
      "screen/macos",
      "alacritty/linux",
      "alacritty/macos",
      "alacritty/windows",
      "wezterm/linux",
      "wezterm/macos",
      "wezterm/windows",
      "xterm/linux",
      "windows-terminal/windows",
      "alacritty/headless",
      "ghostty/headless",
      "ghostty-native/headless",
      "kitty/headless",
      "libvterm/headless",
      "vt100/headless",
      "vt100-rust/headless",
      "vt220/headless",
      "vterm/headless",
      "wezterm/headless",
      "xtermjs/headless",
    ])
  })

  it("counts each kind the way the plan does", () => {
    const { contexts } = fullContextCensus(contentDir)
    const count = (kind: string) => contexts.filter((entry) => entry.kind === kind).length
    expect(count("term")).toBe(18)
    expect(count("mux")).toBe(4)
    expect(count("lib")).toBe(11)
  })
})
