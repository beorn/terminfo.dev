/**
 * @failure A historical retained XWD stops resolving to its exact original bytes after migration, a present
 *   original stops winning over its receipt row, an interrupted migration or rollback leaves a reference
 *   unreadable, a dead writer's lock is broken silently, a receipt row is replaced or withdrawn unverified, a
 *   legacy gzip file is mapped without a declared digest, or a collected-run copy needs the source (#34769).
 * @level l2
 * @consumer capture-core's retention owner: resolveReference/readProbeCapture (packages/probes/erase-capture.ts),
 *   retainCollectedRun (packages/admin/src/collected-run.ts), and the historical migration CLI.
 * @reach fs-walk <fixture-only: lists only the temporary artifact directories each test creates>
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, test } from "vitest"
import {
  lockRetained,
  migrateRetained,
  recoverRetainedLock,
  resolveRetained,
  RETAINED_LOCK,
  RETAINED_RECEIPT,
  RetainedStoreError,
  retainedSource,
  rollbackRetained,
  transferRetained,
  writeRetainedReceipt,
  type RetainedRow,
} from "./capture-core.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** A store with `raw/artifacts/<sha>.xwd` originals, as a historical bundle keeps them. */
function bundle(count = 3): {
  raw: string
  artifacts: string
  originals: Buffer[]
  refs: { path: string; sha256: string }[]
} {
  const raw = join(mkdtempSync(join(tmpdir(), "retained-storage-")), "raw")
  roots.push(join(raw, ".."))
  const artifacts = join(raw, "artifacts")
  mkdirSync(artifacts, { recursive: true })
  const originals = Array.from({ length: count }, (_, index) =>
    Buffer.concat([Buffer.from(`XWD fixture ${index}\n`), Buffer.alloc(64 * 1024, index + 1)]),
  )
  for (const bytes of originals) writeFileSync(join(artifacts, `${sha(bytes)}.xwd`), bytes)
  return {
    raw,
    artifacts,
    originals,
    refs: originals.map((bytes) => ({ path: `artifacts/${sha(bytes)}.xwd`, sha256: sha(bytes) })),
  }
}

function kind(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof RetainedStoreError) return error.kind
    throw error
  }
  return "no error"
}

function receiptRows(artifacts: string): RetainedRow[] {
  return (JSON.parse(readFileSync(join(artifacts, RETAINED_RECEIPT), "utf8")) as { rows: RetainedRow[] }).rows
}

function deadPid(): number {
  const child = spawnSync("true")
  if (child.pid === undefined) throw new Error("Cannot obtain an exited pid")
  return child.pid
}

describe("retained storage resolver and migration", () => {
  test("a migrated original resolves to its exact bytes through the receipt, and its dependencies name stored file and receipt", () => {
    const { raw, artifacts, originals, refs } = bundle()
    const report = migrateRetained(artifacts)
    expect(report).toMatchObject({ encoded: 3, reused: 0, unlinked: 3, gzipRows: 0, skipped: [] })
    expect(report.encodedAllocated).toBeLessThan(report.originalAllocated)
    for (const [index, ref] of refs.entries()) {
      expect(existsSync(join(raw, ref.path))).toBe(false)
      const resolved = resolveRetained(raw, ref)
      expect(resolved.bytes.equals(originals[index]!)).toBe(true)
      expect(resolved.row?.codec).toBe("zstd")
      const stored = retainedSource({ bytes: originals[index]!, format: "xwd" }).bytes
      expect(resolved.files).toEqual([
        join(raw, "artifacts", `${sha(stored)}.xwd.zst`),
        join(raw, "artifacts", RETAINED_RECEIPT),
      ])
    }
    expect(existsSync(join(artifacts, RETAINED_LOCK))).toBe(false)
    // A second run finds nothing left to do.
    expect(migrateRetained(artifacts)).toMatchObject({ encoded: 0, reused: 0, unlinked: 0 })
  })

  test("a present original wins over its row, and a corrupt present original refuses instead of falling through", () => {
    const { raw, artifacts, originals, refs } = bundle(1)
    migrateRetained(artifacts, { keepOriginals: true })
    expect(receiptRows(artifacts)).toHaveLength(1)
    expect(resolveRetained(raw, refs[0]).files).toEqual([join(raw, refs[0]!.path)])
    writeFileSync(join(raw, refs[0]!.path), Buffer.concat([originals[0]!, Buffer.from("x")]))
    expect(kind(() => resolveRetained(raw, refs[0]))).toBe("integrity")
    // A dangling symlink at the exact path is not an absence: it refuses instead of falling through to the row.
    rmSync(join(raw, refs[0]!.path))
    symlinkSync(join(raw, "nowhere.xwd"), join(raw, refs[0]!.path))
    expect(kind(() => resolveRetained(raw, refs[0]))).toBe("conflict")
  })

  test("every refusal is typed: bad reference, escape, missing, corrupt stored, wrong row digest, malformed receipt", () => {
    const { raw, artifacts, refs } = bundle(2)
    expect(kind(() => resolveRetained(raw, { path: "../x", sha256: "a".repeat(64) }))).toBe("reference")
    expect(kind(() => resolveRetained(raw, { path: refs[0]!.path }))).toBe("reference")
    expect(kind(() => resolveRetained(raw, { path: "artifacts/absent.xwd", sha256: "a".repeat(64) }))).toBe("missing")
    migrateRetained(artifacts)
    const [first, second] = receiptRows(artifacts)
    expect(kind(() => resolveRetained(raw, { path: refs[0]!.path, sha256: "b".repeat(64) }))).toBe("integrity")
    writeFileSync(join(artifacts, first!.stored), "not zstd")
    const corrupted = refs.find((ref) => `${ref.sha256}.xwd` === first!.name)!
    expect(kind(() => resolveRetained(raw, corrupted))).toBe("integrity")
    rmSync(join(artifacts, second!.stored))
    expect(
      kind(() =>
        resolveRetained(
          raw,
          refs.find((ref) => `${ref.sha256}.xwd` === second!.name),
        ),
      ),
    ).toBe("missing")
    writeFileSync(
      join(artifacts, RETAINED_RECEIPT),
      JSON.stringify({ schema: 1, rows: [{ ...first, codec: "brotli" }] }),
    )
    expect(kind(() => resolveRetained(raw, corrupted))).toBe("receipt")
  })

  test("interrupted states stay readable and a restart repairs each one", () => {
    const { raw, artifacts, originals, refs } = bundle(2)
    // Encoded files with no row: readers see originals; a restart verifies and reuses the encoded files.
    for (const bytes of originals) {
      const stored = retainedSource({ bytes, format: "xwd" }).bytes
      writeFileSync(join(artifacts, `${sha(stored)}.xwd.zst`), stored)
    }
    for (const [index, ref] of refs.entries()) {
      expect(resolveRetained(raw, ref).bytes.equals(originals[index]!)).toBe(true)
    }
    // Receipt published, originals present: still the exact path.
    expect(migrateRetained(artifacts, { keepOriginals: true })).toMatchObject({ encoded: 0, reused: 2, unlinked: 0 })
    for (const ref of refs) expect(resolveRetained(raw, ref).row).toBeUndefined()
    // Some originals unlinked: those resolve through the receipt, the rest exactly; the restart finishes.
    rmSync(join(raw, refs[0]!.path))
    expect(resolveRetained(raw, refs[0]).row?.name).toBe(`${refs[0]!.sha256}.xwd`)
    expect(resolveRetained(raw, refs[1]).row).toBeUndefined()
    expect(migrateRetained(artifacts)).toMatchObject({ unlinked: 1 })
    for (const [index, ref] of refs.entries()) {
      expect(resolveRetained(raw, ref).bytes.equals(originals[index]!)).toBe(true)
    }
  })

  test("an encoded name holding other bytes, or a symlinked original, refuses rather than being overwritten", () => {
    const { artifacts, originals } = bundle(1)
    const stored = retainedSource({ bytes: originals[0]!, format: "xwd" }).bytes
    writeFileSync(join(artifacts, `${sha(stored)}.xwd.zst`), "squatter")
    expect(kind(() => migrateRetained(artifacts))).toBe("conflict")
    expect(readFileSync(join(artifacts, `${sha(stored)}.xwd.zst`), "utf8")).toBe("squatter")
    expect(existsSync(join(artifacts, `${sha(originals[0]!)}.xwd`))).toBe(true)
    expect(existsSync(join(artifacts, RETAINED_LOCK))).toBe(false)
  })

  test("a lock left by a dead writer is reported, recovered only for that exact dead holder, then the migration resumes", () => {
    const { raw, artifacts, originals, refs } = bundle(1)
    const holder = { pid: deadPid(), startedAt: "2026-11-18T00:00:00.000Z", token: "0123456789abcdef" }
    writeFileSync(join(artifacts, RETAINED_LOCK), JSON.stringify(holder) + "\n")
    writeFileSync(join(artifacts, `.${RETAINED_RECEIPT}.${holder.token}.tmp`), "partial")
    expect(kind(() => migrateRetained(artifacts))).toBe("locked")
    expect(kind(() => recoverRetainedLock(artifacts, { ...holder, token: "fedcba9876543210" }))).toBe("locked")
    expect(kind(() => recoverRetainedLock(artifacts, { ...holder, pid: process.pid }))).toBe("locked")
    expect(recoverRetainedLock(artifacts, holder)).toEqual({
      removedTemps: [`.${RETAINED_RECEIPT}.${holder.token}.tmp`],
    })
    expect(migrateRetained(artifacts)).toMatchObject({ unlinked: 1 })
    expect(resolveRetained(raw, refs[0]).bytes.equals(originals[0]!)).toBe(true)
  })

  test("temporary files from another writer with no lock refuse as unclean", () => {
    const { artifacts } = bundle(1)
    writeFileSync(join(artifacts, ".x.xwd.zst.fedcba9876543210.tmp"), "orphan")
    expect(kind(() => migrateRetained(artifacts))).toBe("unclean")
  })

  test("rollback restores each original byte-equal before withdrawing its row and keeps encoded objects", () => {
    const { raw, artifacts, originals, refs } = bundle(2)
    migrateRetained(artifacts)
    const encoded = readdirSync(artifacts).filter((name) => name.endsWith(".xwd.zst"))
    expect(rollbackRetained(artifacts)).toEqual({ restored: 2, withdrawn: 2 })
    for (const [index, ref] of refs.entries()) {
      expect(readFileSync(join(raw, ref.path)).equals(originals[index]!)).toBe(true)
      expect(resolveRetained(raw, ref).row).toBeUndefined()
    }
    expect(receiptRows(artifacts)).toEqual([])
    expect(readdirSync(artifacts).filter((name) => name.endsWith(".xwd.zst"))).toEqual(encoded)
  })

  test("the receipt writer keeps unrelated rows, accepts an identical retry, and refuses a conflict or an unverified withdrawal", () => {
    const { artifacts } = bundle(2)
    migrateRetained(artifacts, { keepOriginals: true })
    const before = readFileSync(join(artifacts, RETAINED_RECEIPT), "utf8")
    const [first, second] = receiptRows(artifacts)
    const lock = lockRetained(artifacts)
    try {
      expect(writeRetainedReceipt(lock, { add: [first!] })).toHaveLength(2)
      expect(readFileSync(join(artifacts, RETAINED_RECEIPT), "utf8")).toBe(before)
      expect(kind(() => writeRetainedReceipt(lock, { add: [{ ...first!, storedSha256: second!.storedSha256 }] }))).toBe(
        "conflict",
      )
      expect(kind(() => writeRetainedReceipt(lock, { remove: ["absent.xwd"] }))).toBe("conflict")
      rmSync(join(artifacts, first!.name))
      expect(kind(() => writeRetainedReceipt(lock, { remove: [first!.name] }))).toBe("integrity")
      writeRetainedReceipt(lock, { remove: [second!.name] })
      expect(receiptRows(artifacts)).toEqual([first])
    } finally {
      lock.release()
    }
    expect(kind(() => writeRetainedReceipt(lock, { add: [] }))).toBe("locked")
  })

  test("a legacy gzip file is mapped only for a declared digest it decodes to", () => {
    const { raw, artifacts } = bundle(0)
    const declared = Buffer.from("legacy XWD bytes\n".repeat(1000))
    const undeclared = Buffer.from("other legacy bytes\n".repeat(1000))
    writeFileSync(join(artifacts, `${sha(declared)}.xwd.gz`), gzipSync(declared))
    writeFileSync(join(artifacts, `${sha(undeclared)}.xwd.gz`), gzipSync(undeclared))
    const report = migrateRetained(artifacts, { declaredGzip: new Set([sha(declared)]) })
    expect(report.gzipRows).toBe(1)
    expect(report.skipped).toEqual([`${sha(undeclared)}.xwd.gz: no reference declares ${sha(undeclared)}`])
    expect(
      resolveRetained(raw, { path: `artifacts/${sha(declared)}.xwd`, sha256: sha(declared) }).bytes.equals(declared),
    ).toBe(true)
    // The legacy .gz is itself the historical original: rollback withdraws the row and writes no raw file.
    expect(rollbackRetained(artifacts)).toEqual({ restored: 0, withdrawn: 1 })
    expect(existsSync(join(artifacts, `${sha(declared)}.xwd`))).toBe(false)
    expect(existsSync(join(artifacts, `${sha(declared)}.xwd.gz`))).toBe(true)
    const lying = Buffer.from("named for another digest")
    writeFileSync(join(artifacts, `${"c".repeat(64)}.xwd.gz`), gzipSync(lying))
    expect(kind(() => migrateRetained(artifacts, { declaredGzip: new Set(["c".repeat(64)]) }))).toBe("integrity")
  })

  test("a transfer copies only the needed physical files and rows, and the destination resolves with the source gone", () => {
    const { raw, artifacts, originals, refs } = bundle(3)
    const trace = Buffer.from('{"trace":true}')
    writeFileSync(join(raw, "trace.json"), trace)
    migrateRetained(artifacts)
    const destination = join(mkdtempSync(join(tmpdir(), "retained-destination-")), "copy")
    roots.push(join(destination, ".."))
    const wanted = [refs[0]!, refs[2]!, { path: "trace.json", sha256: sha(trace) }]
    transferRetained(raw, destination, wanted)
    rmSync(raw, { recursive: true })
    expect(resolveRetained(destination, wanted[0]).bytes.equals(originals[0]!)).toBe(true)
    expect(resolveRetained(destination, wanted[1]).bytes.equals(originals[2]!)).toBe(true)
    expect(resolveRetained(destination, wanted[2]).bytes.equals(trace)).toBe(true)
    expect(receiptRows(join(destination, "artifacts")).map((row) => row.name)).toEqual(
      [refs[0]!, refs[2]!].map((ref) => `${ref.sha256}.xwd`).sort(),
    )
    expect(readdirSync(join(destination, "artifacts")).filter((name) => name.endsWith(".xwd.zst"))).toHaveLength(2)
    expect(kind(() => resolveRetained(destination, refs[1]))).toBe("missing")
    expect(() => transferRetained(destination, join(destination, "again"), [wanted[0], wanted[0]])).toThrow(
      /Retained transfer failed for artifacts\//,
    )
  })
})
