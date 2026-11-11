/**
 * @failure macOS input installs a CGEvent adapter without the Accessibility grant, without a built helper, or after an injected key never reached the app, so a runner failure is read as terminal behaviour.
 * @level l2
 * @consumer macOS app collector input binding (33574)
 * @reach in-process: fake mechanism, no helper binary and no WindowServer
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import {
  createDarwinInput,
  DARWIN_INPUT_SELF_TEST_KEYSYM,
  selectDarwinInputWindow,
  type DarwinInputOptions,
} from "./darwin-input.ts"
import { describeInputContract, fakeInputMechanism } from "./input-contract.ts"
import type { InputMechanism } from "./input-fixture.ts"

function options(overrides: Partial<DarwinInputOptions> = {}): DarwinInputOptions {
  return {
    appPid: 4242,
    appName: "Terminal.app",
    helperPath: undefined,
    selfTest: async () => DARWIN_INPUT_SELF_TEST_KEYSYM,
    mechanism: fakeInputMechanism().mechanism,
    ...overrides,
  }
}

// The contract runs through the adapter the collector installs, against a fake mechanism: the body
// it shares with Linux is proven once here instead of being copied per platform (@cto 33574 C2).
describeInputContract("macOS", async (mechanism: InputMechanism) => await createDarwinInput(options({ mechanism })))

describe("macOS input install", () => {
  it("refuses by name when the helper was never built and no mechanism was injected", async () => {
    let selfTested = false
    await expect(
      createDarwinInput(
        options({
          mechanism: undefined,
          selfTest: async () => {
            selfTested = true
            return DARWIN_INPUT_SELF_TEST_KEYSYM
          },
        }),
      ),
    ).rejects.toThrow(/TERMINFO_DARWIN_INPUT_HELPER is unset and no helper path was given/)
    expect(selfTested).toBe(false)
  })

  it("refuses the install when the app echoes nothing back", async () => {
    await expect(createDarwinInput(options({ selfTest: async () => null }))).rejects.toThrow(
      /input not delivered to Terminal\.app: the CGEvent helper posted keysym "z" to pid 4242 and the app's TTY echoed nothing/,
    )
  })

  it("refuses the install when the echo is not the injected keysym", async () => {
    await expect(createDarwinInput(options({ selfTest: async () => "q" }))).rejects.toThrow(
      /input not delivered to Terminal\.app: .* echoed "q"/,
    )
  })

  it("posts the documented self-test keysym through the adapter and reports the installed route", async () => {
    const facts: string[] = []
    const fake = fakeInputMechanism()
    const input = await createDarwinInput(
      options({
        mechanism: fake.mechanism,
        selfTest: async (inject) => {
          await inject()
          return DARWIN_INPUT_SELF_TEST_KEYSYM
        },
        report: (fact) => facts.push(fact),
      }),
    )
    expect(fake.calls).toEqual([
      { op: "focus", args: [] },
      { op: "key", args: [DARWIN_INPUT_SELF_TEST_KEYSYM] },
    ])
    expect(typeof input.injectKey).toBe("function")
    expect(facts).toEqual([`darwin input installed: pid 4242, window largest, tty unrecorded, self-test echoed "z"`])
  })

  it("requires the measured app PID", async () => {
    await expect(createDarwinInput(options({ appPid: 0 }))).rejects.toThrow(/requires the measured app PID; got 0/)
    await expect(createDarwinInput(options({ appPid: 1.5 }))).rejects.toThrow(/requires the measured app PID; got 1.5/)
  })
})

describe("macOS input window selection", () => {
  it("targets the largest usable layer-0 window the app owns", () => {
    expect(
      selectDarwinInputWindow(
        [
          { id: 7, x: 10, y: 20, width: 100, height: 40 },
          { id: 9, x: 0, y: 0, width: 800, height: 600 },
          { id: 11, x: 5, y: 5, width: 0, height: 300 },
        ],
        4242,
      ),
    ).toEqual({ id: 9, x: 0, y: 0, width: 800, height: 600 })
  })

  it("targets the window the run launched when its receipt named one", () => {
    const rows = [
      { id: 28, x: 0, y: 0, width: 1440, height: 900 },
      { id: 33, x: 40, y: 40, width: 700, height: 400 },
    ]
    expect(selectDarwinInputWindow(rows, 4242, 33)).toEqual({ id: 33, x: 40, y: 40, width: 700, height: 400 })
  })

  it("refuses by name when the launched window is not among the app windows", () => {
    expect(() => selectDarwinInputWindow([{ id: 28, x: 0, y: 0, width: 800, height: 600 }], 4242, 33)).toThrow(
      /targets the run's own window 33, which is not among the 1 usable window\(s\) the app owns of the 1 listed for pid 4242/,
    )
  })

  it("refuses by name when the app owns no usable window, naming what it saw", () => {
    expect(() => selectDarwinInputWindow([{ id: 7, x: 0, y: 0, width: 0, height: 0 }], 4242)).toThrow(
      /no on-screen window to target for pid 4242; the app owns 0 usable window\(s\) of the 1 listed/,
    )
    expect(() => selectDarwinInputWindow([], 4242)).toThrow(
      /pid 4242; the app owns 0 usable window\(s\) of the 0 listed/,
    )
  })

  it("refuses a census row that is not a finite frame", () => {
    expect(() => selectDarwinInputWindow([{ id: 1, x: 0, y: 0, width: "800", height: 600 }], 4242)).toThrow(
      /has no finite width/,
    )
    expect(() => selectDarwinInputWindow("nope", 4242)).toThrow(/is not an array/)
  })
})
