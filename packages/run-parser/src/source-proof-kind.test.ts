/**
 * @failure A recursive source tree can only be proven by naming the proof: a receipt that says
 *   "derived-source-tree" but omits the upstream revision, or carries a kind nothing implements,
 *   must be refused rather than admitted with a plausible-but-unproven source (@cto 2026-10-06, 27892).
 * @level l1
 * @consumer run-parser provenance admission, linux-container-run receipt composition
 * @reach parses the native provenance sourceArtifact of a controlled-Linux run
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseRunProvenance } from "./index.ts"

const target = {
  kind: "term" as const,
  id: "ghostty",
  version: "1.3.1",
  os: "linux",
  osVersion: null,
  outerTerminal: null,
  mux: null,
  config: null,
  permissions: null,
}
const expected = { probeHash: "3".repeat(12), sourceRevision: "2".repeat(40) }
const derived = {
  kind: "derived-source-tree",
  url: "https://github.com/ghostty-org/ghostty/archive/refs/tags/v1.3.1.tar.gz",
  revision: "refs/tags/v1.3.1",
  narSri: "sha256-+ddMmUe9Jjkun4qqW8XFXVgwVZdVHsGWcQzndgIlBjQ=",
  // 28240: a placeholder (one repeated character) is refused by name, so this is a two-char cycle.
  sha256: "b2".repeat(32),
}
const provenance = (sourceArtifact: unknown) => ({
  // 28260: a placeholder is refused by name, so every measured digest is a two-char cycle.
  executable: { path: "/nix/store/ghostty/bin/ghostty", sha256: "a1".repeat(32), version: "1.3.1" },
  sourceArtifact,
  runtime: {
    imageId: "sha256:" + "c".repeat(64),
    imageTarSha256: "d4".repeat(32),
    arch: "amd64",
    nixLockRevision: "1".repeat(40),
    sourceRevision: "2".repeat(40),
    cleanTree: true,
    suiteHash: "3".repeat(12),
  },
  fixture: {
    definition: "fixture",
    config: "fixture",
    font: "fixture",
    geometry: "100x30",
    display: "fixture",
    gl: "fixture",
  },
})

describe("native provenance source proof kind", () => {
  it("parses a derived source tree with its tree hash and revision intact", () => {
    expect(parseRunProvenance(provenance(derived), target, expected, "p")?.sourceArtifact).toEqual(derived)
  })

  it("refuses a derived source tree with no upstream revision", () => {
    expect(() => parseRunProvenance(provenance({ ...derived, revision: "" }), target, expected, "p")).toThrow(
      /revision/,
    )
    const { revision: _dropped, ...withoutRevision } = derived
    expect(() => parseRunProvenance(provenance(withoutRevision), target, expected, "p")).toThrow(
      /sourceArtifact fields/,
    )
  })

  it("refuses an unknown kind and a malformed derived hash", () => {
    expect(() => parseRunProvenance(provenance({ ...derived, kind: "invented-proof" }), target, expected, "p")).toThrow(
      /unknown provenance.sourceArtifact kind/,
    )
    expect(() => parseRunProvenance(provenance({ ...derived, sha256: "not-a-sha256" }), target, expected, "p")).toThrow(
      /sourceArtifact.sha256/,
    )
    expect(() => parseRunProvenance(provenance({ ...derived, narSri: "sha512-x" }), target, expected, "p")).toThrow(
      /sourceArtifact.narSri/,
    )
  })

  it("keeps the flat-archive form unchanged when no kind is present", () => {
    const flat = { url: "https://invisible-island.net/archives/xterm/xterm-411.tgz", sha256: "b7".repeat(32) }
    expect(parseRunProvenance(provenance(flat), target, expected, "p")?.sourceArtifact).toEqual(flat)
  })

  // 28260: the container-provenance digests must refuse a digest nothing measured, by name, the same
  // way the app-launch branch does. A repeated character is what a hand writes when no bytes existed.
  it("refuses a placeholder digest in each container-provenance field", () => {
    const placeholder = "0".repeat(64)
    const base = provenance(derived)
    const flat = { url: "https://invisible-island.net/archives/xterm/xterm-411.tgz", sha256: placeholder }
    const cases: Array<[string, typeof base]> = [
      ["executable.sha256", { ...base, executable: { ...base.executable, sha256: placeholder } }],
      ["sourceArtifact.sha256", { ...base, sourceArtifact: flat }],
      ["runtime.imageTarSha256", { ...base, runtime: { ...base.runtime, imageTarSha256: placeholder } }],
    ]
    for (const [field, value] of cases) {
      expect(() => parseRunProvenance(value, target, expected, "p"), field).toThrow(/placeholder/)
    }
  })
})
