/**
 * @failure A WezTerm Linux Nix version bump adds a version range/prefix or omits its git rev/audit citation, or a
 *   feature-group constant drops an already-audited exact version (#38127, @cto 146524d0 / 15dada37).
 * @level l1
 * @consumer wezterm-linux-reviewed.ts named feature-group constants read by app-semantic-state, linux-clipboard,
 *   owned-terminal, and probes/unified.
 */
import { describe, expect, test } from "vitest"
import {
  WEZTERM_LINUX_CLIPBOARD_READ_DEFAULTS,
  WEZTERM_LINUX_OSC7_CLI_BUILDS,
  WEZTERM_LINUX_OSC7_CLI_VERSIONS,
  WEZTERM_LINUX_POINTER_IMAGE_BUILDS,
  WEZTERM_LINUX_POINTER_IMAGE_VERSIONS,
  WEZTERM_LINUX_SEMANTIC_BUILDS,
  WEZTERM_LINUX_SYNC_OUTPUT_BUILDS,
  WEZTERM_LINUX_SYNC_OUTPUT_VERSIONS,
} from "./wezterm-linux-reviewed.ts"

const EXACT_NIX_WEZTERM_VERSION = /^0-unstable-\d{4}-\d{2}-\d{2}$/

describe("WezTerm Linux reviewed-build constants (#38127)", () => {
  test("every feature group carries exact Nix versions with rev and audit citations", () => {
    for (const group of [
      WEZTERM_LINUX_SEMANTIC_BUILDS,
      WEZTERM_LINUX_SYNC_OUTPUT_BUILDS,
      WEZTERM_LINUX_POINTER_IMAGE_BUILDS,
      WEZTERM_LINUX_OSC7_CLI_BUILDS,
    ]) {
      expect(group.length).toBeGreaterThanOrEqual(2)
      for (const entry of group) {
        expect(entry.version).toMatch(EXACT_NIX_WEZTERM_VERSION)
        expect(entry.rev).toMatch(/^[a-f0-9]{12,40}$/)
        expect(entry.audit.trim().length).toBeGreaterThan(10)
      }
    }
    for (const entry of WEZTERM_LINUX_CLIPBOARD_READ_DEFAULTS) {
      expect(entry.posture).toBe("absent")
      expect(entry.version).toMatch(EXACT_NIX_WEZTERM_VERSION)
      expect(entry.source).toContain("QuerySelection")
    }
    expect([...WEZTERM_LINUX_SYNC_OUTPUT_VERSIONS]).toEqual(WEZTERM_LINUX_SYNC_OUTPUT_BUILDS.map((e) => e.version))
    expect([...WEZTERM_LINUX_POINTER_IMAGE_VERSIONS]).toEqual(WEZTERM_LINUX_POINTER_IMAGE_BUILDS.map((e) => e.version))
    expect([...WEZTERM_LINUX_OSC7_CLI_VERSIONS]).toEqual(WEZTERM_LINUX_OSC7_CLI_BUILDS.map((e) => e.version))
  })
})
