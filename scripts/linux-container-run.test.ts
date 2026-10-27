/**
 * @failure A missing or mismatched container receipt is accepted as a host image's completed run.
 * @level l1 — invokes the real shell receipt composer on owned temporary files.
 * @consumer scripts/linux-container-run.sh host-side run receipt and prerequisite handling.
 * @reach fs-walk <fixture-only: readdir enumerates the owned temporary run output only>
 * @reach fs-walk vendor/terminfo.dev/scripts/**
 * @testonly none
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { LinuxMuxAttachmentProof } from "@terminfo/probe-defs"
import { bindReceiptToRun, parseDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"

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
        probeRun: { path: "v3-capture.json", runId: "b".repeat(32), sha256: "probe-hash" },
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

// The producer must bind disposable authority to the mux without relabeling Kitty's
// archive/version. Existing composition tests supply host JSON and missed this join.
it.each(["", "tmux", "screen"])("host writer binds %s while retaining the outer source facts", (mux) => {
  const host = join(dir, "produced-host.json")
  const build = join(dir, "build.json")
  writeFileSync(build, "{}")
  const digest = createHash("sha256").update("measured-image").digest("hex")
  const result = spawnSync(
    "bash",
    [
      "-c",
      String.raw`
source "$1"
mux_kind=$2
probe_ids=null run_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa image_id=sha256:$3 image_tar_sha=$3
image_arch=amd64 nix_lock_revision=abcdef123456 source_revision=abcdef root_revision=abcdef suite_hash=abcdef
bundle_tar_sha=$3 bundle_sha=sha256-source root_lock_sha=$3 frozen_runner_sha=$3 build_receipt_sha=$3
source_status=clean cli_receipt=$4 preset=current clipboard_profile=default target_version=0.49.1 target_id=kitty
source_url=https://example.invalid/kitty.txz source_sri=sha256-kitty proof_kind='' proof_nar_sri='' proof_revision=''
prep=$5
write_host_receipt "$6"
TERMINFO_MUX_KIND=$mux_kind TERMINFO_CLIPBOARD_PROFILE=$clipboard_profile target_preset=$preset target_source_url=$source_url
validate_host_metadata "$6"
target_version=wrong-outer-version
if validate_host_metadata "$6" 2>"$5/version-mismatch.stderr"; then
  echo "Container accepted a different outer version" >&2
  exit 1
fi
`,
      "_",
      launcher,
      mux,
      digest,
      build,
      dir,
      host,
    ],
    { encoding: "utf8" },
  )
  expect(result.status, result.stderr).toBe(0)
  const bytes = readFileSync(host, "utf8")
  const parsed = parseDisposableReceipt(bytes)
  const target = { kind: mux ? "mux" : "app", id: mux || "kitty", os: "linux" }
  expect(() => bindReceiptToRun(parsed, target, "host writer test")).not.toThrow()
  expect(() => bindReceiptToRun(parsed, { ...target, id: "wrong-target" }, "host writer test")).toThrow(/disagree/)
  const raw = JSON.parse(bytes) as {
    declaredTarget: { kind: string; id: string; os: string; version?: string }
    sourceArtifact: { url: string; sri: string; target?: { kind: string; id: string; version: string; os: string } }
  }
  expect(raw.sourceArtifact.url).toBe("https://example.invalid/kitty.txz")
  expect(raw.sourceArtifact.sri).toBe("sha256-kitty")
  // The receipt is committed to the public repo: the runner bundle is named by its digests,
  // never by the folder the host prepared it in (30568).
  expect(bytes).not.toContain(dir)
  const outer = { kind: "app", id: "kitty", version: "0.49.1", os: "linux" }
  if (mux) {
    expect(raw.declaredTarget).toEqual(target)
    expect(raw.sourceArtifact.target).toEqual(outer)
    expect(() => bindReceiptToRun(parsed, outer, "host writer test")).toThrow(/disagree/)
  } else {
    expect(raw.declaredTarget).toEqual(outer)
    expect(raw.sourceArtifact).not.toHaveProperty("target")
  }

  // Compose the producer's bytes with the existing measured-container fixture.
  // The host receipt must remain unchanged, and its artifact subject must survive.
  const fixture = compose()
  expect(fixture.result.status, fixture.result.stderr).toBe(0)
  const container = join(dir, "container.json")
  const containerFacts = JSON.parse(readFileSync(container, "utf8")) as {
    collector: { frozenRunnerSha256: string; buildReceiptSha256: string }
    executable: { path: string; sha256: string }
  }
  containerFacts.collector = { frozenRunnerSha256: digest, buildReceiptSha256: digest }
  writeFileSync(container, JSON.stringify(containerFacts))
  const composed = join(dir, "produced-run-receipt.json")
  const joined = spawnSync(
    "bash",
    ["-c", 'source "$1"; compose_receipt "$2" "$3" "$4"', "_", launcher, host, container, composed],
    { encoding: "utf8" },
  )
  expect(joined.status, joined.stderr).toBe(0)
  expect(readFileSync(host, "utf8")).toBe(bytes)
  const combined = JSON.parse(readFileSync(composed, "utf8")) as {
    declaredTarget: unknown
    sourceArtifact: unknown
    receiptInputs: { hostSha256: string }
    clipboardFixture: { sha256: string }
  }
  expect(combined.declaredTarget).toEqual(raw.declaredTarget)
  expect(combined.sourceArtifact).toMatchObject(raw.sourceArtifact)
  expect(combined.receiptInputs.hostSha256).toBe(parsed.sha256)
  expect(combined.clipboardFixture.sha256).not.toBe(parsed.sha256)

  // The launcher's post-batch check must bind the measured ELF to this run's
  // outer app. Mux runs deliberately have no top-level app provenance.
  const source = readFileSync(launcher, "utf8")
  const match = source.match(/jq -e --slurpfile run "\$raw\/v3-capture\.json" \\\n\s*'([^']*)'/)
  if (!match) throw new Error("Retained executable comparison not found in scripts/linux-container-run.sh")
  const executable = containerFacts.executable
  const runPath = join(dir, "v3-capture.json")
  const selectedKey = mux ? "outerApp" : "provenance"
  for (const mismatch of ["none", "path", "sha256", "missing"] as const) {
    const measured = { ...executable }
    if (mismatch === "path") measured.path = "/wrong/executable"
    if (mismatch === "sha256") measured.sha256 = "wrong-hash"
    const selected = mux ? { provenance: { executable: measured } } : { executable: measured }
    const run = {
      subject: { ...target, kind: mux ? "mux" : "term" },
      [selectedKey]: selected,
      // A matching wrong-location decoy must never rescue missing provenance.
      ...(mismatch === "missing"
        ? mux
          ? { outerApp: {}, provenance: { executable } }
          : { provenance: {}, outerApp: { provenance: { executable } } }
        : {}),
    }
    writeFileSync(runPath, JSON.stringify(run))
    const checked = spawnSync("jq", ["-e", "--slurpfile", "run", runPath, match[1]!, container], {
      encoding: "utf8",
    })
    expect(checked.status, `${mux || "app"}: ${mismatch}: ${checked.stderr}`).toBe(mismatch === "none" ? 0 : 1)
  }
})

// Receipt issuance must identify the newly live collector, while preserving the preflight
// identity. Existing compose tests only join already-produced host/container receipts.
it.runIf(process.platform === "linux")(
  "mux receipt producer measures the inner collector separately from preflight",
  () => {
    const config = join(dir, "empty.conf")
    const preflight = join(dir, "preflight.json")
    writeFileSync(config, "", { mode: 0o600 })
    writeFileSync(preflight, JSON.stringify({ pid: 95, startTicks: "203389044" }))
    const result = spawnSync(
      "bash",
      [
        "-c",
        String.raw`
source "$1"
TERMINFO_RUN_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
mux_receipt_target "$2" "$$" "$PPID" "$$" tmux "$BASH" 3.7c "$3" "$4" "terminfo-$TERMINFO_RUN_ID"
`,
        "_",
        launcher,
        preflight,
        config,
        join(dir, "terminfo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sock"),
      ],
      { encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(0)
    const target = JSON.parse(result.stdout) as Pick<
      LinuxMuxAttachmentProof,
      | "preflightCollector"
      | "collector"
      | "outerShell"
      | "outerTerminal"
      | "config"
      | "executable"
      | "bootId"
      | "mux"
      | "socketPath"
      | "session"
    > & { kind: "mux" }
    const stat = readFileSync("/proc/self/stat", "utf8")
    const parentFields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)
    const shell = realpathSync(Bun.which("bash")!)
    expect(target.kind).toBe("mux")
    expect(target.mux).toBe("tmux")
    expect(target.preflightCollector).toEqual({ pid: 95, startTicks: "203389044" })
    expect(target.collector.pid).toBe(result.pid)
    expect(target.collector.startTicks).toMatch(/^\d+$/)
    expect(target.outerShell).toEqual({
      pid: result.pid,
      startTicks: target.collector.startTicks,
      ttyRdev: Number(parentFields[4]),
    })
    expect(target.outerTerminal).toEqual({ pid: process.pid, startTicks: parentFields[19] })
    expect(target.config).toEqual({ path: config, sha256: createHash("sha256").update("").digest("hex") })
    expect(target.executable).toEqual({
      path: shell,
      sha256: createHash("sha256").update(readFileSync(shell)).digest("hex"),
      version: "3.7c",
    })
    expect(target.bootId).toBe(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim())
    expect(target.socketPath).toBe(join(dir, "terminfo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sock"))
    expect(target.session).toBe("terminfo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  },
)

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
    expect(receipt.probeRun).toEqual({ path: "v3-capture.json", runId: "b".repeat(32), sha256: "probe-hash" })
    expect(receipt.clipboardFixture).toEqual({ runId: "a".repeat(32), profile: "default", sha256: "fixture-hash" })
  })

  // The existing three-argument tests never composed a final enriched schema-3 run after review.
  it("binds the final sealed bytes while retaining original container input and logical runId", () => {
    const { result } = compose()
    const output = join(dir, "final-receipt.json")
    expect(result.status).toBe(0)
    const containerBytes = readFileSync(join(dir, "container.json"))
    const final = join(dir, "reviewed-final.json")
    const run = { source: { kind: "live" },
      schemaVersion: 4,
      runId: "b".repeat(32),
      sealedAt: "2026-10-21T05:00:00.000Z",
      rawReplies: { "collector.review.example": "exact reviewed decision bytes" },
    }
    const invoke = (receiptPath = output) =>
      spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; compose_receipt "$2" "$3" "$4" "$5"',
          "_",
          launcher,
          join(dir, "host.json"),
          join(dir, "container.json"),
          receiptPath,
          final,
        ],
        { encoding: "utf8" },
      )
    writeFileSync(final, JSON.stringify(run))
    expect(invoke().status).toBe(0)
    const receipt = JSON.parse(readFileSync(output, "utf8")) as {
      probeRun: { path: string; runId: string; sha256: string }
      receiptInputs: { containerSha256: string }
    }
    expect(receipt.probeRun).toEqual({
      path: "reviewed-final.json",
      runId: run.runId,
      sha256: createHash("sha256").update(readFileSync(final)).digest("hex"),
    })
    expect(receipt.receiptInputs.containerSha256).toBe(createHash("sha256").update(containerBytes).digest("hex"))
    expect(readFileSync(join(dir, "container.json"))).toEqual(containerBytes)
    writeFileSync(final, JSON.stringify({ ...run, runId: "foreign-run" }))
    const foreign = invoke(join(dir, "foreign-receipt.json"))
    expect(foreign.status).toBe(2)
    expect(foreign.stderr).toContain("final runId differs from original captured runId")
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
  it("hands the collector a read-only copy outside the writable output mount and re-tests it after removal", () => {
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
    const match = source.match(/capture_frame=\$\(jq -c '([^']*)' \/out\/v3-capture\.json\)/)
    if (!match) throw new Error("frame selection expression not found in scripts/linux-container-run.sh")
    return match[1]!
  })()

  function select(run: unknown) {
    return spawnSync("jq", ["-c", expression], { input: JSON.stringify(run), encoding: "utf8" })
  }

  it("selects null for a run that captured no frame, without failing", () => {
    const result = select({ results: [{ featureId: "device.primary-da" }, { featureId: "reset.ris" }] })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("null")
  })

  it("selects the target frame when a probe captured one", () => {
    const frame = { role: "target", ref: `sha256:${"a".repeat(64)}`, sourceRef: `sha256:${"b".repeat(64)}` }
    const result = select({ results: [{ featureId: "cursor.shape", frames: [frame] }] })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(frame)
  })

  it("records the absence by name and no longer refuses on the bare jq -er", () => {
    const source = readFileSync(launcher, "utf8")
    expect(source).toMatch(/no frame captured: no selected probe called ctx\.capture/)
    expect(source).toMatch(/capture_receipt=null/)
    expect(source).not.toMatch(/png_sha=\$\(jq -er '\[\.observations\[\]\.frames/)
  })

  const selectionExpression = (() => {
    const source = readFileSync(launcher, "utf8")
    const match = source.match(/jq -e --argjson ids "\$selected_ids" '([^']*)' \/out\/v3-capture\.json/)
    if (!match) throw new Error("--ids selection expression not found in scripts/linux-container-run.sh")
    return match[1]!
  })()
  const selected = (requested: string[], actual: string[], statuses: string[]) =>
    spawnSync("jq", ["-e", "--argjson", "ids", JSON.stringify(requested), selectionExpression], {
      input: JSON.stringify({
        rawReplies: { "collector.selection": JSON.stringify({ ids: actual }) },
        results: actual.map((featureId, index) => ({ featureId, status: statuses[index] })),
      }),
      encoding: "utf8",
    })
  // Selection custody must not rewrite an actual capability FAILURE or missing prerequisite TODO.
  // The old diagnostic-based transport refusal discarded that execution-owned status distinction.
  it("retains requested selection when capability results include TODO and FAILURE", () => {
    expect(
      selected(
        ["device.primary-da", "cursor.shape"],
        ["cursor.shape", "device.primary-da"],
        ["test-todo", "test-failure"],
      ).status,
    ).toBe(0)
  })
  it("refuses a changed selection without deriving feature status from it", () => {
    expect(selected(["device.primary-da", "cursor.shape"], ["device.primary-da"], ["supported"]).status).not.toBe(0)
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

/**
 * @failure cleanup's unbounded wait lets a SIGTERM-ignoring child (kitty / bun collector) keep the
 *   container alive until host `timeout 180 docker start --attach` SIGTERMs it, so a finished batch
 *   is refused as exit 143.
 * @level l1 — sources the launcher and SIGKILLs an owned sleep that traps TERM.
 * @consumer scripts/linux-container-run.sh stop_owned_processes (#28552)
 */
describe("owned process stop does not wait out the attach budget (#28552)", () => {
  it("SIGKILLs a child that ignores SIGTERM and returns before the 180 s attach budget", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source "$1"
set -euo pipefail
bash -c 'trap "" TERM; exec sleep 30' &
pid=$!
start=$(date +%s%N)
TERMINFO_STOP_GRACE_SEC=1 stop_owned_processes "$pid"
elapsed_ms=$(( ( $(date +%s%N) - start ) / 1000000 ))
if kill -0 "$pid" 2>/dev/null; then
  echo STILL_ALIVE
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  exit 2
fi
echo DEAD
echo ELAPSED_MS=$elapsed_ms
[[ "$elapsed_ms" -lt 5000 ]]
`,
        "_",
        launcher,
      ],
      { encoding: "utf8", timeout: 8_000 },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("DEAD")
    expect(result.stdout).not.toContain("STILL_ALIVE")
  })
})

/**
 * @failure host attach exit 143 discards observed.json + container-receipt.json + v3-capture.json that
 *   the completed batch already wrote, so a 7.5 s kitty run is unusable.
 * @level l1 — sources completed_batch_survives_attach_timeout against owned temp receipts.
 * @consumer scripts/linux-container-run.sh host attach failure branch (#28552)
 */
describe("completed batch survives attach SIGTERM (#28552)", () => {
  it("treats exit 143 as a completed run only when the three batch receipts are present", () => {
    const raw = join(dir, "raw")
    mkdirSync(raw)
    writeFileSync(join(raw, "observed.json"), "{}\n")
    writeFileSync(join(raw, "container-receipt.json"), "{}\n")
    writeFileSync(join(raw, "v3-capture.json"), "{}\n")
    const completed = spawnSync(
      "bash",
      ["-c", 'source "$1"; completed_batch_survives_attach_timeout 143 "$2"', "_", launcher, raw],
      { encoding: "utf8" },
    )
    expect(completed.status).toBe(0)
    const other = spawnSync(
      "bash",
      ["-c", 'source "$1"; completed_batch_survives_attach_timeout 1 "$2"', "_", launcher, raw],
      { encoding: "utf8" },
    )
    expect(other.status).not.toBe(0)
    rmSync(join(raw, "observed.json"))
    const missing = spawnSync(
      "bash",
      ["-c", 'source "$1"; completed_batch_survives_attach_timeout 143 "$2"', "_", launcher, raw],
      { encoding: "utf8" },
    )
    expect(missing.status).not.toBe(0)
  })
})

describe("in-image source archive proof", () => {
  it("refuses a wrong declared flat hash for either proof kind through one comparison", () => {
    // A matching real run can never exercise a mismatch, so it is proven here: the derived kind and
    // the flat kind reach this SAME comparison, and a wrong pin or a missing declared hash is refused
    // (@cto 2026-10-06, 27892).
    const archive = join(dir, "derived-source-tar")
    writeFileSync(archive, "derived tar bytes\n")
    const digest = createHash("sha256").update(readFileSync(archive)).digest()
    const sri = (bytes: Buffer) => `sha256-${bytes.toString("base64")}`
    const check = (measured: string, declared: string) =>
      spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; verify_source_archive_hash "$2" "$3" "Loaded ghostty source"',
          "_",
          launcher,
          measured,
          declared,
        ],
        { encoding: "utf8" },
      )
    expect(check(digest.toString("hex"), sri(digest)).status).toBe(0)
    const mismatch = check(digest.toString("hex"), sri(createHash("sha256").update("another tar").digest()))
    expect(mismatch.status).toBe(2)
    expect(mismatch.stderr).toContain("Loaded ghostty source archive differs from declared fixed hash")
    const undeclared = check(digest.toString("hex"), "")
    expect(undeclared.status).toBe(2)
    expect(undeclared.stderr).toContain("Loaded ghostty source has no declared flat sha256")
  })
})

describe("cli producer receipt gate", () => {
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    probeHash: "a".repeat(12),
    collectorRevision: "b".repeat(40),
    bundleSha256: "d".repeat(64),
    ...overrides,
  })
  const gate = (value: unknown, cliBin?: string) => {
    const file = join(dir, "cli-receipt.json")
    writeFileSync(file, JSON.stringify(value))
    return spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; require_cli_producer_receipt "$2" "${3:-}"',
        "_",
        launcher,
        file,
        ...(cliBin ? [cliBin] : []),
      ],
      {
        encoding: "utf8",
      },
    )
  }

  it("accepts a live-identity producer receipt and prints its suite hash", () => {
    const result = gate(receipt())
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("a".repeat(12))
  })

  it("refuses when the CLI bundle reports a suite hash that disagrees with the producer receipt", () => {
    const fakeCli = join(dir, "fake-terminfo.mjs")
    writeFileSync(fakeCli, `console.log("4.0.0 (${"f".repeat(12)})")\n`)
    const result = gate(receipt(), fakeCli)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(
      `CLI bundle suite ${"f".repeat(12)} differs from producer receipt ${"a".repeat(12)}`,
    )
  })

  it("still refuses a malformed producer receipt generically", () => {
    const result = gate(receipt({ bundleSha256: "short" }))
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("Invalid CLI producer receipt")
  })
})

/**
 * @failure xterm 411's 1304x814 window is larger than the Xvfb screen, so whole-window rgba is
 *   the screen (1024x768x4 = 3145728 bytes) and the collector errors instead of grading.
 * @level l1 — reads the launcher's Xvfb -screen geometry, the production display size.
 * @consumer scripts/linux-container-run.sh Xvfb screen vs launched xterm window (#28580)
 */
describe("Xvfb screen fits the launched xterm window (#28580)", () => {
  it("is large enough that a 1304x814 window is fully on-screen", () => {
    // xterm 411 -fs 16 -geometry 100x30 measured 1304x814 on the S+1 tree. 1024x768 clips xwd
    // to exactly 3145728 bytes (1024*768*4), which 28580 read as a 3 MiB capture buffer.
    const source = readFileSync(launcher, "utf8")
    const match = /Xvfb\b[^\n]*-screen 0 (\d+)x(\d+)x(\d+)/.exec(source)
    if (!match) throw new Error("Xvfb -screen geometry not found in scripts/linux-container-run.sh")
    expect(Number(match[1])).toBeGreaterThanOrEqual(1304)
    expect(Number(match[2])).toBeGreaterThanOrEqual(814)
  })
})

/**
 * @failure xterm renders with Xft antialiasing, so a plainly painted frame carries one more
 *   partial-coverage edge pixel than the same frame reached by an edit sequence; the exact-digest
 *   oracle then reads a one-pixel residual (255,255,255 vs 239,239,239) and cannot classify
 *   editing.decdc / editing.decic / editing.sl.
 * @level l1 — reads the launcher's xterm launch args, the production rendering context.
 * @consumer scripts/linux-container-run.sh xterm rendering pin (#28829)
 */
describe("xterm rendering is pinned AND RECORDED so a repaint is byte-exact (#28829)", () => {
  it("launches xterm with Xft antialiasing off, same font and geometry, and records the pin", () => {
    const source = readFileSync(launcher, "utf8")
    const start = source.indexOf("\n    xterm)")
    if (start < 0) throw new Error("xterm case not found in scripts/linux-container-run.sh")
    const xtermCase = source.slice(start, source.indexOf("parse_version", start))
    expect(xtermCase).toContain("-fa 'DejaVu Sans Mono'")
    expect(xtermCase).toContain("-fs 16 -geometry 100x30")
    expect(xtermCase).toContain("-xrm 'Xft.antialias: false'")
    // The pin must be RECORDED, not only applied: the run's context states it so an old run (which
    // carries no render key) is told apart from a new one. CTO O1: pin AND record.
    expect(xtermCase).toContain("target_render_pin=xft-antialias-off")
    expect(source).toContain("--arg render ")
    expect(source).toMatch(/context:"linux-x86_64-xvfb-llvmpipe"[^\n]*render:\$render/)
  })
})

/**
 * @failure split 120s curl / 180s attach budgets kill slow-but-complete groups (ghostty 140.6s,
 *   xterm 157.9s curl-28; wezterm attach-killed at 177s) so Candidate 2 rows go missing.
 * @level l1 — reads the launcher's declared probe-batch timeout.
 * @consumer scripts/linux-container-run.sh PROBE_BATCH_TIMEOUT_SECONDS (@dev/3 51326e54)
 */
describe("declared probe-batch timeout is one value for curl and host attach", () => {
  it("uses PROBE_BATCH_TIMEOUT_SECONDS=600 for both curl --max-time and docker start --attach", () => {
    const source = readFileSync(launcher, "utf8")
    expect(source).toMatch(/^PROBE_BATCH_TIMEOUT_SECONDS=600$/m)
    expect(source).toMatch(/curl [^\n]*--max-time "\$PROBE_BATCH_TIMEOUT_SECONDS"/)
    expect(source).toMatch(/timeout "\$PROBE_BATCH_TIMEOUT_SECONDS" docker start --attach/)
    expect(source).not.toMatch(/--max-time 120\b/)
    expect(source).not.toMatch(/timeout 180 docker start --attach/)
  })
})
