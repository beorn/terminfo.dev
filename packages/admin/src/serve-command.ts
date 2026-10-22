import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { shellQuote, type ProbeRun } from "../../terminfo.dev/src/daemon-client.ts"
import { sourceSuiteEnvironment } from "../versions.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const BUN = process.execPath // use the same bun that's running us
const CLI_ENTRY = join(ROOT, "packages", "admin", "src", "index.ts")

/**
 * The ONE serve command every launcher writes (#30518 D4.6/D5). Two copies of this string existed
 * (app.ts and mux.ts); one builder means the run identity, the suite identity and the capture
 * directory can never drift between the owned route and the mux route.
 *
 * `captureDirectory` is set only by a recipe that declares a ruled capture route, and it is the
 * artifact directory the launch receipt hands the collector (`serve.ts` reads it as
 * TERMINFO_CAPTURE_DIRECTORY). Passing nothing keeps today's behaviour exactly: the arm names the
 * absent adapter rather than retaining a frame it cannot keep.
 */
export function serveCommand(run: ProbeRun, captureDirectory?: string): string {
  const suite = sourceSuiteEnvironment()
  return [
    `TERMINFO_RUN_ID=${run.id}`,
    `TERMINFO_PROBE_HASH=${suite.TERMINFO_PROBE_HASH}`,
    `TERMINFO_SOURCE_REVISION=${suite.TERMINFO_SOURCE_REVISION}`,
    ...(captureDirectory === undefined ? [] : [`TERMINFO_CAPTURE_DIRECTORY=${shellQuote(captureDirectory)}`]),
    `exec ${shellQuote(BUN)} ${shellQuote(CLI_ENTRY)} probe server --start`,
  ].join(" ")
}
