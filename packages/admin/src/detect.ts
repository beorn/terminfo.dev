/**
 * Detect command — identify the current terminal emulator.
 */

export async function handleDetect(opts: { json?: boolean }): Promise<void> {
  const { detectTerminal } = await import("../terminfo.dev/src/detect.ts")
  const terminal = detectTerminal()

  if (opts.json) {
    console.log(JSON.stringify(terminal, null, 2))
    return
  }

  console.log(`\n\x1b[1mterminfo detect\x1b[0m\n`)
  console.log(`  Terminal:  \x1b[1m${terminal.name}\x1b[0m${terminal.version ? ` ${terminal.version}` : ""}`)
  console.log(`  OS:        ${terminal.os} ${terminal.osVersion}`)
}
