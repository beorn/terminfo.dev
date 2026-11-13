import type { InputFixture } from "@terminfo/probe-defs"

/** The pointer position a click or drag starts from, in owned-window pixels. */
export const DEFAULT_POINTER = { x: 400, y: 300 } as const

/** Where a drag releases, in owned-window pixels. */
export const DRAG_TARGET = { x: 450, y: 300 } as const

/** The only buttons an adapter may click: 1 primary, 4 wheel up, 5 wheel down. */
export type InputButton = 1 | 4 | 5

/** The owned window's frame, in the mechanism's own pixel space (window pixels on Linux, screen points on macOS). */
export interface OwnedFrame {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The platform operations an input adapter delegates to. One adapter body (`createInjectedInput`)
 * runs against either mechanism - XTEST through xdotool on Linux, CGEvent through the built helper on
 * macOS - so button numbering, wheel 4/5, the click trajectory and the drag sequence are written
 * once and proven once by `input-contract.ts`, never copied per platform (@cto 2026-11-11, 33574 C2).
 */
export interface InputMechanism {
  /** Make the owned window the input target, refusing by name when that cannot be verified. */
  focus(): Promise<void>
  /** The owned window's frame; the adapter bounds-checks a pointer against its size. */
  geometry(): Promise<OwnedFrame>
  /**
   * Move the pointer into the owned window. `verifyPointer` asks the mechanism to read the pointer
   * back and refuse a different window; `dragged` asks for button-drag motion when the platform
   * distinguishes it from buttonless motion.
   */
  moveTo(x: number, y: number, options: { verifyPointer: boolean; dragged: boolean }): Promise<void>
  click(button: InputButton): Promise<void>
  press(button: InputButton): Promise<void>
  release(button: InputButton): Promise<void>
  key(keys: string): Promise<void>
}

/**
 * The one adapter body both platforms run: focus, place the pointer inside the owned window, then
 * act. `label` names the mechanism in refusals ("XTEST", "CGEvent").
 */
export function createInjectedInput(mechanism: InputMechanism, label: string): InputFixture {
  async function preparePointer(position: { x: number; y: number }): Promise<void> {
    await mechanism.focus()
    const frame = await mechanism.geometry()
    if (position.x < 1 || position.y < 1 || position.x >= frame.width || position.y >= frame.height) {
      throw new Error(
        `requested pointer ${position.x},${position.y} is outside the owned window ${frame.width}x${frame.height}; refusing the click`,
      )
    }
    await mechanism.moveTo(position.x, position.y, { verifyPointer: true, dragged: false })
  }

  return {
    mechanism: label,
    async injectKey(keys: string) {
      if (keys.length === 0) throw new Error(`${label} key injection requires a nonempty keysym`)
      await mechanism.focus()
      await mechanism.key(keys)
    },
    async injectClick(button: InputButton, position?: { x: number; y: number }) {
      await preparePointer(position ?? DEFAULT_POINTER)
      await mechanism.click(button)
    },
    async injectMove(x: number, y: number) {
      await mechanism.focus()
      await mechanism.moveTo(x, y, { verifyPointer: false, dragged: false })
    },
    async injectDrag(button: 1 = 1) {
      await preparePointer(DEFAULT_POINTER)
      await mechanism.press(button)
      await mechanism.moveTo(DRAG_TARGET.x, DRAG_TARGET.y, { verifyPointer: false, dragged: true })
      await mechanism.release(button)
    },
  }
}
