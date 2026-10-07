/**
 * @failure A missing or mismatched container receipt is accepted as a host image's completed run.
 * @level l1 — invokes the real shell receipt composer on owned temporary files.
 * @consumer scripts/linux-container-run.sh host-side run receipt and prerequisite handling.
 * @reach fs-walk <fixture-only: readdir enumerates the owned temporary run output only>
 * @reach fs-walk vendor/terminfo.dev/scripts/
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
  capture: unknown = { xwdSha256: "xwd-hash", pngSha256: "png-hash" },
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
        capture,
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

  it("refuses a filtered host/container selection mismatch", () => {
    const { result } = compose()
    expect(result.status).toBe(0)
    const host = JSON.parse(readFileSync(join(dir, "host.json"), "utf8")) as { selectedIDs?: string[] }
    const container = JSON.parse(readFileSync(join(dir, "container.json"), "utf8")) as { selectedIDs?: string[] }
    host.selectedIDs = ["cursor.hide"]
    container.selectedIDs = ["reset.decaln"]
    writeFileSync(join(dir, "host.json"), JSON.stringify(host))
    writeFileSync(join(dir, "container.json"), JSON.stringify(container))
    const again = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; compose_receipt "$2" "$3" "$4"',
        "_",
        launcher,
        join(dir, "host.json"),
        join(dir, "container.json"),
        join(dir, "mismatched.json"),
      ],
      { encoding: "utf8" },
    )
    expect(again.status).toBe(2)
    expect(again.stderr).toContain("selection")
    expect(existsSync(join(dir, "mismatched.json"))).toBe(false)
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

/** The receipt authorizes writing to a terminal, so the container judged by it must not be able
 * to rewrite the copy it is judged against, and the host must be able to prove that afterwards. */
describe("disposable ownership receipt mount", () => {
  it("hands the collector a read-only copy outside the writable output mount and re-checks it after removal", () => {
    const source = readFileSync(launcher, "utf8")
    expect(source).toMatch(/--mount "type=bind,src=\$prep\/receipt,dst=\/receipt,readonly"/)
    expect(source).toMatch(/--env "TERMINFO_DISPOSABLE_RECEIPT=\/receipt\/host-measured\.json"/)
    expect(source).toMatch(/cmp -s "\$raw\/host-measured\.json" "\$prep\/receipt\/host-measured\.json" \|\|/)
  })
})

/** A run whose selection called no capture callback carries no frame. That is a fact about the
 * run, not a failure of it (27875): the launcher records "no frame captured" and carries the run,
 * instead of aborting on a bare `jq -er` exit 2 that named nothing. */
describe("frame-less container run", () => {
  const expression = (() => {
    const source = readFileSync(launcher, "utf8")
    const match = source.match(/capture_frame=\$\(jq -c '([^']*)' \/out\/v2-run\.json\)/)
    if (!match) throw new Error("frame selection expression not found in scripts/linux-container-run.sh")
    return match[1]!
  })()

  function select(run: unknown) {
    return spawnSync("jq", ["-c", expression], { input: JSON.stringify(run), encoding: "utf8" })
  }

  it("selects null for a run that captured no frame, without failing", () => {
    const result = select({ observations: [{ featureId: "device.primary-da" }, { featureId: "reset.ris" }] })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("null")
  })

  it("selects the target frame when a probe captured one", () => {
    const frame = { role: "target", ref: `sha256:${"a".repeat(64)}`, sourceRef: `sha256:${"b".repeat(64)}` }
    const result = select({ observations: [{ featureId: "cursor.shape", frames: [frame] }] })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(frame)
  })

  it("records the absence by name and no longer refuses on the bare jq -er", () => {
    const source = readFileSync(launcher, "utf8")
    expect(source).toMatch(/no frame captured: no selected probe called ctx\.capture/)
    expect(source).toMatch(/capture_receipt=null/)
    expect(source).not.toMatch(/png_sha=\$\(jq -er '\[\.observations\[\]\.frames/)
  })

  const gateExpression = (() => {
    const source = readFileSync(launcher, "utf8")
    const match = source.match(/jq -e --argjson ids "\$selected_ids" --argjson frameless "\$frameless_ids" '([^']*)'/)
    if (!match) throw new Error("--ids gate expression not found in scripts/linux-container-run.sh")
    return match[1]!
  })()

  function gate(ids: string[], frameless: string[], run: unknown) {
    return spawnSync(
      "jq",
      [
        "-e",
        "--argjson",
        "ids",
        JSON.stringify(ids),
        "--argjson",
        "frameless",
        JSON.stringify(frameless),
        gateExpression,
      ],
      { input: JSON.stringify(run), encoding: "utf8" },
    )
  }

  const frameUnavailable = {
    kind: "collector-error",
    name: "FrameUnavailable",
    message: "This run has no capture directory",
  }

  it("accepts a frame-less selection whose only diagnostic is the named FrameUnavailable", () => {
    const result = gate(["device.primary-da", "cursor.shape"], ["cursor.shape"], {
      observations: [{ featureId: "device.primary-da" }],
      ungradedDiagnostics: { "cursor.shape": frameUnavailable },
    })
    expect(result.status).toBe(0)
  })

  it("refuses a FrameUnavailable in a run that had a capture directory", () => {
    const result = gate(["device.primary-da", "cursor.shape"], [], {
      observations: [{ featureId: "device.primary-da" }],
      ungradedDiagnostics: { "cursor.shape": frameUnavailable },
    })
    expect(result.status).not.toBe(0)
  })

  it("refuses any other diagnostic in a frame-less selection", () => {
    const result = gate(["cursor.shape"], ["cursor.shape"], {
      observations: [],
      ungradedDiagnostics: { "cursor.shape": { kind: "collector-error", name: "Error", message: "boom" } },
    })
    expect(result.status).not.toBe(0)
  })

  it("composes a frame-less run, whose container receipt carries no capture", () => {
    const { result, output } = compose("a".repeat(32), true, "runner-hash", "default", null)
    expect(result.status).toBe(0)
    const receipt = JSON.parse(readFileSync(output, "utf8")) as { capture: unknown }
    expect(receipt.capture).toBeNull()
  })
})

describe("explicit Linux image selection", () => {
  it.each([
    ["bogus", "default", "default", "Unknown target"],
    ["kitty", "unknown", "default", "Kitty takes --preset baseline|current"],
    ["xterm", "baseline", "default", "xterm has only the default preset"],
    ["kitty", "current", "unknown", "Unknown clipboard profile"],
  ])("refuses invalid target/preset/profile %s/%s/%s before preparing a run", (target, preset, profile, error) => {
    const result = spawnSync(
      "bash",
      [launcher, "--target", target, "--preset", preset, "--clipboard-profile", profile, dir],
      { encoding: "utf8" },
    )
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
      [fixtureLauncher, "--target", "kitty", "--preset", "current", "--clipboard-profile", "default", output],
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

describe("private finite launch arguments", () => {
  it("refuses an unknown flag before preparing or building", () => {
    const result = spawnSync(
      "bash",
      [launcher, "--target", "kitty", "--preset", "current", "--clipboard-profile", "default", "--unknown", dir],
      { encoding: "utf8" },
    )
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("Unknown flag")
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    [[], "Missing --ids value"],
    [[""], "Invalid probe IDs"],
    [["cursor.hide,cursor.hide"], "Invalid probe IDs"],
    [["cursor.hide,"], "Invalid probe IDs"],
    [["cursor.hide", "--ids", "reset.decaln"], "Repeated --ids"],
  ])("refuses invalid supplied filter %j before preparing or building", (suffix, message) => {
    const result = spawnSync(
      "bash",
      [launcher, "--target", "kitty", "--preset", "current", "--clipboard-profile", "default", "--ids", ...suffix, dir],
      { encoding: "utf8" },
    )
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(message)
    expect(readdirSync(dir)).toEqual([])
  })
})
