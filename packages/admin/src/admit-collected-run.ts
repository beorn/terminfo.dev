/** Private collection staging; the one admission owner decides and places canonical runs. */
import { constants, copyFileSync, mkdirSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { saveDaemonProbeRun } from "../../terminfo.dev/src/daemon-client.ts"
import { planAdmission, admitRun } from "../../../scripts/admit-run.ts"

/** Retain the original HTTP response and normalized run through the existing immutable writer. */
export function retainCollectedRun(
  run: Parameters<typeof saveDaemonProbeRun>[0],
  retainedResponsePath: string,
  intended?: Parameters<typeof saveDaemonProbeRun>[2],
  outputDirectory?: string,
): string {
  if (outputDirectory?.length === 0)
    throw new Error("Raw collection output directory is empty; choose a private directory")
  const directory = resolve(outputDirectory ?? dirname(retainedResponsePath))
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
  if (outputDirectory !== undefined && (directory === root || directory.startsWith(`${root}${sep}`))) {
    throw new Error(`Raw collection output must be private, outside the source repository: ${directory}`)
  }
  const original = join(directory, basename(retainedResponsePath))
  if (resolve(original) !== resolve(retainedResponsePath)) {
    mkdirSync(directory, { recursive: true })
    copyFileSync(retainedResponsePath, original, constants.COPYFILE_EXCL)
  }
  const source = saveDaemonProbeRun(run, directory, intended)
  console.log(`  Retained private collected run ${source}`)
  return source
}

export function admitCollectedRun(
  run: Parameters<typeof saveDaemonProbeRun>[0],
  retainedResponsePath: string,
  intended?: Parameters<typeof saveDaemonProbeRun>[2],
): string {
  const source = retainCollectedRun(run, retainedResponsePath, intended)
  const plan = planAdmission(source)
  admitRun(plan)
  console.log(`  Admitted run ${plan.destination}`)
  return plan.destination
}
