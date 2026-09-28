/**
 * @failure A missing or mismatched container receipt is accepted as a host image's completed run.
 * @level l1 — invokes the real shell receipt composer on owned temporary files.
 * @consumer scripts/linux-container-run.sh host-side run receipt.
 * @testonly none
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const launcher = fileURLToPath(new URL("./linux-container-run.sh", import.meta.url))
let dir: string

function compose(containerRunId = "a".repeat(32), writeContainer = true, containerRunnerSha = "runner-hash") {
  const host = join(dir, "host.json")
  const container = join(dir, "container.json")
  const output = join(dir, "run-receipt.json")
  writeFileSync(
    host,
    JSON.stringify({
      runId: "a".repeat(32),
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
        executable: { path: "/nix/store/kitty", version: "kitty 0.49.1", sha256: "executable-hash" },
        sourceArtifact: { path: "/kitty-source/kitty.txz", sha256: "archive-hash" },
        collector: { frozenRunnerSha256: containerRunnerSha, buildReceiptSha256: "receipt-hash" },
        probeRun: { path: "v2-run.json", runId: "b".repeat(32), sha256: "probe-hash" },
        display: { glxinfo: "llvmpipe", geometry: "WIDTH=800" },
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
      receiptInputs: { hostSha256: string; containerSha256: string }
      sourceArtifact: { url: string; path: string; sha256: string }
      collector: { frozenRunnerSha256: string }
      probeRun: { runId: string; sha256: string }
    }
    expect(receipt.runtime.imageId).toBe("sha256:image")
    expect(receipt.executable.sha256).toBe("executable-hash")
    expect(receipt.receiptInputs.hostSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.receiptInputs.containerSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.sourceArtifact).toEqual({
      url: "https://example.invalid/kitty.txz",
      path: "/kitty-source/kitty.txz",
      sha256: "archive-hash",
    })
    expect(receipt.collector.frozenRunnerSha256).toBe("runner-hash")
    expect(receipt.probeRun).toEqual({ path: "v2-run.json", runId: "b".repeat(32), sha256: "probe-hash" })
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
})
