/**
 * Which stream the inline collector writes its probe queries to.
 *
 * `--output` puts the run JSON in a FILE, so this process's own stdout is free to be the probe's
 * terminal — and it IS the terminal the user launched us in, which is what the owned-terminal arm
 * verifies (fd0, the selected output and the `ps` tty must be one device). Opening /dev/tty
 * instead breaks that on Darwin twice over: /dev/tty is a magic device whose identity never equals
 * the pty, and a WriteStream built from a raw fd reports no numeric fd under Node, which
 * `selectedFd` refuses (#28553). `--json` keeps the controlling terminal because stdout carries
 * the JSON there.
 */
import { openControllingTTY } from "./tty.ts"

export interface ProbeOutputStreamDeps {
  stdout: NodeJS.WriteStream
  openControllingTerminal: () => NodeJS.WriteStream
}

export function probeOutputStream(
  opts: { json?: boolean; output?: string },
  deps: ProbeOutputStreamDeps = { stdout: process.stdout, openControllingTerminal: openControllingTTY },
): NodeJS.WriteStream | undefined {
  // --json: stdout carries the JSON, so the probe talks to the controlling terminal.
  if (opts.json) return deps.openControllingTerminal()
  // --output: the JSON goes to a FILE, so this process's own stdout is the probe's terminal whenever
  // it is one. That is the device the owned-terminal arm verifies; /dev/tty is not (see #28553).
  if (opts.output !== undefined) {
    return deps.stdout.isTTY ? deps.stdout : deps.openControllingTerminal()
  }
  // Plain `test`: the collector's own default (process.stdout) applies.
  return undefined
}
