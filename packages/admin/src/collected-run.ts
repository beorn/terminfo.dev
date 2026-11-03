/** Retain collection evidence privately and place normalized runs in the corpus. */
import { constants, copyFileSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { saveDaemonProbeRun } from "../../terminfo.dev/src/daemon-client.ts"
import { getTrustedSuiteReceipt } from "../../terminfo.dev/src/serve.ts"
import { placeCollectedRun } from "../corpus-placement.ts"

/** A default corpus write must belong to an authoring branch. */
function assertAuthoringCheckout(cwd: string): void {
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (result.error) throw new Error(`Cannot write corpus: git ${args.join(" ")} failed`, { cause: result.error })
    return result
  }
  const failure = (args: string[], result: ReturnType<typeof run>): never => {
    const outcome = result.signal === null ? `exited ${result.status}` : `was killed by ${result.signal}`
    const stderr = result.stderr.trim()
    throw new Error(`Cannot write corpus: git ${args.join(" ")} in ${cwd} ${outcome}` + (stderr ? `: ${stderr}` : ""))
  }
  const headArgs = ["rev-parse", "HEAD"]
  const head = run(headArgs)
  if (head.status !== 0) return failure(headArgs, head)
  const branchArgs = ["symbolic-ref", "--quiet", "--short", "HEAD"]
  const branch = run(branchArgs)
  if (branch.status === 1) throw new Error(`Cannot write corpus: HEAD is detached in ${cwd}; use an authoring branch`)
  if (branch.status !== 0) return failure(branchArgs, branch)
  const name = branch.stdout.trim()
  const originArgs = ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]
  const originHead = run(originArgs)
  const defaults = new Set(["main"])
  if (originHead.status === 0) {
    const remoteDefault = originHead.stdout.trim().replace(/^origin\//u, "")
    if (!remoteDefault) throw new Error(`Cannot write corpus: git ${originArgs.join(" ")} in ${cwd} named no branch`)
    defaults.add(remoteDefault)
  } else if (originHead.status !== 1) return failure(originArgs, originHead)
  if (defaults.has(name))
    throw new Error(`Cannot write corpus: HEAD is the default branch (${name}); use an authoring branch`)
}

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
  assertAuthoringCheckout(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."))
  const source = retainCollectedRun(run, retainedResponsePath, intended)
  const destination = placeCollectedRun(source, getTrustedSuiteReceipt().manifest)
  console.log(`  Written collected run ${destination}`)
  return destination
}
