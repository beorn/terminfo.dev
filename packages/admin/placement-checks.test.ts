/**
 * #37245: the exact-count downgrade override, the commit message that records it, and the index check that refuses a
 * placement whose cited artifacts are not staged. The downgrade count itself is measured on real corpus data in
 * placement-checks.slow.test.ts.
 *
 * @failure  an inexact or unexplained downgrade override places, or a placement commits without its cited artifacts
 * @level    l2
 * @consumer #37245 placement refusals: the WezTerm placement that shipped without 933, then 208, artifacts
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import type { LoadedRun } from "@terminfo/run-parser"
import {
  checkCitedInIndex,
  checkDowngrades,
  compareServedCells,
  placementCommitMessage,
  stagePlacement,
  type CellChange,
  type CheckedPlacement,
  type DowngradeReport,
} from "./placement-checks.ts"

const dirs: string[] = []
afterEach(() => {
  // raw-delete-allow: dirs holds only this test's own mkdtemp fixture directories
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const cell = (n: number): CellChange => ({ featureId: `feature.${n}`, was: "supported", now: "probe-invalid" })
const report = (downgrades: number, flips: CellChange[] = []): DowngradeReport => ({
  subject: "term:warp@macos",
  before: "term:warp",
  after: "term:warp",
  downgrades: Array.from({ length: downgrades }, (_, n) => cell(n)),
  flips,
})

test("a refusal states its definition, names the first 20 cells and the rest by count, and prints the override", () => {
  expect(() => checkDowngrades("run.json", report(0))).not.toThrow()
  const refusal = (() => {
    try {
      checkDowngrades("run.json", report(74))
    } catch (error) {
      return (error as Error).message
    }
    throw new Error("74 downgrades placed without an override")
  })()
  expect(refusal).toContain("would turn 74 decided cell(s) of term:warp@macos undecided")
  expect(refusal).toContain("decided (supported, unsupported, untestable)")
  expect(refusal).toContain("feature.19 supported -> probe-invalid; and 54 more")
  expect(refusal).not.toContain("feature.20 ")
  expect(refusal).toContain('terminfo place run.json --accept-downgrades 74 --reason "<why>"')
})

test.each([
  [
    "a count one short",
    { count: 73, reason: "known regression" },
    /--accept-downgrades 73 does not match the 74 downgrade/,
  ],
  [
    "a count for a run with none",
    { count: 74, reason: "known" },
    /--accept-downgrades 74 does not match the 0 downgrade/,
  ],
  ["no reason", { count: 74, reason: "  " }, /--accept-downgrades 74 needs --reason/],
])("the override refuses %s: the count must be exact and carry a reason", (label, accept, refusal) => {
  const downgrades = label === "a count for a run with none" ? 0 : 74
  expect(() => checkDowngrades("run.json", report(downgrades), accept)).toThrow(refusal)
})

test("flips are listed, never refused, and an exact accepted count places", () => {
  const flip = { featureId: "sgr.bold", was: "supported", now: "unsupported" }
  expect(() => checkDowngrades("run.json", report(0, [flip]))).not.toThrow()
  expect(() => checkDowngrades("run.json", report(74), { count: 74, reason: "suite rework" })).not.toThrow()
})

// #39206: iTerm2 3.7.9 run ba314701 (no Mac input helper) turned these five served supported cells untestable, and
// placement only listed them as changed values. The reasons are that run's own.
const ITERM2_LOST: Record<string, string> = {
  "modes.application-cursor":
    "Recognized; effect not tested: DECRPM mode 1 returned reset (Ps 2), and application cursor effect needs owned key injection and input readback",
  "modes.bracketed-paste":
    "Recognized; effect not tested: DECRPM mode 2004 returned reset (Ps 2), and bracketed-paste effect needs owned clipboard, key injection and input readback",
  "modes.mouse-all":
    "Recognized; effect not tested: DECRPM mode 1003 returned reset (Ps 2), and all-motion effect needs owned buttonless movement and input readback",
  "modes.mouse-sgr":
    "Recognized; effect not tested: DECRPM mode 1006 returned reset (Ps 2), and SGR mouse effect needs owned click injection and input readback",
  "modes.mouse-tracking":
    "Recognized; effect not tested: DECRPM mode 1000 returned reset (Ps 2), and mouse tracking effect needs owned click injection and input readback",
}

test("a served verdict replaced by untestable is a downgrade naming the run's reason; other decided changes stay flips", () => {
  const before = new Map([
    ...Object.keys(ITERM2_LOST).map((id) => [id, "supported"] as const),
    ["modes.deccolm", "supported"],
    ["text.wide.emoji-flags", "unsupported"],
    ["modes.origin", "untestable"],
  ])
  const after = new Map([
    ...Object.keys(ITERM2_LOST).map((id) => [id, "untestable"] as const),
    ["modes.deccolm", "unsupported"],
    ["text.wide.emoji-flags", "untestable"],
    ["modes.origin", "untestable"],
  ])
  const reasons: Record<string, string> = { ...ITERM2_LOST, "text.wide.emoji-flags": "no grapheme readback" }
  const { downgrades, flips } = compareServedCells(before, after, (id) => reasons[id])
  expect(downgrades.map((c) => c.featureId)).toEqual([...Object.keys(ITERM2_LOST), "text.wide.emoji-flags"])
  expect(flips).toEqual([{ featureId: "modes.deccolm", was: "supported", now: "unsupported" }])

  const iterm2 = { ...report(0), subject: "term:iterm2@macos", downgrades: downgrades.slice(0, 5) }
  const refusal = (() => {
    try {
      checkDowngrades("run.json", iterm2)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error("five lost verdicts placed without an override")
  })()
  expect(refusal).toContain("would turn 5 decided cell(s) of term:iterm2@macos undecided")
  expect(refusal).toContain("or as supported or unsupported without it and untestable with it")
  for (const [id, reason] of Object.entries(ITERM2_LOST)) {
    expect(refusal).toContain(`${id} supported -> untestable (${reason})`)
  }
  expect(refusal).toContain('terminfo place run.json --accept-downgrades 5 --reason "<why>"')
  expect(() => checkDowngrades("run.json", iterm2, { count: 5, reason: "no Mac input helper (#39120)" })).not.toThrow()
  expect(placementCommitMessage(placementOf(iterm2, { count: 5, reason: "no helper" }))).toContain(
    `- modes.mouse-sgr: supported -> untestable (${ITERM2_LOST["modes.mouse-sgr"]})`,
  )
})

function placementOf(
  rep: DowngradeReport,
  accepted: CheckedPlacement["accepted"],
  extra: Partial<CheckedPlacement> = {},
): CheckedPlacement {
  const loaded = {
    runId: "e2e953e124e6648be106e4d898790d18",
    subject: { kind: "term", id: "warp", version: "v1", os: "macos" },
    screenshotRefs: [],
    textSnapshotRefs: [],
  } as unknown as LoadedRun
  return {
    prepared: { loaded, contentDir: "content" } as CheckedPlacement["prepared"],
    written: { destination: "", paths: [] },
    report: rep,
    accepted,
    ...extra,
  }
}

test("the commit message records an accepted downgrade as trailers and lists every downgraded and flipped cell", () => {
  const flip = { featureId: "sgr.bold", was: "supported", now: "unsupported" }
  const message = placementCommitMessage(placementOf(report(2, [flip]), { count: 2, reason: "suite\nrework" }))
  expect(message.split("\n")[0]).toBe("data(terminfo): place warp v1 macos run e2e953e124e6648be106e4d898790d18")
  expect(message).toContain("- feature.0: supported -> probe-invalid\n- feature.1: supported -> probe-invalid")
  expect(message).toContain("Changed decided values (listed, not refused):\n- sgr.bold: supported -> unsupported")
  expect(message.trimEnd().split("\n").slice(-2)).toEqual(["Accepted-Downgrades: 2", "Downgrade-Reason: suite rework"])

  const clean = placementCommitMessage(placementOf(report(0), null))
  expect(clean).not.toMatch(/Accepted-Downgrades|Downgrade-Reason|Downgraded cells/)
})

/** A scratch repository with one committed file and an unrelated change, as a seat's tree usually has. */
function scratchRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "placement-index-"))
  dirs.push(repo)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
  git("init", "-q")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "test")
  mkdirSync(join(repo, "content", "artifacts"), { recursive: true })
  writeFileSync(join(repo, "notes.txt"), "committed\n")
  git("add", "notes.txt")
  git("commit", "-q", "-m", "init")
  writeFileSync(join(repo, "notes.txt"), "an unrelated edit nobody asked placement to stage\n")
  return repo
}

const ref = (c: string) => `sha256:${c.repeat(64)}`

test("placement stages exactly what it wrote, and refuses while any cited artifact is only on disk", () => {
  const repo = scratchRepo()
  const content = join(repo, "content")
  const written = [join(content, "artifacts", `${"a".repeat(64)}.png`), join(content, "run.json")]
  for (const path of written) writeFileSync(path, "x")
  // Cited but not written by this placement: on disk, untracked. An existence check passes it; the index does not.
  writeFileSync(join(content, "artifacts", `${"b".repeat(64)}.png`), "x")
  const placement = placementOf(report(0), null, { written: { destination: written[1] as string, paths: written } })
  placement.prepared = {
    ...placement.prepared,
    contentDir: content,
    loaded: { ...placement.prepared.loaded, screenshotRefs: [ref("a"), ref("b")] } as LoadedRun,
  }

  expect(() => stagePlacement(repo, placement)).toThrow(
    new RegExp(
      `1 of the 2 artifact\\(s\\) this run cites are not in the git index: content/artifacts/${"b".repeat(64)}\\.png\\. ` +
        `This placement wrote and staged 2 path\\(s\\); to unstage them \\(the files stay\\): git -C ${repo} reset -q -- ` +
        `content/artifacts/${"a".repeat(64)}\\.png content/run\\.json`,
    ),
  )
  const staged = () => execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" })
  expect(staged().trim().split("\n")).toEqual([`content/artifacts/${"a".repeat(64)}.png`, "content/run.json"])

  // Once the cited artifact is staged too, placement prints a commit with no pathspec and the unrelated edit stays out.
  execFileSync("git", ["add", "--", `content/artifacts/${"b".repeat(64)}.png`], { cwd: repo })
  const { messageFile, command } = stagePlacement(repo, placement)
  expect(command).toBe(`git -C ${repo} commit -F ${messageFile}`)
  expect(readFileSync(messageFile, "utf8")).toMatch(/^data\(terminfo\): place warp v1 macos run /)
  expect(staged()).not.toContain("notes.txt")
})

test("the index check reads text snapshots as well as screenshots, and a run citing nothing passes", () => {
  const repo = scratchRepo()
  const content = join(repo, "content")
  const run = { screenshotRefs: [], textSnapshotRefs: [ref("c")] }
  expect(() => checkCitedInIndex(repo, content, run)).toThrow(`content/artifacts/${"c".repeat(64)}.txt`)
  expect(() => checkCitedInIndex(repo, content, { screenshotRefs: [], textSnapshotRefs: [] })).not.toThrow()
})
