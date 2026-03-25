#!/usr/bin/env bun
/**
 * App census harness — runs INSIDE a real terminal app.
 *
 * This script is launched by app-runner.ts inside each macOS terminal app
 * (Ghostty, iTerm2, Terminal.app, kitty, Warp). It runs the same probes as
 * the serve daemon (`cli/src/probes/index.ts`) — feeding escape sequences
 * to stdout and reading terminal responses from stdin to test what the REAL
 * terminal actually supports.
 *
 * Output: JSON to a temp file (path from argv[2]) in PerBackendFile format.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { ALL_PROBES } from "../../cli/src/probes/index.ts"
import { withRawMode, drainStdin } from "../../cli/src/tty.ts"

// ── Main ──

async function main(): Promise<void> {
  const outputPath = process.argv[2]
  if (!outputPath) {
    console.error("Usage: app-harness.ts <output-path>")
    process.exit(1)
  }

  // Compute probe hash from the shared probe definitions
  const probesPath = new URL("../../cli/src/probes/index.ts", import.meta.url).pathname
  const probesContent = readFileSync(probesPath)
  const probeHash = createHash("md5").update(probesContent).digest("hex").slice(0, 12)

  const results: Record<string, boolean> = {}
  const notes: Record<string, string> = {}
  const responses: Record<string, string> = {}

  await withRawMode(async () => {
    // Warm up — some terminals need a moment after raw mode
    await new Promise((r) => setTimeout(r, 200))
    await drainStdin(300)

    for (const probe of ALL_PROBES) {
      // Clear screen between probes for clean state
      process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
      try {
        const result = await probe.run()
        results[probe.id] = result.pass
        if (result.note) notes[probe.id] = result.note
        if (result.response) responses[probe.id] = result.response
      } catch (err) {
        results[probe.id] = false
        notes[probe.id] = `error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // Final drain + clear
    process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
    await drainStdin(1000)
  })

  // Reset terminal
  process.stdout.write("\x1bc")

  // Build result in PerBackendFile format
  // The backend name and version will be filled in by app-runner.ts
  const output = {
    backend: "__APP__",
    version: "__VERSION__",
    generated: new Date().toISOString(),
    probeHash,
    results,
    ...(Object.keys(notes).length > 0 ? { notes } : {}),
    ...(Object.keys(responses).length > 0 ? { responses } : {}),
  }

  writeFileSync(outputPath, JSON.stringify(output, null, 2))

  // Write a done marker so the runner knows we finished
  writeFileSync(outputPath + ".done", "")
}

await main()
