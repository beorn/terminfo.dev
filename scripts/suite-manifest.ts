#!/usr/bin/env bun
/** Record and validate the immutable declaration of an executable probe suite. */

import { execFileSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { probeSuiteSnapshot, type ProbeSuiteSnapshot } from "../packages/admin/versions.ts"
import { parseSuiteManifest } from "../docs/data/selected-results.ts"

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

export function writeCurrentSuiteManifest(): { status: "created" | "existing"; path: string } {
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

if (import.meta.main) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check")) {
      throw new Error("Usage: bun scripts/suite-manifest.ts [--check]")
    }
    if (process.argv[2] === "--check") {
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
