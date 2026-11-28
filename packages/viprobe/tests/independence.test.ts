/**
 * @failure viprobe grows a dependency or source import on Terminfo or Termless, breaking AC2 canonical log
 * independence (#30932 AC2).
 * @level l1
 * @consumer packages/viprobe/package.json and packages/viprobe/src/*.ts; every collector writing canonical
 * viprobe.call-log v1 artifacts.
 * @reach package-only: inspects packages/viprobe manifest and source files on disk
 * @testonly none
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"

const VIPROBE_ROOT = join(import.meta.dirname, "..")

it("viprobe declares zero dependencies on Terminfo or Termless", () => {
  const manifest = JSON.parse(readFileSync(join(VIPROBE_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
  expect(declared.filter((name) => /terminfo|termless/i.test(name))).toEqual([])
})

it("viprobe source files contain no imports from Terminfo or Termless", () => {
  const srcDir = join(VIPROBE_ROOT, "src")
  const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const source = readFileSync(join(srcDir, file), "utf8")
    const imports = [...source.matchAll(/\b(?:import|export)\b[^"']*["']([^"']+)["']/gu)].map((match) => match[1])
    expect(
      imports.filter((specifier) => /terminfo|termless/i.test(specifier ?? "")),
      `${file} must not import Terminfo or Termless`,
    ).toEqual([])
  }
})
