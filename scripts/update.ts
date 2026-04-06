#!/usr/bin/env bun
/**
 * Unified pipeline runner for terminfo.dev refresh cycle.
 *
 * Orchestrates: staleness check → explore → radar → probe → validate → build → 404s.
 *
 * Usage:
 *   bun scripts/update.ts                    # Same as --status
 *   bun scripts/update.ts --status           # Check what's stale
 *   bun scripts/update.ts --discover         # Run explore + show radar stats
 *   bun scripts/update.ts --probe            # Re-probe all headless backends
 *   bun scripts/update.ts --validate         # Validate + build + check-404s
 *   bun scripts/update.ts --full             # Run all steps with human checkpoints
 *   bun scripts/update.ts --full --no-pause  # Run all steps without pausing
 */

import { spawnSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const siteRoot = join(__dirname, "..")
const kmRoot = join(siteRoot, "../..")

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StepResult {
  name: string
  ok: boolean
  skipped?: boolean
}

function header(step: number, name: string): void {
  console.log(`\n${BOLD}${CYAN}=== Step ${step}: ${name} ===${RESET}\n`)
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): { ok: boolean; code: number } {
  const cwd = opts.cwd ?? siteRoot
  console.log(`${DIM}$ ${cmd} ${args.join(" ")}${RESET}`)
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env },
  })
  const code = result.status ?? 1
  return { ok: code === 0, code }
}

async function pause(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`\n${YELLOW}${message}${RESET} `, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() !== "n")
    })
  })
}

async function askContinue(stepName: string): Promise<boolean> {
  return pause(`Step "${stepName}" failed. Continue anyway? [Y/n]`)
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepStaleness(): Promise<StepResult> {
  header(1, "Check staleness")
  const { ok } = runCommand("bun", ["sitefile", "--check"])
  return { name: "staleness", ok }
}

async function stepExplore(): Promise<StepResult> {
  header(2, "Run explore queries")
  const { ok } = runCommand("bun", ["run", "explore"])
  return { name: "explore", ok }
}

async function stepRadar(): Promise<StepResult> {
  header(3, "Show radar stats")
  const { ok } = runCommand("bun", ["run", "radar", "stats"])
  return { name: "radar", ok }
}

async function stepPause(): Promise<StepResult> {
  header(4, "Review checkpoint")
  const cont = await pause("Review radar findings. Press Enter to continue, or Ctrl+C to stop.")
  return { name: "pause", ok: cont }
}

async function stepProbe(): Promise<StepResult> {
  header(5, "Re-probe headless backends")
  const { ok } = runCommand("bun", ["terminfo", "probe", "termless", "--all", "--force"], {
    cwd: kmRoot,
  })
  return { name: "probe", ok }
}

async function stepValidate(): Promise<StepResult> {
  header(6, "Validate content")
  const { ok } = runCommand("bun", ["validate"])
  return { name: "validate", ok }
}

async function stepBuild(): Promise<StepResult> {
  header(7, "Build site")
  const { ok } = runCommand("bun", ["run", "build"])
  return { name: "build", ok }
}

async function stepCheck404s(): Promise<StepResult> {
  header(8, "Check 404s")
  const { ok } = runCommand("bun", ["scripts/check-404s.ts"])
  return { name: "check-404s", ok }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(results: StepResult[]): void {
  console.log(`\n${BOLD}=== Summary ===${RESET}\n`)
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${DIM}SKIP${RESET}  ${r.name}`)
    } else if (r.ok) {
      console.log(`  ${GREEN}PASS${RESET}  ${r.name}`)
    } else {
      console.log(`  ${RED}FAIL${RESET}  ${r.name}`)
    }
  }

  const failed = results.filter((r) => !r.ok && !r.skipped)
  if (failed.length > 0) {
    console.log(`\n${RED}${failed.length} step(s) failed.${RESET}`)
  } else {
    console.log(`\n${GREEN}All steps passed.${RESET}`)
  }
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function runStep(
  step: () => Promise<StepResult>,
  results: StepResult[],
  noPause: boolean,
): Promise<boolean> {
  const result = await step()
  results.push(result)
  if (!result.ok && !result.skipped) {
    if (noPause) {
      console.log(`${RED}Step "${result.name}" failed — continuing (--no-pause).${RESET}`)
      return true
    }
    return askContinue(result.name)
  }
  return true
}

async function flowStatus(): Promise<void> {
  const results: StepResult[] = []
  await runStep(stepStaleness, results, true)
  await runStep(stepRadar, results, true)
  printSummary(results)
}

async function flowDiscover(): Promise<void> {
  const results: StepResult[] = []
  const noPause = true
  await runStep(stepStaleness, results, noPause)
  await runStep(stepExplore, results, noPause)
  await runStep(stepRadar, results, noPause)
  printSummary(results)
}

async function flowProbe(): Promise<void> {
  const results: StepResult[] = []
  await runStep(stepProbe, results, true)
  printSummary(results)
}

async function flowValidate(): Promise<void> {
  const results: StepResult[] = []
  const noPause = true
  await runStep(stepValidate, results, noPause)
  await runStep(stepBuild, results, noPause)
  await runStep(stepCheck404s, results, noPause)
  printSummary(results)
}

async function flowFull(noPause: boolean): Promise<void> {
  const results: StepResult[] = []

  if (!(await runStep(stepStaleness, results, noPause))) return printSummary(results)
  if (!(await runStep(stepExplore, results, noPause))) return printSummary(results)
  if (!(await runStep(stepRadar, results, noPause))) return printSummary(results)

  if (!noPause) {
    const pauseResult = await stepPause()
    results.push(pauseResult)
    if (!pauseResult.ok) return printSummary(results)
  } else {
    results.push({ name: "pause", ok: true, skipped: true })
  }

  if (!(await runStep(stepProbe, results, noPause))) return printSummary(results)
  if (!(await runStep(stepValidate, results, noPause))) return printSummary(results)
  if (!(await runStep(stepBuild, results, noPause))) return printSummary(results)
  if (!(await runStep(stepCheck404s, results, noPause))) return printSummary(results)

  printSummary(results)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const noPause = args.includes("--no-pause")

  console.log(`${BOLD}terminfo.dev update pipeline${RESET}`)
  console.log(`${DIM}site: ${siteRoot}${RESET}`)
  console.log(`${DIM}km:   ${kmRoot}${RESET}`)

  if (args.includes("--full")) {
    await flowFull(noPause)
  } else if (args.includes("--discover")) {
    await flowDiscover()
  } else if (args.includes("--probe")) {
    await flowProbe()
  } else if (args.includes("--validate")) {
    await flowValidate()
  } else {
    // Default: --status
    await flowStatus()
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err)
  process.exit(1)
})
