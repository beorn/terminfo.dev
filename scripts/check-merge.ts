#!/usr/bin/env bun
/**
 * Pre-merge gate for vendor/terminfo.dev (operator-approved, @cto 9768f1cf):
 * 1. Fails loudly if YRD_BASE_SHA or YRD_CANDIDATE_SHA is missing (never skips).
 * 2. Fast-skips (exit 0) when vendor/terminfo.dev did not change between base and candidate.
 * 3. Verifies every stored probe run's sourceRevision exists in the git object store and is an ancestor of HEAD.
 * 4. Runs the real full site build under the 20 GiB gate-task-guard into an owned scratch dir
 *    (removed in finally even on failure), plus check-private-leak and check-404s.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export type ExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => CommandResult

const defaultExec: ExecFn = (cmd, args, opts) => {
  const res: SpawnSyncReturns<string> = spawnSync(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  })
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
  }
}

export interface SourceHistoryFailure {
  file: string
  sourceRevision: string
  reason: string
}

/** Check that every stored probe JSON under content/probes-* names a sourceRevision fetched and reachable from HEAD. */
export function checkStoredRunSourceHistory(
  terminfoRoot: string,
  exec: ExecFn = defaultExec,
): { checked: number; failures: SourceHistoryFailure[] } {
  const contentDir = join(terminfoRoot, "content")
  const probeDirs = readdirSync(contentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("probes-"))
    .map((entry) => entry.name)
    .sort()

  const revCache = new Map<string, string | null>()
  const failures: SourceHistoryFailure[] = []
  let checked = 0

  const verifyRev = (rev: string): string | null => {
    if (revCache.has(rev)) return revCache.get(rev) ?? null
    const cat = exec("git", ["-C", terminfoRoot, "cat-file", "-e", `${rev}^{commit}`], {})
    if (cat.status !== 0) {
      const msg = "not fetched (commit missing from git object store)"
      revCache.set(rev, msg)
      return msg
    }
    const anc = exec("git", ["-C", terminfoRoot, "merge-base", "--is-ancestor", rev, "HEAD"], {})
    if (anc.status !== 0) {
      const msg = "not an ancestor of HEAD"
      revCache.set(rev, msg)
      return msg
    }
    revCache.set(rev, null)
    return null
  }

  for (const dir of probeDirs) {
    const absDir = join(contentDir, dir)
    const files = readdirSync(absDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
    for (const f of files) {
      const relPath = join("content", dir, f)
      const parsed = JSON.parse(readFileSync(join(absDir, f), "utf8")) as { sourceRevision?: unknown }
      checked++
      const rev = typeof parsed.sourceRevision === "string" ? parsed.sourceRevision.trim() : ""
      if (!rev) {
        failures.push({ file: relPath, sourceRevision: "<missing>", reason: "missing sourceRevision field" })
        continue
      }
      const err = verifyRev(rev)
      if (err !== null) {
        failures.push({ file: relPath, sourceRevision: rev, reason: err })
      }
    }
  }
  return { checked, failures }
}

export interface MergeCheckOptions {
  terminfoRoot: string
  superRoot: string
  env: NodeJS.ProcessEnv
  exec?: ExecFn
  log?: (line: string) => void
  maxRssMib?: number
}

export function runTerminfoMergeCheck(options: MergeCheckOptions): {
  skipped: boolean
  checkedRuns: number
  peakRssLine?: string
} {
  const exec = options.exec ?? defaultExec
  const log = options.log ?? ((line: string) => console.log(line))
  const baseSha = options.env["YRD_BASE_SHA"]?.trim()
  const candidateSha = options.env["YRD_CANDIDATE_SHA"]?.trim()
  if (!baseSha || !candidateSha) {
    throw new Error(
      `terminfo check:merge requires both YRD_BASE_SHA and YRD_CANDIDATE_SHA (got base=${JSON.stringify(baseSha ?? "")}, candidate=${JSON.stringify(candidateSha ?? "")})`,
    )
  }

  const diff = exec(
    "git",
    ["-C", options.superRoot, "diff", "--name-only", baseSha, candidateSha, "--", "vendor/terminfo.dev"],
    {},
  )
  if (diff.status !== 0) {
    throw new Error(`terminfo check:merge: git diff failed: ${diff.stderr.trim() || diff.stdout.trim()}`)
  }
  if (diff.stdout.trim().length === 0) {
    log("terminfo check:merge: vendor/terminfo.dev unchanged; skipping build")
    return { skipped: true, checkedRuns: 0 }
  }

  const history = checkStoredRunSourceHistory(options.terminfoRoot, exec)
  if (history.failures.length > 0) {
    const details = history.failures
      .map((f) => `  - ${f.file}: sourceRevision=${f.sourceRevision} (${f.reason})`)
      .join("\n")
    throw new Error(
      `terminfo check:merge: ${history.failures.length} probe run(s) failed source-history check:\n${details}`,
    )
  }
  log(`terminfo check:merge: source-history check passed (${history.checked} probe runs reachable from HEAD)`)

  const scratchBase = options.env["TMPDIR"] || tmpdir()
  const scratchDir = mkdtempSync(join(scratchBase, "terminfo-merge-check-"))
  const maxRssMib = options.maxRssMib ?? 20480
  const guardPath = join(options.superRoot, "tools", "gate-task-guard.ts")
  if (!existsSync(guardPath)) {
    rmSync(scratchDir, { recursive: true, force: true })
    throw new Error(`terminfo check:merge: missing gate-task-guard at ${guardPath}`)
  }

  try {
    const buildEnv: NodeJS.ProcessEnv = {
      ...options.env,
      TERMINFO_SITE_OUT_DIR: scratchDir,
      BUN_JSC_forceRAMSize: options.env["BUN_JSC_forceRAMSize"] ?? "8589934592",
    }
    const build = exec(
      "bun",
      [guardPath, "--task", "terminfo-merge-build", "--max-rss-mib", String(maxRssMib), "--", "bun", "run", "build"],
      { cwd: options.terminfoRoot, env: buildEnv },
    )
    const combinedOutput = `${build.stdout}\n${build.stderr}`
    const peakLine = combinedOutput
      .split("\n")
      .find((l) => l.includes("sampled-peak-rss=") || l.includes("peak-rss-bytes="))
      ?.trim()
    if (peakLine) log(`terminfo check:merge: ${peakLine}`)
    if (build.status !== 0) {
      throw new Error(
        `terminfo check:merge: real site build failed (exit ${build.status}):\n${build.stderr.slice(-2000) || build.stdout.slice(-2000)}`,
      )
    }

    const leak = exec("bun", ["scripts/check-private-leak.ts"], { cwd: options.terminfoRoot, env: buildEnv })
    if (leak.status !== 0) {
      throw new Error(`terminfo check:merge: check-private-leak failed:\n${leak.stderr || leak.stdout}`)
    }

    const links = exec("bun", ["scripts/check-404s.ts", join(scratchDir, "dist")], {
      cwd: options.terminfoRoot,
      env: buildEnv,
    })
    if (links.status !== 0) {
      throw new Error(`terminfo check:merge: check-404s failed:\n${links.stderr || links.stdout}`)
    }
    log("terminfo check:merge: build + private-leak + 404 checks passed")
    return { skipped: false, checkedRuns: history.checked, peakRssLine: peakLine }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const terminfoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const superRoot = resolve(terminfoRoot, "..", "..")
  try {
    runTerminfoMergeCheck({ terminfoRoot, superRoot, env: process.env })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
