/**
 * @failure An ordinary-open run starts on a receipt that is about another run, app or version, or it publishes the
 *   person's clipboard fingerprint, length or home path — either way the three OSC 52 rows grade an app nobody can
 *   trace, or leak something about the person using it.
 * @level l1
 * @consumer the ordinary-open producer in serve.ts (@cto 2026-11-13 PLAN GO d82ef4d0).
 * @testonly none
 * @reach fs-walk <fixture-only: receipts this test writes under its own mkdtempSync root>
 *
 * A receipt fixture and an injected Darwin command stand in for the host: no Mac and no person's pasteboard are
 * needed, and the ancestry walk is driven through its seam rather than against a live process.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { ProbeCallbackResult } from "@terminfo/probe-defs"
import { afterEach, expect, test } from "vitest"
import type { DarwinCommand } from "./darwin-clipboard.ts"
import { ORDINARY_OPEN_RECEIPT_KIND, type LiveAncestryReader } from "./ordinary-open-receipt.ts"
import {
  DISPOSABLE_RECEIPT_ENV,
  ORDINARY_OPEN_RECEIPT_ENV,
  assertOneProofPerRun,
  assertOrdinaryOpenVersionBound,
  ordinaryOpenReceiptPath,
  ordinaryOpenRecord,
  resolveOrdinaryOpenRun,
} from "./ordinary-open-run.ts"

const RUN = "0f6c1a2b3c4d5e6f708192a3b4c5d6e7"
const SUBJECT = { id: "iterm2", os: "macos", version: "3.5.14" }
const PERSON = "the person's own clipboard"

/**
 * The receipt's own chain, walked live: the probe is 4802 (bun), its parents are 4790 (zsh) and the app 4711.
 * The reader is a test seam, exactly like the batch's `readAncestry`; production reads the real process table.
 */
const liveChain: LiveAncestryReader = {
  parent(pid) {
    if (pid === 4802) return { pid: 4790, executable: "zsh" }
    if (pid === 4790) return { pid: 4711, executable: "iTerm2" }
    return undefined
  },
}
const PROBE_PID = 4802

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function receiptFile(overrides: Record<string, unknown> = {}): string {
  const nonce = `nonce-${RUN}-b7d1`
  const bytes = JSON.stringify({
    schemaVersion: 1,
    kind: ORDINARY_OPEN_RECEIPT_KIND,
    runId: RUN,
    collectedAt: "2026-11-13T19:00:00Z",
    subject: {
      id: "iterm2",
      bundleId: "com.googlecode.iterm2",
      version: "3.5.14",
      executableInBundle: "iTerm.app/Contents/MacOS/iTerm2",
    },
    ancestry: {
      appPid: 4711,
      chain: [
        { pid: 4802, executable: "bun" },
        { pid: 4790, executable: "zsh" },
        { pid: 4711, executable: "iTerm2" },
      ],
    },
    nonce: { value: nonce, sha256: createHash("sha256").update(nonce).digest("hex") },
    witness: { command: "pbpaste", exit: 0, matched: true },
    baselineRestore: { length: 12, sha256: "a".repeat(64), restored: true },
    signature: { teamId: "H7H8Q7M5B0", signingIdentifier: "com.googlecode.iterm2" },
    ...overrides,
  })
  const directory = mkdtempSync(join(tmpdir(), "terminfo-ordinary-open-"))
  directories.push(directory)
  const path = join(directory, "receipt.json")
  writeFileSync(path, bytes)
  return path
}

/** A pasteboard that holds what a person left there; `pbpaste` strips its own trailing newline. */
function personPasteboard(initial = PERSON, refuseRestore = false, types = "«class utf8», 12, string, 12") {
  let value = initial
  const run: DarwinCommand = async (file, _args, stdin) => {
    if (file.endsWith("pbpaste")) return `${value}\n`
    if (file.endsWith("osascript")) return types
    if (file.endsWith("pbcopy")) {
      if (refuseRestore && stdin === initial) throw new Error("pbcopy refused the restore")
      value = stdin ?? ""
      return ""
    }
    throw new Error(`unexpected ${file}`)
  }
  return { run, read: () => value }
}

function resolve(
  options: {
    overrides?: Record<string, unknown>
    subject?: { id: string; os: string; version: string | undefined }
    runId?: string
    refuseRestore?: boolean
    baseline?: string
  } = {},
) {
  const board = personPasteboard(options.baseline ?? PERSON, options.refuseRestore === true)
  return resolveOrdinaryOpenRun({
    receiptPath: receiptFile(options.overrides),
    runId: options.runId ?? RUN,
    subject: options.subject ?? SUBJECT,
    run: board.run,
    probePid: PROBE_PID,
    readAncestry: liveChain,
  }).then((resolved) => ({ resolved, board }))
}

test("only one of the two receipt variables may be set, and neither may be empty", () => {
  expect(ordinaryOpenReceiptPath({})).toBeUndefined()
  expect(ordinaryOpenReceiptPath({ [ORDINARY_OPEN_RECEIPT_ENV]: "/tmp/r.json" })).toBe("/tmp/r.json")
  expect(() => ordinaryOpenReceiptPath({ [ORDINARY_OPEN_RECEIPT_ENV]: "  " })).toThrow(
    `${ORDINARY_OPEN_RECEIPT_ENV} is set but empty`,
  )
  expect(() =>
    ordinaryOpenReceiptPath({ [ORDINARY_OPEN_RECEIPT_ENV]: "/tmp/r.json", [DISPOSABLE_RECEIPT_ENV]: "/d.json" }),
  ).toThrow(`Both ${ORDINARY_OPEN_RECEIPT_ENV} and ${DISPOSABLE_RECEIPT_ENV} are set`)
})

test("every way a receipt can fail to bind this run refuses at START, by name", async () => {
  await expect(resolve({ runId: "1".repeat(32) })).rejects.toThrow(/belongs to run 0f6c1a2b.*this run is 1111/)
  await expect(resolve({ runId: "" })).rejects.toThrow(/was given no run id/)
  await expect(resolve({ subject: { ...SUBJECT, os: "linux" } })).rejects.toThrow(/grades a macOS app/)
  await expect(resolve({ subject: { ...SUBJECT, id: "kitty" } })).rejects.toThrow(/receipt names iterm2.*kitty/)
  await expect(
    resolve({
      subject: { ...SUBJECT, id: "not-in-the-registry" },
      overrides: {
        subject: {
          id: "not-in-the-registry",
          bundleId: "com.googlecode.iterm2",
          version: "3.5.14",
          executableInBundle: "iTerm.app/Contents/MacOS/iTerm2",
        },
      },
    }),
  ).rejects.toThrow(/no bundle id is named for not-in-the-registry in the app registry/)
  await expect(
    resolve({
      overrides: {
        subject: {
          ...SUBJECT,
          bundleId: "com.example.lookalike",
          executableInBundle: "iTerm.app/Contents/MacOS/iTerm2",
        },
        signature: {},
      },
    }),
  ).rejects.toThrow(/bundle id com.example.lookalike is not the bundle iterm2 names/)
  await expect(resolve({ subject: { ...SUBJECT, version: undefined } })).rejects.toThrow(
    /this run has no measured version/,
  )
  await expect(resolve({ subject: { ...SUBJECT, version: "3.5.15" } })).rejects.toThrow(
    /ancestry app is version 3.5.14, row measures 3.5.15/,
  )
})

test("the walk is live, not cached: a chain that no longer reaches the app refuses the row", async () => {
  const board = personPasteboard()
  // The START walk sees the real chain once; every walk after it sees nothing, as if the app had quit mid-run.
  let calls = 0
  const readAncestry = {
    parent: (pid: number) => {
      calls += 1
      // The first three calls are the START walk (4802 -> 4790 -> 4711); every later walk sees nothing.
      return calls <= 3 ? liveChain.parent(pid) : undefined
    },
  }
  const resolved = await resolveOrdinaryOpenRun({
    receiptPath: receiptFile(),
    runId: RUN,
    subject: SUBJECT,
    run: board.run,
    probePid: PROBE_PID,
    readAncestry,
  })
  await expect(resolved.clipboard.assertOwned()).rejects.toThrow(/does not reach the app pid 4711/)
  // And the refusal is repeated on the next call, because nothing was cached from the START walk.
  await expect(resolved.clipboard.assertOwned()).rejects.toThrow(/does not reach the app pid 4711/)
})

test("the person's pasteboard is restored even when a row throws", async () => {
  const { resolved, board } = await resolve()
  await expect(
    resolved.clipboard.withClipboardFixture(
      async () => {
        throw new Error("row boom")
      },
      () => {},
      async () => {},
    ),
  ).rejects.toThrow(/row boom/)
  expect(board.read()).toBe(PERSON)
})

test("a failed restore is loud, says whose clipboard was left changed, and never quotes the value", async () => {
  const baseline = "luna6-baseline-9f3c2a"
  const { resolved, board } = await resolve({ refuseRestore: true, baseline })
  const message = await resolved.clipboard
    .withClipboardFixture(
      async () => ({ pass: true }) as ProbeCallbackResult,
      () => {},
      async () => {},
    )
    .then(
      () => "",
      (error: unknown) => (error as Error).message,
    )
  expect(message).toBe("The person's clipboard was left changed: restoration failed: pbcopy refused the restore")
  // The value it could not put back is the thing a diagnostic must never repeat.
  expect(message).not.toContain(baseline)
  expect(board.read()).toBe(baseline)
})

test("a foreign pasteboard value publishes neither its digest nor its length", async () => {
  const secret = "hunter2-short-secret"
  // Construction reads the person's own value; the pre-flight read sees someone else's text; the restore puts the
  // person's value back. Only that middle read is foreign, and it is the one that must stay unquoted.
  let value = secret
  let constructed = false
  let tamper = true
  const run: DarwinCommand = async (file, _args, stdin) => {
    if (file.endsWith("pbpaste")) {
      if (!constructed) {
        constructed = true
        return `${secret}\n`
      }
      if (tamper) {
        tamper = false
        return "someone else's text\n"
      }
      return `${value}\n`
    }
    if (file.endsWith("osascript")) return "«class utf8», 20"
    if (file.endsWith("pbcopy")) {
      value = stdin ?? ""
      return ""
    }
    throw new Error(`unexpected ${file}`)
  }
  const resolved = await resolveOrdinaryOpenRun({
    receiptPath: receiptFile(),
    runId: RUN,
    subject: SUBJECT,
    run,
    probePid: PROBE_PID,
    readAncestry: liveChain,
  })
  const traces: unknown[] = []
  const failure = await resolved.clipboard
    .withClipboardFixture(
      async () => ({ pass: true }) as ProbeCallbackResult,
      (event) => traces.push(event),
      async () => {},
    )
    .then(
      () => undefined,
      (error: unknown) => error as Error,
    )
  const message = failure?.message ?? "the baseline did not change"
  expect(message).toBe("Owned clipboard baseline changed before callback: read present")
  expect(value).toBe(secret)
  const digest = createHash("sha256").update(secret).digest("hex")
  const published = JSON.stringify({ message, traces, record: ordinaryOpenRecord(resolved) })
  expect(published).not.toContain(digest)
  expect(published).not.toContain(secret)
  for (const event of traces as Array<Record<string, unknown>>) {
    expect(event).not.toHaveProperty("length")
    expect(event).not.toHaveProperty("sha256")
  }
})

test("the published record carries no path, not even a home directory", async () => {
  const { resolved } = await resolve()
  const record = JSON.parse(ordinaryOpenRecord(resolved)) as Record<string, unknown>
  expect(Object.keys(record).sort()).toEqual(["appPidAlive", "bundleId", "chainLength", "sha256", "subject"])
  expect(JSON.stringify(record)).not.toContain("/")
  expect(JSON.stringify(record)).not.toContain(homedir())
  expect(record.subject).toEqual({
    id: "iterm2",
    bundleId: "com.googlecode.iterm2",
    version: "3.5.14",
    executable: "iTerm2",
  })
  expect(record.chainLength).toBe(3)
  expect(typeof record.appPidAlive).toBe("boolean")
})

test("a START refusal runs no pasteboard command at all, so nothing is written and no row can exist", async () => {
  const calls: string[] = []
  const run: DarwinCommand = async (file) => {
    calls.push(file)
    return ""
  }
  await expect(
    resolveOrdinaryOpenRun({
      receiptPath: receiptFile(),
      runId: RUN,
      subject: { ...SUBJECT, version: "3.5.15" },
      run,
      probePid: PROBE_PID,
      readAncestry: liveChain,
    }),
  ).rejects.toThrow(/ancestry app is version 3.5.14, row measures 3.5.15/)
  expect(calls).toEqual([])
})

test("an app that is already gone is refused at START, not after the rows", async () => {
  const calls: string[] = []
  const run: DarwinCommand = async (file) => {
    calls.push(file)
    return ""
  }
  await expect(
    resolveOrdinaryOpenRun({
      receiptPath: receiptFile(),
      runId: RUN,
      subject: SUBJECT,
      run,
      probePid: PROBE_PID,
      readAncestry: { parent: () => undefined },
    }),
  ).rejects.toThrow(/does not reach the app pid 4711/)
  expect(calls).toEqual([])
})

test("the rows must publish the version the receipt bound", async () => {
  const { resolved } = await resolve()
  expect(() => assertOrdinaryOpenVersionBound(resolved, "3.5.14")).not.toThrow()
  expect(() => assertOrdinaryOpenVersionBound(resolved, "3.5.15")).toThrow(
    /publishes app version 3.5.15, and the ordinary-open receipt bound 3.5.14/,
  )
  expect(() => assertOrdinaryOpenVersionBound(resolved, undefined)).toThrow(/publishes app version \(none\)/)
})

test("an owned terminal and an ordinary-open receipt never share a run", () => {
  expect(() => assertOneProofPerRun(false, "process")).not.toThrow()
  expect(() => assertOneProofPerRun(false, undefined)).not.toThrow()
  expect(() => assertOneProofPerRun(true, undefined)).not.toThrow()
  expect(() => assertOneProofPerRun(true, "process")).toThrow(
    /TERMINFO_ORDINARY_OPEN_RECEIPT is set on a run that owns its terminal \(process\)/,
  )
  expect(() => assertOneProofPerRun(true, "windowsHosted")).toThrow(/owns its terminal \(windowsHosted\)/)
})
