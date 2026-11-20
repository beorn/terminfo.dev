import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"

import type { InputFixture, ViewportScroll, ViewportStep } from "@terminfo/probe-defs"
import { command } from "./capture-core.ts"
import { createInjectedInput, type InputButton, type InputMechanism, type OwnedFrame } from "./input-fixture.ts"
import { currentTTYTraceMark } from "./tty.ts"

/** The compiled helper the macOS job builds from native/darwin-input/main.swift; never a committed binary. */
export const DARWIN_INPUT_HELPER_ENV = "TERMINFO_DARWIN_INPUT_HELPER"
export const DARWIN_INPUT_SIGNING_IDENTITY_ENV = "TERMINFO_DARWIN_INPUT_SIGNING_IDENTITY"
const DARWIN_INPUT_IDENTIFIER = "dev.terminfo.owned-input-helper"
const DARWIN_INPUT_SIGNING_KEYCHAIN = join(homedir(), "Library", "Keychains", "terminfo-helper.keychain-db")

interface OwnedHelperPublication {
  directory: string
  /** Approved certificate SHA-1 fingerprint, not an ambiguous keychain display name. Never a private key. */
  identity: string | undefined
  report?: (evidence: Record<string, unknown>) => void
}

/** Point-in-time prerequisite only: signing still has to prove access to the private key. */
function requireSigningKeychain(helper: string): { keychain: string; rawStatus: number; unlocked: boolean } {
  const keychain = DARWIN_INPUT_SIGNING_KEYCHAIN
  let observed: { keychain: string; rawStatus: number; unlocked: boolean }
  try {
    const stat = lstatSync(keychain)
    if (
      !isAbsolute(keychain) ||
      resolve(keychain) !== keychain ||
      realpathSync(keychain) !== keychain ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error("required dedicated keychain is not this user's canonical controlled regular file")
    }
    const payload = JSON.parse(
      String(
        execFileSync(helper, ["signing-keychain-status", keychain], {
          timeout: 10_000,
          maxBuffer: 65_536,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    ) as Record<string, unknown> | null
    const rawStatus = payload?.rawStatus
    if (
      !payload ||
      Array.isArray(payload) ||
      payload.operation !== "signing-keychain-status" ||
      payload.keychain !== keychain ||
      payload.openStatus !== 0 ||
      payload.statusResult !== 0 ||
      typeof rawStatus !== "number" ||
      !Number.isInteger(rawStatus) ||
      rawStatus < 0 ||
      rawStatus > 0xffff_ffff ||
      typeof payload.unlocked !== "boolean" ||
      payload.unlocked !== ((rawStatus & 1) !== 0)
    ) {
      throw new Error("status command returned unavailable, malformed, or inconsistent Security status")
    }
    observed = { keychain, rawStatus, unlocked: payload.unlocked }
  } catch (error) {
    throw new Error(
      `${keychain}: signing prerequisite UNKNOWN: ${String(error)}; the credential custodian must restore readable keychain status before another build`,
    )
  }
  if (!observed.unlocked) {
    throw new Error(
      `${keychain}: signing prerequisite LOCKED (rawStatus=${observed.rawStatus}); the credential custodian must unlock it before another build`,
    )
  }
  return observed
}

function helperHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function requireHelperDestination(directory: string): number {
  const uid = process.getuid?.()
  if (uid === undefined || !isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("macOS input helper publication requires this user's absolute directory")
  }
  let ancestor = directory
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (realpathSync(ancestor) !== ancestor) throw new Error("macOS input helper publication directory follows a symlink")
  const parent = lstatSync(ancestor)
  if (parent.uid !== uid || (parent.mode & 0o022) !== 0) {
    throw new Error("macOS input helper publication parent is not controlled by this user")
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const controlled = (path: string, directoryExpected: boolean) => {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (
      stat &&
      (stat.isSymbolicLink() ||
        (directoryExpected ? !stat.isDirectory() : !stat.isFile()) ||
        stat.uid !== uid ||
        (stat.mode & 0o022) !== 0)
    ) {
      throw new Error(
        `macOS input helper publication requires a user-controlled ${directoryExpected ? "directory" : "regular file"}: ${path}`,
      )
    }
  }
  controlled(directory, true)
  controlled(join(directory, "darwin-input-helper"), false)
  return uid
}

/** Parent retains the inherited open-file-description lock after lockf exits; close releases it, even on process death. */
function helperPublicationLease(directory: string): () => void {
  const uid = requireHelperDestination(directory)
  const fd = openSync(
    join(directory, ".publication.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
      throw new Error("macOS input helper publication lock is not this user's controlled regular file")
    }
    try {
      execFileSync("/usr/bin/lockf", ["-t", "0", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 5_000 })
    } catch (error) {
      if ((error as { status?: number }).status === 75) {
        throw new Error("macOS input helper publication is in use by another collector")
      }
      throw error
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
  let held = true
  return () => {
    if (held) {
      held = false
      closeSync(fd)
    }
  }
}

/**
 * Compile the helper with the host's own swiftc, for an owned Mac that has no job step to build it
 * (33587), retaining a fresh run artifact. The owned route publishes a verified signed copy at its
 * fixed path under a collector-lifetime lease (35130); hosted input keeps the run path.
 */
export function buildDarwinInputHelper(
  source: string,
  outputDirectory: string,
  owned?: OwnedHelperPublication,
): { path: string; dispose(): void } {
  const helper = join(outputDirectory, "darwin-input-helper")
  let release = () => {}
  let replacement: string | undefined
  let step = "configuration"
  try {
    const identity = owned?.identity?.trim().toLowerCase()
    if (owned) {
      if (!identity || !/^[a-f0-9]{40}$/.test(identity)) {
        throw new Error(
          `owned macOS input requires ${DARWIN_INPUT_SIGNING_IDENTITY_ENV} to name the approved certificate fingerprint`,
        )
      }
      step = "publication ownership"
      release = helperPublicationLease(owned.directory)
    }
    mkdirSync(outputDirectory)
    const sourceHash = owned ? helperHash(source) : undefined
    const argv = ["-O", "-o", helper, source]
    step = "compilation"
    execFileSync("/usr/bin/swiftc", argv, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    })
    if (!owned || !identity) return { path: helper, dispose: release }
    step = "compiler identity"
    const compilerVersion = String(
      execFileSync("/usr/bin/swiftc", ["--version"], { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }),
    ).trim()
    if (!compilerVersion) throw new Error("macOS input helper compiler returned no version")
    const expectedRequirement = `identifier "${DARWIN_INPUT_IDENTIFIER}" and certificate leaf = H"${identity}"`
    step = "signing keychain prerequisite"
    const signingKeychain = requireSigningKeychain(helper)
    step = "signing"
    execFileSync(
      "/usr/bin/codesign",
      [
        "--sign",
        identity,
        "--identifier",
        DARWIN_INPUT_IDENTIFIER,
        "--timestamp=none",
        "--requirements",
        `=designated => ${expectedRequirement}`,
        helper,
      ],
      { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
    )
    step = "signature verification"
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--test-requirement", `=${expectedRequirement}`, helper],
      { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    )
    step = "designated requirement inspection"
    const requirementOutput = String(
      execFileSync("/usr/bin/codesign", ["--display", "--requirements", "-", helper], {
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )
    const actualRequirement = requirementOutput.match(/(?:#\s*)?designated\s*=>\s*(.+)/)?.[1]?.trim()
    if (!actualRequirement) throw new Error("macOS input helper has no readable designated requirement")
    if (sourceHash !== helperHash(source)) {
      throw new Error("macOS input helper staged source changed during compilation")
    }
    step = "publication"
    const binaryHash = helperHash(helper)
    const executedPath = join(owned.directory, "darwin-input-helper")
    replacement = join(owned.directory, `.darwin-input-helper-${randomUUID()}`)
    copyFileSync(helper, replacement, constants.COPYFILE_EXCL)
    chmodSync(replacement, 0o700)
    if (helperHash(replacement) !== binaryHash) {
      throw new Error("macOS input helper publication copy differs from the signed run artifact")
    }
    renameSync(replacement, executedPath)
    replacement = undefined
    if (helperHash(executedPath) !== binaryHash) {
      throw new Error("macOS input helper installed bytes differ from the signed run artifact")
    }
    owned.report?.({
      sourceHash,
      compiler: "/usr/bin/swiftc",
      compilerArgv: argv,
      compilerVersion,
      binaryHash,
      identity,
      expectedRequirement,
      actualRequirement,
      signingKeychain,
      executedPath,
      installedBytesEqual: true,
    })
    return { path: executedPath, dispose: release }
  } catch (error) {
    release()
    const stderr = (error as { stderr?: Buffer | string }).stderr
    const detail = stderr && String(stderr).trim() ? String(stderr).trim() : String(error)
    throw new Error(`macOS input helper build failed during ${step} for ${source}: ${detail}`)
  } finally {
    if (replacement !== undefined && existsSync(replacement)) unlinkSync(replacement)
  }
}

/**
 * The helper an owned host runs: always the one built here from the staged source, because the
 * Swift helper's pid and key-window proof is the safety guarantee and a preset binary would skip it
 * unseen (33587 review P2-1). A set but empty variable names a run with no helper.
 */
export function ownedHostHelperPath(preset: string | undefined, build: () => string): string | undefined {
  if (preset === undefined) return build()
  if (preset === "") return undefined
  throw new Error(
    `macOS input on an owned host builds its helper from the staged source; ${DARWIN_INPUT_HELPER_ENV}=` +
      `${JSON.stringify(preset)} is refused, because a preset binary would skip the helper's pid and key-window proof`,
  )
}

/** The keysym the install self-test posts before any probe may use the adapter (#33574 C3). */
export const DARWIN_INPUT_SELF_TEST_KEYSYM = "z"

/**
 * The second route, for the diagnostic run: a virtual keycode with NO unicode payload. The plain
 * keysym sends virtual keycode 0 WITH a unicode payload, so a null first probe and an echoing second
 * one name the defect as the unicode payload rather than delivery.
 *
 * It posts a DIFFERENT key on purpose. The reader arms before each injection and a late echo of the
 * first probe can arrive inside the second probe's window; with the same key that echo would be read
 * as proof the keycode route delivers. kVK_ANSI_X is code 7, so the second probe waits for "x" and a
 * "z" arriving late can never be counted as its echo.
 */
export const DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM = "code:7"

/** What the second probe's key echoes; distinct from the first probe's, so the routes stay separable. */
export const DARWIN_INPUT_SELF_TEST_KEYCODE_ECHO = "x"

export interface DarwinWindowFrame extends OwnedFrame {
  readonly id: number
}

/** The window a run launched, from its own launch receipt: the window to target and the tty inside it. */
export interface DarwinLaunchTarget {
  readonly windowId: number
  readonly windowTty?: string
}

export interface DarwinInputOptions {
  /** The measured app PID: every event is posted to this process. */
  readonly appPid: number
  /** The app's name, for a refusal a reader can act on. */
  readonly appName: string
  /** The helper the job compiled; absent names the missing binary rather than guessing a path. */
  readonly helperPath: string | undefined
  /**
   * The window the run's own launch receipt recorded, and the tty inside it. When present the
   * adapter targets THAT window and refuses when it is not the app's front window, instead of
   * guessing the app's largest window (#33574; run 43106790420 named window 33 on /dev/ttys001
   * while another Terminal window was open).
   */
  readonly windowId?: number
  readonly windowTty?: string | undefined
  /**
   * Post one key through the fresh adapter and return what the app's own TTY echoed, or null when
   * nothing came back. The install refuses BY NAME when this is null, so no probe reads a row that
   * the runner never delivered (#33574 C3).
   */
  readonly selfTest: (inject: () => Promise<void>) => Promise<string | null>
  /** Records the route and self-test outcome on the run; never silent. */
  readonly report?: (fact: string) => void
  /**
   * Each line the helper prints (the key-window proof and route of every key post), for the
   * collector's log: the measured terminal's stdout never reaches the artifact, so "target window
   * key" was only inferred on the hosted runner (@cto 4b973fcf, 60e39dfc f).
   */
  readonly log?: (line: string) => void
  /**
   * An owned host (codimac, 33587): someone else's apps share its console, so only keys are posted,
   * to the app's pid; mouse and wheel refuse by name, and until the self-test proves delivery to the
   * run's own TTY only the two fixed self-test keys may be posted (@cto 60e39dfc a, c, d).
   */
  readonly ownedHost?: boolean
  /**
   * A hosted app whose window its own capture install selected (34313, @cto cf1ffd6d): keys only,
   * posted to that window id under the helper's per-post key-window proof, with NO tab tty, because the
   * helper's selected-tab query is Terminal.app's. Every pointer verb refuses by name, and, as on an
   * owned host, only the fixed self-test keys may be posted until one echoes on the run's own TTY.
   */
  readonly keysOnly?: boolean
  /** Test seam: the platform operations, in place of the built helper. */
  readonly mechanism?: InputMechanism
}

function requireAppPid(appPid: number): void {
  if (!Number.isSafeInteger(appPid) || appPid < 2) {
    throw new Error(`macOS input requires the measured app PID; got ${String(appPid)}`)
  }
}

/**
 * The window the events must land in: the run's own launched window when the receipt named one,
 * otherwise the largest layer-0 on-screen window the app owns.
 */
export function selectDarwinInputWindow(rows: unknown, appPid: number, expectedWindowId?: number): DarwinWindowFrame {
  if (!Array.isArray(rows)) throw new Error("macOS input window census is not an array")
  const owned = rows
    .map((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("macOS input window census contains a non-object row")
      }
      const value = row as Record<string, unknown>
      const { id, x, y, width, height } = value
      for (const [name, field] of Object.entries({ id, x, y, width, height })) {
        if (typeof field !== "number" || !Number.isFinite(field)) {
          throw new Error(`macOS input window census row has no finite ${name}`)
        }
      }
      return { id: id as number, x: x as number, y: y as number, width: width as number, height: height as number }
    })
    .filter((frame) => frame.width >= 1 && frame.height >= 1)
    .sort((left, right) => right.width * right.height - left.width * left.height)
  if (expectedWindowId !== undefined) {
    const expected = owned.find((frame) => frame.id === expectedWindowId)
    if (!expected) {
      throw new Error(
        `macOS input targets the run's own window ${expectedWindowId}, which is not among the ` +
          `${owned.length} usable window(s) the app owns of the ${rows.length} listed for pid ${appPid}`,
      )
    }
    return expected
  }
  const selected = owned[0]
  if (!selected) {
    throw new Error(
      `macOS input has no on-screen window to target for pid ${appPid}; ` +
        `the app owns ${owned.length} usable window(s) of the ${rows.length} listed`,
    )
  }
  return selected
}

/** The only keys an owned host may post before the self-test has proven delivery to the run's TTY. */
const SELF_TEST_KEYS: readonly string[] = [DARWIN_INPUT_SELF_TEST_KEYSYM, DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM]

/**
 * The owned-host limit over any mechanism (@cto 60e39dfc c): a key is posted before delivery is proven
 * only when it is one of the fixed self-test keys, so nothing that could act elsewhere is typed first.
 *
 * Pointer verbs are NOT refused here any more. They were, for the right reason — a pointer event lands
 * by screen position, not by pid — and that reason is now answered where it belongs: the helper names
 * the pid and window, re-reads that window's frame in the same call as the post, refuses a point outside
 * it, and holds one lock across proof and post (@cto cbc34e67). A refusal here would have kept the
 * proven path and the unproven one in the same shape.
 */
export function ownedHostMechanism(mechanism: InputMechanism, delivered: () => boolean): InputMechanism {
  return {
    focus: () => mechanism.focus(),
    geometry: () => mechanism.geometry(),
    moveTo: (x, y, options) => mechanism.moveTo(x, y, options),
    click: (button) => mechanism.click(button),
    press: (button) => mechanism.press(button),
    release: (button) => mechanism.release(button),
    async key(keys: string) {
      if (!delivered() && !SELF_TEST_KEYS.includes(keys)) {
        throw new Error(
          `macOS key ${JSON.stringify(keys)} refused on an owned host: only the fixed self-test keys may be ` +
            "posted until one comes back through the run's own TTY (@cto 60e39dfc c)",
        )
      }
      await mechanism.key(keys)
    },
  }
}

/**
 * The keys-only limit over any mechanism (34313): a hosted app's window is proved only for keys, so a
 * pointer verb never reaches the mechanism, and keys keep the owned-host pre-delivery restriction.
 */
export function keysOnlyMechanism(mechanism: InputMechanism, delivered: () => boolean): InputMechanism {
  const owned = ownedHostMechanism(mechanism, delivered)
  const refused = (verb: string): Promise<never> =>
    Promise.reject(new Error(`macOS ${verb} refused: this hosted install posts keys only (34313)`))
  return {
    focus: () => mechanism.focus(),
    // Only pointer placement reads the frame, so the refusal lands before any window read.
    geometry: () => refused("pointer placement"),
    moveTo: () => refused("pointer movement"),
    click: () => refused("a click"),
    press: () => refused("a button press"),
    release: () => refused("a button release"),
    key: (keys) => owned.key(keys),
  }
}

/**
 * One mechanism over the built Swift helper. Keys are posted to the app's pid only, after the helper
 * proves in the same call that the target window is the app's front and key window; mouse and wheel
 * use the HID event tap. The helper refuses when the Accessibility grant is missing, and this module
 * never writes TCC (@cto 2026-11-11, 33574 C1; 60e39dfc).
 */
function helperMechanism(
  helperPath: string,
  appPid: number,
  target: { windowId?: number; windowTty?: string; tabTty?: string },
  log?: (line: string) => void,
): InputMechanism {
  const run = async (...args: string[]): Promise<string> => {
    const printed = (await command(helperPath, args)).toString().trim()
    if (printed && args[0] !== "windows") log?.(printed)
    return printed
  }
  // Read, never memoized: a frame cached at install is a frame that can be stale by the time an event
  // is posted, and "re-read before every event" is the condition that makes the pointer route provable
  // (@cto cbc34e67 condition 2). The helper re-reads for itself in the posting call; this one exists for
  // the caller's own bounds check.
  const ownedFrame = async (): Promise<DarwinWindowFrame> =>
    selectDarwinInputWindow(JSON.parse(await run("windows", String(appPid))), appPid, target.windowId)
  // No derived substitute: a mouse verb names the run's own window, and a mechanism built without one
  // refuses by name rather than falling back to "the largest window of that pid" — the fallback is how a
  // posting lands in a window nobody proved (@cto cbc34e67 condition 3, no compatibility arm). In the
  // shipped path this cannot fire: createDarwinInput refuses an owned host without the window id below.
  const targetWindow = (verb: string): number => {
    const windowId = target.windowId
    if (windowId === undefined || !Number.isSafeInteger(windowId) || windowId <= 0) {
      throw new Error(`macOS ${verb} needs the run's own window id; got ${String(windowId)}`)
    }
    return windowId
  }
  return {
    async focus() {
      // The helper refuses by name when the target window is not the app's front window, because a
      // posting then lands in another window and its silence would be read as terminal behaviour.
      await run("front", String(appPid), ...(target.windowId === undefined ? [] : [String(target.windowId)]))
    },
    async geometry() {
      return ownedFrame()
    },
    /**
     * Window-relative coordinates go to the helper, which re-reads that window's frame and does the
     * transform itself: the point and the proof then come from ONE read, so a window that moved
     * between them cannot produce a click at the old place.
     */
    async moveTo(x: number, y: number, options: { verifyPointer: boolean; dragged: boolean }) {
      const windowId = targetWindow("pointer movement")
      await run(
        "mouse",
        "move",
        String(appPid),
        String(windowId),
        options.dragged ? "dragged" : "plain",
        String(x),
        String(y),
      )
    },
    /** The shared body has already placed the pointer; clip/wheel act where it landed, and the helper
     * proves that place is still inside the run's own window before it posts. */
    async click(button: InputButton) {
      await run("mouse", "click", String(appPid), String(targetWindow("a click")), String(button))
    },
    async press(button: InputButton) {
      await run("mouse", "press", String(appPid), String(targetWindow("a button press")), String(button))
    },
    async release(button: InputButton) {
      await run("mouse", "release", String(appPid), String(targetWindow("a button release")), String(button))
    },
    async key(keys: string) {
      // The helper re-proves the frontmost app, the key window and (with a tab tty) the selected tab
      // in the same call as the post.
      const windowId = target.windowId ?? (await ownedFrame()).id
      await run("key", String(appPid), String(windowId), keys, ...(target.tabTty === undefined ? [] : [target.tabTty]))
    },
  }
}

/**
 * Bind OS-level key/click/wheel/drag injection to the owned macOS app window. The adapter refuses by
 * name when the helper is absent or when one injected key does not come back through the app's TTY,
 * because a posting the app ignores would otherwise be read as a terminal behaviour.
 */
export async function createDarwinInput(options: DarwinInputOptions): Promise<InputFixture> {
  requireAppPid(options.appPid)
  if (options.keysOnly && options.ownedHost) {
    throw new Error("keys-only and owned-host input are separate routes; a run installs one of them")
  }
  if (options.keysOnly && options.windowId === undefined) {
    throw new Error(
      "keys-only macOS input needs the window its capture install selected, so every key targets the window " +
        "the run reads (34313)",
    )
  }
  if (options.ownedHost && (options.windowId === undefined || options.windowTty === undefined)) {
    throw new Error(
      "macOS input on an owned host needs the run's own window id and tab tty, so every key can prove the " +
        "selected tab is the run's (@cto 75732b9d)",
    )
  }
  let mechanism = options.mechanism
  if (!mechanism) {
    if (!options.helperPath) {
      throw new Error(
        `macOS input requires the built helper: ${DARWIN_INPUT_HELPER_ENV} is unset and no helper path was given`,
      )
    }
    if (!existsSync(options.helperPath)) {
      throw new Error(
        `macOS input requires the built helper: ${options.helperPath} is absent; ` +
          `the job compiles native/darwin-input/main.swift and a build failure refuses by name`,
      )
    }
    mechanism = helperMechanism(
      options.helperPath,
      options.appPid,
      {
        ...(options.windowId === undefined ? {} : { windowId: options.windowId }),
        windowTty: options.windowTty,
        ...(options.ownedHost && options.windowTty !== undefined && { tabTty: options.windowTty }),
      },
      options.log,
    )
  }
  let proven = false
  if (options.ownedHost) mechanism = ownedHostMechanism(mechanism, () => proven)
  if (options.keysOnly) mechanism = keysOnlyMechanism(mechanism, () => proven)
  const input = createInjectedInput(mechanism, "CGEvent")
  const delivered = (echoed: string | null): boolean =>
    echoed !== null && echoed.includes(DARWIN_INPUT_SELF_TEST_KEYSYM)
  const echoOf = (echoed: string | null): string => (echoed === null ? "nothing" : JSON.stringify(echoed))
  const unicodeEcho = await options.selfTest(() => input.injectKey(DARWIN_INPUT_SELF_TEST_KEYSYM))
  if (!delivered(unicodeEcho)) {
    // Second, independent probe: same key by virtual keycode with no unicode payload. Its echo moves
    // the refusal from "the runner delivers nothing" to "this app drops unicode-only postings" - a
    // different defect with a different cure - and it is stated either way, never silently dropped.
    const keycodeEcho = await options.selfTest(() => input.injectKey(DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM))
    const keycodeDelivered = keycodeEcho !== null && keycodeEcho.includes(DARWIN_INPUT_SELF_TEST_KEYCODE_ECHO)
    const keycodeRoute = keycodeDelivered
      ? `the virtual-keycode route ("${DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM}", which delivered ${echoOf(keycodeEcho)})`
      : `the virtual-keycode route ("${DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM}", which echoed ${echoOf(keycodeEcho)}) also delivered nothing`
    throw new Error(
      `input not delivered to ${options.appName}: the CGEvent helper posted keysym ` +
        `"${DARWIN_INPUT_SELF_TEST_KEYSYM}" (virtual keycode 0 with a unicode payload) to pid ${options.appPid} ` +
        `and the app's TTY echoed ${echoOf(unicodeEcho)}; ${keycodeRoute}; ` +
        `refusing to measure input rows through it`,
    )
  }
  proven = true
  options.report?.(
    `darwin input installed${
      options.ownedHost
        ? " (owned host: keys and pointer addressed to the run's own window, one posting at a time)"
        : options.keysOnly
          ? ` (keys only: the capture's window ${options.windowId}, a key-window proof per post, no pointer)`
          : ""
    }: ` +
      `pid ${options.appPid}, window ${options.windowId ?? "largest"}, ` +
      `tty ${options.windowTty ?? "unrecorded"}, self-test echoed ${JSON.stringify(unicodeEcho)}` +
      // The permission is not ours on an owned host: it belongs to the ssh session's parent, so a
      // rebuilt machine loses it and every input row fails for a reason nothing in the app explains
      // (@cto cbc34e67). Recorded here because this string already reaches the run record.
      (options.ownedHost
        ? ", permission: inherited from the ssh session's /usr/libexec/sshd-keygen-wrapper Accessibility grant" +
          " (a rebuilt host must re-create it)"
        : ""),
  )
  return input
}

/**
 * A subject owner's viewport route over its keys-only install (34313, @cto cf1ffd6d). The owner holds the step-to-key
 * map; a refused install keeps the route with its refusal in the label, and every press fails by name, so a row
 * reports an apparatus TODO instead of losing the route and falling back to the app's declaration.
 */
export function viewportScrollRoute(
  viewport: { readonly route: string; readonly keys: Readonly<Record<ViewportStep, string>> },
  installed: { readonly input: Pick<InputFixture, "injectKey"> } | { readonly refusal: string },
): ViewportScroll {
  if ("refusal" in installed) {
    const reason = installed.refusal
    return {
      route: `${viewport.route}; input not installed: ${reason}`,
      press: () => Promise.reject(new Error(`viewport input not installed (34313): ${reason}`)),
    }
  }
  const input = installed.input
  // 34645 (@cto e1cfff79 items 2-3): the route owns every step it dispatched. Steps run one after another, a
  // hold is recorded as held BEFORE it is dispatched (a post can land and its helper still fail), and the bottom
  // clears it only when it settles with no hold dispatched after it.
  let last: Promise<unknown> = Promise.resolve()
  let order = 0
  let lastHold = 0
  let held = false
  const abandonedRow = (what: string) =>
    currentTTYTraceMark()?.abandoned === true
      ? new Error(`viewport ${what} refused: the row that asked was abandoned at its wall (34645)`)
      : undefined
  const dispatch = (step: ViewportStep): Promise<void> => {
    const position = ++order
    if (step === "bottom") {
      const previous = last
      const run = (async () => {
        await previous
        await input.injectKey(viewport.keys[step])
        if (lastHold < position) held = false
      })()
      last = run.catch(() => {})
      return run
    }
    held = true
    lastHold = position
    const run = last.then(() => input.injectKey(viewport.keys[step]))
    last = run.catch(() => {})
    return run
  }
  return {
    route: viewport.route,
    press(step) {
      const refused = abandonedRow(step)
      return refused ? Promise.reject(refused) : dispatch(step)
    },
    adoptHold() {
      const refused = abandonedRow("adopt an already-held view")
      if (refused) throw refused
      // Ordered like a dispatched hold: a bottom still settling from before it does not clear it.
      held = true
      lastHold = ++order
    },
    async returnToBottom() {
      const refused = abandonedRow("return to the bottom")
      if (refused) throw refused
      await last
      // The wall may have fired while the earlier steps settled: it owns the bottom from then on, so a
      // return that started before it posts nothing (@dev/18 5c1280e5 note a).
      const lateRefusal = abandonedRow("return to the bottom")
      if (lateRefusal) throw lateRefusal
      if (!held) return "not-held"
      await dispatch("bottom")
      return "bottom-pressed"
    },
  }
}
