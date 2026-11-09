import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface CheckoutAlias {
  readonly find: string
  readonly replacement: string
}

interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly exports: ReadonlyMap<string, string>
}

function workspacePackages(root: string): WorkspacePackage[] {
  const packagesDir = join(root, "packages")
  const packages: WorkspacePackage[] = []
  for (const entry of readdirSync(packagesDir).sort()) {
    const dir = join(packagesDir, entry)
    const manifestPath = join(dir, "package.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: unknown
      exports?: unknown
    }
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`${manifestPath} has no string name`)
    }
    if (typeof manifest.exports !== "object" || manifest.exports === null || Array.isArray(manifest.exports)) {
      throw new Error(`${manifestPath} exports is not an object`)
    }
    const exports = new Map<string, string>()
    for (const [key, target] of Object.entries(manifest.exports)) {
      if (typeof target !== "string") {
        throw new Error(`${manifestPath} export ${key} is not a string`)
      }
      exports.set(key, target)
    }
    packages.push({ name: manifest.name, dir, exports })
  }
  return packages
}

/** Map every workspace export to a file in this checkout. */
export function terminfoCheckoutAliases(root: string): CheckoutAlias[] {
  const aliases: CheckoutAlias[] = []
  for (const pkg of workspacePackages(root)) {
    const entries = [...pkg.exports.entries()].sort((a, b) => b[0].length - a[0].length)
    for (const [key, target] of entries) {
      const specifier = key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`
      aliases.push({ find: specifier, replacement: join(pkg.dir, target) })
    }
  }
  return aliases
}

/** Keep these specifiers inside Vite so a parent node_modules link cannot win. */
export function checkoutInlineDeps(root: string): RegExp[] {
  return workspacePackages(root).map((pkg) => {
    const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`^${escaped}(?:$|/)`)
  })
}
