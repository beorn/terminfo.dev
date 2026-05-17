/**
 * Detect command — identify the current terminal emulator.
 */

export async function handleDetect(opts: { json?: boolean }): Promise<void> {
  const { detectTerminal } = await import("terminfo.dev/src/detect.ts")
  const terminal = detectTerminal()

  if (opts.json) {
    // Structured output for piping
    console.log(JSON.stringify(terminal, null, 2))
    return
  }

  console.log("\nterminfo detect\n")
  console.log(`  Terminal:  ${terminal.name}${terminal.version ? ` ${terminal.version}` : ""}`)
  console.log(`  OS:        ${terminal.os} ${terminal.osVersion}`)
}
