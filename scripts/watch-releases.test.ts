/**
 * @failure Release refresh trusts unreviewed raw versions, too-new/undated releases, or a partial feed.
 * @level l2 — CLI comparison with reviewed app rows, plus UTC cutoff and source-response checks.
 * @consumer scripts/watch-releases.ts monthly release report and catalog hint.
 * @testonly none
 */

import { describe, expect, it } from "vitest"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { calendarMonthCutoff, fetchReleaseFeed, selectEligibleRelease, type ReleaseSource } from "./watch-releases.ts"

const source: ReleaseSource = {
  terminal: "example",
  label: "Example",
  type: "github",
  apiUrl: "https://api.github.com/repos/example/terminal/releases",
}

function release(tag: string, publishedAt: string | null, prerelease = false) {
  return {
    tag_name: tag,
    published_at: publishedAt,
    draft: false,
    prerelease,
    html_url: "https://github.com/example/terminal/releases/tag/" + tag,
  }
}

function pages(...data: unknown[][]) {
  const visited: number[] = []
  const fetcher = async (url: string): Promise<Response> => {
    const page = Number(new URL(url).searchParams.get("page"))
    visited.push(page)
    return new Response(JSON.stringify(data[page - 1] ?? []), { status: 200 })
  }
  return { fetcher, visited }
}

describe("monthly release cutoff", () => {
  it("clamps month ends and keeps the exact UTC time across leap years and January", () => {
    expect(calendarMonthCutoff(new Date("2025-03-31T12:34:56.789Z")).toISOString()).toBe("2025-02-28T12:34:56.789Z")
    expect(calendarMonthCutoff(new Date("2024-03-31T12:34:56.789Z")).toISOString()).toBe("2024-02-29T12:34:56.789Z")
    expect(calendarMonthCutoff(new Date("2025-01-31T12:34:56.789Z")).toISOString()).toBe("2024-12-31T12:34:56.789Z")
  })

  it("includes a release published exactly at the cutoff and excludes one a millisecond later", async () => {
    const { fetcher } = pages(
      [release("v1.3.0", "2026-08-28T20:00:00.001Z"), release("v1.2.0", "2026-08-28T20:00:00.000Z")],
      [],
    )
    const candidates = await fetchReleaseFeed(source, fetcher)
    const selection = selectEligibleRelease(candidates, new Date("2026-08-28T20:00:00.000Z"))
    expect(selection.selected?.version).toBe("1.2.0")
    expect(selection.candidates[0]?.excluded).toContain("published after cutoff")
    expect(selection.candidates[1]?.excluded).toEqual([])
  })

  it("normalizes Codeberg's offset publication instant before applying the UTC cutoff", async () => {
    // Codeberg foot 1.28.0 reports 2026-09-02T13:02:54+02:00, or 11:02:54Z.
    const foot: ReleaseSource = {
      terminal: "foot",
      label: "foot",
      type: "codeberg",
      apiUrl: "https://codeberg.org/api/v1/repos/dnkl/foot/releases",
    }
    const { fetcher } = pages(
      [
        {
          ...release("1.28.0", "2026-09-02T13:02:54+02:00"),
          html_url: "https://codeberg.org/dnkl/foot/releases/tag/1.28.0",
        },
      ],
      [],
    )
    const candidates = await fetchReleaseFeed(foot, fetcher)
    expect(candidates[0]?.publishedAt).toBe("2026-09-02T11:02:54.000Z")
    expect(selectEligibleRelease(candidates, new Date("2026-09-02T11:02:54.000Z")).selected?.tag).toBe("1.28.0")
    expect(selectEligibleRelease(candidates, new Date("2026-09-02T11:02:53.999Z")).selected).toBeNull()
    const invalid = pages([{ ...release("1.28.1", "2026-02-30T13:02:54+02:00") }], [])
    await expect(fetchReleaseFeed(foot, invalid.fetcher)).rejects.toThrow(/foot: invalid publication time for 1\.28\.1/)
  })

  it("scans out-of-order pages and old version schemes before choosing the latest eligible release", async () => {
    const { fetcher, visited } = pages(
      [release("v1.4.0", "2026-09-01T00:00:00Z")],
      [
        release("v1.1.0", "2026-07-01T00:00:00Z"),
        release("v1.3.0", "2026-08-01T00:00:00Z"),
        // Windows Terminal's old 1904.29002 tag must not outrank its current v1.x releases.
        release("1904.29002", "2019-04-29T22:17:37Z"),
      ],
      [],
    )
    const candidates = await fetchReleaseFeed(source, fetcher)
    expect(visited).toEqual([1, 2, 3])
    expect(selectEligibleRelease(candidates, new Date("2026-08-28T00:00:00Z")).selected?.version).toBe("1.3.0")
  })

  it("names prerelease, fork, and undated exclusions", async () => {
    const { fetcher } = pages(
      [
        release("v1.5.0-rc.1", "2026-08-01T00:00:00Z", true),
        release("v1.4.0-fork.1", "2026-08-01T00:00:00Z"),
        release("v1.3.0", null),
      ],
      [],
    )
    const candidates = await fetchReleaseFeed(source, fetcher)
    expect(selectEligibleRelease(candidates, new Date("2026-08-28T00:00:00Z")).selected).toBeNull()
    expect(candidates.map((candidate) => candidate.excluded)).toEqual([
      ["prerelease channel"],
      ["fork channel"],
      ["missing publication time"],
    ])
  })

  it("treats a tag-only source as undated and links to the tag itself", async () => {
    const tags: ReleaseSource = {
      terminal: "example",
      label: "Example",
      type: "github-tags",
      apiUrl: "https://api.github.com/repos/example/terminal/tags",
    }
    const { fetcher } = pages([{ name: "v1.3.0" }], [])
    const candidates = await fetchReleaseFeed(tags, fetcher)
    expect(candidates[0]?.excluded).toEqual(["undated tag feed"])
    expect(candidates[0]?.sourceUrl).toBe("https://github.com/example/terminal/tree/v1.3.0")
  })

  it("refuses a feed that cannot be proven complete within the page bound", async () => {
    const { fetcher } = pages([release("v1.1.0", "2026-08-01T00:00:00Z")], [release("v1.2.0", "2026-08-02T00:00:00Z")])
    await expect(fetchReleaseFeed(source, fetcher, 1)).rejects.toThrow("release feed incomplete after 1 pages")
  })

  it("refuses malformed release records instead of selecting around them", async () => {
    const { fetcher } = pages([release("v1.1.0", "2026-08-01T00:00:00Z"), { tag_name: "v1.2.0" }])
    await expect(fetchReleaseFeed(source, fetcher)).rejects.toThrow("lacks draft/prerelease flags")
  })
})

describe("release watch consumer", () => {
  it("compares the eligible release with reviewed app evidence, never raw or same-ID headless", () => {
    const root = mkdtempSync(join(tmpdir(), "terminfo-release-watch-"))
    try {
      mkdirSync(join(root, "scripts"))
      mkdirSync(join(root, "docs", "data"), { recursive: true })
      mkdirSync(join(root, "content", "probes-apps"), { recursive: true })
      copyFileSync(join(import.meta.dirname, "watch-releases.ts"), join(root, "scripts", "watch-releases.ts"))
      writeFileSync(
        join(root, "content", "probes-apps", "kitty-0.99-linux.json"),
        JSON.stringify({ backend: "kitty", version: "0.99" }),
      )
      writeFileSync(
        join(root, "docs", "data", "current-results.ts"),
        `
        const app = { target: { kind: "app", id: "kitty", version: process.env.TEST_REVIEWED_APP_VERSION }, runId: "reviewed-kitty", sha256: "${"a".repeat(64)}" }
        const headless = { target: { kind: "headless", id: "kitty", version: "0.99" }, runId: "reviewed-parser", sha256: "${"b".repeat(64)}" }
        export function loadCurrentResults() { return { projection: { current: { "app:kitty": app, "headless:kitty": headless } } } }
        export function compatibilityTargets() { return new Map([
          ["kitty", { contextKey: "headless:kitty", selected: headless }],
          ...(!process.env.NO_REVIEWED_APP ? [["app-kitty", { contextKey: "app:kitty", selected: app }]] : []),
        ]) }
      `,
      )
      const preload = join(root, "feed.ts")
      writeFileSync(
        preload,
        `
        globalThis.fetch = async (url) => new Response(JSON.stringify(
          url.includes("/kitty/") && new URL(url).searchParams.get("page") === "1"
            ? [
                ["v0.49.1", "2026-08-01T00:00:00Z"], ["v0.46.2", "2026-07-01T00:00:00Z"],
                ["1904.29002", "2019-04-29T22:17:37Z"], ["v0.50.0", "2026-09-01T00:00:00Z"],
              ].map(([tag, date]) => ({ tag_name: tag, published_at: date, draft: false, prerelease: false,
                html_url: "https://github.com/kovidgoyal/kitty/releases/tag/" + tag }))
            : []), { status: 200 })
      `,
      )
      const watch = (currentVersion: string | null = "0.46.2", expectedStatus = 0) => {
        const result = spawnSync(
          process.execPath,
          ["--preload", preload, join(root, "scripts", "watch-releases.ts"), "--json", "--at", "2026-09-28T20:00:00Z"],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NO_REVIEWED_APP: currentVersion === null ? "1" : "",
              TEST_REVIEWED_APP_VERSION: currentVersion ?? "",
            },
          },
        )
        expect(result.status).toBe(expectedStatus)
        return (JSON.parse(result.stdout) as Array<Record<string, unknown>>).find((row) => row.terminal === "kitty")
      }
      expect(watch()).toMatchObject({
        runAt: "2026-09-28T20:00:00.000Z",
        cutoff: "2026-08-28T20:00:00.000Z",
        currentVersion: "0.46.2",
        latestVersion: "0.49.1",
        disposition: "new-release",
        currentEvidence: { contextKey: "app:kitty", runId: "reviewed-kitty", sha256: "a".repeat(64) },
        selectedCandidate: { tag: "v0.49.1" },
      })
      expect(watch(null)).toMatchObject({
        currentVersion: null,
        disposition: "no-reviewed-current",
        isNewer: false,
      })
      expect(watch("1904.29002")).toMatchObject({ disposition: "new-release", isNewer: true })
      expect(watch("0.49.1")).toMatchObject({ disposition: "up-to-date", isNewer: false })
      expect(watch("0.50.0")).toMatchObject({ disposition: "newer-than-eligible", isNewer: false })
      expect(watch("0.47.0", 1)).toMatchObject({
        disposition: "comparison-unresolved",
        isNewer: false,
        currentEvidence: { runId: "reviewed-kitty" },
        error: expect.stringContaining("0.47.0"),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
