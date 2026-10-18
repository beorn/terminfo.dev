/**
 * Prints an owned host's identity sample as JSON on stdout. The transport driver runs this tracked
 * file inside the staged checkout and names the host's os as the one argument: an owned host is
 * not a hosted runner, so no hosted-runner variable is read and the os is never inferred.
 *
 *   bun scripts/owned-host-identity.ts <os>
 */
import { sampleOwnedHostIdentity } from "../packages/terminfo.dev/src/disposable-receipt.ts"

const os = process.argv[2]
if (os === undefined || os === "") {
  throw new Error("owned-host-identity: missing os argument; usage: bun scripts/owned-host-identity.ts <os>")
}
process.stdout.write(JSON.stringify(sampleOwnedHostIdentity(os)))
