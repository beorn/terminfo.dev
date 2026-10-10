/**
 * @failure XTEST injection targets a window with XSendEvent, skips focus, or proceeds without XTEST.
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
  windowfocus|key|click) ;;
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
  "injectKey focuses the owned window with XSetInputFocus, never EWMH activate, then keys through --window 0 with --clearmodifiers",
  async () => {
    const { log } = fixture()
    const input = await createLinuxInput(liveExecutable())
    await input.injectKey("ctrl+shift+a")
    const lines = argvLines(log)
    expect(lines).toContain("windowfocus --sync 42")
    expect(lines).toContain("getwindowfocus")
    expect(lines).toContain("key --window 0 --clearmodifiers ctrl+shift+a")
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
