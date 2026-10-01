/**
 * @failure A missing or mismatched container receipt is accepted as a host image's completed run.
 * @level l1 — invokes the real shell receipt composer on owned temporary files.
 * @consumer scripts/linux-container-run.sh host-side run receipt and prerequisite handling.
 * @reach fs-walk <fixture-only: readdir enumerates the owned temporary run output only>
 * @testonly none
 */

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const launcher = fileURLToPath(new URL("./linux-container-run.sh", import.meta.url))
let dir: string

function compose(
  containerRunId = "a".repeat(32),
  writeContainer = true,
  containerRunnerSha = "runner-hash",
  containerProfile = "default",
) {
  const host = join(dir, "host.json")
  const container = join(dir, "container.json")
  const output = join(dir, "run-receipt.json")
  writeFileSync(
    host,
    JSON.stringify({
      runId: "a".repeat(32),
      clipboardProfile: "default",
      sourceArtifact: { url: "https://example.invalid/kitty.txz" },
      runnerArtifact: { frozenRunnerSha256: "runner-hash", buildReceiptSha256: "receipt-hash" },
      runtime: { imageId: "sha256:image", imageTarSha256: "tar-hash" },
    }),
  )
  if (writeContainer) {
    writeFileSync(
      container,
      JSON.stringify({
        runId: containerRunId,
        invocation: { path: "/nix/store/kitty/bin/kitty", sha256: "wrapper-hash" },
        executable: { path: "/nix/store/kitty/bin/.kitty-wrapped", version: "kitty 0.49.1", sha256: "elf-hash" },
        sourceArtifact: { path: "/kitty-source/kitty.txz", sha256: "archive-hash" },
        collector: { frozenRunnerSha256: containerRunnerSha, buildReceiptSha256: "receipt-hash" },
        probeRun: { path: "v2-run.json", runId: "b".repeat(32), sha256: "probe-hash" },
        display: { glxinfo: "llvmpipe", geometry: "WIDTH=800" },
        clipboardFixture: { runId: containerRunId, profile: containerProfile, sha256: "fixture-hash" },
        capture: { xwdSha256: "xwd-hash", pngSha256: "png-hash" },
      }),
    )
  }
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; compose_receipt "$2" "$3" "$4"', "_", launcher, host, container, output],
    {
      encoding: "utf8",
    },
  )
  return { result, output }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "terminfo-container-receipt-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("container run receipt composition", () => {
  it("combines host image identity with the matching container measurements", () => {
    const { result, output } = compose()
    expect(result.status).toBe(0)
    const receipt = JSON.parse(readFileSync(output, "utf8")) as {
      runtime: { imageId: string }
      executable: { sha256: string }
      invocation: { path: string; sha256: string }
      receiptInputs: { hostSha256: string; containerSha256: string }
      sourceArtifact: { url: string; path: string; sha256: string }
      collector: { frozenRunnerSha256: string }
      probeRun: { runId: string; sha256: string }
      clipboardFixture: { profile: string; sha256: string }
    }
    expect(receipt.runtime.imageId).toBe("sha256:image")
    expect(receipt.executable.sha256).toBe("elf-hash")
    expect(receipt.invocation).toEqual({ path: "/nix/store/kitty/bin/kitty", sha256: "wrapper-hash" })
    expect(receipt.receiptInputs.hostSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.receiptInputs.containerSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.sourceArtifact).toEqual({
      url: "https://example.invalid/kitty.txz",
      path: "/kitty-source/kitty.txz",
      sha256: "archive-hash",
    })
    expect(receipt.collector.frozenRunnerSha256).toBe("runner-hash")
    expect(receipt.probeRun).toEqual({ path: "v2-run.json", runId: "b".repeat(32), sha256: "probe-hash" })
    expect(receipt.clipboardFixture).toEqual({ runId: "a".repeat(32), profile: "default", sha256: "fixture-hash" })
  })

  it("refuses a missing container half before writing a run receipt", () => {
    const { result, output } = compose("a".repeat(32), false)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Missing container receipt")
    expect(existsSync(output)).toBe(false)
  })

  it("refuses mismatched run IDs before writing a run receipt", () => {
    const { result, output } = compose("b".repeat(32))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("runId mismatch")
    expect(existsSync(output)).toBe(false)
  })

  it("refuses collector bytes that differ from the host-measured image input", () => {
    const { result, output } = compose("a".repeat(32), true, "different-runner")
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("container collector bytes disagree")
    expect(existsSync(output)).toBe(false)
  })

  it("refuses a clipboard profile that differs between host and container", () => {
    const { result, output } = compose("a".repeat(32), true, "runner-hash", "allow")
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("container clipboard fixture disagrees")
    expect(existsSync(output)).toBe(false)
  })
})

describe("explicit Linux image selection", () => {
  it.each([
    ["unknown", "default", "Unknown Kitty preset"],
    ["current", "unknown", "Unknown clipboard profile"],
  ])("refuses invalid preset/profile %s/%s before preparing a run", (preset, profile, error) => {
    const result = spawnSync("bash", [launcher, "--preset", preset, "--clipboard-profile", profile, dir], {
      encoding: "utf8",
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(error)
    expect(existsSync(join(dir, "prep"))).toBe(false)
  })
})

/** The real launcher must stop after a failed frozen dependency prerequisite, even inside its checked group. */
describe("Linux runner prerequisite failure", () => {
  it("retains the failed install and never invokes CLI build, Nix or Docker afterwards", () => {
    const root = join(dir, "code")
    const scripts = join(root, "vendor/terminfo.dev/scripts")
    const bins = join(dir, "bin")
    const output = join(dir, "runs")
    const calls = join(dir, "calls.log")
    mkdirSync(scripts, { recursive: true })
    mkdirSync(bins)
    writeFileSync(join(root, "flake.nix"), "{}")
    writeFileSync(join(root, "bun.lock"), "{}")
    const fixtureLauncher = join(scripts, "linux-container-run.sh")
    copyFileSync(launcher, fixtureLauncher)
    for (const name of ["@in", "nix", "docker"]) {
      const path = join(bins, name)
      writeFileSync(
        path,
        `#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "$CALL_LOG"
if [[ "$1 $2 $3" == "-- bun install" ]]; then
  echo "fixture frozen install failed (exit 41)" >&2
  exit 41
fi
exit 0
`,
      )
      chmodSync(path, 0o755)
    }
    const result = spawnSync(
      "bash",
      [fixtureLauncher, "--preset", "current", "--clipboard-profile", "default", output],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bins}:${process.env.PATH ?? ""}`, CALL_LOG: calls },
        timeout: 5_000,
      },
    )
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("fixture frozen install failed (exit 41)")
    expect(result.stderr).toContain("Offline frozen runner build failed; preserved at")
    const run = readdirSync(output)
    expect(run).toHaveLength(1)
    expect(readFileSync(join(output, run[0]!, "prep/bundle-build.log"), "utf8")).toContain(
      "fixture frozen install failed (exit 41)",
    )
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      "@in -- bun install --frozen-lockfile --ignore-scripts",
    ])
    expect(existsSync(join(output, run[0]!, "prep/bundle"))).toBe(false)
    expect(existsSync(join(output, run[0]!, "prep/nix-build.log"))).toBe(false)
    expect(existsSync(join(output, run[0]!, "raw/run-receipt.json"))).toBe(false)
  })
})
