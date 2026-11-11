import { describe, expect, it } from "vitest"
import type { InputFixture } from "@terminfo/probe-defs"
import {
  DEFAULT_POINTER,
  DRAG_TARGET,
  type InputButton,
  type InputMechanism,
  type OwnedFrame,
} from "../input-fixture.ts"

/** One platform operation the adapter asked the mechanism to perform, in order. */
export interface RecordedInputCall {
  readonly op: "focus" | "geometry" | "moveTo" | "click" | "press" | "release" | "key"
  readonly args: readonly unknown[]
}

export interface FakeInputMechanism {
  readonly mechanism: InputMechanism
  readonly calls: RecordedInputCall[]
}

/** A mechanism that records instead of acting, with a fixed owned-window frame. */
export function fakeInputMechanism(frame: OwnedFrame = { x: 100, y: 50, width: 800, height: 600 }): FakeInputMechanism {
  const calls: RecordedInputCall[] = []
  const record = (op: RecordedInputCall["op"], ...args: unknown[]) => {
    calls.push({ op, args })
  }
  return {
    calls,
    mechanism: {
      focus() {
        record("focus")
        return Promise.resolve()
      },
      geometry() {
        record("geometry")
        return Promise.resolve(frame)
      },
      moveTo(x, y, options) {
        record("moveTo", x, y, options)
        return Promise.resolve()
      },
      click(button: InputButton) {
        record("click", button)
        return Promise.resolve()
      },
      press(button: InputButton) {
        record("press", button)
        return Promise.resolve()
      },
      release(button: InputButton) {
        record("release", button)
        return Promise.resolve()
      },
      key(keys: string) {
        record("key", keys)
        return Promise.resolve()
      },
    },
  }
}

/**
 * The behaviour every injected adapter must share, proven once against a fake mechanism (@cto
 * 2026-11-11, 33574 C2): button numbering, wheel 4/5, the click trajectory, the drag sequence and
 * the refusal of a pointer outside the owned window. A platform adapter that adds state around this
 * body runs the same contract with `build`, so the semantics cannot drift between Linux and macOS.
 */
export function describeInputContract(
  name: string,
  build: (mechanism: InputMechanism) => InputFixture | Promise<InputFixture>,
): void {
  describe(`${name} input adapter contract`, () => {
    it("refuses an empty keysym before any focus or key event", async () => {
      const fake = fakeInputMechanism()
      await expect((await build(fake.mechanism)).injectKey("")).rejects.toThrow(/nonempty keysym/)
      expect(fake.calls).toEqual([])
    })

    it("focuses the owned window, then injects the keysym unchanged", async () => {
      const fake = fakeInputMechanism()
      await (await build(fake.mechanism)).injectKey("Return")
      expect(fake.calls).toEqual([
        { op: "focus", args: [] },
        { op: "key", args: ["Return"] },
      ])
    })

    it("clicks wheel up as button 4 and wheel down as button 5, after placing the pointer", async () => {
      const fake = fakeInputMechanism()
      const input = await build(fake.mechanism)
      await input.injectClick(4)
      await input.injectClick(5)
      expect(fake.calls).toEqual([
        { op: "focus", args: [] },
        { op: "geometry", args: [] },
        { op: "moveTo", args: [DEFAULT_POINTER.x, DEFAULT_POINTER.y, { verifyPointer: true, dragged: false }] },
        { op: "click", args: [4] },
        { op: "focus", args: [] },
        { op: "geometry", args: [] },
        { op: "moveTo", args: [DEFAULT_POINTER.x, DEFAULT_POINTER.y, { verifyPointer: true, dragged: false }] },
        { op: "click", args: [5] },
      ])
    })

    it("refuses a pointer outside the owned window without clicking anywhere", async () => {
      const fake = fakeInputMechanism({ x: 0, y: 0, width: 640, height: 480 })
      await expect((await build(fake.mechanism)).injectClick(1, { x: 640, y: 20 })).rejects.toThrow(
        /outside the owned window 640x480; refusing the click/,
      )
      expect(fake.calls.map((call) => call.op)).toEqual(["focus", "geometry"])
    })

    it("drags as press, button-drag motion, then release with the same button", async () => {
      const fake = fakeInputMechanism()
      const input = await build(fake.mechanism)
      expect(input.injectDrag).toBeDefined()
      await input.injectDrag?.(1)
      expect(fake.calls).toEqual([
        { op: "focus", args: [] },
        { op: "geometry", args: [] },
        { op: "moveTo", args: [DEFAULT_POINTER.x, DEFAULT_POINTER.y, { verifyPointer: true, dragged: false }] },
        { op: "press", args: [1] },
        { op: "moveTo", args: [DRAG_TARGET.x, DRAG_TARGET.y, { verifyPointer: false, dragged: true }] },
        { op: "release", args: [1] },
      ])
    })

    it("moves the pointer without any button event", async () => {
      const fake = fakeInputMechanism()
      const input = await build(fake.mechanism)
      expect(input.injectMove).toBeDefined()
      await input.injectMove?.(12, 34)
      expect(fake.calls).toEqual([
        { op: "focus", args: [] },
        { op: "moveTo", args: [12, 34, { verifyPointer: false, dragged: false }] },
      ])
    })
  })
}
