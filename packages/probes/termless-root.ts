/**
 * Derive the Termless checkout from the adapter that actually loaded: the repository that tracks
 * the adapter package. No layout beside the source tree is assumed, and nothing is declared.
 */

import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, relative } from "node:path"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

/** Walk up from the resolved entry to the directory whose package.json names the package. */
function packageDirectory(path: string, packageName: string): string {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
      if (record(manifest) && manifest.name === packageName) return directory
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") throw error
    }
    if (dirname(directory) === directory) {
      throw new Error(`Resolved ${packageName} at ${path} has no package.json naming it`)
    }
  }
}

/**
 * The checkout that tracks `adapterPath`'s package, or a refusal naming the package, the resolved
 * path and the fix. An untracked package inside another repository is not a Termless checkout:
 * taking it would make identity record the enclosing repository's HEAD as the adapter revision.
 */
export function owningCheckout(adapterPath: string, packageName: string): string {
  const path = realpathSync(adapterPath)
  const directory = packageDirectory(path, packageName)
  let checkout: string
  try {
    checkout = realpathSync(git(directory, "rev-parse", "--show-toplevel"))
  } catch (cause) {
    throw new Error(
      `Termless adapter ${packageName} resolved to ${path}, which is not inside a Git checkout; install the owned Termless source workspace`,
      { cause },
    )
  }
  const packagePath = relative(checkout, directory)
  // A package at the checkout root has an empty relative path; joining keeps it repository-relative
  // instead of producing an absolute "/package.json" that git rejects as outside the repository.
  const packageFile = join(packagePath, "package.json")
  try {
    git(checkout, "ls-files", "--error-unmatch", packageFile)
  } catch (cause) {
    throw new Error(
      `Termless adapter ${packageName} resolved to ${path}, but ${packageFile} is not tracked in ${checkout}; install the owned Termless source workspace`,
      { cause },
    )
  }
  return checkout
}
