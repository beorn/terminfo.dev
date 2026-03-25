#!/usr/bin/env bun
/**
 * App census runner — launches real macOS terminal apps and runs the harness
 * inside each one to collect capability data.
 *
 * For each terminal app:
 * 1. Open the app via `open -a`
 * 2. Use osascript to tell it to run the harness script
 * 3. Wait for the harness to finish (watch for .done marker file)
 * 4. Read the JSON results and save as a per-backend result file
 *
 * Usage:
 *   bun packages/cli/app-runner.ts                    # Run all available apps
 *   bun packages/cli/app-runner.ts ghostty iterm2     # Run specific apps
 *   bun packages/cli/app-runner.ts --list             # List available apps
 *   bun packages/cli/app-runner.ts --force            # Re-run even if cached
 *
 * Results are saved to content/probes-apps/.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { fromPerBackendFiles, type CensusData } from "./parse.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..")
const RESULTS_DIR = join(ROOT, "content", "probes-apps")
const HARNESS_PATH = join(__dirname, "app-harness.ts")
const TMP_DIR = "/tmp/terminfo-census"

// ── App definitions ──

interface AppDef {
  /** Display name */
  name: string
  /** Backend ID used in result files */
  backendId: string
  /** macOS app name for `open -a` */
  appName: string
  /** App path to check existence */
  appPath: string
  /** Bundle identifier */
  bundleId: string
  /** How to send a command to this terminal */
  launcher: "iterm2" | "terminal-app" | "kitty" | "ghostty" | "warp"
}

const APPS: AppDef[] = [
  {
    name: "Ghostty",
    backendId: "ghostty-app",
    appName: "Ghostty",
    appPath: "/Applications/Ghostty.app",
    bundleId: "com.mitchellh.ghostty",
    launcher: "ghostty",
  },
  {
    name: "iTerm2",
    backendId: "iterm2-app",
    appName: "iTerm",
    appPath: "/Applications/iTerm.app",
    bundleId: "com.googlecode.iterm2",
    launcher: "iterm2",
  },
  {
    name: "Terminal.app",
    backendId: "terminal-app",
    appName: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    bundleId: "com.apple.Terminal",
    launcher: "terminal-app",
  },
  {
    name: "kitty",
    backendId: "kitty-app",
    appName: "kitty",
    appPath: "/Applications/kitty.app",
    bundleId: "net.kovidgoyal.kitty",
    launcher: "kitty",
  },
  {
    name: "Warp",
    backendId: "warp-app",
    appName: "Warp",
    appPath: "/Applications/Warp.app",
    bundleId: "dev.warp.Warp-Stable",
    launcher: "warp",
  },
]

// ── Version detection ──

function getAppVersion(app: AppDef): string {
  try {
    const plistPath = join(app.appPath, "Contents", "Info.plist")
    const version = execSync(
      `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${plistPath}" 2>/dev/null`,
      { encoding: "utf8" },
    ).trim()
    return version || "unknown"
  } catch {
    return "unknown"
  }
}

// ── Probe hash ──

function appProbeHash(): string {
  const hash = createHash("md5")
  hash.update(readFileSync(HARNESS_PATH))
  return hash.digest("hex").slice(0, 12)
}

// ── Launch harness in terminal app ──

/**
 * Write a shell wrapper script that runs the harness.
 * This avoids quoting issues when embedding commands in AppleScript.
 */
function writeWrapperScript(outputPath: string): string {
  const wrapperPath = join(TMP_DIR, "run-harness.sh")
  mkdirSync(TMP_DIR, { recursive: true })
  writeFileSync(wrapperPath, ["#!/bin/bash", `exec bun "${HARNESS_PATH}" "${outputPath}" 2>/dev/null`].join("\n"))
  execSync(`chmod +x "${wrapperPath}"`)
  return wrapperPath
}

/**
 * Execute an AppleScript by writing it to a temp file.
 * Avoids all quoting issues vs inline `-e`.
 */
function runAppleScript(script: string): void {
  const scriptPath = join(TMP_DIR, "launch.scpt")
  writeFileSync(scriptPath, script)
  execSync(`osascript "${scriptPath}"`, { timeout: 15_000 })
}

/**
 * Launch the harness inside a terminal app. Each app has its own AppleScript
 * incantation to open a new window and run a command.
 *
 * Strategy: write a shell wrapper script, then tell the terminal to execute it.
 * The wrapper avoids all quoting issues with paths.
 */
function launchInApp(app: AppDef, outputPath: string): void {
  const wrapperPath = writeWrapperScript(outputPath)

  switch (app.launcher) {
    case "iterm2": {
      // iTerm2 has native AppleScript support for `write text`
      runAppleScript(
        [
          'tell application "iTerm"',
          "  activate",
          "  set newWindow to (create window with default profile)",
          "  tell current session of newWindow",
          `    write text "${wrapperPath}; exit"`,
          "  end tell",
          "end tell",
        ].join("\n"),
      )
      break
    }

    case "terminal-app": {
      // Terminal.app has `do script`
      runAppleScript(
        ['tell application "Terminal"', "  activate", `  do script "${wrapperPath}; exit"`, "end tell"].join("\n"),
      )
      break
    }

    case "kitty": {
      // kitty: use `open -a` with --args to run the wrapper directly
      try {
        execSync(`open -na kitty --args bash "${wrapperPath}"`)
      } catch {
        // Fallback: activate and type the command
        runAppleScript(
          [
            'tell application "kitty"',
            "  activate",
            "end tell",
            "delay 0.5",
            'tell application "System Events"',
            '  tell process "kitty"',
            '    keystroke "n" using command down',
            "  end tell",
            "end tell",
            "delay 0.5",
            'tell application "System Events"',
            '  tell process "kitty"',
            `    keystroke "${wrapperPath}; exit"`,
            "    key code 36",
            "  end tell",
            "end tell",
          ].join("\n"),
        )
      }
      break
    }

    case "ghostty": {
      // Ghostty: open new window via Cmd+N, type command
      runAppleScript(
        [
          'tell application "Ghostty"',
          "  activate",
          "end tell",
          "delay 0.5",
          'tell application "System Events"',
          '  tell process "Ghostty"',
          '    keystroke "n" using command down',
          "  end tell",
          "end tell",
          "delay 0.5",
          'tell application "System Events"',
          '  tell process "Ghostty"',
          `    keystroke "${wrapperPath}; exit"`,
          "    key code 36",
          "  end tell",
          "end tell",
        ].join("\n"),
      )
      break
    }

    case "warp": {
      // Warp: open new window, type command
      runAppleScript(
        [
          'tell application "Warp"',
          "  activate",
          "end tell",
          "delay 1",
          'tell application "System Events"',
          '  tell process "Warp"',
          '    keystroke "n" using command down',
          "  end tell",
          "end tell",
          "delay 1",
          'tell application "System Events"',
          '  tell process "Warp"',
          `    keystroke "${wrapperPath}; exit"`,
          "    key code 36",
          "  end tell",
          "end tell",
        ].join("\n"),
      )
      break
    }
  }
}

// ── Wait for harness completion ──

async function waitForCompletion(outputPath: string, timeoutMs: number = 30_000): Promise<boolean> {
  const donePath = outputPath + ".done"
  const deadline = Date.now() + timeoutMs
  const pollInterval = 250

  while (Date.now() < deadline) {
    if (existsSync(donePath)) {
      // Clean up marker
      try {
        unlinkSync(donePath)
      } catch {}
      return true
    }
    await new Promise((r) => setTimeout(r, pollInterval))
  }

  return false
}

// ── Cache check ──

function isCacheValid(resultPath: string, hash: string): boolean {
  if (!existsSync(resultPath)) return false
  try {
    const data = JSON.parse(readFileSync(resultPath, "utf-8")) as any
    return data.probeHash === hash
  } catch {
    return false
  }
}

// ── Run one app ──

async function runApp(
  app: AppDef,
  opts: { force?: boolean },
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const version = getAppVersion(app)
  const hash = appProbeHash()
  const resultFilename = `${app.backendId}-${version}-macos.json`
  const resultPath = join(RESULTS_DIR, resultFilename)

  // Check cache
  if (!opts.force && isCacheValid(resultPath, hash)) {
    return { success: true, skipped: true }
  }

  // Check app exists
  if (!existsSync(app.appPath)) {
    return { success: false, error: `${app.name} not installed at ${app.appPath}` }
  }

  // Set up temp output path
  mkdirSync(TMP_DIR, { recursive: true })
  const outputPath = join(TMP_DIR, `${app.backendId}.json`)

  // Clean up any stale files
  try {
    unlinkSync(outputPath)
  } catch {}
  try {
    unlinkSync(outputPath + ".done")
  } catch {}

  // Launch harness in the terminal
  console.log(`  Launching ${app.name}...`)
  try {
    launchInApp(app, outputPath)
  } catch (e: any) {
    return { success: false, error: `Failed to launch: ${e.message}` }
  }

  // Wait for completion
  console.log(`  Waiting for harness to complete...`)
  const completed = await waitForCompletion(outputPath, 60_000)

  if (!completed) {
    return { success: false, error: "Timed out waiting for harness (60s)" }
  }

  // Read results
  if (!existsSync(outputPath)) {
    return { success: false, error: "No output file from harness" }
  }

  try {
    const rawData = JSON.parse(readFileSync(outputPath, "utf-8")) as any

    // Convert to app result format (terminal/terminalVersion/os)
    const appResult: Record<string, any> = {
      terminal: app.backendId,
      terminalVersion: version,
      os: "macos",
      source: "app-runner",
      generated: rawData.generated ?? new Date().toISOString(),
      probeHash: rawData.probeHash,
      results: rawData.results,
    }
    if (rawData.notes && Object.keys(rawData.notes).length > 0) {
      appResult.notes = rawData.notes
    }
    if (rawData.responses && Object.keys(rawData.responses).length > 0) {
      appResult.responses = rawData.responses
    }

    // Save to results/app/ directory
    const resultFilenameWithOs = `${app.backendId}-${version}-macos.json`
    const appResultPath = join(RESULTS_DIR, resultFilenameWithOs)
    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(appResultPath, JSON.stringify(appResult, null, 2))

    // Count results
    const total = Object.keys(rawData.results).length
    const passed = Object.values(rawData.results).filter(Boolean).length
    console.log(`  ${passed}/${total} probes passed`)

    return { success: true }
  } catch (e: any) {
    return { success: false, error: `Failed to parse results: ${e.message}` }
  }
}

// ── Helpers for report ──

function loadAppResults(): CensusData | null {
  if (!existsSync(RESULTS_DIR)) return null

  const allJsonFiles = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"))
  if (allJsonFiles.length === 0) return null

  const perBackend: Array<{
    backend: string
    version: string
    generated: string
    results: Record<string, boolean>
    notes?: Record<string, string>
  }> = []

  // Load all app backend results (backendId contains "-app")
  for (const file of allJsonFiles) {
    try {
      const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf-8")) as any
      if (data.backend?.endsWith("-app") && data.results) {
        perBackend.push(data as (typeof perBackend)[0])
      }
    } catch {}
  }

  if (perBackend.length === 0) return null

  // Keep only the latest per backend
  const latest = new Map<string, (typeof perBackend)[0]>()
  for (const e of perBackend) {
    const existing = latest.get(e.backend)
    if (!existing || e.generated > existing.generated) latest.set(e.backend, e)
  }

  return fromPerBackendFiles([...latest.values()])
}

/** Print a simple text report for app census results (no silvery rendering). */
function printAppReport(data: CensusData): void {
  const colWidth = Math.max(6, ...data.backendNames.map((n) => n.length)) + 2
  const featureWidth = 30

  // Header
  console.log(`  ${"Feature".padEnd(featureWidth)}${data.backendNames.map((n) => n.padStart(colWidth)).join("")}`)
  console.log(`  ${"-".repeat(featureWidth)}${data.backendNames.map(() => "-".repeat(colWidth)).join("")}`)

  // Per-category results
  for (const [cat, ids] of data.categories) {
    console.log(`\n  ${cat}:`)
    for (const id of ids) {
      const suffix = id.slice(cat.length + 1)
      const cells = data.backendNames.map((name) => {
        const pass = data.results.get(name)?.get(id) ?? false
        return (pass ? "  Y" : "  -").padStart(colWidth)
      })
      console.log(`    ${suffix.padEnd(featureWidth - 2)}${cells.join("")}`)
    }
  }

  // Per-backend totals
  console.log(
    `\n  ${"TOTAL".padEnd(featureWidth)}${data.backendNames
      .map((name) => {
        const features = data.results.get(name)!
        let yes = 0
        for (const r of features.values()) if (r) yes++
        const pct = Math.round((yes / (features.size || 1)) * 100)
        return `${yes}/${features.size} ${pct}%`.padStart(colWidth)
      })
      .join("")}`,
  )
  console.log("")
}

function printNotes(data: CensusData) {
  let hasNotes = false
  for (const name of data.backendNames) {
    const backendNotes = data.notes.get(name)
    if (!backendNotes || backendNotes.size === 0) continue
    if (!hasNotes) {
      console.log("\nNotes:\n")
      hasNotes = true
    }
    console.log(`  ${name}:`)
    for (const [feature, note] of backendNotes) {
      console.log(`    ${feature.padEnd(32)} ${note}`)
    }
  }
  if (hasNotes) console.log("")
}

// ── Main ──

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Parse flags
  const force = args.includes("--force")
  const listOnly = args.includes("--list")
  const filterArgs = args.filter((a) => !a.startsWith("--"))

  // List mode
  if (listOnly) {
    console.log("\nAvailable terminal apps:\n")
    for (const app of APPS) {
      const installed = existsSync(app.appPath)
      const version = installed ? getAppVersion(app) : "not installed"
      console.log(`  ${installed ? "+" : "-"} ${app.name.padEnd(16)} ${app.backendId.padEnd(16)} ${version}`)
    }
    console.log("")
    return
  }

  // Filter apps
  let appsToRun = APPS
  if (filterArgs.length > 0) {
    const names = new Set(filterArgs.map((a) => a.toLowerCase()))
    appsToRun = APPS.filter(
      (app) => names.has(app.backendId) || names.has(app.name.toLowerCase()) || names.has(app.launcher),
    )
    if (appsToRun.length === 0) {
      console.error(`No matching apps. Available: ${APPS.map((a) => a.backendId).join(", ")}`)
      process.exit(1)
    }
  }

  // Filter to installed only
  appsToRun = appsToRun.filter((app) => {
    if (!existsSync(app.appPath)) {
      console.log(`  Skipping ${app.name} (not installed)`)
      return false
    }
    return true
  })

  if (appsToRun.length === 0) {
    console.error("No terminal apps available to test.")
    process.exit(1)
  }

  const hash = appProbeHash()
  console.log(`\nApp census (probe hash: ${hash})\n`)
  console.log(`Apps to test: ${appsToRun.map((a) => a.name).join(", ")}\n`)

  // Run each app sequentially (we're automating real GUI apps)
  const runResults: Array<{ app: AppDef; result: Awaited<ReturnType<typeof runApp>> }> = []

  for (const app of appsToRun) {
    console.log(`\n--- ${app.name} ---`)
    const result = await runApp(app, { force })
    runResults.push({ app, result })

    if (result.skipped) {
      console.log(`  Cached (hash matches). Use --force to re-run.`)
    } else if (!result.success) {
      console.log(`  FAILED: ${result.error}`)
    }

    // Brief pause between apps to avoid macOS UI confusion
    if (appsToRun.indexOf(app) < appsToRun.length - 1) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  // Summary
  console.log("\n\n=== Summary ===\n")
  for (const { app, result } of runResults) {
    const status = result.skipped ? "cached" : result.success ? "OK" : `FAIL: ${result.error}`
    console.log(`  ${app.name.padEnd(16)} ${status}`)
  }

  // Show report for app results
  const data = loadAppResults()
  if (data) {
    console.log("")
    printAppReport(data)
    printNotes(data)
  }
}

await main()
