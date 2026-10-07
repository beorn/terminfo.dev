/**
 * @failure Hosted VM identity sampling leaks raw identifiers or loses the measured failure/length/digest facts.
 * @level l1
 * @consumer The branch-only macOS identity probe in macos-measurement.yml.
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

test("the actual workflow sampler records facts without retaining raw VM identifiers", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/macos-measurement.yml", import.meta.url), "utf8"))
  const probe = workflow.jobs["probe-macos-identity"]
  expect(probe, "the approved probe-only job is missing").toBeDefined()
  const first = probe.steps[0]
  const collection = probe.steps.find(
    (step: { env?: { IDENTITY_PHASE?: string } }) => step.env?.IDENTITY_PHASE === "collection",
  )
  expect(collection.run).toBe(first.run)
  const dir = await mkdtemp(join(tmpdir(), "mac-identity-probe-"))
  const raw = { uuid: "fixture-platform-uuid", serial: "fixture-machine-serial", boot: "fixture-boot-session" }
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ jobs: [{ id: 1234, runner_name: "fixture-runner", status: "in_progress" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const fixture = `#!${process.execPath}\nconst name=process.argv[1]; if(name.endsWith("ioreg")) console.log('"IOPlatformUUID" = "${raw.uuid}"\\n"IOPlatformSerialNumber" = "${raw.serial}"'); else console.log("${raw.boot}");\n`
    for (const name of ["ioreg", "sysctl"]) await writeFile(join(dir, name), fixture, { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture HTTP server address")
    for (const phase of ["start", "collection"]) {
      const { stdout, stderr } = await promisify(execFile)("bash", ["-e", "-c", first.run], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          IDENTITY_OUTPUT_DIR: dir,
          IDENTITY_PHASE: phase,
          RUNNER_NAME: "fixture-runner",
          RUNNER_ENVIRONMENT: "github-hosted",
          RUNNER_OS: "macOS",
          RUNNER_ARCH: "ARM64",
          ImageOS: "macos26",
          ImageVersion: "fixture-image",
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          GITHUB_REPOSITORY: "fixture/repo",
          GITHUB_RUN_ID: "42",
          GITHUB_RUN_ATTEMPT: "1",
          GH_TOKEN: "fixture-token",
        },
      })
      const bytes = await readFile(join(dir, `${phase}.json`), "utf8")
      for (const value of Object.values(raw)) expect(bytes + stdout + stderr).not.toContain(value)
      const sampled = JSON.parse(bytes) as {
        job: { matchCount: number | null; id: number | null }
        identifiers: Record<string, unknown>
      }
      expect(sampled.job.matchCount).toBe(1)
      expect(sampled.job.id).toBe(1234)
      for (const [key, value] of Object.entries(raw)) {
        expect(sampled.identifiers[key]).toMatchObject({
          exitStatus: 0,
          byteLength: Buffer.byteLength(value),
          sha256: createHash("sha256").update(value).digest("hex"),
          available: true,
        })
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})
