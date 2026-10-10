/**
 * @failure A hosted measurement workflow launches the collector without exporting TERMINFO_RUN_ID, so
 *   the owned-terminal arm refuses every run with an empty launch id and the whole matrix dies at collect.
 * @level l2
 * @consumer The GitHub-hosted macOS and Windows measurement collectors (27917).
 * @reach fs-walk .github/workflows/macos-measurement.yml .github/workflows/windows-measurement.yml
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"

const root = join(import.meta.dirname, "..")

// serve.ts passes `process.env.TERMINFO_RUN_ID ?? ""` into createOwnedTerminal, which rejects anything
// that is not 32 lowercase hex; the run id exists only after the receipt is emitted, so the workflow must
// read it inside the launched command — after the collector-ready wait and before the collector call.
test("hosted measurement workflows export the launch run id inside the collector command", () => {
  const macos = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const readyAt = macos.indexOf("collector-ready")
  const exportAt = macos.indexOf("export TERMINFO_RUN_ID")
  const collectorAt = macos.indexOf('"$COLLECTOR" test')
  expect(readyAt, "macOS workflow waits for the receipt").toBeGreaterThan(-1)
  expect(exportAt, "macOS workflow exports TERMINFO_RUN_ID").toBeGreaterThan(readyAt)
  expect(collectorAt, "macOS workflow invokes the collector").toBeGreaterThan(exportAt)

  const windows = readFileSync(join(root, ".github/workflows/windows-measurement.yml"), "utf8")
  const winReadyAt = windows.indexOf("collector-ready")
  const winExportAt = windows.indexOf("\\$env:TERMINFO_RUN_ID = ")
  const winCollectorAt = windows.indexOf("& terminfo test")
  expect(winReadyAt, "Windows workflow waits for the receipt").toBeGreaterThan(-1)
  expect(winExportAt, "Windows workflow sets TERMINFO_RUN_ID").toBeGreaterThan(winReadyAt)
  expect(winCollectorAt, "Windows workflow invokes the collector").toBeGreaterThan(winExportAt)
})

/**
 * @failure The macOS workflow redirects the collector's stdout into collector.log, so the collector
 *   loses the terminal: serve.ts writes every probe query to process.stdout, and the darwinHosted arm
 *   binds fd0, stdout and the controlling tty as one PTY, so a redirected stdout makes that binding
 *   impossible and every hosted macOS job dies at collect with "Owned output is not a real TTY
 *   stream" or "Hosted Darwin input, selected output and controlling TTY device identities differ".
 * @level l2
 * @consumer The GitHub-hosted macOS measurement collector (27917 / cause b7580050, 28533).
 * @reach fs-walk .github/workflows/macos-measurement.yml
 * @testonly none
 */
test("the macOS collector keeps stdout on the terminal and sends only stderr to the log", () => {
  const macos = readFileSync(join(root, ".github/workflows/macos-measurement.yml"), "utf8")
  const line = macos.split("\n").find((candidate) => candidate.includes('"$COLLECTOR" test')) ?? ""
  expect(line, "the macOS collector launch line exists").not.toBe("")
  // A stdout redirect is the defect: the collector's probe queries go to stdout, and the owned-terminal
  // arm verifies stdout is the same PTY as fd0 and the ps tty. Only stderr may go to collector.log.
  expect(line, "stdout must stay on the terminal, never redirected to collector.log").not.toMatch(
    /(^|[^0-9])>\s*"\$OUT\/collector\.log"/,
  )
  expect(line, "stderr still reaches the collector.log artifact").toMatch(/\b2>\s*"\$OUT\/collector\.log"/)
})
