/**
 * @failure A provenance executable.version whose number is not dotted (xterm "411") was refused, so an
 *   apparatus-generated run could not be admitted; loosening the extractor must not admit two numbers.
 * @level l1
 * @consumer run-parser provenance admission, linux-container-run receipt composition
 * @reach parses the native provenance block of a controlled-Linux run
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { decodeCollectorDraft, parseRun, parseRunProvenance } from "./index.ts"
import { initializeRunDraft, sealRunDraft, type ProbeSuiteManifest } from "@terminfo/probe-defs"

const target = {
  kind: "term" as const,
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
  it("accepts a bare integer version and still requires exactly one token equal to subject.version", () => {
    expect(
      parseRunProvenance(provenance("XTerm(411)"), { ...target, kind: "term" }, expected, "p")?.executable.version,
    ).toBe("XTerm(411)")
    expect(() => parseRunProvenance(provenance("XTerm(412)"), { ...target, kind: "term" }, expected, "p")).toThrow(
      /differs from subject.version/,
    )
    // A second bare integer (a build number) is still a refusal: the check never passes falsely.
    expect(() =>
      parseRunProvenance(provenance("XTerm(411) build 99887-2"), { ...target, kind: "term" }, expected, "p"),
    ).toThrow(/differs from subject.version/)
  })

  // The inner mux version differs from the independently measured outer app version. Existing
  // provenance-only coverage cannot catch dropping this namespace or validating it as the mux.
  it("retains one app preflight on a mux and rejects conflicting subjects", () => {
    const outerApp = {
      subject: target,
      rawReplies: { "device.da1": "\u001b[?64;1;2c" },
      provenance: provenance("XTerm(411)"),
    }
    const muxTarget = {
      ...target,
      kind: "mux" as const,
      id: "tmux",
      version: "3.7c",
      outerTerminal: "xterm",
      mux: "tmux",
    }
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: expected.probeHash,
      adapterVersion: "test",
      catalogIds: ["fixture.catalog"],
      probes: { term: [], lib: [], mux: [] },
    }
    const draft = initializeRunDraft({
      runId: "attached-mux",
      sourceRevision: expected.sourceRevision,
      manifest,
      source: { kind: "live" },
      intendedSubject: { kind: "mux", id: "tmux" },
    })
    draft.subject = muxTarget
    draft.identity = "unverified"
    draft.measuredAt = "2026-10-19T00:00:00Z"
    draft.origin = { kind: "collector" }
    draft.outerApp = outerApp
    const raw = sealRunDraft(draft, "2026-10-19T00:01:00.000Z")
    const suites = new Map<string, ProbeSuiteManifest>([[expected.probeHash, manifest]])
    const parse = (value: unknown) => parseRun("mux.json", JSON.stringify(value), manifest.catalogIds, suites)
    expect(parse(raw)).toMatchObject({
      outerApp: {
        subject: { ...target, kind: "term" },
        rawReplies: outerApp.rawReplies,
        provenance: outerApp.provenance,
      },
    })
    // The daemon save path rebuilds the public run; parsing alone cannot catch a dropped proof.
    const decoded = decodeCollectorDraft(
      "mux.json",
      JSON.stringify(draft),
      suites.get(expected.probeHash)!,
      expected.sourceRevision,
    )
    expect(decoded.run.outerApp).toEqual({
      subject: { ...target, kind: "term" },
      rawReplies: outerApp.rawReplies,
      provenance: outerApp.provenance,
    })
    expect(parse({ ...raw, outerApp: undefined })).not.toHaveProperty("outerApp")
    expect(() => parse({ ...raw, outerApp: { ...outerApp, provenance: provenance("XTerm(412)") } })).toThrow(
      /differs from subject\.version 411/,
    )
    for (const conflicting of [
      { ...raw, subject: target },
      { ...raw, subject: { ...muxTarget, outerTerminal: "kitty" } },
      { ...raw, subject: { ...muxTarget, mux: "screen" } },
      { ...raw, outerApp: { ...outerApp, subject: { ...target, os: "darwin" } } },
      { ...raw, outerApp: { ...outerApp, subject: { ...target, kind: "mux" } } },
      { ...raw, outerApp: { ...outerApp, subject: { ...target, version: "412" } } },
      { ...raw, outerApp: { ...outerApp, rawReplies: { reply: 1 } } },
      { ...raw, provenance: outerApp.provenance },
    ]) {
      expect(() => parse(conflicting)).toThrow(/outerApp|term subject/)
    }
  })
})
