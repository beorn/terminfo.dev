/** Private throwaway for #32566's pre-build stop point. Never a product grader. */
import { execFileSync } from "node:child_process"
import { readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type { ProbeCallbackResult, TermProbeSource } from "../types.ts"

const osc = (body: string) => `\x1b]${body}\x07`

export async function qualifyAppSemanticRead(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const commands: Array<{ argv: string[]; stdout: string }> = []
  const run = (argv: string[]): string => {
    const stdout = execFileSync(argv[0]!, argv.slice(1), {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    })
    commands.push({ argv, stdout })
    return stdout
  }
  const proc = (pid: number) => {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)
    return { pid, ppid: Number(fields[1]), nice: Number(fields[16]), raw }
  }
  const waitFor = async (read: () => string, matches: (value: string) => boolean, label: string): Promise<string> => {
    const deadline = Date.now() + 5000
    let last = ""
    do {
      last = read()
      if (matches(last)) return last
      await Bun.sleep(25)
    } while (Date.now() < deadline)
    writeFileSync(`/out/osc-qualification-${label}-timeout.txt`, last)
    throw new Error(`Private OSC qualification: ${label} completion not observed; raw bytes retained`)
  }
  const own = proc(process.pid)
  const targetStat = readFileSync("/out/target-process-stat.txt", "utf8")
  const targetFields = targetStat
    .slice(targetStat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)
  if (own.nice !== 10 || Number(targetFields[16]) !== 10) {
    throw new Error("Private OSC qualification requires actual collector and target nice10")
  }
  const nonce = randomUUID().slice(0, 8)
  const common = { privateQualification: true, runId: process.env.TERMINFO_RUN_ID, nonce, own, targetStat, commands }
  let evidence: Record<string, unknown>

  if (process.env.TERMINFO_MUX_KIND === "tmux") {
    const socket = readFileSync("/out/mux-socket.txt", "utf8").trim()
    const pane = process.env.TMUX_PANE
    const tmux = process.env.TMUX?.split(",")
    if (!pane || !/^%\d+$/.test(pane) || tmux?.[0] !== socket || !statSync(socket).isSocket()) {
      throw new Error("Private OSC qualification lacks the existing owned tmux socket/pane")
    }
    const command = (...args: string[]) => run(["tmux", "-S", socket, ...args])
    const identity = command(
      "display-message",
      "-p",
      "-t",
      pane,
      "#{version}\t#{pid}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{socket_path}",
    )
      .trim()
      .split("\t")
    if (
      identity[0] !== "3.8" ||
      identity[1] !== tmux[1] ||
      identity[2] !== pane ||
      identity[4] !== readlinkSync("/proc/self/fd/0") ||
      identity[5] !== socket
    ) {
      throw new Error(`Private OSC qualification tmux identity differs: ${JSON.stringify(identity)}`)
    }
    let cursorPid = process.pid
    const ancestry: number[] = []
    for (let step = 0; step < 12; step++) {
      ancestry.push(cursorPid)
      if (cursorPid === Number(identity[3])) break
      cursorPid = proc(cursorPid).ppid
    }
    if (!ancestry.includes(Number(identity[3]))) {
      throw new Error("Private OSC qualification collector is outside the bound pane")
    }
    const plain = () => command("capture-pane", "-p", "-t", pane)
    const grid = () => command("capture-pane", "-p", "-R", "-t", pane)
    const line = (bytes: string, row: number) => {
      const found = bytes.split("\n").find((value) => new RegExp(`^\\s*L \\d+ \\(${row - 1}\\) flags=`).test(value))
      if (!found) throw new Error(`Private OSC qualification missing diagnostic grid row${row}`)
      return found
    }
    ctx.write("\x1b[2J\x1b[3J\x1b[H")
    const phases: Array<{ name: string; row: number; feed: string; plain: string; grid: string; line: string }> = []
    for (const [name, row, sequence] of [
      ["made-up", 1, osc("133;Z")],
      ["handled", 2, osc("133;A")],
      ["target", 3, osc("633;A")],
    ] as const) {
      const marker = `Q-${nonce}-${name}`
      const feed = `\x1b[${row};1H${sequence}${marker}`
      ctx.write(feed)
      const text = await waitFor(plain, (value) => value.includes(marker), `tmux-${name}`)
      const state = grid()
      phases.push({ name, row, feed, plain: text, grid: state, line: line(state, row) })
    }
    const [madeUp, handled, target] = phases
    const semanticFlags = /START_PROMPT|START_COMMAND|START_OUTPUT|END_OUTPUT/
    if (
      !madeUp ||
      !handled ||
      !target ||
      semanticFlags.test(madeUp.line) ||
      !handled.line.includes("START_PROMPT") ||
      semanticFlags.test(target.line) ||
      line(target.grid, 2) !== handled.line
    ) {
      writeFileSync(
        "/out/osc-qualification-failed-controls.json",
        JSON.stringify({ common, identity, ancestry, phases }, null, 2),
      )
      throw new Error("Private OSC qualification tmux made-up/handled/target control failed; stop to CTO")
    }
    evidence = { ...common, app: "tmux", identity, ancestry, controlsPassed: true, phases }
  } else {
    if (process.env.TERMINFO_TARGET_ID !== "kitty" || process.env.TERMINFO_TARGET_VERSION !== "0.49.2") {
      throw new Error("Private OSC qualification requires image Kitty0.49.2")
    }
    const kittyPid = Number(process.env.KITTY_PID)
    const executable = process.env.TERMINFO_TARGET_BINARY
    if (
      !Number.isSafeInteger(kittyPid) ||
      kittyPid <= 0 ||
      !executable ||
      readlinkSync(`/proc/${kittyPid}/exe`) !== realpathSync(executable)
    ) {
      throw new Error("Private OSC qualification Kitty owner executable differs")
    }
    let cursorPid = process.pid
    const ancestry: number[] = []
    for (let step = 0; step < 12; step++) {
      ancestry.push(cursorPid)
      if (cursorPid === kittyPid) break
      cursorPid = proc(cursorPid).ppid
    }
    if (!ancestry.includes(kittyPid)) throw new Error("Private OSC qualification collector is outside Kitty")
    const windows = run(["xdotool", "search", "--onlyvisible", "--pid", String(kittyPid)])
      .trim()
      .split(/\s+/)
    if (windows.length !== 1 || !/^\d+$/.test(windows[0]!)) {
      throw new Error("Private OSC qualification ambiguous owned Kitty window")
    }
    const window = windows[0]!
    const originalTitle = run(["xdotool", "getwindowname", window]).trimEnd()
    if (/[\x00-\x1f\x7f]/.test(originalTitle)) {
      throw new Error("Private OSC qualification cannot restore original title")
    }
    const log = "/out/daemon.log"
    const phases: Array<{ name: string; offset: number; feed: string; appended: string }> = []
    try {
      for (const [name, sequence] of [
        ["made-up", osc(`7654;${nonce}`)],
        ["handled", osc(`2;Q-${nonce}`)],
        ["target", osc("633;A")],
      ] as const) {
        const offset = statSync(log).size
        const sentinel = `7655;${nonce}-${name}`
        const feed = sequence + osc(sentinel)
        ctx.write(feed)
        const read = () => readFileSync(log).subarray(offset).toString("utf8")
        const appended = await waitFor(
          read,
          (value) => value.includes(`Unknown OSC escape code: ${sentinel}\n`),
          `kitty-${name}`,
        )
        writeFileSync(`/out/osc-qualification-kitty-${name}.bin`, readFileSync(log).subarray(offset))
        phases.push({ name, offset, feed, appended })
        if (name === "handled") {
          await waitFor(
            () => run(["xdotool", "getwindowname", window]),
            (value) => value.trimEnd() === `Q-${nonce}`,
            "kitty-handled-title",
          )
        }
      }
    } finally {
      ctx.write(osc(`2;${originalTitle}`))
    }
    const [madeUp, handled, target] = phases
    const reports = (bytes: string) => bytes.split("\n").filter((value) => value.includes("[PARSE ERROR]"))
    if (
      !madeUp?.appended.includes(`Unknown OSC escape code: 7654;${nonce}`) ||
      !target?.appended.includes("Ignoring OSC 633,") ||
      !handled ||
      reports(handled.appended).some((value) => !value.includes(`Unknown OSC escape code: 7655;${nonce}-handled`))
    ) {
      writeFileSync(
        "/out/osc-qualification-failed-controls.json",
        JSON.stringify({ common, kittyPid, ancestry, phases }, null, 2),
      )
      throw new Error("Private OSC qualification Kitty report controls failed; stop to CTO")
    }
    evidence = {
      ...common,
      app: "kitty",
      kittyPid,
      executable,
      ancestry,
      window,
      originalTitle,
      controlsPassed: true,
      phases,
    }
  }
  writeFileSync("/out/osc-reader-qualification.json", JSON.stringify(evidence, null, 2))
  return {
    pass: false,
    response: JSON.stringify(evidence),
    tests: [
      {
        id: "criterion",
        status: "probe-todo",
        reason: "Private pre-build OSC reader qualification only; no feature grade",
      },
    ],
  }
}
