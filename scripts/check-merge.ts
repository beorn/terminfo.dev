#!/usr/bin/env bun
/**
 * Pre-merge gate for vendor/terminfo.dev (operator-approved, @cto 9768f1cf):
 * 1. Fails loudly if YRD_BASE_SHA or YRD_CANDIDATE_SHA is missing (never skips).
 * 2. Fast-skips (exit 0) when vendor/terminfo.dev did not change between base and candidate.
 * 3. Verifies every stored probe run's sourceRevision exists in the git object store and is an ancestor of HEAD.
 * 4. Runs the full site build only when a changed file is a site build input (@cto 31e669f6 a; see
 *    siteBuildInputs), and otherwise the cheap scope, logging which ran and why. The full build runs under the 20 GiB gate-task-guard into an owned scratch dir
 *    (removed in finally even on failure), plus check-private-leak and check-404s.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
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

/**
 * The files the site build reads, derived from the site's own graph rather than a hand list (@cto 31e669f6 a):
 * the `build` script's entry files and every source file under the page and data roots, followed through their
 * relative and workspace-package imports. A workspace package the build reaches counts whole, with its declared
 * workspace dependencies; a local file outside packages/ counts by itself and its own imports are followed.
 * Test files are never inputs.
 */
export interface SiteBuildInputs {
  /** Directories every file under which is an input: the page and data roots, and each reached package. */
  readonly roots: readonly string[]
  /** Single files reached outside those roots (the build entry and the scripts it imports). */
  readonly files: ReadonlySet<string>
}

/** The build reads every page under docs/ and every data file under content/ by path, not by import. */
const PAGE_AND_DATA_ROOTS = ["docs", "content"] as const
const MANIFESTS = ["package.json", "bun.lock"] as const
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|md)$/u
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/gu
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".vue", "/index.ts", "/index.js"] as const

export function isSiteBuildInput(path: string, inputs: SiteBuildInputs): boolean {
  if (TEST_FILE.test(path)) return false
  if ((MANIFESTS as readonly string[]).includes(path) || inputs.files.has(path)) return true
  return inputs.roots.some((root) => path.startsWith(`${root}/`))
}

export function siteBuildInputs(terminfoRoot: string): SiteBuildInputs {
  const manifest = JSON.parse(readFileSync(join(terminfoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
    workspaces?: string[]
  }
  const buildScript = manifest.scripts?.["build"]
  if (buildScript === undefined) throw new Error("terminfo check:merge: package.json declares no build script")
  const entries = [...buildScript.matchAll(/\b(scripts\/[\w./-]+\.[cm]?ts)\b/gu)].map((match) => match[1]!)
  if (entries.length === 0) {
    throw new Error(`terminfo check:merge: the build script names no scripts/ entry file: ${JSON.stringify(buildScript)}`)
  }

  // Workspace packages by name and by directory, with their declared workspace dependencies.
  const packages = new Map<string, { dir: string; deps: string[] }>()
  for (const name of readdirSync(join(terminfoRoot, "packages"))) {
    const manifestPath = join(terminfoRoot, "packages", name, "package.json")
    if (!existsSync(manifestPath)) continue
    const member = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = Object.entries({ ...member.dependencies, ...member.devDependencies })
      .filter(([, version]) => version.startsWith("workspace"))
      .map(([dep]) => dep)
    packages.set(member.name ?? name, { dir: `packages/${name}`, deps })
  }
  const packageDirByName = new Map([...packages].map(([name, entry]) => [name, entry.dir]))
  const packageByDir = new Map([...packages].map(([name, entry]) => [entry.dir, name]))

  const files = new Set<string>()
  const reachedPackages = new Set<string>()
  const queue: string[] = []
  const visit = (path: string) => {
    if (TEST_FILE.test(path)) return
    const top = path.split("/").slice(0, 2).join("/")
    if (packageByDir.has(top)) {
      reachPackage(packageByDir.get(top)!)
      return
    }
    if (files.has(path)) return
    files.add(path)
    if (SOURCE_FILE.test(path)) queue.push(path)
  }
  const reachPackage = (name: string) => {
    if (reachedPackages.has(name)) return
    reachedPackages.add(name)
    const entry = packages.get(name)!
    for (const dep of entry.deps) if (packages.has(dep)) reachPackage(dep)
    for (const file of listSourceFiles(terminfoRoot, entry.dir)) queue.push(file)
  }
  const resolveLocal = (from: string, specifier: string): string | null => {
    const base = join(dirname(from), specifier)
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${base}${suffix}`
      if (existsSync(join(terminfoRoot, candidate)) && statSync(join(terminfoRoot, candidate)).isFile()) return candidate
    }
    return null
  }

  for (const entry of entries) visit(entry)
  // Pages import code too; data under content/ is read by path and imports nothing.
  for (const file of listSourceFiles(terminfoRoot, "docs")) queue.push(file)
  while (queue.length > 0) {
    const file = queue.pop()!
    const text = readFileSync(join(terminfoRoot, file), "utf8")
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1]!
      if (specifier.startsWith(".")) {
        const resolved = resolveLocal(file, specifier)
        if (resolved !== null && !resolved.startsWith("..")) visit(resolved)
        continue
      }
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!
      if (packageDirByName.has(name)) reachPackage(name)
    }
  }
  const roots = [...PAGE_AND_DATA_ROOTS, ...[...reachedPackages].map((name) => packages.get(name)!.dir)]
  return { roots, files }
}


function listSourceFiles(terminfoRoot: string, dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(terminfoRoot, rel), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "cache") continue
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) out.push(child)
    }
  }
  if (existsSync(join(terminfoRoot, dir))) walk(dir)
  return out
}

/**
 * Which build the gate runs for this candidate, and why: the full site build only when a changed file inside
 * vendor/terminfo.dev is a site build input; otherwise the cheap scope (source history and the private-leak source
 * scan, no build). Changed files it cannot list run the full build, with the reason logged.
 */
export function chooseBuildScope(
  options: { terminfoRoot: string; superRoot: string },
  baseSha: string,
  candidateSha: string,
  exec: ExecFn,
): { scope: "cheap" | "full"; why: string } {
  const gitlink = (sha: string) => {
    const read = exec("git", ["-C", options.superRoot, "rev-parse", `${sha}:vendor/terminfo.dev`], {})
    return read.status === 0 ? read.stdout.trim() : ""
  }
  const [from, to] = [gitlink(baseSha), gitlink(candidateSha)]
  if (from === "" || to === "") {
    return { scope: "full", why: `full build: changed files unknown (no vendor/terminfo.dev gitlink at ${from === "" ? baseSha : candidateSha})` }
  }
  const diff = exec("git", ["-C", options.terminfoRoot, "diff", "--name-only", from, to], {})
  if (diff.status !== 0) {
    return { scope: "full", why: `full build: changed files unknown (git diff ${from.slice(0, 12)} ${to.slice(0, 12)}: ${(diff.stderr || diff.stdout).trim()})` }
  }
  const changed = diff.stdout.split("\n").filter((line) => line.length > 0)
  const inputs = siteBuildInputs(options.terminfoRoot)
  const hit = changed.find((path) => isSiteBuildInput(path, inputs))
  const described = `inputs: ${inputs.roots.join(", ")} and ${inputs.files.size} script file(s) from the build's graph`
  if (hit !== undefined) {
    const count = changed.filter((path) => isSiteBuildInput(path, inputs)).length
    return { scope: "full", why: `full build: ${hit} is a site build input (${count} of ${changed.length} changed file(s) are; ${described})` }
  }
  return {
    scope: "cheap",
    why: `cheap scope (no site build): none of ${changed.length} changed file(s) is a site build input (${described}); first changed: ${changed[0] ?? "none"}`,
  }
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
  scope: "skipped" | "cheap" | "full"
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
    return { skipped: true, scope: "skipped", checkedRuns: 0 }
  }

  const chosen = chooseBuildScope(options, baseSha, candidateSha, exec)
  log(`terminfo check:merge: ${chosen.why}`)

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

  if (chosen.scope === "cheap") {
    const leak = exec("bun", ["scripts/check-private-leak.ts"], { cwd: options.terminfoRoot, env: options.env })
    if (leak.status !== 0) {
      throw new Error(`terminfo check:merge: check-private-leak failed:\n${leak.stderr || leak.stdout}`)
    }
    log("terminfo check:merge: cheap scope passed (source history + private-leak source scan; no site build)")
    return { skipped: false, scope: "cheap", checkedRuns: history.checked }
  }

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
    return { skipped: false, scope: "full", checkedRuns: history.checked, peakRssLine: peakLine }
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
