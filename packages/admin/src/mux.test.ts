/**
 * @failure Mux raw-output collection admits development data or loses its original HTTP response.
 * @level l1
 * @consumer handleMux private-output lifecycle and the shared immutable raw writer.
 * @reach fs-read vendor/terminfo.dev/test-fixtures/probes-apps/kitty-0.49.2-linux-8c50df5834ccb938c208aa91467e9a2b.json
 * @reach fs-walk <fixture-only: mkdtempSync capture output directory; readdirSync picks the tmux raw file written beside the HTTP response>
 * @testonly none
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { execSync, spawnSync } from "node:child_process"
import { expect, it, vi } from "vitest"
import { ENVIRONMENT_GROUP_IDS, type CapturedRunDraft, type HistoricalProbeRun } from "@terminfo/probe-defs"
import { handleMux } from "./mux.ts"
import {
  createProbeRun,
  findOwnedDaemon,
  readRetainedDaemonProbeResponse,
  removeProbeRun,
  requestDaemonProbe,
  stopOwnedDaemon,
} from "../../terminfo.dev/src/daemon-client.ts"
import { planAdmission, admitRun } from "../../../scripts/admit-run.ts"

vi.mock("../../../scripts/admit-run.ts", () => ({ planAdmission: vi.fn(), admitRun: vi.fn() }))
vi.mock("../versions.ts", () => ({
  sourceSuiteEnvironment: () => ({ TERMINFO_PROBE_HASH: "fixture", TERMINFO_SOURCE_REVISION: "fixture" }),
}))
vi.mock("node:child_process", () => ({ execSync: vi.fn(() => ""), spawnSync: vi.fn() }))
vi.mock("../../terminfo.dev/src/daemon-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../terminfo.dev/src/daemon-client.ts")>()),
  createProbeRun: vi.fn(),
  findOwnedDaemon: vi.fn(),
  readRetainedDaemonProbeResponse: vi.fn(),
  removeProbeRun: vi.fn(),
  requestDaemonProbe: vi.fn(),
  stopOwnedDaemon: vi.fn(),
}))

// App/server suites cover admission. This mux boundary must independently prove that an output
// directory chooses raw retention and still cleans up its own daemon/session, without grading it.
it.each([
  ["private", false],
  ["private", true],
  ["empty", false],
  ["symlink", false],
] as const)("handles %s raw output without admission, environment catalogue: %s", async (mode, environment) => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-mux-output-"))
  const output = mode === "empty" ? "" : join(directory, "output")
  if (mode === "symlink") symlinkSync(new URL("../../../", import.meta.url), output)
  const wrapper = join(directory, "wrapper")
  mkdirSync(wrapper)
  const log = vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  const historical = JSON.parse(
    readFileSync(
      new URL(
        "../../../test-fixtures/probes-apps/kitty-0.49.2-linux-8c50df5834ccb938c208aa91467e9a2b.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as HistoricalProbeRun
  const {
    observations: _observations,
    notTested: _notTested,
    ungradedDiagnostics: _diagnostics,
    suiteComplete: _complete,
    ...metadata
  } = historical
  const run: CapturedRunDraft = {
    ...metadata,
    schemaVersion: 3,
    intendedContext: { kind: "mux", id: "tmux", version: "3.6a" },
    results: ["sgr.bold", ...(environment ? ENVIRONMENT_GROUP_IDS : [])].map((featureId) => ({
      featureId,
      status: "test-todo",
      attempt: { scope: "none" },
      checks: [],
      reason: "Synthetic route fixture; not measured",
    })),
  }
  // Only transport/persistence is exercised: this synthetic identity is not native mux evidence.
  run.target = { ...run.target, kind: "mux", id: "tmux", version: "3.6a" }
  const bytes = JSON.stringify(run)
  // COPYFILE_EXCL cannot overwrite the real package.json on the unfixed path; the correct guard must refuse first.
  const original = join(directory, mode === "symlink" ? "package.json" : "http-response.json")
  writeFileSync(original, bytes, { mode: 0o600 })
  vi.mocked(execSync).mockImplementation((command) =>
    command.toString().startsWith("which") ? "/usr/bin/tmux" : command.toString() === "tmux -V" ? "tmux 3.6a" : "",
  )
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: "tmux 3.6a\n",
    stderr: "",
    signal: null,
    pid: 0,
    output: [],
  })
  vi.mocked(createProbeRun).mockReturnValue({
    id: "fixture-launch",
    directory: wrapper,
    scriptPath: join(wrapper, "serve.sh"),
  })
  const owned = {
    filepath: join(directory, "registration"),
    registration: {
      pid: 123,
      port: 1234,
      runId: "fixture-launch",
      token: "fixture-token",
      terminal: "tmux",
      terminalVersion: "3.6a",
    },
  }
  vi.mocked(findOwnedDaemon).mockResolvedValue(owned)
  vi.mocked(requestDaemonProbe).mockResolvedValue(new Response("{}"))
  vi.mocked(readRetainedDaemonProbeResponse).mockResolvedValue({
    run,
    path: original,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })
  vi.mocked(planAdmission).mockImplementation(() => {
    throw new Error("development entered admission")
  })
  try {
    if (mode === "empty") {
      await expect(handleMux("tmux", { output })).rejects.toThrow(/output directory is empty/)
    } else if (mode === "symlink") {
      await expect(handleMux("tmux", { output })).rejects.toThrow(
        /output must be private, outside the source repository/,
      )
    } else {
      await handleMux("tmux", { output })
    }
    expect(planAdmission).not.toHaveBeenCalled()
    expect(admitRun).not.toHaveBeenCalled()
    if (mode === "private") {
      const clause = environment ? " · 9 environment groups manual by design (catalogue), ungraded" : ""
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`1 TEST TODO · 0 TEST FAILURE${clause} (private, unadmitted)`),
      )
      expect(readFileSync(join(output, "http-response.json"), "utf8")).toBe(bytes)
      const raw = readdirSync(output).find((name) => name.startsWith("tmux-3.6a-"))
      expect(raw).toBeTruthy()
      expect(JSON.parse(readFileSync(join(output, raw!), "utf8"))).toMatchObject({
        runId: run.runId,
        target: { kind: "mux", id: "tmux" },
      })
    }
    expect(stopOwnedDaemon).toHaveBeenCalledWith(owned)
    expect(removeProbeRun).toHaveBeenCalledOnce()
    expect(spawnSync).toHaveBeenCalledWith("/usr/bin/tmux", ["-V"], expect.anything())
    expect(execSync).toHaveBeenCalledWith(expect.stringMatching(/^'\/usr\/bin\/tmux' new-session /), expect.anything())
    expect(execSync).toHaveBeenCalledWith(expect.stringMatching(/^'\/usr\/bin\/tmux' kill-session /), expect.anything())
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("(admitted)"))
    expect(readFileSync(original, "utf8")).toBe(bytes)
  } finally {
    vi.resetAllMocks()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  }
})

// The existing listing boundary must distinguish usable Screen metadata from suppressed command failures.
it.each([
  { label: "status zero", status: 0, stdout: "Screen version 4.00.03 (FAU) 23-Oct-06\n", stderr: "", accepted: true },
  {
    label: "Screen status one convention",
    status: 1,
    stdout: "Screen version 4.00.03 (FAU) 23-Oct-06\n",
    stderr: "",
    accepted: true,
  },
  { label: "unexpected status", status: 2, stdout: "Screen version 4.00.03\n", stderr: "", accepted: false },
  { label: "bad banner", status: 1, stdout: "screen failed\n", stderr: "", accepted: false },
  { label: "extra output", status: 1, stdout: "Screen version 4.00.03\nfailed\n", stderr: "", accepted: false },
  { label: "stderr failure", status: 1, stdout: "Screen version 4.00.03\n", stderr: "cannot execute", accepted: false },
  { label: "spawn failure", status: null, stdout: "", stderr: "", accepted: false, error: new Error("ENOENT") },
])("validates Darwin Screen preflight: $label", async ({ status, stdout, stderr, accepted, ...extra }) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {})
  const originalPath = process.env.PATH
  const standardPaths = 'PATH="/usr/local/bin:/usr/bin:/bin"; export PATH;\n'
  vi.stubGlobal("process", { ...process, platform: "darwin" })
  vi.mocked(execSync).mockImplementation((command) => {
    if (command.toString().startsWith("which tmux")) throw new Error("not found")
    if (command.toString().startsWith("which screen")) return "/ambient/screen"
    return "Screen version 9.99.99\n"
  })
  vi.mocked(spawnSync).mockImplementation((binary, args = []) => {
    const result = { status: 0, stdout: "", stderr: "", error: undefined, signal: null, pid: 0, output: [] }
    if (binary === "/usr/libexec/path_helper") {
      return { ...result, stdout: standardPaths }
    }
    if (binary === "/bin/sh") {
      return args.at(-1) === "screen" ? { ...result, stdout: "/usr/bin/screen\n" } : { ...result, status: 1 }
    }
    if (binary === "/usr/bin/screen") return { ...result, status, stdout, stderr, ...extra }
    throw new Error(`Unexpected preflight executable: ${binary}`)
  })
  try {
    if (accepted) {
      await handleMux(undefined, {})
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/GNU Screen\s+4\.00\.03/))
    } else {
      await expect(handleMux(undefined, {})).rejects.toThrow(/screen.*version|version.*screen/i)
    }
    expect(spawnSync).toHaveBeenCalledWith("/usr/libexec/path_helper", ["-s"], expect.anything())
    expect(spawnSync).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", `${standardPaths}\ncommand -v "$1"`, "terminfo-mux", "screen"],
      expect.anything(),
    )
    expect(process.env.PATH).toBe(originalPath)
    expect(createProbeRun).not.toHaveBeenCalled()
    expect(findOwnedDaemon).not.toHaveBeenCalled()
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    vi.unstubAllGlobals()
    vi.resetAllMocks()
    vi.restoreAllMocks()
  }
})
