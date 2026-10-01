/**
 * @failure A website build labels the wrong source or silently drops required sidebar metadata.
 * @level l1 — measures build identity against an isolated real Git checkout.
 * @consumer docs/.vitepress/config.ts build footer, sidebar metadata, and emitted build metadata.
 * @testonly none
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
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

describe("website sidebar metadata", () => {
  const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

  it.each([
    ["features", "features.json"],
    ["terminals", 'terminal "ghostty" requires a nonempty label'],
  ])("rejects malformed %s metadata during config evaluation", (kind, expected) => {
    const script = `
      import * as fs from "node:fs";
      import { mock } from "bun:test";
      const read = fs.readFileSync;
      mock.module("node:fs", () => ({
        ...fs,
        readFileSync: (path, ...args) => {
          const value = read(path, ...args);
          if (${JSON.stringify(kind)} === "features" && String(path).endsWith("/content/features.json")) return "{";
          if (${JSON.stringify(kind)} === "terminals" && String(path).endsWith("/content/terminals.json")) {
            const data = JSON.parse(String(value));
            delete data.ghostty.label;
            return JSON.stringify(data);
          }
          return value;
        },
      }));
      try {
        await import("./docs/.vitepress/config.ts");
        throw new Error("config accepted malformed metadata");
      } catch (error) {
        if (!String(error.message).includes(${JSON.stringify(expected)})) throw error;
        console.log(error.message);
      }
    `
    expect(
      execFileSync(process.execPath, ["-e", script], { cwd: siteRoot, encoding: "utf8", timeout: 10_000 }),
    ).toContain(expected)
  })
})
