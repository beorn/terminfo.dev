/**
 * Submit command — probe this terminal and submit results to terminfo.dev.
 *
 * Flow: confirm terminal info -> run inline probes -> submit via GitHub issue.
 */

export async function handleSubmit(opts: { terminalName?: string; terminalVersion?: string }): Promise<void> {
  const { detectTerminal } = await import("../../terminfo.dev/src/detect.ts")
  const { ALL_PROBES } = await import("../../terminfo.dev/src/probes/unified.ts")
  const { withRawMode, drainStdin } = await import("../../terminfo.dev/src/tty.ts")
  const { submitResults } = await import("../../terminfo.dev/src/submit.ts")

  // Confirm details BEFORE probes (stdin is still clean)
  const terminal = detectTerminal()
  let name = opts.terminalName ?? terminal.name
  let version = opts.terminalVersion ?? terminal.version

  /** OSC 8 hyperlink */
  function link(url: string, text: string): string {
    return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
  }

  const siteLink = link("https://terminfo.dev", "terminfo.dev")
  console.log(`${siteLink} — can your terminal do that?\n`)
  console.log(`  Terminal:  ${terminal.name}${terminal.version ? ` ${terminal.version}` : ""}`)
  console.log(`  Platform:  ${terminal.os} ${terminal.osVersion}`)
  console.log(
    `  Probes:    ${ALL_PROBES.length} features across ${new Set(ALL_PROBES.map((p) => p.id.split(".")[0])).size} categories`,
  )
  console.log(`  Website:   ${link("https://terminfo.dev", "https://terminfo.dev")}`)
  console.log("")

  // Let user confirm/edit terminal info before running probes
  const { createInterface } = await import("node:readline")

  async function ask(question: string, defaultValue: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return new Promise((resolve) => {
      rl.question(`  ${question} [${defaultValue}]: `, (answer) => {
        rl.close()
        resolve(answer.trim() || defaultValue)
      })
    })
  }

  name = await ask("Terminal name", name)
  version = await ask("Terminal version", version || "unknown")
  if (version === "unknown") version = ""

  console.log(``)
  console.log(`  Submitting as ${name}${version ? ` ${version}` : ""} on ${terminal.os}`)

  const rl2 = createInterface({ input: process.stdin, output: process.stdout })
  await new Promise<void>((resolve) => {
    rl2.question(`  Press Enter to run probes (Ctrl+C to cancel) `, () => {
      rl2.close()
      resolve()
    })
  })

  // Run probes
  const results: Record<string, boolean> = {}
  const notes: Record<string, string> = {}
  const responses: Record<string, string> = {}
  let passed = 0

  process.stdout.write("\x1b7")

  await withRawMode(async () => {
    for (const probe of ALL_PROBES) {
      try {
        const result = await probe.run()
        results[probe.id] = result.pass
        if (result.note) notes[probe.id] = result.note
        if (result.response) responses[probe.id] = result.response
        if (result.pass) passed++
      } catch (err) {
        results[probe.id] = false
        notes[probe.id] = `error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    await drainStdin(1000)
  })

  process.stdout.write("\x1b8")
  process.stdout.write("\x1bc")

  const total = ALL_PROBES.length
  const pct = Math.round((passed / total) * 100)
  console.log(`\n  Score: ${passed}/${total} (${pct}%)`)

  console.log(`\nSubmitting results to terminfo.dev...`)
  const url = await submitResults({
    terminal: name,
    terminalVersion: version,
    os: terminal.os,
    osVersion: terminal.osVersion,
    results,
    notes,
    responses,
    generated: new Date().toISOString(),
    cliVersion: "4.0.0",
    probeCount: ALL_PROBES.length,
  })
  if (url) {
    console.log(`+ Issue created: ${link(url, url)}`)
  }
}
