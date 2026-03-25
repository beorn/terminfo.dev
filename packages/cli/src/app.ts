/**
 * App probe mechanism — launch macOS terminal apps and run the harness inside them.
 *
 * Delegates to the existing app-runner.ts which handles AppleScript automation,
 * harness launching, result collection, and caching.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { fromPerBackendFiles, type CensusData } from "../parse.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const RESULTS_DIR = join(ROOT, "content", "probes-apps")
const HARNESS_PATH = join(__dirname, "..", "app-harness.ts")
const TMP_DIR = "/tmp/terminfo-census"

// ── App definitions ──

interface AppDef {
  name: string
  backendId: string
  appName: string
  appPath: string
  bundleId: string
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

function writeWrapperScript(outputPath: string): string {
  const wrapperPath = join(TMP_DIR, "run-harness.sh")
  mkdirSync(TMP_DIR, { recursive: true })
  writeFileSync(wrapperPath, ["#!/bin/bash", `exec bun "${HARNESS_PATH}" "${outputPath}" 2>/dev/null`].join("\n"))
  execSync(`chmod +x "${wrapperPath}"`)
  return wrapperPath
}

function runAppleScript(script: string): void {
  const scriptPath = join(TMP_DIR, "launch.scpt")
  writeFileSync(scriptPath, script)
  execSync(`osascript "${scriptPath}"`, { timeout: 15_000 })
}

function launchInApp(app: AppDef, outputPath: string): void {
  const wrapperPath = writeWrapperScript(outputPath)

  switch (app.launcher) {
    case "iterm2":
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
    case "terminal-app":
      runAppleScript(
        ['tell application "Terminal"', "  activate", `  do script "${wrapperPath}; exit"`, "end tell"].join("\n"),
      )
      break
    case "kitty":
      try {
        execSync(`open -na kitty --args bash "${wrapperPath}"`)
      } catch {
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
    case "ghostty":
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
    case "warp":
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

// ── Wait for harness completion ──

async function waitForCompletion(outputPath: string, timeoutMs: number = 30_000): Promise<boolean> {
  const donePath = outputPath + ".done"
  const deadline = Date.now() + timeoutMs
  const pollInterval = 250

  while (Date.now() < deadline) {
    if (existsSync(donePath)) {
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

  if (!opts.force && isCacheValid(resultPath, hash)) {
    return { success: true, skipped: true }
  }

  if (!existsSync(app.appPath)) {
    return { success: false, error: `${app.name} not installed at ${app.appPath}` }
  }

  mkdirSync(TMP_DIR, { recursive: true })
  const outputPath = join(TMP_DIR, `${app.backendId}.json`)

  try {
    unlinkSync(outputPath)
  } catch {}
  try {
    unlinkSync(outputPath + ".done")
  } catch {}

  console.log(`  Launching ${app.name}...`)
  try {
    launchInApp(app, outputPath)
  } catch (e: any) {
    return { success: false, error: `Failed to launch: ${e.message}` }
  }

  console.log(`  Waiting for harness to complete...`)
  const completed = await waitForCompletion(outputPath, 60_000)

  if (!completed) {
    return { success: false, error: "Timed out waiting for harness (60s)" }
  }

  if (!existsSync(outputPath)) {
    return { success: false, error: "No output file from harness" }
  }

  try {
    const rawData = JSON.parse(readFileSync(outputPath, "utf-8")) as any
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

    const resultFilenameWithOs = `${app.backendId}-${version}-macos.json`
    const appResultPath = join(RESULTS_DIR, resultFilenameWithOs)
    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(appResultPath, JSON.stringify(appResult, null, 2))

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

  for (const file of allJsonFiles) {
    try {
      const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf-8")) as any
      if (data.backend?.endsWith("-app") && data.results) {
        perBackend.push(data as (typeof perBackend)[0])
      }
    } catch {}
  }

  if (perBackend.length === 0) return null

  const latest = new Map<string, (typeof perBackend)[0]>()
  for (const e of perBackend) {
    const existing = latest.get(e.backend)
    if (!existing || e.generated > existing.generated) latest.set(e.backend, e)
  }

  return fromPerBackendFiles([...latest.values()])
}

function printAppReport(data: CensusData): void {
  const colWidth = Math.max(6, ...data.backendNames.map((n) => n.length)) + 2
  const featureWidth = 30

  console.log(`  ${"Feature".padEnd(featureWidth)}${data.backendNames.map((n) => n.padStart(colWidth)).join("")}`)
  console.log(`  ${"-".repeat(featureWidth)}${data.backendNames.map(() => "-".repeat(colWidth)).join("")}`)

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

export async function handleApp(
  terminal: string | undefined,
  opts: { all?: boolean; force?: boolean },
): Promise<void> {
  if (!terminal && !opts.all) {
    // Bare: list available apps
    console.log("\nAvailable terminal apps:\n")
    for (const app of APPS) {
      const installed = existsSync(app.appPath)
      const version = installed ? getAppVersion(app) : "not installed"
      console.log(`  ${installed ? "+" : "-"} ${app.name.padEnd(16)} ${app.backendId.padEnd(16)} ${version}`)
    }
    console.log(`\nProbe all: \x1b[1mterminfo probe app --all\x1b[0m`)
    console.log(`Probe one: \x1b[1mterminfo probe app ghostty\x1b[0m`)
    return
  }

  // Filter apps
  let appsToRun = APPS
  if (terminal) {
    const name = terminal.toLowerCase()
    appsToRun = APPS.filter(
      (app) => app.backendId === name || app.name.toLowerCase() === name || app.launcher === name,
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
  console.log(`\nApp probes (hash: ${hash})\n`)
  console.log(`Apps to test: ${appsToRun.map((a) => a.name).join(", ")}\n`)

  const runResults: Array<{ app: AppDef; result: Awaited<ReturnType<typeof runApp>> }> = []

  for (const app of appsToRun) {
    console.log(`\n--- ${app.name} ---`)
    const result = await runApp(app, { force: opts.force })
    runResults.push({ app, result })

    if (result.skipped) {
      console.log(`  Cached (hash matches). Use --force to re-run.`)
    } else if (!result.success) {
      console.log(`  FAILED: ${result.error}`)
    }

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
