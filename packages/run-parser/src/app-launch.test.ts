/**
 * @failure A placeholder sha256 — one repeated character — passed the FLAT branch of the app-launch
 *   receipt parser, so two admitted macOS documents (alacritty-0.17.0-macos, terminal-app-2.15-macos)
 *   held receipts nothing measured. The refusal must name the placeholder without refusing a measured
 *   digest, and it must reuse the ONE predicate the container receipt already applies (27874, 28240).
 * @level l1
 * @consumer run-parser app-launch admission; the docs/data current-results projection
 * @reach parses origin.appLaunch of a collector app run
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseAppLaunchReceipt } from "./app-launch.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..")
const ZEROS = "0".repeat(64)
const LETTERS = "a".repeat(64)

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

const MEASURED = "alacritty-0.17.0-macos-976d8f5c37c0fb4426205993a0c08da1.json"

describe("a placeholder digest is refused by name", () => {
  for (const name of ["alacritty-0.17.0-macos.json", "terminal-app-2.15-macos.json"]) {
    it("refuses the placeholder receipt carried by " + name, () => {
      expect(() => parse(appLaunchOf(name))).toThrow(/placeholder/)
    })
  }

  it("refuses a placeholder executableSha256 on an otherwise measured receipt", () => {
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "executableSha256", ZEROS))).toThrow(/placeholder/)
  })

  it("refuses a placeholder sourceArtifact.sha256 on an otherwise measured receipt", () => {
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "sourceArtifact.sha256", ZEROS))).toThrow(/placeholder/)
  })

  it("refuses one repeated character, not only an all-zero digest", () => {
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "executableSha256", LETTERS))).toThrow(/placeholder/)
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "sourceArtifact.sha256", LETTERS))).toThrow(/placeholder/)
  })

  it("still refuses a digest that is not a sha256 at all", () => {
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "executableSha256", "zz"))).toThrow(/invalid/)
    expect(() => parse(withDigest(appLaunchOf(MEASURED), "sourceArtifact.sha256", "zz"))).toThrow(/invalid/)
  })
})

describe("a measured receipt still parses", () => {
  it("accepts the receipt 28216's re-collection produced", () => {
    const parsed = parse(appLaunchOf(MEASURED)) as { executableSha256: string; sourceArtifact: { sha256: string } }
    expect(parsed.executableSha256).toBe("444055799f1211d6adbe9f18ab2660c57155de4f0e88d42458d6ae4fb539dcda")
    expect(parsed.sourceArtifact.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(parsed.sourceArtifact.sha256).not.toBe(ZEROS)
  })
})
