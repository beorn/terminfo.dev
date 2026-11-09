/**
 * @failure A component worktree resolves @terminfo/* or viprobe to the shared checkout, so a green run proves nothing about the change.
 * @level l1
 * @consumer terminfo component-worktree test runs
 * @testonly none
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { eraseCheckoutAlias, eraseCheckoutInline } from "../packages/probes/erase.vitest.config.ts"
import probesConfig from "../packages/probes/vitest.config.ts"
import rootConfig from "../vitest.config.ts"
import { checkoutInlineDeps, terminfoCheckoutAliases } from "./checkout-alias.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const shared = "/hh/dev/vendor/terminfo.dev/"

async function resolvedConfig(config: unknown): Promise<{
  resolve?: { alias?: { find: string; replacement: string }[] }
  test?: { server?: { deps?: { inline?: RegExp[] } } }
}> {
  const value = await Promise.resolve(config)
  return typeof value === "function" ? await value() : value
}

it("points every workspace export at this checkout", () => {
  const aliases = terminfoCheckoutAliases(root)
  expect(aliases.find((alias) => alias.find === "@terminfo/probe-defs")?.replacement).toBe(
    join(root, "packages/probe-defs/src/index.ts"),
  )
  expect(aliases.find((alias) => alias.find === "@terminfo/probe-defs/testing/fake-probe-result")?.replacement).toBe(
    join(root, "packages/probe-defs/src/testing/fake-probe-result.ts"),
  )
  expect(aliases.find((alias) => alias.find === "viprobe")?.replacement).toBe(
    join(root, "packages/viprobe/src/index.ts"),
  )
  for (const alias of aliases) {
    expect(alias.replacement.startsWith(`${root}/`), alias.find).toBe(true)
    if (!`${root}/`.startsWith(shared)) {
      expect(alias.replacement.startsWith(shared), alias.find).toBe(false)
    }
  }
})

it("throws when an export target is not a string", () => {
  const dir = mkdtempSync(join(tmpdir(), "checkout-alias-"))
  const manifest = join(dir, "packages", "example")
  mkdirSync(manifest, { recursive: true })
  writeFileSync(
    join(manifest, "package.json"),
    JSON.stringify({ name: "example", exports: { ".": { import: "./x.ts" } } }),
  )
  expect(() => terminfoCheckoutAliases(dir)).toThrow(/export \. is not a string/)
})

it("every vitest config aliases this checkout and inlines those packages", async () => {
  const aliases = terminfoCheckoutAliases(root)
  const inline = checkoutInlineDeps(root)
  expect(inline.some((pattern) => pattern.test("@terminfo/probe-defs"))).toBe(true)
  expect(inline.some((pattern) => pattern.test("viprobe"))).toBe(true)
  for (const config of [rootConfig, probesConfig]) {
    const resolved = await resolvedConfig(config)
    expect(resolved.resolve?.alias).toEqual(aliases)
    expect(resolved.test?.server?.deps?.inline?.map((pattern) => pattern.source)).toEqual(
      inline.map((pattern) => pattern.source),
    )
  }
  expect(eraseCheckoutAlias).toEqual(aliases)
  expect(eraseCheckoutInline.map((pattern) => pattern.source)).toEqual(inline.map((pattern) => pattern.source))
})
