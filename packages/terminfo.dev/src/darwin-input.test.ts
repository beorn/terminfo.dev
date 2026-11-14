/**
 * @failure macOS input installs a CGEvent adapter without the Accessibility grant, without a built helper, or after an injected key never reached the app, so a runner failure is read as terminal behaviour.
 * @level l2
 * @consumer macOS app collector input binding (33574)
 * @reach in-process: fake mechanism, no helper binary and no WindowServer
 * @testonly none
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createDarwinInput,
  ownedHostHelperPath,
  ownedHostMechanism,
  DARWIN_INPUT_SELF_TEST_KEYCODE_ECHO,
  DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM,
  DARWIN_INPUT_SELF_TEST_KEYSYM,
  selectDarwinInputWindow,
  type DarwinInputOptions,
} from "./darwin-input.ts"
import { describeInputContract, fakeInputMechanism } from "./testing/input-contract.ts"
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

  it("refuses the install when the app echoes nothing back, naming both posting routes", async () => {
    await expect(createDarwinInput(options({ selfTest: async () => null }))).rejects.toThrow(
      /input not delivered to Terminal\.app: the CGEvent helper posted keysym "z" \(virtual keycode 0 with a unicode payload\) to pid 4242 and the app's TTY echoed nothing; the virtual-keycode route \("code:7", which echoed nothing\) also delivered nothing; refusing to measure input rows through it/,
    )
  })

  it("names the unicode payload as the defect when the keycode route delivers and the unicode route does not", async () => {
    const fake = fakeInputMechanism()
    const probes: string[] = []
    await expect(
      createDarwinInput(
        options({
          mechanism: fake.mechanism,
          selfTest: async (inject) => {
            const before = fake.calls.filter((call) => call.op === "key").length
            await inject()
            const posted = fake.calls.filter((call) => call.op === "key")[before]
            probes.push(String(posted?.args[0]))
            return posted?.args[0] === DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM
              ? DARWIN_INPUT_SELF_TEST_KEYCODE_ECHO
              : null
          },
        }),
      ),
    ).rejects.toThrow(
      /echoed nothing; the virtual-keycode route \("code:7", which delivered "x"\); refusing to measure input rows through it/,
    )
    expect(probes).toEqual([DARWIN_INPUT_SELF_TEST_KEYSYM, DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM])
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

// 33587, @cto 60e39dfc: codimac's console shows other people's apps, so nothing but the fixed
// self-test keys may be posted before delivery is proven. Pointer verbs stopped being refused here when
// @cto ruled (cbc34e67) that their identity is proved in the helper — pid, window, re-read frame, one lock
// across proof and post — so this guard now covers keys only and lets the proved mechanism through.
describe("macOS input on an owned host", () => {
  it("keeps the pre-delivery key restriction and passes pointer verbs to the mechanism that proves identity", async () => {
    const fake = fakeInputMechanism()
    let delivered = false
    const owned = ownedHostMechanism(fake.mechanism, () => delivered)
    await owned.key(DARWIN_INPUT_SELF_TEST_KEYSYM)
    await owned.key(DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM)
    await expect(owned.key("a")).rejects.toThrow(/refused on an owned host: only the fixed self-test keys/)
    delivered = true
    await owned.key("a")
    await owned.moveTo(1, 2, { verifyPointer: true, dragged: false })
    await owned.click(1)
    await owned.press(1)
    await owned.release(1)
    expect(fake.calls.filter((call) => call.op === "key").map((call) => call.args[0])).toEqual([
      DARWIN_INPUT_SELF_TEST_KEYSYM,
      DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM,
      "a",
    ])
    expect(
      fake.calls.filter((call) => ["moveTo", "click", "press", "release"].includes(call.op)).map((call) => call.op),
    ).toEqual(["moveTo", "click", "press", "release"])
  })

  it("posts each key to the app pid with the run's own window id, and logs every helper line", async () => {
    // A stand-in helper records its argv, so the key verb's shape is read, not inferred.
    const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-input-helper-"))
    const argv = join(directory, "argv.txt")
    const helper = join(directory, "helper")
    writeFileSync(
      helper,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${argv}'`,
        'case "$1" in',
        '  windows) printf \'[{"id":33,"x":40,"y":40,"width":700,"height":400}]\\n\' ;;',
        '  front) printf \'frontmost=true front-window=true key=true pid=%s window=%s\\n\' "$2" "$3" ;;',
        '  key) printf \'posted=key route=pid frontmost=true front-window=true key=true pid=%s window=%s\\n\' "$2" "$3" ;;',
        "esac",
        "",
      ].join("\n"),
    )
    chmodSync(helper, 0o755)
    const logged: string[] = []
    const facts: string[] = []
    try {
      const input = await createDarwinInput(
        options({
          mechanism: undefined,
          helperPath: helper,
          windowId: 33,
          windowTty: "/dev/ttys004",
          ownedHost: true,
          log: (line) => logged.push(line),
          report: (fact) => facts.push(fact),
          selfTest: async (inject) => {
            await inject()
            return DARWIN_INPUT_SELF_TEST_KEYSYM
          },
        }),
      )
      await input.injectKey("a")
      // The click reaches the helper with the pid and the run's own window: the helper re-reads that
      // window's frame, refuses a point outside it, and posts under its own lock (@cto cbc34e67).
      await input.injectClick(1)
      const calls = readFileSync(argv, "utf8").trim().split("\n")
      // Every key names the pid and the run's own window; the refused click never reaches a mouse verb.
      // The run's tab tty rides on every key, so the helper proves the selected tab in the same call.
      expect(calls.filter((call) => call.startsWith("key "))).toEqual([
        "key 4242 33 z /dev/ttys004",
        "key 4242 33 a /dev/ttys004",
      ])
      // Window-relative coordinates and the identity, in one argv: no screen point leaves this process.
      expect(calls.filter((call) => call.startsWith("mouse "))).toEqual([
        "mouse move 4242 33 plain 400 300",
        "mouse click 4242 33 1",
      ])
      expect(logged.filter((line) => line.startsWith("posted="))).toEqual([
        "posted=key route=pid frontmost=true front-window=true key=true pid=4242 window=33",
        "posted=key route=pid frontmost=true front-window=true key=true pid=4242 window=33",
      ])
      expect(logged).not.toContain('[{"id":33,"x":40,"y":40,"width":700,"height":400}]')
      expect(facts[0]).toMatch(
        /^darwin input installed \(owned host: keys and pointer addressed to the run's own window, one posting at a time\): pid 4242, window 33,/,
      )
      // Where the permission comes from rides on the same fact: a rebuilt host must fail recognisably.
      expect(facts[0]).toMatch(
        /permission: inherited from the ssh session's \/usr\/libexec\/sshd-keygen-wrapper Accessibility grant/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("macOS input on an owned host: tab and helper", () => {
  it("refuses an owned host install without the run's own window id and tab tty", async () => {
    await expect(createDarwinInput(options({ ownedHost: true, windowId: 33 }))).rejects.toThrow(
      /owned host needs the run's own window id and tab tty/,
    )
    await expect(createDarwinInput(options({ ownedHost: true, windowTty: "/dev/ttys004" }))).rejects.toThrow(
      /owned host needs the run's own window id and tab tty/,
    )
  })

  it("builds the helper from source, and refuses a preset helper binary", () => {
    expect(ownedHostHelperPath(undefined, () => "/built/helper")).toBe("/built/helper")
    expect(ownedHostHelperPath("", () => "/built/helper")).toBeUndefined()
    expect(() => ownedHostHelperPath("/somewhere/helper", () => "/built/helper")).toThrow(
      /TERMINFO_DARWIN_INPUT_HELPER="\/somewhere\/helper" is refused/,
    )
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
