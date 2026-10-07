/**
 * @failure Hosted Windows VM identity sampling leaks raw identifiers or loses measured failure/length/digest facts.
 * @level l1
 * @consumer The branch-only Windows identity probe in windows-measurement.yml (27931).
 * @testonly none
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "vitest"
import { parse } from "yaml"

test("the Windows probe workflow records facts without retaining raw VM identifiers", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/windows-measurement.yml", import.meta.url), "utf8"))
  const probe = workflow.jobs["probe-windows-identity"]
  expect(probe, "the approved probe-windows-identity job is missing").toBeDefined()
  expect(probe["runs-on"]).toBe("windows-latest")
  expect(probe.strategy.matrix.sample).toEqual([1, 2])

  const startStep = probe.steps.find((step: { env?: { IDENTITY_PHASE?: string } }) => step.env?.IDENTITY_PHASE === "start")
  const collectionStep = probe.steps.find(
    (step: { env?: { IDENTITY_PHASE?: string } }) => step.env?.IDENTITY_PHASE === "collection",
  )
  expect(startStep, "start step missing").toBeDefined()
  expect(collectionStep, "collection step missing").toBeDefined()
  expect(collectionStep.run).toBe(startStep.run)

  const dir = await mkdtemp(join(tmpdir(), "win-identity-probe-"))
  const raw = {
    machineGuid: "12345678-abcd-1234-abcd-123456789abc",
    nicMac: "00:15:5d:01:02:03",
    productUuid: "87654321-4321-4321-4321-abcdefabcdef",
    bootTime: "2026-10-07T07:22:15.1234567Z",
    kernelEvent12: "2026-10-07T07:22:15.0000000Z",
  }

  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ jobs: [{ id: 5678, runner_name: "fixture-runner", status: "in_progress" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const fakeReg = `#!${process.execPath}
console.log('    MachineGuid    REG_SZ    ${raw.machineGuid}');
`
    const fakePs = `#!${process.execPath}
const cmd = process.argv.slice(2).join(' ');
if (cmd.includes('Get-NetAdapter')) {
  console.log('${raw.nicMac}');
} else if (cmd.includes('Win32_ComputerSystemProduct')) {
  console.log('${raw.productUuid}');
} else if (cmd.includes('Win32_OperatingSystem')) {
  console.log('${raw.bootTime}');
} else if (cmd.includes('Microsoft-Windows-Kernel-General')) {
  console.log('${raw.kernelEvent12}');
} else {
  console.log('');
}
`
    await writeFile(join(dir, "reg.exe"), fakeReg, { mode: 0o755 })
    await writeFile(join(dir, "powershell.exe"), fakePs, { mode: 0o755 })

    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture HTTP server address")

    for (const phase of ["start", "collection"]) {
      const { stdout, stderr } = await promisify(execFile)("bash", ["-e", "-c", startStep.run], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          IDENTITY_OUTPUT_DIR: dir,
          IDENTITY_PHASE: phase,
          RUNNER_NAME: "fixture-runner",
          RUNNER_ENVIRONMENT: "github-hosted",
          RUNNER_OS: "Windows",
          RUNNER_ARCH: "X64",
          ImageOS: "win22",
          ImageVersion: "20261001.1",
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          GITHUB_REPOSITORY: "beorn/terminfo.dev",
          GITHUB_RUN_ID: "99",
          GITHUB_RUN_ATTEMPT: "1",
          GH_TOKEN: "fixture-token",
        },
      })

      const bytes = await readFile(join(dir, `${phase}.json`), "utf8")
      for (const value of Object.values(raw)) {
        expect(bytes + stdout + stderr).not.toContain(value)
      }

      const sampled = JSON.parse(bytes) as {
        job: { matchCount: number | null; id: number | null }
        identifiers: Record<string, { available: boolean; sha256: string | null; byteLength: number }>
      }
      expect(sampled.job.matchCount).toBe(1)
      expect(sampled.job.id).toBe(5678)
      expect(sampled.identifiers.machineGuid.sha256).toBe(createHash("sha256").update(raw.machineGuid).digest("hex"))
      expect(sampled.identifiers.nicMac.sha256).toBe(createHash("sha256").update(raw.nicMac).digest("hex"))
      expect(sampled.identifiers.productUuid.sha256).toBe(createHash("sha256").update(raw.productUuid).digest("hex"))
      expect(sampled.identifiers.bootTime.sha256).toBe(createHash("sha256").update(raw.bootTime).digest("hex"))
      expect(sampled.identifiers.kernelEvent12.sha256).toBe(createHash("sha256").update(raw.kernelEvent12).digest("hex"))
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})
