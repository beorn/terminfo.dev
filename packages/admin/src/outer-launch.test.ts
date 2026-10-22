/**
 * @failure A Darwin mux proof is admitted against a receipt from another run, or a replayed receipt
 *          whose run file, identity file or owner identity no longer match is read as a pass.
 * @level l1
 * @consumer Admission's Darwin mux arm, through the one record parser and join.
 * @testonly none
 * @reach none <fixture-only: in-memory bytes>
 */
import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import type { DarwinMuxAttachmentProof } from "@terminfo/probe-defs"
import { outerLaunchMismatch, parseOuterLaunchRecord } from "./outer-launch.ts"

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const proof: DarwinMuxAttachmentProof = {
  platform: "darwin",
  mux: "tmux",
  bootId: "a1b2c3d4-1111-2222-3333-444455556666",
  receiptSha256: "",
  launchRunId: "0123456789abcdef0123456789abcdef",
  captureRunId: "fedcba9876543210fedcba9876543210",
  preflightCollector: { pid: 95, startedAtEpochSeconds: 1792678700 },
  outerShell: { pid: 55772, startedAtEpochSeconds: 1792678807, ttyRdev: 268435456 },
  outerTerminal: { pid: 55770, startedAtEpochSeconds: 1792678806 },
  collector: { pid: 55803, startedAtEpochSeconds: 1792678808, ttyRdev: 268435459 },
  attachedClient: { pid: 55802, startedAtEpochSeconds: 1792678808, ttyRdev: 268435456 },
  chain: [
    {
      pid: 55803,
      ppid: 55800,
      uid: 501,
      startedAtEpochSeconds: 1792678808,
      executablePath: "/Users/codi/.bun/bin/bun",
      ttyRdev: 268435459,
    },
    {
      pid: 55800,
      ppid: 55772,
      uid: 501,
      startedAtEpochSeconds: 1792678807,
      executablePath: "/usr/local/Cellar/tmux/3.7/bin/tmux",
      ttyRdev: 268435456,
    },
    {
      pid: 55772,
      ppid: 55771,
      uid: 501,
      startedAtEpochSeconds: 1792678807,
      executablePath: "/bin/bash",
      ttyRdev: 268435456,
    },
    {
      pid: 55771,
      ppid: 55770,
      uid: 0,
      startedAtEpochSeconds: 1792678806,
      executablePath: "/usr/bin/login",
      ttyRdev: 268435456,
    },
    {
      pid: 55770,
      ppid: 1,
      uid: 501,
      startedAtEpochSeconds: 1792678806,
      executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      ttyRdev: null,
    },
  ],
  executable: { path: "/usr/local/Cellar/tmux/3.7/bin/tmux", sha256: digest("tmux"), version: "3.7" },
  config: { path: "/tmp/run/tmux.conf", sha256: digest("") },
  socketPath: "/tmp/run/mux.sock",
  session: "owned",
}

const RUN_FILE = "/tmp/terminfo-run-abc/ghostty-0123456789abcdef0123456789abcdef"
const IDENTITY_FILE = "/tmp/terminfo-run-abc/owner-tty.txt"
const GHOSTTY = "/Applications/Ghostty.app/Contents/MacOS/ghostty"

const files = () =>
  new Map<string, Buffer>([
    [RUN_FILE, Buffer.from("command = /tmp/terminfo-run-abc/serve-0123456789abcdef0123456789abcdef.sh\n")],
    [IDENTITY_FILE, Buffer.from("/dev/ttys000\n")],
  ])

const record = () =>
  JSON.stringify({
    launchRunId: proof.launchRunId,
    executablePath: GHOSTTY,
    marker: { flag: "--config-file", value: RUN_FILE },
    identityFile: { path: IDENTITY_FILE, sha256: digest(files().get(IDENTITY_FILE)!) },
    outerTerminal: proof.outerTerminal,
    bootId: proof.bootId,
    runFileSha256: digest(files().get(RUN_FILE)!),
    autoUpdate: {
      key: "SUEnableAutomaticChecks",
      value: "0",
      plistPath: "/Users/codi/Library/Preferences/com.mitchellh.ghostty.plist",
      plistSha256: digest("plist"),
    },
  })

const withCitation = () => {
  const source = record()
  return { source, proof: { ...proof, receiptSha256: digest(source) } }
}

test("the record parses strictly and admits only the run, owner and bytes it names", () => {
  const { source, proof: cited } = withCitation()
  expect(parseOuterLaunchRecord(source)).toMatchObject({ launchRunId: proof.launchRunId, bootId: proof.bootId })
  const read = (path: string) => files().get(path) ?? null
  expect(outerLaunchMismatch(source, cited, read, GHOSTTY)).toBeNull()

  // Every case re-cites its own text, so the citation check cannot mask the rule under test.
  const cases: [string, string, RegExp][] = [
    // Another run's receipt: the marker no longer carries this run's id.
    [
      "another run's marker",
      source.replaceAll(proof.launchRunId, "ffffffffffffffffffffffffffffffff"),
      /does not carry the run id|names another run/,
    ],
    // The owner binary differs from the measured outer app.
    [
      "another owner executable",
      source.replace(
        '"/Applications/Ghostty.app/Contents/MacOS/ghostty"',
        '"/Applications/Ghostty.app/Contents/MacOS/other"',
      ),
      /owner executable differs/,
    ],
    // The boot identity differs from the proof.
    ["another boot id", source.replace(proof.bootId, "a1b2c3d4-1111-2222-3333-444455556667"), /boot id differs/],
    // The outer terminal differs from the proof.
    ["another outer terminal", source.replace('"pid":55770', '"pid":55771'), /outer terminal differs/],
    ["malformed JSON", "{", /not JSON/],
    ["an extra key", source.replace('{"launchRunId"', '{"extra":1,"launchRunId"'), /must have exactly/],
  ]
  for (const [name, text, refusal] of cases) {
    const altered = { ...cited, receiptSha256: digest(text) }
    expect(outerLaunchMismatch(text, altered, read, GHOSTTY), name).toMatch(refusal)
  }
  // A proof replaying a receipt it does not cite is refused before any field is compared.
  expect(outerLaunchMismatch(source, { ...cited, receiptSha256: digest("other") }, read, GHOSTTY)).toMatch(
    /cites another receipt/,
  )
  // Bytes that no longer match the receipt are named, never a pass.
  const rewritten = (path: string) =>
    path === RUN_FILE ? Buffer.from("command = /tmp/elsewhere.sh\n") : (files().get(path) ?? null)
  expect(outerLaunchMismatch(source, cited, rewritten, GHOSTTY)).toMatch(/run file's bytes differ/)
  const newIdentity = (path: string) =>
    path === IDENTITY_FILE ? Buffer.from("/dev/ttys001\n") : (files().get(path) ?? null)
  expect(outerLaunchMismatch(source, cited, newIdentity, GHOSTTY)).toMatch(/identity file's bytes differ/)
  // Absent bytes are named, never a pass.
  expect(outerLaunchMismatch(source, cited, () => null, GHOSTTY)).toMatch(/run file .* is absent/)
})
