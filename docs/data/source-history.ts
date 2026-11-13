/**
 * The terminfo repository's own history, read at the source revisions runs recorded (33587, @cto d805d1af).
 *
 * The site's context pick and per-row join compare two runs by their `sourceRevision`: which one descends
 * from the other, and whether the probe-defs file that defines a row is byte-equal at both. The build reads
 * these from git, the way packages/admin/versions.ts already reads HEAD; the deploy and validate checkouts
 * fetch full history (`fetch-depth: 0`). A revision this repository cannot read throws by name: a pick or a
 * join never guesses past a missing history.
 */
import { execFileSync } from "node:child_process"
import { join } from "node:path"

export interface SourceHistory {
  /** True when `ancestor` is `descendant` or one of its ancestors. Throws when either revision is unreadable. */
  isAncestor(ancestor: string, descendant: string): boolean
  /** The blob id of `path` at `revision`, or null when that revision has no such file. */
  blobId(revision: string, path: string): string | null
  /** The text of `path` at `revision`, or null when that revision has no such file. */
  text(revision: string, path: string): string | null
}

const REPO_ROOT = join(import.meta.dirname, "..", "..")
const REVISION = /^[0-9a-f]{40}$/

function requireRevision(revision: string): void {
  if (!REVISION.test(revision)) throw new Error(`Source revision ${JSON.stringify(revision)} is not a full commit id`)
}

/** Git-backed history of this repository; every answer is memoized for the process. */
export function gitSourceHistory(repoRoot: string = REPO_ROOT): SourceHistory {
  const git = (args: string[]): { ok: boolean; out: string; err: string } => {
    try {
      return { ok: true, out: execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }), err: "" }
    } catch (cause) {
      const failure = cause as { status?: number; stderr?: string }
      return { ok: false, out: "", err: `${failure.stderr ?? ""}`.trim() || `exit ${failure.status ?? "unknown"}` }
    }
  }
  const known = new Set<string>()
  const requireCommit = (revision: string): void => {
    requireRevision(revision)
    if (known.has(revision)) return
    const probe = git(["cat-file", "-e", `${revision}^{commit}`])
    if (!probe.ok) {
      throw new Error(
        `Source revision ${revision} is not in ${repoRoot}; a full-history checkout is required (${probe.err})`,
      )
    }
    known.add(revision)
  }
  const ancestry = new Map<string, boolean>()
  const blobs = new Map<string, string | null>()
  const texts = new Map<string, string | null>()
  const blobId = (revision: string, path: string): string | null => {
    const key = `${revision}:${path}`
    if (blobs.has(key)) return blobs.get(key) ?? null
    requireCommit(revision)
    const listed = git(["ls-tree", revision, "--", path])
    if (!listed.ok) throw new Error(`git ls-tree ${key} failed: ${listed.err}`)
    const match = /^\d+ blob ([0-9a-f]{40})\t/.exec(listed.out)
    const id = match?.[1] ?? null
    blobs.set(key, id)
    return id
  }
  return {
    isAncestor(ancestor, descendant) {
      const key = `${ancestor}..${descendant}`
      const memo = ancestry.get(key)
      if (memo !== undefined) return memo
      requireCommit(ancestor)
      requireCommit(descendant)
      const result = git(["merge-base", "--is-ancestor", ancestor, descendant])
      // --is-ancestor exits 1 for "no"; any other failure is an unreadable history, never a "no".
      if (!result.ok && result.err !== "exit 1") throw new Error(`git merge-base ${key} failed: ${result.err}`)
      ancestry.set(key, result.ok)
      return result.ok
    },
    blobId,
    text(revision, path) {
      const key = `${revision}:${path}`
      if (texts.has(key)) return texts.get(key) ?? null
      const id = blobId(revision, path)
      const body = id === null ? null : git(["cat-file", "blob", id])
      if (body && !body.ok) throw new Error(`git cat-file ${key} failed: ${body.err}`)
      const value = body ? body.out : null
      texts.set(key, value)
      return value
    },
  }
}

const PROBE_DEFS = "packages/probe-defs/src"
const REGISTRY = `${PROBE_DEFS}/index.ts`

/**
 * The probe-defs file that defines `featureId` at `revision`, read from that revision's registration: ALL_PROBES
 * in packages/probe-defs/src/index.ts spreads one family table per feature-id prefix, imported as
 * `import { <prefix>Probes } from "./<file>.ts"`. The file is the module that table is imported from.
 * Returns the path, or a refusal naming why that revision registers no such family.
 */
export function definingFile(
  history: SourceHistory,
  revision: string,
  featureId: string,
): { path: string } | { refused: string } {
  const family = featureId.split(".")[0]
  if (!family || family === featureId) return { refused: `row ${featureId} has no family prefix` }
  const registry = history.text(revision, REGISTRY)
  if (registry === null) return { refused: `${REGISTRY} is absent at ${revision.slice(0, 12)}` }
  const imports = registry.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([\w.-]+\.ts)"/g)
  const owners = [...imports].filter(([, names]) =>
    (names ?? "").split(",").some((name) => name.trim() === `${family}Probes`),
  )
  if (
    owners.length !== 1 ||
    !owners[0]?.[2] ||
    !new RegExp(`\\.\\.\\.${family}Probes\\b|\\b${family}Probes\\.filter`).test(registry)
  ) {
    return {
      refused: `${REGISTRY} at ${revision.slice(0, 12)} registers ${owners.length} modules for ${family}Probes, not one spread into ALL_PROBES`,
    }
  }
  return { path: `${PROBE_DEFS}/${owners[0][2]}` }
}

/**
 * Why the file defining `featureId` is not byte-equal at the two revisions, or null when it is. Equal revisions
 * are trivially equal and read nothing.
 */
export function definitionDiffers(
  history: SourceHistory,
  featureId: string,
  left: string,
  right: string,
): string | null {
  if (left === right) return null
  const leftFile = definingFile(history, left, featureId)
  if ("refused" in leftFile) return leftFile.refused
  const rightFile = definingFile(history, right, featureId)
  if ("refused" in rightFile) return rightFile.refused
  if (leftFile.path !== rightFile.path) {
    return `row ${featureId} is defined in ${leftFile.path} at ${left.slice(0, 12)} but ${rightFile.path} at ${right.slice(0, 12)}`
  }
  const leftBlob = history.blobId(left, leftFile.path)
  const rightBlob = history.blobId(right, rightFile.path)
  if (leftBlob === null || rightBlob === null || leftBlob !== rightBlob) {
    return `${leftFile.path} differs between ${left.slice(0, 12)} and ${right.slice(0, 12)}`
  }
  return null
}
