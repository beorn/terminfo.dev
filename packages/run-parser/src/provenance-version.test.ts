/**
 * @failure A provenance executable.version whose number is not dotted (xterm "411") was refused, so an
 *   apparatus-generated run could not be admitted; loosening the extractor must not admit two numbers.
 * @level l1
 * @consumer run-parser provenance admission, linux-container-run receipt composition
 * @reach parses the native provenance block of a controlled-Linux run
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { decodeHistoricalCollectorRun, parseRun, parseRunProvenance } from "./index.ts"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"

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
  executable: { path: "/nix/store/xterm-411/bin/xterm", sha256: "a1".repeat(32), version },
  sourceArtifact: { url: "https://invisible-island.net/archives/xterm/xterm-411.tgz", sha256: "b7".repeat(32) },
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

  // The inner mux version differs from the independently measured outer app version. Existing
  // provenance-only coverage cannot catch dropping this namespace or validating it as the mux.
  it("retains one app preflight on a mux and rejects conflicting subjects", () => {
    const outerApp = { target, rawReplies: { "device.da1": "\u001b[?64;1;2c" }, provenance: provenance("XTerm(411)") }
    const muxTarget = { ...target, kind: "mux", id: "tmux", version: "3.7c", outerTerminal: "xterm", mux: "tmux" }
    const raw = {
      schemaVersion: 2,
      runId: "attached-mux",
      target: muxTarget,
      identity: "unverified",
      suiteId: "test",
      ...expected,
      suiteComplete: true,
      measuredAt: "2026-10-19T00:00:00Z",
      origin: { kind: "collector" },
      rawReplies: {},
      assertions: [],
      observations: [],
      screenshotRefs: [],
      outerApp,
    }
    const suites = new Map<string, ProbeSuiteManifest>([
      [
        expected.probeHash,
        {
          probeHash: expected.probeHash,
          adapterVersion: "test",
          probes: { term: [], lib: [], mux: [] },
        },
      ],
    ])
    const parse = (value: unknown) => parseRun("mux.json", JSON.stringify(value), [], suites)
    expect(parse(raw)).toMatchObject({ outerApp })
    // The daemon save path rebuilds the public run; parsing alone cannot catch a dropped proof.
    const decoded = decodeHistoricalCollectorRun(
      "mux.json",
      JSON.stringify({ ...raw, suiteId: expected.probeHash }),
      suites.get(expected.probeHash)!,
      expected.sourceRevision,
    )
    expect(decoded.run.outerApp).toEqual(outerApp)
    expect(parse({ ...raw, outerApp: undefined })).not.toHaveProperty("outerApp")
    for (const conflicting of [
      { ...raw, target },
      { ...raw, target: { ...muxTarget, outerTerminal: "kitty" } },
      { ...raw, target: { ...muxTarget, mux: "screen" } },
      { ...raw, outerApp: { ...outerApp, target: { ...target, os: "darwin" } } },
      { ...raw, outerApp: { ...outerApp, target: { ...target, kind: "mux" } } },
      { ...raw, outerApp: { ...outerApp, target: { ...target, version: "412" } } },
      { ...raw, outerApp: { ...outerApp, rawReplies: { reply: 1 } } },
      { ...raw, provenance: outerApp.provenance },
    ]) {
      expect(() => parse(conflicting)).toThrow(/outerApp|app target/)
    }
  })
})
