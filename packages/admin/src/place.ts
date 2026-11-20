/** `terminfo place`: place a retained run that collection kept, with an exact-count downgrade override (#37245). */
import { resolve } from "node:path"
import { placeAndStage } from "./collected-run.ts"

export function handlePlace(run: string, opts: { acceptDowngrades?: string; reason?: string }): void {
  if (opts.reason !== undefined && opts.acceptDowngrades === undefined) {
    throw new Error("--reason is the reason for --accept-downgrades; give the count too")
  }
  let accept: { count: number; reason: string } | undefined
  if (opts.acceptDowngrades !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(opts.acceptDowngrades)) {
      throw new Error(`--accept-downgrades takes a whole number, not ${opts.acceptDowngrades}`)
    }
    accept = { count: Number(opts.acceptDowngrades), reason: opts.reason ?? "" }
  }
  placeAndStage(resolve(run), accept)
}
