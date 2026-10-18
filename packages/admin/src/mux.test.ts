/**
 * @failure Mux raw-output collection admits development data or loses its original HTTP response.
 * @level l1
 * @consumer handleMux private-output lifecycle and the shared immutable raw writer.
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/kitty-0.49.2-linux-8c50df5834ccb938c208aa91467e9a2b.json
 * @testonly none
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { execSync } from "node:child_process"
import { expect, it, vi } from "vitest"
import type { ProbeRun } from "@terminfo/probe-defs"
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
vi.mock("node:child_process", () => ({ execSync: vi.fn(() => "") }))
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
it.each(["private", "empty", "symlink"])("handles %s raw output without entering admission", async (mode) => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-mux-output-"))
  const output = mode === "empty" ? "" : join(directory, "output")
  if (mode === "symlink") symlinkSync(new URL("../../../", import.meta.url), output)
  const wrapper = join(directory, "wrapper")
  mkdirSync(wrapper)
  const log = vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  const run = JSON.parse(
    readFileSync(
      new URL("../../../content/probes-apps/kitty-0.49.2-linux-8c50df5834ccb938c208aa91467e9a2b.json", import.meta.url),
      "utf8",
    ),
  ) as ProbeRun
  // Only transport/persistence is exercised: this synthetic identity is not native mux evidence.
  run.target = { ...run.target, kind: "mux", id: "tmux", version: "3.6a" }
  const bytes = JSON.stringify(run)
  // COPYFILE_EXCL cannot overwrite the real package.json on the unfixed path; the correct guard must refuse first.
  const original = join(directory, mode === "symlink" ? "package.json" : "http-response.json")
  writeFileSync(original, bytes, { mode: 0o600 })
  vi.mocked(execSync).mockImplementation((command) =>
    command.toString().startsWith("which") ? "/usr/bin/tmux" : command.toString() === "tmux -V" ? "tmux 3.6a" : "",
  )
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
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining("tmux kill-session"), expect.anything())
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("(admitted)"))
    expect(readFileSync(original, "utf8")).toBe(bytes)
  } finally {
    vi.resetAllMocks()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  }
})
