/**
 * @failure A component worktree resolves @terminfo/* to the shared checkout, so a green run proves nothing about the change.
 * @level l1
 * @consumer terminfo component-worktree test runs
 * @testonly none
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import config from "../vitest.config.ts"
import { terminfoCheckoutAliases } from "./checkout-alias.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

it("points every @terminfo export at this checkout", () => {
  const aliases = terminfoCheckoutAliases(root)
  const probe = aliases.find((alias) => alias.find === "@terminfo/probe-defs")
  const sub = aliases.find((alias) => alias.find === "@terminfo/probe-defs/testing/fake-probe-result")
  expect(probe?.replacement).toBe(join(root, "packages/probe-defs/src/index.ts"))
  expect(sub?.replacement).toBe(join(root, "packages/probe-defs/src/testing/fake-probe-result.ts"))
  for (const alias of aliases) {
    expect(alias.replacement.startsWith(`${root}/`), alias.find).toBe(true)
  }
})

it("the vitest config uses those aliases", async () => {
  const resolved = await Promise.resolve(config)
  expect(resolved.resolve?.alias).toEqual(terminfoCheckoutAliases(root))
})
