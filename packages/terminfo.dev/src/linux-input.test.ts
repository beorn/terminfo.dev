/**
 * @failure XTEST injection targets a window with XSendEvent, skips focus, proceeds without XTEST, or hangs on windowfocus --sync.
 * @level l2
 * @consumer Linux Kitty collector OS-level key/click/wheel injection
 * @reach fs-walk <fixture-only: inspect only the owned temporary xdotool log>
 * @testonly none
 */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { createLinuxInput } from "./linux-input.ts"

const temporary: string[] = []
const originalPath = process.env.PATH
const originalDisplay = process.env.DISPLAY

function executable(path: string, source: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${source}\n`)
  chmodSync(path, 0o700)
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-linux-input-"))
  temporary.push(directory)
  const log = join(directory, "xdotool.log")
  writeFileSync(log, "")
  executable(
    join(directory, "xdotool"),
    `printf '%s\\n' "$*" >> "$TEST_INPUT_LOG"
case "$1" in
  search)
    if [ "$3" = --pid ]; then printf '%s\\n' "$TEST_INPUT_WINDOWS"
    else printf '%s\\n' "$TEST_INPUT_VISIBLE_WINDOWS"; fi
    ;;
  getwindowpid) printf '%s\\n' "$TEST_INPUT_OWNER_PID" ;;
  getwindowfocus) printf '%s\\n' "$TEST_INPUT_ACTIVE_WINDOW" ;;
  getactivewindow|windowactivate)
    printf '%s\\n' "Your windowmanager claims not to support _NET_ACTIVE_WINDOW, so the attempt to activate the window was aborted." >&2
    exit 1
    ;;
  windowfocus)
    if [ "$TEST_INPUT_FOCUS_HANG" = 1 ]; then
      for arg in "$@"; do
        if [ "$arg" = --sync ]; then sleep 30; exit 0; fi
      done
    fi
    ;;
  mousemove|key|click|mousedown|mouseup) ;;
  *) exit 18 ;;
esac`,
  )
  executable(
    join(directory, "xdpyinfo"),
    `printf 'root window id: 0x21f\\n'
if [ "$TEST_INPUT_XTEST" != "0" ]; then printf '    XTEST\\n'; fi`,
  )
  process.env.PATH = `${directory}:${originalPath ?? ""}`
  process.env.DISPLAY = ":test"
  process.env.TEST_INPUT_LOG = log
  process.env.TEST_INPUT_OWNER_PID = String(process.pid)
  process.env.TEST_INPUT_WINDOWS = "42"
  process.env.TEST_INPUT_VISIBLE_WINDOWS = "543 42"
  process.env.TEST_INPUT_ACTIVE_WINDOW = "42"
  process.env.TEST_INPUT_XTEST = "1"
  process.env.TEST_INPUT_FOCUS_HANG = "0"
  return { directory, log }
}

function liveExecutable(sha256?: string) {
  const path = realpathSync(`/proc/${process.pid}/exe`)
  return { path, sha256: sha256 ?? createHash("sha256").update(readFileSync(path)).digest("hex") }
}

function argvLines(log: string): string[] {
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalDisplay === undefined) delete process.env.DISPLAY
  else process.env.DISPLAY = originalDisplay
  for (const key of [
    "TEST_INPUT_LOG",
    "TEST_INPUT_OWNER_PID",
    "TEST_INPUT_WINDOWS",
    "TEST_INPUT_VISIBLE_WINDOWS",
    "TEST_INPUT_ACTIVE_WINDOW",
    "TEST_INPUT_XTEST",
    "TEST_INPUT_FOCUS_HANG",
  ]) {
    delete process.env[key]
  }
})

test.runIf(process.platform === "linux")("createLinuxInput refuses when xdpyinfo does not list XTEST", async () => {
  fixture()
  process.env.TEST_INPUT_XTEST = "0"
  await expect(createLinuxInput(liveExecutable())).rejects.toThrow(/XTEST/)
})

test.runIf(process.platform === "linux")(
  "injectKey refuses when getwindowfocus is not the owned window, and does not send a key",
  async () => {
    const { log } = fixture()
    const input = await createLinuxInput(liveExecutable())
    process.env.TEST_INPUT_ACTIVE_WINDOW = "99"
    await expect(input.injectKey("a")).rejects.toThrow(/focused|getwindowfocus|owned window/)
    expect(argvLines(log).some((line) => line.startsWith("key "))).toBe(false)
  },
)

test.runIf(process.platform === "linux")(
  "injectKey does not wait out a windowfocus --sync that never confirms",
  { timeout: 15_000 },
  async () => {
    const { log } = fixture()
    process.env.TEST_INPUT_FOCUS_HANG = "1"
    const input = await createLinuxInput(liveExecutable())
    const started = Date.now()
    await input.injectKey("a")
    expect(Date.now() - started).toBeLessThan(2_000)
    const lines = argvLines(log)
    expect(lines.some((line) => line.startsWith("key "))).toBe(true)
    expect(lines).not.toContain("windowfocus --sync 42")
  },
)

test.runIf(process.platform === "linux")(
  "injectKey focuses the owned window with XSetInputFocus, never EWMH activate, then keys through --window 0 with --clearmodifiers",
  async () => {
    const { log } = fixture()
    const input = await createLinuxInput(liveExecutable())
    await input.injectKey("ctrl+a")
    const lines = argvLines(log)
    expect(lines).toContain("windowfocus 42")
    expect(lines).toContain("getwindowfocus")
    expect(lines).toContain("mousemove --sync --window 42 400 300")
    expect(lines).toContain("key --window 0 --clearmodifiers ctrl+a")
    expect(lines.some((line) => line.startsWith("windowactivate"))).toBe(false)
    expect(lines.some((line) => line === "getactivewindow")).toBe(false)
    expect(lines.some((line) => /^key /.test(line) && /--window 42/.test(line))).toBe(false)
  },
)

test.runIf(process.platform === "linux")(
  "injectClick sends button 1 and wheel 4 through --window 0 with --clearmodifiers",
  async () => {
    const { log } = fixture()
    const input = await createLinuxInput(liveExecutable())
    await input.injectClick(1)
    await input.injectClick(4)
    const lines = argvLines(log)
    expect(lines).toContain("click --window 0 --clearmodifiers 1")
    expect(lines).toContain("click --window 0 --clearmodifiers 4")
    expect(lines.some((line) => /^click /.test(line) && /--window 42/.test(line))).toBe(false)
  },
)

test.runIf(process.platform === "linux")(
  "injectDrag mousedowns, moves off the prepare cell, and mouseups through --window 0",
  async () => {
    const { log } = fixture()
    const input = await createLinuxInput(liveExecutable())
    await input.injectDrag!(1)
    const lines = argvLines(log)
    expect(lines).toContain("windowfocus 42")
    expect(lines).toContain("mousemove --sync --window 42 400 300")
    expect(lines).toContain("mousedown --window 0 --clearmodifiers 1")
    expect(lines).toContain("mousemove --sync --window 42 450 300")
    expect(lines).toContain("mouseup --window 0 --clearmodifiers 1")
    expect(lines.some((line) => /^mousedown /.test(line) && /--window 42/.test(line))).toBe(false)
    expect(lines.some((line) => /^mouseup /.test(line) && /--window 42/.test(line))).toBe(false)
  },
)
