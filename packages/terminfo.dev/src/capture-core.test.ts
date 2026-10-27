/**
 * @failure An identical capture is written twice, so a rerun of an unchanged screen adds a file, or a digest collision is overwritten instead of named.
 * @level l1
 * @consumer The AC4 retention contract: byte-identical pixels reuse the existing artifact, and a collision is refused.
 * @testonly none
 * @reach fs-walk <fixture-only: /tmp/terminfo-retain-witness>
 */
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { retain } from "./capture-core.ts"

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "terminfo-retain-witness-"))
  directories.push(path)
  return path
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

test("an identical repeat is the same artifact: same ref, one file, bytes untouched (#30764 AC4)", () => {
  const dir = directory()
  const bytes = Buffer.from("\u0089PNG\r\n\u001a\n same screen, same bytes")

  const first = retain(dir, bytes, "png")
  const second = retain(dir, bytes, "png")

  expect(first).toBe(`sha256:${digest(bytes)}`)
  expect(second).toBe(first)
  expect(readdirSync(dir)).toEqual([`${digest(bytes)}.png`])
  expect(readFileSync(join(dir, `${digest(bytes)}.png`)).equals(bytes)).toBe(true)
})

test("different bytes behind an existing name are named, never overwritten (#30764 AC4)", () => {
  const dir = directory()
  const bytes = Buffer.from("the bytes the digest names")
  const impostor = Buffer.from("different bytes, same name")
  const path = join(dir, `${digest(bytes)}.bin`)
  writeFileSync(path, impostor)

  expect(() => retain(dir, bytes, "bin")).toThrow(/digest collision/)
  expect(readFileSync(path).equals(impostor)).toBe(true)
})

test("the extension is part of the name: one digest may hold two encodings without collision (#30764 AC4)", () => {
  const dir = directory()
  const bytes = Buffer.from("one capture, two extensions")

  const png = retain(dir, bytes, "png")
  const xwd = retain(dir, bytes, "xwd")

  expect(png).toBe(xwd)
  expect(readdirSync(dir).sort()).toEqual([`${digest(bytes)}.png`, `${digest(bytes)}.xwd`])
})
