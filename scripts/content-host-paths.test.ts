/**
 * @failure Committed run files recorded absolute paths on the collecting host, the estate root or a
 *   person's home folder, so the public repository and site published that host's folder layout (30568).
 * @level l1
 * @consumer The committed content/ tree, which the repository and the site's API publish as it is
 * @reach fs-walk vendor/terminfo.dev/content/
 * @reach fs-walk <fixture-only: mkdtempSync content trees>
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * The one account a recorded home folder may name: GitHub-hosted runners and the Linux
 * measurement container both run as `runner`, which names no person.
 */
const RUNNER_ACCOUNT = "runner"

/**
 * An absolute path on a collecting host: the estate root /hh, or the home folder of any
 * account but the runner's. A run file that records one publishes the host's folder layout
 * or a person's account name.
 */
const HOST_PATH = new RegExp(
  String.raw`(?<![\w.~-])/(?:hh(?=[/"'\s\\]|$)|(?:home|Users)/(?!${RUNNER_ACCOUNT}(?=[/"'\s\\]|$))[^/"'\s\\]+)`,
  "g",
)

/** Text formats under content/ that can carry a recorded path, the text captures in artifacts/ included. */
const CONTENT_TEXT = /\.(?:json|jsonl|md|txt|ya?ml)$/

interface Finding {
  path: string
  reason: string
}

function walk(dir: string, onFile: (full: string) => void): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, onFile)
    else onFile(full)
  }
}

/** One finding per file: where the first host path starts, never the path itself, which CI logs would republish. */
function scanContent(contentDir: string): Finding[] {
  const findings: Finding[] = []
  walk(contentDir, (full) => {
    if (!CONTENT_TEXT.test(full)) return
    const text = readFileSync(full, "utf-8")
    const matches = [...text.matchAll(HOST_PATH)]
    const first = matches[0]
    if (!first || first.index === undefined) return
    const before = text.slice(0, first.index)
    const line = before.split("\n").length
    const column = first.index - before.lastIndexOf("\n")
    const root = first[0].startsWith("/hh")
      ? "/hh"
      : first[0].startsWith("/home/")
        ? "/home/<account>"
        : "/Users/<account>"
    findings.push({
      path: `content/${relative(contentDir, full)}`,
      reason: `${matches.length} absolute host path(s), the first under ${root} at ${line}:${column} — record a workspace-relative path, or none`,
    })
  })
  return findings
}

let content: string

function write(rel: string, text: string): void {
  const full = join(content, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
}

beforeEach(() => {
  content = mkdtempSync(join(tmpdir(), "terminfo-content-"))
})

afterEach(() => {
  rmSync(content, { recursive: true, force: true })
})

describe("content host-path scan", () => {
  it("flags an estate path in a run file, also inside a stored reply", () => {
    write(
      "probes-libs/run.json",
      JSON.stringify({ runtimeIdentity: { resolvedPath: "/hh/var/wt/seat/node_modules/a/index.js" } }, null, 2),
    )
    const reply = JSON.stringify({ receipt: { url: "file:///hh/var/seat/prep/runner-bundle.tar" } })
    write("probes-apps/run.json", JSON.stringify({ rawReplies: { "collector.disposableOwnership": reply } }))
    const v = scanContent(content)
    expect(v.map((x) => x.path).sort()).toEqual(["content/probes-apps/run.json", "content/probes-libs/run.json"])
    expect(v.every((x) => x.reason.includes("under /hh"))).toBe(true)
    expect(v.find((x) => x.path.includes("probes-libs"))?.reason).toContain("at 3:")
  })

  it("flags the home folder of every account but the runner's", () => {
    write("probes-apps/a.json", JSON.stringify({ config: "--config-file /home/alice/term.conf" }))
    write("probes-apps/b.json", JSON.stringify({ path: "/Users/alice/Library/Caches/x.dmg" }))
    write("probes-apps/c.json", JSON.stringify({ path: "C:/x /home/runneradmin/x" }))
    const v = scanContent(content)
    expect(v.map((x) => x.path).sort()).toEqual([
      "content/probes-apps/a.json",
      "content/probes-apps/b.json",
      "content/probes-apps/c.json",
    ])
    // The finding names where the path starts, never the account it would republish in CI logs.
    expect(v.some((x) => x.reason.includes("alice") || x.reason.includes("runneradmin"))).toBe(false)
  })

  it("allows the runner account, Nix store paths and workspace-relative paths", () => {
    write(
      "probes-apps/run.json",
      JSON.stringify({
        config: "wezterm --config-file /home/runner/wezterm-config.lua",
        sourceArtifact: { path: "/Users/runner/Library/Caches/Homebrew/downloads/x--Ghostty.dmg" },
        loadedBinary: { path: "/nix/store/0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty-0.49.2/bin/kitty" },
        resolvedPath: "node_modules/.bun/ghostty-web@0.4.0/node_modules/ghostty-web/dist/ghostty-web.js",
        osc7: "\u001b]7;file:///tmp\u0007",
      }),
    )
    expect(scanContent(content)).toEqual([])
  })

  it("reads the text captures in artifacts/ and skips images", () => {
    write("artifacts/a.txt", "prompt in /hh/var/seat $ ")
    write("artifacts/b.png", "\u0089PNG /hh/var/seat")
    expect(scanContent(content).map((x) => x.path)).toEqual(["content/artifacts/a.txt"])
  })

  it("the committed content/ tree records no host path", () => {
    expect(scanContent(fileURLToPath(new URL("../content", import.meta.url)))).toEqual([])
  })
})
