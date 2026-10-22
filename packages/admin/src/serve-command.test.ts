/**
 * @failure A launch hands its collector a capture directory no recipe declared, or the two launchers
 *          drift on the serve command's identity variables.
 * @level l1
 * @consumer The owned app route and the mux route, through the one builder both call.
 * @testonly none
 * @reach none <fixture-only: no process, no filesystem>
 */
import { expect, test, vi } from "vitest"
import type { ProbeRun } from "../../terminfo.dev/src/daemon-client.ts"
import { serveCommand } from "./serve-command.ts"

vi.mock("../versions.ts", () => ({
  sourceSuiteEnvironment: () => ({ TERMINFO_PROBE_HASH: "suite", TERMINFO_SOURCE_REVISION: "source" }),
}))

const run: ProbeRun = { id: "run-1", directory: "/private/run", scriptPath: "/private/run/serve.sh" }

test("the serve command carries run and suite identity, and a capture directory only when one is handed in", () => {
  // No recipe declares a capture route here, so nothing is retained and no arm is asked for a frame.
  const plain = serveCommand(run)
  expect(plain).toMatch(
    /^TERMINFO_RUN_ID=run-1 TERMINFO_PROBE_HASH=suite TERMINFO_SOURCE_REVISION=source exec '.+' '.+\/packages\/admin\/src\/index\.ts' probe server --start$/,
  )
  expect(plain).not.toContain("TERMINFO_CAPTURE_DIRECTORY")
  expect(serveCommand(run, "/private/run/artifacts")).toContain("TERMINFO_CAPTURE_DIRECTORY='/private/run/artifacts'")
})
