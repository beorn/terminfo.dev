/**
 * @failure The hosted Windows arm accepts a second owner, or claims an ownership it cannot check on
 *   a platform that is not Windows, so a Windows run grades geometry on a console nobody verified
 *   (#29558, 138 inconclusive observations).
 * @level l1
 * @consumer createOwnedTerminal windowsHosted arm used by collectProbeRun on hosted Windows.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { afterEach, expect, test } from "vitest"
import { createOwnedTerminal, hostedWindowsAppFromExecutablePath } from "./owned-terminal.ts"

const packageRoot = join(import.meta.dirname, "../../..")
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex")
const directories: string[] = []
afterEach(() => {
  // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; each path is this test's own mkdtemp scratch root
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const ids = {
  captureRunId: "a".repeat(32),
  expectedLaunchRunId: "b".repeat(32),
}

test("hostedWindowsAppFromExecutablePath maps WindowsTerminal.exe and alacritty.exe from the receipt executable", () => {
  expect(hostedWindowsAppFromExecutablePath("C:\\runner\\windows-terminal\\WindowsTerminal.exe")).toEqual({
    id: "windows-terminal",
    comm: "WindowsTerminal.exe",
  })
  expect(hostedWindowsAppFromExecutablePath("D:\\a\\_temp\\alacritty\\alacritty.exe")).toEqual({
    id: "alacritty",
    comm: "alacritty.exe",
  })
  expect(() => hostedWindowsAppFromExecutablePath("C:\\Windows\\System32\\cmd.exe")).toThrow(
    /Hosted Windows receipt executable is not one of WindowsTerminal\.exe, alacritty\.exe/,
  )
})

test("windowsHosted is a fourth XOR arm: linux plus windowsHosted is refused", async () => {
  await expect(
    createOwnedTerminal({
      ...ids,
      out: process.stdout,
      linux: { receiptPath: "/tmp/missing-linux.json", executable: { path: process.execPath, sha256: digest("x") } },
      windowsHosted: { receiptPath: "/tmp/missing-windows.json" },
    }),
  ).rejects.toThrow(/Owned terminal requires exactly one platform receipt/)
})

test("windowsHosted alone off Windows refuses by platform, before it reads any receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-hosted-windows-"))
  directories.push(dir)
  const receiptPath = join(dir, "host-measured.json")
  // A receipt file that EXISTS but is not a github-hosted-runner envelope: if the platform guard
  // came second, this test would fail on the receipt instead of the host platform, and a Windows run
  // started anywhere else would read a receipt it has no business reading.
  writeFileSync(receiptPath, "{}")
  await expect(
    createOwnedTerminal({
      ...ids,
      out: process.stdout,
      windowsHosted: { receiptPath },
    }),
  ).rejects.toThrow(/Owned Windows hosted terminal requires Windows/)
})

const alacrittyPath = "D:\\a\\_temp\\alacritty\\alacritty.exe"

/** A github-hosted-runner receipt whose win32 appLaunch is a portable exe at `executablePath`. */
function writeHostedReceipt(executablePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-hosted-windows-alacritty-"))
  directories.push(dir)
  const receiptPath = join(dir, "host-measured.json")
  const exeSha256 = "5ad70ddc5c2a2bfe84084a2c4c73558e9360914f035a902d7a69277be7249f1f"
  const mesaArchiveSha256 = "d1b713ca2a7fba47a50c058099f13c435ddb76a16a422c334e4d787f9755a31d"
  const openglDllSha256 = "8ddc061ee752fff06ae682de0ac2e010926d76a93c1aecc4c206adee771856e1"
  const sample = {
    machineIdSha256: digest("machine"),
    productUuidSha256: digest("uuid"),
    bootIdSha256: digest("boot"),
  }
  writeFileSync(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: "github-hosted-runner",
      runId: ids.expectedLaunchRunId,
      collectedAt: "2026-10-18T09:21:00.000Z",
      job: {
        repository: "terminfo-dev/terminfo.dev",
        workflow: "Windows Measurement",
        workflowRef: "terminfo-dev/terminfo.dev/.github/workflows/windows-measurement.yml@refs/heads/main",
        githubRunId: "39114986301",
        githubRunAttempt: "1",
        job: "collect",
        jobId: "8888",
      },
      runner: {
        environment: "github-hosted",
        name: "win-runner",
        os: "Windows",
        arch: "X64",
        trackingId: "win-tracking",
        imageOS: "win22",
        imageVersion: "20261001.1",
      },
      vm: {
        identityAtJobStart: sample,
        identityAtCollection: sample,
      },
      appLaunch: {
        platform: "win32",
        executablePath,
        productVersion: "0.17.0",
        executableSha256: exeSha256,
        sourceArtifact: {
          kind: "portable-exe",
          path: "D:\\a\\_temp\\measurement-artifacts\\Alacritty-v0.17.0-portable.exe",
          sha256: exeSha256,
        },
        mesaRenderer: {
          upstream: "https://github.com/mmozeiko/build-mesa",
          version: "26.2.5",
          archivePath: "D:\\a\\_temp\\measurement-artifacts\\mesa-llvmpipe-x64-26.2.5.7z",
          archiveSha256: mesaArchiveSha256,
          dlls: [
            {
              name: "opengl32.dll",
              path: "D:\\a\\_temp\\alacritty\\opengl32.dll",
              sha256: openglDllSha256,
            },
          ],
        },
      },
    }),
  )
  return receiptPath
}

/** One Toolhelp32 row; "self" is the child collector's own pid. */
type TableRow = { pid: number | "self"; ppid: number; comm: string }

/** The measured chain of hosted run 39114986301, with conhost.exe as the terminal's other child. */
const alacrittyTable: readonly TableRow[] = [
  { pid: "self", ppid: 4960, comm: "bun.exe" },
  { pid: 4960, ppid: 4684, comm: "powershell.exe" },
  { pid: 7216, ppid: 4684, comm: "conhost.exe" },
  { pid: 4684, ppid: 9644, comm: "alacritty.exe" },
  { pid: 9644, ppid: 6348, comm: "bash.exe" },
  { pid: 6348, ppid: 5672, comm: "Runner.Worker.exe" },
]

/** Runs createOwnedTerminal in a child that reads `table` as the Windows process table, then `assertions`. */
function spawnHostedOwner(receiptPath: string, table: readonly TableRow[], assertions = "") {
  const rows = table
    .map(
      (row) =>
        `{ pid: ${row.pid === "self" ? "process.pid" : String(row.pid)}, ppid: ${String(row.ppid)}, comm: ${JSON.stringify(row.comm)} }`,
    )
    .join(",\n          ")
  return spawnSync(
    process.execPath,
    [
      "-e",
      `
      import { mock } from "bun:test"
      import assert from "node:assert/strict"
      Object.defineProperty(process, "platform", { value: "win32" })
      const ancestry = await import("./packages/terminfo.dev/src/windows-process-ancestry.ts")
      const ffi = await import("./packages/terminfo.dev/src/windows-console-ffi.ts")
      const tty = await import("./packages/terminfo.dev/src/tty.ts")
      mock.module("./packages/terminfo.dev/src/windows-kernel32.ts", () => ({
        hasWindowsKernel32Ffi: () => true,
        loadKernel32: () => ({ symbols: {}, ptr: () => 0 })
      }))
      mock.module("./packages/terminfo.dev/src/windows-process-ancestry.ts", () => ({
        ...ancestry,
        readWindowsProcessTable: () => [
          ${rows}
        ]
      }))
      mock.module("./packages/terminfo.dev/src/windows-console-ffi.ts", () => ({
        ...ffi,
        readWindowsConsoleIdentity: () => "hwnd:0x100",
        readWindowsConsoleGeometry: () => ({ cols: 80, rows: 24 })
      }))
      mock.module("./packages/terminfo.dev/src/tty.ts", () => ({
        ...tty,
        wasCollectorOpenedControllingTTY: () => true
      }))
      const { createOwnedTerminal } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      const owner = await createOwnedTerminal({
        captureRunId: ${JSON.stringify(ids.captureRunId)},
        expectedLaunchRunId: ${JSON.stringify(ids.expectedLaunchRunId)},
        out: process.stdout,
        windowsHosted: { receiptPath: ${JSON.stringify(receiptPath)} }
      })
      ${assertions}
      await owner.dispose()
      `,
    ],
    { cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
  )
}

test("windowsHosted grants ownership to an alacritty.exe ancestor from a portable-exe receipt and records its appId and conhost buffer owner", () => {
  const result = spawnHostedOwner(
    writeHostedReceipt(alacrittyPath),
    alacrittyTable,
    `
      assert.equal(owner.hostedWindowsAppId, "alacritty")
      assert.equal(owner.hostedAppPid, 4684)
      const summary = JSON.parse(owner.summary)
      assert.equal(summary.windowsHosted.appId, "alacritty")
      assert.deepEqual(summary.windowsHosted.ancestor, { pid: 4684, ppid: 9644, comm: "alacritty.exe" })
      assert.deepEqual(summary.windowsHosted.consoleHost, { image: "conhost.exe", pid: 7216, ppid: 4684 })
      `,
  )
  expect(result.status, result.stderr).toBe(0)
})

// Each refusal is reached through createOwnedTerminal itself: the receipt executable picks the app
// (owned-terminal.ts hostedWindowsAppFromExecutablePath) and the measured chain must reach that app
// and no other (requireHostedWindowsAppAncestor), so a lenient call site grants these chains.
test.each([
  {
    name: "a receipt executable that is not a hosted Windows app, even with that executable on the chain",
    executablePath: "C:\\Windows\\System32\\cmd.exe",
    table: alacrittyTable.map((row) => (row.comm === "alacritty.exe" ? { ...row, comm: "cmd.exe" } : row)),
    refusal: /Hosted Windows receipt executable is not one of WindowsTerminal\.exe, alacritty\.exe/,
  },
  {
    name: "a chain that reaches a competing hosted terminal",
    executablePath: alacrittyPath,
    table: alacrittyTable.flatMap((row) =>
      row.comm === "alacritty.exe"
        ? [
            { ...row, ppid: 3100 },
            { pid: 3100, ppid: 9644, comm: "WindowsTerminal.exe" },
          ]
        : [row],
    ),
    refusal: /Hosted Windows ancestry reached WindowsTerminal\.exe \(pid 3100\) while the receipt names alacritty\.exe/,
  },
  {
    name: "a chain that never reaches the receipt's app",
    executablePath: alacrittyPath,
    table: alacrittyTable
      .filter((row) => row.comm !== "alacritty.exe" && row.comm !== "conhost.exe")
      .map((row) => (row.comm === "powershell.exe" ? { ...row, ppid: 9644 } : row)),
    refusal: /Hosted Windows ancestry never reached alacritty\.exe/,
  },
])("windowsHosted refuses $name", ({ executablePath, table, refusal }) => {
  const result = spawnHostedOwner(writeHostedReceipt(executablePath), table)
  expect(result.status, result.stderr).not.toBe(0)
  expect(result.stderr).toMatch(refusal)
})
