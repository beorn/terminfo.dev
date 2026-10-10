import type { InputFixture } from "@terminfo/probe-defs"
import { command, kittyAncestor, type LiveExecutable } from "./linux-capture.ts"

export type LinuxInputAdapter = InputFixture

function requireLinuxDisplay(): void {
  if (process.platform !== "linux" || !process.env.DISPLAY) {
    throw new Error("Linux input requires Linux and the owned DISPLAY")
  }
}

/** Bind OS-level XTEST key/click/wheel injection to the owned Kitty window. */
export async function createLinuxInput(executable: LiveExecutable): Promise<LinuxInputAdapter> {
  requireLinuxDisplay()
  const display = (await command("xdpyinfo", [])).toString()
  if (!/\bXTEST\b/.test(display)) {
    throw new Error("DISPLAY lacks the XTEST extension; Xvfb must be started with +extension XTEST")
  }
  const kittyPid = kittyAncestor(executable)
  const windows = (await command("xdotool", ["search", "--onlyvisible", "--pid", String(kittyPid)]))
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const windowId = windows[0]
  if (windows.length !== 1 || windowId === undefined || !/^\d+$/.test(windowId)) {
    throw new Error(`Collector's Kitty PID ${kittyPid} owns ${windows.length} visible windows; expected one`)
  }
  const ownedWindowId: string = windowId

  async function prepare(): Promise<void> {
    // Xvfb has no EWMH WM: windowactivate/getactivewindow abort on _NET_ACTIVE_WINDOW.
    // windowfocus uses XSetInputFocus, which CURRENTWINDOW (--window 0) then follows.
    // xterm on the collection image never completes windowfocus --sync (28550/28556).
    // XSetInputFocus without --sync, then getwindowfocus, is the bound: inject cannot wait out a 10s execFile timeout.
    await command("xdotool", ["windowfocus", ownedWindowId])
    const focused = (await command("xdotool", ["getwindowfocus"])).toString().trim()
    if (focused !== ownedWindowId) {
      throw new Error(
        `XTEST inject requires the owned window ${ownedWindowId} to be focused; getwindowfocus is ${focused}`,
      )
    }
    await command("xdotool", ["mousemove", "--sync", "--window", ownedWindowId, "400", "300"])
  }

  return {
    async injectKey(keys: string) {
      if (keys.length === 0) throw new Error("XTEST key injection requires a nonempty keysym")
      await prepare()
      await command("xdotool", ["key", "--window", "0", "--clearmodifiers", keys])
    },
    async injectClick(button: 1 | 4 | 5) {
      await prepare()
      await command("xdotool", ["click", "--window", "0", "--clearmodifiers", String(button)])
    },
    async injectDrag(button: 1) {
      await prepare()
      await command("xdotool", ["mousedown", "--window", "0", "--clearmodifiers", String(button)])
      await command("xdotool", ["mousemove", "--sync", "--window", ownedWindowId, "450", "300"])
      await command("xdotool", ["mouseup", "--window", "0", "--clearmodifiers", String(button)])
    },
  }
}
