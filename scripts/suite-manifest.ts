#!/usr/bin/env bun
/** Record and validate the immutable declaration of an executable probe suite. */

import { execFileSync, spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { probeSuiteSnapshot, type ProbeSuiteSnapshot } from "../packages/admin/versions.ts"
import { parseSuiteManifest } from "@terminfo/run-parser"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SUITES_DIR = join(ROOT, "content", "suites")
const KINDS = ["app", "headless", "mux"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameStrings(actual: unknown, expected: string[]): actual is string[] {
  return (
    Array.isArray(actual) && actual.length === expected.length && actual.every((id, index) => id === expected[index])
  )
}

function verifyValue(value: ProbeSuiteManifest, path: string, snapshot: ProbeSuiteSnapshot): ProbeSuiteManifest {
  if (value.probeHash !== snapshot.probeHash) throw new Error(`Suite hash mismatch: ${path}`)
  if (value.adapterVersion !== snapshot.adapterVersion) throw new Error(`Suite adapter version mismatch: ${path}`)
  for (const kind of KINDS) {
    if (!sameStrings(value.probes[kind], snapshot.probes[kind])) {
      throw new Error(`Suite ${kind} membership mismatch: ${path}`)
    }
  }
  return value
}

/** Verify a stored declaration against the currently executable suite. */
export function verifySuiteManifest(path: string, snapshot: ProbeSuiteSnapshot): ProbeSuiteManifest {
  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch (cause) {
    throw new Error(`Cannot read suite manifest ${path}`, { cause })
  }
  return verifyValue(parseSuiteManifest(path, source), path, snapshot)
}

/** Create exclusively; an existing hash is checked and its original metadata retained. */
export function persistSuiteManifest(
  path: string,
  manifest: ProbeSuiteManifest,
  snapshot: ProbeSuiteSnapshot,
): "created" | "existing" {
  verifyValue(parseSuiteManifest(path, JSON.stringify(manifest)), path, snapshot)
  mkdirSync(dirname(path), { recursive: true })
  let descriptor: number
  try {
    descriptor = openSync(path, "wx")
  } catch (cause) {
    if (isRecord(cause) && cause.code === "EEXIST") {
      verifySuiteManifest(path, snapshot)
      return "existing"
    }
    throw new Error(`Cannot create suite manifest ${path}`, { cause })
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`)
  } finally {
    closeSync(descriptor)
  }
  return "created"
}

function committedSourceRevision(snapshot: ProbeSuiteSnapshot): string {
  const sourcePaths = [...snapshot.sourcePaths, "packages/admin/versions.ts", "scripts/suite-manifest.ts"]
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...sourcePaths], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim()
  if (dirty) throw new Error(`Cannot declare an uncommitted probe suite:\n${dirty}`)
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
}

export function checkCurrentSuiteManifest(): ProbeSuiteManifest {
  const snapshot = probeSuiteSnapshot()
  return verifySuiteManifest(join(SUITES_DIR, `${snapshot.probeHash}.json`), snapshot)
}

/**
 * Declaring a suite is authoring (27843 AC2), so it may only run on a checkout carrying work that
 * is not yet on main. In a shared-main checkout HEAD is always an ancestor of origin/main and a
 * declare there writes a manifest no commit will take — the stray that reached /hh/dev twice.
 * `--check` still runs anywhere: validating a stored declaration is a read.
 */
export function assertDeclareIsAuthoring(cwd: string): void {
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (result.error) throw new Error(`Cannot declare a suite: git ${args.join(" ")} failed`, { cause: result.error })
    return result
  }
  const head = run(["rev-parse", "HEAD"])
  if (head.status !== 0) throw new Error(`Cannot declare a suite outside a Git checkout (${cwd})`)
  const declared = run(["rev-parse", "--verify", "origin/main^{commit}"])
  if (declared.status !== 0) {
    throw new Error(`Cannot declare a suite: ${cwd} offers no origin/main to compare the declared revision against`)
  }
  const ancestor = run(["merge-base", "--is-ancestor", head.stdout.trim(), declared.stdout.trim()])
  if (ancestor.status === 0) {
    throw new Error(
      `Refusing to declare a suite manifest whose HEAD is already on origin/main (${cwd}).\n` +
        "Declaring is authoring: commit the change in your own worktree, then declare there.",
    )
  }
  if (ancestor.status !== 1) {
    throw new Error(
      `Cannot declare a suite: git merge-base --is-ancestor failed (${ancestor.status}): ${ancestor.stderr.trim()}`,
    )
  }
}

export function writeCurrentSuiteManifest(): { status: "created" | "existing"; path: string } {
  assertDeclareIsAuthoring(ROOT)
  const snapshot = probeSuiteSnapshot()
  const path = join(SUITES_DIR, `${snapshot.probeHash}.json`)
  if (existsSync(path)) {
    verifySuiteManifest(path, snapshot)
    return { status: "existing", path }
  }
  const manifest: ProbeSuiteManifest = {
    probeHash: snapshot.probeHash,
    sourceRevision: committedSourceRevision(snapshot),
    generatedAt: new Date().toISOString(),
    adapterVersion: snapshot.adapterVersion,
    probes: snapshot.probes,
  }
  return { status: persistSuiteManifest(path, manifest, snapshot), path }
}

export type SuiteManifestMode = "check" | "write" | "usage"

/** A bare invocation is never a declare: the write needs the explicit verb (27843 AC2). */
export function suiteManifestMode(argv: string[]): SuiteManifestMode {
  if (argv.length !== 1) return "usage"
  if (argv[0] === "--check") return "check"
  if (argv[0] === "--write") return "write"
  return "usage"
}

const USAGE = [
  "Usage: bun scripts/suite-manifest.ts --check|--write",
  "  --check  verify the stored declaration against the currently executable suite",
  "  --write  declare the current suite; refused in a checkout whose HEAD is on origin/main",
].join("\n")

if (import.meta.main) {
  const mode = suiteManifestMode(process.argv.slice(2))
  if (mode === "usage") {
    console.error(USAGE)
    process.exitCode = 2
  } else {
    try {
      if (mode === "check") {
        const manifest = checkCurrentSuiteManifest()
        console.log(`Suite manifest valid: ${manifest.probeHash}`)
      } else {
        const result = writeCurrentSuiteManifest()
        console.log(`Suite manifest ${result.status}: ${result.path}`)
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
