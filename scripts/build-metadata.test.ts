import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildStamp, createBuildMetadata } from "./build-metadata.ts"

let repo: string

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "terminfo-build-"))
  git("init", "-q")
  writeFileSync(join(repo, "index.md"), "# site\n")
  git("add", "index.md")
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "site source")
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe("website build identity", () => {
  it("binds one clean GitHub build to the owning source commit and run", () => {
    const sha = git("rev-parse", "HEAD")
    const result = createBuildMetadata(
      repo,
      {
        GITHUB_ACTIONS: "true",
        GITHUB_WORKSPACE: repo,
        GITHUB_SHA: sha,
        GITHUB_RUN_ID: "36453006753",
        GITHUB_RUN_ATTEMPT: "1",
      },
      new Date("2026-09-28T20:00:00.000Z"),
    )
    expect(result).toEqual({
      sourceCommit: sha,
      dirty: false,
      context: "github",
      builtAt: "2026-09-28T20:00:00.000Z",
      githubRun: { id: "36453006753", attempt: 1 },
    })
    expect(buildStamp(result)).toContain("GitHub run 36453006753/1")
  })

  it("refuses a mismatched CI commit and marks dirty local builds", () => {
    const sha = git("rev-parse", "HEAD")
    expect(() =>
      createBuildMetadata(repo, {
        GITHUB_ACTIONS: "true",
        GITHUB_WORKSPACE: repo,
        GITHUB_SHA: sha,
        GITHUB_RUN_ID: "1",
      }),
    ).toThrow(/GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT/)
    expect(() =>
      createBuildMetadata(repo, {
        GITHUB_ACTIONS: "true",
        GITHUB_WORKSPACE: repo,
        GITHUB_SHA: "0".repeat(40),
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
      }),
    ).toThrow(/differs from terminfo.dev HEAD/)
    writeFileSync(join(repo, "index.md"), "# changed\n")
    const local = createBuildMetadata(repo, {})
    expect(local.context).toBe("local")
    expect(local.dirty).toBe(true)
    expect(buildStamp(local)).toContain("local changes")
  })
})
