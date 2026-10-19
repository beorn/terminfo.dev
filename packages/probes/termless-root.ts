/**
 * Locate the owned Termless checkout for headless collection: a declared location first, the
 * sibling layout second, and a refusal that names both only when neither exists.
 */

import { realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"

export const TERMLESS_ROOT_ENV = "TERMINFO_TERMLESS_ROOT"

export interface TermlessRootOptions {
  /** Repository root whose sibling `../termless` is the conventional checkout location. */
  root: string
  /** Receives a declaration that cannot be used; one stderr line by default. */
  warn?: (line: string) => void
}

function absent(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR")
}

function checkoutDirectory(path: string): string | null {
  try {
    const resolved = realpathSync(path)
    return statSync(resolved).isDirectory() ? resolved : null
  } catch (cause) {
    // silent-fallback-allow: an absent candidate is the answer this probe exists to report; the
    // caller warns by path or refuses naming every location. Any other failure is not absence.
    if (absent(cause)) return null
    throw cause
  }
}

/** Resolve the checkout, or refuse naming every candidate and the variable that supplies one. */
export function resolveTermlessRoot({
  root,
  warn = (line) => process.stderr.write(`${line}\n`),
}: TermlessRootOptions): string {
  const sibling = resolve(root, "../termless")
  const declared = process.env[TERMLESS_ROOT_ENV]?.trim()
  if (declared) {
    const resolved = checkoutDirectory(declared)
    if (resolved) return resolved
    warn(`Ignoring ${TERMLESS_ROOT_ENV}=${declared}: no checkout directory there; using the sibling ${sibling}`)
  }
  const resolved = checkoutDirectory(sibling)
  if (resolved) return resolved
  const looked = declared ? `${declared} (${TERMLESS_ROOT_ENV}) and ${sibling}` : sibling
  throw new Error(`Owned Termless checkout not found: looked in ${looked}. Set ${TERMLESS_ROOT_ENV} to its root.`)
}
