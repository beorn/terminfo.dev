#!/usr/bin/env bun
/**
 * Historical retained-XWD storage (#34769, @cto 34769-migration-v2-go-2201): census, migrate, roll back, or
 * recover a dead writer's lock, one retained artifact directory at a time, through capture-core's retention owner.
 *
 *   bun scripts/retained-encoding.ts census   <root>...   read-only: what a migration would encode, map and skip
 *   bun scripts/retained-encoding.ts migrate  <root>...   encode, publish receipt rows, unlink verified originals
 *   bun scripts/retained-encoding.ts rollback <root>...   restore every mapped original, then withdraw its row
 *   bun scripts/retained-encoding.ts recover-lock <artifacts-dir> '<holder json>'
 *
 * A root is a `raw/artifacts` directory or any directory above one (a bundle, a pass, a run). Directories are found
 * with lstat, never following a symlink, the named root included; a named root that does not exist, is a symlink or
 * is not a directory is reported by name and fails the command before any directory is read.
 * Legacy `<sha>.xwd.gz` files are mapped only for digests a JSON file beside the bundle declares as an XWD reference
 * (`xwdSha256`, or a `{path, sha256}` reference whose path ends in `.xwd`). Each directory prints one JSON line; the
 * command stops at the first refusal and exits 1 naming that directory. Nothing is migrated before an operator release
 * names the run (no historical file moves without it).
 *
 * A human citation of `artifacts/<sha>.xwd` stays resolvable after migration: read it with
 *   bun -e 'import { resolveRetained } from "./packages/terminfo.dev/src/capture-core.ts";
 *           process.stdout.write(resolveRetained("<raw dir>", { path: "artifacts/<sha>.xwd", sha256: "<sha>" }).bytes)'
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import {
  migrateRetained,
  recoverRetainedLock,
  RETAINED_RECEIPT,
  rollbackRetained,
  type RetainedLockHolder,
} from "../packages/terminfo.dev/src/capture-core.ts"

const HEX64 = /^[0-9a-f]{64}$/
const RAW_XWD = /^[0-9a-f]{64}\.xwd$/
const LEGACY_GZIP = /^([0-9a-f]{64})\.xwd\.gz$/

function lstatOrMissing(path: string): ReturnType<typeof lstatSync> | "missing" {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    throw error
  }
}

/**
 * Why a named root is refused, or undefined when it is a real directory. A symlink is refused, never followed, even as
 * the named root itself (@cto 34769-rootlink-finding-1646): readdirSync on a linked root would walk its target.
 */
export function rootRefusal(root: string): string | undefined {
  const stat = lstatOrMissing(root)
  if (stat === "missing" || stat === undefined) return "does not exist"
  if (stat.isSymbolicLink()) return "is a symlink, which is never followed"
  if (!stat.isDirectory()) return "is not a directory"
  return undefined
}

/** Every `artifacts` directory at or below `root`, found without following symlinks; a refused root throws by name. */
export function artifactDirectories(root: string): string[] {
  const refusal = rootRefusal(root)
  if (refusal !== undefined) throw new Error(`retained-encoding: named root ${root} ${refusal}`)
  const found: string[] = []
  const walk = (directory: string): void => {
    if (basename(directory) === "artifacts") {
      found.push(directory)
      return
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(join(directory, entry.name))
    }
  }
  walk(root)
  return found.sort()
}

/** XWD digests declared by the JSON files in the artifact directory's parent and grandparent. */
export function declaredXwdDigests(artifacts: string): Set<string> {
  const declared = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== "object") return
    const record = value as Record<string, unknown>
    if (typeof record.xwdSha256 === "string" && HEX64.test(record.xwdSha256)) declared.add(record.xwdSha256)
    // v3 captures name their source bytes as `sourceRef: "sha256:<digest>"`.
    const sourceRef =
      typeof record.sourceRef === "string" ? /^sha256:([0-9a-f]{64})$/.exec(record.sourceRef)?.[1] : undefined
    if (sourceRef !== undefined) declared.add(sourceRef)
    if (
      typeof record.path === "string" &&
      record.path.endsWith(".xwd") &&
      typeof record.sha256 === "string" &&
      HEX64.test(record.sha256)
    ) {
      declared.add(record.sha256)
    }
    for (const nested of Object.values(record)) {
      // Raw replies (collector.traceManifest) hold their JSON as a string; one that does not parse refuses loudly.
      if (typeof nested === "string" && nested.startsWith("{")) {
        visit(JSON.parse(nested))
      } else {
        visit(nested)
      }
    }
  }
  for (const directory of [artifacts, dirname(artifacts), dirname(dirname(artifacts))]) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json") || name === RETAINED_RECEIPT) continue
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (!stat.isFile()) continue
      visit(JSON.parse(readFileSync(path, "utf8")))
    }
  }
  return declared
}

function census(artifacts: string, declared: ReadonlySet<string>): Record<string, unknown> {
  const names = readdirSync(artifacts)
  const receipt = names.includes(RETAINED_RECEIPT)
    ? (JSON.parse(readFileSync(join(artifacts, RETAINED_RECEIPT), "utf8")) as { rows: { name: string }[] }).rows
    : []
  const mapped = new Set(receipt.map((row) => row.name))
  let rawBytes = 0
  const raw = names.filter((name) => RAW_XWD.test(name) && !mapped.has(name))
  for (const name of raw) rawBytes += lstatSync(join(artifacts, name)).blocks * 512
  const gzip = names.filter((name) => LEGACY_GZIP.test(name))
  const declaredGzip = gzip.filter((name) => declared.has(LEGACY_GZIP.exec(name)?.[1] ?? ""))
  return {
    directory: artifacts,
    unmappedRaw: raw.length,
    unmappedRawAllocated: rawBytes,
    receiptRows: receipt.length,
    legacyGzip: gzip.length,
    legacyGzipDeclared: declaredGzip.length,
  }
}

export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv
  if (command === "recover-lock") {
    const [directory, holder] = rest
    if (directory === undefined || holder === undefined) {
      console.error("usage: retained-encoding.ts recover-lock <artifacts-dir> '<holder json from the lock file>'")
      return 2
    }
    console.log(
      JSON.stringify({ directory, ...recoverRetainedLock(directory, JSON.parse(holder) as RetainedLockHolder) }),
    )
    return 0
  }
  if ((command !== "census" && command !== "migrate" && command !== "rollback") || rest.length === 0) {
    console.error(
      "usage: retained-encoding.ts census|migrate|rollback <root>...  |  recover-lock <artifacts-dir> '<holder>'",
    )
    return 2
  }
  const refused = rest.flatMap((root) => {
    const refusal = rootRefusal(resolve(root))
    return refusal === undefined ? [] : [`${root} ${refusal}`]
  })
  if (refused.length) {
    console.error(`retained-encoding: ${refused.length} named root(s) refused: ${refused.join(", ")}`)
    return 1
  }
  for (const root of rest) {
    const directories = artifactDirectories(resolve(root))
    if (directories.length === 0) console.error(`retained-encoding: ${root} holds no artifacts directory`)
    for (const artifacts of directories) {
      try {
        const declared = declaredXwdDigests(artifacts)
        const report =
          command === "census"
            ? census(artifacts, declared)
            : command === "migrate"
              ? migrateRetained(artifacts, { declaredGzip: declared })
              : { directory: artifacts, ...rollbackRetained(artifacts) }
        console.log(JSON.stringify(report))
      } catch (error) {
        console.error(`retained-encoding: ${command} refused in ${artifacts}: ${(error as Error).message}`)
        return 1
      }
    }
  }
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
