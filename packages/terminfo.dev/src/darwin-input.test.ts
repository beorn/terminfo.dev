/**
 * @failure macOS input installs a CGEvent adapter without the Accessibility grant, without a built helper, or after an injected key never reached the app, so a runner failure is read as terminal behaviour.
 * @level l2
 * @consumer macOS app collector input binding (33574)
 * @reach fake input and compiler/signing processes; real temporary files/kernel locks; no native TCC or WindowServer proof
 * @testonly none
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
  buildDarwinInputHelper,
  createDarwinInput,
  keysOnlyMechanism,
  ownedHostHelperPath,
  ownedHostMechanism,
  DARWIN_INPUT_SELF_TEST_KEYCODE_ECHO,
  DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM,
  DARWIN_INPUT_SELF_TEST_KEYSYM,
  selectDarwinInputWindow,
  viewportScrollRoute,
  type DarwinInputOptions,
} from "./darwin-input.ts"
import { ALACRITTY_0_17_VIEWPORT_KEYS } from "./owned-terminal.ts"
import { describeInputContract, fakeInputMechanism } from "./testing/input-contract.ts"
import { withTTYOperation, withTTYQueryTrace } from "./tty.ts"
import type { InputMechanism } from "./input-fixture.ts"

const helperBuild = vi.hoisted(() => ({
  run: undefined as undefined | ((file: string, args: readonly string[], options?: unknown) => Buffer),
  home: undefined as string | undefined,
  restoreUid: undefined as undefined | (() => void),
  calls: [] as { file: string; args: readonly string[]; options?: unknown }[],
}))
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>()
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs")
  const path = await vi.importActual<typeof import("node:path")>("node:path")
  helperBuild.home = fs.realpathSync(fs.mkdtempSync(path.join(actual.tmpdir(), "terminfo-helper-home-")))
  fs.mkdirSync(path.join(helperBuild.home, "Library", "Keychains"), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(helperBuild.home, "Library", "Keychains", "terminfo-helper.keychain-db"), "fixture", {
    mode: 0o600,
  })
  return { ...actual, homedir: () => helperBuild.home! }
})
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>()
  return {
    ...actual,
    execFileSync(file: string, args: readonly string[] = [], options?: unknown) {
      return helperBuild.run
        ? helperBuild.run(file, args, options)
        : actual.execFileSync(file, args, options as import("node:child_process").ExecFileSyncOptions)
    },
  }
})
afterEach(() => {
  helperBuild.run = undefined
  helperBuild.restoreUid?.()
  helperBuild.restoreUid = undefined
})
afterAll(() => {
  if (helperBuild.home) rmSync(helperBuild.home, { recursive: true, force: true })
})

function keychainStatusFixture(fail: string | undefined, args: readonly string[]): Buffer {
  if (fail === "keychain-command") throw new Error("keychain status command unavailable")
  if (fail === "malformed-keychain") return Buffer.from("not JSON")
  if (fail === "empty-keychain") return Buffer.alloc(0)
  if (fail === "missing-keychain-fields") return Buffer.from('{"unlocked":true}')
  return Buffer.from(
    JSON.stringify({
      operation: "signing-keychain-status",
      keychain: fail === "wrong-keychain-path" ? join(helperBuild.home!, "login.keychain-db") : args[1],
      openStatus: fail === "unknown-keychain" ? -25308 : 0,
      statusResult: fail === "unknown-keychain" ? null : 0,
      rawStatus:
        fail === "unknown-keychain" ? null : fail === "locked-keychain" || fail === "inconsistent-keychain" ? 2 : 1,
      unlocked:
        fail === "unknown-keychain" ? null : fail === "string-keychain-flag" ? "true" : fail !== "locked-keychain",
    }),
  )
}

// 35130: compile/sign are process-boundary stubs, not native trust proof. Files and overlapping kernel locks are real.
async function helperBuildFixture(
  fail?:
    | "compile"
    | "sign"
    | "verify"
    | "metadata"
    | "locked-keychain"
    | "unknown-keychain"
    | "malformed-keychain"
    | "inconsistent-keychain"
    | "keychain-command"
    | "empty-keychain"
    | "wrong-keychain-path"
    | "string-keychain-flag"
    | "missing-keychain-fields"
    | "wrong-owned-keychain"
    | "missing-keychain-resource",
) {
  helperBuild.restoreUid?.()
  helperBuild.restoreUid = undefined
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  const keychain = join(helperBuild.home!, "Library", "Keychains", "terminfo-helper.keychain-db")
  if (fail === "missing-keychain-resource") rmSync(keychain)
  else writeFileSync(keychain, "fixture", { mode: 0o600 })
  helperBuild.calls = []
  helperBuild.run = (file, args, options) => {
    helperBuild.calls.push({ file, args, options })
    if (args[0] === "signing-keychain-status") return keychainStatusFixture(fail, args)
    if (file === "/usr/bin/lockf") {
      if (process.platform === "darwin") {
        return actual.execFileSync(file, args, options as import("node:child_process").ExecFileSyncOptions) as Buffer
      }
      try {
        return actual.execFileSync(
          "/usr/bin/flock",
          ["--exclusive", "--nonblock", "3"],
          options as import("node:child_process").ExecFileSyncOptions,
        ) as Buffer
      } catch (error) {
        // Darwin lockf uses EX_TEMPFAIL; Linux flock uses 1 for the same real contention.
        if ((error as { status?: number }).status === 1) Object.assign(error as object, { status: 75 })
        throw error
      }
    }
    if (file === "/usr/bin/swiftc") {
      if (args[0] === "--version") {
        if (fail === "wrong-owned-keychain") {
          // Model a keychain uid different from the reader after the real publication lease is acquired.
          // No chown/sudo or forged filesystem metadata; only the reader's reported uid is injected.
          const uid = process.getuid!()
          const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1)
          helperBuild.restoreUid = () => spy.mockRestore()
        }
        return Buffer.from("fixture Swift toolchain")
      }
      if (fail === "compile") throw new Error("compiler rejected staged source")
      writeFileSync(args[2]!, readFileSync(args[3]!))
      return Buffer.alloc(0)
    }
    if (file === "/usr/bin/codesign") {
      if (args.includes("--sign")) {
        if (fail === "sign") throw new Error("signer unavailable")
        const path = args.at(-1)!
        writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("-signed")]))
      }
      if (args.includes("--verify") && fail === "verify") throw new Error("candidate signature invalid")
      if (args.includes("--display") && fail === "metadata") return Buffer.alloc(0)
      return args.includes("--display")
        ? Buffer.from(
            'designated => identifier "dev.terminfo.owned-input-helper" and certificate leaf = H"abababababababababababababababababababab"',
          )
        : Buffer.alloc(0)
    }
    throw new Error(`unexpected helper build command ${file}`)
  }
}

describe("owned Mac helper publication", () => {
  it("publishes fresh owned builds at one path and retains exclusive ownership until release", async () => {
    await helperBuildFixture()
    const root = realpathSync(mkdtempSync(join(tmpdir(), "terminfo-helper-publication-")))
    const source = join(root, "main.swift")
    const evidence: unknown[] = []
    const owned = {
      directory: join(root, "installed"),
      identity: "ab".repeat(20),
      report: (fact: unknown) => evidence.push(fact),
    }
    let current: ReturnType<typeof buildDarwinInputHelper> | undefined
    try {
      writeFileSync(source, "first staged source")
      current = buildDarwinInputHelper(source, join(root, "run-a"), owned)
      const readinessIndex = helperBuild.calls.findIndex((call) => call.args[0] === "signing-keychain-status")
      const signIndex = helperBuild.calls.findIndex(
        (call) => call.file === "/usr/bin/codesign" && call.args.includes("--sign"),
      )
      expect(readinessIndex).toBeGreaterThanOrEqual(0)
      expect(readinessIndex).toBeLessThan(signIndex)
      expect(helperBuild.calls[readinessIndex]).toMatchObject({
        file: join(root, "run-a", "darwin-input-helper"),
        args: [
          "signing-keychain-status",
          join(helperBuild.home!, "Library", "Keychains", "terminfo-helper.keychain-db"),
        ],
        options: { timeout: 10_000 },
      })
      expect(typeof current === "string" ? current : current.path).toBe(join(owned.directory, "darwin-input-helper"))
      expect(readFileSync(current.path, "utf8")).toBe("first staged source-signed")
      expect(readFileSync(join(root, "run-a", "darwin-input-helper"), "utf8")).toBe("first staged source-signed")
      expect(() => buildDarwinInputHelper(source, join(root, "overlap"), owned)).toThrow(/publication.*in use/)
      current.dispose()
      current = undefined
      writeFileSync(source, "second staged source")
      current = buildDarwinInputHelper(source, join(root, "run-b"), owned)
      expect(current.path).toBe(join(owned.directory, "darwin-input-helper"))
      expect(readFileSync(current.path, "utf8")).toBe("second staged source-signed")
      expect(evidence.at(-1)).toMatchObject({
        compiler: "/usr/bin/swiftc",
        compilerVersion: "fixture Swift toolchain",
        identity: owned.identity,
        executedPath: current.path,
        installedBytesEqual: true,
      })
      current.dispose()
      current = undefined
      const statusCalls = helperBuild.calls.filter((call) => call.args[0] === "signing-keychain-status").length
      const hosted = buildDarwinInputHelper(source, join(root, "hosted"))
      expect(helperBuild.calls.filter((call) => call.args[0] === "signing-keychain-status")).toHaveLength(statusCalls)
      expect(hosted.path).toBe(join(root, "hosted", "darwin-input-helper"))
      expect(readFileSync(hosted.path, "utf8")).toBe("second staged source")
      hosted.dispose()
    } finally {
      if (typeof current === "object") current.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    "compile",
    "sign",
    "verify",
    "metadata",
    "locked-keychain",
    "unknown-keychain",
    "malformed-keychain",
    "inconsistent-keychain",
    "keychain-command",
    "empty-keychain",
    "wrong-keychain-path",
    "string-keychain-flag",
    "missing-keychain-fields",
    "wrong-owned-keychain",
    "missing-keychain-resource",
  ] as const)("does not use prior installed bytes after a %s failure and releases the failed lease", async (fail) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "terminfo-helper-failure-")))
    const source = join(root, "main.swift")
    const owned = { directory: join(root, "installed"), identity: "ab".repeat(20) }
    try {
      await helperBuildFixture()
      writeFileSync(source, "previous source")
      const previous = buildDarwinInputHelper(source, join(root, "previous"), owned)
      previous.dispose()
      await helperBuildFixture(fail)
      writeFileSync(source, "new source")
      expect(() => buildDarwinInputHelper(source, join(root, "failed"), owned)).toThrow(
        fail.includes("keychain")
          ? fail === "locked-keychain"
            ? /helper.*failed.*LOCKED/
            : /helper.*failed.*UNKNOWN/
          : /helper.*failed/,
      )
      if (fail.includes("keychain")) {
        expect(helperBuild.calls.filter((call) => call.file === "/usr/bin/codesign")).toHaveLength(0)
      }
      if (fail === "wrong-owned-keychain") {
        expect(helperBuild.calls.filter((call) => call.args[0] === "signing-keychain-status")).toHaveLength(0)
      }
      expect(readFileSync(join(owned.directory, "darwin-input-helper"), "utf8")).toBe("previous source-signed")
      await helperBuildFixture()
      const next = buildDarwinInputHelper(source, join(root, "next"), owned)
      expect(readFileSync(next.path, "utf8")).toBe("new source-signed")
      next.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    "missing signer",
    "ambiguous signer",
    "linked directory",
    "writable directory",
    "linked executable",
  ] as const)("refuses %s without changing an existing file", async (bad) => {
    await helperBuildFixture()
    const root = realpathSync(mkdtempSync(join(tmpdir(), "terminfo-helper-destination-")))
    const source = join(root, "main.swift")
    const directory = join(root, "installed")
    const outside = join(root, "outside")
    const identity =
      bad === "missing signer" ? undefined : bad === "ambiguous signer" ? "display name" : "ab".repeat(20)
    try {
      writeFileSync(source, "staged source")
      writeFileSync(outside, "existing file")
      if (bad === "linked directory") symlinkSync(root, directory)
      else {
        mkdirSync(directory, { mode: 0o700 })
        if (bad === "writable directory") chmodSync(directory, 0o777)
        if (bad === "linked executable") symlinkSync(outside, join(directory, "darwin-input-helper"))
      }
      expect(() => buildDarwinInputHelper(source, join(root, "run"), { directory, identity })).toThrow(
        /approved certificate fingerprint|symlink|controlled/,
      )
      expect(readFileSync(outside, "utf8")).toBe("existing file")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // CTO428c2f50 explicitly requires dispatch isolation; real unsigned-arm qualification is separate.
  it("dispatches the read-only keychain command without trust, window reads, or input calls", () => {
    const source = readFileSync(new URL("../../../native/darwin-input/main.swift", import.meta.url), "utf8")
    const arm = source.match(/case "signing-keychain-status":([\s\S]*?)\ncase "trust":/)?.[1]
    expect(arm).toBeTypeOf("string")
    expect(arm).toContain("SecKeychainOpen")
    expect(arm).toContain("SecKeychainGetStatus")
    expect(arm).not.toMatch(/\b(?:requireTrust|trusted|AX\w+|CG\w+|windowRows|requireKeyWindow|post\w*)\s*\(/)
  })
})

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

describe("macOS input, keys only, on a hosted app named by its capture (34313)", () => {
  it("refuses every pointer verb by name and keeps the pre-delivery key restriction", async () => {
    const fake = fakeInputMechanism()
    let delivered = false
    const keys = keysOnlyMechanism(fake.mechanism, () => delivered)
    await keys.key(DARWIN_INPUT_SELF_TEST_KEYSYM)
    await expect(keys.key("shift+Page_Up")).rejects.toThrow(/only the fixed self-test keys/)
    delivered = true
    await keys.key("shift+Page_Up")
    await expect(keys.moveTo(1, 2, { verifyPointer: true, dragged: false })).rejects.toThrow(
      /pointer movement refused: this hosted install posts keys only/,
    )
    await expect(keys.geometry()).rejects.toThrow(/pointer placement refused: this hosted install posts keys only/)
    await expect(keys.click(4)).rejects.toThrow(/a click refused: this hosted install posts keys only/)
    await expect(keys.press(1)).rejects.toThrow(/a button press refused/)
    await expect(keys.release(1)).rejects.toThrow(/a button release refused/)
    expect(fake.calls.map((call) => call.op)).toEqual(["key", "key"])
  })

  it("posts each key to the captured window with no tab tty, so the helper runs no Terminal.app query", async () => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-darwin-input-keys-"))
    const argv = join(directory, "argv.txt")
    const helper = join(directory, "helper")
    writeFileSync(
      helper,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${argv}'`,
        'case "$1" in',
        '  key) printf \'posted=key route=pid frontmost=true front-window=true key=true pid=%s window=%s\\n\' "$2" "$3" ;;',
        "esac",
        "",
      ].join("\n"),
    )
    chmodSync(helper, 0o755)
    const facts: string[] = []
    try {
      const input = await createDarwinInput(
        options({
          appName: "alacritty",
          mechanism: undefined,
          helperPath: helper,
          windowId: 51,
          windowTty: "/dev/ttys007",
          keysOnly: true,
          report: (fact) => facts.push(fact),
          selfTest: async (inject) => {
            await inject()
            return DARWIN_INPUT_SELF_TEST_KEYSYM
          },
        }),
      )
      await input.injectKey("shift+Page_Up")
      await expect(input.injectClick(4)).rejects.toThrow(/posts keys only/)
      const calls = readFileSync(argv, "utf8").trim().split("\n")
      // Four arguments after the verb, never a fifth: a tab tty sends the helper's selected-tab query to Terminal.app.
      expect(calls.filter((call) => call.startsWith("key "))).toEqual(["key 4242 51 z", "key 4242 51 shift+Page_Up"])
      expect(calls.filter((call) => call.startsWith("mouse "))).toEqual([])
      expect(facts[0]).toMatch(
        /^darwin input installed \(keys only: the capture's window 51, a key-window proof per post, no pointer\)/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses a keys-only install without the captured window id, or combined with an owned host", async () => {
    await expect(createDarwinInput(options({ keysOnly: true }))).rejects.toThrow(
      /keys-only macOS input needs the window its capture install selected/,
    )
    await expect(
      createDarwinInput(options({ keysOnly: true, ownedHost: true, windowId: 51, windowTty: "/dev/ttys007" })),
    ).rejects.toThrow(/keys-only and owned-host input are separate routes/)
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

describe("the viewport route over keys-only input (34313)", () => {
  const viewport = { route: "hosted alacritty 0.17.0 default bindings", keys: ALACRITTY_0_17_VIEWPORT_KEYS }

  /**
   * @failure A portable step reaches the app as the wrong key, or as anything but a key, so a page press scrolls
   *   nothing (or clicks) and the rows read an unmoved viewport as the feature's absence.
   * @level l1
   * @consumer The viewport-history rows on hosted alacritty 0.17.0.
   * @testonly none
   */
  it("maps each portable step to its reviewed key and posts nothing else", async () => {
    const posted: string[] = []
    const input = {
      injectKey: async (keys: string) => void posted.push(keys),
      injectClick: async () => {
        throw new Error("a viewport step must never click")
      },
    }
    const route = viewportScrollRoute(viewport, { input })
    expect(route.route).toBe(viewport.route)
    for (const step of ["pageUp", "pageDown", "top", "bottom"] as const) await route.press(step)
    expect(posted).toEqual(["shift+Page_Up", "shift+Page_Down", "shift+Home", "shift+End"])
  })

  /**
   * @failure A refused keys-only install removes the route, so the rows fall back to the app's declared
   *   "no pane read" Untestable: our missing input reads as the app's missing feature (@cto cf1ffd6d amendment 4).
   * @level l1
   * @consumer The viewport-history rows on a hosted run whose Accessibility grant or self-test failed.
   * @testonly none
   */
  it("keeps the route after a refused install, names the refusal, and fails every press by name", async () => {
    const route = viewportScrollRoute(viewport, { refusal: "self-test key did not echo" })
    expect(route.route).toContain(viewport.route)
    expect(route.route).toContain("input not installed: self-test key did not echo")
    await expect(route.press("pageUp")).rejects.toThrow(
      /viewport input not installed \(34313\): self-test key did not echo/,
    )
  })

  /**
   * @failure A hold dispatched before a row's wall lands after the bottom was put back, or during the next row,
   *   so a later row reads a scrolled window as its own (@cto e1cfff79 items 2-3, 34645). Existing tests press
   *   synchronously and see neither an in-flight post nor one that lands and then rejects.
   * @level l1
   * @consumer The held-viewport reader and the row wall, which return to the bottom through this route.
   * @testonly none
   */
  it("settles every dispatched step before returning to the bottom, and covers a post that landed then rejected", async () => {
    const posted: string[] = []
    let finishHold: (() => void) | undefined
    const input = {
      injectKey: (keys: string) => {
        posted.push(keys)
        if (keys === "shift+Page_Up") return new Promise<void>((resolve) => (finishHold = resolve))
        if (keys === "shift+Home") return Promise.reject(new Error("helper exited 1 after posting"))
        return Promise.resolve()
      },
      injectClick: async () => {},
    }
    const route = viewportScrollRoute(viewport, { input })
    const hold = route.press("pageUp")
    const returning = route.returnToBottom?.()
    await Promise.resolve()
    // The bottom must not be posted while the hold is still in flight.
    expect(posted).toEqual(["shift+Page_Up"])
    finishHold?.()
    await hold
    await expect(returning).resolves.toBe("bottom-pressed")
    expect(posted).toEqual(["shift+Page_Up", "shift+End"])
    // Exactly once: a route already back at the bottom has nothing left to post.
    await expect(route.returnToBottom?.()).resolves.toBe("not-held")
    // A post that may have landed before its helper failed still counts as held.
    await expect(route.press("top")).rejects.toThrow(/after posting/)
    await expect(route.returnToBottom?.()).resolves.toBe("bottom-pressed")
    expect(posted).toEqual(["shift+Page_Up", "shift+End", "shift+Home", "shift+End"])
  })

  /**
   * @failure An abandoned callback wakes after its wall and posts a step into the next row's window (34645).
   * @level l1
   * @consumer The row wall in probes/unified.ts.
   * @testonly none
   */
  it("refuses a step, or a return to the bottom, asked from a row abandoned at its wall", async () => {
    const posted: string[] = []
    const input = { injectKey: async (keys: string) => void posted.push(keys), injectClick: async () => {} }
    const route = viewportScrollRoute(viewport, { input })
    let scope: { abandon(): void } | undefined
    const late = await withTTYOperation(
      () =>
        withTTYQueryTrace(
          [],
          [],
          async () => {
            await route.press("pageUp")
            scope?.abandon()
            const press = await route.press("bottom").then(
              () => "posted",
              (error: Error) => error.message,
            )
            const back = await route.returnToBottom?.().then(
              (value) => value,
              (error: Error) => error.message,
            )
            return { press, back }
          },
          { onScope: (value) => (scope = value) },
        ),
      { write: () => true } as unknown as NodeJS.WriteStream,
    )
    expect(late.press).toMatch(/abandoned at its wall/)
    expect(late.back).toMatch(/abandoned at its wall/)
    expect(posted).toEqual(["shift+Page_Up"])
    // The wall, outside the abandoned scope, still owns the bottom.
    await expect(route.returnToBottom?.()).resolves.toBe("bottom-pressed")
    expect(posted).toEqual(["shift+Page_Up", "shift+End"])
  })

  /**
   * @failure A row's return to the bottom starts before its wall, waits on a hold still in flight, and posts the
   *   bottom after the wall fired; the wall then posts it a second time (@dev/18 5c1280e5 note a, 34645).
   * @level l1
   * @consumer The held-viewport reader's failure return and the row wall in probes/unified.ts.
   * @testonly none
   */
  it("posts nothing from a return that began before the wall and finished after it", async () => {
    const posted: string[] = []
    let finishHold: (() => void) | undefined
    const input = {
      injectKey: (keys: string) => {
        posted.push(keys)
        return keys === "shift+Page_Up" ? new Promise<void>((resolve) => (finishHold = resolve)) : Promise.resolve()
      },
      injectClick: async () => {},
    }
    const route = viewportScrollRoute(viewport, { input })
    let scope: { abandon(): void } | undefined
    const late = await withTTYOperation(
      () =>
        withTTYQueryTrace(
          [],
          [],
          async () => {
            const hold = route.press("pageUp")
            const back = route.returnToBottom?.().then(
              (value) => value,
              (error: Error) => error.message,
            )
            await Promise.resolve()
            scope?.abandon()
            finishHold?.()
            await hold
            return back
          },
          { onScope: (value) => (scope = value) },
        ),
      { write: () => true } as unknown as NodeJS.WriteStream,
    )
    expect(late).toMatch(/abandoned at its wall/)
    expect(posted).toEqual(["shift+Page_Up"])
    // Exactly one bottom, from the wall.
    await expect(route.returnToBottom?.()).resolves.toBe("bottom-pressed")
    expect(posted).toEqual(["shift+Page_Up", "shift+End"])
  })
})
