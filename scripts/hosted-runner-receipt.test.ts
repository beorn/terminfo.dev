/**
 * @failure Hosted receipt production invents identity/job IDs, leaks raw values, or permits collection after an invalid two-sample handoff.
 * @level l1
 * @consumer The first-step and pre-collection hosted-runner receipt apparatus (27910).
 * @testonly none
 * @reach fs-walk <fixture-only: mkdtempSync hosted receipt commands and output files>
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "vitest"
import { parseDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"

test("the actual hosted producer self-parses measured bytes and refuses incomplete or changed handoffs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-"))
  const raw = { machine: "02:00:00:00:00:01", platform: "fixture-platform-uuid", boot: "fixture-boot-uuid" }
  let matches = 1
  let apiStatus = 200
  const queried: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://fixture")
    queried.push(url.pathname + url.search)
    res.statusCode = apiStatus
    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify({
        jobs:
          url.searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, (_, i) => ({
                id: 1234 + i,
                runner_name: i === 0 && matches > 0 ? "fixture-runner" : `other-${i}`,
              }))
            : matches > 1
              ? [{ id: 5678, runner_name: "fixture-runner" }]
              : [],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const fixture = `#!${process.execPath}\nconst n=process.argv[1]; if(n.endsWith('ifconfig')) console.log('ether ${raw.machine}'); else if(n.endsWith('ioreg')) console.log('"IOPlatformUUID" = "${raw.platform}"'); else console.log('${raw.boot}');\n`
    for (const name of ["ifconfig", "ioreg", "sysctl"]) await writeFile(join(dir, name), fixture, { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_NAME: "fixture-runner",
      RUNNER_OS: "macOS",
      RUNNER_ARCH: "ARM64",
      RUNNER_TRACKING_ID: "fixture-tracking",
      ImageOS: "macos26",
      ImageVersion: "fixture-image",
      GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_WORKFLOW: "collect",
      GITHUB_WORKFLOW_REF: "collect.yml@main",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "collect",
      GH_TOKEN: "fixture-token",
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    }
    const run = (...args: string[]) =>
      promisify(execFile)(
        "node",
        ["--experimental-strip-types", fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)), ...args],
        { env },
      )
    const start = join(dir, "start.json")
    const receipt = join(dir, "host-measured.json")
    const first = await run("start", start)
    const emitted = await run("emit", start, receipt)
    const bytes = await readFile(receipt, "utf8")
    expect(parseDisposableReceipt(bytes).kind).toBe("github-hosted-runner")
    const decoded = JSON.parse(bytes) as {
      job: { jobId: string }
      runId: string
      vm: { identityAtJobStart: Record<string, string>; identityAtCollection: Record<string, string> }
    }
    expect(decoded.job.jobId).toBe("1234")
    expect(decoded.runId).toBe(
      createHash("sha256")
        .update(["github-hosted-runner", "fixture/repo", "42", "1", "1234"].join("\n"))
        .digest("hex")
        .slice(0, 32),
    )
    expect(decoded.vm.identityAtJobStart).toEqual(decoded.vm.identityAtCollection)
    for (const [field, value] of [
      ["machineIdSha256", raw.machine],
      ["productUuidSha256", raw.platform],
      ["bootIdSha256", raw.boot],
    ] as const) {
      expect(decoded.vm.identityAtJobStart[field]).toBe(createHash("sha256").update(value).digest("hex"))
    }
    for (const value of Object.values(raw)) {
      expect(
        bytes + (await readFile(start, "utf8")) + first.stdout + first.stderr + emitted.stdout + emitted.stderr,
      ).not.toContain(value)
    }
    expect(queried).toContain("/repos/fixture/repo/actions/runs/42/attempts/1/jobs?per_page=100&page=2")
    env.GITHUB_RUN_ID = "43"
    await expect(run("emit", start, join(dir, "foreign-job.json"))).rejects.toThrow(
      /does not describe this job\/runner/,
    )
    env.GITHUB_RUN_ID = "42"
    env.RUNNER_TRACKING_ID = "different-tracking"
    await expect(run("emit", start, join(dir, "foreign-runner.json"))).rejects.toThrow(
      /does not describe this job\/runner/,
    )
    env.RUNNER_TRACKING_ID = "fixture-tracking"
    apiStatus = 503
    await expect(run("start", join(dir, "api-failure.json"))).rejects.toThrow(/jobs API.*HTTP 503/)
    apiStatus = 200

    await writeFile(join(dir, "sysctl"), `#!${process.execPath}\nconsole.log('different-boot');\n`, { mode: 0o755 })
    await expect(run("emit", start, join(dir, "changed.json"))).rejects.toThrow(/one machine must serve the whole job/)
    await expect(run("emit", join(dir, "absent.json"), join(dir, "missing.json"))).rejects.toThrow(/absent.json/)
    matches = 2
    await expect(run("start", join(dir, "ambiguous.json"))).rejects.toThrow(/exactly one.*RUNNER_NAME.*found 2/)
    matches = 0
    await expect(run("start", join(dir, "unmatched.json"))).rejects.toThrow(/exactly one.*RUNNER_NAME.*found 0/)
    matches = 1
    await writeFile(join(dir, "ifconfig"), `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o755 })
    await expect(run("start", join(dir, "failed-source.json"))).rejects.toThrow(/machineIdSha256.*ifconfig.*7/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})

test("the hosted producer supports Windows and refuses degenerate identities by name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-win-"))
  let raw = {
    mac: "00-15-5D-12-34-56",
    uuid: "12345678-ABCD-1234-ABCD-123456789ABC",
    boot: "2026-10-07T07:57:50.5000000Z",
  }
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ jobs: [{ id: 7777, runner_name: "win-runner", status: "in_progress" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const fakePs = () => `#!${process.execPath}
const cmd = process.argv.slice(2).join(' ');
if (cmd.includes('Get-NetAdapter')) {
  console.log('${raw.mac}');
} else if (cmd.includes('Win32_ComputerSystemProduct')) {
  console.log('${raw.uuid}');
} else if (cmd.includes('Win32_OperatingSystem')) {
  console.log('${raw.boot}');
} else {
  console.log('');
}
`
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_NAME: "win-runner",
      RUNNER_OS: "Windows",
      RUNNER_ARCH: "X64",
      RUNNER_TRACKING_ID: "win-tracking",
      ImageOS: "win22",
      ImageVersion: "20261001.1",
      GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_WORKFLOW: "collect",
      GITHUB_WORKFLOW_REF: "collect.yml@main",
      GITHUB_RUN_ID: "88",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "collect",
      GH_TOKEN: "fixture-token",
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    }
    const run = (...args: string[]) =>
      promisify(execFile)(
        "node",
        ["--experimental-strip-types", fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)), ...args],
        { env },
      )
    const start = join(dir, "start.json")
    const receipt = join(dir, "host-measured.json")
    await run("start", start)
    await run("emit", start, receipt)
    const bytes = await readFile(receipt, "utf8")
    const parsed = parseDisposableReceipt(bytes)
    expect(parsed.kind).toBe("github-hosted-runner")
    const decoded = JSON.parse(bytes) as {
      vm: { identityAtJobStart: Record<string, string> }
    }
    expect(decoded.vm.identityAtJobStart.machineIdSha256).toBe(createHash("sha256").update(raw.mac).digest("hex"))
    expect(decoded.vm.identityAtJobStart.productUuidSha256).toBe(createHash("sha256").update(raw.uuid).digest("hex"))
    expect(decoded.vm.identityAtJobStart.bootIdSha256).toBe(createHash("sha256").update(raw.boot).digest("hex"))

    // Refusal test 1: All-zero UUID
    raw.uuid = "00000000-0000-0000-0000-000000000000"
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })
    await expect(run("start", join(dir, "degenerate-zero-uuid.json"))).rejects.toThrow(/degenerate UUID/)

    // Refusal test 2: All-F UUID
    raw.uuid = "ffffffff-ffff-ffff-ffff-ffffffffffff"
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })
    await expect(run("start", join(dir, "degenerate-f-uuid.json"))).rejects.toThrow(/degenerate UUID/)

    // Refusal test 3: All-zero MAC
    raw.uuid = "12345678-ABCD-1234-ABCD-123456789ABC"
    raw.mac = "00:00:00:00:00:00"
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })
    await expect(run("start", join(dir, "degenerate-zero-mac.json"))).rejects.toThrow(/degenerate all-zero MAC/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})
