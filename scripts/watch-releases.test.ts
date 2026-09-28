/**
 * @failure Monthly release selection admits too-new or undated releases, or trusts a partial feed.
 * @level l1 — checks UTC calendar boundaries and mocked multi-page source responses.
 * @consumer scripts/watch-releases.ts monthly release report and catalog hint.
 * @testonly none
 */

import { describe, expect, it } from "vitest"
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

  it("scans out-of-order pages before choosing the newest eligible stable version", async () => {
    const { fetcher, visited } = pages(
      [release("v1.4.0", "2026-09-01T00:00:00Z")],
      [release("v1.1.0", "2026-07-01T00:00:00Z"), release("v1.3.0", "2026-08-01T00:00:00Z")],
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

  it("refuses a feed that cannot be proven complete within the page bound", async () => {
    const { fetcher } = pages([release("v1.1.0", "2026-08-01T00:00:00Z")], [release("v1.2.0", "2026-08-02T00:00:00Z")])
    await expect(fetchReleaseFeed(source, fetcher, 1)).rejects.toThrow("release feed incomplete after 1 pages")
  })

  it("refuses malformed release records instead of selecting around them", async () => {
    const { fetcher } = pages([release("v1.1.0", "2026-08-01T00:00:00Z"), { tag_name: "v1.2.0" }])
    await expect(fetchReleaseFeed(source, fetcher)).rejects.toThrow("lacks draft/prerelease flags")
  })
})
