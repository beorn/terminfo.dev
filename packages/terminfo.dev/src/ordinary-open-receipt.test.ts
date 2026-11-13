/**
 * @failure An ordinary-open receipt authorizes a row it is not about, or a self-declared payload lets a copy of
 *   another run's evidence grade this one — either way a Mac row is published from evidence nobody can trace.
 * @level l1
 * @consumer the OSC 52 write/read/clipboard gate on an app a person opened normally (@cto 2026-11-13).
 * @testonly the receipt parser and its admission predicate, driven with synthetic receipts: no Mac host is needed
 *   to prove what the parser refuses.
 */
import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import {
  ordinaryOpenAdmission,
  parseOrdinaryOpenReceipt,
  readOrdinaryOpenReceipt,
  ORDINARY_OPEN_RECEIPT_KIND,
} from "./ordinary-open-receipt.ts"

const RUN = "0f6c1a2b3c4d5e6f708192a3b4c5d6e7"

function receipt(overrides: Record<string, unknown> = {}, collectedAt = "2026-11-13T19:00:00Z"): string {
  const nonce = `nonce-${RUN}-b7d1`
  return JSON.stringify({
    schemaVersion: 1,
    kind: ORDINARY_OPEN_RECEIPT_KIND,
    runId: RUN,
    collectedAt,
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
    signature: { teamId: "H7H8Q7M5BK", signingIdentifier: "com.googlecode.iterm2" },
    ...overrides,
  })
}

function refusal(bytes: string): string {
  try {
    parseOrdinaryOpenReceipt(bytes)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("expected the parser to refuse this receipt")
}

test("a well-formed receipt parses its own fields and hashes its own bytes", () => {
  const parsed = parseOrdinaryOpenReceipt(receipt())
  expect(parsed.kind).toBe(ORDINARY_OPEN_RECEIPT_KIND)
  expect(parsed.subject).toEqual({
    id: "iterm2",
    bundleId: "com.googlecode.iterm2",
    version: "3.5.14",
    executableInBundle: "iTerm.app/Contents/MacOS/iTerm2",
  })
  expect(parsed.ancestry.appPid).toBe(4711)
  expect(parsed.sha256).toBe(createHash("sha256").update(receipt()).digest("hex"))
  expect(parsed.signature).toEqual({ teamId: "H7H8Q7M5BK", signingIdentifier: "com.googlecode.iterm2" })
})

test("another kind is refused by name, and says it grants no mutation authority", () => {
  const message = refusal(receipt({ kind: "github-hosted-runner" }))
  expect(message).toContain('is not "ordinary-open-app"')
  expect(message).toContain("grants no mutation authority")
})

test("a runId that is not 32 lowercase hex is refused", () => {
  expect(refusal(receipt({ runId: "not-a-run" }))).toContain("runId must be 32 lowercase hex")
})

test("a nonce carrying another run's id is refused", () => {
  const other = "1".repeat(32)
  const nonce = `nonce-${other}-b7d1`
  const message = refusal(
    receipt({ nonce: { value: nonce, sha256: createHash("sha256").update(nonce).digest("hex") } }),
  )
  expect(message).toContain("nonce does not carry this receipt's runId")
})

test("a recorded nonce hash that does not match the nonce is refused", () => {
  const message = refusal(receipt({ nonce: { value: `nonce-${RUN}-b7d1`, sha256: "b".repeat(64) } }))
  expect(message).toContain("does not match the nonce it names")
})

test("ancestry that stops short of the app's pid is refused", () => {
  const message = refusal(
    receipt({
      ancestry: {
        appPid: 4711,
        chain: [
          { pid: 4790, executable: "zsh" },
          { pid: 4802, executable: "bun" },
        ],
      },
    }),
  )
  expect(message).toContain("does not reach the app")
})

test("an executable recorded as a path is refused, including the app's own", () => {
  expect(
    refusal(
      receipt({
        ancestry: { appPid: 4711, chain: [{ pid: 4711, executable: "/Applications/iTerm.app/Contents/MacOS/iTerm2" }] },
      }),
    ),
  ).toContain("must be a basename")
  expect(
    refusal(
      receipt({
        subject: {
          id: "iterm2",
          bundleId: "com.googlecode.iterm2",
          version: "3.5.14",
          executableInBundle: "/Applications/iTerm.app/Contents/MacOS/iTerm2",
        },
      }),
    ),
  ).toContain("must be a path inside a .app bundle")
})

test("a signing identifier that differs from the bundle id is refused; an absent one is fine", () => {
  expect(
    refusal(receipt({ signature: { teamId: "H7H8Q7M5BK", signingIdentifier: "com.example.something-else" } })),
  ).toContain("differs from the bundle id")
  expect(parseOrdinaryOpenReceipt(receipt({ signature: {} })).signature).toEqual({})
})

test("the three OSC 52 rows are admitted on a matching app and measured version", () => {
  const parsed = parseOrdinaryOpenReceipt(receipt())
  for (const probeId of ["extensions.osc52-write", "extensions.osc52-read", "extensions.osc52-clipboard"]) {
    expect(
      ordinaryOpenAdmission({
        receipt: parsed,
        probeId,
        subject: { id: "iterm2", os: "macos", kind: "term" },
        measuredVersion: "3.5.14",
        expectedBundleId: "com.googlecode.iterm2",
      }),
    ).toEqual({ admit: true })
  }
})

test("another probe id, another app, another version and a failed witness each refuse by name", () => {
  const parsed = parseOrdinaryOpenReceipt(receipt())
  const base = {
    receipt: parsed,
    probeId: "extensions.osc52-read",
    subject: { id: "iterm2", os: "macos", kind: "term" },
    measuredVersion: "3.5.14",
    expectedBundleId: "com.googlecode.iterm2",
  }
  expect(ordinaryOpenAdmission({ ...base, probeId: "modes.bracketed-paste" })).toMatchObject({
    admit: false,
    refusal: expect.stringContaining("admits only the OSC 52 rows"),
  })
  expect(ordinaryOpenAdmission({ ...base, subject: { id: "iterm2", os: "linux", kind: "term" } })).toMatchObject({
    admit: false,
    refusal: expect.stringContaining("admits a macOS terminal app"),
  })
  expect(ordinaryOpenAdmission({ ...base, subject: { id: "warp", os: "macos", kind: "term" } })).toMatchObject({
    admit: false,
    refusal: "ancestry names iterm2, not warp",
  })
  expect(ordinaryOpenAdmission({ ...base, measuredVersion: "3.5.15" })).toMatchObject({
    admit: false,
    refusal: "ancestry app is version 3.5.14, row measures 3.5.15",
  })
  const failedWitness = parseOrdinaryOpenReceipt(receipt({ witness: { command: "pbpaste", exit: 1, matched: false } }))
  expect(ordinaryOpenAdmission({ ...base, receipt: failedWitness })).toMatchObject({
    admit: false,
    refusal: expect.stringContaining("did not carry the payload"),
  })
  const unrestored = parseOrdinaryOpenReceipt(
    receipt({ baselineRestore: { length: 12, sha256: "a".repeat(64), restored: false } }),
  )
  expect(ordinaryOpenAdmission({ ...base, receipt: unrestored })).toMatchObject({
    admit: false,
    refusal: expect.stringContaining("baseline was not restored"),
  })
})

test("the bundle id binds, not the id string: a receipt claiming the id with another bundle is refused", () => {
  const parsed = parseOrdinaryOpenReceipt(
    receipt({
      subject: {
        id: "iterm2",
        bundleId: "com.example.lookalike",
        version: "3.5.14",
        executableInBundle: "iTerm.app/Contents/MacOS/iTerm2",
      },
      signature: {},
    }),
  )
  expect(
    ordinaryOpenAdmission({
      receipt: parsed,
      probeId: "extensions.osc52-read",
      subject: { id: "iterm2", os: "macos", kind: "term" },
      measuredVersion: "3.5.14",
      expectedBundleId: "com.googlecode.iterm2",
    }),
  ).toMatchObject({
    admit: false,
    unprovable: false,
    refusal: "ancestry bundle id com.example.lookalike is not the bundle iterm2 names (com.googlecode.iterm2)",
  })
})

test("a subject the registry names no bundle for is unprovable, not a measured negative", () => {
  const parsed = parseOrdinaryOpenReceipt(receipt())
  expect(
    ordinaryOpenAdmission({
      receipt: parsed,
      probeId: "extensions.osc52-read",
      subject: { id: "iterm2", os: "macos", kind: "term" },
      measuredVersion: "3.5.14",
      expectedBundleId: undefined,
    }),
  ).toMatchObject({ admit: false, unprovable: true })
})

test("the reader refuses a missing receipt loudly instead of returning a default", () => {
  expect(() => readOrdinaryOpenReceipt("/nonexistent/ordinary-open.json")).toThrow(/unreadable at/)
})
