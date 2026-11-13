/** Private canonical resource witness, shared by the local driver and its remote Bun process. */

import { createHash } from "node:crypto"

import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs"

import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path"

export const RESOURCE_EXCLUDES = new Set([".git", ".vitest", ".vitest-cache", ".cache"])

function fail(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`)
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function manifestScan(
  root: string,
  entries: readonly string[],
  missing: string,
  also: readonly string[] = [],
): { lines: string[]; linkTargets: string[] } {
  const lines: string[] = []
  // Staged-relative paths every link depends on: each hop's own lexical target AND the final real
  // target, so a chain a -> bridge/pkg -> ag/pkg stages bridge as well as ag.
  const linkTargets: string[] = []
  // Containment is decided on PHYSICAL roots, the same on both sides: a root under a symlinked
  // ancestor (macOS /tmp -> /private/tmp) would otherwise read its own targets as escapes. `also`
  // names further roots holding the same staged tree (the closure reaches declared resources
  // through the code root); each maps onto the same staged-relative paths.
  const physical = [root, ...also].map((path) => realpathSync(path))
  const stagedPath = (path: string): string | undefined => {
    for (const base of physical) {
      if (path === base) return ""
      if (path.startsWith(`${base}${sep}`)) return relativePath(base, path).split(sep).join("/")
    }
    return undefined
  }
  const walk = (path: string): void => {
    let info
    try {
      info = lstatSync(path)
    } catch {
      fail(missing, `declared resource ${JSON.stringify(path.slice(root.length + 1))} is absent`)
    }
    const relative = path.slice(root.length + 1)
    if (info.isSymbolicLink()) {
      const target = readlinkSync(path)
      // A link's text is what the stage will hold, and the host resolves it from a different
      // location. An absolute target would resolve against the HOST's filesystem, so identical
      // text and identical staged bytes could still read a file this run never measured.
      if (isAbsolute(target)) {
        fail("broken staged symlink", `${relative} -> ${target} is absolute and cannot be relocated into the stage`)
      }
      const resolved = resolve(dirname(path), target)
      // The hop's own text must stay inside the tree, or the host resolves it outside the stage.
      const hop =
        resolved === root ? "" : resolved.startsWith(`${root}${sep}`) ? resolved.slice(root.length + 1) : undefined
      if (hop === undefined) fail("resource manifest mismatch", `${relative} -> ${target} escapes the staged tree`)
      let real: string
      try {
        real = realpathSync(resolved)
      } catch {
        fail("broken staged symlink", `${relative} -> ${target} does not resolve`)
      }
      // The real path follows every intermediate link, so a chain that leaves the tree and comes
      // back — or leaves it for good — is refused on the bytes, not on the lexical text.
      const staged = stagedPath(real)
      if (staged === undefined) {
        fail("resource manifest mismatch", `${relative} -> ${target} escapes the staged tree`)
      }
      linkTargets.push(hop, staged)
      lines.push(`${relative}\tsymlink:${target}\tresolved:${staged}`)
      return
    }
    if (info.isDirectory()) {
      for (const child of readdirSync(path).sort()) {
        if (RESOURCE_EXCLUDES.has(child)) continue
        walk(join(path, child))
      }
      return
    }
    if (!info.isFile()) fail(missing, `${relative} is neither a file, a directory nor a symlink`)
    lines.push(`${relative}\tsha256:${sha256(readFileSync(path))}`)
  }
  if (entries.length === 0) {
    walk(root)
  } else {
    for (const entry of entries) walk(join(root, entry))
  }
  lines.sort()
  return { lines, linkTargets }
}

export function digestValue(lines: readonly string[]): { sha256: string; files: number } {
  return { sha256: sha256(lines.join("\n")), files: lines.length }
}
