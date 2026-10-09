/**
 * @failure A placeholder sha256 — one repeated character — passed the FLAT branch of the app-launch
 *   receipt parser and `parseDerivedSourceTree`, so two macOS documents (runs b6faa688, 2c0558f2) held
 *   receipts nothing measured. The refusal must name the placeholder without refusing a measured
 *   digest, and it must reuse the ONE predicate the container receipt already applies (27874, 28240).
 * @level l1
 * @consumer run-parser app-launch admission; the docs/data current-results projection
 * @reach parses origin.appLaunch of a collector app run, flat and derived-source-tree
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseAppLaunchReceipt } from "./app-launch.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..")
const ZEROS = "0".repeat(64)
const LETTERS = "a".repeat(64)
const MEASURED = "alacritty-0.17.0-macos-976d8f5c37c0fb4426205993a0c08da1.json"

/**
 * The two documents 28240 retired, carrying their own receipt blocks verbatim (@cto 2026-10-08: the
 * corpus documents are `git rm`-ed, so a test may not read them from disk any more).
 */
const RETIRED: Record<string, Record<string, unknown>> = {
  "alacritty-0.17.0-macos.json (run b6faa688)": {
    bundlePath: "/Applications/Alacritty.app",
    cfBundleShortVersionString: "0.17.0",
    cfBundleVersion: "1",
    executablePath: "/Applications/Alacritty.app/Contents/MacOS/alacritty",
    executableSha256: ZEROS,
    sourceArtifact: { path: "/Applications/Alacritty.app", sha256: ZEROS },
  },
  "terminal-app-2.15-macos.json (run 2c0558f2)": {
    bundlePath: "/System/Applications/Utilities/Terminal.app",
    cfBundleShortVersionString: "2.15",
    cfBundleVersion: "470.2",
    executablePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    executableSha256: ZEROS,
    sourceArtifact: { path: "/System/Applications/Utilities/Terminal.app", sha256: ZEROS },
  },
}

function appLaunchOf(name: string): Record<string, unknown> {
  const path = join(REPO_ROOT, "content", "probes-apps", name)
  const document = JSON.parse(readFileSync(path, "utf8")) as { origin: { appLaunch: Record<string, unknown> } }
  return document.origin.appLaunch
}

function parse(receipt: Record<string, unknown>): unknown {
  return parseAppLaunchReceipt(receipt, "collector", "app", "origin.appLaunch")
}

function withDigest(receipt: Record<string, unknown>, field: string, value: string): Record<string, unknown> {
  if (field === "executableSha256") return { ...receipt, executableSha256: value }
  const sourceArtifact = receipt.sourceArtifact as Record<string, unknown>
  return { ...receipt, sourceArtifact: { ...sourceArtifact, sha256: value } }
}

/** A derived source artifact names its proof; only `sha256` is the flat re-measured tar digest. */
function derived(sha256: string): Record<string, unknown> {
  return {
    kind: "derived-source-tree",
    url: "https://upstream.invalid/alacritty-0.17.0.tar.gz",
    revision: "b".repeat(40),
    narSri: "sha256-+ddMmUe9Jjkun4qqW8XFXVgwVZdVHsGWcQzndgIlBjQ=",
    sha256,
  }
}

function withDerived(receipt: Record<string, unknown>, sha256: string): Record<string, unknown> {
  return { ...receipt, sourceArtifact: derived(sha256) }
}

describe("a placeholder digest is refused by name", () => {
  for (const [label, receipt] of Object.entries(RETIRED)) {
    it("refuses the placeholder receipt carried by " + label, () => {
      expect(() => parse(receipt)).toThrow(/placeholder/)
    })
  }

  it("refuses a placeholder executableSha256 on an otherwise measured receipt", () => {
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "executableSha256", ZEROS))).toThrow(/placeholder/)
  })

  it("refuses a placeholder flat sourceArtifact.sha256 on an otherwise measured receipt", () => {
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "sourceArtifact.sha256", ZEROS))).toThrow(/placeholder/)
  })

  it("refuses a placeholder derived-source-tree sha256", () => {
    expect(() => parse(withDerived(appLaunchOf(MEASURED), ZEROS))).toThrow(/placeholder/)
  })

  it("refuses one repeated character, not only an all-zero digest", () => {
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "executableSha256", LETTERS))).toThrow(/placeholder/)
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "sourceArtifact.sha256", LETTERS))).toThrow(/placeholder/)
    expect(() => parse(withDerived(appLaunchOf(MEASURED), LETTERS))).toThrow(/placeholder/)
  })

  it("still refuses a digest that is not a sha256 at all", () => {
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "executableSha256", "zz"))).toThrow(/invalid/)
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "sourceArtifact.sha256", "zz"))).toThrow(/invalid/)
    expect(() => parse(withDerived(appLaunchOf(MEASURED), "zz"))).toThrow(/invalid/)
  })
})

describe("a measured receipt still parses", () => {
  it("accepts the receipt 28216's re-collection produced", () => {
    const parsed = parse(appLaunchOf(MEASURED)) as { executableSha256: string; sourceArtifact: { sha256: string } }
    expect(parsed.executableSha256).toBe("444055799f1211d6adbe9f18ab2660c57155de4f0e88d42458d6ae4fb539dcda")
    expect(parsed.sourceArtifact.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(parsed.sourceArtifact.sha256).not.toBe(ZEROS)
  })

  it("accepts a derived-source-tree artifact with a measured sha256", () => {
    const parsed = parse(withDerived(appLaunchOf(MEASURED), "c3".repeat(32))) as {
      sourceArtifact: { kind: string; sha256: string }
    }
    expect(parsed.sourceArtifact.kind).toBe("derived-source-tree")
    expect(parsed.sourceArtifact.sha256).toBe("c3".repeat(32))
  })
})
