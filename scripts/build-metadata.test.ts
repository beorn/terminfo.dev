/**
 * @failure A website build labels the wrong source, drops sidebar metadata, or deployment accepts stale live identity.
 * @level l1 — real Git producer and actual deployment shell against isolated HTTP responses.
 * @consumer docs/.vitepress/config.ts metadata and .github/workflows/deploy.yml live readback.
 * @testonly none
 */

import { execFile, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
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
  it("accepts only the exact validated clean CI build from the deployed HTTP endpoint", async () => {
    const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
    const workflow = readFileSync(join(siteRoot, ".github/workflows/deploy.yml"), "utf8")
    const block = workflow.match(
      /      - name: Verify live build identity\n        shell: bash\n        run: \|\n([\s\S]*?)(?=\n      - |$)/,
    )?.[1]
    expect(block, "deployment must verify the actual live build after Wrangler").toBeDefined()
    const sha = git("rev-parse", "HEAD")
    const metadata = {
      sourceCommit: sha,
      dirty: false,
      context: "github",
      builtAt: "2026-10-02T12:00:00.000Z",
      githubRun: { id: "42", attempt: 2 },
    }
    const path = join(repo, "docs/.vitepress/dist/api/v1")
    mkdirSync(path, { recursive: true })
    let response = JSON.stringify(metadata)
    let status = 200
    const server = createServer((_request, reply) => {
      reply.writeHead(status, { "content-type": "application/json" })
      reply.end(response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("HTTP fixture has no TCP address")
      const shell = block!
        .replace(/^          /gm, "")
        .replace("https://terminfo.dev/api/v1/build.json", `http://127.0.0.1:${address.port}/api/v1/build.json`)
      const cases = [
        ["matching", metadata, 200, "Verified live build identity", false],
        ["rerun", metadata, 200, "Verified live build identity", false],
        ["commit", { ...metadata, sourceCommit: "0".repeat(40) }, 200, "differs from validated archive", false],
        ["run", { ...metadata, githubRun: { id: "43", attempt: 2 } }, 200, "differs from validated archive", false],
        ["attempt", { ...metadata, githubRun: { id: "42", attempt: 3 } }, 200, "differs from validated archive", false],
        [
          "timestamp",
          { ...metadata, builtAt: "2026-10-01T12:00:00.000Z" },
          200,
          "differs from validated archive",
          false,
        ],
        ["dirty", { ...metadata, dirty: true }, 200, "not this clean GitHub build", true],
        ["context", { ...metadata, context: "local" }, 200, "not this clean GitHub build", true],
        ["malformed", "{", 200, "Cannot verify live build identity", false],
        ["HTTP404", metadata, 404, "404", false],
      ] as const
      for (const [name, value, code, diagnostic, invalidArchive] of cases) {
        response = typeof value === "string" ? value : JSON.stringify(value)
        status = code
        writeFileSync(join(path, "build.json"), JSON.stringify(invalidArchive ? value : metadata))
        let exitCode = 0
        let output = ""
        try {
          const result = await promisify(execFile)("bash", ["-c", shell], {
            cwd: repo,
            env: {
              ...process.env,
              GITHUB_SHA: sha,
              GITHUB_RUN_ID: "42",
              GITHUB_RUN_ATTEMPT: name === "rerun" ? "3" : "2",
            },
            timeout: 5_000,
          })
          output = result.stdout + result.stderr
        } catch (error) {
          const failure = error as Error & { code: number; stdout: string; stderr: string }
          exitCode = failure.code
          output = failure.stdout + failure.stderr
        }
        if (name === "matching" || name === "rerun") expect(exitCode, name).toBe(0)
        else expect(exitCode, name).not.toBe(0)
        expect(output, name).toContain(diagnostic)
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

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
