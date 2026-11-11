import type { InputFixture } from "@terminfo/probe-defs"
import { command } from "./capture-core.ts"
import { kittyAncestor, windowPixels, windowRectangle, type LiveExecutable, type WindowRect } from "./linux-capture.ts"

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
 * The owned helper window that takes X focus in the middle of the witness (#33305). GTK reports
 * no focus change when focus moves to the display root, so a root step proves nothing for Ghostty
 * while xterm reports it - the middle target has to be a window that both kinds of terminal see
 * losing focus to. The container script maps it before the app and dies with the display; this
 * adapter only learns its id.
 */
function focusHelperWindowId(): string {
  const window = process.env.TERMINFO_FOCUS_HELPER_WINDOW?.trim()
  if (window === undefined || window === "") {
    throw new Error(
      "The owned focus helper window is missing: TERMINFO_FOCUS_HELPER_WINDOW must name the helper " +
        "toplevel, because a GTK terminal reports no focus change to the display root (#33305)",
    )
  }
  if (!/^\d+$/.test(window)) {
    throw new Error(`TERMINFO_FOCUS_HELPER_WINDOW is not an X window id: ${window}`)
  }
  return window
}

async function windowRect(windowId: string): Promise<WindowRect> {
  return windowRectangle((await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString())
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
  const helperWindowId = focusHelperWindowId()
  if (helperWindowId === ownedWindowId) {
    throw new Error(`The focus helper window ${helperWindowId} is the owned window; the witness needs two`)
  }
  // The helper must never occlude the owned window: an XGetImage capture of an obscured window can
  // read undefined pixels, so an overlapping helper would corrupt every captured cell it covers.
  const ownedRect = await windowRect(ownedWindowId)
  const helperRect = await windowRect(helperWindowId)
  const overlaps =
    helperRect.x < ownedRect.x + ownedRect.width &&
    ownedRect.x < helperRect.x + helperRect.width &&
    helperRect.y < ownedRect.y + ownedRect.height &&
    ownedRect.y < helperRect.y + helperRect.height
  if (overlaps) {
    throw new Error(
      `The owned focus helper ${helperWindowId} at ${String(helperRect.x)},${String(helperRect.y)} ` +
        `${String(helperRect.width)}x${String(helperRect.height)} overlaps the owned window ${ownedWindowId} at ` +
        `${String(ownedRect.x)},${String(ownedRect.y)} ${String(ownedRect.width)}x${String(ownedRect.height)}; ` +
        "an obscured capture is not a reading",
    )
  }

  async function focusRoundTrip(work?: (readFocus: () => Promise<string>) => Promise<void>): Promise<{
    ownedWindowId: string
    helperWindowId: string
    focusedWindowIds: [string, string, string]
  }> {
    const readFocus = async (): Promise<string> =>
      (await command("xdotool", ["getwindowfocus", "-f"])).toString().trim()
    const focus = async (target: string): Promise<string> => {
      await command("xdotool", ["windowfocus", target])
      const focused = await readFocus()
      if (focused !== target) {
        throw new Error(`Owned focus roundtrip expected ${target}; getwindowfocus -f is ${focused}`)
      }
      return focused
    }
    // The helper step is the witness, not an activation: it must move X input focus away and back.
    const initialFocus = await focus(ownedWindowId)
    let helperFocus: string
    let restoredFocus: string
    try {
      helperFocus = await focus(helperWindowId)
      await work?.(readFocus)
    } finally {
      restoredFocus = await focus(ownedWindowId)
    }
    return { ownedWindowId, helperWindowId, focusedWindowIds: [initialFocus, helperFocus, restoredFocus] }
  }

  async function focusOwnedWindow(): Promise<void> {
    // Xvfb has no EWMH WM: windowactivate/getactivewindow abort on _NET_ACTIVE_WINDOW, and a
    // manager would take the focus back anyway. windowfocus uses XSetInputFocus, which
    // CURRENTWINDOW (--window 0) then follows.
    // xterm on the collection image never completes xdotool --sync (28550/28556).
    // XSetInputFocus then getwindowfocus, without --sync, is the bound: inject cannot wait out a 10s execFile timeout.
    await command("xdotool", ["windowfocus", ownedWindowId])
    const focused = (await command("xdotool", ["getwindowfocus"])).toString().trim()
    if (focused !== ownedWindowId) {
      throw new Error(
        `XTEST inject requires the owned window ${ownedWindowId} to be focused; getwindowfocus is ${focused}`,
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
