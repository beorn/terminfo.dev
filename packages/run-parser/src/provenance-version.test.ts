/**
 * @failure A provenance executable.version whose number is not dotted (xterm "411") was refused, so an
 *   apparatus-generated run could not be admitted; loosening the extractor must not admit two numbers.
 * @level l1
 * @consumer run-parser provenance admission, linux-container-run receipt composition
 * @reach parses the native provenance block of a controlled-Linux run
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseRunProvenance } from "./index.ts"

const target = {
  kind: "app" as const,
  id: "xterm",
  version: "411",
  os: "linux",
  osVersion: null,
  outerTerminal: null,
  mux: null,
  config: null,
  permissions: null,
}
const expected = { probeHash: "3".repeat(12), sourceRevision: "2".repeat(40) }
const provenance = (version: string) => ({
  executable: { path: "/nix/store/xterm-411/bin/xterm", sha256: "a".repeat(64), version },
  sourceArtifact: { url: "https://invisible-island.net/archives/xterm/xterm-411.tgz", sha256: "b".repeat(64) },
  runtime: {
    imageId: "sha256:" + "c".repeat(64),
    imageTarSha256: "d".repeat(64),
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

describe("parseRunProvenance version token", () => {
  it("accepts a bare integer version and still requires exactly one token equal to target.version", () => {
    expect(parseRunProvenance(provenance("XTerm(411)"), target, expected, "p")?.executable.version).toBe("XTerm(411)")
    expect(() => parseRunProvenance(provenance("XTerm(412)"), target, expected, "p")).toThrow(
      /differs from target.version/,
    )
    // A second bare integer (a build number) is still a refusal: the check never passes falsely.
    expect(() => parseRunProvenance(provenance("XTerm(411) build 99887-2"), target, expected, "p")).toThrow(
      /differs from target.version/,
    )
  })
})
