/** Retain collection evidence privately and place normalized runs in the corpus. */
import { constants, copyFileSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { saveDaemonProbeRun } from "../../terminfo.dev/src/daemon-client.ts"
import { getTrustedSuiteReceipt } from "../../terminfo.dev/src/serve.ts"
import { placeCollectedRun } from "../corpus-placement.ts"

/** Check before creation, resolving existing symlinks without hiding missing or unreadable resources. */
export function assertPrivateCollectionOutput(outputDirectory: string): void {
  if (outputDirectory.length === 0) {
    throw new Error("Raw collection output directory is empty; choose a private directory")
  }
  const directory = resolve(outputDirectory)
  let ancestor = directory
  for (;;) {
    try {
      lstatSync(ancestor)
      break
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT" ||
        dirname(ancestor) === ancestor
      ) {
        throw error
      }
      ancestor = dirname(ancestor)
    }
  }
  const physical = resolve(realpathSync(ancestor), relative(ancestor, directory))
  const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."))
  if (physical === root || physical.startsWith(`${root}${sep}`)) {
    throw new Error(`Collection output must be private, outside the source repository: ${directory}`)
  }
}

/** Retain the original HTTP response and normalized run through the existing immutable writer. */
export function retainCollectedRun(
  run: Parameters<typeof saveDaemonProbeRun>[0],
  retainedResponsePath: string,
  intended?: Parameters<typeof saveDaemonProbeRun>[2],
  outputDirectory?: string,
): string {
  if (outputDirectory !== undefined) assertPrivateCollectionOutput(outputDirectory)
  const directory = resolve(outputDirectory ?? dirname(retainedResponsePath))
  const original = join(directory, basename(retainedResponsePath))
  if (resolve(original) !== resolve(retainedResponsePath)) {
    mkdirSync(directory, { recursive: true })
    copyFileSync(retainedResponsePath, original, constants.COPYFILE_EXCL)
  }
  const source = saveDaemonProbeRun(run, directory, intended)
  console.log(`  Retained private collected run ${source}`)
  return source
}

export function writeCollectedRun(
  run: Parameters<typeof saveDaemonProbeRun>[0],
  retainedResponsePath: string,
  intended?: Parameters<typeof saveDaemonProbeRun>[2],
): string {
  const source = retainCollectedRun(run, retainedResponsePath, intended)
  const destination = placeCollectedRun(source, getTrustedSuiteReceipt().manifest)
  console.log(`  Written collected run ${destination}`)
  return destination
}
