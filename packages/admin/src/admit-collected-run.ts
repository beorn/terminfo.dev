/** Private collection staging; the one admission owner decides and places canonical runs. */
import { dirname } from "node:path"
import { saveDaemonProbeRun } from "terminfo.dev/src/daemon-client.ts"
import { planAdmission, admitRun } from "../../../scripts/admit-run.ts"

export function admitCollectedRun(
  run: Parameters<typeof saveDaemonProbeRun>[0],
  retainedResponsePath: string,
  intended?: Parameters<typeof saveDaemonProbeRun>[2],
): string {
  const source = saveDaemonProbeRun(run, dirname(retainedResponsePath), intended)
  console.log(`  Retained private collected run ${source}`)
  const plan = planAdmission(source)
  admitRun(plan)
  console.log(`  Admitted run ${plan.destination}`)
  return plan.destination
}
