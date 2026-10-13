import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"

export interface BuildMetadata {
  sourceCommit: string
  /**
   * The CODE gitlink this build was made for — the `vendor/terminfo.dev` submodule pin of the landing the caller
   * built from (28620). A landing build reads this from its own HEAD, which IS the pin, but the field is named and
   * supplied by the caller through `TERMINFO_SITE_CODE_GITLINK` so the served dist says which CODE pin produced it
   * instead of leaving a reader to infer it from `sourceCommit` "equalling the gitlink by coincidence of where it
   * was built". `null` for a build outside a CODE landing (CI, a bare developer checkout).
   */
  codeGitlink: string | null
  dirty: boolean
  context: "local" | "github"
  builtAt: string
  githubRun: { id: string; attempt: number } | null
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim()
}

/**
 * The CODE gitlink the caller built for, read from `TERMINFO_SITE_CODE_GITLINK`. Absent means "this build is not
 * serving a CODE landing" and is recorded as `null`; a present-but-malformed value is a caller bug and throws, so a
 * broken pin never reaches the stamp as a plausible-looking string (NO SILENT ERRORS).
 */
function codeGitlinkFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env["TERMINFO_SITE_CODE_GITLINK"]?.trim()
  if (!raw) return null
  if (!/^[0-9a-f]{40}$/.test(raw)) {
    throw new Error(`Invalid TERMINFO_SITE_CODE_GITLINK: ${raw}`)
  }
  return raw
}

/** Identity of the owning terminfo.dev checkout, measured once per site build. */
export function createBuildMetadata(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): BuildMetadata {
  const sourceCommit = git(repoRoot, "rev-parse", "HEAD")
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error(`Invalid terminfo.dev source commit: ${sourceCommit}`)
  }
  const codeGitlink = codeGitlinkFromEnv(env)
  const dirty = git(repoRoot, "status", "--porcelain", "--untracked-files=normal") !== ""
  const builtAt = now.toISOString()
  const ownedGitHubBuild =
    env.GITHUB_ACTIONS === "true" &&
    typeof env.GITHUB_WORKSPACE === "string" &&
    realpathSync(env.GITHUB_WORKSPACE) === realpathSync(repoRoot)

  if (!ownedGitHubBuild) {
    return { sourceCommit, codeGitlink, dirty, context: "local", builtAt, githubRun: null }
  }
  if (env.GITHUB_SHA !== sourceCommit) {
    throw new Error(
      `GitHub source commit ${env.GITHUB_SHA ?? "(missing)"} differs from terminfo.dev HEAD ${sourceCommit}`,
    )
  }
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")) {
    throw new Error("GitHub site build requires valid GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT")
  }
  if (dirty) {
    throw new Error("GitHub site build has uncommitted or untracked source files")
  }
  return {
    sourceCommit,
    codeGitlink,
    dirty,
    context: "github",
    builtAt,
    githubRun: { id: env.GITHUB_RUN_ID!, attempt: Number(env.GITHUB_RUN_ATTEMPT) },
  }
}

export function buildStamp(metadata: BuildMetadata): string {
  const source = metadata.sourceCommit.slice(0, 10)
  const origin = metadata.githubRun
    ? `GitHub run ${metadata.githubRun.id}/${metadata.githubRun.attempt}`
    : metadata.dirty
      ? "local changes"
      : "local build"
  return `Site build ${source} · ${metadata.builtAt} · ${origin}`
}
