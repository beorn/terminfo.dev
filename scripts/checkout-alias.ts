import { readFileSync } from "node:fs"
import { join } from "node:path"

const PACKAGE_DIRS = ["admin", "catalog", "probe-defs", "probes", "run-parser"] as const

export interface CheckoutAlias {
  readonly find: string
  readonly replacement: string
}

/** Map every @terminfo export to a file in this checkout. */
export function terminfoCheckoutAliases(root: string): CheckoutAlias[] {
  const aliases: CheckoutAlias[] = []
  for (const name of PACKAGE_DIRS) {
    const dir = join(root, "packages", name)
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>
    }
    const entries = Object.entries(manifest.exports ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    )
    entries.sort((a, b) => b[0].length - a[0].length)
    for (const [key, target] of entries) {
      const specifier = key === "." ? `@terminfo/${name}` : `@terminfo/${name}${key.slice(1)}`
      aliases.push({ find: specifier, replacement: join(dir, target) })
    }
  }
  return aliases
}
