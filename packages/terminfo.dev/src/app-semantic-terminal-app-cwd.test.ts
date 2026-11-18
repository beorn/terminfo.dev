/**
 * @failure Terminal.app 2.15's OSC 633 P reader grades a one-pair or unrestored experiment, compares AXDocument's
 *   trailing-slash URL spelling instead of the path, binds a stale or ambiguous window, or hides why a read failed.
 * @level l2
 * @consumer OwnedTerminal.readAppSemanticState on the hosted Terminal.app arm, through readAppSemanticState's owned
 *   cwd branch and graded by gradeAppSemanticState (34870, @cto 34870-terminalapp-cwd-r1).
 * @testonly none
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { gradeAppSemanticState } from "../../probe-defs/src/app-semantic-state.ts"
import { OwnedCwdReadError, readAppSemanticState } from "./app-semantic-state.ts"
import {
  type TerminalAppDocumentReply,
  type TerminalAppDocumentRun,
  terminalAppOwnedCwd,
} from "./terminal-app-window.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

const TTY = "/dev/ttys004"
const INITIAL = "file:///Users/private%20person/secret%20project/"

/** Terminal.app 2.15 as 34841 measured it: AXDocument follows OSC 7 with one trailing slash; OSC 2 sets the title. */
function fakeTerminal(options: {
  initial?: string
  honours633?: boolean
  /** Which of the public OSC 7 controls take effect. */
  controls?: "both" | "none" | "first"
  restores?: boolean
  /** A non-read reply for every read after the first N reads. */
  failAfter?: { reads: number; reply: TerminalAppDocumentReply }
  /** The title never carries the fence. */
  staleTitle?: boolean
}) {
  const store = (uri: string) => {
    const path = uri.startsWith("file:") ? new URL(uri).pathname : uri
    return `file://${path}${path.endsWith("/") ? "" : "/"}`
  }
  let title = "codi — zsh"
  let document = options.initial ?? INITIAL
  let controls = 0
  let reads = 0
  const publicWrites: string[] = []
  const privateWrites: string[] = []
  const argvs: Array<readonly [string, string]> = []
  const consume = (text: string, channel: "public" | "private") => {
    const osc2 = /\x1b\]2;([^\x07]*)\x07/.exec(text)?.[1]
    if (osc2 !== undefined && !options.staleTitle) title = `${osc2} — zsh`
    const osc7 = /\x1b\]7;([^\x07]*)\x07/.exec(text)?.[1]
    if (osc7 !== undefined) {
      if (channel === "private") {
        if (options.restores !== false) document = store(osc7)
      } else {
        controls++
        const mode = options.controls ?? "both"
        if (mode === "both" || (mode === "first" && controls === 1)) document = store(osc7)
      }
    }
    const cwd = /\x1b\]633;P;Cwd=([^\x07]*)\x07/.exec(text)?.[1]
    if (cwd !== undefined && options.honours633) document = store(cwd)
  }
  const run: TerminalAppDocumentRun = (argv) => {
    argvs.push(argv)
    const [, fence] = argv
    let reply: TerminalAppDocumentReply
    if (!title.includes(fence)) reply = { status: "fence-pending", windowId: 7 }
    else if (options.failAfter !== undefined && reads++ >= options.failAfter.reads) reply = options.failAfter.reply
    else reply = { status: "read", document, windowId: 7, trusted: true }
    return { stdout: JSON.stringify(reply), stderr: "", status: 0, signal: null }
  }
  return {
    run,
    argvs,
    publicWrites,
    privateWrites,
    write(text: string) {
      publicWrites.push(text)
      consume(text, "public")
    },
    privateWrite(text: string) {
      privateWrites.push(text)
      consume(text, "private")
    },
  }
}

async function read(
  terminal: ReturnType<typeof fakeTerminal>,
  overrides: { privateWrite?: false; check?: () => void } = {},
) {
  const runId = "c".repeat(32)
  vi.stubEnv("TERMINFO_RUN_ID", runId)
  vi.stubEnv("TERMINFO_MUX_KIND", "")
  vi.stubEnv("TERMINFO_TARGET_ID", "terminal-app")
  vi.stubEnv("TERMINFO_TARGET_VERSION", "2.15")
  const directory = mkdtempSync(join(tmpdir(), "terminfo-terminal-app-cwd-"))
  vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", directory)
  const retained: string[] = []
  try {
    const reading = await readAppSemanticState({
      featureId: "extensions.osc633-p",
      onRetained: (artifact: { path: string }) => {
        retained.push(artifact.path)
      },
      runId,
      executable: {
        path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
        sha256: "d".repeat(64),
      },
      write: (text: string) => terminal.write(text),
      ...(overrides.privateWrite !== false && { privateWrite: (text: string) => terminal.privateWrite(text) }),
      readCwd: terminalAppOwnedCwd({
        tty: TTY,
        write: (text) => terminal.write(text),
        check: overrides.check ?? (() => {}),
        run: terminal.run,
      }),
    })
    const detail = reading.detail as { privateEvidence?: string } | undefined
    const privateEvidence =
      detail?.privateEvidence === undefined ? "" : readFileSync(join(directory, detail.privateEvidence), "utf8")
    return { reading, graded: gradeAppSemanticState(reading), privateEvidence, retained }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const published = (value: unknown) => JSON.stringify(value)

// @failure A reader that ignores 633 P, or honours it, is misgraded because AXDocument's slash survives into the
//   comparison, a target counts before both controls qualify, or the session's own directory leaks into the trace.
test.each([
  ["honoured", true, "supported"],
  ["ignored", false, "unsupported"],
] as const)("two controls and two targets decide OSC 633 P: %s", async (_name, honours633, outcome) => {
  const terminal = fakeTerminal({ honours633 })
  const { reading, graded, privateEvidence } = await read(terminal)
  expect(reading.status).toBe("measured")
  if (reading.status !== "measured" || reading.reader !== "state") return
  expect(graded.observation?.outcome).toBe(outcome)
  // Both controls read back as exact nonce paths: the slash AXDocument adds is gone, and nothing else changed.
  const controls = JSON.parse(reading.handled.after) as string[]
  expect(controls).toHaveLength(2)
  expect(controls[0]).toMatch(/^\/terminfo-control-A-[0-9a-f]{8}$/)
  expect(controls[1]).toMatch(/^\/terminfo-control-B-[0-9a-f]{8}$/)
  expect(reading.handled.after).toBe(reading.handled.expected)
  const targets = JSON.parse(reading.target.expected) as string[]
  expect(targets).toHaveLength(2)
  expect(targets[0]).not.toBe(targets[1])
  // Restoration ran through the private writer and read the initial directory back.
  expect(reading.detail).toMatchObject({ paneLeftPinned: false, restoration: { attempted: true, equal: true } })
  expect(terminal.privateWrites.join("")).toContain(INITIAL)
  for (const secret of [INITIAL, "private person", "private%20person", "secret project"]) {
    expect(terminal.publicWrites.join("")).not.toContain(secret)
    expect(published(reading)).not.toContain(secret)
    expect(published(graded)).not.toContain(secret)
  }
  expect(privateEvidence).toContain(INITIAL)
  // Every read was fenced, the baseline included, and the script received the TTY and fence as argv.
  expect(terminal.argvs.every(([tty]) => tty === TTY)).toBe(true)
  expect(terminal.argvs[0]?.[1]).toMatch(/^terminfo-baseline-/)
})

// @failure The slash model strips "/" itself, or misses a percent-encoded path.
test("a root initial directory restores to / and still decides", async () => {
  const { reading, graded } = await read(fakeTerminal({ initial: "file:///", honours633: true }))
  expect(graded.observation?.outcome).toBe("supported")
  expect(reading.detail).toMatchObject({ restoration: { attempted: true, equal: true } })
})

// @failure Controls the window ignores are graded as a 633 P negative instead of an unavailable read.
test("two inert OSC 7 controls leave the row TODO, never unsupported", async () => {
  const { reading, graded } = await read(fakeTerminal({ controls: "none" }))
  expect(reading).toMatchObject({
    status: "unavailable",
    reason: "Terminal.app AXDocument did not move for two distinct fresh non-existent OSC 7 control paths",
  })
  expect(graded.tests?.[0]?.status).toBe("probe-todo")
  expect(graded.observation?.outcome).toBeUndefined()
})

// @failure One qualifying control is treated as enough to read a target.
test("a control that does not read back makes the row invalid", async () => {
  const { reading, graded } = await read(fakeTerminal({ controls: "first", honours633: true }))
  expect(reading.status).toBe("measured")
  expect(graded.tests?.[0]?.status).toBe("probe-invalid")
})

// @failure A measurement is graded although the session's directory was never restored.
test("a failed restoration makes a decided row invalid and says why", async () => {
  const { reading, graded } = await read(fakeTerminal({ honours633: true, restores: false }))
  expect(reading).toMatchObject({
    status: "invalid",
    reason: "Terminal.app cwd was read, but the initial directory did not read back after restoration",
  })
  // The pane is unpinned only by a restore that read back; a failed one says the pane stays pinned.
  expect(reading.detail).toMatchObject({ paneLeftPinned: true, restoration: { attempted: true, equal: false } })
  expect(graded.tests?.[0]?.status).toBe("probe-invalid")
})

test("no private writer means no experiment", async () => {
  const terminal = fakeTerminal({ honours633: true })
  const { reading } = await read(terminal, { privateWrite: false })
  expect(reading).toMatchObject({
    status: "invalid",
    reason: "Terminal.app cwd needs the owner's private writer and a restorable initial file URI",
  })
  expect(terminal.publicWrites.some((text) => text.includes("\x1b]7;"))).toBe(false)
})

// @failure An Accessibility refusal mid-run is published as a generic failure, graded, or skips restoration.
test("an AX error names its phase and number, and the directory is still restored", async () => {
  const terminal = fakeTerminal({
    honours633: true,
    // baseline, unknown and both controls read; the first target's read fails.
    failAfter: { reads: 4, reply: { status: "ax-error", phase: "AXDocument", axError: -25211, trusted: false } },
  })
  const { reading, graded } = await read(terminal)
  expect(reading.status).toBe("invalid")
  if (reading.status !== "invalid") return
  expect(reading.reason).toMatch(
    /^Owned cwd observation failed in the AXDocument phase: AXError -25211 \(process trusted for Accessibility: false\); then restoring the initial directory failed: /,
  )
  expect(terminal.privateWrites.join("")).toContain(INITIAL)
  expect(graded.tests?.[0]?.status).toBe("probe-invalid")
})

// @failure An ambiguous accessibility window match is read as the owned window's document.
test("two fenced accessibility windows are refused by count", async () => {
  const terminal = fakeTerminal({
    failAfter: {
      reads: 0,
      reply: { status: "refused", phase: "ax-match", reason: "2 accessibility windows carry the fence", trusted: true },
    },
  })
  const { reading } = await read(terminal)
  expect(reading).toMatchObject({
    status: "invalid",
    reason: "Owned cwd observation failed in the ax-match phase: 2 accessibility windows carry the fence",
  })
  // The baseline itself failed, so nothing was mutated and nothing needed restoring.
  expect(terminal.publicWrites.some((text) => text.includes("\x1b]7;"))).toBe(false)
})

// @failure A lost owner is read through instead of stopping the native read.
test("owner loss stops the read before any native call", async () => {
  const terminal = fakeTerminal({ honours633: true })
  const { reading } = await read(terminal, {
    check: () => {
      throw new Error("Terminal.app cwd read has no live owned terminal")
    },
  })
  expect(reading).toMatchObject({ status: "invalid", reason: "Owned cwd observation failed; see private evidence" })
  expect(terminal.argvs).toHaveLength(0)
})

// @failure A title that never carries the fence lets a stale AXDocument count as this phase's value.
test("a stale title fails the fence by name, never reading AXDocument", async () => {
  const terminal = fakeTerminal({ staleTitle: true })
  const getter = terminalAppOwnedCwd({
    tty: TTY,
    write: (text) => terminal.write(text),
    check: () => {},
    run: terminal.run,
  })
  const error = await getter().then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(OwnedCwdReadError)
  expect(error).toMatchObject({ phase: "fence", publicReason: "the window title never carried the fence" })
}, 15_000)

// @failure An osascript that exits non-zero or prints a foreign shape is parsed as a reading.
test.each([
  [{ stdout: "", stderr: "execution error", status: 1, signal: null }, "osascript", "osascript exit 1"],
  [{ stdout: '{"status":"read"}', stderr: "", status: 0, signal: null }, "osascript", "the reply had no known shape"],
  [{ stdout: "", stderr: "", status: null, signal: "SIGKILL" as const }, "osascript", "osascript killed by SIGKILL"],
])("an unusable osascript reply is a named failure: %#", async (result, phase, publicReason) => {
  const getter = terminalAppOwnedCwd({ tty: TTY, write: () => {}, check: () => {}, run: () => result })
  await expect(getter()).rejects.toMatchObject({ phase, publicReason })
})
