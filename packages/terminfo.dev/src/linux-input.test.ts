/**
 * @failure XTEST injection targets a window with XSendEvent, skips focus, proceeds without XTEST, or hangs on xdotool --sync.
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
  writeFileSync(`${log}.focus`, "42\n")
  executable(
    join(directory, "xdotool"),
    `printf '%s\\n' "$*" >> "$TEST_INPUT_LOG"
case "$1" in
  search)
    if [ "$3" = --pid ]; then printf '%s\\n' "$TEST_INPUT_WINDOWS"
    else printf '%s\\n' "$TEST_INPUT_VISIBLE_WINDOWS"; fi
    ;;
  getwindowpid) printf '%s\\n' "$TEST_INPUT_OWNER_PID" ;;
  getwindowfocus)
    if [ "$TEST_INPUT_ACTIVE_WINDOW" = 42 ]; then
      if [ "$(cat "$TEST_INPUT_LOG.focus")" = 543 ] && [ "\${TEST_INPUT_ROOT_FOCUS:-543}" != 543 ]; then
        printf '%s\\n' "$TEST_INPUT_ROOT_FOCUS"
      else cat "$TEST_INPUT_LOG.focus"; fi
    else printf '%s\\n' "$TEST_INPUT_ACTIVE_WINDOW"; fi
    ;;
  getactivewindow|windowactivate)
    if [ "\${TEST_INPUT_WM_ACCEPTS:-0}" = 1 ] && [ "$1" = windowactivate ]; then
      for last; do :; done
      printf '%s\\n' "$last" > "$TEST_INPUT_LOG.focus"
      exit 0
    fi
    printf '%s\\n' "Your windowmanager claims not to support _NET_ACTIVE_WINDOW, so the attempt to activate the window was aborted." >&2
    exit 1
    ;;
  windowfocus|mousemove)
    if [ "$1" = windowfocus ]; then printf '%s\\n' "$2" > "$TEST_INPUT_LOG.focus"; fi
    if [ "$TEST_INPUT_FOCUS_HANG" = 1 ]; then
      for arg in "$@"; do
        if [ "$arg" = --sync ]; then sleep 30; exit 0; fi
      done
    fi
    ;;
  getwindowgeometry)
    if [ -f "$TEST_INPUT_LOG.size" ]; then
      read -r width height < "$TEST_INPUT_LOG.size"
      printf 'WIDTH=%s\\nHEIGHT=%s\\n' "$width" "$height"
    else printf 'WIDTH=800\\nHEIGHT=600\\n'; fi
    ;;
  getmouselocation) printf 'X=400\\nY=300\\nSCREEN=0\\nWINDOW=%s\\n' "\${TEST_INPUT_POINTER_WINDOW:-42}" ;;
  windowsize)
    if [ "\${TEST_INPUT_FAIL_WINDOWSIZE:-0}" = 1 ]; then printf 'windowsize failed\\n' >&2; exit 29; fi
    if [ "\${TEST_INPUT_STALE_GEOMETRY:-0}" != 1 ]; then printf '%s %s\\n' "$3" "$4" > "$TEST_INPUT_LOG.size"; fi
    ;;
  key|click|mousedown|mouseup) ;;
  *) exit 18 ;;
esac`,
  )
  executable(
    join(directory, "xdpyinfo"),
    `printf 'default screen number: 0\\nscreen #0:\\nroot window id: 0x21f\\n'
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

// The owned transport must retain the caller's sensitive pixel position and
// return original dimensions so the probe can restore its disposable window.
test.runIf(process.platform === "linux")(
  "owned resize returns old pixels and click preserves the requested position",
  async () => {
    const { log } = fixture()
    const input = await createLinuxInput(liveExecutable())
    if (!input.resizeWindow) throw new Error("Missing owned resize fixture")
    expect(await input.resizeWindow(1400, 600)).toEqual({ width: 800, height: 600 })
    await input.injectClick(1, { x: 1300, y: 120 })
    expect(argvLines(log)).toContain("windowsize 42 1400 600")
    expect(argvLines(log)).toContain("mousemove --window 42 1300 120")
    expect(argvLines(log).some((line) => line.includes("--sync"))).toBe(false)
  },
)

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
    "TEST_INPUT_ROOT_FOCUS",
    "TEST_INPUT_XTEST",
    "TEST_INPUT_FOCUS_HANG",
    "TEST_INPUT_FAIL_WINDOWSIZE",
    "TEST_INPUT_POINTER_WINDOW",
    "TEST_INPUT_STALE_GEOMETRY",
    "TEST_INPUT_WM_ACCEPTS",
    "TERMINFO_XVFB_WM",
  ]) {
    delete process.env[key]
  }
})

test.runIf(process.platform === "linux")(
  "resizeWindow declares the new size with its owning featureId only after xdotool windowsize succeeds (#32791)",
  async () => {
    const { log } = fixture()
    const declared: Array<{ width: number; height: number; featureId: string | undefined; afterLogLine: string }> = []
    const input = await createLinuxInput(liveExecutable(), {
      onResizeWindow: (width, height, featureId) => {
        declared.push({ width, height, featureId, afterLogLine: argvLines(log).at(-1) ?? "" })
      },
    })
    expect(await input.resizeWindow(520, 600, "extensions.reflow")).toEqual({ width: 800, height: 600 })
    expect(declared).toEqual([
      {
        width: 520,
        height: 600,
        featureId: "extensions.reflow",
        afterLogLine: "getwindowgeometry --shell 42",
      },
    ])
    process.env.TEST_INPUT_FAIL_WINDOWSIZE = "1"
    await expect(input.resizeWindow(640, 600, "extensions.reflow")).rejects.toThrow(/windowsize failed/)
    expect(declared).toHaveLength(1)
  },
)

test.runIf(process.platform === "linux")("createLinuxInput refuses when xdpyinfo does not list XTEST", async () => {
  fixture()
  process.env.TEST_INPUT_XTEST = "0"
  await expect(createLinuxInput(liveExecutable())).rejects.toThrow(/XTEST/)
})

// Input ownership is distinct from the probe's byte grading: verify actual root
// and owned focus IDs and restoration even if the root read is wrong.
test.runIf(process.platform === "linux")(
  "focus roundtrip verifies root and owned focus, restoring after a wrong read",
  async () => {
    const { log } = fixture()
    const input = await createLinuxInput(liveExecutable())
    if (!input.focusRoundTrip) throw new Error("Missing owned focus roundtrip")
    expect(await input.focusRoundTrip()).toEqual({
      ownedWindowId: "42",
      rootWindowId: "543",
      focusedWindowIds: ["42", "543", "42"],
    })
    expect(argvLines(log).filter((line) => line.startsWith("windowfocus "))).toEqual([
      "windowfocus 42",
      "windowfocus 543",
      "windowfocus 42",
    ])
    expect(argvLines(log).filter((line) => line === "getwindowfocus -f")).toHaveLength(3)
    process.env.TEST_INPUT_ROOT_FOCUS = "99"
    await expect(input.focusRoundTrip()).rejects.toThrow(/focus/)
    expect(argvLines(log).at(-2)).toBe("windowfocus 42")
  },
)

// #33305: a window manager owns activation, so the arm asks it for the owned window and still
// proves the same owned/root/owned witness; the root step stays the raw roundtrip.
test.runIf(process.platform === "linux")(
  "focus roundtrip asks the owned window manager to activate and keeps the same witness",
  async () => {
    const { log } = fixture()
    process.env.TEST_INPUT_WM_ACCEPTS = "1"
    process.env.TERMINFO_XVFB_WM = "openbox"
    const input = await createLinuxInput(liveExecutable())
    if (!input.focusRoundTrip) throw new Error("Missing owned focus roundtrip")
    expect(await input.focusRoundTrip()).toEqual({
      ownedWindowId: "42",
      rootWindowId: "543",
      focusedWindowIds: ["42", "543", "42"],
    })
    expect(argvLines(log).filter((line) => line.startsWith("windowactivate "))).toEqual([
      "windowactivate --sync 42",
      "windowactivate --sync 42",
    ])
    expect(argvLines(log).filter((line) => line.startsWith("windowfocus "))).toEqual(["windowfocus 543"])
  },
)

test.runIf(process.platform === "linux")(
  "focus roundtrip refuses loudly when the owned window manager will not activate the window",
  async () => {
    const { log } = fixture()
    process.env.TERMINFO_XVFB_WM = "openbox"
    const input = await createLinuxInput(liveExecutable())
    if (!input.focusRoundTrip) throw new Error("Missing owned focus roundtrip")
    await expect(input.focusRoundTrip()).rejects.toThrow(/openbox/)
    expect(argvLines(log)).toContain("windowactivate --sync 42")
    expect(argvLines(log).filter((line) => line === "windowfocus 42")).toEqual([])
  },
)

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
    expect(lines.some((line) => line.includes("mousemove --sync"))).toBe(false)
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
    // Key delivery must not prepend mouse-motion bytes to the same stdin read.
    expect(lines.some((line) => line.startsWith("mousemove "))).toBe(false)
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
    expect(lines).toContain("mousemove --window 42 400 300")
    expect(lines).toContain("click --window 0 --clearmodifiers 1")
    expect(lines).toContain("click --window 0 --clearmodifiers 4")
    expect(lines).toContain("getmouselocation --shell")
    expect(lines.some((line) => /^click /.test(line) && /--window 42/.test(line))).toBe(false)
    process.env.TEST_INPUT_POINTER_WINDOW = "0"
    await input.injectClick(1)
    process.env.TEST_INPUT_POINTER_WINDOW = "1"
    const before = argvLines(log).length
    await expect(input.injectClick(1)).rejects.toThrow(/pointer is not on the owned window/)
    expect(
      argvLines(log)
        .slice(before)
        .some((line) => line.startsWith("click ")),
    ).toBe(false)
  },
)

test.runIf(process.platform === "linux")(
  "resize refuses when the window does not land on the asked pixels",
  async () => {
    fixture()
    const input = await createLinuxInput(liveExecutable())
    process.env.TEST_INPUT_STALE_GEOMETRY = "1"
    await expect(input.resizeWindow?.(1400, 600)).rejects.toThrow(/getwindowgeometry is 800x600/)
  },
)

// The approved 1003 route needs an owned-window move with no button gesture;
// click/drag tests do not prove this separate delivery path.
test.runIf(process.platform === "linux")(
  "injectMove focuses the owned window and moves without a button or --sync",
  async () => {
    const { log } = fixture()
    const input = await createLinuxInput(liveExecutable())
    expect(input.injectMove).toBeTypeOf("function")
    await input.injectMove!(32, 48)
    expect(argvLines(log).slice(-3)).toEqual(["windowfocus 42", "getwindowfocus", "mousemove --window 42 32 48"])
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
    expect(lines).toContain("mousemove --window 42 400 300")
    expect(lines).toContain("mousedown --window 0 --clearmodifiers 1")
    expect(lines).toContain("mousemove --window 42 450 300")
    expect(lines).toContain("mouseup --window 0 --clearmodifiers 1")
    expect(lines.some((line) => /^mousedown /.test(line) && /--window 42/.test(line))).toBe(false)
    expect(lines.some((line) => /^mouseup /.test(line) && /--window 42/.test(line))).toBe(false)
  },
)
