import type { InputFixture } from "@terminfo/probe-defs"
import { command } from "./capture-core.ts"
import { kittyAncestor, windowPixels, type LiveExecutable } from "./linux-capture.ts"

export interface CollectorInputAdapter extends InputFixture {
  resizeWindow(width: number, height: number, featureId?: string): Promise<{ width: number; height: number }>
}

export type LinuxInputAdapter = CollectorInputAdapter

function requireLinuxDisplay(): void {
  if (process.platform !== "linux" || !process.env.DISPLAY) {
    throw new Error("Linux input requires Linux and the owned DISPLAY")
  }
}

/**
 * The window manager that owns the collection display for this whole run (#33305), or null when
 * the environment has none. A GTK toplevel only reports focus when its window manager activates
 * it, so the focus arm has to ask the manager whenever one is running. Unset is the WM-free
 * environment byte for byte; the name is the one the container receipt records.
 */
function ownedWindowManager(): string | null {
  const name = process.env.TERMINFO_XVFB_WM?.trim()
  return name === undefined || name === "" ? null : name
}

/** Bind OS-level XTEST key/click/wheel injection to the owned Kitty window. */
export async function createLinuxInput(
  executable: LiveExecutable,
  options?: { onResizeWindow?: (width: number, height: number, featureId: string) => void },
): Promise<LinuxInputAdapter> {
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

  async function focusRoundTrip(): Promise<{
    ownedWindowId: string
    rootWindowId: string
    focusedWindowIds: [string, string, string]
  }> {
    const selectedScreen = /default screen number:\s*(\d+)/.exec(display)?.[1]
    const section = selectedScreen === undefined ? undefined : display.split(`screen #${selectedScreen}:`)[1]
    const rootHex = section?.split(/screen #\d+:/)[0]?.match(/root window id:\s*(0x[0-9a-f]+)/i)?.[1]
    if (!rootHex) throw new Error("Owned DISPLAY xdpyinfo lacks its selected screen root window id")
    const rootWindowId = String(Number.parseInt(rootHex, 16))
    const windowManager = ownedWindowManager()
    const focus = async (target: string, activation: "manager" | "raw"): Promise<string> => {
      if (activation === "manager") {
        try {
          await command("xdotool", ["windowactivate", "--sync", target])
        } catch (error) {
          throw new Error(`Window manager ${windowManager} refused to activate ${target}: ${(error as Error).message}`)
        }
      } else {
        await command("xdotool", ["windowfocus", target])
      }
      const focused = (await command("xdotool", ["getwindowfocus", "-f"])).toString().trim()
      if (focused !== target) {
        throw new Error(
          `Owned focus roundtrip expected ${target}; getwindowfocus -f is ${focused}` +
            (windowManager === null ? "" : ` under window manager ${windowManager}`),
        )
      }
      return focused
    }
    // The root step is the witness, not an activation: it must move X input focus away and back.
    const focusOwned = (): Promise<string> => focus(ownedWindowId, windowManager === null ? "raw" : "manager")
    const initialFocus = await focusOwned()
    let rootFocus: string
    let restoredFocus: string
    try {
      rootFocus = await focus(rootWindowId, "raw")
    } finally {
      restoredFocus = await focusOwned()
    }
    return { ownedWindowId, rootWindowId, focusedWindowIds: [initialFocus, rootFocus, restoredFocus] }
  }

  async function focusOwnedWindow(): Promise<void> {
    // Xvfb has no EWMH WM by default: windowactivate/getactivewindow abort on _NET_ACTIVE_WINDOW.
    // windowfocus uses XSetInputFocus, which CURRENTWINDOW (--window 0) then follows.
    // xterm on the collection image never completes xdotool --sync (28550/28556).
    // XSetInputFocus then getwindowfocus, without --sync, is the bound: inject cannot wait out a 10s execFile timeout.
    // Under TERMINFO_XVFB_WM the manager owns activation, and the raw roundtrip above produces no
    // GTK focus report (#33305), so the owned step asks the manager and still verifies the result.
    const windowManager = ownedWindowManager()
    if (windowManager === null) {
      await command("xdotool", ["windowfocus", ownedWindowId])
    } else {
      try {
        await command("xdotool", ["windowactivate", "--sync", ownedWindowId])
      } catch (error) {
        throw new Error(
          `Window manager ${windowManager} refused to activate the owned window ${ownedWindowId}: ${(error as Error).message}`,
        )
      }
    }
    const focused = (await command("xdotool", ["getwindowfocus"])).toString().trim()
    if (focused !== ownedWindowId) {
      throw new Error(
        `XTEST inject requires the owned window ${ownedWindowId} to be focused; getwindowfocus is ${focused}` +
          (windowManager === null ? "" : ` under window manager ${windowManager}`),
      )
    }
  }

  async function ownedGeometry(): Promise<{ width: number; height: number }> {
    return windowPixels((await command("xdotool", ["getwindowgeometry", "--shell", ownedWindowId])).toString())
  }

  async function preparePointer(position = { x: 400, y: 300 }): Promise<void> {
    await focusOwnedWindow()
    const geometry = await ownedGeometry()
    if (position.x < 1 || position.y < 1 || position.x >= geometry.width || position.y >= geometry.height) {
      throw new Error(
        `requested pointer ${position.x},${position.y} is outside the owned window ${geometry.width}x${geometry.height}; refusing the click`,
      )
    }
    await command("xdotool", ["mousemove", "--window", ownedWindowId, String(position.x), String(position.y)])
    const location = (await command("xdotool", ["getmouselocation", "--shell"])).toString()
    const pointerWindow = /^WINDOW=(\d+)$/m.exec(location)?.[1]
    // XQueryPointer names the deepest child. GTK under Xvfb reports WINDOW=0 for the owned
    // toplevel even after mousemove --window onto it (ghostty run 29e1b284). Refuse only a
    // different positive window, which is a pointer that landed somewhere else.
    if (pointerWindow !== undefined && pointerWindow !== "0" && pointerWindow !== ownedWindowId) {
      throw new Error(
        `pointer is not on the owned window ${ownedWindowId}; getmouselocation WINDOW is ${pointerWindow}; refusing the click`,
      )
    }
  }

  return {
    focusRoundTrip,
    async resizeWindow(width: number, height: number, featureId?: string) {
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw new Error(`Owned window resize requires positive integer pixels; got ${width}x${height}`)
      }
      if (options?.onResizeWindow && (!featureId || featureId.trim().length === 0)) {
        throw new Error("Declared window resize requires the owning featureId")
      }
      const original = windowPixels(
        (await command("xdotool", ["getwindowgeometry", "--shell", ownedWindowId])).toString(),
      )
      await command("xdotool", ["windowsize", ownedWindowId, String(width), String(height)])
      const landed = await ownedGeometry()
      if (landed.width !== width || landed.height !== height) {
        throw new Error(
          `owned window resize asked ${width}x${height}; getwindowgeometry is ${landed.width}x${landed.height}`,
        )
      }
      if (options?.onResizeWindow && featureId) options.onResizeWindow(width, height, featureId)
      return original
    },
    async injectKey(keys: string) {
      if (keys.length === 0) throw new Error("XTEST key injection requires a nonempty keysym")
      await focusOwnedWindow()
      await command("xdotool", ["key", "--window", "0", "--clearmodifiers", keys])
    },
    async injectClick(button: 1 | 4 | 5, position?: { x: number; y: number }) {
      await preparePointer(position)
      await command("xdotool", ["click", "--window", "0", "--clearmodifiers", String(button)])
    },
    async injectMove(x: number, y: number) {
      await focusOwnedWindow()
      await command("xdotool", ["mousemove", "--window", ownedWindowId, String(x), String(y)])
    },
    async injectDrag(button: 1) {
      await preparePointer()
      await command("xdotool", ["mousedown", "--window", "0", "--clearmodifiers", String(button)])
      await command("xdotool", ["mousemove", "--window", ownedWindowId, "450", "300"])
      await command("xdotool", ["mouseup", "--window", "0", "--clearmodifiers", String(button)])
    },
  }
}
