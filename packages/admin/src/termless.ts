/**
 * Headless diagnostic runner. Vitest's pass booleans are legacy diagnostics,
 * never v2 observations or publishable content.
 */

import { dirname, join } from "node:path"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { backends as allBackendNames, entry } from "@termless/core"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")

/** Run the existing suite without allowing its legacy booleans into content/. */
export async function runTermlessProbes(selectors: string[], _opts: { force?: boolean }): Promise<void> {
  const headless = allBackendNames().filter((name) => entry(name)?.type !== "os")
  const osOnly = allBackendNames().filter((name) => entry(name)?.type === "os")
  if (osOnly.join(",") !== "peekaboo") {
    throw new Error("Unexpected OS-only backend disposition: " + osOnly.join(", "))
  }
  if (selectors.length > 0) {
    const unknown = selectors.filter((selector) => !headless.includes(selector))
    if (unknown.length > 0) throw new Error("Unknown headless backend selector(s): " + unknown.join(", "))
    throw new Error("Selected or versioned headless runs require the v2 collector; legacy boolean files are frozen")
  }

  const proc = Bun.spawn(
    ["bun", "vitest", "run", "--config", "packages/probes/vitest.config.ts", "--reporter", "json"],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const diagnosticDir = mkdtempSync(join(tmpdir(), "terminfo-headless-"))
  const stdoutPath = join(diagnosticDir, "vitest-stdout.json")
  const stderrPath = join(diagnosticDir, "vitest-stderr.txt")
  writeFileSync(stdoutPath, stdout)
  writeFileSync(stderrPath, stderr)
  const diagnosticPaths = `stdout=${stdoutPath} stderr=${stderrPath}`
  if (exitCode !== 0) {
    throw new Error(
      `Headless diagnostic Vitest exited ${exitCode}; no content was written. Raw process output: ${diagnosticPaths}`,
    )
  }
  if (!stdout.trim()) throw new Error(`Headless diagnostic Vitest exited 0 with empty JSON; ${diagnosticPaths}`)
  let report: unknown
  try {
    report = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`Headless diagnostic Vitest emitted invalid JSON: ${String(error)}; ${diagnosticPaths}`)
  }
  if (
    typeof report !== "object" ||
    report === null ||
    !("numTotalTests" in report) ||
    typeof report.numTotalTests !== "number" ||
    report.numTotalTests < 1
  ) {
    throw new Error(`Headless diagnostic Vitest reported no tests; no content was written; ${diagnosticPaths}`)
  }
  throw new Error(
    `Headless diagnostic completed ${report.numTotalTests} tests across ${headless.length} expected engines; ` +
      `peekaboo is OS automation. Vitest booleans are ungraded and no content was written. ` +
      `The v2 headless collector with loaded runtime identity is required for an admissible run. ${diagnosticPaths}`,
  )
}
