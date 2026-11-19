/**
 * @failure The historical retained-encoding command migrates without naming a missing root, follows a symlink out of
 *   the named tree, maps a legacy gzip file no reference declares, or stops being able to roll a run back (#34769).
 * @level l2
 * @consumer the operator-released historical migration of terminfo-remeasure bundles (scripts/retained-encoding.ts).
 * @reach fs-walk <fixture-only: lists only the temporary artifact directories each test creates>
 * @testonly none
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, test, vi } from "vitest"
import { resolveRetained } from "../packages/terminfo.dev/src/capture-core.ts"
import { artifactDirectories, declaredXwdDigests, main } from "./retained-encoding.ts"

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** run/pass/linux/app/<id>/raw/artifacts with one raw XWD, one declared and one undeclared legacy gzip file. */
function run() {
  const root = mkdtempSync(join(tmpdir(), "retained-encoding-cli-"))
  roots.push(root)
  const raw = join(root, "run", "pass-a", "linux", "app", "0123", "raw")
  const artifacts = join(raw, "artifacts")
  mkdirSync(artifacts, { recursive: true })
  const original = Buffer.concat([Buffer.from("XWD raw\n"), Buffer.alloc(32 * 1024, 7)])
  const declared = Buffer.from("declared legacy XWD\n".repeat(500))
  const undeclared = Buffer.from("undeclared legacy XWD\n".repeat(500))
  writeFileSync(join(artifacts, `${sha(original)}.xwd`), original)
  writeFileSync(join(artifacts, `${sha(declared)}.xwd.gz`), gzipSync(declared))
  writeFileSync(join(artifacts, `${sha(undeclared)}.xwd.gz`), gzipSync(undeclared))
  writeFileSync(
    join(raw, "v3-capture.json"),
    JSON.stringify({ captures: [{ sourceRef: `sha256:${sha(declared)}` }], reply: JSON.stringify({ blobs: [] }) }),
  )
  return { root, raw, artifacts, original, declared }
}

describe("retained-encoding command", () => {
  test("a named root that does not exist refuses by name before anything is read", () => {
    const { root } = run()
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(main(["census", join(root, "run"), join(root, "absent")])).toBe(1)
    expect(error.mock.calls.flat().join("\n")).toContain(join(root, "absent"))
  })

  test("finds artifact directories without following a symlink, and reads declared digests from beside the bundle", () => {
    const { root, artifacts, declared } = run()
    symlinkSync(join(root, "run"), join(root, "run", "pass-a", "loop"))
    expect(artifactDirectories(join(root, "run"))).toEqual([artifacts])
    expect([...declaredXwdDigests(artifacts)]).toEqual([sha(declared)])
    // The named root is held to the same rule (@cto 34769-rootlink-finding-1646): a link to the run, and a link named
    // artifacts, are refused by name before any read, and the command exits 1 without counting the target's files.
    symlinkSync(join(root, "run"), join(root, "run-link"))
    symlinkSync(artifacts, join(root, "artifacts"))
    for (const link of [join(root, "run-link"), `${join(root, "run-link")}/`, join(root, "artifacts")]) {
      expect(() => artifactDirectories(link)).toThrow(`named root ${link} is a symlink`)
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    expect(main(["census", join(root, "run-link")])).toBe(1)
    expect(error.mock.calls.flat().join("\n")).toContain(`${join(root, "run-link")} is a symlink`)
    expect(log).not.toHaveBeenCalled()
  })

  test("census reads only; migrate maps the declared gzip and the raw original; rollback restores the original", () => {
    const { root, raw, artifacts, original, declared } = run()
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
    expect(main(["census", join(root, "run")])).toBe(0)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      unmappedRaw: 1,
      legacyGzip: 2,
      legacyGzipDeclared: 1,
      receiptRows: 0,
    })
    expect(existsSync(join(artifacts, "retained-encoding.json"))).toBe(false)
    expect(main(["migrate", join(root, "run")])).toBe(0)
    expect(JSON.parse(lines[1]!)).toMatchObject({ encoded: 1, gzipRows: 1, unlinked: 1, skipped: [expect.any(String)] })
    expect(existsSync(join(artifacts, `${sha(original)}.xwd`))).toBe(false)
    expect(
      resolveRetained(raw, { path: `artifacts/${sha(original)}.xwd`, sha256: sha(original) }).bytes.equals(original),
    ).toBe(true)
    expect(
      resolveRetained(raw, { path: `artifacts/${sha(declared)}.xwd`, sha256: sha(declared) }).bytes.equals(declared),
    ).toBe(true)
    expect(main(["rollback", join(root, "run")])).toBe(0)
    expect(readFileSync(join(artifacts, `${sha(original)}.xwd`)).equals(original)).toBe(true)
  })
})
